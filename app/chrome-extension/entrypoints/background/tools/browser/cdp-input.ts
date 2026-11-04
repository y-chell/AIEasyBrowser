import { cdpSessionManager } from '@/utils/cdp-session-manager';

// Input.dispatch* events are trusted browser input and carry user activation, which synthetic
// DOM events never do (window.open, fullscreen, clipboard and many site handlers require it).

export type MouseButton = 'left' | 'right' | 'middle';

export interface KeyModifiers {
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

interface KeyDef {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

const MODIFIER_BITS: Record<string, number> = {
  alt: 1,
  ctrl: 2,
  control: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  win: 4,
  windows: 4,
  shift: 8,
};

// Chrome only runs default actions such as implicit form submission when a keyDown carries
// the key's text and Windows virtual key code; a bare rawKeyDown for Enter does nothing.
const NAMED_KEYS: Record<string, KeyDef> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  del: { key: 'Delete', code: 'Delete', keyCode: 46 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
};

// Letters follow the DOM keyboard helper: lowercase unless Shift is held.
function resolveKey(token: string, shift: boolean): KeyDef {
  const lower = token.toLowerCase();
  const named = NAMED_KEYS[lower];
  if (named) return named;
  const fn = /^f([1-9]|1[0-2])$/.exec(lower);
  if (fn) return { key: `F${fn[1]}`, code: `F${fn[1]}`, keyCode: 111 + Number(fn[1]) };
  if (token.length === 1) {
    if (/[a-z]/i.test(token)) {
      const upper = token.toUpperCase();
      const key = shift ? upper : lower;
      return { key, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: key };
    }
    if (/[0-9]/.test(token)) {
      return { key: token, code: `Digit${token}`, keyCode: token.charCodeAt(0), text: token };
    }
    return { key: token, code: '', keyCode: 0, text: token };
  }
  throw new Error(`INVALID_ARGUMENT: unknown key "${token}"`);
}

/** Parses "Ctrl+Shift+A" into a key and a CDP modifier mask. */
export function parseKeyChord(chord: string): { def: KeyDef; modifiers: number } {
  const parts = chord
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);
  let modifiers = 0;
  let keyToken: string | undefined;
  for (const part of parts) {
    const bit = MODIFIER_BITS[part.toLowerCase()];
    if (bit !== undefined) modifiers |= bit;
    else if (keyToken === undefined) keyToken = part;
    else throw new Error(`INVALID_ARGUMENT: key combination "${chord}" has more than one key`);
  }
  if (keyToken === undefined)
    throw new Error(`INVALID_ARGUMENT: key combination "${chord}" has no key`);
  return { def: resolveKey(keyToken, (modifiers & MODIFIER_BITS.shift) !== 0), modifiers };
}

export function modifierMask(modifiers: KeyModifiers | undefined): number {
  return (
    (modifiers?.altKey ? 1 : 0) |
    (modifiers?.ctrlKey ? 2 : 0) |
    (modifiers?.metaKey ? 4 : 0) |
    (modifiers?.shiftKey ? 8 : 0)
  );
}

export async function dispatchKeyChord(tabId: number, chord: string): Promise<void> {
  const { def, modifiers } = parseKeyChord(chord);
  // A real keyboard produces no text while Ctrl, Alt or Meta is held.
  const text = modifiers & ~MODIFIER_BITS.shift ? undefined : def.text;
  const base = {
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    nativeVirtualKeyCode: def.keyCode,
    modifiers,
  };
  await cdpSessionManager.sendCommand(tabId, 'Input.dispatchKeyEvent', {
    ...base,
    type: text ? 'keyDown' : 'rawKeyDown',
    ...(text ? { text, unmodifiedText: text } : {}),
  });
  await cdpSessionManager.sendCommand(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
}

export async function dispatchMouseClick(
  tabId: number,
  point: { x: number; y: number },
  options: { button?: MouseButton; clickCount?: number; modifiers?: number } = {},
): Promise<void> {
  const button = options.button ?? 'left';
  const buttons = button === 'left' ? 1 : button === 'right' ? 2 : 4;
  const modifiers = options.modifiers ?? 0;
  const x = Math.round(point.x);
  const y = Math.round(point.y);
  await cdpSessionManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x,
    y,
    button: 'none',
    buttons: 0,
    modifiers,
  });
  for (let clickCount = 1; clickCount <= (options.clickCount ?? 1); clickCount++) {
    await cdpSessionManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button,
      buttons,
      clickCount,
      modifiers,
    });
    await cdpSessionManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button,
      buttons: 0,
      clickCount,
      modifiers,
    });
  }
}

/** Holds one debugger attach for a whole input sequence instead of one per event. */
export async function withTrustedInput<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
  return await cdpSessionManager.withSession(tabId, 'trusted-input', fn);
}
