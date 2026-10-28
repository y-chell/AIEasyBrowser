import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

let cdpSessionManager: typeof import('@/utils/cdp-session-manager').cdpSessionManager;

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('chrome', {
    runtime: { id: 'self' },
    debugger: {
      onDetach: { addListener: vi.fn() },
      getTargets: vi.fn(async () => []),
      attach: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
      sendCommand: vi.fn(async () => ({ ok: true })),
    },
  });
  ({ cdpSessionManager } = await import('@/utils/cdp-session-manager'));
});
afterEach(() => vi.unstubAllGlobals());

describe('child session commands', () => {
  test('route through the held root attach', async () => {
    await cdpSessionManager.attach(7, 'holder');
    await cdpSessionManager.sendCommand(7, 'Runtime.evaluate', { expression: '1' }, 'child-1');
    expect(chrome.debugger.sendCommand).toHaveBeenCalledExactlyOnceWith(
      { tabId: 7, sessionId: 'child-1' },
      'Runtime.evaluate',
      { expression: '1' },
    );
  });

  test('fail without a held attach instead of attaching temporarily', async () => {
    await expect(
      cdpSessionManager.sendCommand(7, 'Runtime.evaluate', {}, 'child-1'),
    ).rejects.toThrow('no held debugger session');
    expect(chrome.debugger.attach).not.toHaveBeenCalled();
    expect(chrome.debugger.sendCommand).not.toHaveBeenCalled();
  });
});
