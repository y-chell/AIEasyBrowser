import { beforeEach, describe, expect, test, vi } from 'vitest';
import { dispatchKeyChord, dispatchMouseClick, parseKeyChord } from './cdp-input';
import { cdpSessionManager } from '@/utils/cdp-session-manager';

vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: { sendCommand: vi.fn(), withSession: vi.fn() },
}));

const sent = () => vi.mocked(cdpSessionManager.sendCommand).mock.calls.map(([, , p]) => p as any);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(cdpSessionManager.sendCommand).mockResolvedValue({});
});

describe('trusted key input', () => {
  test('sends Enter as keyDown with text and virtual key code so default actions run', async () => {
    await dispatchKeyChord(7, 'Enter');
    expect(sent()).toEqual([
      expect.objectContaining({
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        text: '\r',
      }),
      expect.objectContaining({ type: 'keyUp', key: 'Enter', windowsVirtualKeyCode: 13 }),
    ]);
  });

  test('types lowercase letters unless Shift is held', async () => {
    await dispatchKeyChord(7, 'A');
    expect(sent()[0]).toMatchObject({ type: 'keyDown', key: 'a', text: 'a', code: 'KeyA' });
    vi.mocked(cdpSessionManager.sendCommand).mockClear();
    await dispatchKeyChord(7, 'Shift+a');
    expect(sent()[0]).toMatchObject({ type: 'keyDown', key: 'A', text: 'A', modifiers: 8 });
  });

  test('drops text while Ctrl is held', async () => {
    await dispatchKeyChord(7, 'Ctrl+A');
    expect(sent()[0]).toMatchObject({
      type: 'rawKeyDown',
      key: 'a',
      modifiers: 2,
      windowsVirtualKeyCode: 65,
    });
    expect(sent()[0]).not.toHaveProperty('text');
    vi.mocked(cdpSessionManager.sendCommand).mockClear();
    await dispatchKeyChord(7, 'Shift+Tab');
    expect(sent()[0]).toMatchObject({ type: 'rawKeyDown', key: 'Tab', modifiers: 8 });
  });

  test.each(['Ctrl', 'Ctrl+A+B', 'NotAKey', ''])('rejects %j before sending anything', (chord) => {
    expect(() => parseKeyChord(chord)).toThrow(/INVALID_ARGUMENT/);
    expect(cdpSessionManager.sendCommand).not.toHaveBeenCalled();
  });
});

describe('trusted mouse input', () => {
  test('moves, then presses and releases with increasing clickCount for a double click', async () => {
    await dispatchMouseClick(7, { x: 10.6, y: 20.2 }, { clickCount: 2, modifiers: 8 });
    expect(sent().map((p) => [p.type, p.clickCount])).toEqual([
      ['mouseMoved', undefined],
      ['mousePressed', 1],
      ['mouseReleased', 1],
      ['mousePressed', 2],
      ['mouseReleased', 2],
    ]);
    expect(sent()[1]).toMatchObject({ x: 11, y: 20, button: 'left', buttons: 1, modifiers: 8 });
  });
});
