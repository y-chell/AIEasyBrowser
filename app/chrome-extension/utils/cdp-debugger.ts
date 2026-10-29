import { cdpSessionManager } from '@/utils/cdp-session-manager';

/**
 * Pause and breakpoint state of a held CDP session, per root/child session.
 *
 * B2 enables Debugger with setSkipAllPauses(true) so `debugger;` statements never freeze the page.
 * A session is "armed" (skip off) only while it has breakpoints, a requested pause, or a current
 * pause; once none remain it is disarmed again. Keys are the child sessionId, '' for the root.
 */

export const OBJECT_GROUP = 'aeb-debugger';

export interface PauseRecord {
  seq: number;
  key: string;
  at: number;
  reason: string;
  callFrames: any[];
  hitBreakpoints: string[];
  data?: unknown;
  asyncStackTrace?: unknown;
}

export interface BreakpointRecord {
  id: string;
  key: string;
  kind: 'line' | 'xhr' | 'event';
  /** CDP id for line breakpoints, also used for removal. */
  cdpId?: string;
  url?: string;
  urlRegex?: string;
  scriptId?: string;
  line?: number;
  column?: number;
  condition?: string;
  logMessage?: string;
  xhrUrl?: string;
  eventName?: string;
  targetName?: string;
  locations: Array<{ scriptId: string; lineNumber: number; columnNumber?: number }>;
  hits: number;
}

type WaitResult = { pause: PauseRecord } | { ended: true } | { timedOut: true };

interface Waiter {
  key?: string;
  afterSeq: number;
  resolve: (result: WaitResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface DebugState {
  pauses: Map<string, PauseRecord>;
  breakpoints: Map<string, BreakpointRecord>;
  armed: Set<string>;
  pending: Set<string>;
  /** Sessions where evaluate created objects in OBJECT_GROUP. */
  groups: Set<string>;
  blackbox: Map<string, string[]>;
  nextSeq: number;
  waiters: Set<Waiter>;
}

export interface DebugSessionHost {
  tabId: number;
  debug: DebugState;
}

export function createDebugState(): DebugState {
  return {
    pauses: new Map(),
    breakpoints: new Map(),
    armed: new Set(),
    pending: new Set(),
    groups: new Set(),
    blackbox: new Map(),
    nextSeq: 1,
    waiters: new Set(),
  };
}

export const sessionKey = (sessionId: string | undefined) => sessionId ?? '';
const sessionArg = (key: string) => key || undefined;

function settle(state: DebugState, waiter: Waiter, result: WaitResult) {
  clearTimeout(waiter.timer);
  state.waiters.delete(waiter);
  waiter.resolve(result);
}

function forgetSession(state: DebugState, key: string) {
  state.pauses.delete(key);
  state.armed.delete(key);
  state.pending.delete(key);
  state.groups.delete(key);
  state.blackbox.delete(key);
  for (const [id, record] of state.breakpoints) {
    if (record.key === key) state.breakpoints.delete(id);
  }
}

/** Updates pause state from one debugger event; called for every event of a held session. */
export function trackDebugEvent(
  host: DebugSessionHost,
  method: string,
  params: any,
  sessionId: string | undefined,
) {
  const state = host.debug;
  const key = sessionKey(sessionId);
  switch (method) {
    case 'Debugger.paused': {
      const hits: string[] = Array.isArray(params?.hitBreakpoints) ? params.hitBreakpoints : [];
      const pause: PauseRecord = {
        seq: state.nextSeq++,
        key,
        at: Date.now(),
        reason: params?.reason ?? 'other',
        callFrames: Array.isArray(params?.callFrames) ? params.callFrames : [],
        hitBreakpoints: hits,
        ...(params?.data !== undefined ? { data: params.data } : {}),
        ...(params?.asyncStackTrace ? { asyncStackTrace: params.asyncStackTrace } : {}),
      };
      state.pauses.set(key, pause);
      state.pending.delete(key);
      for (const record of state.breakpoints.values()) {
        if (record.key === key && record.cdpId && hits.includes(record.cdpId)) record.hits += 1;
      }
      for (const waiter of [...state.waiters]) {
        if (waiter.key === undefined || waiter.key === key) settle(state, waiter, { pause });
      }
      break;
    }
    case 'Debugger.resumed':
      state.pauses.delete(key);
      break;
    case 'Target.detachedFromTarget':
      if (params?.sessionId) forgetSession(state, params.sessionId);
      break;
  }
}

/** Drops all state; pending waiters return as ended. Used on detach and stop. */
export function clearDebugState(state: DebugState) {
  for (const waiter of [...state.waiters]) settle(state, waiter, { ended: true });
  state.pauses.clear();
  state.breakpoints.clear();
  state.armed.clear();
  state.pending.clear();
  state.groups.clear();
  state.blackbox.clear();
}

/**
 * Resolves with the first pause of `key` (any session when undefined) whose seq is after
 * `afterSeq`; an existing such pause resolves immediately. Register before sending the command
 * that may pause, since Debugger.paused can arrive before the command's response.
 */
export function waitForPause(
  state: DebugState,
  key: string | undefined,
  afterSeq: number,
  timeoutMs: number,
): { promise: Promise<WaitResult>; cancel: () => void } {
  const existing = [...state.pauses.values()]
    .filter((pause) => pause.seq > afterSeq && (key === undefined || pause.key === key))
    .sort((a, b) => a.seq - b.seq)[0];
  if (existing) return { promise: Promise.resolve({ pause: existing }), cancel: () => {} };
  let waiter!: Waiter;
  const promise = new Promise<WaitResult>((resolve) => {
    waiter = {
      key,
      afterSeq,
      resolve,
      timer: setTimeout(() => settle(state, waiter, { timedOut: true }), timeoutMs),
    };
    state.waiters.add(waiter);
  });
  return {
    promise,
    cancel: () => {
      if (state.waiters.has(waiter)) settle(state, waiter, { timedOut: true });
    },
  };
}

async function setSkip(host: DebugSessionHost, key: string, skip: boolean) {
  await cdpSessionManager.sendCommand(
    host.tabId,
    'Debugger.setSkipAllPauses',
    { skip },
    sessionArg(key),
  );
}

export async function arm(host: DebugSessionHost, key: string) {
  if (host.debug.armed.has(key)) return;
  await setSkip(host, key, false);
  host.debug.armed.add(key);
}

/** Disarms a session that has no breakpoints, requested pause, or current pause left. */
export async function disarmIfIdle(host: DebugSessionHost, key: string) {
  const state = host.debug;
  if (!state.armed.has(key) || state.pending.has(key) || state.pauses.has(key)) return;
  if ([...state.breakpoints.values()].some((record) => record.key === key)) return;
  await setSkip(host, key, true);
  state.armed.delete(key);
}

/** Releases evaluate results of a session; called on resume because they pin page objects. */
export async function releaseObjects(host: DebugSessionHost, key: string) {
  if (!host.debug.groups.has(key)) return;
  host.debug.groups.delete(key);
  await cdpSessionManager.sendCommand(
    host.tabId,
    'Runtime.releaseObjectGroup',
    { objectGroup: OBJECT_GROUP },
    sessionArg(key),
  );
}

/**
 * Before stop disables Debugger: skip all pauses on armed sessions so nothing pauses again,
 * then resume paused ones, so the page is never left frozen. Returns errors instead of hiding them.
 */
export async function releaseDebugger(host: DebugSessionHost): Promise<string[]> {
  const state = host.debug;
  const errors: string[] = [];
  const keys = new Set([...state.armed, ...state.pauses.keys(), ...state.groups]);
  for (const key of keys) {
    const label = key ? `session ${key}` : 'page';
    if (state.armed.has(key)) {
      try {
        await setSkip(host, key, true);
      } catch (error) {
        errors.push(`skip pauses in ${label}: ${error instanceof Error ? error.message : error}`);
      }
    }
    if (state.pauses.has(key)) {
      try {
        await cdpSessionManager.sendCommand(host.tabId, 'Debugger.resume', {}, sessionArg(key));
      } catch (error) {
        errors.push(`resume ${label}: ${error instanceof Error ? error.message : error}`);
      }
    }
    try {
      await releaseObjects(host, key);
    } catch (error) {
      errors.push(`release objects in ${label}: ${error instanceof Error ? error.message : error}`);
    }
  }
  clearDebugState(state);
  return errors;
}
