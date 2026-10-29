import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { getOwnedSession } from '@/utils/cdp-event-hub';

/**
 * Maps an extension frame ID (webNavigation / scripting, a number) to its CDP frame and session.
 *
 * Chrome exposes no shared key: chrome.runtime.getFrameId is absent in content scripts (Chrome 156),
 * webNavigation documentId and CDP loaderId differ, CDP frame names come from the owner element
 * id, and two iframes may load the same URL. The mapping therefore goes through the owner element:
 * each frame on the chain reports its index in parent.frames (a read-only scripting call), and in
 * the parent's CDP session that index selects the owner element whose DOM.describeNode frameId
 * is the CDP frame. An OOPIF's CDP frame ID equals its target ID, which selects the held child
 * session. Lookups run in a hidden isolated world so page scripts cannot redirect them.
 */

const MAP_WORLD = 'aeb-frame-map';
const MAP_GROUP = 'aeb-frame-map';

export interface ResolvedFrame {
  frameId: number;
  cdpFrameId: string;
  /** Child CDP session for frames inside an OOPIF; absent in the tab's root session. */
  sessionId?: string;
  /** The frame is the main frame of its CDP session (tab top frame or OOPIF root). */
  sessionRoot: boolean;
}

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

function send<T = any>(tabId: number, method: string, params: object, sessionId?: string) {
  return cdpSessionManager.sendCommand<T>(tabId, method, params, sessionId);
}

interface FrameTreeNode {
  frame: { id: string };
  childFrames?: FrameTreeNode[];
}

function collectIds(node: FrameTreeNode, ids: Set<string>) {
  ids.add(node.frame.id);
  for (const child of node.childFrames || []) collectIds(child, ids);
}

/** Frames rendered by one CDP session; OOPIFs are absent and belong to their own child session. */
async function sessionFrames(tabId: number, sessionId: string | undefined) {
  const { frameTree } = await send<{ frameTree: FrameTreeNode }>(
    tabId,
    'Page.getFrameTree',
    {},
    sessionId,
  );
  const ids = new Set<string>();
  collectIds(frameTree, ids);
  return { rootId: frameTree.frame.id, ids };
}

/** Index of each listed frame inside its parent's window.frames, read in the frame itself. */
async function frameIndexes(tabId: number, frameIds: number[]): Promise<Map<number, number>> {
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds },
    world: 'ISOLATED',
    func: () => {
      for (let index = 0; index < parent.frames.length; index += 1) {
        if (parent.frames[index] === window) return index;
      }
      return -1;
    },
  });
  const indexes = new Map<number, number>();
  for (const result of results) {
    if (typeof result.result === 'number' && result.result >= 0) {
      indexes.set(result.frameId, result.result);
    }
  }
  return indexes;
}

/** CDP frame ID of the owner element of parent.frames[index], read in the parent's session. */
async function ownerFrameId(
  tabId: number,
  sessionId: string | undefined,
  parentCdpFrameId: string,
  index: number,
): Promise<string | undefined> {
  const { executionContextId } = await send<{ executionContextId: number }>(
    tabId,
    'Page.createIsolatedWorld',
    { frameId: parentCdpFrameId, worldName: MAP_WORLD },
    sessionId,
  );
  try {
    const found = await send<{ result?: { objectId?: string } }>(
      tabId,
      'Runtime.evaluate',
      {
        contextId: executionContextId,
        // contentWindow comparison works for cross-origin children; querySelectorAll does not
        // pierce shadow roots, so a frame owned by a shadow-tree element is reported unmapped.
        expression: `(() => { const w = window.frames[${index}]; return [...document.querySelectorAll('iframe,frame,object')].find((el) => el.contentWindow === w) || null; })()`,
        objectGroup: MAP_GROUP,
      },
      sessionId,
    );
    const objectId = found.result?.objectId;
    if (!objectId) return undefined;
    const { node } = await send<{ node?: { frameId?: string } }>(
      tabId,
      'DOM.describeNode',
      { objectId },
      sessionId,
    );
    return node?.frameId;
  } finally {
    await send(tabId, 'Runtime.releaseObjectGroup', { objectGroup: MAP_GROUP }, sessionId).catch(
      () => undefined,
    );
  }
}

/** Held child session of this task for an OOPIF target; never attaches on its own. */
function oopifSession(tabId: number, owner: string | undefined, frameId: number, targetId: string) {
  const hint = `frame ${frameId} is in a cross-process iframe; start chrome_cdp_session on tab ${tabId} in this task first`;
  if (!owner) fail('CDP_SESSION_NOT_STARTED', `${hint} (requires a named task session)`);
  let session;
  try {
    session = getOwnedSession(tabId, owner);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('CDP_SESSION_NOT_STARTED')) fail('CDP_SESSION_NOT_STARTED', hint);
    throw error;
  }
  if (session.ended) {
    fail('CDP_SESSION_ENDED', `tab ${tabId} debugger session ended (${session.ended.reason})`);
  }
  const target = [...session.targets.values()].find((item) => item.targetId === targetId);
  if (!target) {
    // Only the root session auto-attaches, so an OOPIF nested inside another OOPIF lands here.
    fail(
      'FRAME_TARGET_NOT_ATTACHED',
      `cross-process frame ${frameId} (target ${targetId}) is not an attached child session of tab ${tabId}`,
    );
  }
  return target.sessionId;
}

/**
 * Resolves an extension frame ID to its CDP frame and session. Must run inside an attach of the
 * tab (cdpSessionManager.withSession or a held session).
 */
export async function resolveFrame(
  tabId: number,
  frameId: number,
  owner: string | undefined,
): Promise<ResolvedFrame> {
  const all = await chrome.webNavigation.getAllFrames({ tabId });
  const byId = new Map((all || []).map((frame) => [frame.frameId, frame]));
  const target = byId.get(frameId);
  if (!target) fail('FRAME_NOT_FOUND', `frame ${frameId} does not exist in tab ${tabId}`);

  const chain: number[] = [];
  for (let id = frameId; id !== 0; ) {
    chain.unshift(id);
    const parent = byId.get(id)?.parentFrameId;
    if (parent === undefined || parent < 0) {
      fail('FRAME_NOT_FOUND', `frame ${id} has no parent frame in tab ${tabId}`);
    }
    id = parent;
  }

  const root = await sessionFrames(tabId, undefined);
  if (chain.length === 0) {
    return { frameId: 0, cdpFrameId: root.rootId, sessionRoot: true };
  }

  const indexes = await frameIndexes(tabId, chain);
  const trees = new Map<string | undefined, Awaited<ReturnType<typeof sessionFrames>>>([
    [undefined, root],
  ]);
  let sessionId: string | undefined;
  let current = root.rootId;
  let sessionRoot = true;
  for (const id of chain) {
    const index = indexes.get(id);
    if (index === undefined) {
      fail('FRAME_MAPPING_FAILED', `frame ${id} could not report its position in its parent`);
    }
    const next = await ownerFrameId(tabId, sessionId, current, index);
    if (!next) {
      fail(
        'FRAME_MAPPING_FAILED',
        `owner element of frame ${id} was not found in its parent document (shadow DOM or a concurrent change)`,
      );
    }
    if (trees.get(sessionId)!.ids.has(next)) {
      sessionRoot = false;
    } else {
      sessionId = oopifSession(tabId, owner, id, next);
      const child = await sessionFrames(tabId, sessionId);
      if (child.rootId !== next) {
        fail('FRAME_MAPPING_FAILED', `child session of frame ${id} renders another frame`);
      }
      trees.set(sessionId, child);
      sessionRoot = true;
    }
    current = next;
  }

  // The positions were read before the CDP walk; a navigation in between invalidates them.
  const after = await chrome.webNavigation.getFrame({ tabId, frameId });
  if (!after || after.documentId !== target.documentId) {
    fail('FRAME_CHANGED', `frame ${frameId} navigated while it was being resolved; retry`);
  }
  return { frameId, cdpFrameId: current, ...(sessionId ? { sessionId } : {}), sessionRoot };
}

function originOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

/** http(s) origins of the documents currently in the tab. */
export async function tabFrameOrigins(tabId: number): Promise<Set<string>> {
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  const origins = new Set<string>();
  for (const frame of frames || []) {
    const origin = originOf(frame.url);
    if (origin) origins.add(origin);
  }
  return origins;
}

/** Browser-level worker targets (shared workers, out-of-scope service workers) of the tab's origins. */
export async function browserWorkerTargets(tabId: number): Promise<chrome.debugger.TargetInfo[]> {
  const origins = await tabFrameOrigins(tabId);
  const targets = await chrome.debugger.getTargets();
  return targets.filter((target) => {
    const origin = originOf(target.url);
    return target.type === 'worker' && origin !== undefined && origins.has(origin);
  });
}
