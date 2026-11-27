import { createErrorResponse, createStructuredToolResult, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import type { BrowserToolExecutionContext } from '../browser-session-context';
import { TOOL_NAMES } from 'aieasybrowser-shared';
import { focusTabAndVerify } from '@/utils/page-visibility';

// Default window dimensions
const DEFAULT_WINDOW_WIDTH = 1280;
const DEFAULT_WINDOW_HEIGHT = 720;

interface NavigateToolParams {
  url?: string;
  newWindow?: boolean;
  width?: number;
  height?: number;
  refresh?: boolean;
  tabId?: number;
  windowId?: number;
  background?: boolean; // when true, do not activate tab or focus window
}

const WEB_URL_SCHEMES = new Set(['http:', 'https:']);

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function isIpv4Address(hostname: string): boolean {
  const parts = hostname.split('.');
  return (
    parts.length === 4 &&
    parts.every((part) => {
      if (!/^\d+$/.test(part)) return false;
      const value = Number(part);
      return value >= 0 && value <= 255 && String(value) === part;
    })
  );
}

function isLocalOrIpHostname(hostname: string): boolean {
  const normalized = stripIpv6Brackets(hostname).toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    isIpv4Address(normalized) ||
    normalized.includes(':')
  );
}

function canAddWwwVariant(hostname: string): boolean {
  const normalized = stripIpv6Brackets(hostname).toLowerCase();
  return (
    normalized.includes('.') && !normalized.startsWith('www.') && !isLocalOrIpHostname(normalized)
  );
}

function withPort(hostname: string, port: string): string {
  return port ? `${hostname}:${port}` : hostname;
}

function normalizeComparablePath(pathname: string): string {
  if (!pathname) return '/';
  const withLeading = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return withLeading !== '/' && withLeading.endsWith('/') ? withLeading.slice(0, -1) : withLeading;
}

function normalizeComparableUrl(input: string): URL | undefined {
  try {
    return new URL(input);
  } catch {
    return undefined;
  }
}

export function buildUrlQueryPatterns(input: string): {
  patterns: string[];
  canUseUrlFilter: boolean;
  reason?: string;
} {
  const trimmed = input.trim();
  if (!trimmed) return { patterns: [], canUseUrlFilter: false, reason: 'empty_url' };

  if (trimmed.includes('*')) {
    const scheme = trimmed.split(':', 1)[0]?.toLowerCase();
    const canUseUrlFilter = scheme === 'http' || scheme === 'https';
    return {
      patterns: [trimmed],
      canUseUrlFilter,
      reason: canUseUrlFilter ? undefined : 'unsupported_match_pattern_scheme',
    };
  }

  const parsed = normalizeComparableUrl(trimmed);
  if (!parsed) {
    return { patterns: [], canUseUrlFilter: false, reason: 'not_absolute_url' };
  }

  if (!WEB_URL_SCHEMES.has(parsed.protocol)) {
    return { patterns: [], canUseUrlFilter: false, reason: 'unsupported_url_scheme' };
  }

  const patterns = new Set<string>();
  const hostnames = new Set<string>([parsed.hostname]);
  const hostnameNoWww = parsed.hostname.replace(/^www\./i, '');

  hostnames.add(hostnameNoWww);
  if (canAddWwwVariant(hostnameNoWww)) {
    hostnames.add(`www.${hostnameNoWww}`);
  }

  const protocols = new Set<string>([parsed.protocol]);
  protocols.add(parsed.protocol === 'https:' ? 'http:' : 'https:');

  for (const protocol of protocols) {
    for (const hostname of hostnames) {
      patterns.add(`${protocol}//${withPort(hostname, parsed.port)}/*`);
    }
  }

  return { patterns: Array.from(patterns), canUseUrlFilter: true };
}

/**
 * Tool for navigating to URLs in browser tabs or windows
 */
class NavigateTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.NAVIGATE;

  private createNavigationResponse(
    tab: chrome.tabs.Tab,
    navigationAction: 'navigate' | 'refresh' | 'back' | 'forward' | 'reuse',
    requestedUrl: string | null,
    message: string,
    tabs?: chrome.tabs.Tab[],
  ): ToolResult {
    if (typeof tab.id !== 'number') {
      return createErrorResponse('Navigation returned no tab ID');
    }
    return createStructuredToolResult({
      success: true,
      message,
      tabId: tab.id,
      windowId: tab.windowId,
      navigationAction,
      navigationStatus: navigationAction === 'reuse' ? 'not_requested' : 'requested',
      requestedUrl,
      // These are Chrome snapshots, not proof that this request committed. Even
      // a matching URL or status="complete" may still describe the old document.
      url: tab.url ?? null,
      pendingUrl: tab.pendingUrl ?? null,
      tabStatus: tab.status ?? null,
      ...(tabs ? { tabs: tabs.map((item) => ({ tabId: item.id, url: item.url })) } : {}),
    });
  }

  private async createWindowNavigationResponse(
    window: chrome.windows.Window,
    requestedUrl: string,
  ): Promise<ToolResult> {
    const tabs = window.tabs?.length
      ? window.tabs
      : await chrome.tabs.query({ windowId: window.id });
    const tab = tabs.find((item) => typeof item.id === 'number');
    if (!tab) return createErrorResponse('Navigation requested, but new window returned no tab ID');
    return this.createNavigationResponse(
      tab,
      'navigate',
      requestedUrl,
      'Navigation requested in new window; completion has not been verified',
      tabs,
    );
  }

  async execute(
    args: NavigateToolParams,
    executionContext?: BrowserToolExecutionContext,
  ): Promise<ToolResult> {
    const {
      newWindow = false,
      width,
      height,
      url,
      refresh = false,
      tabId,
      background,
      windowId,
    } = args;

    console.log(
      `Attempting to ${refresh ? 'refresh current tab' : `open URL: ${url}`} with options:`,
      args,
    );

    try {
      const explicitTab = await this.tryGetTab(tabId);
      if (typeof tabId === 'number' && !explicitTab && executionContext?.strictTarget) {
        return createErrorResponse('TARGET_CLOSED: select an existing tab with use or open');
      }

      // Handle refresh option first
      if (refresh) {
        console.log('Requesting refresh of target tab');
        // Get target tab (explicit or active in provided window)
        const targetTab = explicitTab || (await this.getActiveTabOrThrowInWindow(windowId));
        if (!targetTab.id) return createErrorResponse('No target tab found to refresh');
        await chrome.tabs.reload(targetTab.id);

        console.log(`Refresh requested for tab ID: ${targetTab.id}`);

        const updatedTab = await chrome.tabs.get(targetTab.id);
        return this.createNavigationResponse(
          updatedTab,
          'refresh',
          null,
          'Refresh requested; completion has not been verified',
        );
      }

      // Validate that url is provided when not refreshing
      if (!url) {
        return createErrorResponse('URL parameter is required when refresh is not true');
      }

      // Handle history navigation: url="back" or url="forward"
      if (url === 'back' || url === 'forward') {
        const targetTab = explicitTab || (await this.getActiveTabOrThrowInWindow(windowId));
        if (!targetTab.id) {
          return createErrorResponse('No target tab found for history navigation');
        }

        // Respect background flag for focus behavior
        await this.ensureFocus(targetTab, {
          activate: background !== true,
          focusWindow: background !== true,
        });

        if (url === 'forward') {
          await chrome.tabs.goForward(targetTab.id);
          console.log(`Forward navigation requested in tab ID: ${targetTab.id}`);
        } else {
          await chrome.tabs.goBack(targetTab.id);
          console.log(`Back navigation requested in tab ID: ${targetTab.id}`);
        }

        const updatedTab = await chrome.tabs.get(targetTab.id);
        return this.createNavigationResponse(
          updatedTab,
          url,
          null,
          `History navigation ${url} requested; completion has not been verified`,
        );
      }

      const normalizedUrl = url.trim();

      // 1. Check if URL is already open
      // Prefer Chrome's URL match patterns for http(s). For local/special URLs that
      // cannot be represented safely as match patterns, query all tabs and filter below.
      console.log(`Checking if URL is already open: ${url}`);

      const urlQuery = buildUrlQueryPatterns(normalizedUrl);
      let candidateTabs: chrome.tabs.Tab[] = [];
      if (urlQuery.canUseUrlFilter && urlQuery.patterns.length > 0) {
        try {
          candidateTabs = await chrome.tabs.query({ url: urlQuery.patterns });
        } catch (error) {
          console.warn('URL pattern query failed; falling back to all-tab scan:', error);
          candidateTabs = await chrome.tabs.query({});
        }
      } else {
        candidateTabs = await chrome.tabs.query({});
      }
      console.log(`Found ${candidateTabs.length} candidate tabs for URL:`, {
        url: normalizedUrl,
        patterns: urlQuery.patterns,
        queryReason: urlQuery.reason,
      });

      // Prefer strict match when user specifies a concrete path/query.
      // Only fall back to host-level activation when the target is site root.
      const pickBestMatch = (target: string, tabsToPick: chrome.tabs.Tab[]) => {
        const targetUrl = normalizeComparableUrl(target);
        if (!targetUrl) {
          // Not a fully-qualified URL; cannot do structured comparison
          return tabsToPick[0];
        }

        const hostBase = (h: string) => h.replace(/^www\./, '').toLowerCase();
        const isRootTarget =
          normalizeComparablePath(targetUrl.pathname) === '/' && !targetUrl.search;
        const targetPath = normalizeComparablePath(targetUrl.pathname);
        const targetSearch = targetUrl.search || '';
        const targetHostBase = hostBase(targetUrl.host);

        let best: { tab?: chrome.tabs.Tab; score: number } = { score: -1 };

        for (const tab of tabsToPick) {
          const tabUrlStr = tab.url || '';
          const tabUrl = normalizeComparableUrl(tabUrlStr);
          if (!tabUrl) {
            continue;
          }

          if (tabUrl.protocol !== targetUrl.protocol && !WEB_URL_SCHEMES.has(targetUrl.protocol)) {
            continue;
          }

          const tabHostBase = hostBase(tabUrl.host);
          if (WEB_URL_SCHEMES.has(targetUrl.protocol) && tabHostBase !== targetHostBase) continue;
          if (!WEB_URL_SCHEMES.has(targetUrl.protocol) && tabUrl.href !== targetUrl.href) continue;

          const tabPath = normalizeComparablePath(tabUrl.pathname);
          const tabSearch = tabUrl.search || '';

          // Scoring:
          // 3 - exact path match and (if target has query) exact query match
          // 2 - exact path match ignoring query (target without query)
          // 1 - same host, any path (only if target is root)
          let score = -1;
          const pathEqual = tabPath === targetPath;
          const searchEqual = tabSearch === targetSearch;

          if (pathEqual && (targetSearch ? searchEqual : true)) {
            score = 3;
          } else if (pathEqual && !targetSearch) {
            score = 2;
          }

          if (score > best.score) {
            best = { tab, score };
            if (score === 3) break; // Cannot do better
          }
        }

        return best.tab;
      };

      const existingTab = explicitTab || pickBestMatch(normalizedUrl, candidateTabs);
      if (existingTab?.id !== undefined) {
        // An explicit target always requests navigation, including the same URL.
        // Matching an existing tab by URL only reuses it without navigating.
        if (explicitTab && typeof explicitTab.id === 'number') {
          await chrome.tabs.update(explicitTab.id, { url: normalizedUrl });
        }
        // Optionally bring to foreground based on background flag
        await this.ensureFocus(existingTab, {
          activate: background !== true,
          focusWindow: background !== true,
        });

        const updatedTab = await chrome.tabs.get(existingTab.id);
        return this.createNavigationResponse(
          updatedTab,
          explicitTab ? 'navigate' : 'reuse',
          normalizedUrl,
          explicitTab
            ? 'Navigation requested in existing tab; completion has not been verified'
            : 'Reused existing tab; no navigation requested',
        );
      }

      // 2. If URL is not already open, decide how to open it based on options
      const openInNewWindow = newWindow || typeof width === 'number' || typeof height === 'number';

      if (openInNewWindow) {
        console.log('Opening URL in a new window.');

        // Create new window
        const newWindow = await chrome.windows.create({
          url: normalizedUrl,
          width: typeof width === 'number' ? width : DEFAULT_WINDOW_WIDTH,
          height: typeof height === 'number' ? height : DEFAULT_WINDOW_HEIGHT,
          focused: background === true ? false : true,
        });

        if (newWindow && newWindow.id !== undefined) {
          return await this.createWindowNavigationResponse(newWindow, normalizedUrl);
        }
      } else {
        console.log('Opening URL in the last active window.');
        // Try to open a new tab in the specified window, otherwise the most recently active window
        let targetWindow: chrome.windows.Window | null = null;
        if (typeof windowId === 'number') {
          targetWindow = await chrome.windows.get(windowId, { populate: false });
        }
        if (!targetWindow) {
          targetWindow = await chrome.windows.getLastFocused({ populate: false });
        }

        if (targetWindow && targetWindow.id !== undefined) {
          console.log(`Found target Window ID: ${targetWindow.id}`);

          const newTab = await chrome.tabs.create({
            url: normalizedUrl,
            windowId: targetWindow.id,
            active: background === true ? false : true,
          });
          if (background !== true) {
            await chrome.windows.update(targetWindow.id, { focused: true });
          }

          return this.createNavigationResponse(
            newTab,
            'navigate',
            normalizedUrl,
            'Navigation requested in new tab; completion has not been verified',
          );
        } else {
          // In rare cases, if there's no recently active window (e.g., browser just started with no windows)
          // Fall back to opening in a new window
          console.warn('No last focused window found, falling back to creating a new window.');

          const fallbackWindow = await chrome.windows.create({
            url: normalizedUrl,
            width: DEFAULT_WINDOW_WIDTH,
            height: DEFAULT_WINDOW_HEIGHT,
            focused: true,
          });

          if (fallbackWindow && fallbackWindow.id !== undefined) {
            return await this.createWindowNavigationResponse(fallbackWindow, normalizedUrl);
          }
        }
      }

      // If all attempts fail, return a generic error
      return createErrorResponse('Failed to open URL: Unknown error occurred');
    } catch (error) {
      if (chrome.runtime.lastError) {
        console.error(`Chrome API Error: ${chrome.runtime.lastError.message}`, error);
        return createErrorResponse(`Chrome API Error: ${chrome.runtime.lastError.message}`);
      } else {
        console.error('Error in navigate:', error);
        return createErrorResponse(
          `Error navigating to URL: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
export const navigateTool = new NavigateTool();

interface CloseTabsToolParams {
  tabIds?: number[];
  url?: string;
}

/**
 * Tool for closing browser tabs
 */
class CloseTabsTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.CLOSE_TABS;

  private serializeTabContext(tab: chrome.tabs.Tab | null | undefined) {
    if (!tab || typeof tab.id !== 'number') return null;
    return {
      tabId: tab.id,
      windowId: tab.windowId,
      url: tab.url || '',
      title: tab.title || '',
      active: tab.active || false,
      index: tab.index,
    };
  }

  private async getActiveContextForWindow(
    windowId: number,
  ): Promise<Record<string, unknown> | null> {
    try {
      const [activeTab] = await chrome.tabs.query({ active: true, windowId });
      return this.serializeTabContext(activeTab);
    } catch {
      return null;
    }
  }

  private async getPostCloseContext(
    tabsToClose: chrome.tabs.Tab[],
    preferredWindowId?: number,
  ): Promise<{
    affectedWindowIds: number[];
    activeContextAfterClose: Record<string, unknown> | null;
    remainingActiveContexts: Record<string, unknown>[];
  }> {
    const affectedWindowIds = Array.from(
      new Set(
        tabsToClose
          .map((tab) => tab.windowId)
          .filter((windowId): windowId is number => Number.isInteger(windowId)),
      ),
    );

    const remainingActiveContexts = (
      await Promise.all(
        affectedWindowIds.map((windowId) => this.getActiveContextForWindow(windowId)),
      )
    ).filter((context): context is Record<string, unknown> => context !== null);

    const activeContextAfterClose =
      remainingActiveContexts.find((context) => context.windowId === preferredWindowId) ||
      remainingActiveContexts[0] ||
      null;

    return {
      affectedWindowIds,
      activeContextAfterClose,
      remainingActiveContexts,
    };
  }

  async execute(args: CloseTabsToolParams): Promise<ToolResult> {
    const { tabIds, url } = args;
    console.log(`Attempting to close tabs with options:`, args);

    try {
      // If URL is provided, close all tabs matching that URL
      if (url) {
        console.log(`Searching for tabs with URL: ${url}`);
        let tabs: chrome.tabs.Tab[];
        if (url.includes('*')) {
          tabs = await chrome.tabs.query({ url });
        } else {
          const exactUrl = new URL(url).href;
          tabs = (await chrome.tabs.query({})).filter(
            (tab) => tab.url === exactUrl || tab.pendingUrl === exactUrl,
          );
        }

        if (!tabs || tabs.length === 0) {
          console.log(`No tabs found with URL: ${url}`);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  message: `No tabs found with URL: ${url}`,
                  closedCount: 0,
                }),
              },
            ],
            isError: false,
          };
        }

        console.log(`Found ${tabs.length} tabs with URL: ${url}`);
        const tabsToClose = tabs.filter(
          (tab): tab is chrome.tabs.Tab => typeof tab.id === 'number',
        );
        const tabIdsToClose = tabsToClose
          .map((tab) => tab.id)
          .filter((id): id is number => id !== undefined);

        if (tabIdsToClose.length === 0) {
          return createErrorResponse('Found tabs but could not get their IDs');
        }

        const preferredWindowId =
          tabsToClose.find((tab) => tab.active)?.windowId ?? tabsToClose[0]?.windowId;
        await chrome.tabs.remove(tabIdsToClose);
        const postCloseContext = await this.getPostCloseContext(tabsToClose, preferredWindowId);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: `Closed ${tabIdsToClose.length} tabs with URL: ${url}`,
                closedCount: tabIdsToClose.length,
                closedTabIds: tabIdsToClose,
                activeContextAfterClose: postCloseContext.activeContextAfterClose,
                remainingActiveContexts: postCloseContext.remainingActiveContexts,
                affectedWindowIds: postCloseContext.affectedWindowIds,
              }),
            },
          ],
          isError: false,
        };
      }

      // If tabIds are provided, close those tabs
      if (tabIds && tabIds.length > 0) {
        console.log(`Closing tabs with IDs: ${tabIds.join(', ')}`);

        // Verify that all tabIds exist
        const existingTabs = await Promise.all(
          tabIds.map(async (tabId) => {
            try {
              return await chrome.tabs.get(tabId);
            } catch (error) {
              console.warn(`Tab with ID ${tabId} not found`);
              return null;
            }
          }),
        );

        const validTabs = existingTabs.filter((tab): tab is chrome.tabs.Tab => tab !== null);
        const validTabIds = validTabs
          .filter((tab): tab is chrome.tabs.Tab => tab !== null)
          .map((tab) => tab.id)
          .filter((id): id is number => id !== undefined);

        if (validTabIds.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  message: 'None of the provided tab IDs exist',
                  closedCount: 0,
                }),
              },
            ],
            isError: false,
          };
        }

        const preferredWindowId =
          validTabs.find((tab) => tab.active)?.windowId ?? validTabs[0]?.windowId;
        await chrome.tabs.remove(validTabIds);
        const postCloseContext = await this.getPostCloseContext(validTabs, preferredWindowId);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: `Closed ${validTabIds.length} tabs`,
                closedCount: validTabIds.length,
                closedTabIds: validTabIds,
                invalidTabIds: tabIds.filter((id) => !validTabIds.includes(id)),
                activeContextAfterClose: postCloseContext.activeContextAfterClose,
                remainingActiveContexts: postCloseContext.remainingActiveContexts,
                affectedWindowIds: postCloseContext.affectedWindowIds,
              }),
            },
          ],
          isError: false,
        };
      }

      // If no tabIds or URL provided, close the current active tab
      console.log('No tabIds or URL provided, closing active tab');
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!activeTab || !activeTab.id) {
        return createErrorResponse('No active tab found');
      }

      await chrome.tabs.remove(activeTab.id);
      const postCloseContext = await this.getPostCloseContext([activeTab], activeTab.windowId);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: 'Closed active tab',
              closedCount: 1,
              closedTabIds: [activeTab.id],
              activeContextAfterClose: postCloseContext.activeContextAfterClose,
              remainingActiveContexts: postCloseContext.remainingActiveContexts,
              affectedWindowIds: postCloseContext.affectedWindowIds,
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      console.error('Error in CloseTabsTool.execute:', error);
      return createErrorResponse(
        `Error closing tabs: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const closeTabsTool = new CloseTabsTool();

interface SwitchTabToolParams {
  tabId: number;
  windowId?: number;
}

/**
 * Tool for switching the active tab
 */
class SwitchTabTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.SWITCH_TAB;

  async execute(args: SwitchTabToolParams): Promise<ToolResult> {
    const { tabId, windowId } = args;

    console.log(`Attempting to switch to tab ID: ${tabId} in window ID: ${windowId}`);

    try {
      const targetTab = await chrome.tabs.get(tabId);
      if (windowId !== undefined && windowId !== targetTab.windowId)
        throw new Error('The requested tab does not belong to windowId');
      const focusVerification = await focusTabAndVerify(targetTab);
      const updatedTab = await chrome.tabs.get(tabId);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: focusVerification.renderingReady
                ? `Tab ${tabId} is active and its document reports visible focus`
                : `Tab ${tabId} activation requested; page presentation is not confirmed`,
              tabId: updatedTab.id,
              windowId: updatedTab.windowId,
              url: updatedTab.url,
              active: updatedTab.active,
              focusVerification,
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      if (chrome.runtime.lastError) {
        console.error(`Chrome API Error: ${chrome.runtime.lastError.message}`, error);
        return createErrorResponse(`Chrome API Error: ${chrome.runtime.lastError.message}`);
      } else {
        console.error('Error in SwitchTabTool.execute:', error);
        return createErrorResponse(
          `Error switching tab: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}

export const switchTabTool = new SwitchTabTool();
