import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'aieasybrowser-shared';
import { networkCaptureStartTool, networkCaptureStopTool } from './network-capture-web-request';
import type { BrowserToolExecutionContext } from '../browser-session-context';

interface NetworkCaptureToolParams {
  action: 'start' | 'stop';
  url?: string;
  maxCaptureTime?: number;
  inactivityTimeout?: number;
  includeStatic?: boolean;
}

export interface WaitForCapturedRequestOptions {
  tabId: number;
  urlPattern?: string;
  method?: string;
  status?: number;
  timeoutMs: number;
  startedAfter?: number;
  includeStatic?: boolean;
  signal?: AbortSignal;
  reportProgress?: BrowserToolExecutionContext['reportProgress'];
}

const WAIT_PROGRESS_INTERVAL_MS = 250;

function createAbortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  const message = reason instanceof Error ? reason.message : 'Operation cancelled';
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError(signal);
}

function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(createAbortError(signal));
    };

    const timer = setTimeout(
      () => {
        cleanup();
        resolve();
      },
      Math.max(0, delayMs),
    );
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function reportWaitProgress(
  reportProgress: BrowserToolExecutionContext['reportProgress'] | undefined,
  progress: number,
  message: string,
): Promise<void> {
  try {
    await reportProgress?.({
      progress: Math.max(0, Math.min(100, Math.round(progress))),
      total: 100,
      message,
    });
  } catch {
    // Progress delivery is best effort.
  }
}

/**
 * Extract text content from ToolResult
 */
function getFirstText(result: ToolResult): string | undefined {
  const first = result.content?.[0];
  return first && first.type === 'text' ? first.text : undefined;
}

/**
 * Decorate JSON result with additional fields
 */
function decorateJsonResult(result: ToolResult, extra: Record<string, unknown>): ToolResult {
  const text = getFirstText(result);
  if (typeof text !== 'string') return result;

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        ...result,
        content: [{ type: 'text', text: JSON.stringify({ ...parsed, ...extra }) }],
      };
    }
  } catch {
    // If the underlying tool didn't return JSON, keep it as-is
  }
  return result;
}

function getWebRequestCaptureInfo(tabId: number): any | undefined {
  return networkCaptureStartTool.captureData.get(tabId);
}

function listCapturedRequests(captureInfo: any): any[] {
  if (!captureInfo || typeof captureInfo !== 'object') return [];
  const requests = captureInfo.requests;
  if (!requests || typeof requests !== 'object') return [];
  return Object.values(requests);
}

function isCompletedRequest(request: any): boolean {
  if (!request || typeof request !== 'object') return false;
  if (request.status === 'complete' || request.status === 'error') return true;
  if (typeof request.status === 'number') return true;
  if (typeof request.statusCode === 'number') return true;
  if (typeof request.responseTime === 'number') return true;
  if (typeof request.errorText === 'string' && request.errorText.trim()) return true;
  return false;
}

function matchesCapturedRequest(request: any, opts: WaitForCapturedRequestOptions): boolean {
  if (!request || typeof request !== 'object') return false;
  if (typeof opts.startedAfter === 'number' && Number.isFinite(opts.startedAfter)) {
    const requestTime =
      typeof request.requestTime === 'number'
        ? request.requestTime
        : typeof request.responseTime === 'number'
          ? request.responseTime
          : undefined;
    if (typeof requestTime === 'number' && requestTime < opts.startedAfter) {
      return false;
    }
  }
  if (opts.urlPattern) {
    const haystack = String(request.url || '').toLowerCase();
    if (!haystack.includes(opts.urlPattern.toLowerCase())) return false;
  }
  if (opts.method) {
    if (String(request.method || '').toUpperCase() !== opts.method.toUpperCase()) return false;
  }
  if (typeof opts.status === 'number') {
    const statusValue =
      typeof request.status === 'number'
        ? request.status
        : typeof request.statusCode === 'number'
          ? request.statusCode
          : undefined;
    if (statusValue !== opts.status) return false;
  }
  return true;
}

export async function waitForCapturedRequest(opts: WaitForCapturedRequestOptions) {
  const startTime = Date.now();
  const timeoutMs = Math.max(1000, Math.min(Number(opts.timeoutMs || 10000), 120000));
  const pollIntervalMs = 100;
  const useActiveWebRequest = !!getWebRequestCaptureInfo(opts.tabId);
  let tempCaptureStarted = false;
  let lastProgress = -1;
  let lastReportedAt = Number.NEGATIVE_INFINITY;

  const reportElapsedProgress = async (force = false) => {
    const now = Date.now();
    const elapsedMs = now - startTime;
    const progress = Math.min(99, Math.floor((elapsedMs / timeoutMs) * 100));
    if (!force && now - lastReportedAt < WAIT_PROGRESS_INTERVAL_MS) return;
    if (progress <= lastProgress) return;

    await reportWaitProgress(opts.reportProgress, progress, 'Waiting for matching network request');
    lastProgress = progress;
    lastReportedAt = now;
  };

  try {
    throwIfAborted(opts.signal);
    await reportElapsedProgress(true);

    if (!useActiveWebRequest) {
      await networkCaptureStartTool.startCaptureForTab(opts.tabId, {
        maxCaptureTime: timeoutMs + 1000,
        inactivityTimeout: timeoutMs + 1000,
        includeStatic: opts.includeStatic === true,
      });
      tempCaptureStarted = true;
      throwIfAborted(opts.signal);
    }

    while (Date.now() - startTime <= timeoutMs) {
      throwIfAborted(opts.signal);
      const matched = listCapturedRequests(getWebRequestCaptureInfo(opts.tabId))
        .filter((request) => matchesCapturedRequest(request, opts))
        .find((request) => isCompletedRequest(request));

      if (matched) {
        await reportWaitProgress(opts.reportProgress, 100, 'Matched network request');
        return {
          backend: 'webRequest',
          request: matched,
          tookMs: Date.now() - startTime,
        };
      }

      await reportElapsedProgress();
      await abortableDelay(pollIntervalMs, opts.signal);
    }

    throw new Error('Network wait timed out');
  } finally {
    if (tempCaptureStarted) {
      await networkCaptureStartTool.stopCapture(opts.tabId).catch(() => undefined);
    }
  }
}

/**
 * Network capture through the webRequest API: no debugger, no bodies. Bodies, wire headers, and
 * HAR come from chrome_cdp_network on a held debugger session.
 */
class NetworkCaptureTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.NETWORK_CAPTURE;

  async execute(args: NetworkCaptureToolParams): Promise<ToolResult> {
    const action = args?.action;
    if (action !== 'start' && action !== 'stop') {
      return createErrorResponse('Parameter [action] is required and must be one of: start, stop');
    }

    if (action === 'start') {
      if (networkCaptureStartTool.captureData.size > 0) {
        return createErrorResponse(
          'Network capture is already active. Stop it before starting a new capture.',
        );
      }
      const result = await networkCaptureStartTool.execute({
        url: args.url,
        maxCaptureTime: args.maxCaptureTime,
        inactivityTimeout: args.inactivityTimeout,
        includeStatic: args.includeStatic,
      });
      return decorateJsonResult(result, { backend: 'webRequest' });
    }

    if (
      networkCaptureStartTool.captureData.size === 0 &&
      !networkCaptureStartTool.peekLatestCompletedCapture?.()
    ) {
      return createErrorResponse('No active network captures found in any tab.');
    }
    const result = await networkCaptureStopTool.execute();
    return decorateJsonResult(result, { backend: 'webRequest' });
  }
}

export const networkCaptureTool = new NetworkCaptureTool();
