import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ToolResult } from '@/common/tool-handler';
import {
  clearBrowserToolQueues,
  runBrowserToolCallWithIsolation,
} from '../browser-session-context';
import { navigateTool } from './common';

const requestedUrl = 'https://fixture.test/new?mode=test';
const oldUrl = 'https://fixture.test/old';
let currentTab: chrome.tabs.Tab;
let candidateTabs: chrome.tabs.Tab[];

function payload(result: ToolResult) {
  expect(result.isError).toBe(false);
  const text = result.content[0];
  if (text.type !== 'text') throw new Error('Expected text result');
  const data = JSON.parse(text.text);
  expect(result.structuredContent).toEqual(data);
  // The CLI owns actionStatus; navigationStatus describes this tool's request.
  expect(data).not.toHaveProperty('actionStatus');
  return data;
}

beforeEach(() => {
  clearBrowserToolQueues();
  currentTab = {
    id: 7,
    windowId: 2,
    active: true,
    url: oldUrl,
    status: 'complete',
  } as chrome.tabs.Tab;
  candidateTabs = [];
  const createdTab = {
    id: 9,
    windowId: 2,
    url: '',
    pendingUrl: requestedUrl,
    status: 'loading',
  } as chrome.tabs.Tab;
  vi.stubGlobal('chrome', {
    runtime: {},
    tabs: {
      get: vi.fn(async () => ({ ...currentTab })),
      query: vi.fn(async (options: chrome.tabs.QueryInfo) =>
        options.active ? [currentTab] : candidateTabs,
      ),
      update: vi.fn(async () => ({ ...currentTab })),
      reload: vi.fn(async () => undefined),
      goBack: vi.fn(async () => undefined),
      goForward: vi.fn(async () => undefined),
      create: vi.fn(async () => createdTab),
    },
    windows: {
      update: vi.fn(async () => ({ id: 2 })),
      get: vi.fn(async () => ({ id: 2 })),
      getLastFocused: vi.fn(async () => ({ id: 2 })),
      create: vi.fn(async () => ({ id: 3, tabs: [{ ...createdTab, windowId: 3 }] })),
    },
  });
});

afterEach(() => {
  clearBrowserToolQueues();
  vi.unstubAllGlobals();
});

describe('navigation request responses', () => {
  test.each([
    { pendingUrl: requestedUrl, status: 'loading' },
    { pendingUrl: requestedUrl, status: 'complete' },
    { pendingUrl: undefined, status: 'complete' },
  ] as const)('preserves a stale URL snapshot without claiming arrival: %j', async (snapshot) => {
    Object.assign(currentTab, snapshot);
    const data = payload(
      await navigateTool.execute({ url: ` ${requestedUrl} `, tabId: 7, background: true }),
    );
    expect(data).toEqual({
      success: true,
      message: 'Navigation requested in existing tab; completion has not been verified',
      tabId: 7,
      windowId: 2,
      navigationAction: 'navigate',
      navigationStatus: 'requested',
      requestedUrl,
      url: oldUrl,
      pendingUrl: snapshot.pendingUrl ?? null,
      tabStatus: snapshot.status,
    });
    expect(chrome.tabs.update).toHaveBeenCalledExactlyOnceWith(7, { url: requestedUrl });
    expect(chrome.tabs.get).toHaveBeenNthCalledWith(1, 7);
    expect(chrome.tabs.get).toHaveBeenNthCalledWith(2, 7);
    expect(chrome.tabs.get).toHaveBeenCalledTimes(2);
    expect(chrome.windows.update).not.toHaveBeenCalled();
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });

  test('requests the same URL once and does not treat the old complete state as a commit', async () => {
    currentTab.url = requestedUrl;
    candidateTabs = [currentTab];
    const data = payload(
      await navigateTool.execute({ url: requestedUrl, tabId: 7, background: true }),
    );
    expect(data).toMatchObject({
      navigationAction: 'navigate',
      navigationStatus: 'requested',
      requestedUrl,
      url: requestedUrl,
      pendingUrl: null,
      tabStatus: 'complete',
    });
    expect(chrome.tabs.update).toHaveBeenCalledExactlyOnceWith(7, { url: requestedUrl });
    expect(chrome.tabs.reload).not.toHaveBeenCalled();
  });

  test('reports a redirected snapshot separately from the request without retrying the URL', async () => {
    const redirectedUrl = 'https://fixture.test/login?next=new';
    vi.mocked(chrome.tabs.get)
      .mockResolvedValueOnce(currentTab)
      .mockResolvedValueOnce({ ...currentTab, url: redirectedUrl });
    const data = payload(
      await navigateTool.execute({ url: requestedUrl, tabId: 7, background: true }),
    );
    expect(data).toMatchObject({
      navigationStatus: 'requested',
      requestedUrl,
      url: redirectedUrl,
      pendingUrl: null,
    });
    expect(chrome.tabs.update).toHaveBeenCalledExactlyOnceWith(7, { url: requestedUrl });
  });

  test.each([true, false])(
    'distinguishes URL reuse from navigation (background=%s)',
    async (background) => {
      currentTab.url = requestedUrl;
      candidateTabs = [currentTab];
      const data = payload(await navigateTool.execute({ url: requestedUrl, background }));
      expect(data).toMatchObject({
        message: 'Reused existing tab; no navigation requested',
        tabId: 7,
        navigationAction: 'reuse',
        navigationStatus: 'not_requested',
        requestedUrl,
        url: requestedUrl,
      });
      if (background) {
        expect(chrome.tabs.update).not.toHaveBeenCalled();
        expect(chrome.windows.update).not.toHaveBeenCalled();
      } else {
        expect(chrome.tabs.update).toHaveBeenCalledExactlyOnceWith(7, { active: true });
        expect(chrome.windows.update).toHaveBeenCalledExactlyOnceWith(2, { focused: true });
      }
      expect(chrome.tabs.create).not.toHaveBeenCalled();
      expect(chrome.tabs.reload).not.toHaveBeenCalled();
    },
  );

  test('does not claim to own an existing pending navigation when reusing its tab', async () => {
    currentTab.url = requestedUrl;
    currentTab.pendingUrl = 'https://fixture.test/elsewhere';
    currentTab.status = 'loading';
    candidateTabs = [currentTab];
    const data = payload(await navigateTool.execute({ url: requestedUrl, background: true }));
    expect(data).toMatchObject({
      navigationAction: 'reuse',
      navigationStatus: 'not_requested',
      pendingUrl: currentTab.pendingUrl,
      tabStatus: 'loading',
    });
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });

  test('returns the new tab ID and its pending URL for a subsequent CLI wait', async () => {
    const data = payload(await navigateTool.execute({ url: requestedUrl, background: true }));
    expect(data).toMatchObject({
      tabId: 9,
      windowId: 2,
      navigationAction: 'navigate',
      navigationStatus: 'requested',
      requestedUrl,
      url: '',
      pendingUrl: requestedUrl,
      tabStatus: 'loading',
    });
    expect(chrome.tabs.create).toHaveBeenCalledExactlyOnceWith({
      url: requestedUrl,
      windowId: 2,
      active: false,
    });
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });

  test.each([false, true])(
    'returns a top-level tab ID for a new window (fallback=%s)',
    async (fallback) => {
      if (fallback) vi.mocked(chrome.windows.getLastFocused).mockResolvedValue(null as any);
      const data = payload(
        await navigateTool.execute({ url: requestedUrl, newWindow: !fallback, background: true }),
      );
      expect(data).toMatchObject({
        tabId: 9,
        windowId: 3,
        navigationAction: 'navigate',
        navigationStatus: 'requested',
        requestedUrl,
        url: '',
        pendingUrl: requestedUrl,
        tabs: [{ tabId: 9, url: '' }],
      });
      expect(chrome.windows.create).toHaveBeenCalledOnce();
      expect(chrome.tabs.create).not.toHaveBeenCalled();
    },
  );

  test('looks up only the created window when Chrome omits its populated tabs', async () => {
    vi.mocked(chrome.windows.create).mockImplementation(
      async () => ({ id: 3 }) as chrome.windows.Window,
    );
    vi.mocked(chrome.tabs.query).mockImplementation(async (options) =>
      options.windowId === 3 ? [{ ...currentTab, id: 9, windowId: 3 }] : [],
    );
    const data = payload(await navigateTool.execute({ url: requestedUrl, newWindow: true }));
    expect(data).toMatchObject({ tabId: 9, windowId: 3, navigationStatus: 'requested' });
    expect(chrome.tabs.query).toHaveBeenLastCalledWith({ windowId: 3 });
    expect(chrome.windows.create).toHaveBeenCalledOnce();
  });

  test('does not create another window or claim success if its tab is already gone', async () => {
    vi.mocked(chrome.windows.create).mockImplementation(
      async () => ({ id: 3 }) as chrome.windows.Window,
    );
    const result = await navigateTool.execute({ url: requestedUrl, newWindow: true });
    expect(result.isError).toBe(true);
    expect(chrome.tabs.query).toHaveBeenLastCalledWith({ windowId: 3 });
    expect(chrome.windows.create).toHaveBeenCalledOnce();
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });

  test('reports refresh as requested even when the URL and complete status are unchanged', async () => {
    const data = payload(await navigateTool.execute({ refresh: true, tabId: 7 }));
    expect(data).toMatchObject({
      tabId: 7,
      navigationAction: 'refresh',
      navigationStatus: 'requested',
      requestedUrl: null,
      url: oldUrl,
      pendingUrl: null,
      tabStatus: 'complete',
    });
    expect(chrome.tabs.reload).toHaveBeenCalledExactlyOnceWith(7);
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });

  test.each(['back', 'forward'] as const)(
    'reports %s as requested without inventing a destination',
    async (direction) => {
      const data = payload(
        await navigateTool.execute({ url: direction, tabId: 7, background: true }),
      );
      expect(data).toMatchObject({
        tabId: 7,
        navigationAction: direction,
        navigationStatus: 'requested',
        requestedUrl: null,
        url: oldUrl,
        pendingUrl: null,
        tabStatus: 'complete',
      });
      expect(
        direction === 'back' ? chrome.tabs.goBack : chrome.tabs.goForward,
      ).toHaveBeenCalledExactlyOnceWith(7);
      expect(
        direction === 'back' ? chrome.tabs.goForward : chrome.tabs.goBack,
      ).not.toHaveBeenCalled();
      expect(chrome.tabs.update).not.toHaveBeenCalled();
    },
  );
});

describe('navigation target ownership and failures', () => {
  test.each([{ url: requestedUrl }, { refresh: true }, { url: 'back' }, { url: 'forward' }])(
    'does not fall back when the strict target closes after the isolation precheck: %j',
    async (args) => {
      candidateTabs = [{ ...currentTab, id: 8, url: requestedUrl }];
      vi.mocked(chrome.tabs.get)
        .mockResolvedValueOnce(currentTab)
        .mockRejectedValueOnce(new Error('No tab with id: 7'));
      const result = await runBrowserToolCallWithIsolation(
        { ...args, tabId: 7 },
        { sessionId: 'navigation-test', transport: 'cli' },
        (boundArgs, context) => navigateTool.execute(boundArgs, context),
      );
      expect(result.isError).toBe(true);
      expect(result.content[0]).toMatchObject({
        type: 'text',
        text: expect.stringContaining('TARGET_CLOSED:'),
      });
      expect(chrome.tabs.get).toHaveBeenCalledTimes(2);
      expect(chrome.tabs.query).not.toHaveBeenCalled();
      expect(chrome.tabs.update).not.toHaveBeenCalled();
      expect(chrome.tabs.reload).not.toHaveBeenCalled();
      expect(chrome.tabs.goBack).not.toHaveBeenCalled();
      expect(chrome.tabs.goForward).not.toHaveBeenCalled();
      expect(chrome.tabs.create).not.toHaveBeenCalled();
      expect(chrome.windows.create).not.toHaveBeenCalled();
      expect(chrome.windows.update).not.toHaveBeenCalled();
    },
  );

  test('does not retry or choose another tab when the requested update fails', async () => {
    candidateTabs = [{ ...currentTab, id: 8, url: requestedUrl }];
    vi.mocked(chrome.tabs.update).mockRejectedValue(new Error('No tab with id: 7'));
    const result = await navigateTool.execute(
      { url: requestedUrl, tabId: 7, background: true },
      { strictTarget: true },
    );
    expect(result.isError).toBe(true);
    expect(chrome.tabs.update).toHaveBeenCalledExactlyOnceWith(7, { url: requestedUrl });
    expect(chrome.tabs.get).toHaveBeenCalledExactlyOnceWith(7);
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(chrome.windows.create).not.toHaveBeenCalled();
  });

  test('does not fall back or resend when the target closes after the navigation request', async () => {
    vi.mocked(chrome.tabs.get)
      .mockResolvedValueOnce(currentTab)
      .mockRejectedValueOnce(new Error('No tab with id: 7'));
    const result = await navigateTool.execute(
      { url: requestedUrl, tabId: 7, background: true },
      { strictTarget: true },
    );
    expect(result.isError).toBe(true);
    expect(chrome.tabs.update).toHaveBeenCalledExactlyOnceWith(7, { url: requestedUrl });
    expect(chrome.tabs.get).toHaveBeenNthCalledWith(2, 7);
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(chrome.windows.create).not.toHaveBeenCalled();
  });
});
