import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { computerTool } from './computer';
import { clickTool } from './interaction';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { screenshotContextManager } from '@/utils/screenshot-context';

vi.mock('./interaction', () => ({
  clickTool: { execute: vi.fn() },
  fillTool: { execute: vi.fn() },
}));
vi.mock('./keyboard', () => ({ keyboardTool: { execute: vi.fn() } }));
vi.mock('./screenshot', () => ({ screenshotTool: { execute: vi.fn() } }));
vi.mock('./download', () => ({ waitForDownload: vi.fn() }));
vi.mock('./network-capture', () => ({ waitForCapturedRequest: vi.fn() }));
vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: { attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn() },
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('chrome', {
    tabs: { get: vi.fn(async (id) => ({ id, windowId: 1, url: 'https://fixture.test/' })) },
  });
  vi.mocked(clickTool.execute).mockResolvedValue({ content: [], isError: false });
  vi.mocked(cdpSessionManager.attach).mockResolvedValue(undefined);
  vi.mocked(cdpSessionManager.detach).mockResolvedValue(undefined);
  vi.mocked(cdpSessionManager.sendCommand).mockResolvedValue({});
  screenshotContextManager.clear(7);
});
afterEach(() => {
  screenshotContextManager.clear(7);
  vi.unstubAllGlobals();
});

describe('computer coordinate input', () => {
  test.each(['left_click', 'right_click'] as const)(
    'uses one trusted CDP sequence for %s, never a synthetic DOM attempt',
    async (action) => {
      const result = await computerTool.execute({
        tabId: 7,
        action,
        coordinates: { x: 50, y: 20 },
      });
      expect(result.isError).toBe(false);
      expect(clickTool.execute).not.toHaveBeenCalled();
      const sent = vi.mocked(cdpSessionManager.sendCommand).mock.calls;
      expect(sent.map(([, , params]) => (params as any).type)).toEqual([
        'mouseMoved',
        'mousePressed',
        'mouseReleased',
      ]);
      for (const [tabId, method, params] of sent) {
        expect(tabId).toBe(7);
        expect(method).toBe('Input.dispatchMouseEvent');
        expect(params).toMatchObject({ x: 50, y: 20 });
      }
      expect(cdpSessionManager.detach).toHaveBeenCalledExactlyOnceWith(7, 'computer');
    },
  );

  test.each(['left_click', 'right_click', 'double_click', 'hover', 'scroll'] as const)(
    'does not reinterpret CSS coordinates after a resized/full-page screenshot: %s',
    async (action) => {
      screenshotContextManager.setContext(7, {
        screenshotWidth: 400,
        screenshotHeight: 1200,
        viewportWidth: 800,
        viewportHeight: 600,
        hostname: 'fixture.test',
        devicePixelRatio: 1.25,
      });
      const result = await computerTool.execute({
        tabId: 7,
        action,
        coordinates: { x: 50, y: 20 },
      });
      expect(result.isError).toBe(false);
      const sent = vi.mocked(cdpSessionManager.sendCommand).mock.calls;
      expect(sent.length).toBeGreaterThan(0);
      for (const [, , params] of sent) expect(params).toMatchObject({ x: 50, y: 20 });
    },
  );

  test('returns a CDP failure without replaying via DOM, and releases its debugger owner', async () => {
    vi.mocked(cdpSessionManager.sendCommand).mockImplementation(async (_tab, _method, params) => {
      if ((params as any).type === 'mousePressed') throw new Error('fixture dispatch failed');
      return {};
    });
    const result = await computerTool.execute({
      tabId: 7,
      action: 'left_click',
      coordinates: { x: 5, y: 5 },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('fixture dispatch failed');
    expect(clickTool.execute).not.toHaveBeenCalled();
    expect(cdpSessionManager.sendCommand).toHaveBeenCalledTimes(2);
    expect(cdpSessionManager.detach).toHaveBeenCalledExactlyOnceWith(7, 'computer');
  });
  test('does not dispatch after debugger attach fails', async () => {
    vi.mocked(cdpSessionManager.attach).mockRejectedValue(new Error('fixture debugger conflict'));
    const result = await computerTool.execute({
      tabId: 7,
      action: 'left_click',
      coordinates: { x: 5, y: 5 },
    });
    expect(result.isError).toBe(true);
    expect(cdpSessionManager.sendCommand).not.toHaveBeenCalled();
    expect(clickTool.execute).not.toHaveBeenCalled();
  });
  test('keeps the screenshot domain guard without silently rescaling or clicking', async () => {
    screenshotContextManager.setContext(7, {
      screenshotWidth: 400,
      screenshotHeight: 300,
      viewportWidth: 800,
      viewportHeight: 600,
      hostname: 'other.test',
    });
    const result = await computerTool.execute({
      tabId: 7,
      action: 'left_click',
      coordinates: { x: 5, y: 5 },
    });
    expect(result.isError).toBe(true);
    expect(cdpSessionManager.sendCommand).not.toHaveBeenCalled();
    expect(clickTool.execute).not.toHaveBeenCalled();
  });

  test.each([{ ref: 'ref_1' }, { selector: '#target', frameId: 5 }])(
    'keeps ref/selector clicks synthetic and bound to their explicit target: %j',
    async (target) => {
      const context = { documentId: 'fixture-doc' };
      await computerTool.execute({ tabId: 7, action: 'left_click', ...target }, context);
      expect(clickTool.execute).toHaveBeenCalledWith(
        expect.objectContaining({ tabId: 7, ...target }),
        context,
      );
      expect(cdpSessionManager.sendCommand).not.toHaveBeenCalled();
    },
  );
});
