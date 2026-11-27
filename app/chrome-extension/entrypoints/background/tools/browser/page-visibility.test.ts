import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { focusTabAndVerify, readPageVisibility } from '@/utils/page-visibility';

beforeEach(() => {
  vi.stubGlobal('document', { visibilityState: 'visible', hidden: false, hasFocus: () => true });
  vi.stubGlobal('chrome', {
    windows: { get: vi.fn(async () => ({ state: 'normal' })), update: vi.fn(async () => ({})) },
    tabs: { update: vi.fn(async () => ({})) },
    scripting: { executeScript: vi.fn(async ({ func }) => [{ result: func() }]) },
  });
});
afterEach(() => vi.unstubAllGlobals());
const tab = { id: 7, windowId: 3 } as chrome.tabs.Tab;

describe('verified document focus', () => {
  test('reads document state in the requested frame without changing it', async () => {
    expect(await readPageVisibility(7, 4)).toEqual({
      visibilityState: 'visible',
      hidden: false,
      hasFocus: true,
    });
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 7, frameIds: [4] },
        world: 'ISOLATED',
      }),
    );
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });
  test('does not report API success plus hasFocus=true as rendering ready while hidden', async () => {
    vi.stubGlobal('document', { visibilityState: 'hidden', hidden: true, hasFocus: () => true });
    expect(await focusTabAndVerify(tab, { settleTimeoutMs: 0 })).toMatchObject({
      activationRequested: true,
      focusRequested: true,
      renderingReady: false,
      code: 'PAGE_HIDDEN',
      pageVisibility: { visibilityState: 'hidden', hidden: true, hasFocus: true },
      guidance: expect.stringContaining('Restore/show the actual Chrome window'),
    });
  });
  test('restores a minimized window and verifies the document after activation', async () => {
    vi.mocked(chrome.windows.get).mockResolvedValue({
      state: 'minimized',
    } as chrome.windows.Window);
    expect(await focusTabAndVerify(tab)).toMatchObject({ renderingReady: true });
    expect(chrome.windows.update).toHaveBeenCalledWith(3, { state: 'normal', focused: true });
    expect(chrome.tabs.update).toHaveBeenCalledWith(7, { active: true });
  });
  test('preserves a maximized window and does not fabricate missing document state', async () => {
    vi.mocked(chrome.windows.get).mockResolvedValue({
      state: 'maximized',
    } as chrome.windows.Window);
    vi.mocked(chrome.scripting.executeScript).mockRejectedValue(new Error('Cannot access page'));
    expect(await focusTabAndVerify(tab)).toMatchObject({
      renderingReady: false,
      code: 'FOCUS_UNVERIFIED',
      pageVisibility: { hidden: null, error: 'Cannot access page' },
    });
    expect(chrome.windows.update).toHaveBeenCalledWith(3, { focused: true });
  });
  test('visible without document focus remains unconfirmed', async () => {
    vi.stubGlobal('document', { visibilityState: 'visible', hidden: false, hasFocus: () => false });
    expect(await focusTabAndVerify(tab, { settleTimeoutMs: 0 })).toMatchObject({
      renderingReady: false,
      code: 'FOCUS_NOT_CONFIRMED',
    });
  });
});
