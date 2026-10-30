/**
 * Chrome allows one Tracing session in the whole browser (Chrome 156: a second Tracing.start, in
 * the same or another tab, fails with "Tracing has already been started (possibly in another
 * tab)"). performance_start_trace and chrome_cdp_profile cpuStart both claim this lock first, so
 * they fail with TRACE_BUSY naming the holder instead of with Chrome's message.
 */

export interface TracingHolder {
  tabId: number;
  tool: 'performance_start_trace' | 'chrome_cdp_profile';
}

let holder: TracingHolder | undefined;

export function claimTracing(next: TracingHolder): void {
  if (holder) {
    throw new Error(
      `TRACE_BUSY: ${holder.tool} is tracing tab ${holder.tabId}; Chrome runs one trace at a time`,
    );
  }
  holder = next;
}

export function releaseTracing(tabId: number, tool: TracingHolder['tool']): void {
  if (holder?.tabId === tabId && holder.tool === tool) holder = undefined;
}

/** Chrome's own refusal (a trace started outside AEB) mapped to the same code. */
export function tracingError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return /already been started/i.test(message)
    ? new Error(`TRACE_BUSY: ${message}`)
    : error instanceof Error
      ? error
      : new Error(message);
}

export function resetTracingLockForTest(): void {
  holder = undefined;
}
