import { MessageTarget, OFFSCREEN_MESSAGE_TYPES } from '@/common/message-types';

type OffscreenMessage = {
  target?: string;
  type?: string;
  text?: string;
};

function runClipboardCommand(command: 'copy' | 'paste', text = ''): string {
  const textarea = document.createElement('textarea');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  // Empty text still needs a selection to dispatch the copy event.
  textarea.value = command === 'copy' ? text || ' ' : '';
  let pastedText: string | undefined;
  let clipboardError: Error | undefined;
  textarea.addEventListener(command, (event: ClipboardEvent) => {
    event.preventDefault();
    if (!event.clipboardData) {
      clipboardError = new Error('Clipboard event did not provide clipboard data');
    } else if (command === 'copy') {
      event.clipboardData.setData('text/plain', text);
    } else {
      pastedText = event.clipboardData.getData('text/plain');
    }
  });
  document.body.appendChild(textarea);
  try {
    textarea.focus();
    textarea.select();
    // Offscreen documents cannot gain focus; use the extension's clipboard permissions.
    if (!document.execCommand(command)) {
      throw new Error(`Clipboard ${command} command was rejected`);
    }
    if (clipboardError) throw clipboardError;
    if (command === 'paste' && pastedText === undefined) {
      throw new Error('Clipboard paste command did not provide text');
    }
    return pastedText ?? '';
  } finally {
    textarea.remove();
  }
}

async function readClipboardText(): Promise<string> {
  return runClipboardCommand('paste');
}

async function writeClipboardText(text: string): Promise<void> {
  runClipboardCommand('copy', text);
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
        if (typeof message.text !== 'string') {
          sendResponse({ success: false, error: 'Clipboard text must be a string' });
          return false;
        }
        writeClipboardText(message.text)
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
