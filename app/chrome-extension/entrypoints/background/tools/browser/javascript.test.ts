import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { javascriptTool } from './javascript';
import { cdpSessionTool } from './cdp-session';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { clearCdpSessionsForTest } from '@/utils/cdp-event-hub';

vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: {
    attach: vi.fn(),
    detach: vi.fn(),
    sendCommand: vi.fn(),
    withSession: vi.fn(async (_tabId: number, _owner: string, fn: () => Promise<unknown>) => fn()),
  },
}));

/**
 * Fake tab shaped like the real B4 probe: top page with a same-site iframe, two iframes with the
 * same URL, and a cross-site OOPIF (its own CDP session) that contains a nested same-process frame.
 * Extension frame IDs and CDP frame IDs share no key; the fake maps them through owner elements.
 */
interface FakeFrame {
  frameId: number;
  parent: number;
  cdp: string;
  session?: string;
  url: string;
  documentId: string;
}
const FRAMES: FakeFrame[] = [
  { frameId: 0, parent: -1, cdp: 'TOP', url: 'http://a.test/frames', documentId: 'D0' },
  { frameId: 11, parent: 0, cdp: 'SAME', url: 'http://a.test/child?same', documentId: 'D11' },
  { frameId: 12, parent: 0, cdp: 'DUPA', url: 'http://a.test/child?dup', documentId: 'D12' },
  { frameId: 13, parent: 0, cdp: 'DUPB', url: 'http://a.test/child?dup', documentId: 'D13' },
  { frameId: 14, parent: 0, cdp: 'OOPIF', url: 'http://b.test/child', documentId: 'D14' },
  {
    frameId: 15,
    parent: 14,
    cdp: 'NESTED',
    session: 'child-1',
    url: 'http://b.test/nested',
    documentId: 'D15',
  },
];
const CHILDREN: Record<string, string[]> = {
  TOP: ['SAME', 'DUPA', 'DUPB', 'OOPIF'],
  OOPIF: ['NESTED'],
};
const SESSION_FRAMES: Record<string, string[]> = {
  '': ['TOP', 'SAME', 'DUPA', 'DUPB'],
  'child-1': ['OOPIF', 'NESTED'],
};
const ctxOf = (frame: string) => 100 + Object.keys(cdpOf).indexOf(frame);
const cdpOf = Object.fromEntries(FRAMES.map((frame) => [frame.cdp, frame]));

type EventListener = (source: any, method: string, params?: any) => void;
let eventListeners: EventListener[];
let calls: Array<{ method: string; params: any; sessionId?: string }>;
let navigateDuringLookup: boolean;
let workerTargets: chrome.debugger.TargetInfo[];

const A = { owner: 'cli:A', strictTarget: true };
const B = { owner: 'cli:B', strictTarget: true };

function emit(method: string, params?: unknown, sessionId?: string) {
  for (const listener of eventListeners) listener({ tabId: 7, sessionId }, method, params);
}

function sessionKey(sessionId?: string) {
  return sessionId ?? '';
}

// The OOPIF is absent from the root session's tree; it is the root of its own child session.
function tree(id: string): any {
  const children = (CHILDREN[id] || []).filter((child) => child !== 'OOPIF');
  return { frame: { id }, childFrames: children.map(tree) };
}

function fakeCdp(method: string, params: any = {}, sessionId?: string): any {
  calls.push({ method, params, sessionId });
  const key = sessionKey(sessionId);
  switch (method) {
    case 'Page.getFrameTree':
      return { frameTree: tree(key === '' ? 'TOP' : 'OOPIF') };
    case 'Page.createIsolatedWorld': {
      if (!SESSION_FRAMES[key].includes(params.frameId))
        throw new Error('No frame for given id found');
      return { executionContextId: ctxOf(params.frameId) };
    }
    case 'Runtime.evaluate': {
      const owner = /window\.frames\[(\d+)\]/.exec(params.expression || '');
      if (owner) {
        const parent = Object.keys(cdpOf)[params.contextId - 100];
        const child = CHILDREN[parent]?.[Number(owner[1])];
        return {
          result: child ? { objectId: `owner:${child}` } : { type: 'object', subtype: 'null' },
        };
      }
      return {
        result: { type: 'string', value: `ran:${key || 'root'}:${params.contextId ?? 'default'}` },
      };
    }
    case 'DOM.describeNode': {
      if (params.objectId) return { node: { frameId: params.objectId.slice('owner:'.length) } };
      return { node: { contentDocument: { backendNodeId: params.backendNodeId + 1000 } } };
    }
    case 'DOM.getFrameOwner':
      return { backendNodeId: Object.keys(cdpOf).indexOf(params.frameId) };
    case 'DOM.resolveNode':
      return { object: { objectId: `doc:${params.backendNodeId}` } };
    case 'Runtime.callFunctionOn':
      return { result: { type: 'string', value: `main:${params.objectId}` } };
    default:
      return {};
  }
}

function body(result: any) {
  expect(result.isError).toBe(false);
  return JSON.parse(result.content[0].text);
}

function failure(result: any) {
  return JSON.parse(errorText(result));
}

function errorText(result: any): string {
  expect(result.isError).toBe(true);
  return result.content[0].text;
}

const run = (args: Record<string, unknown>, context: any = A) =>
  javascriptTool.execute({ tabId: 7, code: 'return 1', ...args } as any, context);

beforeEach(() => {
  vi.clearAllMocks();
  clearCdpSessionsForTest();
  eventListeners = [];
  calls = [];
  navigateDuringLookup = false;
  workerTargets = [];
  vi.stubGlobal('chrome', {
    tabs: {
      get: vi.fn(async (id: number) =>
        id === 7 ? { id, windowId: 1 } : Promise.reject(new Error('No tab')),
      ),
      query: vi.fn(async () => [{ id: 7, windowId: 1, active: true }]),
      onRemoved: { addListener: vi.fn() },
    },
    webNavigation: {
      getAllFrames: vi.fn(async () =>
        FRAMES.map((frame) => ({
          frameId: frame.frameId,
          parentFrameId: frame.parent,
          url: frame.url,
          documentId: frame.documentId,
        })),
      ),
      getFrame: vi.fn(async ({ frameId }: { frameId: number }) => {
        const frame = FRAMES.find((item) => item.frameId === frameId);
        if (!frame) return null;
        return { documentId: navigateDuringLookup ? 'NEW' : frame.documentId };
      }),
    },
    scripting: {
      executeScript: vi.fn(async ({ target }: any) =>
        target.frameIds.map((frameId: number) => {
          const frame = FRAMES.find((item) => item.frameId === frameId)!;
          const parent = FRAMES.find((item) => item.frameId === frame.parent)!;
          return { frameId, result: CHILDREN[parent.cdp].indexOf(frame.cdp) };
        }),
      ),
    },
    debugger: {
      onEvent: { addListener: (fn: EventListener) => eventListeners.push(fn) },
      onDetach: { addListener: vi.fn() },
      getTargets: vi.fn(async () => workerTargets),
      attach: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
      sendCommand: vi.fn(async () => ({ result: { type: 'string', value: 'shared-worker' } })),
    },
  });
  vi.mocked(cdpSessionManager.attach).mockResolvedValue(undefined);
  vi.mocked(cdpSessionManager.detach).mockResolvedValue(undefined);
  vi.mocked(cdpSessionManager.sendCommand).mockImplementation(
    async (_tab, method, params, sessionId) => fakeCdp(method, params, sessionId),
  );
});
afterEach(() => {
  clearCdpSessionsForTest();
  vi.unstubAllGlobals();
});

async function holdSessionWithOopif(context = A) {
  await cdpSessionTool.execute({ tabId: 7, action: 'start' } as any, context);
  emit('Target.attachedToTarget', {
    sessionId: 'child-1',
    targetInfo: { targetId: 'OOPIF', type: 'iframe', url: 'http://b.test/child' },
  });
  calls = [];
}

const evaluations = () => calls.filter((call) => /evaluate|callFunctionOn/.test(call.method));
const userEvaluation = () =>
  evaluations().filter((call) => !/window\.frames/.test(call.params.expression || ''));

describe('chrome_javascript frame contexts', () => {
  test('top frame MAIN keeps the plain page Runtime.evaluate path', async () => {
    const result = body(await run({}));
    expect(result).toMatchObject({ success: true, frameId: 0, world: 'MAIN', engine: 'cdp' });
    expect(calls).toEqual([
      {
        method: 'Runtime.evaluate',
        params: expect.objectContaining({ awaitPromise: true, returnByValue: true }),
        sessionId: undefined,
      },
    ]);
    expect(calls[0].params.contextId).toBeUndefined();
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });

  test('a same-process subframe runs in its main world through its document node', async () => {
    const result = body(await run({ frameId: 11 }));
    expect(result).toMatchObject({ frameId: 11, world: 'MAIN', cdpFrameId: 'SAME' });
    expect(result.sessionId).toBeUndefined();
    const call = userEvaluation();
    expect(call).toHaveLength(1);
    expect(call[0]).toMatchObject({ method: 'Runtime.callFunctionOn', sessionId: undefined });
    expect(call[0].params.functionDeclaration).toContain('.call(globalThis)');
    expect(calls.some((item) => /^(Runtime|DOM)\.enable$/.test(item.method))).toBe(false);
    expect(calls.at(-1)).toMatchObject({ method: 'Runtime.releaseObjectGroup' });
  });

  test('iframes with the same URL map to their own CDP frames', async () => {
    expect(body(await run({ frameId: 12 })).cdpFrameId).toBe('DUPA');
    expect(body(await run({ frameId: 13 })).cdpFrameId).toBe('DUPB');
  });

  test('ISOLATED runs in a named isolated world of the chosen frame, including the top frame', async () => {
    const sub = body(await run({ frameId: 11, world: 'ISOLATED' }));
    expect(sub).toMatchObject({ world: 'ISOLATED', cdpFrameId: 'SAME', result: 'ran:root:101' });
    expect(calls).toContainEqual({
      method: 'Page.createIsolatedWorld',
      params: { frameId: 'SAME', worldName: 'aeb-javascript' },
      sessionId: undefined,
    });
    calls = [];
    const top = body(await run({ world: 'ISOLATED' }));
    expect(top).toMatchObject({ frameId: 0, world: 'ISOLATED', cdpFrameId: 'TOP' });
    expect(chrome.scripting.executeScript).toHaveBeenCalledOnce();
  });

  test('a cross-process frame without a held session fails before evaluating anywhere', async () => {
    const result = failure(await run({ frameId: 14 }));
    expect(result.error.kind).toBe('target_error');
    expect(result.error.message).toMatch(
      /^CDP_SESSION_NOT_STARTED: frame 14 is in a cross-process iframe/,
    );
    expect(userEvaluation()).toEqual([]);
  });

  test('a cross-process frame held by another task is refused', async () => {
    await holdSessionWithOopif(B);
    expect(failure(await run({ frameId: 14 })).error.message).toMatch(/^CDP_SESSION_OWNED/);
    expect(userEvaluation()).toEqual([]);
  });

  test('the held child session runs the OOPIF root and a frame nested inside it', async () => {
    await holdSessionWithOopif();
    const root = body(await run({ frameId: 14 }));
    expect(root).toMatchObject({
      cdpFrameId: 'OOPIF',
      sessionId: 'child-1',
      result: 'ran:child-1:default',
    });
    calls = [];
    const nested = body(await run({ frameId: 15 }));
    expect(nested).toMatchObject({ cdpFrameId: 'NESTED', sessionId: 'child-1' });
    expect(userEvaluation()).toEqual([
      expect.objectContaining({ method: 'Runtime.callFunctionOn', sessionId: 'child-1' }),
    ]);
    calls = [];
    const isolated = body(await run({ frameId: 15, world: 'ISOLATED' }));
    expect(isolated).toMatchObject({ world: 'ISOLATED', sessionId: 'child-1' });
    expect(calls).toContainEqual({
      method: 'Page.createIsolatedWorld',
      params: { frameId: 'NESTED', worldName: 'aeb-javascript' },
      sessionId: 'child-1',
    });
  });

  test('a cross-process frame that is not an attached child target is reported', async () => {
    await cdpSessionTool.execute({ tabId: 7, action: 'start' } as any, A);
    expect(failure(await run({ frameId: 14 })).error.message).toMatch(/^FRAME_TARGET_NOT_ATTACHED/);
  });

  test.each([
    ['an unknown frame', { frameId: 99 }, 'FRAME_NOT_FOUND'],
    ['a frame that navigates during lookup', { frameId: 11 }, 'FRAME_CHANGED'],
  ])('fails on %s', async (_label, args, code) => {
    navigateDuringLookup = code === 'FRAME_CHANGED';
    const result = failure(await run(args));
    expect(result.error).toMatchObject({ kind: 'target_error' });
    expect(result.error.message.startsWith(code)).toBe(true);
    expect(userEvaluation()).toEqual([]);
  });

  test('an owner element the lookup cannot see (shadow DOM) is not guessed', async () => {
    vi.mocked(chrome.scripting.executeScript).mockResolvedValueOnce([
      { frameId: 11, result: 9 },
    ] as never);
    const result = failure(await run({ frameId: 11 }));
    expect(result.error.message).toMatch(/^FRAME_MAPPING_FAILED: owner element of frame 11/);
  });

  test('a busy debugger fails explicitly without a chrome.scripting fallback', async () => {
    vi.mocked(cdpSessionManager.withSession).mockRejectedValueOnce(
      new Error(
        'Debugger is already attached to tab 7 by another client (e.g., DevTools/extension)',
      ),
    );
    const result = failure(await run({}));
    expect(result.error.kind).toBe('debugger_conflict');
    expect(result.warnings).toBeUndefined();
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });

  test.each([
    [{ frameId: 1, sessionId: 's' }, 'use only one of frameId, sessionId'],
    [{ sessionId: 's', workerTargetId: 'w' }, 'use only one of sessionId, workerTargetId'],
    [{ frameId: -1 }, 'frameId must be a non-negative integer'],
    [{ frameId: 1.5 }, 'frameId must be a non-negative integer'],
    [{ world: 'PAGE' }, 'world must be MAIN or ISOLATED'],
    [{ sessionId: 's', world: 'ISOLATED' }, 'world ISOLATED needs a frame'],
    [{ workerTargetId: '' }, 'workerTargetId must be a non-empty string'],
  ])('rejects %j before any IO', async (args, message) => {
    expect(errorText(await run(args))).toContain(`INVALID_ARGUMENT: ${message}`);
    expect(calls).toEqual([]);
    expect(chrome.tabs.get).not.toHaveBeenCalled();
  });
});

describe('chrome_javascript workers', () => {
  async function holdSessionWithWorker() {
    await cdpSessionTool.execute({ tabId: 7, action: 'start' } as any, A);
    emit('Target.attachedToTarget', {
      sessionId: 'worker-1',
      targetInfo: { targetId: 'W1', type: 'worker', url: 'http://a.test/w.js' },
    });
    emit('Target.attachedToTarget', {
      sessionId: 'sw-1',
      targetInfo: { targetId: 'SW1', type: 'service_worker', url: 'http://a.test/sw.js' },
    });
    calls = [];
  }

  test('runs in a held worker child session', async () => {
    await holdSessionWithWorker();
    const result = body(await run({ sessionId: 'worker-1' }));
    expect(result).toMatchObject({ sessionId: 'worker-1', result: 'ran:worker-1:default' });
    expect(result.world).toBeUndefined();
    expect(calls).toEqual([
      expect.objectContaining({ method: 'Runtime.evaluate', sessionId: 'worker-1' }),
    ]);
  });

  test.each([
    ['an unknown session', 'nope', A, 'CDP_UNKNOWN_SESSION'],
    ['another task', 'worker-1', B, 'CDP_SESSION_OWNED'],
    ['no task owner', 'worker-1', {}, 'CDP_SESSION_NOT_STARTED'],
  ])('refuses %s without sending CDP', async (_label, sessionId, context, code) => {
    await holdSessionWithWorker();
    const result = failure(await run({ sessionId }, context));
    expect(result.error).toMatchObject({ kind: 'target_error' });
    expect(result.error.message.startsWith(code)).toBe(true);
    expect(calls).toEqual([]);
  });

  test('a shared worker target of a tab origin is attached for one call', async () => {
    workerTargets = [
      { id: 'SHARED', type: 'worker', url: 'http://a.test/shared.js', attached: false } as any,
    ];
    const result = body(await run({ workerTargetId: 'SHARED' }));
    expect(result).toMatchObject({ workerTargetId: 'SHARED', result: 'shared-worker' });
    expect(chrome.debugger.attach).toHaveBeenCalledExactlyOnceWith({ targetId: 'SHARED' }, '1.3');
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { targetId: 'SHARED' },
      'Runtime.evaluate',
      expect.objectContaining({ awaitPromise: true }),
    );
    expect(chrome.debugger.detach).toHaveBeenCalledExactlyOnceWith({ targetId: 'SHARED' });
  });

  test('detaches the worker when evaluation fails', async () => {
    workerTargets = [{ id: 'SHARED', type: 'worker', url: 'http://a.test/s.js' } as any];
    vi.mocked(chrome.debugger.sendCommand).mockRejectedValueOnce(new Error('Target closed'));
    expect(failure(await run({ workerTargetId: 'SHARED' })).error).toMatchObject({
      kind: 'cdp_error',
      message: 'Target closed',
    });
    expect(chrome.debugger.detach).toHaveBeenCalledOnce();
  });

  test.each([
    ['another origin', { id: 'X', type: 'worker', url: 'http://other.test/s.js' }],
    ['a non-worker target', { id: 'X', type: 'page', url: 'http://a.test/' }],
  ])('refuses a worker target of %s', async (_label, target) => {
    workerTargets = [target as any];
    const result = failure(await run({ workerTargetId: 'X' }));
    expect(result.error.message).toMatch(/^WORKER_NOT_FOUND/);
    expect(chrome.debugger.attach).not.toHaveBeenCalled();
  });

  test('chrome_cdp_session workers lists child sessions and browser-level workers', async () => {
    await holdSessionWithWorker();
    emit('Target.attachedToTarget', {
      sessionId: 'child-1',
      targetInfo: { targetId: 'OOPIF', type: 'iframe', url: 'http://b.test/child' },
    });
    workerTargets = [
      { id: 'SW1', type: 'worker', url: 'http://a.test/sw.js', attached: false } as any,
      { id: 'SHARED', type: 'worker', url: 'http://a.test/shared.js', attached: false } as any,
      { id: 'FOREIGN', type: 'worker', url: 'http://other.test/s.js', attached: false } as any,
    ];
    const listed = body(await cdpSessionTool.execute({ tabId: 7, action: 'workers' } as any, A));
    expect(listed.sessions.map((target: any) => [target.sessionId, target.type])).toEqual([
      ['worker-1', 'worker'],
      ['sw-1', 'service_worker'],
    ]);
    expect(listed.browserTargets).toEqual([
      { workerTargetId: 'SHARED', url: 'http://a.test/shared.js', attached: false },
    ]);
    expect(cdpSessionTool.skipsTargetLock({ action: 'workers' })).toBe(true);
    const foreign = await cdpSessionTool.execute({ tabId: 7, action: 'workers' } as any, B);
    expect(errorText(foreign)).toContain('CDP_SESSION_OWNED');
  });
});
