import {
  createErrorResponse,
  createStructuredToolResult,
  type ToolResult,
} from '@/common/tool-handler';
import { TOOL_NAMES } from 'aieasybrowser-shared';
import { BaseBrowserToolExecutor } from '../base-browser';
import type { BrowserToolExecutionContext } from '../browser-session-context';
import { getOwnedSession, type HeldSession } from '@/utils/cdp-event-hub';
import {
  ensureScriptDebugger,
  findScript,
  lineStarts,
  loadScriptSource,
  toLocation,
  type ScriptKind,
  type ScriptRecord,
} from '@/utils/cdp-scripts';
import { DEFAULT_MAX_OUTPUT_BYTES, redactInlineSecrets } from '@/utils/output-sanitizer';
import { clampInt } from './cdp';

interface CdpScriptsParams {
  action?: 'list' | 'source' | 'search';
  tabId?: number;
  windowId?: number;
  scriptId?: string;
  sessionId?: string;
  url?: string;
  kind?: ScriptKind;
  includeIsolated?: boolean;
  after?: number;
  limit?: number;
  offset?: number;
  length?: number;
  line?: number;
  lineCount?: number;
  query?: string;
  isRegex?: boolean;
  caseSensitive?: boolean;
  maxMatches?: number;
  contextChars?: number;
  cursor?: string;
  maxOutputBytes?: number;
  sanitizeOutput?: boolean;
}

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1000;
const DEFAULT_SOURCE_LENGTH = 20_000;
const DEFAULT_LINE_COUNT = 200;
const DEFAULT_MAX_MATCHES = 50;
const MAX_MATCHES = 500;
const DEFAULT_CONTEXT_CHARS = 80;
const MAX_CONTEXT_CHARS = 500;
// A greedy pattern can match a whole bundle; the snippet keeps only the head of the match.
const MAX_MATCH_CHARS = 500;
const encoder = new TextEncoder();

function invalid(message: string): never {
  throw new Error(`INVALID_ARGUMENT: ${message}`);
}

function bytesOf(value: unknown): number {
  return encoder.encode(typeof value === 'string' ? value : JSON.stringify(value)).length;
}

function present(text: string, sanitize: boolean): { text: string; redacted: boolean } {
  return sanitize ? redactInlineSecrets(text) : { text, redacted: false };
}

/** Longest prefix of text[start, end) whose UTF-8 size fits maxBytes, as an end offset. */
function fitBytes(text: string, start: number, end: number, maxBytes: number): number {
  let used = 0;
  let index = start;
  while (index < end) {
    const code = text.codePointAt(index)!;
    const width = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (used + width > maxBytes) break;
    used += width;
    index += code > 0xffff ? 2 : 1;
  }
  return index;
}

function describe(record: ScriptRecord) {
  return {
    seq: record.seq,
    scriptId: record.scriptId,
    ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    url: record.url,
    kind: record.kind,
    target: record.target,
    ...(record.context ? { context: record.context } : {}),
    ...(record.frameId ? { frameId: record.frameId } : {}),
    startLine: record.startLine,
    startColumn: record.startColumn,
    endLine: record.endLine,
    endColumn: record.endColumn,
    ...(record.length !== undefined ? { length: record.length } : {}),
    hash: record.hash,
    ...(record.sourceMapURL ? { sourceMapURL: record.sourceMapURL } : {}),
    ...(record.isModule ? { isModule: true } : {}),
    ...(record.language ? { language: record.language } : {}),
    ...(record.failedToParse ? { failedToParse: true } : {}),
  };
}

function selectScripts(session: HeldSession, args: CdpScriptsParams): ScriptRecord[] {
  const url = args.url?.toLowerCase();
  return [...session.scripts.records.values()]
    .filter(
      (record) =>
        (args.includeIsolated === true || record.context !== 'isolated') &&
        (!url || record.url.toLowerCase().includes(url)) &&
        (!args.kind || record.kind === args.kind) &&
        (args.sessionId === undefined || (record.sessionId ?? '') === args.sessionId) &&
        (args.scriptId === undefined || record.scriptId === args.scriptId),
    )
    .sort((a, b) => a.seq - b.seq);
}

class CdpScriptsTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.CDP_SCRIPTS;

  // Reading source at a pause must not wait for a call stuck on the paused page.
  skipsTargetLock() {
    return true;
  }

  async execute(
    args: CdpScriptsParams,
    executionContext?: BrowserToolExecutionContext,
  ): Promise<ToolResult> {
    const owner = executionContext?.owner;
    if (!owner) {
      return createErrorResponse(
        'CDP_SESSION_NOT_STARTED: chrome_cdp_scripts requires a named task session',
      );
    }
    try {
      const explicit = await this.tryGetTab(args.tabId);
      if (args.tabId !== undefined && !explicit) {
        throw new Error(`TARGET_CLOSED: tab ${args.tabId} is not open`);
      }
      const tab = explicit || (await this.getActiveTabOrThrowInWindow(args.windowId));
      if (!tab.id) throw new Error('Active tab has no ID');
      // Validate before any CDP IO so a bad call does not enable the debugger.
      const run = this.prepare(args);
      const session = getOwnedSession(tab.id, owner);
      if (session.ended) {
        throw new Error(
          `CDP_SESSION_ENDED: tab ${tab.id} debugger session ended (${session.ended.reason})`,
        );
      }
      if (args.sessionId && !session.targets.has(args.sessionId)) {
        throw new Error(
          `CDP_UNKNOWN_SESSION: sessionId ${args.sessionId} is not an attached child target of tab ${tab.id}`,
        );
      }
      await ensureScriptDebugger(session);
      const payload = await run(session);
      return createStructuredToolResult({
        success: true,
        tool: this.name,
        tabId: tab.id,
        ...payload,
        ...(session.scripts.errors.length ? { debuggerErrors: session.scripts.errors } : {}),
      });
    } catch (error) {
      return createErrorResponse(
        `Error in CDP scripts: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private prepare(args: CdpScriptsParams): (session: HeldSession) => Promise<object> {
    const maxBytes = clampInt(args.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 1000, 2_000_000);
    const sanitize = args.sanitizeOutput !== false;
    switch (args.action) {
      case 'list':
        return async (session) => this.list(session, args, maxBytes);
      case 'source': {
        if (!args.scriptId) invalid('source requires scriptId');
        if (args.offset !== undefined && args.line !== undefined) {
          invalid('use either offset/length or line/lineCount, not both');
        }
        return async (session) => this.source(session, args, maxBytes, sanitize);
      }
      case 'search': {
        if (!args.query) invalid('search requires a non-empty query');
        let pattern: RegExp;
        try {
          const source = args.isRegex
            ? args.query
            : args.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          pattern = new RegExp(source, args.caseSensitive ? 'g' : 'gi');
        } catch (error) {
          invalid(`query is not a valid regular expression: ${(error as Error).message}`);
        }
        const cursor = args.cursor ? parseCursor(args.cursor) : { seq: 0, offset: 0 };
        return async (session) => this.search(session, args, pattern, cursor, maxBytes, sanitize);
      }
      default:
        invalid('action must be list, source, or search');
    }
  }

  private list(session: HeldSession, args: CdpScriptsParams, maxBytes: number) {
    const after = clampInt(args.after, 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = clampInt(args.limit, DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
    const matching = selectScripts(session, args);
    const page: object[] = [];
    let used = 0;
    let truncated = false;
    for (const record of matching) {
      if (record.seq <= after) continue;
      if (page.length >= limit) break;
      const entry = describe(record);
      const size = bytesOf(entry);
      if (page.length > 0 && used + size > maxBytes) {
        truncated = true;
        break;
      }
      page.push(entry);
      used += size;
    }
    const nextAfter = page.length ? (page[page.length - 1] as { seq: number }).seq : after;
    return {
      total: matching.length,
      scripts: page,
      nextAfter,
      hasMore: matching.some((record) => record.seq > nextAfter),
      ...(truncated ? { pageTruncatedByBytes: true } : {}),
      dropped: session.scripts.dropped,
    };
  }

  private async source(
    session: HeldSession,
    args: CdpScriptsParams,
    maxBytes: number,
    sanitize: boolean,
  ) {
    const record = this.resolveScript(session, args);
    const source = await loadScriptSource(session, record);
    if (source.wasm) {
      throw new Error(`SCRIPT_NOT_TEXT: script ${record.scriptId} is WebAssembly bytecode`);
    }
    const text = source.text;
    const starts = lineStarts(source);
    let start: number;
    let end: number;
    if (args.line !== undefined) {
      // line is resource-relative like every other CDP location.
      const first = clampInt(args.line, record.startLine, 0, Number.MAX_SAFE_INTEGER);
      const index = first - record.startLine;
      if (index < 0 || index >= starts.length) {
        invalid(
          `line ${first} is outside script lines ${record.startLine}..${record.startLine + starts.length - 1}`,
        );
      }
      const count = clampInt(args.lineCount, DEFAULT_LINE_COUNT, 1, 100_000);
      start = starts[index];
      end = index + count < starts.length ? starts[index + count] : text.length;
    } else {
      start = clampInt(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      if (start > text.length) invalid(`offset ${start} is past script length ${text.length}`);
      end = Math.min(
        text.length,
        start + clampInt(args.length, DEFAULT_SOURCE_LENGTH, 1, 2_000_000),
      );
    }
    const limitedEnd = Math.max(fitBytes(text, start, end, maxBytes), Math.min(end, start + 1));
    const shown = present(text.slice(start, limitedEnd), sanitize);
    const from = toLocation(record, starts, start);
    const to = toLocation(record, starts, limitedEnd);
    return {
      script: describe(record),
      totalLength: text.length,
      totalLines: starts.length,
      offset: start,
      endOffset: limitedEnd,
      startLocation: from,
      endLocation: to,
      text: shown.text,
      ...(limitedEnd < end ? { truncatedByBytes: true } : {}),
      hasMore: limitedEnd < text.length,
      ...(shown.redacted ? { redacted: true } : {}),
      sanitizeOutput: sanitize,
    };
  }

  private async search(
    session: HeldSession,
    args: CdpScriptsParams,
    pattern: RegExp,
    cursor: { seq: number; offset: number },
    maxBytes: number,
    sanitize: boolean,
  ) {
    const maxMatches = clampInt(args.maxMatches, DEFAULT_MAX_MATCHES, 1, MAX_MATCHES);
    const context = clampInt(args.contextChars, DEFAULT_CONTEXT_CHARS, 0, MAX_CONTEXT_CHARS);
    const scripts = selectScripts(session, args).filter(
      (record) => record.seq >= cursor.seq && !record.failedToParse,
    );
    const matches: object[] = [];
    const scriptErrors: Array<{ scriptId: string; sessionId?: string; error: string }> = [];
    let used = 0;
    let searched = 0;
    let redacted = false;
    let next: string | undefined;

    outer: for (const record of scripts) {
      let source;
      try {
        source = await loadScriptSource(session, record);
      } catch (error) {
        scriptErrors.push({
          scriptId: record.scriptId,
          ...(record.sessionId ? { sessionId: record.sessionId } : {}),
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (source.wasm) continue;
      searched += 1;
      const text = source.text;
      const starts = lineStarts(source);
      pattern.lastIndex = record.seq === cursor.seq ? cursor.offset : 0;
      for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
        if (match[0].length === 0) pattern.lastIndex += 1;
        const offset = match.index;
        if (matches.length >= maxMatches) {
          next = `${record.seq}:${offset}`;
          break outer;
        }
        const matchEnd = offset + Math.min(match[0].length, MAX_MATCH_CHARS);
        const before = present(text.slice(Math.max(0, offset - context), offset), sanitize);
        const hit = present(text.slice(offset, matchEnd), sanitize);
        const afterText = present(text.slice(matchEnd, matchEnd + context), sanitize);
        const entry = {
          scriptId: record.scriptId,
          ...(record.sessionId ? { sessionId: record.sessionId } : {}),
          url: record.url,
          ...toLocation(record, starts, offset),
          offset,
          matchLength: match[0].length,
          before: before.text,
          match: hit.text,
          after: afterText.text,
        };
        const size = bytesOf(entry);
        if (matches.length > 0 && used + size > maxBytes) {
          next = `${record.seq}:${offset}`;
          break outer;
        }
        redacted ||= before.redacted || hit.redacted || afterText.redacted;
        matches.push(entry);
        used += size;
      }
    }
    return {
      query: args.query,
      isRegex: args.isRegex === true,
      caseSensitive: args.caseSensitive === true,
      matches,
      scriptsSearched: searched,
      ...(scriptErrors.length ? { scriptErrors } : {}),
      hasMore: next !== undefined,
      ...(next ? { cursor: next } : {}),
      ...(redacted ? { redacted: true } : {}),
      sanitizeOutput: sanitize,
    };
  }

  private resolveScript(session: HeldSession, args: CdpScriptsParams): ScriptRecord {
    const record = findScript(session.scripts, args.scriptId!, args.sessionId);
    if (!record) {
      throw new Error(
        `SCRIPT_NOT_FOUND: script ${args.scriptId} is not in the ${
          args.sessionId ? `child session ${args.sessionId}` : 'root session'
        } script table; list scripts first`,
      );
    }
    return record;
  }
}

function parseCursor(cursor: string): { seq: number; offset: number } {
  const match = /^(\d+):(\d+)$/.exec(cursor);
  if (!match) invalid('cursor must be the value returned by a previous search');
  return { seq: Number(match[1]), offset: Number(match[2]) };
}

export const cdpScriptsTool = new CdpScriptsTool();
