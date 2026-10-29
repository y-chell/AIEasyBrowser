import {
  createErrorResponse,
  createStructuredToolResult,
  type ToolResult,
} from '@/common/tool-handler';
import { TOOL_NAMES } from 'aieasybrowser-shared';
import { BaseBrowserToolExecutor } from '../base-browser';
import type { BrowserToolExecutionContext } from '../browser-session-context';
import { getOwnedSession, type HeldSession } from '@/utils/cdp-event-hub';
import {
  addInjection,
  removeInjection,
  type Injection,
  type InjectionInput,
} from '@/utils/cdp-inject';
import type { HookKind } from '@/utils/cdp-hook-runtime';
import { clampInt } from './cdp';

interface CdpInjectParams {
  action?: 'add' | 'hook' | 'list' | 'remove';
  tabId?: number;
  windowId?: number;
  source?: string;
  worldName?: string;
  runImmediately?: boolean;
  hook?: HookKind;
  path?: string;
  access?: 'get' | 'set' | 'both';
  maxRecords?: number;
  stackDepth?: number;
  id?: string;
}

const MAX_SOURCE_BYTES = 1024 * 1024;
const HOOK_KINDS: HookKind[] = ['function', 'property', 'fetch', 'xhr'];
// Dotted identifiers only: the path is data inside the generated source, never code.
const PATH = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*){0,9}$/;

function invalid(message: string): never {
  throw new Error(`INVALID_ARGUMENT: ${message}`);
}

function describe(injection: Injection) {
  return {
    id: injection.id,
    type: injection.type,
    ...(injection.hook ? injection.hook : {}),
    ...(injection.worldName ? { worldName: injection.worldName } : {}),
    runImmediately: injection.runImmediately,
    ...(injection.type === 'script'
      ? { sourceBytes: new TextEncoder().encode(injection.source).length }
      : {}),
    sessions: [...injection.identifiers.keys()].map((key) => key || 'root'),
    ...(injection.type === 'hook'
      ? {
          installed: injection.installed,
          records: injection.records,
          limitedDocuments: injection.limited,
          ...(injection.failures.length ? { failures: injection.failures } : {}),
        }
      : {}),
    addedAt: injection.addedAt,
  };
}

/** Validates before any CDP IO so a bad call leaves the session unchanged. */
function parse(args: CdpInjectParams): InjectionInput {
  const hookOnly = ['hook', 'path', 'access', 'maxRecords', 'stackDepth'] as const;
  if (args.action === 'add') {
    for (const key of hookOnly) if (args[key] !== undefined) invalid(`add does not take ${key}`);
    if (typeof args.source !== 'string' || !args.source.trim()) {
      invalid('add requires a non-empty source');
    }
    if (new TextEncoder().encode(args.source).length > MAX_SOURCE_BYTES) {
      invalid(`source exceeds ${MAX_SOURCE_BYTES} bytes`);
    }
    if (args.worldName !== undefined && !/^[\w.-]{1,64}$/.test(args.worldName)) {
      invalid('worldName must be 1-64 letters, digits, "_", "." or "-"');
    }
    return {
      type: 'script',
      source: args.source,
      ...(args.worldName ? { worldName: args.worldName } : {}),
      runImmediately: args.runImmediately === true,
    };
  }
  if (args.source !== undefined || args.worldName !== undefined) {
    invalid('hook runs in the page main world and takes no source or worldName');
  }
  if (!args.hook || !HOOK_KINDS.includes(args.hook)) {
    invalid('hook must be function, property, fetch, or xhr');
  }
  const needsPath = args.hook === 'function' || args.hook === 'property';
  if (needsPath) {
    if (!args.path || !PATH.test(args.path)) {
      invalid('path must be a dotted property path from globalThis, e.g. "crypto.subtle.sign"');
    }
    if (/^(window|globalThis|self)$/.test(args.path)) invalid('path must name a property');
  } else if (args.path !== undefined) {
    invalid(`${args.hook} hook takes no path`);
  }
  if (args.access !== undefined && args.hook !== 'property') {
    invalid('access applies to property hooks only');
  }
  return {
    type: 'hook',
    runImmediately: args.runImmediately !== false,
    hook: {
      kind: args.hook,
      ...(needsPath ? { path: args.path } : {}),
      access: args.access ?? 'both',
      maxRecords: clampInt(args.maxRecords, 200, 1, 10_000),
      stackDepth: clampInt(args.stackDepth, 5, 0, 20),
    },
  };
}

class CdpInjectTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.CDP_INJECT;

  // list/remove only touch registrations; add/hook may run in the current document and keep the lock.
  skipsTargetLock(args: CdpInjectParams) {
    return args?.action === 'list' || args?.action === 'remove';
  }

  async execute(
    args: CdpInjectParams,
    executionContext?: BrowserToolExecutionContext,
  ): Promise<ToolResult> {
    const owner = executionContext?.owner;
    if (!owner) {
      return createErrorResponse(
        'CDP_SESSION_NOT_STARTED: chrome_cdp_inject requires a named task session',
      );
    }
    try {
      const explicit = await this.tryGetTab(args.tabId);
      if (args.tabId !== undefined && !explicit) {
        throw new Error(`TARGET_CLOSED: tab ${args.tabId} is not open`);
      }
      const tab = explicit || (await this.getActiveTabOrThrowInWindow(args.windowId));
      if (!tab.id) throw new Error('Active tab has no ID');
      let input: InjectionInput | undefined;
      if (args.action === 'add' || args.action === 'hook') input = parse(args);
      else if (args.action === 'remove') {
        if (!args.id) invalid('remove requires id');
      } else if (args.action !== 'list') {
        invalid('action must be add, hook, list, or remove');
      }
      const session = this.activeSession(tab.id, owner);
      const base = { success: true, tool: this.name, tabId: tab.id };
      if (input) {
        const { injection, childErrors } = await addInjection(session, input);
        return createStructuredToolResult({
          ...base,
          injection: describe(injection),
          ...(childErrors.length ? { childErrors } : {}),
        });
      }
      if (args.action === 'remove') {
        const errors = await removeInjection(session, args.id!);
        if (errors.length) {
          throw new Error(`INJECT_REMOVE_INCOMPLETE: ${errors.join('; ')}`);
        }
        return createStructuredToolResult({ ...base, removed: args.id });
      }
      const state = session.inject;
      return createStructuredToolResult({
        ...base,
        injections: [...state.scripts.values()].map(describe),
        waitOnStart: session.childStart.waitOnStart,
        rejectedBindingCalls: state.rejected,
        ...(state.errors.length ? { errors: state.errors } : {}),
      });
    } catch (error) {
      return createErrorResponse(
        `Error in CDP inject: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private activeSession(tabId: number, owner: string): HeldSession {
    const session = getOwnedSession(tabId, owner);
    if (session.ended) {
      throw new Error(
        `CDP_SESSION_ENDED: tab ${tabId} debugger session ended (${session.ended.reason})`,
      );
    }
    return session;
  }
}

export const cdpInjectTool = new CdpInjectTool();
