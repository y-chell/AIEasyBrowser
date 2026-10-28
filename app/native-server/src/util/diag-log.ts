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

/**
 * Rotate before the next append. Returns an error instead of proceeding when a
 * rotation slot cannot be replaced, so the caller never writes past MAX_LOG_BYTES.
 */
function rotateIfNeeded(filePath: string): Error | undefined {
  let size: number;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return undefined;
  }
  if (size < MAX_LOG_BYTES) return undefined;

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

  try {
    for (let index = MAX_LOG_FILES - 1; index >= 1; index -= 1) {
      const from = rotationSlot(filePath, index);
      const to = rotationSlot(filePath, index + 1);
      if (!fs.existsSync(from)) continue;
      fs.rmSync(to, { force: true });
      fs.renameSync(from, to);
    }
    fs.rmSync(rotationSlot(filePath, 1), { force: true });
    fs.renameSync(filePath, rotationSlot(filePath, 1));
  } catch (error) {
    return new Error(
      `log rotation failed: ${error instanceof Error ? error.message : String(error)}`,
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
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const rotationError = rotateIfNeeded(target);
    if (rotationError) throw rotationError;
    fs.appendFileSync(target, `${JSON.stringify(record)}\n`, 'utf8');
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
 * Verify the log location can accept a record, including that rotation will not be
 * blocked by a directory squatting on an archive slot. Used by startup and doctor.
 */
export function probeLogWritable(): { ok: boolean; path: string; error?: string } {
  const target = getLogFilePath();
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(target) && !fs.statSync(target).isFile()) {
      throw new Error('log path exists but is not a regular file');
    }
    for (let index = 1; index <= MAX_LOG_FILES; index += 1) {
      const slot = rotationSlot(target, index);
      if (fs.existsSync(slot) && !fs.statSync(slot).isFile()) {
        throw new Error(`rotation slot is not a regular file: ${slot}`);
      }
    }
    fs.appendFileSync(target, '', 'utf8');
    fs.accessSync(target, fs.constants.W_OK);
    return { ok: true, path: target };
  } catch (error) {
    return {
      ok: false,
      path: target,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Timestamped duration helper for command and tool timing. */
export function startTimer(): () => number {
  const started = process.hrtime.bigint();
  return () => Number(process.hrtime.bigint() - started) / 1e6;
}
