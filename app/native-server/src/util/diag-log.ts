/**
 * Diagnostic logging for the native server.
 *
 * Security model: the log API has no free-text field. Callers can only submit the
 * fields listed in `LogFields`, and every string is validated against a narrow token
 * grammar before it is written. Error messages, page text, form values, clipboard
 * contents and tool result payloads therefore have no path into the log at all —
 * this does not rely on pattern-matching secrets out of arbitrary text.
 *
 * Writes are synchronous so a crash immediately after logging still leaves the
 * record on disk, and so exit handlers do not need to await anything.
 */

import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { getLogDir } from '../scripts/utils';

export const LOG_FILE_NAME = 'native-server.log';
export const MAX_LOG_BYTES = 5 * 1024 * 1024;
export const MAX_LOG_FILES = 5;

export type LogLevel = 'info' | 'warn' | 'error';

/**
 * Every field is either an internal identifier, an enum, a number, or a boolean.
 * There is deliberately no `error`/`message`/`extra` slot: external text cannot be
 * logged even by accident.
 */
export interface LogFields {
  /** Internal event name such as `command.start`. */
  event: string;
  /** Correlation id shared by a CLI command and every tool call it fans out to. */
  requestId?: string;
  session?: string;
  tool?: string;
  /** Native Messaging request id for the extension round trip. */
  nativeRequestId?: string;
  tabId?: number;
  frameId?: number;
  phase?: string;
  actionStatus?: string;
  completed?: number;
  durationMs?: number;
  /** Machine-readable outcome code such as TIMEOUT or TARGET_CLOSED. */
  code?: string;
  /** Error constructor name only, never an error message. */
  errorName?: string;
  status?: number;
  timeoutMs?: number;
  port?: number;
  count?: number;
  exitCode?: number;
  hasDocumentId?: boolean;
  signal?: string;
}

export interface LogRecord extends Record<string, unknown> {
  ts: string;
  level: LogLevel;
  pid: number;
}

/** Identifiers and enum values only: no whitespace, quotes, JSON, or page text. */
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

function token(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return TOKEN_PATTERN.test(value) ? value : 'invalid';
}

let logDirOverride: string | undefined;
let failureReported = false;

/** Point the logger at a fixture directory. Tests only. */
export function setLogDirForTests(dir: string | undefined): void {
  logDirOverride = dir;
  failureReported = false;
}

export function getActiveLogDir(): string {
  return logDirOverride ?? process.env.AIEASYBROWSER_LOG_DIR?.trim() ?? getLogDir();
}

export function getLogFilePath(): string {
  return path.join(getActiveLogDir(), LOG_FILE_NAME);
}

function rotationSlot(filePath: string, index: number): string {
  return `${filePath}.${index}`;
}

/** All cooperating writers and doctor probes must hold this cross-process lock. */
function withLogLock(filePath: string, action: () => Error | undefined): Error | undefined {
  const lockPath = filePath + '.lock';
  let descriptor: number | undefined;
  let failure: Error | undefined;
  const addFailure = (error: unknown, prefix = ''): void => {
    const detail = prefix + (error instanceof Error ? error.message : String(error));
    failure = new Error(failure ? failure.message + '; ' + detail : detail);
  };
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    try {
      descriptor = fs.openSync(lockPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        // Never steal by age: a paused writer may still own the live files.
        throw new Error(
          `log lock busy: ${lockPath}; retry after the owner finishes; if abandoned, verify the owner has exited before removing the lock`,
        );
      }
      throw error;
    }
    fs.writeFileSync(
      descriptor,
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }) + '\n',
      'utf8',
    );
    failure = action();
  } catch (error) {
    addFailure(error);
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch (error) {
        addFailure(error, `cannot close log lock ${lockPath}: `);
      }
      try {
        fs.unlinkSync(lockPath);
      } catch (error) {
        addFailure(error, `cannot release log lock ${lockPath}: `);
      }
    }
  }
  return failure;
}

let renameProbeCounter = 0;

function uniqueSiblingPath(filePath: string, purpose: string): string {
  let candidate: string;
  do {
    candidate =
      filePath +
      '.' +
      purpose +
      '-' +
      process.pid +
      '-' +
      renameProbeCounter++ +
      '-' +
      randomUUID();
  } while (fs.existsSync(candidate));
  return candidate;
}

/**
 * Rotate before the next append. `thresholdBytes` is the size at which rotation is
 * required; the writer passes the remaining space so a record that would cross the
 * cap triggers rotation first. Returns an error instead of proceeding when rotation
 * cannot be performed, so the caller never writes past MAX_LOG_BYTES.
 */
function rotateIfNeeded(filePath: string, thresholdBytes = MAX_LOG_BYTES): Error | undefined {
  let size: number;
  try {
    size = fs.statSync(filePath).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return new Error(`cannot inspect active log ${filePath}: ${String(error)}`);
  }
  if (size < thresholdBytes) return undefined;

  // Refuse to rotate when an archive slot is occupied by a non-regular file.
  for (let index = 1; index <= MAX_LOG_FILES; index += 1) {
    const slot = rotationSlot(filePath, index);
    try {
      if (!fs.statSync(slot).isFile()) {
        return new Error(`log rotation blocked: ${slot} is not a regular file`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return new Error(`log rotation blocked: cannot inspect ${slot}`);
      }
    }
  }

  const lastSlot = rotationSlot(filePath, MAX_LOG_FILES);
  const lastBackup = fs.existsSync(lastSlot) ? uniqueSiblingPath(lastSlot, 'bak') : undefined;
  if (lastBackup) {
    try {
      fs.renameSync(lastSlot, lastBackup);
    } catch (error) {
      return new Error(`log rotation failed: cannot preserve ${lastSlot}: ${String(error)}`);
    }
  }

  const moves = [
    { from: filePath, to: rotationSlot(filePath, 1) },
    ...Array.from({ length: MAX_LOG_FILES - 1 }, (_, index) => ({
      from: rotationSlot(filePath, index + 1),
      to: rotationSlot(filePath, index + 2),
    })),
  ].filter(({ from }) => fs.existsSync(from));
  const staged = moves.map((move) => ({
    ...move,
    temp: uniqueSiblingPath(move.from, 'rotate'),
    staged: false,
    committed: false,
  }));
  let failure: unknown;

  try {
    for (const move of staged) {
      fs.renameSync(move.from, move.temp);
      move.staged = true;
    }
    for (const move of staged) {
      fs.renameSync(move.temp, move.to);
      move.committed = true;
    }
  } catch (error) {
    failure = error;
  }

  if (failure) {
    const rollbackErrors: string[] = [];
    // First get committed destinations out of the way, then restore original slots.
    for (const move of [...staged].reverse()) {
      if (!move.committed) continue;
      try {
        fs.renameSync(move.to, move.temp);
        move.committed = false;
      } catch (error) {
        rollbackErrors.push(
          move.to + ': ' + (error instanceof Error ? error.message : String(error)),
        );
      }
    }
    if (rollbackErrors.length === 0) {
      for (const move of [...staged].reverse()) {
        if (!move.staged) continue;
        try {
          fs.renameSync(move.temp, move.from);
          move.staged = false;
        } catch (error) {
          rollbackErrors.push(
            move.from + ': ' + (error instanceof Error ? error.message : String(error)),
          );
        }
      }
    }
    if (lastBackup && !fs.existsSync(lastSlot)) {
      try {
        fs.renameSync(lastBackup, lastSlot);
      } catch (error) {
        rollbackErrors.push(
          lastSlot + ': ' + (error instanceof Error ? error.message : String(error)),
        );
      }
    }
    const detail = failure instanceof Error ? failure.message : String(failure);
    const rollbackDetail = rollbackErrors.length
      ? '; rollback incomplete: ' + rollbackErrors.join('; ')
      : '';
    return new Error('log rotation failed: ' + detail + rollbackDetail);
  }

  if (lastBackup) {
    try {
      fs.rmSync(lastBackup, { force: true });
    } catch (error) {
      return new Error(
        `log rotation cleanup failed; archive remains at ${lastBackup}: ${String(error)}`,
      );
    }
  }
  return undefined;
}

/**
 * Verify that an existing file can actually be renamed, which rotation requires.
 * Renames the real file to a sibling probe name and immediately restores it, so an
 * ACL or attribute that blocks rotation on that specific archive is detected here
 * rather than on the first write.
 */
function verifyPathRenameable(filePath: string): Error | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  const probe = uniqueSiblingPath(filePath, 'rename-probe');
  try {
    fs.renameSync(filePath, probe);
  } catch (error) {
    return new Error(
      `cannot rename ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    fs.renameSync(probe, filePath);
  } catch (error) {
    try {
      fs.copyFileSync(probe, filePath, fs.constants.COPYFILE_EXCL);
      fs.rmSync(probe);
    } catch (recoveryError) {
      return new Error(
        `cannot restore ${filePath} after rename probe: ${String(error)}; recovery failed: ${String(recoveryError)}; original retained at ${probe}`,
      );
    }
    return new Error(
      `cannot restore ${filePath} after rename probe: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return undefined;
}

/**
 * Write one record. Returns the error when the write failed so callers that must
 * surface the failure (startup, doctor) can act on it instead of silently losing logs.
 */
export function log(level: LogLevel, fields: LogFields): Error | undefined {
  const record: LogRecord = {
    ts: new Date().toISOString(),
    level,
    pid: process.pid,
    event: token(fields.event) ?? 'invalid',
  };
  const requestId = token(fields.requestId);
  if (requestId) record.requestId = requestId;
  const session = token(fields.session);
  if (session) record.session = session;
  const tool = token(fields.tool);
  if (tool) record.tool = tool;
  const nativeRequestId = token(fields.nativeRequestId);
  if (nativeRequestId) record.nativeRequestId = nativeRequestId;
  const phase = token(fields.phase);
  if (phase) record.phase = phase;
  const actionStatus = token(fields.actionStatus);
  if (actionStatus) record.actionStatus = actionStatus;
  const code = token(fields.code);
  if (code) record.code = code;
  const errorName = token(fields.errorName);
  if (errorName) record.errorName = errorName;
  const signal = token(fields.signal);
  if (signal) record.signal = signal;
  if (typeof fields.tabId === 'number' && Number.isFinite(fields.tabId))
    record.tabId = fields.tabId;
  if (typeof fields.frameId === 'number' && Number.isFinite(fields.frameId))
    record.frameId = fields.frameId;
  if (typeof fields.completed === 'number') record.completed = fields.completed;
  if (typeof fields.durationMs === 'number') record.durationMs = Math.round(fields.durationMs);
  if (typeof fields.status === 'number') record.status = fields.status;
  if (typeof fields.timeoutMs === 'number') record.timeoutMs = fields.timeoutMs;
  if (typeof fields.port === 'number') record.port = fields.port;
  if (typeof fields.count === 'number') record.count = fields.count;
  if (typeof fields.exitCode === 'number') record.exitCode = fields.exitCode;
  if (typeof fields.hasDocumentId === 'boolean') record.hasDocumentId = fields.hasDocumentId;

  const target = getLogFilePath();
  try {
    const line = `${JSON.stringify(record)}\n`;
    const lineBytes = Buffer.byteLength(line, 'utf8');
    if (lineBytes > MAX_LOG_BYTES) {
      throw new Error('single log record exceeds the log size limit');
    }
    // Rotate when this record would not fit in the remaining space, not only when
    // the file is already at the cap.
    const writeError = withLogLock(target, () => {
      const rotationError = rotateIfNeeded(target, MAX_LOG_BYTES - lineBytes);
      if (rotationError) return rotationError;
      fs.appendFileSync(target, line, 'utf8');
      return undefined;
    });
    if (writeError) throw writeError;
    return undefined;
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    // Report once per process to stderr; the native messaging protocol owns stdout.
    if (!failureReported) {
      failureReported = true;
      process.stderr.write(`[aieasybrowser] log write failed (${target}): ${failure.message}\n`);
    }
    return failure;
  }
}

export const logger = {
  info: (fields: LogFields) => log('info', fields),
  warn: (fields: LogFields) => log('warn', fields),
  error: (fields: LogFields) => log('error', fields),
};

/**
 * Verify the log location can accept a record: the target is writable, archive slots
 * are regular files, every existing file can actually be renamed (rotation needs it),
 * and a temporary write can be created and cleaned up. Real files are renamed to a
 * sibling probe name and immediately restored, so ACLs that differ per archive are
 * caught here instead of during the first rotation.
 */
export function probeLogWritable(): { ok: boolean; path: string; error?: string } {
  const target = getLogFilePath();
  const dir = path.dirname(target);
  const failure = withLogLock(target, () => {
    const writeProbe = path.join(dir, '.write-probe-' + process.pid + '-' + randomUUID());
    let writeProbeCreated = false;
    let cleanupError: Error | undefined;
    let probeError: string | undefined;
    try {
      if (fs.existsSync(target) && !fs.statSync(target).isFile()) {
        throw new Error('log path exists but is not a regular file');
      }
      for (let index = 1; index <= MAX_LOG_FILES; index += 1) {
        const slot = rotationSlot(target, index);
        if (fs.existsSync(slot) && !fs.statSync(slot).isFile()) {
          throw new Error(`rotation slot is not a regular file: ${slot}`);
        }
      }

      // The write probe checks the directory accepts new files and that a failure to
      // clean it up is reported rather than thrown at the caller.
      const descriptor = fs.openSync(writeProbe, 'wx');
      writeProbeCreated = true;
      try {
        fs.writeFileSync(descriptor, 'probe\n', 'utf8');
      } finally {
        fs.closeSync(descriptor);
      }

      // Rotation renames the live file and every existing archive; verify each real
      // path can be renamed, not just a throwaway file in the same directory.
      const renameError =
        verifyPathRenameable(target) ??
        (() => {
          for (let index = 1; index <= MAX_LOG_FILES; index += 1) {
            const error = verifyPathRenameable(rotationSlot(target, index));
            if (error) return error;
          }
          return undefined;
        })();
      if (renameError) throw renameError;
      fs.appendFileSync(target, '', 'utf8');
      fs.accessSync(target, fs.constants.W_OK);
    } catch (error) {
      probeError = error instanceof Error ? error.message : String(error);
    } finally {
      if (writeProbeCreated) {
        try {
          fs.rmSync(writeProbe, { force: true });
        } catch (error) {
          cleanupError = new Error(
            `probe cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    if (cleanupError) {
      return new Error([probeError, cleanupError.message].filter(Boolean).join('; '));
    }
    return probeError ? new Error(probeError) : undefined;
  });
  return failure ? { ok: false, path: target, error: failure.message } : { ok: true, path: target };
}

/** Timestamped duration helper for command and tool timing. */
export function startTimer(): () => number {
  const started = process.hrtime.bigint();
  return () => Number(process.hrtime.bigint() - started) / 1e6;
}
