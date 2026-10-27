/**
 * Diagnostic logging for the native server.
 *
 * Every record is written as one JSON line with a fixed field whitelist. Free-form
 * request or response bodies are never passed through: callers provide only the
 * fields listed in `LogFields`, and `sanitizeText` scrubs anything that looks like
 * a credential from the few string fields that echo external text (error messages).
 *
 * Writes are synchronous so a crash immediately after logging still leaves the
 * record on disk, and so exit handlers do not need to await anything. The cost is
 * one small append per event, which is negligible next to a browser round trip.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getLogDir } from '../scripts/utils';

export const LOG_FILE_NAME = 'native-server.log';
export const MAX_LOG_BYTES = 5 * 1024 * 1024;
export const MAX_LOG_FILES = 5;

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogFields {
  /** Command name for CLI requests, or a subsystem label for lifecycle events. */
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
  code?: string;
  error?: string;
  port?: number;
  count?: number;
  /** Extra short scalars. Values must already be safe to log. */
  extra?: Record<string, string | number | boolean>;
}

export interface LogRecord extends Record<string, unknown> {
  ts: string;
  level: LogLevel;
  pid: number;
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]'],
  // Quoted JSON keys: {"password":"value"} and {"authToken": "value"}
  [
    /(["']?(?:auth[_-]?token|access[_-]?token|api[_-]?key|authorization|cookie|password|secret|session[_-]?id)["']?\s*[:=]\s*)(["'][^"']*["']|[^\s,;}]+)/gi,
    '$1[redacted]',
  ],
];

/** Scrub credential-shaped substrings out of text that may echo external input. */
export function sanitizeText(input: string, maxLength = 400): string {
  let value = input;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    value = value.replace(pattern, replacement);
  }
  value = value.replace(/\s+/g, ' ').trim();
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
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

function rotateIfNeeded(filePath: string): void {
  let size: number;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return;
  }
  if (size < MAX_LOG_BYTES) return;

  for (let index = MAX_LOG_FILES - 1; index >= 1; index -= 1) {
    const from = `${filePath}.${index}`;
    const to = `${filePath}.${index + 1}`;
    try {
      fs.renameSync(from, to);
    } catch {
      // A missing rotation slot is expected until that many rotations happened.
    }
  }
  try {
    fs.renameSync(filePath, `${filePath}.1`);
  } catch {
    // If rotation fails the append below still reports the real problem.
  }
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
    event: sanitizeText(fields.event, 120),
  };
  if (fields.requestId) record.requestId = sanitizeText(fields.requestId, 120);
  if (fields.session) record.session = sanitizeText(fields.session, 80);
  if (fields.tool) record.tool = sanitizeText(fields.tool, 120);
  if (fields.nativeRequestId) record.nativeRequestId = sanitizeText(fields.nativeRequestId, 120);
  if (typeof fields.tabId === 'number') record.tabId = fields.tabId;
  if (typeof fields.frameId === 'number') record.frameId = fields.frameId;
  if (fields.phase) record.phase = sanitizeText(fields.phase, 40);
  if (fields.actionStatus) record.actionStatus = sanitizeText(fields.actionStatus, 40);
  if (typeof fields.completed === 'number') record.completed = fields.completed;
  if (typeof fields.durationMs === 'number') record.durationMs = Math.round(fields.durationMs);
  if (fields.code) record.code = sanitizeText(fields.code, 80);
  if (fields.error) record.error = sanitizeText(fields.error);
  if (typeof fields.port === 'number') record.port = fields.port;
  if (typeof fields.count === 'number') record.count = fields.count;
  if (fields.extra) {
    const extra: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(fields.extra)) {
      extra[sanitizeText(key, 40)] = typeof value === 'string' ? sanitizeText(value, 160) : value;
    }
    record.extra = extra;
  }

  const target = getLogFilePath();
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    rotateIfNeeded(target);
    fs.appendFileSync(target, `${JSON.stringify(record)}\n`, 'utf8');
    return undefined;
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    // Report once per process to stderr; the native messaging protocol owns stdout.
    if (!failureReported) {
      failureReported = true;
      process.stderr.write(
        `[aieasybrowser] log write failed (${target}): ${sanitizeText(failure.message)}\n`,
      );
    }
    return failure;
  }
}

export const logger = {
  info: (fields: LogFields) => log('info', fields),
  warn: (fields: LogFields) => log('warn', fields),
  error: (fields: LogFields) => log('error', fields),
};

/** Verify the log location can accept a record; used by startup and doctor. */
export function probeLogWritable(): { ok: boolean; path: string; error?: string } {
  const target = getLogFilePath();
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // A directory or other non-regular file at the log path would make every append
    // fail silently later, so reject anything that is not appendable now.
    if (fs.existsSync(target) && !fs.statSync(target).isFile()) {
      throw new Error('log path exists but is not a regular file');
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
