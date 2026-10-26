interface NetworkIdleOptions {
  tabId: number;
  timeoutMs: number;
  idleMs: number;
  includeStatic?: boolean;
  signal?: AbortSignal;
}

type RequestEvent = { requestId: string; tabId: number };

export async function waitForNetworkIdle({
  tabId,
  timeoutMs,
  idleMs,
  includeStatic = false,
  signal,
}: NetworkIdleOptions): Promise<void> {
  if (!Number.isInteger(tabId) || tabId < 0) {
    throw new Error('network idle requires a valid tab ID');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(idleMs) || idleMs < 0) {
    throw new Error('network idle requires finite, non-negative timeouts');
  }

  return new Promise((resolve, reject) => {
    const activeRequests = new Set<string>();
    const subscriptions: Array<() => void> = [];
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      clearTimeout(timeoutTimer);
      for (const unsubscribe of subscriptions) unsubscribe();
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => {
      const error = new Error(
        signal?.reason instanceof Error ? signal.reason.message : 'Operation cancelled',
      );
      error.name = 'AbortError';
      finish(error);
    };
    const armIdleTimer = () => {
      clearTimeout(idleTimer);
      if (activeRequests.size === 0) {
        idleTimer = setTimeout(() => finish(), idleMs);
      }
    };
    const onRequestStarted = (details: RequestEvent) => {
      if (details.tabId !== tabId) return;
      activeRequests.add(details.requestId);
      clearTimeout(idleTimer);
    };
    const onRequestFinished = (details: RequestEvent) => {
      if (details.tabId !== tabId) return;
      activeRequests.delete(details.requestId);
      armIdleTimer();
    };
    const onRedirect = (details: RequestEvent & { redirectUrl: string }) => {
      // Redirects to data URLs do not produce onCompleted or onErrorOccurred.
      if (details.redirectUrl.startsWith('data:')) onRequestFinished(details);
    };
    const filter: chrome.webRequest.RequestFilter = {
      tabId,
      urls: ['<all_urls>'],
      ...(includeStatic
        ? {}
        : {
            types: [
              'main_frame',
              'sub_frame',
              'xmlhttprequest',
              'ping',
              'other',
            ] as chrome.webRequest.ResourceType[],
          }),
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }

    try {
      // Independent listeners must not start, stop, or overwrite an agent's network capture.
      chrome.webRequest.onBeforeRequest.addListener(onRequestStarted, filter);
      subscriptions.push(() => chrome.webRequest.onBeforeRequest.removeListener(onRequestStarted));
      chrome.webRequest.onCompleted.addListener(onRequestFinished, filter);
      subscriptions.push(() => chrome.webRequest.onCompleted.removeListener(onRequestFinished));
      chrome.webRequest.onErrorOccurred.addListener(onRequestFinished, filter);
      subscriptions.push(() => chrome.webRequest.onErrorOccurred.removeListener(onRequestFinished));
      chrome.webRequest.onBeforeRedirect.addListener(onRedirect, filter);
      subscriptions.push(() => chrome.webRequest.onBeforeRedirect.removeListener(onRedirect));
      signal?.addEventListener('abort', onAbort, { once: true });
      subscriptions.push(() => signal?.removeEventListener('abort', onAbort));
      timeoutTimer = setTimeout(
        () => finish(new Error('wait for network idle timed out')),
        timeoutMs,
      );
      armIdleTimer();
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
