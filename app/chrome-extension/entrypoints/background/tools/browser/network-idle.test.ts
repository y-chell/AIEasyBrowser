import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { waitForNetworkIdle } from './network-idle';

type RequestEvent = { requestId: string; tabId: number; redirectUrl?: string };

function createRequestEvent() {
  const listeners = new Set<(details: RequestEvent) => void>();
  return {
    listeners,
    addListener: vi.fn((listener: (details: RequestEvent) => void) => listeners.add(listener)),
    removeListener: vi.fn((listener: (details: RequestEvent) => void) =>
      listeners.delete(listener),
    ),
    emit(details: RequestEvent) {
      for (const listener of listeners) listener(details);
    },
  };
}

let webRequest: Record<
  'onBeforeRequest' | 'onCompleted' | 'onErrorOccurred' | 'onBeforeRedirect',
  ReturnType<typeof createRequestEvent>
>;

beforeEach(() => {
  vi.useFakeTimers();
  webRequest = {
    onBeforeRequest: createRequestEvent(),
    onCompleted: createRequestEvent(),
    onErrorOccurred: createRequestEvent(),
    onBeforeRedirect: createRequestEvent(),
  };
  vi.stubGlobal('chrome', { webRequest });
});

afterEach(() => {
  expect(vi.getTimerCount()).toBe(0);
  for (const event of Object.values(webRequest)) expect(event.listeners.size).toBe(0);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('tab-scoped network idle', () => {
  test('resolves after a complete idle window and ignores other tabs', async () => {
    const pending = waitForNetworkIdle({ tabId: 7, timeoutMs: 1000, idleMs: 200 });
    const done = vi.fn();
    void pending.then(done);

    webRequest.onBeforeRequest.emit({ tabId: 8, requestId: 'other-tab' });
    await vi.advanceTimersByTimeAsync(199);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(done).toHaveBeenCalledOnce();
    expect(webRequest.onBeforeRequest.addListener).toHaveBeenCalledWith(expect.any(Function), {
      tabId: 7,
      urls: ['<all_urls>'],
      types: ['main_frame', 'sub_frame', 'xmlhttprequest', 'ping', 'other'],
    });
  });

  test('does not confuse an unfinished request with network idle', async () => {
    const failure = waitForNetworkIdle({ tabId: 7, timeoutMs: 500, idleMs: 200 }).catch(
      (error: Error) => error,
    );
    webRequest.onBeforeRequest.emit({ tabId: 7, requestId: 'unfinished' });
    await vi.advanceTimersByTimeAsync(500);
    expect(await failure).toEqual(new Error('wait for network idle timed out'));
  });

  test('waits for overlapping requests and resets idle time after completion or error', async () => {
    const pending = waitForNetworkIdle({ tabId: 7, timeoutMs: 1000, idleMs: 200 });
    const done = vi.fn();
    void pending.then(done);
    webRequest.onBeforeRequest.emit({ tabId: 7, requestId: 'first' });
    webRequest.onBeforeRequest.emit({ tabId: 7, requestId: 'second' });
    await vi.advanceTimersByTimeAsync(100);
    webRequest.onCompleted.emit({ tabId: 7, requestId: 'first' });
    await vi.advanceTimersByTimeAsync(250);
    expect(done).not.toHaveBeenCalled();
    webRequest.onErrorOccurred.emit({ tabId: 7, requestId: 'second' });
    await vi.advanceTimersByTimeAsync(199);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
  });

  test('counts completion of requests that began before the wait started', async () => {
    const pending = waitForNetworkIdle({ tabId: 7, timeoutMs: 1000, idleMs: 200 });
    const done = vi.fn();
    void pending.then(done);
    await vi.advanceTimersByTimeAsync(100);
    webRequest.onCompleted.emit({ tabId: 7, requestId: 'already-running' });
    await vi.advanceTimersByTimeAsync(199);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
  });

  test('handles terminal data redirects without waiting for a nonexistent completion', async () => {
    const pending = waitForNetworkIdle({ tabId: 7, timeoutMs: 1000, idleMs: 200 });
    webRequest.onBeforeRequest.emit({ tabId: 7, requestId: 'redirect' });
    webRequest.onBeforeRedirect.emit({
      tabId: 7,
      requestId: 'redirect',
      redirectUrl: 'data:text/plain,done',
    });
    await vi.advanceTimersByTimeAsync(200);
    await pending;
  });

  test('does not treat an HTTP redirect as a completed request', async () => {
    const failure = waitForNetworkIdle({ tabId: 7, timeoutMs: 500, idleMs: 200 }).catch(
      (error: Error) => error,
    );
    webRequest.onBeforeRequest.emit({ tabId: 7, requestId: 'redirect' });
    webRequest.onBeforeRedirect.emit({
      tabId: 7,
      requestId: 'redirect',
      redirectUrl: 'https://fixture.test/next',
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(await failure).toEqual(new Error('wait for network idle timed out'));
  });

  test('includes static requests only when explicitly requested', async () => {
    const pending = waitForNetworkIdle({
      tabId: 7,
      timeoutMs: 1000,
      idleMs: 200,
      includeStatic: true,
    });
    expect(webRequest.onBeforeRequest.addListener).toHaveBeenCalledWith(expect.any(Function), {
      tabId: 7,
      urls: ['<all_urls>'],
    });
    await vi.advanceTimersByTimeAsync(200);
    await pending;
  });

  test('cleans up listeners and timers on cancellation', async () => {
    const controller = new AbortController();
    const failure = waitForNetworkIdle({
      tabId: 7,
      timeoutMs: 1000,
      idleMs: 200,
      signal: controller.signal,
    }).catch((error: Error) => error);
    webRequest.onBeforeRequest.emit({ tabId: 7, requestId: 'cancelled' });
    controller.abort(new Error('Tool call cancelled'));
    expect(await failure).toMatchObject({
      name: 'AbortError',
      message: 'Tool call cancelled',
    });
  });

  test('does not subscribe when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      waitForNetworkIdle({
        tabId: 7,
        timeoutMs: 1000,
        idleMs: 200,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(webRequest.onBeforeRequest.addListener).not.toHaveBeenCalled();
  });

  test('cleans up partial subscription failures instead of swallowing them', async () => {
    webRequest.onCompleted.addListener.mockImplementationOnce(() => {
      throw new Error('webRequest permission denied');
    });
    await expect(waitForNetworkIdle({ tabId: 7, timeoutMs: 1000, idleMs: 200 })).rejects.toThrow(
      'webRequest permission denied',
    );
    expect(webRequest.onBeforeRequest.removeListener).toHaveBeenCalledOnce();
  });

  test.each([
    { tabId: -1, timeoutMs: 1000, idleMs: 200 },
    { tabId: 1.5, timeoutMs: 1000, idleMs: 200 },
    { tabId: 7, timeoutMs: NaN, idleMs: 200 },
    { tabId: 7, timeoutMs: -1, idleMs: 200 },
    { tabId: 7, timeoutMs: 1000, idleMs: Infinity },
  ])('rejects invalid wait parameters: %j', async (options) => {
    await expect(waitForNetworkIdle(options)).rejects.toThrow(/network idle requires/);
    expect(webRequest.onBeforeRequest.addListener).not.toHaveBeenCalled();
  });
});
