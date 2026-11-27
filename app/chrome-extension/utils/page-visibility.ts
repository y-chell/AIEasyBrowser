export interface PageVisibility {
  visibilityState: string;
  hidden: boolean | null;
  hasFocus: boolean | null;
  error?: string;
}

export const PAGE_HIDDEN_GUIDANCE =
  'The page is hidden; rendering and animations may be paused. Restore/show the actual Chrome window and tab, then re-check the condition. Focus requests do not guarantee OS presentation. Do not repeat an already completed action.';

/** Read the document state without emulating focus or changing page styles. */
export async function readPageVisibility(tabId: number, frameId = 0): Promise<PageVisibility> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: 'ISOLATED',
      func: () => ({
        visibilityState: document.visibilityState,
        hidden: document.hidden,
        hasFocus: document.hasFocus(),
      }),
    });
    const state = results?.[0]?.result;
    if (
      !state ||
      typeof state.visibilityState !== 'string' ||
      typeof state.hidden !== 'boolean' ||
      typeof state.hasFocus !== 'boolean'
    ) {
      throw new Error('Page visibility probe returned no document state');
    }
    return state;
  } catch (error) {
    return {
      visibilityState: 'unknown',
      hidden: null,
      hasFocus: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface FocusVerification {
  activationRequested: boolean;
  focusRequested: boolean;
  /** Verified document visibility/focus only; this does not prove OS pixel presentation. */
  renderingReady: boolean;
  pageVisibility: PageVisibility;
  code?: 'PAGE_HIDDEN' | 'FOCUS_NOT_CONFIRMED' | 'FOCUS_UNVERIFIED';
  guidance?: string;
}

/** Ordinary window/tab activation followed by a bounded, read-only document-state check. */
export async function focusTabAndVerify(
  tab: chrome.tabs.Tab,
  options: { activate?: boolean; focusWindow?: boolean; settleTimeoutMs?: number } = {},
): Promise<FocusVerification> {
  if (typeof tab.id !== 'number') throw new Error('A tab id is required to verify focus');
  const activate = options.activate !== false;
  const focusWindow = options.focusWindow !== false;
  if (focusWindow && typeof tab.windowId === 'number') {
    const window = await chrome.windows.get(tab.windowId);
    // Focusing alone does not restore a minimized window. Preserve maximized/fullscreen states.
    await chrome.windows.update(tab.windowId, {
      ...(window.state === 'minimized' ? { state: 'normal' as const } : {}),
      focused: true,
    });
  }
  if (activate) await chrome.tabs.update(tab.id, { active: true });

  const deadline = Date.now() + Math.max(0, Math.min(options.settleTimeoutMs ?? 300, 1000));
  let pageVisibility: PageVisibility;
  do {
    pageVisibility = await readPageVisibility(tab.id);
    if (pageVisibility.hidden === false && pageVisibility.hasFocus === true) break;
    if (pageVisibility.hidden === null || Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, deadline - Date.now())));
  } while (Date.now() <= deadline);

  const result: FocusVerification = {
    activationRequested: activate,
    focusRequested: focusWindow && typeof tab.windowId === 'number',
    renderingReady: pageVisibility.hidden === false && pageVisibility.hasFocus === true,
    pageVisibility,
  };
  if (pageVisibility.hidden === true) {
    result.code = 'PAGE_HIDDEN';
    result.guidance = PAGE_HIDDEN_GUIDANCE;
  } else if (pageVisibility.hidden === null) {
    result.code = 'FOCUS_UNVERIFIED';
    result.guidance =
      'The focus request completed, but the page state could not be read. Verify the actual Chrome window and tab before relying on visible UI state.';
  } else if (!result.renderingReady) {
    result.code = 'FOCUS_NOT_CONFIRMED';
    result.guidance =
      'The page is visible but does not report document focus. Activate the actual Chrome window and tab, then re-check.';
  }
  return result;
}
