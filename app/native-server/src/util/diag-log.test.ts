import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LOG_FILE_NAME,
  MAX_LOG_BYTES,
  getLogFilePath,
  log,
  logger,
  probeLogWritable,
  sanitizeText,
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

  test('does not record arbitrary request or response bodies', () => {
    // Only declared fields survive; a smuggled payload is dropped rather than logged.
    logger.info({
      event: 'tool.start',
      tool: 'chrome_fill_or_select',
      // @ts-expect-error deliberately passing an undeclared field
      args: { value: 'secret-form-value', tabId: 7 },
      // @ts-expect-error deliberately passing an undeclared field
      response: { text: 'page body' },
    } as never);

    const [record] = readRecords();
    expect(record).not.toHaveProperty('args');
    expect(record).not.toHaveProperty('response');
    expect(JSON.stringify(record)).not.toContain('secret-form-value');
    expect(JSON.stringify(record)).not.toContain('page body');
  });

  test('scrubs credential-shaped text from error fields', () => {
    logger.error({
      event: 'tool.failed',
      error:
        'request failed Authorization: Bearer abc123.def456 while posting {"password":"hunter2"} access_token=sk-live-999',
    });

    const [record] = readRecords();
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain('abc123.def456');
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('sk-live-999');
    expect(record.error).toContain('[redacted]');
  });

  test('truncates long error text instead of writing unbounded content', () => {
    logger.error({ event: 'tool.failed', error: 'x'.repeat(2000) });
    const [record] = readRecords();
    expect(String(record.error).length).toBeLessThanOrEqual(401);
    expect(String(record.error).endsWith('…')).toBe(true);
  });
});

describe('log failure handling', () => {
  test('returns the error when the directory cannot be written', () => {
    // Occupy the log path with a directory so the append must fail.
    fs.rmSync(fixtureDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(fixtureDir, LOG_FILE_NAME), { recursive: true });

    const failure = log('error', { event: 'command.failed', error: 'boom' });
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

  test('rotation keeps the newest records in the live file', () => {
    const target = path.join(fixtureDir, LOG_FILE_NAME);
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.writeFileSync(target, '{"pad":"' + 'x'.repeat(MAX_LOG_BYTES) + '"}\n', 'utf8');

    logger.info({ event: 'command.start', tool: 'health' });

    expect(fs.existsSync(`${target}.1`)).toBe(true);
    const live = readRecords();
    expect(live).toHaveLength(1);
    expect(live[0].event).toBe('command.start');
  });
});

describe('sanitizeText', () => {
  test('keeps ordinary diagnostics readable', () => {
    expect(sanitizeText('Request timed out after 30000ms')).toBe('Request timed out after 30000ms');
  });

  test('collapses newlines so one record stays one line', () => {
    expect(sanitizeText('line one\nline two\r\nline three')).toBe('line one line two line three');
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
