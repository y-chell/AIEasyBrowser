import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { BaseBrowserToolExecutor } from '../base-browser';
import { clickTool, fillTool } from './interaction';
import { keyboardTool } from './keyboard';
import { scanCompactTool } from './scan-compact';
import { cdpSessionManager } from '@/utils/cdp-session-manager';

vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: {
    sendCommand: vi.fn(async () => ({})),
    withSession: vi.fn(async (_tabId: number, _owner: string, fn: () => Promise<unknown>) => fn()),
  },
}));

class HelperHarness extends BaseBrowserToolExecutor {
  name = 'fixture';
  async execute() {
    return { content: [], isError: false };
  }
  inject(documentId?: string) {
    return this.injectContentScript(7, ['helper.js'], false, 'ISOLATED', true, [5], documentId);
  }
  message(documentId?: string) {
    return this.sendMessageToTab(7, { action: 'fixture' }, 5, documentId);
  }
}

beforeEach(() => {
  vi.stubGlobal('chrome', {
    tabs: {
      get: vi.fn(async (id) => ({ id, windowId: 1, url: 'https://fixture.test/' })),
      query: vi.fn(async () => [{ id: 7, windowId: 1 }]),
      sendMessage: vi.fn(async () => ({
        success: true,
        title: 'Fixture',
        url: 'https://fixture.test/',
        elements: [{ ref: 'ref_1' }],
      })),
    },
    scripting: { executeScript: vi.fn(async () => []) },
    webNavigation: {
      getAllFrames: vi.fn(async () => [
        { frameId: 0, documentId: 'top-doc', url: 'https://fixture.test/' },
        { frameId: 5, documentId: 'iframe-doc', url: 'https://frame.test/' },
      ]),
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('document-targeted Chrome APIs', () => {
  test('targets injection and messaging by documentId, never mixing documentIds with frameIds', async () => {
    const harness = new HelperHarness();
    await harness.inject('iframe-doc');
    await harness.message('iframe-doc');
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 7, documentIds: ['iframe-doc'] },
      }),
    );
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      7,
      { action: 'fixture' },
      { documentId: 'iframe-doc' },
    );
  });
  test('preserves the existing frameId path when there is no bound document', async () => {
    const harness = new HelperHarness();
    await harness.inject();
    await harness.message();
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 7, frameIds: [5] },
      }),
    );
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7, { action: 'fixture' }, { frameId: 5 });
  });
  test('forwards the exact document for click and fill, including XPath resolution', async () => {
    vi.mocked(chrome.tabs.sendMessage).mockResolvedValue({ success: true, ref: 'ref_1' });
    await clickTool.execute({ tabId: 7, frameId: 5, ref: 'ref_1' }, { documentId: 'iframe-doc' });
    await fillTool.execute(
      { tabId: 7, frameId: 5, selector: '//input', selectorType: 'xpath', value: false },
      { documentId: 'iframe-doc' },
    );
    for (const [details] of vi.mocked(chrome.scripting.executeScript).mock.calls) {
      expect(details.target).toEqual({ tabId: 7, documentIds: ['iframe-doc'] });
    }
    for (const [, , options] of vi.mocked(chrome.tabs.sendMessage).mock.calls) {
      expect(options).toEqual({ documentId: 'iframe-doc' });
    }
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ ref: 'ref_1', value: false }),
      { documentId: 'iframe-doc' },
    );
  });
  test('cannot send an action to a new document when the old document disappears during injection', async () => {
    vi.mocked(chrome.scripting.executeScript).mockRejectedValue(
      new Error('No document with id old-doc'),
    );
    const failed = await clickTool.execute({ tabId: 7, ref: 'ref_1' }, { documentId: 'old-doc' });
    expect(failed.isError).toBe(true);
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 7, documentIds: ['old-doc'] } }),
    );
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });
  test('does not send a new fill after cancellation during helper injection', async () => {
    const controller = new AbortController();
    vi.mocked(chrome.scripting.executeScript).mockImplementation(async () => {
      controller.abort();
      return [];
    });
    const failed = await fillTool.execute(
      { tabId: 7, ref: 'ref_1', value: 'no' },
      { signal: controller.signal, documentId: 'top-doc' },
    );
    expect(failed.isError).toBe(true);
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });
  test('keeps keyboard XPath lookup, focus and final input in the same iframe document', async () => {
    vi.mocked(chrome.tabs.sendMessage).mockResolvedValue({ success: true, ref: 'ref_1' });
    const result = await keyboardTool.execute(
      { tabId: 7, frameId: 5, selector: '//input', selectorType: 'xpath', keys: 'Enter' },
      { documentId: 'iframe-doc' },
    );
    expect(result.isError).toBe(false);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(4);
    for (const [, , options] of vi.mocked(chrome.tabs.sendMessage).mock.calls)
      expect(options).toEqual({ documentId: 'iframe-doc' });
    for (const [details] of vi.mocked(chrome.scripting.executeScript).mock.calls)
      expect(details.target).toEqual({ tabId: 7, documentIds: ['iframe-doc'] });
  });
});

describe('trusted click and keyboard input', () => {
  beforeEach(() => vi.mocked(cdpSessionManager.sendCommand).mockClear());

  test('resolves the ref in the bound document, then clicks over CDP instead of in the page', async () => {
    vi.mocked(chrome.tabs.sendMessage).mockResolvedValue({
      success: true,
      elementInfo: { tagName: 'DIV' },
      point: { x: 40, y: 12 },
    });
    const result = await clickTool.execute(
      { tabId: 7, ref: 'ref_1', trusted: true },
      { documentId: 'top-doc' },
    );
    expect(result.isError).toBe(false);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledExactlyOnceWith(
      7,
      expect.objectContaining({ ref: 'ref_1', resolveOnly: true }),
      { documentId: 'top-doc' },
    );
    const sent = vi.mocked(cdpSessionManager.sendCommand).mock.calls;
    expect(sent.map(([, method, params]) => [method, (params as any).type])).toEqual([
      ['Input.dispatchMouseEvent', 'mouseMoved'],
      ['Input.dispatchMouseEvent', 'mousePressed'],
      ['Input.dispatchMouseEvent', 'mouseReleased'],
    ]);
    expect(sent[1][2]).toMatchObject({ x: 40, y: 12 });
    expect(JSON.parse((result.content[0] as any).text)).toMatchObject({ clickMethod: 'trusted' });
  });

  test('sends no input when the trusted click target is not interactable', async () => {
    vi.mocked(chrome.tabs.sendMessage).mockResolvedValue({
      error: 'NOT_INTERACTABLE: element is hidden, blocked, or not hit-testable',
    });
    const failed = await clickTool.execute({ tabId: 7, ref: 'ref_1', trusted: true });
    expect(failed.isError).toBe(true);
    expect(cdpSessionManager.sendCommand).not.toHaveBeenCalled();
  });

  test.each([
    [{ frameId: 5, ref: 'ref_1' }, 'TRUSTED_FRAME_UNSUPPORTED'],
    [{ coordinates: { x: 1, y: 1 } }, 'trusted click takes a ref or selector'],
  ])('rejects trusted click %j before touching the page', async (target, message) => {
    const failed = await clickTool.execute({ tabId: 7, trusted: true, ...target });
    expect(failed.isError).toBe(true);
    expect((failed.content[0] as any).text).toContain(message);
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
    expect(cdpSessionManager.sendCommand).not.toHaveBeenCalled();
  });

  test('sends trusted keys over CDP without injecting the DOM keyboard helper', async () => {
    const result = await keyboardTool.execute({ tabId: 7, keys: 'Ctrl+A, Enter', trusted: true });
    expect(result.isError).toBe(false);
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    const types = vi
      .mocked(cdpSessionManager.sendCommand)
      .mock.calls.map(([, , params]) => [(params as any).type, (params as any).key]);
    expect(types).toEqual([
      ['rawKeyDown', 'a'],
      ['keyUp', 'a'],
      ['keyDown', 'Enter'],
      ['keyUp', 'Enter'],
    ]);
  });

  test.each([
    [{ keys: 'Enter, NotAKey' }, 'unknown key'],
    [{ keys: 'Enter', selector: '#q' }, 'focus it first'],
    [{ keys: 'Enter', frameId: 5 }, 'TRUSTED_FRAME_UNSUPPORTED'],
  ])('rejects trusted keys %j before sending any', async (args, message) => {
    const failed = await keyboardTool.execute({ tabId: 7, trusted: true, ...args });
    expect(failed.isError).toBe(true);
    expect((failed.content[0] as any).text).toContain(message);
    expect(cdpSessionManager.sendCommand).not.toHaveBeenCalled();
  });
});

describe('strict CLI compact scan', () => {
  test('captures each frame document identity and scans exactly that document', async () => {
    const scanned = await scanCompactTool.execute({ tabId: 7 }, { strictTarget: true });
    expect(scanned.isError).toBe(false);
    const frames = (scanned.structuredContent as any).frames;
    expect(frames.map((frame: any) => frame.documentId)).toEqual(['top-doc', 'iframe-doc']);
    expect(chrome.scripting.executeScript).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ target: { tabId: 7, documentIds: ['top-doc'] } }),
    );
    expect(chrome.tabs.sendMessage).toHaveBeenNthCalledWith(2, 7, expect.any(Object), {
      documentId: 'iframe-doc',
    });
  });
  test('does not silently fall back when CLI frame enumeration fails', async () => {
    vi.mocked(chrome.webNavigation.getAllFrames).mockRejectedValue(
      new Error('Frame enumeration failed'),
    );
    const failed = await scanCompactTool.execute({ tabId: 7 }, { strictTarget: true });
    expect(failed.isError).toBe(true);
    expect(failed.content[0]).toMatchObject({
      text: expect.stringContaining('Frame enumeration failed'),
    });
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });
  test.each([{ frames: [] }, { frames: [{ frameId: 0, url: 'https://fixture.test/' }] }])(
    'rejects missing CLI frame documents %j',
    async ({ frames }) => {
      vi.mocked(chrome.webNavigation.getAllFrames).mockResolvedValue(frames as any);
      expect((await scanCompactTool.execute({ tabId: 7 }, { strictTarget: true })).isError).toBe(
        true,
      );
      expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
    },
  );
  test('reports an absent requested frame rather than scanning a different frame', async () => {
    const failed = await scanCompactTool.execute({ tabId: 7, frameId: 99 }, { strictTarget: true });
    expect(failed.isError).toBe(true);
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });
  test('keeps the MCP scan frame path and original enumeration fallback', async () => {
    vi.mocked(chrome.webNavigation.getAllFrames).mockRejectedValue(
      new Error('Enumeration fixture'),
    );
    const scanned = await scanCompactTool.execute({ tabId: 7 });
    expect(scanned.isError).toBe(false);
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 7, allFrames: true } }),
    );
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7, expect.any(Object), { frameId: 0 });
  });
});
