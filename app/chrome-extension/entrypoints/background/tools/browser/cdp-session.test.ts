import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cdpSessionTool } from './cdp-session';
import { cdpBatchTool, cdpCommandTool } from './cdp';
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

type EventListener = (source: any, method: string, params?: any) => void;
type DetachListener = (source: any, reason: string) => void;
let eventListeners: EventListener[];
let detachListeners: DetachListener[];
let removedListeners: Array<(tabId: number) => void>;

const A = { owner: 'cli:A', strictTarget: true };
const B = { owner: 'cli:B', strictTarget: true };

function emit(method: string, params?: unknown, sessionId?: string, tabId = 7) {
  for (const listener of eventListeners) listener({ tabId, sessionId }, method, params);
}

function body(result: any) {
  expect(result.isError).toBe(false);
  return JSON.parse(result.content[0].text);
}

function errorText(result: any): string {
  expect(result.isError).toBe(true);
  return result.content[0].text;
}

const session = (args: Record<string, unknown>, context: any = A) =>
  cdpSessionTool.execute({ tabId: 7, ...args } as any, context);

beforeEach(() => {
  vi.clearAllMocks();
  clearCdpSessionsForTest();
  eventListeners = [];
  detachListeners = [];
  removedListeners = [];
  vi.stubGlobal('chrome', {
    tabs: {
      get: vi.fn(async (id: number) =>
        id === 7 || id === 8 ? { id, windowId: 1 } : Promise.reject(new Error('No tab')),
      ),
      query: vi.fn(async () => [{ id: 7, windowId: 1, active: true }]),
      onRemoved: { addListener: (fn: (tabId: number) => void) => removedListeners.push(fn) },
    },
    windows: { getLastFocused: vi.fn(async () => ({ id: 1 })) },
    debugger: {
      onEvent: { addListener: (fn: EventListener) => eventListeners.push(fn) },
      onDetach: { addListener: (fn: DetachListener) => detachListeners.push(fn) },
    },
  });
  vi.mocked(cdpSessionManager.attach).mockResolvedValue(undefined);
  vi.mocked(cdpSessionManager.detach).mockResolvedValue(undefined);
  vi.mocked(cdpSessionManager.sendCommand).mockResolvedValue({});
});
afterEach(() => {
  clearCdpSessionsForTest();
  vi.unstubAllGlobals();
});

describe('chrome_cdp_session lifecycle', () => {
  test('holds one owner-tagged attach and enables flattened auto-attach', async () => {
    const started = body(await session({ action: 'start', events: ['Runtime'] }));
    expect(started).toMatchObject({ started: true, active: true, autoAttach: true, buffered: 0 });
    expect(cdpSessionManager.attach).toHaveBeenCalledExactlyOnceWith(7, 'cdp-session:cli:A');
    expect(cdpSessionManager.sendCommand).toHaveBeenCalledWith(7, 'Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
    expect(cdpSessionManager.detach).not.toHaveBeenCalled();

    expect(body(await session({ action: 'stop' }))).toMatchObject({ stopped: true });
    expect(cdpSessionManager.sendCommand).toHaveBeenLastCalledWith(7, 'Target.setAutoAttach', {
      autoAttach: false,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
    expect(cdpSessionManager.detach).toHaveBeenCalledExactlyOnceWith(7, 'cdp-session:cli:A');
    expect(body(await session({ action: 'status' }))).toEqual({
      success: true,
      tool: 'chrome_cdp_session',
      tabId: 7,
      started: false,
    });
  });

  test('requires a task owner instead of creating an unowned session', async () => {
    expect(errorText(await session({ action: 'start' }, {}))).toContain('CDP_SESSION_NOT_STARTED');
    expect(cdpSessionManager.attach).not.toHaveBeenCalled();
  });

  test('rejects reads before start and a second start in the same task', async () => {
    expect(errorText(await session({ action: 'events' }))).toContain('CDP_SESSION_NOT_STARTED');
    await session({ action: 'start' });
    expect(errorText(await session({ action: 'start' }))).toContain('CDP_SESSION_ACTIVE');
    expect(cdpSessionManager.attach).toHaveBeenCalledOnce();
  });

  test('isolates sessions between tasks', async () => {
    await session({ action: 'start', events: ['*'] });
    emit('Runtime.consoleAPICalled', { type: 'log' });
    for (const action of ['start', 'status', 'events', 'stop']) {
      expect(errorText(await session({ action }, B))).toContain('CDP_SESSION_OWNED');
    }
    expect(cdpSessionManager.detach).not.toHaveBeenCalled();
  });

  test('rolls back the attach when auto-attach fails', async () => {
    vi.mocked(cdpSessionManager.sendCommand).mockRejectedValueOnce(new Error('Not allowed'));
    expect(errorText(await session({ action: 'start' }))).toContain('Not allowed');
    expect(cdpSessionManager.detach).toHaveBeenCalledExactlyOnceWith(7, 'cdp-session:cli:A');
    expect(body(await session({ action: 'status' }))).toMatchObject({ started: false });
  });

  test('reports incomplete cleanup instead of claiming a clean stop', async () => {
    await session({ action: 'start' });
    vi.mocked(cdpSessionManager.detach).mockRejectedValueOnce(new Error('detach denied'));
    expect(errorText(await session({ action: 'stop' }))).toContain(
      'CDP_SESSION_STOP_INCOMPLETE: detach: detach denied',
    );
  });

  test('a closed explicit tab fails instead of falling back to the active tab', async () => {
    expect(errorText(await session({ action: 'status', tabId: 99 }))).toContain('TARGET_CLOSED');
    expect(chrome.tabs.query).not.toHaveBeenCalled();
  });
});

describe('chrome_cdp_session events', () => {
  test('buffers only subscribed methods with monotonic cursors', async () => {
    await session({ action: 'start', events: ['Runtime', 'Network.requestWillBeSent'] });
    emit('Runtime.consoleAPICalled', { type: 'log', n: 1 });
    emit('Network.responseReceived', { requestId: 'x' });
    emit('Network.requestWillBeSent', { requestId: 'y' });
    emit('Runtimes.notADomainMatch', {});
    emit('Runtime.consoleAPICalled', { n: 2 }, undefined, 8);

    const first = body(await session({ action: 'events', limit: 1 }));
    expect(first.events.map((event: any) => [event.seq, event.method])).toEqual([
      [1, 'Runtime.consoleAPICalled'],
    ]);
    expect(first).toMatchObject({ nextAfter: 1, hasMore: true, missed: 0, dropped: 0 });
    const second = body(await session({ action: 'events', after: first.nextAfter }));
    expect(second.events.map((event: any) => event.method)).toEqual(['Network.requestWillBeSent']);
    expect(second).toMatchObject({ nextAfter: 2, hasMore: false });
  });

  test('reports ring-buffer loss through dropped and missed', async () => {
    await session({ action: 'start', events: ['*'], maxEvents: 2 });
    for (let index = 0; index < 5; index += 1) emit('Runtime.consoleAPICalled', { index });
    const page = body(await session({ action: 'events' }));
    expect(page.events.map((event: any) => event.seq)).toEqual([4, 5]);
    expect(page).toMatchObject({ dropped: 3, missed: 3 });
    expect(body(await session({ action: 'events', after: 4 }))).toMatchObject({ missed: 0 });
  });

  test('pages by bytes but always makes progress past an oversized event', async () => {
    await session({ action: 'start', events: ['*'] });
    emit('Runtime.consoleAPICalled', { text: 'word '.repeat(600) });
    emit('Runtime.consoleAPICalled', { text: 'b' });
    const page = body(await session({ action: 'events', maxOutputBytes: 1000 }));
    expect(page.events).toHaveLength(1);
    expect(page.events[0]).toMatchObject({ seq: 1, truncated: true });
    expect(page).toMatchObject({ nextAfter: 1, hasMore: true });
    const next = body(await session({ action: 'events', after: 1, maxOutputBytes: 1000 }));
    expect(next.events[0]).toMatchObject({ seq: 2, params: { text: 'b' } });
  });

  test('redacts sensitive event fields by default', async () => {
    await session({ action: 'start', events: ['Network'] });
    emit('Network.requestWillBeSent', { request: { headers: { Authorization: 'Bearer SECRET' } } });
    const text = JSON.stringify(body(await session({ action: 'events' })).events);
    expect(text).not.toContain('SECRET');
    const raw = body(await session({ action: 'events', sanitizeOutput: false }));
    expect(JSON.stringify(raw.events)).toContain('SECRET');
  });

  test('discards the session of a closed tab, which no later call can address', async () => {
    await session({ action: 'start', events: ['*'] });
    emit('Runtime.consoleAPICalled', {});
    for (const listener of detachListeners) listener({ tabId: 7 }, 'target_closed');
    for (const listener of removedListeners) listener(7);
    expect(body(await session({ action: 'status' }))).toMatchObject({ started: false });
    expect(body(await session({ action: 'start' }))).toMatchObject({ active: true, buffered: 0 });
  });

  test('keeps events readable after a detach while the tab stays open', async () => {
    await session({ action: 'start', events: ['Inspector'] });
    emit('Target.attachedToTarget', {
      sessionId: 'child-1',
      targetInfo: { targetId: 'T1', type: 'iframe', url: 'https://child.test/' },
    });
    emit('Inspector.targetCrashed', {});
    for (const listener of detachListeners) listener({ tabId: 7 }, 'canceled_by_user');
    emit('Inspector.afterDetach', {});

    const page = body(await session({ action: 'events' }));
    expect(page).toMatchObject({ active: false, ended: { reason: 'canceled_by_user' } });
    expect(page.events.map((event: any) => event.method)).toEqual(['Inspector.targetCrashed']);
    expect(body(await session({ action: 'status' })).targets).toEqual([]);
    expect(
      errorText(
        await cdpCommandTool.execute(
          { tabId: 7, method: 'Runtime.evaluate', sessionId: 'child-1' },
          A,
        ),
      ),
    ).toContain('CDP_SESSION_ENDED');
    expect(body(await session({ action: 'stop' }))).toMatchObject({ stopped: true });
    expect(cdpSessionManager.detach).not.toHaveBeenCalled();
  });
});

describe('child session routing', () => {
  async function startWithChild() {
    await session({ action: 'start' });
    emit('Target.attachedToTarget', {
      sessionId: 'child-1',
      targetInfo: { targetId: 'T1', type: 'iframe', url: 'https://child.test/' },
    });
  }

  test('tracks attached targets and routes commands by sessionId', async () => {
    await startWithChild();
    expect(body(await session({ action: 'status' })).targets).toMatchObject([
      { sessionId: 'child-1', targetId: 'T1', type: 'iframe', url: 'https://child.test/' },
    ]);
    vi.mocked(cdpSessionManager.sendCommand).mockResolvedValueOnce({ result: { value: 2 } });
    const result = body(
      await cdpCommandTool.execute(
        {
          tabId: 7,
          method: 'Runtime.evaluate',
          params: { expression: '1+1' },
          sessionId: 'child-1',
        },
        A,
      ),
    );
    expect(result).toMatchObject({ success: true, sessionId: 'child-1' });
    expect(cdpSessionManager.sendCommand).toHaveBeenLastCalledWith(
      7,
      'Runtime.evaluate',
      { expression: '1+1' },
      'child-1',
    );

    await cdpBatchTool.execute(
      { tabId: 7, commands: [{ method: 'Runtime.enable' }], sessionId: 'child-1' },
      A,
    );
    expect(cdpSessionManager.sendCommand).toHaveBeenLastCalledWith(
      7,
      'Runtime.enable',
      {},
      'child-1',
    );
  });

  test.each([
    ['unknown child', 'child-2', A, 'CDP_UNKNOWN_SESSION'],
    ['another task', 'child-1', B, 'CDP_SESSION_OWNED'],
    ['no task owner', 'child-1', {}, 'CDP_SESSION_NOT_STARTED'],
  ])('rejects %s before sending any CDP command', async (_label, sessionId, context, code) => {
    await startWithChild();
    vi.mocked(cdpSessionManager.sendCommand).mockClear();
    const text = errorText(
      await cdpCommandTool.execute({ tabId: 7, method: 'Runtime.evaluate', sessionId }, context),
    );
    expect(text).toContain(code);
    expect(cdpSessionManager.sendCommand).not.toHaveBeenCalled();
  });

  test('forgets detached children', async () => {
    await startWithChild();
    emit('Target.detachedFromTarget', { sessionId: 'child-1' });
    expect(body(await session({ action: 'status' })).targets).toEqual([]);
    expect(
      errorText(
        await cdpCommandTool.execute(
          { tabId: 7, method: 'Runtime.evaluate', sessionId: 'child-1' },
          A,
        ),
      ),
    ).toContain('CDP_UNKNOWN_SESSION');
  });

  test('root commands without sessionId keep the previous path', async () => {
    await cdpCommandTool.execute({ tabId: 7, method: 'Page.getFrameTree' }, A);
    expect(cdpSessionManager.sendCommand).toHaveBeenLastCalledWith(
      7,
      'Page.getFrameTree',
      {},
      undefined,
    );
  });
});
