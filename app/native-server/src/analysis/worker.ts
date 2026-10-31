import { parentPort } from 'worker_threads';
import { computeJob, type AnalysisJob } from './compute';
import { AnalysisError } from './errors';

// One job per worker: the runner terminates the thread on abort, so nothing is reused.
parentPort!.once('message', (job: AnalysisJob) => {
  try {
    parentPort!.postMessage({ ok: true, value: computeJob(job) });
  } catch (error) {
    if (error instanceof AnalysisError) {
      parentPort!.postMessage({ ok: false, code: error.code, detail: error.detail });
    } else {
      const message = error instanceof Error ? error.message : String(error);
      parentPort!.postMessage({ ok: false, code: 'ANALYSIS_FAILED', detail: message });
    }
  }
});
