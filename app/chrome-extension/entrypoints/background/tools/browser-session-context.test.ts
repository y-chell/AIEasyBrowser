import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createStructuredToolResult } from '@/common/tool-handler';
import {
  clearBrowserToolSessionState,
  getBrowserToolSessionBinding,
  runBrowserToolCallWithIsolation,
} from './browser-session-context';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const result = (tabId?: number) => createStructuredToolResult({ success: true, tabId });

beforeEach(() => {
  clearBrowserToolSessionState();
  vi.stubGlobal('chrome', {
    tabs: {
      get: vi.fn(async (id: number) => ({ id, windowId: 1 })),
      query: vi.fn(async () => [{ id: 7, windowId: 1, active: true }]),
    },
    windows: { get: vi.fn(async (id: number) => ({ id })) },
  });
});

afterEach(() => {
  clearBrowserToolSessionState();
  vi.unstubAllGlobals();
});

describe('session cancellation and target ownership', () => {
  test('reuses a validated session target for calls without an explicit tab', async () => {
    await runBrowserToolCallWithIsolation(
      'chrome_read_page',
      { tabId: 8 },
      { sessionId: 'A' },
      async () => result(8),
    );
    const execute = vi.fn(async () => result(8));
    await runBrowserToolCallWithIsolation('chrome_read_page', {}, { sessionId: 'A' }, execute);
    expect(execute).toHaveBeenCalledWith({ tabId: 8 }, undefined);
    expect(getBrowserToolSessionBinding('A')?.tabId).toBe(8);
  });

  test('keeps normally running calls serial within a session', async () => {
    const slow = deferred<ReturnType<typeof result>>();
    const firstExecute = vi.fn(() => slow.promise);
    const nextExecute = vi.fn(async () => result());
    const first = runBrowserToolCallWithIsolation(
      'chrome_health',
      {},
      { sessionId: 'A' },
      firstExecute,
    );
    await vi.waitFor(() => expect(firstExecute).toHaveBeenCalledOnce());
    const next = runBrowserToolCallWithIsolation(
      'chrome_health',
      {},
      { sessionId: 'A' },
      nextExecute,
    );
    await Promise.resolve();
    expect(nextExecute).not.toHaveBeenCalled();
    slow.resolve(result());
    await Promise.all([first, next]);
    expect(nextExecute).toHaveBeenCalledOnce();
  });

  test('frees a cancelled session without releasing a still-running target or applying late results', async () => {
    const slow = deferred<ReturnType<typeof result>>();
    const execute = vi.fn(() => slow.promise);
    const controller = new AbortController();
    const first = runBrowserToolCallWithIsolation(
      'chrome_read_page',
      { tabId: 7 },
      { sessionId: 'A' },
      execute,
      { signal: controller.signal },
    ).catch((error: Error) => error);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    controller.abort(new Error('Tool call cancelled'));
    expect(await first).toMatchObject({ name: 'AbortError', message: 'Tool call cancelled' });

    const sameTargetExecute = vi.fn(async () => result(7));
    const sameTarget = runBrowserToolCallWithIsolation(
      'chrome_read_page',
      { tabId: 7 },
      { sessionId: 'B' },
      sameTargetExecute,
    );
    await runBrowserToolCallWithIsolation('chrome_health', {}, { sessionId: 'A' }, async () =>
      result(),
    );
    await runBrowserToolCallWithIsolation(
      'chrome_read_page',
      { tabId: 8 },
      { sessionId: 'A' },
      async () => result(8),
    );
    expect(sameTargetExecute).not.toHaveBeenCalled();
    slow.resolve(result(99));
    await sameTarget;
    expect(sameTargetExecute).toHaveBeenCalledOnce();
    expect(getBrowserToolSessionBinding('A')?.tabId).toBe(8);
  });

  test('does not apply a late target lookup after cancellation during preparation', async () => {
    const lookup = deferred<chrome.tabs.Tab>();
    vi.mocked(chrome.tabs.get).mockImplementation(async (id: number) =>
      id === 7 ? lookup.promise : ({ id, windowId: 1 } as chrome.tabs.Tab),
    );
    const controller = new AbortController();
    const execute = vi.fn(async () => result(7));
    const first = runBrowserToolCallWithIsolation(
      'chrome_read_page',
      { tabId: 7 },
      { sessionId: 'A' },
      execute,
      { signal: controller.signal },
    ).catch((error: Error) => error);
    await vi.waitFor(() => expect(chrome.tabs.get).toHaveBeenCalledWith(7));
    controller.abort(new Error('Cancelled during target lookup'));
    expect(await first).toMatchObject({ name: 'AbortError' });

    await runBrowserToolCallWithIsolation(
      'chrome_read_page',
      { tabId: 8 },
      { sessionId: 'A' },
      async () => result(8),
    );
    lookup.resolve({ id: 7, windowId: 1 } as chrome.tabs.Tab);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(execute).not.toHaveBeenCalled();
    expect(getBrowserToolSessionBinding('A')?.tabId).toBe(8);
  });

  test('does not restore a stale binding after cancellation during stored-target validation', async () => {
    await runBrowserToolCallWithIsolation(
      'chrome_read_page',
      { tabId: 8 },
      { sessionId: 'A' },
      async () => result(8),
    );
    const lookup = deferred<chrome.tabs.Tab>();
    vi.mocked(chrome.tabs.get).mockClear();
    vi.mocked(chrome.tabs.get).mockImplementation(async (id: number) =>
      id === 8 ? lookup.promise : ({ id, windowId: 1 } as chrome.tabs.Tab),
    );
    const controller = new AbortController();
    const execute = vi.fn(async () => result(8));
    const first = runBrowserToolCallWithIsolation(
      'chrome_read_page',
      {},
      { sessionId: 'A' },
      execute,
      { signal: controller.signal },
    ).catch((error: Error) => error);
    await vi.waitFor(() => expect(chrome.tabs.get).toHaveBeenCalledWith(8));
    controller.abort(new Error('Cancelled during binding validation'));
    expect(await first).toMatchObject({ name: 'AbortError' });

    await runBrowserToolCallWithIsolation(
      'chrome_read_page',
      { tabId: 9 },
      { sessionId: 'A' },
      async () => result(9),
    );
    lookup.resolve({ id: 8, windowId: 1 } as chrome.tabs.Tab);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(execute).not.toHaveBeenCalled();
    expect(getBrowserToolSessionBinding('A')?.tabId).toBe(9);
  });

  test('does not apply a late target lookup after cancellation during finalization', async () => {
    const lookup = deferred<chrome.tabs.Tab>();
    vi.mocked(chrome.tabs.get).mockImplementation(async (id: number) =>
      id === 99 ? lookup.promise : ({ id, windowId: 1 } as chrome.tabs.Tab),
    );
    const controller = new AbortController();
    const first = runBrowserToolCallWithIsolation(
      'chrome_read_page',
      { tabId: 7 },
      { sessionId: 'A' },
      async () => result(99),
      { signal: controller.signal },
    ).catch((error: Error) => error);
    await vi.waitFor(() => expect(chrome.tabs.get).toHaveBeenCalledWith(99));
    controller.abort(new Error('Cancelled during finalization'));
    expect(await first).toMatchObject({ name: 'AbortError' });

    await runBrowserToolCallWithIsolation(
      'chrome_read_page',
      { tabId: 8 },
      { sessionId: 'A' },
      async () => result(8),
    );
    const next = runBrowserToolCallWithIsolation(
      'chrome_read_page',
      { tabId: 7 },
      { sessionId: 'B' },
      async () => result(7),
    );
    lookup.resolve({ id: 99, windowId: 1 } as chrome.tabs.Tab);
    await next;
    expect(getBrowserToolSessionBinding('A')?.tabId).toBe(8);
  });

  test('cancels a queued call without starting it or breaking the next call', async () => {
    const slow = deferred<ReturnType<typeof result>>();
    const started = vi.fn(() => slow.promise);
    const first = runBrowserToolCallWithIsolation('chrome_health', {}, { sessionId: 'A' }, started);
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    const controller = new AbortController();
    const cancelledExecute = vi.fn(async () => result());
    const cancelled = runBrowserToolCallWithIsolation(
      'chrome_health',
      {},
      { sessionId: 'A' },
      cancelledExecute,
      { signal: controller.signal },
    ).catch((error: Error) => error);
    controller.abort(new Error('Queued call cancelled'));
    expect(await cancelled).toMatchObject({ name: 'AbortError' });
    const nextExecute = vi.fn(async () => result());
    const next = runBrowserToolCallWithIsolation(
      'chrome_health',
      {},
      { sessionId: 'A' },
      nextExecute,
    );
    expect(nextExecute).not.toHaveBeenCalled();
    slow.resolve(result());
    await Promise.all([first, next]);
    expect(cancelledExecute).not.toHaveBeenCalled();
    expect(nextExecute).toHaveBeenCalledOnce();
  });

  test.each([undefined, 'A'])(
    'does not start an already cancelled call (session %s)',
    async (sessionId) => {
      const controller = new AbortController();
      controller.abort(new Error('Already cancelled'));
      const execute = vi.fn(async () => result());
      await expect(
        runBrowserToolCallWithIsolation('chrome_read_page', { tabId: 7 }, { sessionId }, execute, {
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(execute).not.toHaveBeenCalled();
      expect(chrome.tabs.get).not.toHaveBeenCalled();
    },
  );

  test('releases queues when execution fails normally', async () => {
    const failed = runBrowserToolCallWithIsolation(
      'chrome_read_page',
      { tabId: 7 },
      { sessionId: 'A' },
      async () => {
        throw new Error('Page disconnected');
      },
    ).catch((error: Error) => error);
    const nextExecute = vi.fn(async () => result(7));
    const next = runBrowserToolCallWithIsolation(
      'chrome_read_page',
      { tabId: 7 },
      { sessionId: 'A' },
      nextExecute,
    );
    expect(await failed).toMatchObject({ message: 'Page disconnected' });
    await next;
    expect(nextExecute).toHaveBeenCalledOnce();
  });
});
