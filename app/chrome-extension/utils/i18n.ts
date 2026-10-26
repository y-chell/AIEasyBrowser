/** Safe wrapper for the one browser-provided label used by bookmark tools. */
export function getMessage(key: string, substitutions?: string[]): string {
  try {
    const message = chrome.i18n.getMessage(key, substitutions);
    if (message) return message;
  } catch {
    // Tests and non-extension contexts do not provide chrome.i18n.
  }

  return key === 'bookmarksBarLabel' ? 'Bookmarks bar' : key;
}
