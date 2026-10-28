import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createStructuredToolResult } from '@/common/tool-handler';
import { clearBrowserToolQueues, runBrowserToolCallWithIsolation } from './browser-session-context';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const result = (tabId?: number) => createStructuredToolResult({ success: true, tabId });
const context = (sessionId = 'A') => ({ sessionId, transport: 'cli' });

beforeEach(() => {
  clearBrowserToolQueues();
  vi.stubGlobal('chrome', {
    tabs: {
      get: vi.fn(async (id: number) => ({ id, windowId: 1 })),
      query: vi.fn(async () => [{ id: 7, windowId: 1, active: true }]),
    },
    webNavigation: { getFrame: vi.fn(async () => ({ documentId: 'doc-old', frameId: 5 })) },
  });
});
afterEach(() => {
  clearBrowserToolQueues();
  vi.unstubAllGlobals();
});

describe('task cancellation and target ownership', () => {
  test.each([undefined, '', 7])(
    'does not fabricate task state from an absent or invalid session ID %j',
    async (sessionId) => {
      const execute = vi.fn(async () => result());
      await runBrowserToolCallWithIsolation({}, { sessionId, transport: 'cli' } as any, execute);
      expect(execute).toHaveBeenCalledOnce();
      expect(chrome.tabs.query).not.toHaveBeenCalled();
    },
  );

  test('does not keep a second implicit target or apply targets returned by tools', async () => {
    await runBrowserToolCallWithIsolation({ tabId: 8 }, context(), async () => result(99));
    const execute = vi.fn(async () => result());
    await runBrowserToolCallWithIsolation({}, context(), execute);
    expect(execute).toHaveBeenCalledWith(
      {},
      { documentId: undefined, strictTarget: true, owner: 'A' },
    );
    expect(chrome.tabs.get).toHaveBeenCalledExactlyOnceWith(8);
    expect(chrome.tabs.query).not.toHaveBeenCalled();
  });

  test('keeps normally running calls serial within a task', async () => {
    const slow = deferred<ReturnType<typeof result>>();
    const firstExecute = vi.fn(() => slow.promise);
    const nextExecute = vi.fn(async () => result());
    const first = runBrowserToolCallWithIsolation({}, context(), firstExecute);
    await vi.waitFor(() => expect(firstExecute).toHaveBeenCalledOnce());
    const next = runBrowserToolCallWithIsolation({}, context(), nextExecute);
    await Promise.resolve();
    expect(nextExecute).not.toHaveBeenCalled();
    slow.resolve(result());
    await Promise.all([first, next]);
    expect(nextExecute).toHaveBeenCalledOnce();
  });

  test('frees a cancelled task while retaining the lock of its still-running target', async () => {
    const slow = deferred<ReturnType<typeof result>>();
    const execute = vi.fn(() => slow.promise);
    const controller = new AbortController();
    const first = runBrowserToolCallWithIsolation({ tabId: 7 }, context(), execute, {
      signal: controller.signal,
    }).catch((error: Error) => error);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    controller.abort(new Error('Tool call cancelled'));
    expect(await first).toMatchObject({ name: 'AbortError', message: 'Tool call cancelled' });
    const sameTargetExecute = vi.fn(async () => result(7));
    const sameTarget = runBrowserToolCallWithIsolation(
      { tabId: 7 },
      context('B'),
      sameTargetExecute,
    );
    await runBrowserToolCallWithIsolation({}, context(), async () => result());
    await runBrowserToolCallWithIsolation({ tabId: 8 }, context(), async () => result(8));
    expect(sameTargetExecute).not.toHaveBeenCalled();
    slow.resolve(result(99));
    await sameTarget;
    expect(sameTargetExecute).toHaveBeenCalledOnce();
    expect(chrome.tabs.get).not.toHaveBeenCalledWith(99);
  });

  test('does not execute after a cancelled tab lookup finishes late', async () => {
    const lookup = deferred<chrome.tabs.Tab>();
    vi.mocked(chrome.tabs.get).mockImplementation(async (id: number) =>
      id === 7 ? lookup.promise : ({ id, windowId: 1 } as chrome.tabs.Tab),
    );
    const controller = new AbortController();
    const execute = vi.fn(async () => result(7));
    const first = runBrowserToolCallWithIsolation({ tabId: 7 }, context(), execute, {
      signal: controller.signal,
    }).catch((error: Error) => error);
    await vi.waitFor(() => expect(chrome.tabs.get).toHaveBeenCalledWith(7));
    controller.abort();
    expect(await first).toMatchObject({ name: 'AbortError' });
    await runBrowserToolCallWithIsolation({ tabId: 8 }, context(), async () => result(8));
    lookup.resolve({ id: 7, windowId: 1 } as chrome.tabs.Tab);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(execute).not.toHaveBeenCalled();
  });

  test('cancels a queued call without breaking the next call', async () => {
    const slow = deferred<ReturnType<typeof result>>();
    const started = vi.fn(() => slow.promise);
    const first = runBrowserToolCallWithIsolation({}, context(), started);
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    const controller = new AbortController();
    const cancelledExecute = vi.fn(async () => result());
    const cancelled = runBrowserToolCallWithIsolation({}, context(), cancelledExecute, {
      signal: controller.signal,
    }).catch((error: Error) => error);
    controller.abort();
    expect(await cancelled).toMatchObject({ name: 'AbortError' });
    const nextExecute = vi.fn(async () => result());
    const next = runBrowserToolCallWithIsolation({}, context(), nextExecute);
    expect(nextExecute).not.toHaveBeenCalled();
    slow.resolve(result());
    await Promise.all([first, next]);
    expect(cancelledExecute).not.toHaveBeenCalled();
    expect(nextExecute).toHaveBeenCalledOnce();
  });

  test.each([undefined, 'A'])(
    'does not start an already cancelled call (%s)',
    async (sessionId) => {
      const controller = new AbortController();
      controller.abort();
      const execute = vi.fn(async () => result());
      await expect(
        runBrowserToolCallWithIsolation({ tabId: 7 }, { sessionId, transport: 'cli' }, execute, {
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(execute).not.toHaveBeenCalled();
      expect(chrome.tabs.get).not.toHaveBeenCalled();
    },
  );

  test('releases queues after execution failure', async () => {
    const failed = runBrowserToolCallWithIsolation({ tabId: 7 }, context(), async () => {
      throw new Error('Page disconnected');
    }).catch((error: Error) => error);
    const nextExecute = vi.fn(async () => result(7));
    const next = runBrowserToolCallWithIsolation({ tabId: 7 }, context(), nextExecute);
    expect(await failed).toMatchObject({ message: 'Page disconnected' });
    await next;
    expect(nextExecute).toHaveBeenCalledOnce();
  });

  test.each([
    [{ tabIds: [8, 7, 8] }, { tabId: 7 }],
    [{ windowId: 2 }, { windowId: 2 }],
  ])('locks overlapping targets across independent tasks: %j', async (firstArgs, nextArgs) => {
    const slow = deferred<ReturnType<typeof result>>();
    const firstExecute = vi.fn(() => slow.promise);
    const first = runBrowserToolCallWithIsolation(firstArgs, context(), firstExecute);
    await vi.waitFor(() => expect(firstExecute).toHaveBeenCalledOnce());
    const nextExecute = vi.fn(async () => result());
    const next = runBrowserToolCallWithIsolation(nextArgs, context('B'), nextExecute);
    await Promise.resolve();
    expect(nextExecute).not.toHaveBeenCalled();
    slow.resolve(result());
    await Promise.all([first, next]);
    expect(nextExecute).toHaveBeenCalledOnce();
  });

  test('consumes a late execution rejection after cancellation', async () => {
    const slow = deferred<ReturnType<typeof result>>();
    const execute = vi.fn(() => slow.promise);
    const controller = new AbortController();
    const first = runBrowserToolCallWithIsolation({ tabId: 7 }, context(), execute, {
      signal: controller.signal,
    }).catch((error: Error) => error);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    controller.abort();
    expect(await first).toMatchObject({ name: 'AbortError' });
    slow.reject(new Error('Late page failure'));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe('document-bound execution', () => {
  test('passes the document checked under the target lock into execution', async () => {
    const execute = vi.fn(async () => result(8));
    await runBrowserToolCallWithIsolation(
      { tabId: 8, frameId: 5, ref: 'ref_1' },
      { ...context(), documentId: 'doc-old' },
      execute,
    );
    expect(chrome.webNavigation.getFrame).toHaveBeenCalledWith({ tabId: 8, frameId: 5 });
    expect(execute).toHaveBeenCalledWith(
      { tabId: 8, frameId: 5, ref: 'ref_1' },
      { documentId: 'doc-old', strictTarget: true, owner: 'A' },
    );
  });

  test.each([null, { documentId: 'doc-new' }, { frameId: 5 }])(
    'rejects stale or missing document identity before execution: %j',
    async (frame) => {
      vi.mocked(chrome.webNavigation.getFrame).mockResolvedValue(frame as any);
      const execute = vi.fn(async () => result(8));
      await expect(
        runBrowserToolCallWithIsolation(
          { tabId: 8, frameId: 5 },
          { ...context(), documentId: 'doc-old' },
          execute,
        ),
      ).rejects.toThrow('STALE_DOCUMENT');
      expect(execute).not.toHaveBeenCalled();
    },
  );

  test('rejects a closed tab without selecting the active tab', async () => {
    vi.mocked(chrome.tabs.get).mockRejectedValue(new Error('No tab'));
    const execute = vi.fn(async () => result(7));
    await expect(runBrowserToolCallWithIsolation({ tabId: 8 }, context(), execute)).rejects.toThrow(
      'TARGET_CLOSED',
    );
    expect(execute).not.toHaveBeenCalled();
    expect(chrome.tabs.query).not.toHaveBeenCalled();
  });

  test('checks document identity only after acquiring the target lock', async () => {
    const slow = deferred<ReturnType<typeof result>>();
    const firstExecute = vi.fn(() => slow.promise);
    const first = runBrowserToolCallWithIsolation({ tabId: 8 }, context('B'), firstExecute);
    await vi.waitFor(() => expect(firstExecute).toHaveBeenCalledOnce());
    const execute = vi.fn(async () => result(8));
    const next = runBrowserToolCallWithIsolation(
      { tabId: 8, frameId: 5 },
      { ...context(), documentId: 'doc-old' },
      execute,
    ).catch((error: Error) => error);
    await Promise.resolve();
    expect(chrome.webNavigation.getFrame).not.toHaveBeenCalled();
    vi.mocked(chrome.webNavigation.getFrame).mockResolvedValue({ documentId: 'doc-new' } as any);
    slow.resolve(result(8));
    await first;
    expect(await next).toMatchObject({ message: expect.stringContaining('STALE_DOCUMENT') });
    expect(execute).not.toHaveBeenCalled();
  });

  test('does not execute after a cancelled document lookup finishes late', async () => {
    const lookup = deferred<any>();
    vi.mocked(chrome.webNavigation.getFrame).mockReturnValue(lookup.promise);
    const controller = new AbortController();
    const execute = vi.fn(async () => result(8));
    const pending = runBrowserToolCallWithIsolation(
      { tabId: 8 },
      { ...context(), documentId: 'doc-old' },
      execute,
      { signal: controller.signal },
    ).catch((error: Error) => error);
    await vi.waitFor(() => expect(chrome.webNavigation.getFrame).toHaveBeenCalledOnce());
    controller.abort();
    expect(await pending).toMatchObject({ name: 'AbortError' });
    await runBrowserToolCallWithIsolation({ tabId: 9 }, context(), async () => result(9));
    lookup.resolve({ documentId: 'doc-old' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(execute).not.toHaveBeenCalled();
  });
});
