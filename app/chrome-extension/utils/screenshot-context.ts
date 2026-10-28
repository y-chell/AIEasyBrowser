// Simple in-memory screenshot context manager per tab
// Used for screenshot metadata and domain checks, not implicit input scaling.

export interface ScreenshotContext {
  // Final screenshot dimensions (in CSS pixels after any scaling)
  screenshotWidth: number;
  screenshotHeight: number;
  // Viewport dimensions (CSS pixels)
  viewportWidth: number;
  viewportHeight: number;
  // Device pixel ratio at capture time (optional, for reference)
  devicePixelRatio?: number;
  // Hostname of the page when the screenshot was taken (used for domain safety checks)
  hostname?: string;
  // Timestamp
  timestamp: number;
}

const TTL_MS = 5 * 60 * 1000; // 5 minutes

const contexts = new Map<number, ScreenshotContext>();

export const screenshotContextManager = {
  setContext(tabId: number, ctx: Omit<ScreenshotContext, 'timestamp'>) {
    contexts.set(tabId, { ...ctx, timestamp: Date.now() });
  },
  getContext(tabId: number): ScreenshotContext | undefined {
    const ctx = contexts.get(tabId);
    if (!ctx) return undefined;
    if (Date.now() - ctx.timestamp > TTL_MS) {
      contexts.delete(tabId);
      return undefined;
    }
    return ctx;
  },
  clear(tabId: number) {
    contexts.delete(tabId);
  },
};
