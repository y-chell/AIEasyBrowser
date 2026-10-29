import { cdpSessionManager } from '@/utils/cdp-session-manager';

/**
 * Pause-on-start of auto-attached children, shared by document-start injection and the network
 * table: while any feature holds it, a new child is attached paused (waitForDebuggerOnStart), every
 * feature sets it up, and the session hub resumes it. Each feature releases its hold when it no
 * longer needs children to wait.
 */

export interface ChildStartState {
  holds: Set<string>;
  waitOnStart: boolean;
  /** Resume failures; feature setup errors stay with the feature. */
  errors: string[];
}

export interface ChildStartHost {
  tabId: number;
  autoAttach: boolean;
  childStart: ChildStartState;
}

export function createChildStartState(): ChildStartState {
  return { holds: new Set(), waitOnStart: false, errors: [] };
}

/** Detach ends auto-attach in Chrome; only the bookkeeping is left to clear. */
export function clearChildStartState(state: ChildStartState) {
  state.holds.clear();
  state.waitOnStart = false;
}

export function noteChildStartError(state: ChildStartState, message: string) {
  state.errors.push(message);
  if (state.errors.length > 20) state.errors.shift();
}

async function sync(host: ChildStartHost) {
  const state = host.childStart;
  const wait = state.holds.size > 0;
  if (!host.autoAttach || state.waitOnStart === wait) return;
  await cdpSessionManager.sendCommand(host.tabId, 'Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: wait,
    flatten: true,
  });
  state.waitOnStart = wait;
}

export async function holdChildStart(host: ChildStartHost, feature: string) {
  host.childStart.holds.add(feature);
  try {
    await sync(host);
  } catch (error) {
    host.childStart.holds.delete(feature);
    throw error;
  }
}

export async function releaseChildStart(host: ChildStartHost, feature: string) {
  host.childStart.holds.delete(feature);
  await sync(host);
}

/** Runs once per key; a failed run is retried by the next caller instead of being cached. */
export function once(map: Map<string, Promise<void>>, key: string, run: () => Promise<void>) {
  let ready = map.get(key);
  if (!ready) {
    ready = run();
    map.set(key, ready);
    ready.catch(() => map.delete(key));
  }
  return ready;
}
