import { cdpSessionManager } from '@/utils/cdp-session-manager';
import {
  clearScripts,
  createScriptTable,
  disableScriptDebugger,
  trackScriptEvent,
  type ScriptTable,
} from '@/utils/cdp-scripts';
import {
  clearDebugState,
  createDebugState,
  releaseDebugger,
  trackDebugEvent,
  type DebugState,
} from '@/utils/cdp-debugger';
import {
  clearInjectState,
  createInjectState,
  setupInjectChild,
  trackInjectEvent,
  type InjectState,
} from '@/utils/cdp-inject';
import {
  clearChildStartState,
  createChildStartState,
  noteChildStartError,
  type ChildStartState,
} from '@/utils/cdp-child-start';
import {
  createNetworkState,
  endNetwork,
  setupNetworkChild,
  stopNetwork,
  trackNetworkEvent,
  type NetworkState,
} from '@/utils/cdp-network';

/**
 * Long-lived debugger sessions owned by one named CLI task.
 *
 * State lives in service-worker memory only. The SW stays alive while the native port and a
 * debugger session are open (Chrome 105 / 118), but an extension reload or native host exit
 * loses it; callers then get CDP_SESSION_NOT_STARTED instead of a silently recreated session.
 */

export const DEFAULT_MAX_EVENTS = 1000;
export const MAX_EVENTS_LIMIT = 10_000;
const MAX_EVENT_BYTES = 256 * 1024;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const MAX_ENDED_SESSIONS = 10;

export interface ChildTarget {
  sessionId: string;
  targetId: string;
  type: string;
  url: string;
  parentSessionId?: string;
  attachedAt: number;
}

export interface BufferedEvent {
  seq: number;
  ts: number;
  method: string;
  sessionId?: string;
  /** Raw params, or the truncated JSON text when a single event exceeded MAX_EVENT_BYTES. */
  params?: unknown;
  paramsText?: string;
  bytes: number;
}

export interface HeldSession {
  tabId: number;
  owner: string;
  startedAt: number;
  filters: string[];
  autoAttach: boolean;
  maxEvents: number;
  events: BufferedEvent[];
  bufferBytes: number;
  nextSeq: number;
  dropped: number;
  targets: Map<string, ChildTarget>;
  scripts: ScriptTable;
  debug: DebugState;
  inject: InjectState;
  childStart: ChildStartState;
  network: NetworkState;
  ended?: { at: number; reason: string };
}

const sessions = new Map<number, HeldSession>();
let listening = false;

function ownerTag(owner: string): string {
  return `cdp-session:${owner}`;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function matchesFilter(filters: string[], method: string): boolean {
  return filters.some(
    (filter) => filter === '*' || filter === method || method.startsWith(`${filter}.`),
  );
}

function pushEvent(session: HeldSession, method: string, params: unknown, sessionId?: string) {
  let text: string;
  try {
    text = JSON.stringify(params ?? null);
  } catch {
    text = String(params);
  }
  const bytes = byteLength(text);
  const event: BufferedEvent = {
    seq: session.nextSeq++,
    ts: Date.now(),
    method,
    ...(sessionId ? { sessionId } : {}),
    bytes: Math.min(bytes, MAX_EVENT_BYTES),
  };
  if (bytes > MAX_EVENT_BYTES) {
    event.paramsText = `${text.slice(0, MAX_EVENT_BYTES)}... [truncated ${bytes - MAX_EVENT_BYTES} bytes]`;
  } else {
    event.params = params;
  }
  session.events.push(event);
  session.bufferBytes += event.bytes;
  while (
    session.events.length > session.maxEvents ||
    (session.bufferBytes > MAX_BUFFER_BYTES && session.events.length > 1)
  ) {
    const removed = session.events.shift()!;
    session.bufferBytes -= removed.bytes;
    session.dropped += 1;
  }
}

/** Every feature sets up a new child before it runs; a child attached paused is then resumed. */
async function onChildAttached(session: HeldSession, params: any) {
  const sessionId: string = params.sessionId;
  const type: string | undefined = params.targetInfo?.type;
  try {
    if (type === 'iframe' && session.inject.scripts.size > 0) {
      await setupInjectChild(session, sessionId);
    }
    await setupNetworkChild(session, sessionId, type);
  } finally {
    if (params.waitingForDebugger) {
      await cdpSessionManager
        .sendCommand(session.tabId, 'Runtime.runIfWaitingForDebugger', {}, sessionId)
        .catch((error) =>
          noteChildStartError(
            session.childStart,
            `resume ${sessionId}: ${error instanceof Error ? error.message : error}`,
          ),
        );
    }
  }
}

function handleEvent(source: chrome.debugger.DebuggerSession, method: string, params?: any) {
  if (typeof source.tabId !== 'number') return;
  const session = sessions.get(source.tabId);
  if (!session || session.ended) return;
  if (method === 'Target.attachedToTarget' && params?.sessionId && params?.targetInfo) {
    session.targets.set(params.sessionId, {
      sessionId: params.sessionId,
      targetId: params.targetInfo.targetId,
      type: params.targetInfo.type,
      url: params.targetInfo.url,
      ...(source.sessionId ? { parentSessionId: source.sessionId } : {}),
      attachedAt: Date.now(),
    });
  } else if (method === 'Target.detachedFromTarget' && params?.sessionId) {
    session.targets.delete(params.sessionId);
  }
  if (method === 'Target.attachedToTarget' && params?.sessionId) {
    void onChildAttached(session, params);
  }
  // The script and request tables are maintained regardless of the event filter.
  trackScriptEvent(session, method, params, source.sessionId);
  trackNetworkEvent(session, method, params, source.sessionId);
  trackDebugEvent(session, method, params, source.sessionId);
  // Hook records are buffered whatever the filter; the raw binding call never is.
  const hook = trackInjectEvent(session, method, params, source.sessionId);
  if (hook === 'consumed') return;
  if (hook) {
    pushEvent(session, hook.method, hook.params, source.sessionId);
    return;
  }
  if (matchesFilter(session.filters, method)) {
    pushEvent(session, method, params, source.sessionId);
  }
}

function pruneEnded() {
  const ended = [...sessions.values()]
    .filter((session) => session.ended)
    .sort((a, b) => a.ended!.at - b.ended!.at);
  while (ended.length > MAX_ENDED_SESSIONS) {
    sessions.delete(ended.shift()!.tabId);
  }
}

function handleDetach(source: chrome.debugger.Debuggee, reason: string) {
  if (typeof source.tabId !== 'number') return;
  const session = sessions.get(source.tabId);
  if (!session || session.ended) return;
  // Keep buffered events readable: the last events before a crash or close are often the point.
  session.ended = { at: Date.now(), reason };
  session.targets.clear();
  clearScripts(session.scripts);
  clearDebugState(session.debug);
  clearInjectState(session.inject);
  clearChildStartState(session.childStart);
  endNetwork(session.network);
  pruneEnded();
}

// A closed tab cannot be addressed by later calls (the bridge rejects it first), so its
// buffered events are unreachable; drop them instead of keeping an unreadable tombstone.
function handleTabRemoved(tabId: number) {
  const session = sessions.get(tabId);
  // A pending wait returns CDP_SESSION_ENDED instead of running into its timeout.
  if (session) clearDebugState(session.debug);
  sessions.delete(tabId);
}

function ensureListening() {
  if (listening) return;
  chrome.debugger.onEvent.addListener(handleEvent);
  chrome.debugger.onDetach.addListener(handleDetach);
  chrome.tabs.onRemoved.addListener(handleTabRemoved);
  listening = true;
}

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

/** Session for a tab, rejecting access from another task. */
export function getOwnedSession(tabId: number, owner: string): HeldSession {
  const session = sessions.get(tabId);
  if (!session) {
    fail('CDP_SESSION_NOT_STARTED', `no debugger session was started for tab ${tabId}`);
  }
  if (session.owner !== owner) {
    fail('CDP_SESSION_OWNED', `tab ${tabId} debugger session belongs to another task`);
  }
  return session;
}

export function peekSession(tabId: number): HeldSession | undefined {
  return sessions.get(tabId);
}

export interface StartOptions {
  filters: string[];
  autoAttach: boolean;
  maxEvents: number;
}

export async function startSession(
  tabId: number,
  owner: string,
  options: StartOptions,
): Promise<HeldSession> {
  ensureListening();
  const existing = sessions.get(tabId);
  if (existing && !existing.ended) {
    fail(
      existing.owner === owner ? 'CDP_SESSION_ACTIVE' : 'CDP_SESSION_OWNED',
      existing.owner === owner
        ? `tab ${tabId} already has a debugger session for this task; stop it first`
        : `tab ${tabId} debugger session belongs to another task`,
    );
  }
  if (existing?.ended && existing.owner !== owner) {
    fail('CDP_SESSION_OWNED', `tab ${tabId} has an ended session of another task`);
  }

  await cdpSessionManager.attach(tabId, ownerTag(owner));
  const session: HeldSession = {
    tabId,
    owner,
    startedAt: Date.now(),
    filters: options.filters,
    autoAttach: options.autoAttach,
    maxEvents: options.maxEvents,
    events: [],
    bufferBytes: 0,
    nextSeq: 1,
    dropped: 0,
    targets: new Map(),
    scripts: createScriptTable(),
    debug: createDebugState(),
    inject: createInjectState(),
    childStart: createChildStartState(),
    network: createNetworkState(),
  };
  // Register before auto-attach: Target.attachedToTarget arrives before the command resolves.
  sessions.set(tabId, session);
  if (options.autoAttach) {
    try {
      await cdpSessionManager.sendCommand(tabId, 'Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      });
    } catch (error) {
      sessions.delete(tabId);
      await cdpSessionManager.detach(tabId, ownerTag(owner));
      throw error;
    }
  }
  return session;
}

/** Stops the session; returns cleanup errors instead of hiding them. */
export async function stopSession(tabId: number, owner: string): Promise<string[]> {
  const session = getOwnedSession(tabId, owner);
  const errors: string[] = [];
  if (!session.ended) {
    // Mark ended first so the detach event of our own stop is not reported as unexpected.
    session.ended = { at: Date.now(), reason: 'stopped' };
    // Resume before Debugger.disable so a paused page is never left frozen.
    errors.push(...(await releaseDebugger(session)));
    errors.push(...(await stopNetwork(session)).map((error) => `disable network: ${error}`));
    try {
      await disableScriptDebugger(session);
    } catch (error) {
      errors.push(`disable debugger: ${error instanceof Error ? error.message : error}`);
    }
    if (session.autoAttach) {
      try {
        await cdpSessionManager.sendCommand(tabId, 'Target.setAutoAttach', {
          autoAttach: false,
          waitForDebuggerOnStart: false,
          flatten: true,
        });
      } catch (error) {
        errors.push(`disable auto-attach: ${error instanceof Error ? error.message : error}`);
      }
    }
    try {
      await cdpSessionManager.detach(tabId, ownerTag(owner));
    } catch (error) {
      errors.push(`detach: ${error instanceof Error ? error.message : error}`);
    }
    // Detach removed the registrations and the binding in Chrome.
    clearInjectState(session.inject);
    clearChildStartState(session.childStart);
  }
  sessions.delete(tabId);
  return errors;
}

/** Child session of an active owned session; unknown IDs fail instead of reaching Chrome. */
export function resolveChildSession(tabId: number, owner: string, sessionId: string): ChildTarget {
  const session = getOwnedSession(tabId, owner);
  if (session.ended) {
    fail('CDP_SESSION_ENDED', `tab ${tabId} debugger session ended (${session.ended.reason})`);
  }
  const target = session.targets.get(sessionId);
  if (!target) {
    fail(
      'CDP_UNKNOWN_SESSION',
      `sessionId ${sessionId} is not an attached child target of tab ${tabId}`,
    );
  }
  return target;
}

export function clearCdpSessionsForTest(): void {
  sessions.clear();
  listening = false;
}
