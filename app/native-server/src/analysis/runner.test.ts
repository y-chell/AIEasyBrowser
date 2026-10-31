import { describe, expect, test } from '@jest/globals';
import path from 'node:path';
import { runInWorker } from './runner';

const WORKER = path.join(__dirname, '__fixtures__', 'runner-worker.cjs');
const job = (kind: string) => ({ kind, text: 'x' }) as any;
const signal = () => new AbortController().signal;

describe('runInWorker', () => {
  test('resolves the worker value', async () => {
    await expect(runInWorker(job('ok'), signal(), WORKER)).resolves.toEqual({ echo: 'x' });
  });

  test('turns worker failures into AnalysisError codes', async () => {
    await expect(runInWorker(job('fail'), signal(), WORKER)).rejects.toMatchObject({
      code: 'PARSE_FAILED',
      message: 'PARSE_FAILED: bad',
    });
    await expect(runInWorker(job('throw'), signal(), WORKER)).rejects.toThrow(
      /^ANALYSIS_FAILED: analysis worker failed: worker blew up$/,
    );
    await expect(runInWorker(job('exit'), signal(), WORKER)).rejects.toThrow(
      /^ANALYSIS_FAILED: analysis worker exited with code 3$/,
    );
  });

  test('terminates a running worker on abort and rejects with the abort reason', async () => {
    const controller = new AbortController();
    const pending = runInWorker(job('hang'), controller.signal, WORKER);
    const reason = new Error('timed out');
    setTimeout(() => controller.abort(reason), 50);
    await expect(pending).rejects.toBe(reason);
  });

  test('does not start a worker for an already aborted signal', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(runInWorker(job('ok'), controller.signal, '/missing/worker.js')).rejects.toThrow(
      'cancelled',
    );
  });
});
