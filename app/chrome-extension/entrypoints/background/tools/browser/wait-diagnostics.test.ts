import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createStructuredToolResult } from '@/common/tool-handler';
import { computerTool } from './computer';
import { javascriptTool } from './javascript';
import { assertTool, waitForTool } from './wait-for';

vi.mock('./interaction', () => ({
  clickTool: { execute: vi.fn() },
  fillTool: { execute: vi.fn() },
}));
vi.mock('./keyboard', () => ({ keyboardTool: { execute: vi.fn() } }));
vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: { attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn() },
}));
vi.mock('./screenshot', () => ({ screenshotTool: { execute: vi.fn() } }));
vi.mock('./javascript', () => ({ javascriptTool: { execute: vi.fn() } }));
vi.mock('./download', () => ({ waitForDownload: vi.fn() }));
vi.mock('./network-capture', () => ({ waitForCapturedRequest: vi.fn() }));

const pageVisibility = { visibilityState: 'hidden', hidden: true, hasFocus: true };
const hiddenTimeout = {
  success: false,
  reason: 'timeout',
  code: 'PAGE_HIDDEN',
  pageVisibility,
  elementState: { exists: true, visible: false, hiddenReason: 'ancestor:opacity:0' },
  guidance: 'Restore/show the actual Chrome window. Do not repeat an already completed action.',
};
beforeEach(() => {
  vi.stubGlobal('chrome', {
    tabs: { get: vi.fn(async (id) => ({ id, windowId: 1 })) },
    webNavigation: { getAllFrames: vi.fn(async () => [{ frameId: 0 }, { frameId: 2 }]) },
    scripting: { executeScript: vi.fn(async () => [{ result: pageVisibility }]) },
  });
  vi.spyOn(computerTool as any, 'injectContentScript').mockResolvedValue(undefined);
  vi.mocked(javascriptTool.execute).mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('wait/assert diagnostic propagation', () => {
  test('a ref hidden wait is not rewritten as clickable and succeeds on a hidden page', async () => {
    const send = vi.spyOn(computerTool as any, 'sendMessageToTab').mockResolvedValue({
      success: true,
      matched: null,
      tookMs: 0,
      pageVisibility,
      elementState: hiddenTimeout.elementState,
    });
    const result = await assertTool.execute({
      tabId: 7,
      frameId: 2,
      condition: { kind: 'element', ref: 'ref_1', state: 'hidden' },
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      passed: true,
      state: 'hidden',
      pageVisibility,
      elementState: { exists: true, visible: false },
    });
    expect(send).toHaveBeenCalledExactlyOnceWith(
      7,
      expect.objectContaining({ action: 'waitForSelector', ref: 'ref_1', visible: false }),
      2,
    );
    expect(result.structuredContent?.code).toBeUndefined();
  });
  test.each(['visible', 'hidden'] as const)(
    'preserves PAGE_HIDDEN across %s multi-frame aggregation and assert',
    async (state) => {
      vi.spyOn(computerTool as any, 'sendMessageToTab').mockImplementation(
        async (...args: any[]) =>
          args[2] === 2
            ? hiddenTimeout
            : state === 'hidden'
              ? { success: true, tookMs: 0 }
              : { success: false, reason: 'timeout' },
      );
      const result = await assertTool.execute({
        tabId: 7,
        condition: { kind: 'element', selector: '#dialog', state },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject(hiddenTimeout);
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining('PAGE_HIDDEN') });
    },
  );
  test('preserves text timeout diagnosis through wait_for', async () => {
    vi.spyOn(computerTool as any, 'sendMessageToTab').mockResolvedValue(hiddenTimeout);
    const result = await waitForTool.execute({
      tabId: 7,
      condition: { kind: 'text', text: 'confirmation' },
    });
    expect(result.structuredContent).toMatchObject(hiddenTimeout);
  });
  test('diagnoses an unmet JavaScript node-removal condition without replaying an action', async () => {
    vi.mocked(javascriptTool.execute).mockResolvedValue(
      createStructuredToolResult({ success: true, result: 'false' }),
    );
    const result = await assertTool.execute({
      tabId: 7,
      timeoutMs: 10,
      condition: { kind: 'javascript', predicate: '!document.querySelector("#dialog")' },
    });
    expect(result.structuredContent).toMatchObject({
      success: false,
      code: 'PAGE_HIDDEN',
      pageVisibility,
      guidance: expect.stringContaining('Do not repeat an already completed action'),
    });
  });
  test('a satisfied business predicate succeeds without a page visibility precondition', async () => {
    vi.mocked(javascriptTool.execute).mockResolvedValue(
      createStructuredToolResult({ success: true, result: 'true' }),
    );
    const result = await assertTool.execute({
      tabId: 7,
      condition: { kind: 'javascript', predicate: 'true' },
    });
    expect(result.structuredContent).toMatchObject({ success: true, passed: true });
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });
  test('exists keeps DOM existence semantics even when the page is hidden', async () => {
    vi.mocked(chrome.scripting.executeScript).mockResolvedValue([
      { result: { success: true, exists: true } },
    ] as any);
    const result = await waitForTool.execute({
      tabId: 7,
      condition: { kind: 'element', selector: '#dialog', state: 'exists' },
    });
    expect(result.structuredContent).toMatchObject({
      success: true,
      state: 'exists',
      observed: { exists: true },
    });
  });
});
