import { describe, expect, jest, test } from '@jest/globals';
import path from 'node:path';
import fs from 'node:fs';

const regression = require('./cli-regression.cjs') as {
  cleanupTargets: (
    run: (session: string, args: string[], options?: { timeoutMs?: number }) => any,
    sessionNames: string[],
    urls: string[],
  ) => string[];
  createFixtureServer: (runId: string) => Promise<{
    close: () => Promise<void>;
    origin: string;
    waitForSignal: (name: string) => Promise<void>;
  }>;
  readLogRecords: (file: string) => Array<Record<string, unknown>>;
  testAdvancedInputContract: (
    run: (session: string, args: string[]) => any,
    task: string,
    logPath: string,
  ) => unknown;
  testHttpsCopy: (
    run: (...args: any[]) => any,
    session: string,
    runId: string,
    urls: string[],
    tabIds: number[],
  ) => Promise<unknown>;
  parseCliRun: (
    run: {
      stdout: string;
      error?: Error;
      status?: number | null;
      signal?: string | null;
      stderr?: string;
    },
    label: string,
  ) => unknown;
  runProcess: (
    executable: string,
    args: string[],
    label: string,
    options?: { timeoutMs?: number },
  ) => { status: number | null; response: any; stdout: string; stderr: string };
  runWithCleanup: <T>(work: () => Promise<T>, cleanup: () => Promise<void>) => Promise<T>;
};

describe('CLI-only regression harness', () => {
  test('requires invalid advanced calls to fail before dispatch, and checks free CDP params positively', () => {
    const snapshot = 'task-id.1';
    let leaked = false;
    let wrongSuccess = false;
    let records = '';
    jest.spyOn(fs, 'existsSync').mockImplementation((file) => String(file) === 'fixture-log');
    jest.spyOn(fs, 'readFileSync').mockImplementation(() => records);
    const run = (_session: string, args: string[]) => {
      if (args[0] === 'session') return { status: 0, response: { ok: true, result: { snapshot } } };
      if (args[0] === 'describe') return { status: 0, response: { ok: true, result: {} } };
      if (args[1] === 'chrome_cdp_command')
        return {
          status: 0,
          response: {
            ok: true,
            result: { result: { result: { value: { fixture: 'P3', values: [0, false] } } } },
          },
        };
      if (leaked)
        records = JSON.stringify({
          event: 'tool.start',
          session: 'task-id',
          nativeRequestId: 'leaked',
        });
      const pointers: Record<string, string> = {
        chrome_javascript: 'args/code',
        chrome_switch_tab: 'args/tabId',
        chrome_screenshot: 'args/savePng',
        chrome_clipboard: 'args/action',
        chrome_wait_for: 'args/condition/extra',
        chrome_cdp_batch: 'args/commands/0/method',
        chrome_fill_or_select: 'args/value',
      };
      return {
        status: wrongSuccess ? 0 : 2,
        response: {
          ok: wrongSuccess,
          error: { code: 'INVALID_ARGUMENT', message: pointers[args[1]] },
          actionStatus: 'not_started',
          completed: 0,
        },
      };
    };
    try {
      expect(regression.testAdvancedInputContract(run, 'task', 'fixture-log')).toEqual({
        rejectedBeforeDispatch: 7,
        freeCdpParams: true,
      });
      leaked = true;
      expect(() => regression.testAdvancedInputContract(run, 'task', 'fixture-log')).toThrow(
        'reached Native Messaging',
      );
      leaked = false;
      wrongSuccess = true;
      expect(() => regression.testAdvancedInputContract(run, 'task', 'fixture-log')).toThrow(
        'non-zero exit status',
      );
    } finally {
      jest.restoreAllMocks();
    }
  });

  test('requires observed HTTPS CSP enforcement, not merely a successful eval response', async () => {
    const evidence = {
      origin: 'https://github.com',
      secure: true,
      inlineBlocked: true,
      directive: 'script-src-elem',
    };
    const run = (_session: string, args: string[]) => ({
      status: 0,
      response: {
        ok: true,
        result:
          args[0] === 'open'
            ? { tabId: 42 }
            : args[0] === 'eval'
              ? { result: JSON.stringify(evidence) }
              : {},
      },
    });
    const urls: string[] = [];
    const tabIds: number[] = [];
    await expect(regression.testHttpsCopy(run, 'task', 'unique', urls, tabIds)).resolves.toEqual(
      evidence,
    );
    expect(urls).toEqual(['https://github.com/?aieasybrowser-regression=unique']);
    expect(tabIds).toEqual([42]);
    evidence.inlineBlocked = false;
    await expect(regression.testHttpsCopy(run, 'task', 'unique', [], [])).rejects.toThrow(
      'did not demonstrate enforced',
    );
  });

  test('serves a positive fixture and rejects unknown fixture routes', async () => {
    const fixture = await regression.createFixtureServer('run-fixture-1');
    try {
      const page = await fetch(fixture.origin + '/?tag=A');
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('Regression A');
      expect(html).toContain('run-fixture-1');
      expect(html).toContain('window.__clickCount += 1');

      const missing = await fetch(fixture.origin + '/missing');
      expect(missing.status).toBe(404);
      const long = await fetch(fixture.origin + '/long?tag=A&record=fixture');
      expect(await long.text()).toContain('window.__replaceTarget');
      const frame = await fetch(fixture.origin + '/long-frame');
      expect(await frame.text()).toContain('event.isTrusted');
      expect((await fetch(fixture.origin + '/long', { method: 'POST' })).status).toBe(404);
      const observed = fixture.waitForSignal('timeout-start');
      expect((await fetch(fixture.origin + '/signal?name=timeout-start')).status).toBe(204);
      await observed;
      await fixture.waitForSignal('timeout-start');
      expect((await fetch(fixture.origin + '/signal?name=invalid')).status).toBe(400);
      jest.useFakeTimers();
      const absent = expect(fixture.waitForSignal('disconnect-start')).rejects.toThrow(
        'fixture signal not observed',
      );
      jest.advanceTimersByTime(15000);
      await absent;
    } finally {
      jest.useRealTimers();
      await fixture.close();
    }
  });

  test('reads live and rotated diagnostic records, rejecting malformed evidence', () => {
    const live = path.resolve('fixture-log');
    jest
      .spyOn(fs, 'existsSync')
      .mockImplementation((file) => [live, live + '.1'].includes(String(file)));
    const read = jest
      .spyOn(fs, 'readFileSync')
      .mockImplementation((file) =>
        String(file) === live ? '{"event":"new"}\n' : '{"event":"old"}\n',
      );
    try {
      expect(regression.readLogRecords(live)).toEqual([{ event: 'new' }, { event: 'old' }]);
      read.mockReturnValueOnce('not-json');
      expect(() => regression.readLogRecords(live)).toThrow();
    } finally {
      jest.restoreAllMocks();
    }
  });

  test('parses valid CLI JSON and rejects malformed process output', () => {
    expect(regression.parseCliRun({ stdout: '{"ok":true}' }, 'valid fixture')).toEqual({
      ok: true,
    });
    expect(() => regression.parseCliRun({ stdout: 'not-json' }, 'invalid fixture')).toThrow(
      'did not print one JSON response',
    );
    expect(() =>
      regression.parseCliRun({ stdout: '', status: 1, stderr: 'child failure' }, 'empty fixture'),
    ).toThrow('status=1; signal=undefined; stderr=child failure');
  });

  test('keeps CLI JSON on non-zero exit and rejects invalid JSON from a child process', () => {
    const fixture = path.join(__dirname, '__fixtures__', 'cli-process-result.cjs');
    const success = regression.runProcess(
      process.execPath,
      [fixture, 'success'],
      'success fixture',
    );
    expect(success.status).toBe(0);
    expect(success.response).toMatchObject({ ok: true, result: { fixture: true } });

    const failure = regression.runProcess(
      process.execPath,
      [fixture, 'failure'],
      'failure fixture',
    );
    expect(failure.status).toBe(3);
    expect(failure.response).toMatchObject({ ok: false, error: { code: 'FIXTURE_FAILURE' } });

    expect(() =>
      regression.runProcess(process.execPath, [fixture, 'invalid-json'], 'invalid JSON fixture'),
    ).toThrow('did not print one JSON response');
  });

  test('runs cleanup after an assertion failure', async () => {
    const cleanup = jest.fn(async () => undefined);
    await expect(
      regression.runWithCleanup(async () => {
        throw new Error('fixture assertion failure');
      }, cleanup),
    ).rejects.toThrow('fixture assertion failure');
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  test('reports cleanup failure, including when the main assertion already failed', async () => {
    const cleanupFailure = new Error('fixture cleanup failure');
    await expect(
      regression.runWithCleanup(
        async () => undefined,
        async () => {
          throw cleanupFailure;
        },
      ),
    ).rejects.toThrow('fixture cleanup failure');
    await expect(
      regression.runWithCleanup(
        async () => {
          throw new Error('fixture assertion failure');
        },
        async () => {
          throw cleanupFailure;
        },
      ),
    ).rejects.toThrow('cleanup also failed');
  });

  test('attempts every close and session cleanup, reporting failures instead of swallowing them', () => {
    const calls: Array<{ session: string; args: string[] }> = [];
    const run = (session: string, args: string[]) => {
      calls.push({ session, args });
      const failed = args[0] === 'call';
      const tabs =
        calls.length === 1
          ? [
              { tabId: 7, url: 'http://127.0.0.1/?run=tab-a' },
              { tabId: 8, url: 'http://127.0.0.1/?run=tab-b' },
              { tabId: 99, url: 'https://unrelated.invalid/' },
            ]
          : [];
      return {
        status: failed ? 1 : 0,
        response: { ok: !failed, result: args[1] === '--list' ? [] : { tabs } },
        stdout: failed ? 'close failure' : '{"ok":true}',
      };
    };

    const errors = regression.cleanupTargets(
      run,
      ['task-a', 'task-b'],
      ['http://127.0.0.1/?run=tab-a', 'http://127.0.0.1/?run=tab-b'],
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('close created fixture tabs');
    expect(JSON.parse(calls[1].args[2])).toEqual({ tabIds: [7, 8] });
    expect(calls).toHaveLength(7);
    expect(calls.slice(3, 6).map((call) => call.args)).toEqual([
      ['session', '--forget'],
      ['session', '--forget'],
      ['session', '--forget'],
    ]);
  });
});
