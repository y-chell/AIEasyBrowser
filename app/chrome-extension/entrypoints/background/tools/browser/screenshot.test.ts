import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';

vi.hoisted(() => {
  (globalThis as any).chrome = { tabs: {} };
});
const sessionReleased = vi.hoisted(() => vi.fn());
vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: {
    withSession: vi.fn(async (tab, owner, fn) => {
      try {
        return await fn();
      } finally {
        sessionReleased(tab, owner);
      }
    }),
    sendCommand: vi.fn(),
  },
}));
vi.mock('@/utils/image-utils', () => ({
  compressImage: vi.fn(async (dataUrl) => ({
    dataUrl,
    mimeType: 'image/png',
    width: 800,
    height: 600,
    originalWidth: 800,
    originalHeight: 600,
  })),
  canvasToDataURL: vi.fn(),
  createImageBitmapFromUrl: vi.fn(),
  cropAndResizeImage: vi.fn(),
  stitchImages: vi.fn(),
}));
import { screenshotTool } from './screenshot';
import { cdpSessionManager } from '@/utils/cdp-session-manager';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('chrome', {
    tabs: {
      get: vi.fn(async (id) => ({ id, windowId: 9, url: 'https://fixture.test/post' })),
      captureVisibleTab: vi.fn(),
    },
    scripting: {
      executeScript: vi.fn(async () => [
        { result: { visibilityState: 'visible', hidden: false, hasFocus: true } },
      ]),
    },
    downloads: { download: vi.fn() },
  });
  vi.mocked(cdpSessionManager.sendCommand).mockImplementation(async (_tab, method) => {
    if (method === 'Page.getLayoutMetrics')
      return {
        cssLayoutViewport: { clientWidth: 800, clientHeight: 600 },
        cssVisualViewport: { pageX: 0, pageY: 200 },
        cssContentSize: { width: 800, height: 6000 },
      };
    if (method === 'Runtime.evaluate')
      return { result: { value: { x: 100, y: 1200, width: 500, height: 900 } } };
    if (method === 'Page.captureScreenshot') return { data: 'cGl4ZWxz' };
    return {};
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const capture = (params: object = {}, signal?: AbortSignal) =>
  screenshotTool.execute(
    {
      name: 'view',
      tabId: 7,
      background: true,
      storeBase64: true,
      savePng: false,
      ...params,
    },
    { signal },
  );

function deferCommand(method: string) {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const pending = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  const original = vi.mocked(cdpSessionManager.sendCommand).getMockImplementation()!;
  vi.mocked(cdpSessionManager.sendCommand).mockImplementation((tab, command, params) =>
    command === method ? pending : original(tab, command, params),
  );
  return { resolve, reject };
}

function hiddenPage() {
  const pageVisibility = { visibilityState: 'hidden', hidden: true, hasFocus: false };
  vi.mocked(chrome.scripting.executeScript).mockResolvedValue([{ result: pageVisibility }] as any);
  return pageVisibility;
}

describe('targeted browser pixel capture', () => {
  test('captures the selected background tab without downloads or an active-tab screenshot', async () => {
    const result = await capture();
    expect(result.isError).toBe(false);
    expect(chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(chrome.downloads.download).not.toHaveBeenCalled();
    expect(cdpSessionManager.sendCommand).toHaveBeenCalledWith(7, 'Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
    });
  });

  test('captures an entire image below the fold with CSS document coordinates', async () => {
    const result = await capture({ selector: '#illustration' });
    expect(result.isError).toBe(false);
    expect(cdpSessionManager.sendCommand).toHaveBeenCalledWith(7, 'Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: true,
      clip: { x: 100, y: 1200, width: 500, height: 900, scale: 1 },
    });
    const evalCall = vi
      .mocked(cdpSessionManager.sendCommand)
      .mock.calls.find(([, method]) => method === 'Runtime.evaluate')!;
    expect((evalCall[2] as any).expression).toContain('matches.length !== 1');
    expect(chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
  });

  test('quotes selectors as data inside the geometry expression', async () => {
    const selector = 'img[alt="a\\b"]';
    await capture({ selector });
    const evalCall = vi
      .mocked(cdpSessionManager.sendCommand)
      .mock.calls.find(([, method]) => method === 'Runtime.evaluate')!;
    expect((evalCall[2] as any).expression).toContain(
      `querySelectorAll(${JSON.stringify(selector)})`,
    );
  });

  test.each([
    { exceptionDetails: { text: 'Selector matched multiple images' } },
    { result: { value: { x: 0, y: 0, width: 0, height: 4 } } },
    { result: { value: { x: -100, y: 0, width: 20, height: 10 } } },
  ])(
    'rejects invalid/ambiguous element geometry without taking another tab screenshot: %j',
    async (geometry) => {
      const original = vi.mocked(cdpSessionManager.sendCommand).getMockImplementation()!;
      vi.mocked(cdpSessionManager.sendCommand).mockImplementation(async (tab, method, params) =>
        method === 'Runtime.evaluate' ? geometry : original(tab, method, params),
      );
      expect((await capture({ selector: 'img' })).isError).toBe(true);
      expect(
        vi
          .mocked(cdpSessionManager.sendCommand)
          .mock.calls.some(([, method]) => method === 'Page.captureScreenshot'),
      ).toBe(false);
      expect(chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
    },
  );

  test('reports CDP readback failure without falling back to a different active tab', async () => {
    const original = vi.mocked(cdpSessionManager.sendCommand).getMockImplementation()!;
    vi.mocked(cdpSessionManager.sendCommand).mockImplementation(async (tab, method, params) => {
      if (method === 'Page.captureScreenshot') throw new Error('image readback failed');
      return original(tab, method, params);
    });
    const result = await capture();
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('image readback failed');
    expect(JSON.stringify(result)).not.toContain('PAGE_HIDDEN');
    expect(chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
    expect(sessionReleased).toHaveBeenCalledExactlyOnceWith(7, 'screenshot');
  });

  test.each(['Page.getLayoutMetrics', 'Runtime.evaluate', 'Page.captureScreenshot'])(
    'bounds a never-resolving %s inside the session and ignores its late result',
    async (method) => {
      vi.useFakeTimers();
      const pageVisibility = hiddenPage();
      const pending = deferCommand(method);
      const finished = vi.fn();
      const operation = capture({ selector: '#illustration' }).then((result) => {
        finished();
        return result;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(cdpSessionManager.sendCommand).toHaveBeenCalledWith(7, method, expect.any(Object));
      await vi.advanceTimersByTimeAsync(14999);
      expect(finished).not.toHaveBeenCalled();
      expect(sessionReleased).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      const result = await operation;
      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          success: false,
          code: 'PAGE_HIDDEN',
          error: expect.stringContaining('SCREENSHOT_TIMEOUT'),
          pageVisibility,
          guidance: expect.stringContaining('Restore/show'),
        },
      });
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining('PAGE_HIDDEN:') });
      expect(sessionReleased).toHaveBeenCalledExactlyOnceWith(7, 'screenshot');
      const calls = vi.mocked(cdpSessionManager.sendCommand).mock.calls.length;
      pending.resolve({ data: 'late-pixels' });
      await vi.advanceTimersByTimeAsync(0);
      expect(cdpSessionManager.sendCommand).toHaveBeenCalledTimes(calls);
      expect(sessionReleased).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
    },
  );

  test('keeps a visible-page timeout as a capture error and releases the session', async () => {
    vi.useFakeTimers();
    deferCommand('Page.captureScreenshot');
    const operation = capture();
    await vi.advanceTimersByTimeAsync(15000);
    const result = await operation;
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('SCREENSHOT_TIMEOUT');
    expect(JSON.stringify(result)).not.toContain('PAGE_HIDDEN');
    expect(sessionReleased).toHaveBeenCalledExactlyOnceWith(7, 'screenshot');
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each(['Page.getLayoutMetrics', 'Runtime.evaluate', 'Page.captureScreenshot'])(
    'aborts a pending %s promptly and releases its owner once',
    async (method) => {
      vi.useFakeTimers();
      hiddenPage();
      const pending = deferCommand(method);
      const controller = new AbortController();
      const operation = capture({ selector: '#illustration' }, controller.signal);
      await vi.advanceTimersByTimeAsync(0);
      expect(cdpSessionManager.sendCommand).toHaveBeenCalledWith(7, method, expect.any(Object));
      controller.abort(new Error('Cancelled by caller'));
      const result = await operation;
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain('Cancelled by caller');
      expect(JSON.stringify(result)).not.toContain('PAGE_HIDDEN');
      expect(sessionReleased).toHaveBeenCalledExactlyOnceWith(7, 'screenshot');
      expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      pending.reject(new Error('Late CDP rejection'));
      await vi.advanceTimersByTimeAsync(0);
      expect(sessionReleased).toHaveBeenCalledTimes(1);
    },
  );

  test('does not attach a screenshot owner for an already aborted signal', async () => {
    const controller = new AbortController();
    controller.abort(new Error('Already cancelled'));
    const result = await capture({}, controller.signal);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('Already cancelled');
    expect(cdpSessionManager.withSession).not.toHaveBeenCalled();
    expect(cdpSessionManager.sendCommand).not.toHaveBeenCalled();
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });

  test('reports a hidden-page readback failure with structured visibility and guidance', async () => {
    const pageVisibility = hiddenPage();
    const original = vi.mocked(cdpSessionManager.sendCommand).getMockImplementation()!;
    vi.mocked(cdpSessionManager.sendCommand).mockImplementation(async (tab, method, params) => {
      if (method === 'Page.captureScreenshot') throw new Error('image readback failed');
      return original(tab, method, params);
    });
    const result = await capture();
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        code: 'PAGE_HIDDEN',
        pageVisibility,
        error: expect.stringContaining('image readback failed'),
        guidance: expect.stringContaining('Restore/show'),
      },
    });
    expect(sessionReleased).toHaveBeenCalledExactlyOnceWith(7, 'screenshot');
    expect(chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
  });

  test.each([
    "SyntaxError: Failed to execute 'querySelectorAll': '[broken' is not a valid selector",
    'Screenshot selector must match exactly one element; found 0',
    'Screenshot element has no rendered area',
  ])('does not misclassify a hidden-page selector error: %s', async (message) => {
    hiddenPage();
    const original = vi.mocked(cdpSessionManager.sendCommand).getMockImplementation()!;
    vi.mocked(cdpSessionManager.sendCommand).mockImplementation(async (tab, method, params) =>
      method === 'Runtime.evaluate'
        ? { exceptionDetails: { exception: { description: message } } }
        : original(tab, method, params),
    );
    const result = await capture({ selector: '[broken' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain(message);
    expect(JSON.stringify(result)).not.toContain('PAGE_HIDDEN');
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(sessionReleased).toHaveBeenCalledExactlyOnceWith(7, 'screenshot');
  });

  test('cleans up the timeout and abort listener after a successful capture', async () => {
    vi.useFakeTimers();
    hiddenPage();
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const result = await capture({ selector: '#illustration' }, controller.signal);
    expect(result.isError).toBe(false);
    expect(sessionReleased).toHaveBeenCalledExactlyOnceWith(7, 'screenshot');
    expect(removeListener).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    controller.abort();
    expect(sessionReleased).toHaveBeenCalledTimes(1);
  });
});
