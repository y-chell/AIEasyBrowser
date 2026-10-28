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
  jest.restoreAllMocks();
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
  test('rejects writes and probes while another owner holds the log lock', () => {
    const target = getLogFilePath();
    fs.writeFileSync(target, 'EVIDENCE');
    fs.writeFileSync(target + '.lock', 'OTHER_OWNER');
    expect(logger.info({ event: 'test.locked' })?.message).toContain('log lock busy');
    expect(probeLogWritable()).toMatchObject({
      ok: false,
      error: expect.stringContaining('log lock busy'),
    });
    expect(fs.readFileSync(target, 'utf8')).toBe('EVIDENCE');
    expect(fs.readFileSync(target + '.lock', 'utf8')).toBe('OTHER_OWNER');
    fs.unlinkSync(target + '.lock');
    expect(probeLogWritable().ok).toBe(true);
    expect(logger.info({ event: 'test.unlocked' })).toBeUndefined();
    expect(fs.readFileSync(target, 'utf8')).toContain('test.unlocked');
    expect(fs.existsSync(target + '.lock')).toBe(false);
  });

  test('holds the same lock throughout probe rename and rotation', () => {
    const target = getLogFilePath();
    fs.writeFileSync(target, 'x'.repeat(MAX_LOG_BYTES));
    const rename = fs.renameSync.bind(fs);
    let probed = false;
    let rotated = false;
    jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      expect(fs.existsSync(target + '.lock')).toBe(true);
      if (String(to).includes('.rename-probe-')) {
        probed = true;
        expect(logger.info({ event: 'test.contender' })?.message).toContain('log lock busy');
      }
      if (String(to).includes('.rotate-')) {
        rotated = true;
        expect(probeLogWritable().ok).toBe(false);
      }
      return rename(from, to);
    });
    expect(probeLogWritable().ok).toBe(true);
    expect(logger.info({ event: 'test.rotation' })).toBeUndefined();
    expect(probed).toBe(true);
    expect(rotated).toBe(true);
    expect(fs.existsSync(target + '.lock')).toBe(false);
  });

  test('reports lock initialization failure and releases its own lock', () => {
    const write = fs.writeFileSync.bind(fs);
    jest.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
      if (typeof file === 'number') throw new Error('lock metadata denied');
      return write(file, data, options);
    });
    expect(logger.info({ event: 'test.lock' })?.message).toContain('lock metadata denied');
    expect(fs.existsSync(getLogFilePath() + '.lock')).toBe(false);
    expect(fs.existsSync(getLogFilePath())).toBe(false);
  });

  test('reports lock release failure together with the primary probe failure', () => {
    fs.writeFileSync(getLogFilePath(), 'EVIDENCE');
    jest.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('rename denied');
    });
    jest.spyOn(fs, 'unlinkSync').mockImplementation(() => {
      throw new Error('unlock denied');
    });
    const result = probeLogWritable();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('rename denied');
    expect(result.error).toContain('unlock denied');
    expect(fs.existsSync(getLogFilePath() + '.lock')).toBe(true);
  });

  test('reports lock close failure even when a record was appended', () => {
    const close = fs.closeSync.bind(fs);
    let lockDescriptor: number;
    const open = fs.openSync.bind(fs);
    jest.spyOn(fs, 'openSync').mockImplementation((file, flags, mode) => {
      const descriptor = open(file, flags, mode);
      if (String(file).endsWith('.lock')) lockDescriptor = descriptor;
      return descriptor;
    });
    jest.spyOn(fs, 'closeSync').mockImplementation((descriptor) => {
      close(descriptor);
      if (descriptor === lockDescriptor) throw new Error('close denied');
    });
    expect(logger.info({ event: 'test.lock' })?.message).toContain('cannot close log lock');
    expect(readRecords()).toHaveLength(1);
  });

  test('does not append after an active log stat permission failure', () => {
    const target = getLogFilePath();
    const stat = fs.statSync.bind(fs);
    fs.writeFileSync(target, 'EVIDENCE');
    jest.spyOn(fs, 'statSync').mockImplementation(((file: fs.PathLike) => {
      if (String(file) === target)
        throw Object.assign(new Error('stat denied'), { code: 'EACCES' });
      return stat(file);
    }) as typeof fs.statSync);
    expect(logger.info({ event: 'test.stat' })?.message).toContain('cannot inspect active log');
    expect(fs.readFileSync(target, 'utf8')).toBe('EVIDENCE');
    expect(fs.existsSync(target + '.lock')).toBe(false);
  });

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

  test('preserves all archives when a later rotation move fails', () => {
    const target = path.join(fixtureDir, LOG_FILE_NAME);
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.writeFileSync(target, 'x'.repeat(MAX_LOG_BYTES - 1), 'utf8');
    fs.writeFileSync(target + '.3', 'OLD3', 'utf8');
    fs.writeFileSync(target + '.4', 'OLD4', 'utf8');
    fs.writeFileSync(target + '.5', 'OLD5', 'utf8');
    const originalRename = fs.renameSync.bind(fs);
    let failMove = true;
    jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (failMove && String(from).includes('.rotate-') && String(to).endsWith('.4')) {
        failMove = false;
        const error = new Error('EACCES: permission denied, rename');
        (error as NodeJS.ErrnoException).code = 'EACCES';
        throw error;
      }
      return originalRename(from, to);
    });

    const failure = logger.info({ event: 'command.start', tool: 'health' });

    expect(failure).toBeInstanceOf(Error);
    expect(fs.readFileSync(target + '.3', 'utf8')).toBe('OLD3');
    expect(fs.readFileSync(target + '.4', 'utf8')).toBe('OLD4');
    expect(fs.readFileSync(target + '.5', 'utf8')).toBe('OLD5');
    expect(fs.statSync(target).size).toBe(MAX_LOG_BYTES - 1);
  });

  test('restores the live path when the rename probe cannot rename back', () => {
    const target = path.join(fixtureDir, LOG_FILE_NAME);
    const originalContent = 'existing log evidence\n';
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.writeFileSync(target, originalContent, 'utf8');
    const originalRename = fs.renameSync.bind(fs);
    jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from).includes('.rename-probe-') && String(to) === target) {
        const error = new Error('EACCES: permission denied, rename back');
        (error as NodeJS.ErrnoException).code = 'EACCES';
        throw error;
      }
      return originalRename(from, to);
    });

    const probe = probeLogWritable();

    expect(probe.ok).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe(originalContent);
  });

  test('reports where evidence remains if both probe restore operations fail', () => {
    const target = getLogFilePath();
    fs.writeFileSync(target, 'EVIDENCE');
    const rename = fs.renameSync.bind(fs);
    jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from).includes('.rename-probe-')) throw new Error('restore denied');
      return rename(from, to);
    });
    jest.spyOn(fs, 'copyFileSync').mockImplementation(() => {
      throw new Error('copy denied');
    });
    const result = probeLogWritable();
    const remaining = fs.readdirSync(fixtureDir).find((name) => name.includes('.rename-probe-'));
    expect(remaining).toBeDefined();
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toContain(path.join(fixtureDir, remaining!));
    expect(result.error).toContain('copy denied');
    expect(fs.readFileSync(path.join(fixtureDir, remaining!), 'utf8')).toBe('EVIDENCE');
  });

  test('reports cleanup failure together with the original probe failure', () => {
    fs.writeFileSync(getLogFilePath(), 'EVIDENCE');
    jest.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('rename denied');
    });
    const rm = fs.rmSync.bind(fs);
    jest.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
      if (String(target).includes('.write-probe-')) throw new Error('cleanup denied');
      return rm(target, options);
    });
    const result = probeLogWritable();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('rename denied');
    expect(result.error).toContain('cleanup denied');
  });

  test('reports a rotation backup cleanup failure without deleting its evidence', () => {
    const target = getLogFilePath();
    fs.writeFileSync(target, 'x'.repeat(MAX_LOG_BYTES));
    fs.writeFileSync(target + '.5', 'OLDEST');
    const rm = fs.rmSync.bind(fs);
    jest.spyOn(fs, 'rmSync').mockImplementation((file, options) => {
      if (String(file).includes('.bak-')) throw new Error('backup cleanup denied');
      return rm(file, options);
    });
    const error = logger.info({ event: 'test.rotation' });
    expect(error?.message).toContain('log rotation cleanup failed');
    const backup = fs.readdirSync(fixtureDir).find((name) => name.includes('.bak-'));
    expect(backup).toBeDefined();
    expect(fs.readFileSync(path.join(fixtureDir, backup!), 'utf8')).toBe('OLDEST');
  });

  test('probeLogWritable fails when a real archive cannot be renamed', () => {
    const target = path.join(fixtureDir, LOG_FILE_NAME);
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.writeFileSync(target, 'live\n', 'utf8');
    fs.writeFileSync(`${target}.4`, 'archive four\n', 'utf8');
    const originalRename = fs.renameSync.bind(fs);
    jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from).endsWith('.4')) {
        const error = new Error('EACCES: permission denied, rename');
        (error as NodeJS.ErrnoException).code = 'EACCES';
        throw error;
      }
      return originalRename(from, to);
    });

    const probe = probeLogWritable();

    expect(probe.ok).toBe(false);
    expect(String(probe.error)).toContain('cannot rename');
  });

  test('keeps existing archives when a rotation move fails', () => {
    const target = path.join(fixtureDir, LOG_FILE_NAME);
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.writeFileSync(target, 'x'.repeat(MAX_LOG_BYTES - 1), 'utf8');
    fs.writeFileSync(`${target}.4`, 'OLD4', 'utf8');
    fs.writeFileSync(`${target}.5`, 'OLD5', 'utf8');
    const originalRename = fs.renameSync.bind(fs);
    jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from).includes('.rotate-') && String(to).endsWith('.5')) {
        const error = new Error('EACCES: permission denied, rename');
        (error as NodeJS.ErrnoException).code = 'EACCES';
        throw error;
      }
      return originalRename(from, to);
    });

    const failure = logger.info({ event: 'command.start', tool: 'health' });

    expect(failure).toBeInstanceOf(Error);
    expect(fs.readFileSync(`${target}.4`, 'utf8')).toBe('OLD4');
    expect(fs.readFileSync(`${target}.5`, 'utf8')).toBe('OLD5');
  });

  test('probeLogWritable returns an error instead of throwing when cleanup fails', () => {
    const originalRm = fs.rmSync.bind(fs);
    jest.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
      if (String(target).includes('.write-probe-')) {
        throw new Error('EBUSY: resource busy, unlink');
      }
      return originalRm(target, options);
    });

    const probe = probeLogWritable();

    expect(probe.ok).toBe(false);
    expect(String(probe.error)).toContain('probe cleanup failed');
  });

  test('does not overwrite or delete a colliding write-probe path', () => {
    const originalOpen = fs.openSync.bind(fs);
    const originalWrite = fs.writeFileSync.bind(fs);
    let collisionPath: string | undefined;
    jest.spyOn(fs, 'openSync').mockImplementation((target, flags, mode) => {
      if (!collisionPath && String(target).includes('.write-probe-') && flags === 'wx') {
        collisionPath = String(target);
        originalWrite(collisionPath, 'KEEP', 'utf8');
      }
      return originalOpen(target, flags, mode);
    });

    const probe = probeLogWritable();

    expect(probe.ok).toBe(false);
    expect(collisionPath).toBeDefined();
    expect(fs.readFileSync(collisionPath!, 'utf8')).toBe('KEEP');
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
