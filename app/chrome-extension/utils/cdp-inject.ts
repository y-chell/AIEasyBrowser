import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { hookSource, type HookKind, type HookSpec } from '@/utils/cdp-hook-runtime';
import {
  holdChildStart,
  once,
  releaseChildStart,
  type ChildStartHost,
} from '@/utils/cdp-child-start';

/**
 * Document-start scripts and hooks of one held session (chrome_cdp_inject).
 *
 * Chrome facts this relies on (measured on Chrome 156): addScriptToEvaluateOnNewDocument only runs
 * on later navigations while Page is enabled; a Runtime binding exists in new documents only while
 * Runtime is enabled; registrations belong to one CDP session, so an OOPIF that is re-created on
 * navigation comes back as a new child session without them, and detach removes them all. New
 * children are therefore held paused on start (cdp-child-start) while any script exists and
 * registered before the session hub resumes them.
 */

export const MAX_INJECTIONS = 50;
const MAX_FAILURES = 5;

export interface Injection {
  id: string;
  type: 'script' | 'hook';
  source: string;
  worldName?: string;
  runImmediately: boolean;
  hook?: Pick<HookSpec, 'kind' | 'access' | 'maxRecords' | 'stackDepth'> & { path?: string };
  addedAt: number;
  /** Host key ('' = root session, else child sessionId) -> identifier, or 'pending' while sent. */
  identifiers: Map<string, string>;
  records: number;
  installed: number;
  limited: number;
  failures: Array<{ href: string; error: string; sessionId?: string }>;
}

export interface InjectState {
  bindingName: string;
  scripts: Map<string, Injection>;
  nextId: number;
  /** Per host key: Page.enable / Runtime.enable + addBinding, shared by concurrent callers. */
  pageReady: Map<string, Promise<void>>;
  bindingReady: Map<string, Promise<void>>;
  /** Binding calls that were not a record of a current hook (removed hook, malformed payload). */
  rejected: number;
  errors: string[];
}

export interface InjectSessionHost extends ChildStartHost {
  targets: Map<string, { sessionId: string; type: string }>;
  inject: InjectState;
}

export function createInjectState(): InjectState {
  const random = crypto.getRandomValues(new Uint8Array(8));
  return {
    bindingName: '__aeb_' + [...random].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
    scripts: new Map(),
    nextId: 1,
    pageReady: new Map(),
    bindingReady: new Map(),
    rejected: 0,
    errors: [],
  };
}

/** Detach drops every registration in Chrome; only the bookkeeping is left to clear. */
export function clearInjectState(state: InjectState) {
  state.scripts.clear();
  state.pageReady.clear();
  state.bindingReady.clear();
}

function noteError(state: InjectState, message: string) {
  state.errors.push(message);
  if (state.errors.length > 20) state.errors.shift();
}

function send(host: InjectSessionHost, key: string, method: string, params: object = {}) {
  return cdpSessionManager.sendCommand(host.tabId, method, params, key || undefined);
}

async function prepare(host: InjectSessionHost, key: string, binding: boolean) {
  const state = host.inject;
  await once(state.pageReady, key, () => send(host, key, 'Page.enable').then(() => undefined));
  if (binding) {
    await once(state.bindingReady, key, async () => {
      await send(host, key, 'Runtime.enable');
      await send(host, key, 'Runtime.addBinding', { name: state.bindingName });
    });
  }
}

async function registerOn(host: InjectSessionHost, key: string, script: Injection) {
  if (script.identifiers.has(key)) return;
  script.identifiers.set(key, 'pending');
  try {
    await prepare(host, key, script.type === 'hook');
    const result = await send(host, key, 'Page.addScriptToEvaluateOnNewDocument', {
      source: script.source,
      ...(script.worldName ? { worldName: script.worldName } : {}),
      runImmediately: script.runImmediately,
    });
    if (!host.inject.scripts.has(script.id)) {
      // Removed while the registration was in flight.
      await send(host, key, 'Page.removeScriptToEvaluateOnNewDocument', {
        identifier: result.identifier,
      });
      return;
    }
    script.identifiers.set(key, result.identifier);
  } catch (error) {
    script.identifiers.delete(key);
    throw error;
  }
}

/** Registers every script in a new OOPIF before the hub resumes it; failures are listed. */
export async function setupInjectChild(host: InjectSessionHost, sessionId: string) {
  try {
    for (const script of [...host.inject.scripts.values()]) {
      await registerOn(host, sessionId, script);
    }
  } catch (error) {
    noteError(
      host.inject,
      `register in ${sessionId}: ${error instanceof Error ? error.message : error}`,
    );
  }
}

export interface HookEvent {
  method: 'AEB.hook';
  params: Record<string, unknown>;
}

/**
 * Updates injection state from one event. Returns a hook record to buffer for our binding's calls
 * (which are consumed, never buffered raw), 'consumed' for a dropped binding call, else undefined.
 */
export function trackInjectEvent(
  host: InjectSessionHost,
  method: string,
  params: any,
  sessionId: string | undefined,
): HookEvent | 'consumed' | undefined {
  const state = host.inject;
  switch (method) {
    case 'Target.detachedFromTarget':
      if (params?.sessionId) {
        state.pageReady.delete(params.sessionId);
        state.bindingReady.delete(params.sessionId);
        for (const script of state.scripts.values()) script.identifiers.delete(params.sessionId);
      }
      return undefined;
    case 'Runtime.bindingCalled': {
      if (params?.name !== state.bindingName) return undefined;
      let message: any;
      try {
        message = JSON.parse(params.payload);
      } catch {
        message = undefined;
      }
      const script =
        message && typeof message.id === 'string' ? state.scripts.get(message.id) : undefined;
      if (!script || typeof message.type !== 'string') {
        state.rejected += 1;
        return 'consumed';
      }
      if (message.type === 'installed') script.installed += 1;
      else if (message.type === 'limit') script.limited += 1;
      else if (message.type === 'failed') {
        script.failures.push({
          href: String(message.href ?? ''),
          error: String(message.error ?? ''),
          ...(sessionId ? { sessionId } : {}),
        });
        if (script.failures.length > MAX_FAILURES) script.failures.shift();
      } else script.records += 1;
      const { id, ...record } = message;
      return {
        method: 'AEB.hook',
        params: { hookId: id, kind: script.hook?.kind, ...record },
      };
    }
    default:
      return undefined;
  }
}

export interface InjectionInput {
  type: 'script' | 'hook';
  source?: string;
  worldName?: string;
  runImmediately: boolean;
  hook?: {
    kind: HookKind;
    path?: string;
    access: HookSpec['access'];
    maxRecords: number;
    stackDepth: number;
  };
}

function hostKeys(host: InjectSessionHost): string[] {
  return [
    '',
    ...[...host.targets.values()]
      .filter((target) => target.type === 'iframe')
      .map((target) => target.sessionId),
  ];
}

/**
 * Registers on the root session (failure rejects the call) and every attached OOPIF (failures are
 * returned per child). Same-process frames are covered by the root registration.
 */
export async function addInjection(
  host: InjectSessionHost,
  input: InjectionInput,
): Promise<{ injection: Injection; childErrors: Array<{ sessionId: string; error: string }> }> {
  const state = host.inject;
  if (state.scripts.size >= MAX_INJECTIONS) {
    throw new Error(`INJECT_LIMIT: at most ${MAX_INJECTIONS} injections per session; remove one`);
  }
  const id = `inj-${state.nextId++}`;
  let source = input.source ?? '';
  if (input.type === 'hook') {
    const hook = input.hook!;
    source = hookSource(state.bindingName, {
      id,
      kind: hook.kind,
      parts: hook.path ? hook.path.replace(/^(window|globalThis|self)\./, '').split('.') : [],
      access: hook.access,
      maxRecords: hook.maxRecords,
      stackDepth: hook.stackDepth,
      sourceUrl: `aeb-hook://${id}`,
    });
  }
  const injection: Injection = {
    id,
    type: input.type,
    source,
    ...(input.worldName ? { worldName: input.worldName } : {}),
    runImmediately: input.runImmediately,
    ...(input.hook ? { hook: { ...input.hook } } : {}),
    addedAt: Date.now(),
    identifiers: new Map(),
    records: 0,
    installed: 0,
    limited: 0,
    failures: [],
  };
  state.scripts.set(id, injection);
  try {
    await registerOn(host, '', injection);
    // Before registering on current children: an OOPIF created from now on waits for us.
    await holdChildStart(host, 'inject');
  } catch (error) {
    state.scripts.delete(id);
    const root = injection.identifiers.get('');
    if (root && root !== 'pending') {
      await send(host, '', 'Page.removeScriptToEvaluateOnNewDocument', { identifier: root }).catch(
        () => undefined,
      );
    }
    if (state.scripts.size === 0) await releaseChildStart(host, 'inject').catch(() => undefined);
    throw error;
  }
  const childErrors: Array<{ sessionId: string; error: string }> = [];
  for (const key of hostKeys(host).slice(1)) {
    try {
      await registerOn(host, key, injection);
    } catch (error) {
      childErrors.push({
        sessionId: key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { injection, childErrors };
}

/**
 * Removes the registration everywhere. Hooks already installed in a loaded document stay in that
 * document until it navigates; their later records are dropped because the id is gone.
 */
export async function removeInjection(host: InjectSessionHost, id: string): Promise<string[]> {
  const state = host.inject;
  const injection = state.scripts.get(id);
  if (!injection) {
    throw new Error(`INJECTION_NOT_FOUND: no injection ${id} in this session; list them first`);
  }
  state.scripts.delete(id);
  const errors: string[] = [];
  for (const [key, identifier] of injection.identifiers) {
    if (identifier === 'pending') continue;
    if (key && !host.targets.has(key)) continue;
    try {
      await send(host, key, 'Page.removeScriptToEvaluateOnNewDocument', { identifier });
    } catch (error) {
      errors.push(`${key || 'root'}: ${error instanceof Error ? error.message : error}`);
    }
  }
  if (state.scripts.size === 0) {
    try {
      await releaseChildStart(host, 'inject');
    } catch (error) {
      errors.push(`disable wait on start: ${error instanceof Error ? error.message : error}`);
    }
  }
  return errors;
}
