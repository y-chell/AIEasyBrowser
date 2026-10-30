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
import {
  addRule,
  ERROR_REASONS,
  MAX_FULFILL_BODY_BYTES,
  removeRules,
  RESOURCE_TYPES,
  ruleView,
  type InterceptAction,
  type RuleInput,
} from '@/utils/cdp-network-intercept';
import {
  DEFAULT_REPLAY_TIMEOUT_MS,
  MAX_REPLAY_BODY_BYTES,
  MAX_REPLAY_TIMEOUT_MS,
  replayRequest,
  type ReplayCredentials,
  type ReplayInput,
} from '@/utils/cdp-network-replay';
import { clampInt } from './cdp';

type Action =
  | 'start'
  | 'list'
  | 'get'
  | 'body'
  | 'messages'
  | 'har'
  | 'clear'
  | 'stop'
  | 'intercept'
  | 'rules'
  | 'unintercept'
  | 'replay';

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
  rule?: RuleInput;
  ruleId?: string;
  replay?: Partial<ReplayInput>;
}

const ACTIONS: Action[] = [
  'start',
  'list',
  'get',
  'body',
  'messages',
  'har',
  'clear',
  'stop',
  'intercept',
  'rules',
  'unintercept',
  'replay',
];
const RULE_ACTIONS: InterceptAction[] = ['continue', 'fulfill', 'fail', 'log'];
const CREDENTIALS: ReplayCredentials[] = ['include', 'same-origin', 'omit'];
const HEADER_NAME = /^[!#$%&'*+.^_`|~\w-]+$/;
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

function headerMap(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalid(`${label} must be an object`);
  for (const [name, item] of Object.entries(value)) {
    if (!HEADER_NAME.test(name)) invalid(`${label} has an invalid header name "${name}"`);
    if (typeof item !== 'string' || /[\r\n\0]/.test(item)) {
      invalid(`${label}.${name} must be a string without CR, LF, or NUL`);
    }
  }
  return value as Record<string, string>;
}

function nameList(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.some((name) => typeof name !== 'string' || !HEADER_NAME.test(name))
  ) {
    invalid(`${label} must be header names`);
  }
  return value as string[];
}

/** Checks a rule fully before any CDP IO; only the fields of its action are allowed. */
export function validateRule(input: unknown): RuleInput {
  if (!input || typeof input !== 'object') invalid('intercept requires rule');
  const rule = input as RuleInput;
  if (typeof rule.urlPattern !== 'string' || !rule.urlPattern) {
    invalid('rule.urlPattern must be a non-empty glob, e.g. "*://*/api/*"');
  }
  if (!RULE_ACTIONS.includes(rule.action))
    invalid(`rule.action must be ${RULE_ACTIONS.join(', ')}`);
  const stage = rule.stage ?? 'request';
  if (stage !== 'request' && stage !== 'response')
    invalid('rule.stage must be request or response');
  if (rule.resourceTypes !== undefined) {
    if (
      !Array.isArray(rule.resourceTypes) ||
      rule.resourceTypes.some((type) => !RESOURCE_TYPES.includes(type))
    ) {
      invalid(`rule.resourceTypes must be CDP resource types: ${RESOURCE_TYPES.join(', ')}`);
    }
  }
  const allowed: Record<InterceptAction, string[]> = {
    log: [],
    fail: ['errorReason'],
    fulfill: ['status', 'headers', 'body', 'bodyBase64'],
    continue: stage === 'request' ? ['url', 'method', 'headers', 'removeHeaders', 'postData'] : [],
  };
  const base = ['urlPattern', 'resourceTypes', 'stage', 'action'];
  for (const key of Object.keys(rule)) {
    if (base.includes(key) || allowed[rule.action].includes(key)) continue;
    invalid(
      rule.action === 'continue' && stage === 'response'
        ? `rule.${key} is not allowed: Chrome ignores request changes at the response stage`
        : `rule.${key} does not apply to action ${rule.action}`,
    );
  }
  headerMap(rule.headers, 'rule.headers');
  nameList(rule.removeHeaders, 'rule.removeHeaders');
  if (rule.url !== undefined) {
    try {
      new URL(rule.url);
    } catch {
      invalid('rule.url must be an absolute URL');
    }
  }
  if (rule.method !== undefined && !/^[A-Za-z]{1,20}$/.test(rule.method)) {
    invalid('rule.method must be an HTTP method');
  }
  if (rule.postData !== undefined && typeof rule.postData !== 'string') {
    invalid('rule.postData must be a string');
  }
  if (rule.errorReason !== undefined && !ERROR_REASONS.includes(rule.errorReason)) {
    invalid(`rule.errorReason must be ${ERROR_REASONS.join(', ')}`);
  }
  if (
    rule.status !== undefined &&
    (!Number.isInteger(rule.status) || rule.status < 100 || rule.status > 599)
  ) {
    invalid('rule.status must be an integer 100-599');
  }
  if (rule.body !== undefined) {
    if (typeof rule.body !== 'string') invalid('rule.body must be a string');
    if (rule.bodyBase64 && !/^[A-Za-z0-9+/]*={0,2}$/.test(rule.body)) {
      invalid('rule.body is not valid base64');
    }
    if (bytesOf(rule.body) > MAX_FULFILL_BODY_BYTES) {
      invalid(`rule.body is larger than ${MAX_FULFILL_BODY_BYTES} bytes`);
    }
  }
  return { ...rule, stage };
}

/** method is always explicit; a body is either given or the original one confirmed, never implied. */
export function validateReplay(input: unknown): ReplayInput {
  if (!input || typeof input !== 'object') {
    invalid('replay requires replay: {method, body or useOriginalBody}');
  }
  const replay = input as Partial<ReplayInput>;
  if (typeof replay.method !== 'string' || !/^[A-Za-z]{1,20}$/.test(replay.method)) {
    invalid('replay.method is required (e.g. "POST"); it is not copied from the recorded row');
  }
  const method = replay.method.toUpperCase();
  const hasBody = replay.body !== undefined;
  if (replay.body !== undefined && typeof replay.body !== 'string')
    invalid('replay.body must be a string');
  if (method === 'GET' || method === 'HEAD') {
    if (hasBody || replay.useOriginalBody)
      invalid(`replay.${hasBody ? 'body' : 'useOriginalBody'} is not allowed with ${method}`);
  } else if (hasBody === (replay.useOriginalBody === true)) {
    invalid(
      `replay with ${method} needs exactly one of replay.body (may be "") or replay.useOriginalBody: true`,
    );
  }
  if (hasBody && bytesOf(replay.body) > MAX_REPLAY_BODY_BYTES) {
    invalid(`replay.body is larger than ${MAX_REPLAY_BODY_BYTES} bytes`);
  }
  if (replay.url !== undefined) {
    try {
      new URL(replay.url);
    } catch {
      invalid('replay.url must be an absolute URL');
    }
  }
  const credentials = replay.credentials ?? 'include';
  if (!CREDENTIALS.includes(credentials))
    invalid(`replay.credentials must be ${CREDENTIALS.join(', ')}`);
  return {
    method,
    ...(replay.url !== undefined ? { url: replay.url } : {}),
    ...(hasBody ? { body: replay.body } : {}),
    ...(replay.useOriginalBody ? { useOriginalBody: true } : {}),
    ...(replay.headers ? { headers: headerMap(replay.headers, 'replay.headers') } : {}),
    ...(replay.removeHeaders
      ? { removeHeaders: nameList(replay.removeHeaders, 'replay.removeHeaders') }
      : {}),
    credentials,
    timeoutMs: clampInt(replay.timeoutMs, DEFAULT_REPLAY_TIMEOUT_MS, 1000, MAX_REPLAY_TIMEOUT_MS),
  };
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
    ...(record.intercepts?.length
      ? {
          intercepted: record.intercepts.map((note) =>
            note.ruleId ? `${note.ruleId}:${note.action}` : note.action,
          ),
        }
      : {}),
    ...(record.replayOf !== undefined ? { replayOf: record.replayOf } : {}),
    ...(record.replays?.length ? { replays: record.replays } : {}),
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
    ...(record.intercepts?.length ? { intercepts: record.intercepts } : {}),
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
    if (args.rule !== undefined && args.action !== 'intercept')
      invalid('rule applies to intercept only');
    if (args.ruleId !== undefined && args.action !== 'unintercept') {
      invalid('ruleId applies to unintercept only');
    }
    if (args.replay !== undefined && args.action !== 'replay')
      invalid('replay applies to replay only');
    const needsSeq =
      args.action === 'get' ||
      args.action === 'body' ||
      args.action === 'messages' ||
      args.action === 'replay';
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
      case 'intercept': {
        const rule = validateRule(args.rule);
        return async (session) => {
          this.requireActive(session);
          this.requireRecording(session);
          const { rule: added, childErrors } = await addRule(session, rule);
          return {
            rule: this.presentRule(ruleView(added), sanitize),
            rules: session.network.intercept.rules.size,
            ...(childErrors.length ? { childErrors } : {}),
          };
        };
      }
      case 'rules':
        return async (session) => {
          this.requireTable(session);
          const state = session.network.intercept;
          return {
            intercepting: state.rules.size > 0,
            rules: [...state.rules.values()].map((rule) =>
              this.presentRule(ruleView(rule), sanitize),
            ),
            sessions: [...state.enabled].map((key) => key || 'root'),
            paused: state.paused,
            unmatched: state.unmatched,
            recent: state.recent.map((note) => ({
              ...note,
              url: presentText(note.url, sanitize).text,
            })),
            ...(state.errors.length ? { errors: state.errors } : {}),
          };
        };
      case 'unintercept': {
        if (typeof args.ruleId !== 'string' || !args.ruleId) {
          invalid('unintercept requires ruleId from intercept or rules, or "all"');
        }
        const ruleId = args.ruleId;
        return async (session) => {
          this.requireTable(session);
          const { removed, errors } = await removeRules(session, ruleId);
          if (errors.length) {
            throw new Error(
              `INTERCEPT_STOP_INCOMPLETE: removed ${removed.join(', ') || 'nothing'}; ${errors.join('; ')}`,
            );
          }
          return { removed, rules: session.network.intercept.rules.size };
        };
      }
      case 'replay': {
        const replay = validateReplay(args.replay);
        return async (session) => {
          this.requireActive(session);
          const record = this.record(session, args.seq!);
          const result = await replayRequest(session, record, replay, (key) =>
            session.debug.pauses.has(key),
          );
          return this.presentReplay(result, sanitize);
        };
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

  private requireRecording(session: HeldSession) {
    if (!session.network.enabled) {
      throw new Error(
        'NETWORK_NOT_RECORDING: interception needs network recording on, so paused requests link to rows; call start',
      );
    }
  }

  private presentRule(rule: Record<string, any>, sanitize: boolean) {
    const view: Record<string, any> = { ...rule };
    if (view.headers) view.headers = presentHeaders(view.headers, sanitize);
    if (typeof view.body === 'string') {
      view.bodyChars = view.body.length;
      view.body =
        view.body.length > PREVIEW_CHARS ? `${view.body.slice(0, PREVIEW_CHARS)}...` : view.body;
      if (!view.bodyBase64) view.body = presentText(view.body, sanitize).text;
    }
    if (typeof view.postData === 'string')
      view.postData = presentText(view.postData, sanitize).text;
    return view;
  }

  private presentReplay(result: Awaited<ReturnType<typeof replayRequest>>, sanitize: boolean) {
    const response = (result as any).response;
    return {
      ...result,
      request: {
        ...result.request,
        url: presentText(result.request.url, sanitize).text,
        headers: presentHeaders(result.request.headers, sanitize),
      },
      ...(response
        ? {
            response: {
              ...response,
              url: presentText(String(response.url ?? ''), sanitize).text,
              headers: presentHeaders(Object.fromEntries(response.headers ?? []), sanitize),
              preview: presentText(String(response.preview ?? ''), sanitize).text,
            },
          }
        : {}),
      sanitizeOutput: sanitize,
    };
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
