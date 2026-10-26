import { MessageTarget, OFFSCREEN_MESSAGE_TYPES } from '@/common/message-types';

type OffscreenMessage = {
  target?: string;
  type?: string;
  text?: string;
};

async function readClipboardText(): Promise<string> {
  return navigator.clipboard.readText();
}

async function writeClipboardText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

chrome.runtime.onMessage.addListener(
  (message: OffscreenMessage, _sender, sendResponse: (response: unknown) => void) => {
    if (!message || message.target !== MessageTarget.Offscreen) return false;
    switch (message.type) {
      case OFFSCREEN_MESSAGE_TYPES.CLIPBOARD_READ_TEXT:
        readClipboardText()
          .then((text) => sendResponse({ success: true, text }))
          .catch((error) =>
            sendResponse({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        return true;
      case OFFSCREEN_MESSAGE_TYPES.CLIPBOARD_WRITE_TEXT:
        writeClipboardText(String(message.text ?? ''))
          .then(() => sendResponse({ success: true }))
          .catch((error) =>
            sendResponse({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        return true;
      default:
        sendResponse({ success: false, error: `Unknown offscreen message type: ${message.type}` });
        return false;
    }
  },
);
