import fs from 'fs/promises';
import path from 'path';
import { AnalysisError, invalid } from './errors';

export const MAX_INPUT_BYTES = 50 * 1024 * 1024;
// One chrome_cdp_scripts page; Native Messaging replies may be far larger than this.
const SCRIPT_PAGE_BYTES = 2_000_000;

export type InvokeTool = (name: string, args: Record<string, unknown>) => Promise<any>;

export function requireAbsolute(name: string, value: string): string {
  if (!path.isAbsolute(value)) invalid(`${name} must be an absolute path`);
  return path.resolve(value);
}

function decodeUtf8(bytes: Buffer, what: string): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new AnalysisError('INPUT_READ_FAILED', `${what} is not valid UTF-8`);
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export async function readInputFile(file: string, signal: AbortSignal): Promise<string> {
  const target = requireAbsolute('file', file);
  let size: number;
  try {
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new AnalysisError('INPUT_READ_FAILED', `${target} is not a file`);
    size = stat.size;
  } catch (error) {
    if (error instanceof AnalysisError) throw error;
    throw new AnalysisError('INPUT_READ_FAILED', `${target}: ${(error as Error).message}`);
  }
  if (size > MAX_INPUT_BYTES) {
    throw new AnalysisError(
      'INPUT_TOO_LARGE',
      `${target} is ${size} bytes, limit ${MAX_INPUT_BYTES}`,
    );
  }
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(target, { signal });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw new AnalysisError('INPUT_READ_FAILED', `${target}: ${(error as Error).message}`);
  }
  return decodeUtf8(bytes, target);
}

export interface ScriptInfo {
  scriptId: string;
  sessionId?: string;
  url: string;
  kind?: string;
  startLine: number;
  startColumn: number;
  sourceMapURL?: string;
}

/** Reads a whole parsed script through chrome_cdp_scripts source pages (raw, unredacted). */
export async function loadScript(
  invoke: InvokeTool,
  target: { scriptId: string; sessionId?: string; tabId?: number },
  signal: AbortSignal,
): Promise<{ script: ScriptInfo; text: string }> {
  const parts: string[] = [];
  let offset = 0;
  let script: ScriptInfo | undefined;
  for (;;) {
    signal.throwIfAborted();
    const page = await invoke('chrome_cdp_scripts', {
      action: 'source',
      scriptId: target.scriptId,
      ...(target.sessionId !== undefined ? { sessionId: target.sessionId } : {}),
      ...(target.tabId !== undefined ? { tabId: target.tabId } : {}),
      offset,
      length: SCRIPT_PAGE_BYTES,
      maxOutputBytes: SCRIPT_PAGE_BYTES,
      sanitizeOutput: false,
    });
    if (!script) {
      script = page.script as ScriptInfo;
      if (page.totalLength > MAX_INPUT_BYTES) {
        throw new AnalysisError(
          'INPUT_TOO_LARGE',
          `script ${target.scriptId} has ${page.totalLength} code units, limit ${MAX_INPUT_BYTES}`,
        );
      }
    }
    if (typeof page.text !== 'string' || page.endOffset <= offset) {
      throw new AnalysisError(
        'ANALYSIS_FAILED',
        `chrome_cdp_scripts returned no progress at ${offset}`,
      );
    }
    parts.push(page.text);
    offset = page.endOffset;
    if (!page.hasMore) break;
  }
  return { script, text: parts.join('') };
}

/** Joins a planned relative path under root and refuses anything that resolves outside it. */
function inside(root: string, relative: string): string {
  const target = path.resolve(root, ...relative.split('/'));
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new AnalysisError('OUTPUT_WRITE_FAILED', `planned path escapes outDir: ${relative}`);
  }
  return target;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new AnalysisError('OUTPUT_WRITE_FAILED', `${target}: ${(error as Error).message}`);
  }
}

/**
 * Writes files under root. Without overwrite every target is checked first, so an existing
 * file fails the call before anything is written.
 */
export async function writeFiles(
  root: string,
  files: Array<{ path: string; content: string }>,
  overwrite: boolean,
  signal: AbortSignal,
): Promise<void> {
  const targets = files.map((file) => ({ target: inside(root, file.path), content: file.content }));
  if (!overwrite) {
    for (const { target } of targets) {
      signal.throwIfAborted();
      if (await exists(target)) {
        throw new AnalysisError(
          'OUTPUT_EXISTS',
          `${target} exists; pass overwrite:true to replace it`,
        );
      }
    }
  }
  const made = new Set<string>();
  for (const { target, content } of targets) {
    signal.throwIfAborted();
    const dir = path.dirname(target);
    try {
      if (!made.has(dir)) {
        await fs.mkdir(dir, { recursive: true });
        made.add(dir);
      }
      await fs.writeFile(target, content, 'utf8');
    } catch (error) {
      throw new AnalysisError('OUTPUT_WRITE_FAILED', `${target}: ${(error as Error).message}`);
    }
  }
}

export async function writeOutputFile(
  file: string,
  content: string,
  overwrite: boolean,
  signal: AbortSignal,
): Promise<string> {
  const target = requireAbsolute('outFile', file);
  await writeFiles(
    path.dirname(target),
    [{ path: path.basename(target), content }],
    overwrite,
    signal,
  );
  return target;
}
