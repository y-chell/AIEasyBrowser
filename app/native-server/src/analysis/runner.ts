import path from 'path';
import { Worker } from 'worker_threads';
import type { AnalysisJob } from './compute';
import { AnalysisError } from './errors';

export type JobRunner = (job: AnalysisJob, signal: AbortSignal) => Promise<unknown>;

const DEFAULT_WORKER = path.join(__dirname, 'worker.js');

/**
 * Runs one job in a fresh worker thread so parsing a large bundle never blocks the bridge.
 * Abort terminates the thread; a crash (including out-of-memory) rejects with ANALYSIS_FAILED.
 */
export function runInWorker(
  job: AnalysisJob,
  signal: AbortSignal,
  workerPath = DEFAULT_WORKER,
): Promise<unknown> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath);
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      void worker.terminate();
      settle();
    };
    const onAbort = () => finish(() => reject(signal.reason));
    signal.addEventListener('abort', onAbort, { once: true });
    worker.once(
      'message',
      (message: { ok: boolean; value?: unknown; code?: string; detail?: string }) => {
        finish(() =>
          message.ok
            ? resolve(message.value)
            : reject(new AnalysisError(message.code ?? 'ANALYSIS_FAILED', message.detail ?? '')),
        );
      },
    );
    worker.once('error', (error) => {
      finish(() =>
        reject(new AnalysisError('ANALYSIS_FAILED', `analysis worker failed: ${error.message}`)),
      );
    });
    worker.once('exit', (code) => {
      finish(() =>
        reject(new AnalysisError('ANALYSIS_FAILED', `analysis worker exited with code ${code}`)),
      );
    });
    worker.postMessage(job);
  });
}
