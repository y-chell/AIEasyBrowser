import type { ToolResult } from '@/common/tool-handler';
import type { NativeToolProgress } from 'aieasybrowser-shared';

export interface BrowserToolCallContext {
  sessionId?: string;
  requestId?: string;
  transport?: string;
  nativeRequestId?: string;
  documentId?: string;
}

export interface BrowserToolExecutionContext {
  signal?: AbortSignal;
  reportProgress?: (progress: NativeToolProgress) => void | Promise<void>;
  documentId?: string;
  strictTarget?: boolean;
}

const isolationQueues = new Map<string, Promise<void>>();

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function abortReason(signal: AbortSignal): Error {
  const message = signal.reason instanceof Error ? signal.reason.message : 'Tool call cancelled';
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

async function waitForCompletion<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}

async function enqueue<T>(key: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const previous = isolationQueues.get(key) || Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = previous.catch(() => undefined).then(() => gate);
  isolationQueues.set(key, current);
  void current.finally(() => {
    if (isolationQueues.get(key) === current) isolationQueues.delete(key);
  });
  try {
    await waitForCompletion(
      previous.catch(() => undefined),
      signal,
    );
    throwIfAborted(signal);
    return await fn();
  } finally {
    release();
  }
}

async function withQueues<T>(
  keys: string[],
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const uniqueKeys = Array.from(new Set(keys)).sort();
  let run = fn;
  for (const key of uniqueKeys.reverse()) {
    const next = run;
    run = () => enqueue(key, next, signal);
  }
  return run();
}

function getTargetQueueKeys(args: Record<string, any>): string[] {
  const keys: string[] = [];
  const tabId = asFiniteNumber(args.tabId);
  if (tabId !== undefined) keys.push(`tab:${tabId}`);
  if (Array.isArray(args.tabIds)) {
    for (const id of args.tabIds) {
      const value = asFiniteNumber(id);
      if (value !== undefined) keys.push(`tab:${value}`);
    }
  }
  const windowId = asFiniteNumber(args.windowId);
  if (windowId !== undefined) keys.push(`window:${windowId}`);
  return keys;
}

export async function runBrowserToolCallWithIsolation(
  rawArgs: any,
  context: BrowserToolCallContext | undefined,
  execute: (args: any, executionContext?: BrowserToolExecutionContext) => Promise<ToolResult>,
  executionContext?: BrowserToolExecutionContext,
): Promise<ToolResult> {
  const signal = executionContext?.signal;
  const sessionId = typeof context?.sessionId === 'string' ? context.sessionId.trim() : undefined;
  // The bridge owns tab/ref state. The extension only locks and validates explicit targets.
  const args = isPlainObject(rawArgs) ? { ...rawArgs } : {};
  const run = () =>
    withQueues(
      getTargetQueueKeys(args),
      async () => {
        throwIfAborted(signal);
        if (context?.transport === 'cli' && typeof args.tabId === 'number') {
          const tab = await chrome.tabs.get(args.tabId).catch(() => null);
          throwIfAborted(signal);
          if (!tab) throw new Error('TARGET_CLOSED: select an existing tab with use or open');
        }
        if (context?.documentId) {
          const frame = await chrome.webNavigation.getFrame({
            tabId: args.tabId,
            frameId: args.frameId ?? 0,
          });
          throwIfAborted(signal);
          if (!frame || frame.documentId !== context.documentId) {
            throw new Error('STALE_DOCUMENT: the page navigated or refreshed; scan again');
          }
        }
        const boundExecution =
          context?.transport === 'cli' || context?.documentId
            ? {
                ...executionContext,
                documentId: context.documentId,
                strictTarget: context.transport === 'cli',
              }
            : executionContext;
        const result = await execute(args, boundExecution);
        throwIfAborted(signal);
        return result;
      },
      signal,
    );
  // Cancellation frees the task queue, not the lock of an operation still running in Chrome.
  const waitForRun = () => {
    throwIfAborted(signal);
    return waitForCompletion(run(), signal);
  };
  return sessionId ? enqueue(`session:${sessionId}`, waitForRun, signal) : waitForRun();
}

export function clearBrowserToolQueues(): void {
  isolationQueues.clear();
}
