import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { OFFSCREEN_MESSAGE_TYPES } from '@/common/message-types';
import { offscreenManager } from '@/utils/offscreen-manager';
import { clipboardTool } from './clipboard';

vi.mock('@/utils/offscreen-manager', () => ({
  offscreenManager: { ensureOffscreenDocument: vi.fn(async () => undefined) },
}));

let sendMessage: ReturnType<typeof vi.fn>;
let executeScript: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(offscreenManager.ensureOffscreenDocument).mockResolvedValue(undefined);
  sendMessage = vi.fn(async () => ({ success: true, text: 'clipboard fixture' }));
  executeScript = vi.fn(async () => [
    {
      result: {
        success: true,
        text: 'selected fixture',
        source: 'target',
        inserted: true,
        target: 'input',
        method: 'setRangeText',
      },
    },
  ]);
  vi.stubGlobal('chrome', {
    runtime: { sendMessage },
    scripting: { executeScript },
    tabs: {
      get: vi.fn(async (id: number) => ({ id, windowId: 1, url: 'https://fixture.test/' })),
      query: vi.fn(async () => [{ id: 7, windowId: 1 }]),
      update: vi.fn(),
    },
    windows: { update: vi.fn() },
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('extension-owned clipboard transport', () => {
  test('reads without accessing or focusing the target website', async () => {
    const read = await clipboardTool.execute({ action: 'read_text', tabId: 7 });
    expect(read.structuredContent).toMatchObject({
      success: true,
      text: 'clipboard fixture',
      clipboardTransport: 'offscreen',
    });
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: OFFSCREEN_MESSAGE_TYPES.CLIPBOARD_READ_TEXT,
      }),
    );
    expect(executeScript).not.toHaveBeenCalled();
    expect(chrome.tabs.get).not.toHaveBeenCalled();
    expect(chrome.windows.update).not.toHaveBeenCalled();
  });

  test.each(['', 'agent text'])('writes %j directly through offscreen', async (text) => {
    const write = await clipboardTool.execute({ action: 'write_text', text });
    expect(write.structuredContent).toMatchObject({
      success: true,
      length: text.length,
      clipboardTransport: 'offscreen',
    });
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: OFFSCREEN_MESSAGE_TYPES.CLIPBOARD_WRITE_TEXT,
        text,
      }),
    );
    expect(executeScript).not.toHaveBeenCalled();
  });

  test.each(['read_text', 'write_text'] as const)(
    'reports %s errors without using page APIs',
    async (action) => {
      sendMessage.mockResolvedValue({ success: false, error: 'Clipboard denied' });
      const failed = await clipboardTool.execute({ action, text: 'value' });
      expect(failed.isError).toBe(true);
      expect(failed.content[0]).toMatchObject({
        text: expect.stringContaining('Clipboard denied'),
      });
      expect(executeScript).not.toHaveBeenCalled();
    },
  );

  test('reports an absent offscreen response', async () => {
    sendMessage.mockResolvedValue(undefined);
    const failed = await clipboardTool.execute({ action: 'read_text' });
    expect(failed.content[0]).toMatchObject({
      text: expect.stringContaining('No response from offscreen'),
    });
  });

  test('rejects missing text before creating the offscreen document', async () => {
    const failed = await clipboardTool.execute({ action: 'write_text' });
    expect(failed.isError).toBe(true);
    expect(offscreenManager.ensureOffscreenDocument).not.toHaveBeenCalled();
  });

  test('reads omitted paste text through offscreen before inserting in the page', async () => {
    const pasted = await clipboardTool.execute({
      action: 'paste_text',
      selector: '#search',
      tabId: 7,
    });
    expect(pasted.structuredContent).toMatchObject({ success: true, inserted: true });
    expect(executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        args: [expect.objectContaining({ text: 'clipboard fixture', selector: '#search' })],
      }),
    );
  });

  test('does not silently ignore clipboard write errors before paste', async () => {
    sendMessage.mockResolvedValue({ success: false, error: 'Write rejected' });
    const failed = await clipboardTool.execute({ action: 'paste_text', text: 'value', tabId: 7 });
    expect(failed.isError).toBe(true);
    expect(executeScript).not.toHaveBeenCalled();
  });

  test('returns an explicit partial result when copy extracts text but cannot write it', async () => {
    sendMessage.mockResolvedValue({ success: false, error: 'Write rejected' });
    const copied = await clipboardTool.execute({ action: 'copy_selection', tabId: 7 });
    expect(copied.structuredContent).toMatchObject({
      success: true,
      partialSuccess: true,
      text: 'selected fixture',
      clipboardWritten: false,
      clipboardError: 'Write rejected',
    });
  });

  test('does not dispatch a late clipboard write after cancelled offscreen creation', async () => {
    let finish!: () => void;
    vi.mocked(offscreenManager.ensureOffscreenDocument).mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const controller = new AbortController();
    const pending = clipboardTool.execute(
      { action: 'write_text', text: 'must not be written' },
      { signal: controller.signal },
    );
    controller.abort(new Error('Cancelled'));
    finish();
    const failed = await pending;
    expect(failed.isError).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test('does not return a late clipboard reply as success after cancellation', async () => {
    let finish!: (response: unknown) => void;
    sendMessage.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const controller = new AbortController();
    const pending = clipboardTool.execute({ action: 'read_text' }, { signal: controller.signal });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
    controller.abort(new Error('Cancelled'));
    finish({ success: true, text: 'late reply' });
    expect((await pending).isError).toBe(true);
  });

  test('does not mask cancellation as a partial copy success', async () => {
    const controller = new AbortController();
    executeScript.mockImplementation(async () => {
      controller.abort(new Error('Cancelled'));
      return [{ result: { success: true, text: 'late selection' } }];
    });
    const failed = await clipboardTool.execute(
      { action: 'copy_selection', tabId: 7 },
      {
        signal: controller.signal,
      },
    );
    expect(failed.isError).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test('does not return a late page paste result as success after cancellation', async () => {
    const controller = new AbortController();
    executeScript.mockImplementation(async () => {
      controller.abort(new Error('Cancelled'));
      return [{ result: { success: true, inserted: true } }];
    });
    const failed = await clipboardTool.execute(
      { action: 'paste_text', text: 'value', tabId: 7 },
      { signal: controller.signal },
    );
    expect(failed.isError).toBe(true);
  });
});
