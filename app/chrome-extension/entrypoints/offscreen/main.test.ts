import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { MessageTarget, OFFSCREEN_MESSAGE_TYPES } from '@/common/message-types';

type MessageListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => boolean;

let listener: MessageListener;
let clipboardText: string;
let textarea: {
  style: Record<string, string>;
  value: string;
  addEventListener: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
};
let execCommand: ReturnType<typeof vi.fn>;
let clipboardDataAvailable: boolean;
let dispatchEvent: boolean;

beforeEach(async () => {
  vi.resetModules();
  clipboardText = 'fixture clipboard text';
  clipboardDataAvailable = true;
  dispatchEvent = true;
  const events = new Map<string, (event: unknown) => void>();
  textarea = {
    style: {},
    value: '',
    addEventListener: vi.fn((type: string, callback: (event: unknown) => void) =>
      events.set(type, callback),
    ),
    focus: vi.fn(),
    select: vi.fn(),
    remove: vi.fn(),
  };
  execCommand = vi.fn((command: string) => {
    if (dispatchEvent) {
      events.get(command)?.({
        preventDefault: vi.fn(),
        clipboardData: clipboardDataAvailable
          ? {
              getData: vi.fn(() => clipboardText),
              setData: vi.fn((_type: string, text: string) => {
                clipboardText = text;
              }),
            }
          : null,
      });
    }
    return true;
  });
  vi.stubGlobal('document', {
    createElement: vi.fn(() => textarea),
    body: { appendChild: vi.fn() },
    execCommand,
  });
  vi.stubGlobal('navigator', {
    clipboard: {
      readText: vi.fn(() => {
        throw new Error('Offscreen document is not focused');
      }),
      writeText: vi.fn(() => {
        throw new Error('Offscreen document is not focused');
      }),
    },
  });
  vi.stubGlobal('chrome', {
    runtime: {
      onMessage: {
        addListener: vi.fn((callback: MessageListener) => {
          listener = callback;
        }),
      },
    },
  });
  await import('./main');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('clipboard-only offscreen runtime', () => {
  test('reads clipboard text without a user interface', async () => {
    const sendResponse = vi.fn();
    expect(
      listener(
        { target: MessageTarget.Offscreen, type: OFFSCREEN_MESSAGE_TYPES.CLIPBOARD_READ_TEXT },
        {},
        sendResponse,
      ),
    ).toBe(true);
    await vi.waitFor(() =>
      expect(sendResponse).toHaveBeenCalledWith({
        success: true,
        text: 'fixture clipboard text',
      }),
    );
  });

  test('writes clipboard text and acknowledges completion', async () => {
    const sendResponse = vi.fn();
    expect(
      listener(
        {
          target: MessageTarget.Offscreen,
          type: OFFSCREEN_MESSAGE_TYPES.CLIPBOARD_WRITE_TEXT,
          text: 'agent text',
        },
        {},
        sendResponse,
      ),
    ).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ success: true }));
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(clipboardText).toBe('agent text');
    expect(textarea.remove).toHaveBeenCalledOnce();
  });

  test.each(['paste', 'copy'])('reports rejected clipboard %s commands', async (command) => {
    execCommand.mockReturnValue(false);
    const sendResponse = vi.fn();
    listener(
      {
        target: MessageTarget.Offscreen,
        type:
          command === 'paste'
            ? OFFSCREEN_MESSAGE_TYPES.CLIPBOARD_READ_TEXT
            : OFFSCREEN_MESSAGE_TYPES.CLIPBOARD_WRITE_TEXT,
        text: 'agent text',
      },
      {},
      sendResponse,
    );
    await vi.waitFor(() =>
      expect(sendResponse).toHaveBeenCalledWith({
        success: false,
        error: `Clipboard ${command} command was rejected`,
      }),
    );
    expect(textarea.remove).toHaveBeenCalledOnce();
  });

  test.each(['', 'first\r\nsecond', '\u4e2d\u6587'])(
    'preserves plaintext bytes: %j',
    async (text) => {
      clipboardText = text;
      const sendResponse = vi.fn();
      listener(
        { target: MessageTarget.Offscreen, type: OFFSCREEN_MESSAGE_TYPES.CLIPBOARD_READ_TEXT },
        {},
        sendResponse,
      );
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ success: true, text }));
      expect(textarea.remove).toHaveBeenCalledOnce();
      expect(navigator.clipboard.readText).not.toHaveBeenCalled();
    },
  );

  test('writes an empty string instead of the placeholder selection', async () => {
    const sendResponse = vi.fn();
    listener(
      {
        target: MessageTarget.Offscreen,
        type: OFFSCREEN_MESSAGE_TYPES.CLIPBOARD_WRITE_TEXT,
        text: '',
      },
      {},
      sendResponse,
    );
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ success: true }));
    expect(textarea.value).toBe(' ');
    expect(clipboardText).toBe('');
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  test('reports missing event data and removes the textarea', async () => {
    clipboardDataAvailable = false;
    const sendResponse = vi.fn();
    listener(
      { target: MessageTarget.Offscreen, type: OFFSCREEN_MESSAGE_TYPES.CLIPBOARD_READ_TEXT },
      {},
      sendResponse,
    );
    await vi.waitFor(() =>
      expect(sendResponse).toHaveBeenCalledWith({
        success: false,
        error: 'Clipboard event did not provide clipboard data',
      }),
    );
    expect(textarea.remove).toHaveBeenCalledOnce();
  });

  test('does not report an undelivered paste event as an empty clipboard', async () => {
    dispatchEvent = false;
    const sendResponse = vi.fn();
    listener(
      { target: MessageTarget.Offscreen, type: OFFSCREEN_MESSAGE_TYPES.CLIPBOARD_READ_TEXT },
      {},
      sendResponse,
    );
    await vi.waitFor(() =>
      expect(sendResponse).toHaveBeenCalledWith({
        success: false,
        error: 'Clipboard paste command did not provide text',
      }),
    );
    expect(textarea.remove).toHaveBeenCalledOnce();
  });

  test('cleans up after a command exception', async () => {
    execCommand.mockImplementation(() => {
      throw new Error('Clipboard unavailable');
    });
    const sendResponse = vi.fn();
    listener(
      {
        target: MessageTarget.Offscreen,
        type: OFFSCREEN_MESSAGE_TYPES.CLIPBOARD_WRITE_TEXT,
        text: 'value',
      },
      {},
      sendResponse,
    );
    await vi.waitFor(() =>
      expect(sendResponse).toHaveBeenCalledWith({
        success: false,
        error: 'Clipboard unavailable',
      }),
    );
    expect(textarea.remove).toHaveBeenCalledOnce();
  });

  test('rejects non-string write input before clipboard access', () => {
    const sendResponse = vi.fn();
    expect(
      listener(
        { target: MessageTarget.Offscreen, type: OFFSCREEN_MESSAGE_TYPES.CLIPBOARD_WRITE_TEXT },
        {},
        sendResponse,
      ),
    ).toBe(false);
    expect(sendResponse).toHaveBeenCalledWith({
      success: false,
      error: 'Clipboard text must be a string',
    });
    expect(execCommand).not.toHaveBeenCalled();
  });

  test('ignores messages for another runtime and malformed messages', () => {
    const sendResponse = vi.fn();
    expect(listener({ target: 'background' }, {}, sendResponse)).toBe(false);
    expect(listener(null, {}, sendResponse)).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
  });

  test('rejects removed workflow messages', () => {
    const sendResponse = vi.fn();
    expect(
      listener({ target: MessageTarget.Offscreen, type: 'record_replay' }, {}, sendResponse),
    ).toBe(false);
    expect(sendResponse).toHaveBeenCalledWith({
      success: false,
      error: 'Unknown offscreen message type: record_replay',
    });
    expect(execCommand).not.toHaveBeenCalled();
  });
});
