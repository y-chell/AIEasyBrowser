import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { MessageTarget, OFFSCREEN_MESSAGE_TYPES } from '@/common/message-types';

type MessageListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => boolean;

let listener: MessageListener;
let clipboard: {
  readText: ReturnType<typeof vi.fn>;
  writeText: ReturnType<typeof vi.fn>;
};

beforeEach(async () => {
  vi.resetModules();
  clipboard = {
    readText: vi.fn().mockResolvedValue('fixture clipboard text'),
    writeText: vi.fn().mockResolvedValue(undefined),
  };
  vi.stubGlobal('navigator', { clipboard });
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
    expect(clipboard.writeText).toHaveBeenCalledWith('agent text');
  });

  test.each(['read', 'write'])('reports clipboard %s failures', async (operation) => {
    clipboard.readText.mockRejectedValue(new Error('Clipboard access denied'));
    clipboard.writeText.mockRejectedValue(new Error('Clipboard access denied'));
    const sendResponse = vi.fn();
    listener(
      {
        target: MessageTarget.Offscreen,
        type:
          operation === 'read'
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
        error: 'Clipboard access denied',
      }),
    );
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
    expect(clipboard.readText).not.toHaveBeenCalled();
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });
});
