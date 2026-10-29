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
  authSummary,
  clearNetworkTable,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_REQUESTS,
  isSensitiveHeader,
  loadBody,
  MAX_BODY_BYTES_LIMIT,
  MAX_REQUESTS_LIMIT,
  requestHeadersOf,
  responseHeadersOf,
  startNetwork,
  stopNetwork,
  STREAM_TYPES,
  type BodyMode,
  type BodyPart,
  type Headers,
  type NetworkRecord,
  type RecordState,
} from '@/utils/cdp-network';
import { buildHar, phaseTimings, REDACTED } from '@/utils/cdp-network-har';
import { DEFAULT_MAX_OUTPUT_BYTES, redactInlineSecrets } from '@/utils/output-sanitizer';
import { clampInt } from './cdp';

type Action = 'start' | 'list' | 'get' | 'body' | 'messages' | 'har' | 'clear' | 'stop';

interface CdpNetworkParams {
  action?: Action;
  tabId?: number;
  windowId?: number;
  bodies?: BodyMode;
  maxBodyBytes?: number;
  maxRequests?: number;
  seq?: number;
  part?: BodyPart;
  url?: string;
  method?: string;
  types?: string[];
  status?: number;
  state?: RecordState;
  sessionId?: string;
  after?: number;
  limit?: number;
  offset?: number;
  length?: number;
  includeBodies?: boolean;
  filename?: string;
  maxOutputBytes?: number;
  sanitizeOutput?: boolean;
}

const ACTIONS: Action[] = ['start', 'list', 'get', 'body', 'messages', 'har', 'clear', 'stop'];
const STATES: RecordState[] = ['pending', 'complete', 'failed', 'open', 'closed'];
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1000;
const MAX_URL_CHARS = 300;
const PREVIEW_CHARS = 1000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const FILENAME = /^[\w][\w.-]{0,99}$/;
const encoder = new TextEncoder();

function invalid(message: string): never {
  throw new Error(`INVALID_ARGUMENT: ${message}`);
}

function bytesOf(value: unknown): number {
  return encoder.encode(typeof value === 'string' ? value : JSON.stringify(value)).length;
}

function presentText(text: string, sanitize: boolean): { text: string; redacted: boolean } {
  return sanitize ? redactInlineSecrets(text) : { text, redacted: false };
}

function presentHeaders(headers: Headers, sanitize: boolean): Headers {
  if (!sanitize) return headers;
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      isSensitiveHeader(name) ? REDACTED : value,
    ]),
  );
}

function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
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

function row(record: NetworkRecord, sanitize: boolean) {
  const url = presentText(record.url, sanitize).text;
  const response = record.response;
  return {
    seq: record.seq,
    method: record.method,
    url: url.length > MAX_URL_CHARS ? `${url.slice(0, MAX_URL_CHARS)}...` : url,
    ...(url.length > MAX_URL_CHARS ? { urlLength: url.length } : {}),
    type: record.resourceType,
    state: record.state,
    ...(record.status !== undefined ? { status: record.status } : {}),
    ...(record.mimeType ? { mimeType: record.mimeType } : {}),
    ...(record.endedAt !== undefined ? { durationMs: record.endedAt - record.startedAt } : {}),
    ...(record.encodedDataLength !== undefined ? { transferBytes: record.encodedDataLength } : {}),
    ...(response.stored
      ? { bodyBytes: response.stored.totalBytes }
      : response.pending
        ? { body: 'reading' }
        : {}),
    ...(record.messageCount ? { messages: record.messageCount } : {}),
    ...(record.fromCache ? { fromCache: record.fromCache } : {}),
    ...(record.errorText ? { error: record.errorText } : {}),
    ...(record.redirectedTo !== undefined ? { redirectedTo: record.redirectedTo } : {}),
    ...(record.key ? { sessionId: record.key } : {}),
  };
}

function preview(record: NetworkRecord, part: BodyPart, sanitize: boolean) {
  const stored = record[part].stored;
  if (!stored) {
    return record[part].evicted
      ? { evicted: true }
      : record[part].error
        ? { error: record[part].error }
        : undefined;
  }
  const base = {
    bytes: stored.totalBytes,
    ...(stored.truncated ? { storedBytes: stored.bytes } : {}),
  };
  if (stored.base64) return { ...base, base64: true };
  const shown = presentText(stored.text.slice(0, PREVIEW_CHARS), sanitize);
  return {
    ...base,
    preview: shown.text,
    ...(stored.text.length > PREVIEW_CHARS ? { previewTruncated: true } : {}),
  };
}

function detail(record: NetworkRecord, sanitize: boolean) {
  const request = requestHeadersOf(record);
  const response = responseHeadersOf(record);
  const totalMs = Math.max(0, (record.endedAt ?? record.startedAt) - record.startedAt);
  const initiator = record.initiator;
  return {
    ...row(record, sanitize),
    url: presentText(record.url, sanitize).text,
    requestId: record.requestId,
    ...(record.frameId ? { frameId: record.frameId } : {}),
    ...(record.documentURL ? { documentURL: presentText(record.documentURL, sanitize).text } : {}),
    startedAt: record.startedAt,
    ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
    request: {
      headers: presentHeaders(request.headers, sanitize),
      headersSource: request.source,
      ...(record.hasPostData ? { body: preview(record, 'request', sanitize) ?? {} } : {}),
    },
    response: {
      ...(record.status !== undefined ? { status: record.status } : {}),
      ...(record.statusText ? { statusText: record.statusText } : {}),
      ...(record.responseHeaders || record.responseHeadersExtra
        ? { headers: presentHeaders(response.headers, sanitize), headersSource: response.source }
        : {}),
      ...(record.protocol ? { protocol: record.protocol } : {}),
      ...(record.remoteIPAddress
        ? { remoteAddress: `${record.remoteIPAddress}:${record.remotePort ?? ''}` }
        : {}),
      ...(preview(record, 'response', sanitize)
        ? { body: preview(record, 'response', sanitize) }
        : {}),
    },
    ...(authSummary(record) ? { auth: authSummary(record) } : {}),
    ...(initiator
      ? {
          initiator: {
            type: initiator.type,
            ...(initiator.url ? { url: initiator.url } : {}),
            ...(typeof initiator.lineNumber === 'number'
              ? { lineNumber: initiator.lineNumber }
              : {}),
            ...(initiator.stack?.callFrames?.length
              ? {
                  stack: initiator.stack.callFrames.slice(0, 5).map((frame: any) => ({
                    functionName: frame.functionName,
                    url: frame.url,
                    lineNumber: frame.lineNumber,
                    columnNumber: frame.columnNumber,
                  })),
                }
              : {}),
          },
        }
      : {}),
    ...(record.timing ? { timings: phaseTimings(record, totalMs) } : {}),
    ...(record.redirectedFrom !== undefined ? { redirectedFrom: record.redirectedFrom } : {}),
    ...(record.canceled ? { canceled: true } : {}),
    ...(record.blockedReason ? { blockedReason: record.blockedReason } : {}),
    ...(record.messagesDropped ? { messagesDropped: record.messagesDropped } : {}),
    sanitizeOutput: sanitize,
  };
}

function select(session: HeldSession, args: CdpNetworkParams): NetworkRecord[] {
  const url = args.url?.toLowerCase();
  const method = args.method?.toUpperCase();
  const types = args.types?.map((type) => type.toLowerCase());
  const sessionKey = args.sessionId === 'root' ? '' : args.sessionId;
  return [...session.network.records.values()].filter(
    (record) =>
      (!url || record.url.toLowerCase().includes(url)) &&
      (!method || record.method.toUpperCase() === method) &&
      (!types || types.includes(record.resourceType.toLowerCase())) &&
      (args.status === undefined || record.status === args.status) &&
      (!args.state || record.state === args.state) &&
      (sessionKey === undefined || record.key === sessionKey),
  );
}

function harFilename(tabId: number, requested: string | undefined): string {
  if (requested) return requested.toLowerCase().endsWith('.har') ? requested : `${requested}.har`;
  return `network_tab${tabId}_${new Date().toISOString().replace(/[:.]/g, '-')}.har`;
}

/** Writes through chrome.downloads and waits until the file is complete on disk. */
async function saveDownload(text: string, filename: string) {
  const bytes = encoder.encode(text);
  const downloadId = await chrome.downloads.download({
    // application/json would make Chrome rename the file to .json.
    url: `data:application/octet-stream;base64,${encodeBase64(bytes)}`,
    filename,
    conflictAction: 'uniquify',
    saveAs: false,
  });
  const deadline = Date.now() + DOWNLOAD_TIMEOUT_MS;
  for (;;) {
    const [item] = await chrome.downloads.search({ id: downloadId });
    if (item?.state === 'complete') return { downloadId, path: item.filename, bytes: bytes.length };
    if (item?.state === 'interrupted') {
      throw new Error(`HAR_WRITE_FAILED: download ${downloadId} was interrupted (${item.error})`);
    }
    if (Date.now() > deadline) {
      throw new Error(`HAR_WRITE_FAILED: download ${downloadId} did not finish in 60 s`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

class CdpNetworkTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.CDP_NETWORK;

  // Every action works on the held session alone and must reach a page paused in the debugger.
  skipsTargetLock() {
    return true;
  }

  async execute(
    args: CdpNetworkParams,
    executionContext?: BrowserToolExecutionContext,
  ): Promise<ToolResult> {
    const owner = executionContext?.owner;
    if (!owner) {
      return createErrorResponse(
        'CDP_SESSION_NOT_STARTED: chrome_cdp_network requires a named task session',
      );
    }
    try {
      const explicit = await this.tryGetTab(args.tabId);
      if (args.tabId !== undefined && !explicit) {
        throw new Error(`TARGET_CLOSED: tab ${args.tabId} is not open`);
      }
      const tab = explicit || (await this.getActiveTabOrThrowInWindow(args.windowId));
      if (!tab.id) throw new Error('Active tab has no ID');
      // Validate before any CDP IO so a bad call leaves the session unchanged.
      const run = this.prepare(args, tab.id);
      const session = getOwnedSession(tab.id, owner);
      const payload = await run(session);
      const network = session.network;
      return createStructuredToolResult({
        success: true,
        tool: this.name,
        tabId: tab.id,
        ...payload,
        ...(network.errors.length ? { networkErrors: network.errors } : {}),
      });
    } catch (error) {
      return createErrorResponse(
        `Error in CDP network: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private prepare(
    args: CdpNetworkParams,
    tabId: number,
  ): (session: HeldSession) => Promise<object> {
    if (!args.action || !ACTIONS.includes(args.action)) {
      invalid(`action must be ${ACTIONS.join(', ')}`);
    }
    const maxBytes = clampInt(args.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 1000, 2_000_000);
    const sanitize = args.sanitizeOutput !== false;
    if (args.part !== undefined && args.action !== 'body') invalid('part applies to body only');
    if (args.state !== undefined && !STATES.includes(args.state)) {
      invalid(`state must be ${STATES.join(', ')}`);
    }
    const needsSeq = args.action === 'get' || args.action === 'body' || args.action === 'messages';
    if (needsSeq && (!Number.isInteger(args.seq) || args.seq! < 1)) {
      invalid(`${args.action} requires seq from list`);
    }
    switch (args.action) {
      case 'start': {
        const bodies = args.bodies ?? 'api';
        if (!['api', 'all', 'none'].includes(bodies)) invalid('bodies must be api, all, or none');
        const options = {
          bodies,
          maxBodyBytes: clampInt(
            args.maxBodyBytes,
            DEFAULT_MAX_BODY_BYTES,
            1024,
            MAX_BODY_BYTES_LIMIT,
          ),
          maxRequests: clampInt(args.maxRequests, DEFAULT_MAX_REQUESTS, 10, MAX_REQUESTS_LIMIT),
        };
        return async (session) => {
          this.requireActive(session);
          const { sessions, childErrors } = await startNetwork(session, options);
          return {
            recording: true,
            ...options,
            sessions,
            ...(childErrors.length ? { childErrors } : {}),
          };
        };
      }
      case 'stop':
        return async (session) => {
          const errors = session.ended ? [] : await stopNetwork(session);
          if (errors.length) throw new Error(`NETWORK_STOP_INCOMPLETE: ${errors.join('; ')}`);
          return { recording: false, requests: session.network.records.size };
        };
      case 'clear':
        return async (session) => ({
          cleared: clearNetworkTable(session.network),
          recording: session.network.enabled,
        });
      case 'list':
        return async (session) => this.list(session, args, maxBytes, sanitize);
      case 'get':
        return async (session) => ({ request: detail(this.record(session, args.seq!), sanitize) });
      case 'body':
        return async (session) =>
          this.body(session, args, args.part ?? 'response', maxBytes, sanitize);
      case 'messages':
        return async (session) => this.messages(session, args, maxBytes, sanitize);
      case 'har': {
        if (args.filename !== undefined && !FILENAME.test(args.filename)) {
          invalid(
            'filename must be 1-100 letters, digits, "_", "." or "-", starting with a letter or digit',
          );
        }
        const filename = harFilename(tabId, args.filename);
        return async (session) => this.har(session, args, filename, sanitize);
      }
      default:
        invalid(`action must be ${ACTIONS.join(', ')}`);
    }
  }

  private requireActive(session: HeldSession) {
    if (session.ended) {
      throw new Error(
        `CDP_SESSION_ENDED: tab ${session.tabId} debugger session ended (${session.ended.reason})`,
      );
    }
  }

  private requireTable(session: HeldSession) {
    if (!session.network.enabled && session.network.startedAt === undefined) {
      throw new Error(
        'NETWORK_NOT_STARTED: network recording was not started in this session; call action start first',
      );
    }
  }

  private record(session: HeldSession, seq: number): NetworkRecord {
    this.requireTable(session);
    const record = session.network.records.get(seq);
    if (!record) {
      throw new Error(
        `NETWORK_REQUEST_NOT_FOUND: seq ${seq} is not in the request table (cleared, dropped by maxRequests, or never recorded); list first`,
      );
    }
    return record;
  }

  private list(session: HeldSession, args: CdpNetworkParams, maxBytes: number, sanitize: boolean) {
    this.requireTable(session);
    const after = clampInt(args.after, 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = clampInt(args.limit, DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
    const matching = select(session, args);
    const page: Array<{ seq: number }> = [];
    let used = 0;
    let truncated = false;
    for (const record of matching) {
      if (record.seq <= after) continue;
      if (page.length >= limit) break;
      const entry = row(record, sanitize);
      const size = bytesOf(entry);
      if (page.length > 0 && used + size > maxBytes) {
        truncated = true;
        break;
      }
      page.push(entry);
      used += size;
    }
    const nextAfter = page.length ? page[page.length - 1].seq : after;
    const network = session.network;
    return {
      recording: network.enabled,
      total: matching.length,
      requests: page,
      nextAfter,
      hasMore: matching.some((record) => record.seq > nextAfter),
      ...(truncated ? { pageTruncatedByBytes: true } : {}),
      dropped: network.dropped,
      bodyBytes: network.bodyBytes,
      ...(network.evictedBodies ? { evictedBodies: network.evictedBodies } : {}),
    };
  }

  private async body(
    session: HeldSession,
    args: CdpNetworkParams,
    part: BodyPart,
    maxBytes: number,
    sanitize: boolean,
  ) {
    const record = this.record(session, args.seq!);
    const stored = await loadBody(session, record, part);
    const base = {
      seq: record.seq,
      part,
      ...(record.mimeType && part === 'response' ? { mimeType: record.mimeType } : {}),
      totalBytes: stored.totalBytes,
      ...(stored.truncated ? { storedBytes: stored.bytes, captureTruncated: true } : {}),
    };
    if (stored.base64) {
      const bytes = decodeBase64(stored.text);
      const start = clampInt(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      if (start > bytes.length) invalid(`offset ${start} is past stored length ${bytes.length}`);
      // 3 raw bytes per 4 base64 characters.
      const fit = Math.max(3, Math.floor(maxBytes / 4) * 3);
      const end = Math.min(
        bytes.length,
        start + clampInt(args.length, fit, 1, 2_000_000),
        start + fit,
      );
      return {
        ...base,
        base64: true,
        offset: start,
        endOffset: end,
        unit: 'bytes',
        data: encodeBase64(bytes.subarray(start, end)),
        hasMore: end < bytes.length,
      };
    }
    const text = stored.text;
    const start = clampInt(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    if (start > text.length) invalid(`offset ${start} is past stored length ${text.length}`);
    const end = Math.min(text.length, start + clampInt(args.length, text.length, 1, 2_000_000));
    const limitedEnd = Math.max(fitBytes(text, start, end, maxBytes), Math.min(end, start + 1));
    const shown = presentText(text.slice(start, limitedEnd), sanitize);
    return {
      ...base,
      offset: start,
      endOffset: limitedEnd,
      unit: 'chars',
      totalChars: text.length,
      text: shown.text,
      hasMore: limitedEnd < text.length,
      ...(shown.redacted ? { redacted: true } : {}),
      sanitizeOutput: sanitize,
    };
  }

  private messages(
    session: HeldSession,
    args: CdpNetworkParams,
    maxBytes: number,
    sanitize: boolean,
  ) {
    const record = this.record(session, args.seq!);
    if (!STREAM_TYPES.has(record.resourceType)) {
      throw new Error(
        `NETWORK_NO_MESSAGES: seq ${record.seq} is ${record.resourceType}, not a WebSocket or EventSource; read it with action body`,
      );
    }
    const after = clampInt(args.after, 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = clampInt(args.limit, DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
    const page: Array<{ index: number }> = [];
    let used = 0;
    let truncated = false;
    let redacted = false;
    const all = record.messages ?? [];
    for (const item of all) {
      if (item.index <= after) continue;
      if (page.length >= limit) break;
      const shown = presentText(item.data, sanitize);
      const entry = { ...item, data: shown.text };
      const size = bytesOf(entry);
      if (page.length > 0 && used + size > maxBytes) {
        truncated = true;
        break;
      }
      redacted ||= shown.redacted;
      page.push(entry);
      used += size;
    }
    const nextAfter = page.length ? page[page.length - 1].index : after;
    return {
      seq: record.seq,
      type: record.resourceType,
      state: record.state,
      total: record.messageCount ?? 0,
      ...(record.messagesDropped ? { dropped: record.messagesDropped } : {}),
      messages: page,
      nextAfter,
      hasMore: all.some((item) => item.index > nextAfter),
      ...(truncated ? { pageTruncatedByBytes: true } : {}),
      ...(redacted ? { redacted: true } : {}),
      sanitizeOutput: sanitize,
    };
  }

  private async har(
    session: HeldSession,
    args: CdpNetworkParams,
    filename: string,
    sanitize: boolean,
  ) {
    this.requireTable(session);
    const records = select(session, args);
    await Promise.allSettled(
      records.flatMap((record) => [record.request.pending, record.response.pending]),
    );
    const includeBodies = args.includeBodies !== false;
    const { har, redacted } = buildHar(records, {
      includeBodies,
      sanitize,
      creatorVersion: chrome.runtime.getManifest().version,
      browserVersion: /Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1],
    });
    const saved = await saveDownload(JSON.stringify(har), filename);
    return {
      path: saved.path,
      bytes: saved.bytes,
      entries: records.length,
      downloadId: saved.downloadId,
      includeBodies,
      ...(redacted ? { redacted: true } : {}),
      sanitizeOutput: sanitize,
    };
  }
}

export const cdpNetworkTool = new CdpNetworkTool();
