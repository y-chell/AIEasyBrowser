import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LOG_FILE_NAME,
  MAX_LOG_BYTES,
  MAX_LOG_FILES,
  getLogFilePath,
  log,
  logger,
  probeLogWritable,
  setLogDirForTests,
  startTimer,
} from './diag-log';

let fixtureDir: string;

beforeEach(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aieasybrowser-log-'));
  setLogDirForTests(fixtureDir);
});

afterEach(() => {
  setLogDirForTests(undefined);
  expect(path.dirname(path.resolve(fixtureDir))).toBe(path.resolve(os.tmpdir()));
  expect(path.basename(fixtureDir)).toMatch(/^aieasybrowser-log-/);
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

function readRecords(): Array<Record<string, unknown>> {
  const target = path.join(fixtureDir, LOG_FILE_NAME);
  if (!fs.existsSync(target)) return [];
  return fs
    .readFileSync(target, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('diagnostic log records', () => {
  test('writes one JSON line per event with the whitelisted fields', () => {
    expect(
      logger.info({
        event: 'command.done',
        requestId: 'req-1',
        session: 'research',
        tool: 'scan',
        tabId: 42,
        frameId: 0,
        phase: 'scan',
        actionStatus: 'completed',
        completed: 2,
        durationMs: 12.7,
        status: 200,
        timeoutMs: 60000,
      }),
    ).toBeUndefined();

    const records = readRecords();
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record).toMatchObject({
      level: 'info',
      event: 'command.done',
      requestId: 'req-1',
      session: 'research',
      tool: 'scan',
      tabId: 42,
      frameId: 0,
      phase: 'scan',
      actionStatus: 'completed',
      completed: 2,
      durationMs: 13,
      status: 200,
      timeoutMs: 60000,
      pid: process.pid,
    });
    expect(typeof record.ts).toBe('string');
  });

  test('appends without truncating earlier records', () => {
    logger.info({ event: 'command.start', tool: 'health' });
    logger.error({ event: 'command.failed', tool: 'scan', code: 'TIMEOUT' });
    const records = readRecords();
    expect(records.map((record) => record.event)).toEqual(['command.start', 'command.failed']);
    expect(records[1].level).toBe('error');
    expect(records[1].code).toBe('TIMEOUT');
  });

  test('has no free-text field: page, form and clipboard content cannot be logged', () => {
    // The API only accepts declared fields. A caller that tries to smuggle page or
    // form content has nowhere to put it; anything shaped like prose is rejected by
    // the token grammar rather than written.
    logger.info({
      event: 'tool.start',
      tool: 'chrome_fill_or_select',
      // @ts-expect-error deliberately passing undeclared fields
      error: 'rejected form value FORM_VALUE_FIXTURE; clipboard text CLIPBOARD_VALUE_FIXTURE',
      // @ts-expect-error deliberately passing undeclared fields
      extra: { clipboard: 'EXTRA_CLIPBOARD_FIXTURE', token: 'EXTRA_TOKEN_FIXTURE' },
      // @ts-expect-error deliberately passing undeclared fields
      message: 'page body PAGE_BODY_FIXTURE',
    } as never);

    const raw = fs.readFileSync(path.join(fixtureDir, LOG_FILE_NAME), 'utf8');
    expect(raw).not.toContain('FORM_VALUE_FIXTURE');
    expect(raw).not.toContain('CLIPBOARD_VALUE_FIXTURE');
    expect(raw).not.toContain('EXTRA_CLIPBOARD_FIXTURE');
    expect(raw).not.toContain('EXTRA_TOKEN_FIXTURE');
    expect(raw).not.toContain('PAGE_BODY_FIXTURE');
  });

  test('rejects prose in declared string fields instead of writing it', () => {
    logger.info({
      event: 'tool.start',
      tool: 'chrome_click_element target=secret-form-value',
      session: 'session with spaces and 中文',
      code: 'Error: clipboard CLIPBOARD_VALUE_FIXTURE',
    });

    const [record] = readRecords();
    expect(record.tool).toBe('invalid');
    expect(record.session).toBe('invalid');
    expect(record.code).toBe('invalid');
    expect(JSON.stringify(record)).not.toContain('CLIPBOARD_VALUE_FIXTURE');
    expect(JSON.stringify(record)).not.toContain('secret-form-value');
  });
});

describe('log failure handling', () => {
  test('returns the error when the directory cannot be written', () => {
    // Occupy the log path with a directory so the append must fail.
    fs.rmSync(fixtureDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(fixtureDir, LOG_FILE_NAME), { recursive: true });

    const failure = log('error', { event: 'command.failed', code: 'BROWSER_ERROR' });
    expect(failure).toBeInstanceOf(Error);
    expect(getLogFilePath()).toBe(path.join(fixtureDir, LOG_FILE_NAME));
  });

  test('probeLogWritable reports the real target and its failure', () => {
    const healthy = probeLogWritable();
    expect(healthy.ok).toBe(true);
    expect(healthy.path).toBe(path.join(fixtureDir, LOG_FILE_NAME));

    fs.rmSync(fixtureDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(fixtureDir, LOG_FILE_NAME), { recursive: true });
    const broken = probeLogWritable();
    expect(broken.ok).toBe(false);
    expect(typeof broken.error).toBe('string');
  });

  test('rotates at the size limit and keeps the newest record live', () => {
    const target = path.join(fixtureDir, LOG_FILE_NAME);
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.writeFileSync(target, 'x'.repeat(MAX_LOG_BYTES), 'utf8');

    logger.info({ event: 'command.start', tool: 'health' });

    expect(fs.existsSync(`${target}.1`)).toBe(true);
    const live = readRecords();
    expect(live).toHaveLength(1);
    expect(live[0].event).toBe('command.start');
  });

  test('rotates when the next record would cross the limit', () => {
    const target = path.join(fixtureDir, LOG_FILE_NAME);
    fs.mkdirSync(fixtureDir, { recursive: true });
    // One byte of headroom is not enough for a full record.
    fs.writeFileSync(target, 'x'.repeat(MAX_LOG_BYTES - 1), 'utf8');

    logger.info({ event: 'command.start', tool: 'health' });

    expect(fs.existsSync(`${target}.1`)).toBe(true);
    expect(fs.statSync(target).size).toBeLessThan(1024);
  });

  test('probeLogWritable fails when rotation rename is denied', () => {
    jest.spyOn(fs, 'renameSync').mockImplementation(() => {
      const error = new Error('EACCES: permission denied, rename');
      (error as NodeJS.ErrnoException).code = 'EACCES';
      throw error;
    });

    const probe = probeLogWritable();

    expect(probe.ok).toBe(false);
    expect(String(probe.error)).toContain('rotation failed');
  });

  test('never exceeds the size limit when rotation is blocked', () => {
    const target = path.join(fixtureDir, LOG_FILE_NAME);
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.writeFileSync(target, 'x'.repeat(MAX_LOG_BYTES), 'utf8');
    // Squat on every archive slot with directories.
    for (let index = 1; index <= MAX_LOG_FILES; index += 1) {
      fs.mkdirSync(`${target}.${index}`, { recursive: true });
    }

    const failure = logger.info({ event: 'command.start', tool: 'health' });

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure?.message)).toContain('rotation blocked');
    expect(fs.statSync(target).size).toBe(MAX_LOG_BYTES);
  });

  test('probeLogWritable rejects a blocked rotation slot', () => {
    const target = path.join(fixtureDir, LOG_FILE_NAME);
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.mkdirSync(`${target}.2`, { recursive: true });

    const probe = probeLogWritable();
    expect(probe.ok).toBe(false);
    expect(String(probe.error)).toContain('rotation slot');
  });
});

describe('startTimer', () => {
  test('returns a positive elapsed time', () => {
    const elapsed = startTimer();
    const value = elapsed();
    expect(value).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(value)).toBe(true);
  });
});
