import { cdpSessionManager } from '@/utils/cdp-session-manager';
import {
  loadBody,
  REPLAY_SOURCE_PREFIX,
  type NetworkRecord,
  type NetworkSessionHost,
} from '@/utils/cdp-network';

/**
 * Replay of one recorded request (chrome_cdp_network replay).
 *
 * The request is sent again with fetch from the session and frame that made it, so it carries that
 * frame's cookies, Origin, and Referer and goes through the same Network table and Fetch rules.
 * chrome_network_request was not reused: it runs in a content script of the active tab's top frame
 * and cannot reach a cross-site iframe or a worker. Measured on Chrome 156: fetch in an isolated
 * world (Page.createIsolatedWorld, also in an OOPIF child session) sends the frame's cookies and
 * Origin, is not affected by a page that replaced window.fetch, and the script's sourceURL appears
 * in the request's initiator stack, which links the new row to the replayed one. Workers have no
 * isolated world, so a worker request is replayed in the worker's own global scope. fetch drops
 * forbidden headers (Cookie, Origin, Host, ...) instead of sending them; they are reported.
 */

export const REPLAY_WORLD = 'aeb-replay';
export const MAX_REPLAY_BODY_BYTES = 10 * 1024 * 1024;
export const DEFAULT_REPLAY_TIMEOUT_MS = 30_000;
export const MAX_REPLAY_TIMEOUT_MS = 60_000;
const PREVIEW_CHARS = 2000;
const MAX_REPLAY_SOURCES = 200;
const WORKER_TYPES = new Set(['worker', 'shared_worker', 'service_worker']);
const FORBIDDEN_HEADERS = new Set([
  'accept-charset',
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'connection',
  'content-length',
  'cookie',
  'cookie2',
  'date',
  'dnt',
  'expect',
  'host',
  'keep-alive',
  'origin',
  'referer',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
]);

export type ReplayCredentials = 'include' | 'same-origin' | 'omit';

export interface ReplayInput {
  method: string;
  url?: string;
  body?: string;
  useOriginalBody?: boolean;
  headers?: Record<string, string>;
  removeHeaders?: string[];
  credentials: ReplayCredentials;
  timeoutMs: number;
}

export function isForbiddenHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.startsWith(':') ||
    lower.startsWith('proxy-') ||
    lower.startsWith('sec-') ||
    FORBIDDEN_HEADERS.has(lower)
  );
}

/** Original renderer headers with the overrides applied, minus what fetch would drop. */
export function replayHeaders(record: NetworkRecord, input: ReplayInput) {
  const remove = new Set(
    [...(input.removeHeaders ?? []), ...Object.keys(input.headers ?? {})].map((name) =>
      name.toLowerCase(),
    ),
  );
  const merged: Array<[string, string]> = [
    ...Object.entries(record.requestHeaders).filter(([name]) => !remove.has(name.toLowerCase())),
    ...Object.entries(input.headers ?? {}),
  ];
  const headers: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [name, value] of merged) {
    if (isForbiddenHeader(name)) dropped.push(name);
    else headers[name] = value;
  }
  return { headers, dropped };
}

function fail(code: string, text: string): never {
  throw new Error(`${code}: ${text}`);
}

function send<T = any>(host: NetworkSessionHost, key: string, method: string, params: object) {
  return cdpSessionManager.sendCommand<T>(host.tabId, method, params, key || undefined);
}

/** Session and execution context the request came from. */
async function replayContext(host: NetworkSessionHost, record: NetworkRecord) {
  // A cross-site iframe's navigation is recorded in the root session but its document lives in the
  // child session that finished loading it.
  const key = record.resourceType === 'Document' && record.bodyKey ? record.bodyKey : record.key;
  if (key && !host.targets.has(key)) {
    fail('REPLAY_CONTEXT_UNAVAILABLE', `the session that sent seq ${record.seq} is gone`);
  }
  const type = key ? host.targets.get(key)!.type : 'page';
  if (WORKER_TYPES.has(type)) return { key, contextId: undefined, where: type };
  let frameId = key === record.bodyKey ? undefined : record.frameId;
  try {
    if (!frameId) {
      const tree = await send(host, key, 'Page.getFrameTree', {});
      frameId = tree.frameTree.frame.id;
    }
    const world = await send<{ executionContextId: number }>(
      host,
      key,
      'Page.createIsolatedWorld',
      {
        frameId,
        worldName: REPLAY_WORLD,
      },
    );
    return { key, contextId: world.executionContextId, where: 'frame' };
  } catch (error) {
    fail(
      'REPLAY_CONTEXT_UNAVAILABLE',
      `frame of seq ${record.seq} is gone or not ready (${error instanceof Error ? error.message : error})`,
    );
  }
}

async function replayBody(host: NetworkSessionHost, record: NetworkRecord, input: ReplayInput) {
  if (input.body !== undefined) return { body: input.body };
  if (!input.useOriginalBody) return {};
  const stored = await loadBody(host, record, 'request');
  if (stored.truncated) {
    fail(
      'REPLAY_BODY_UNAVAILABLE',
      `the request body of seq ${record.seq} was kept only to ${stored.bytes} of ${stored.totalBytes} bytes; pass body`,
    );
  }
  return stored.base64 ? { bodyBase64: stored.text } : { body: stored.text };
}

/** Page-side script; the input is embedded as JSON data, never as code. */
export function replayExpression(id: string, data: Record<string, unknown>): string {
  return `(async (input) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    let body = input.body;
    if (input.bodyBase64 !== undefined) body = Uint8Array.from(atob(input.bodyBase64), (c) => c.charCodeAt(0));
    const response = await fetch(input.url, { method: input.method, headers: input.headers, body, credentials: input.credentials, signal: controller.signal });
    const text = await response.text();
    return { status: response.status, statusText: response.statusText, url: response.url, redirected: response.redirected, type: response.type, headers: [...response.headers], bodyChars: text.length, preview: text.slice(0, input.previewChars) };
  } catch (error) {
    return { error: String((error && error.message) || error), name: error && error.name };
  } finally {
    clearTimeout(timer);
  }
})(${JSON.stringify(data)})
//# sourceURL=${REPLAY_SOURCE_PREFIX}${id}`;
}

export async function replayRequest(
  host: NetworkSessionHost,
  record: NetworkRecord,
  input: ReplayInput,
  isPaused: (key: string) => boolean,
) {
  const state = host.network;
  if (!state.enabled) {
    fail(
      'NETWORK_NOT_RECORDING',
      'replay needs network recording on, so its row is recorded; call start',
    );
  }
  const body = await replayBody(host, record, input);
  const { headers, dropped } = replayHeaders(record, input);
  const context = await replayContext(host, record);
  if (isPaused(context.key)) {
    fail(
      'REPLAY_PAGE_PAUSED',
      `the ${context.key ? `session ${context.key}` : 'page'} is paused in the debugger; resume it first`,
    );
  }
  const id = String(state.nextReplayId++);
  state.replaySources.set(id, record.seq);
  while (state.replaySources.size > MAX_REPLAY_SOURCES) {
    state.replaySources.delete(state.replaySources.keys().next().value!);
  }
  const firstSeq = state.nextSeq;
  const url = input.url ?? record.url;
  const result = await send(host, context.key, 'Runtime.evaluate', {
    expression: replayExpression(id, {
      url,
      method: input.method,
      headers,
      credentials: input.credentials,
      timeoutMs: input.timeoutMs,
      previewChars: PREVIEW_CHARS,
      ...body,
    }),
    ...(context.contextId !== undefined ? { contextId: context.contextId } : {}),
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    fail(
      'REPLAY_FAILED',
      result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'exception',
    );
  }
  const value = result.result?.value ?? {};
  const rows = [...state.records.values()]
    .filter((item) => item.seq >= firstSeq && item.replayOf === record.seq)
    .map((item) => item.seq);
  return {
    replayOf: record.seq,
    replayId: id,
    sentFrom: context.key ? { sessionId: context.key, kind: context.where } : { kind: 'page' },
    request: {
      method: input.method,
      url,
      headers,
      ...(dropped.length ? { droppedHeaders: dropped } : {}),
      body:
        body.bodyBase64 !== undefined
          ? 'original (binary)'
          : body.body !== undefined
            ? 'set'
            : 'none',
      credentials: input.credentials,
    },
    ...(value.error !== undefined
      ? {
          error:
            value.name === 'AbortError' ? `timed out after ${input.timeoutMs} ms` : value.error,
        }
      : { response: value }),
    seqs: rows,
    linked: rows.length > 0,
  };
}
