import {
  createErrorResponse,
  createStructuredToolResult,
  type ToolResult,
} from '@/common/tool-handler';
import { TOOL_NAMES } from 'aieasybrowser-shared';
import { BaseBrowserToolExecutor } from '../base-browser';
import type { BrowserToolExecutionContext } from '../browser-session-context';
import {
  DEFAULT_MAX_EVENTS,
  MAX_EVENTS_LIMIT,
  getOwnedSession,
  peekSession,
  startSession,
  stopSession,
  type HeldSession,
} from '@/utils/cdp-event-hub';
import { browserWorkerTargets } from '@/utils/cdp-frames';
import { DEFAULT_MAX_OUTPUT_BYTES } from '@/utils/output-sanitizer';
import { clampInt, serializeResult } from './cdp';

interface CdpSessionParams {
  action?: 'start' | 'status' | 'events' | 'workers' | 'stop';
  tabId?: number;
  windowId?: number;
  events?: string[];
  autoAttach?: boolean;
  maxEvents?: number;
  after?: number;
  limit?: number;
  maxOutputBytes?: number;
  sanitizeOutput?: boolean;
}

const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 1000;

function describeSession(session: HeldSession) {
  const last = session.events[session.events.length - 1];
  return {
    started: true,
    active: !session.ended,
    ...(session.ended ? { ended: session.ended } : {}),
    startedAt: session.startedAt,
    events: session.filters,
    autoAttach: session.autoAttach,
    maxEvents: session.maxEvents,
    buffered: session.events.length,
    lastSeq: last ? last.seq : session.nextSeq - 1,
    dropped: session.dropped,
    targets: [...session.targets.values()],
    // Paused JavaScript freezes the page; chrome_cdp_debugger status has the frames.
    paused: [...session.debug.pauses.values()].map((pause) => ({
      ...(pause.key ? { sessionId: pause.key } : {}),
      reason: pause.reason,
      seq: pause.seq,
    })),
    ...(session.network.enabled ? { network: { requests: session.network.records.size } } : {}),
    ...(session.childStart.errors.length ? { childStartErrors: session.childStart.errors } : {}),
  };
}

class CdpSessionTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.CDP_SESSION;

  // status/events/stop must reach a session whose page is paused; start attaches and keeps the lock.
  skipsTargetLock(args: CdpSessionParams) {
    return args?.action !== 'start';
  }

  async execute(
    args: CdpSessionParams,
    executionContext?: BrowserToolExecutionContext,
  ): Promise<ToolResult> {
    const owner = executionContext?.owner;
    if (!owner) {
      return createErrorResponse(
        'CDP_SESSION_NOT_STARTED: chrome_cdp_session requires a named task session',
      );
    }
    try {
      const explicit = await this.tryGetTab(args.tabId);
      if (args.tabId !== undefined && !explicit) {
        throw new Error(`TARGET_CLOSED: tab ${args.tabId} is not open`);
      }
      const tab = explicit || (await this.getActiveTabOrThrowInWindow(args.windowId));
      if (!tab.id) throw new Error('Active tab has no ID');
      const base = { success: true, tool: this.name, tabId: tab.id };

      switch (args.action) {
        case 'start': {
          const filters = (args.events || []).map((filter) => filter.trim());
          if (filters.some((filter) => !filter)) {
            throw new Error('events entries must be non-empty domain or method names');
          }
          const session = await startSession(tab.id, owner, {
            filters,
            autoAttach: args.autoAttach !== false,
            maxEvents: clampInt(args.maxEvents, DEFAULT_MAX_EVENTS, 1, MAX_EVENTS_LIMIT),
          });
          return createStructuredToolResult({ ...base, ...describeSession(session) });
        }
        case 'status': {
          const session = peekSession(tab.id);
          if (!session) return createStructuredToolResult({ ...base, started: false });
          return createStructuredToolResult({
            ...base,
            ...describeSession(getOwnedSession(tab.id, owner)),
          });
        }
        case 'events':
          return createStructuredToolResult({
            ...base,
            ...this.readEvents(getOwnedSession(tab.id, owner), args),
          });
        case 'workers':
          return createStructuredToolResult({
            ...base,
            ...(await this.listWorkers(getOwnedSession(tab.id, owner))),
          });
        case 'stop': {
          const errors = await stopSession(tab.id, owner);
          if (errors.length) {
            throw new Error(`CDP_SESSION_STOP_INCOMPLETE: ${errors.join('; ')}`);
          }
          return createStructuredToolResult({ ...base, stopped: true });
        }
        default:
          throw new Error('action must be start, status, events, workers, or stop');
      }
    } catch (error) {
      return createErrorResponse(
        `Error in CDP session: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Workers of the tab: auto-attached child sessions (dedicated workers, service workers in scope)
   * and browser-level worker targets of the tab's origins that are not children of the page.
   * Chrome reports both shared and service workers there as type "worker".
   */
  private async listWorkers(session: HeldSession) {
    if (session.ended) {
      throw new Error(
        `CDP_SESSION_ENDED: tab ${session.tabId} debugger session ended (${session.ended.reason})`,
      );
    }
    const children = [...session.targets.values()].filter((target) => target.type !== 'iframe');
    const childIds = new Set(children.map((target) => target.targetId));
    const browserTargets = (await browserWorkerTargets(session.tabId))
      .filter((target) => !childIds.has(target.id))
      .map((target) => ({
        workerTargetId: target.id,
        url: target.url,
        // Attached by another debugger client (DevTools) or a call in progress.
        attached: target.attached,
      }));
    return { sessions: children, browserTargets };
  }

  private readEvents(session: HeldSession, args: CdpSessionParams) {
    const after = clampInt(args.after, 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = clampInt(args.limit, DEFAULT_PAGE_LIMIT, 1, MAX_PAGE_LIMIT);
    const maxBytes = clampInt(args.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 1000, 2_000_000);
    const sanitizeOutput = args.sanitizeOutput !== false;
    const oldest = session.events[0]?.seq ?? session.nextSeq;
    // Events evicted from the ring between the caller's cursor and the oldest retained one.
    const missed = Math.max(0, oldest - after - 1);

    const page: Array<Record<string, unknown>> = [];
    let used = 0;
    let truncated = false;
    for (const event of session.events) {
      if (event.seq <= after) continue;
      if (page.length >= limit) break;
      const budget = maxBytes - used;
      const body =
        event.paramsText !== undefined
          ? { resultText: event.paramsText, truncated: true }
          : serializeResult(event.params, { maxOutputBytes: Math.max(budget, 1), sanitizeOutput });
      const entry = {
        seq: event.seq,
        ts: event.ts,
        method: event.method,
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
        ...('result' in body ? { params: body.result } : { paramsText: body.resultText }),
        ...(body.truncated ? { truncated: true } : {}),
        ...('redacted' in body && body.redacted ? { redacted: true } : {}),
      };
      const size = new TextEncoder().encode(JSON.stringify(entry)).length;
      // Always return at least one event so a cursor can make progress past an oversized one.
      if (page.length > 0 && used + size > maxBytes) {
        truncated = true;
        break;
      }
      page.push(entry);
      used += size;
    }
    const last = page[page.length - 1];
    const nextAfter = last ? (last.seq as number) : after;
    return {
      active: !session.ended,
      ...(session.ended ? { ended: session.ended } : {}),
      events: page,
      nextAfter,
      hasMore: session.events.some((event) => event.seq > nextAfter),
      ...(truncated ? { pageTruncatedByBytes: true } : {}),
      missed,
      dropped: session.dropped,
      sanitizeOutput,
    };
  }
}

export const cdpSessionTool = new CdpSessionTool();
