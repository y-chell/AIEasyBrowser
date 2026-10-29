import { cdpSessionManager } from '@/utils/cdp-session-manager';
import {
  holdChildStart,
  once,
  releaseChildStart,
  type ChildStartHost,
} from '@/utils/cdp-child-start';
import { isSensitiveKey } from '@/utils/output-sanitizer';

/**
 * Request table of one held session (chrome_cdp_network).
 *
 * Chrome facts this relies on (measured on Chrome 156): Network events of a cross-site iframe or a
 * worker reach only its own child session, which needs its own Network.enable, and a re-created
 * iframe comes back as a new child session (held paused on start until it is enabled). A response
 * body can be read only from the session that loaded it and is gone once the document navigates,
 * so bodies are read at loadingFinished. requestWillBeSent lists only the headers the renderer set;
 * the ExtraInfo events carry what went on the wire, including Cookie and Set-Cookie, and may arrive
 * before or after the event they belong to.
 */

export type BodyMode = 'api' | 'all' | 'none';
export type BodyPart = 'request' | 'response';
export type RecordState = 'pending' | 'complete' | 'failed' | 'open' | 'closed';

export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
export const MAX_BODY_BYTES_LIMIT = 10 * 1024 * 1024;
export const DEFAULT_MAX_REQUESTS = 2000;
export const MAX_REQUESTS_LIMIT = 10_000;
export const BODY_BUDGET_BYTES = 32 * 1024 * 1024;
export const MAX_MESSAGES = 500;
export const MAX_MESSAGE_CHARS = 16 * 1024;
const MAX_PENDING_EXTRA = 500;
const API_TYPES = new Set(['Document', 'XHR', 'Fetch', 'Other']);
export const STREAM_TYPES = new Set(['WebSocket', 'EventSource']);
const NETWORK_TARGETS = new Set(['iframe', 'worker', 'shared_worker', 'service_worker']);
const ENABLE_PARAMS = {
  maxTotalBufferSize: 100 * 1024 * 1024,
  maxResourceBufferSize: 20 * 1024 * 1024,
  maxPostDataSize: 64 * 1024,
};
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type Headers = Record<string, string>;

export interface StoredBody {
  /** Text, or base64 when base64 is true. */
  text: string;
  base64: boolean;
  bytes: number;
  totalBytes: number;
  truncated: boolean;
}

export interface BodySlot {
  stored?: StoredBody;
  pending?: Promise<void>;
  error?: string;
  evicted?: boolean;
}

export interface NetworkMessage {
  index: number;
  ts: number;
  direction: 'sent' | 'received' | 'event';
  opcode?: number;
  event?: string;
  id?: string;
  data: string;
  length: number;
  truncated?: boolean;
}

export interface NetworkRecord {
  seq: number;
  /** '' = root session, else the child sessionId. */
  key: string;
  /** Session that finished loading it when that differs from key: the body is read there. */
  bodyKey?: string;
  requestId: string;
  url: string;
  method: string;
  resourceType: string;
  state: RecordState;
  frameId?: string;
  loaderId?: string;
  documentURL?: string;
  /** Epoch ms, and the CDP monotonic seconds of the same moment for later event timestamps. */
  startedAt: number;
  monotonicStart?: number;
  endedAt?: number;
  requestHeaders: Headers;
  requestHeadersExtra?: Headers;
  hasPostData?: boolean;
  initiator?: any;
  status?: number;
  statusText?: string;
  mimeType?: string;
  responseHeaders?: Headers;
  responseHeadersExtra?: Headers;
  protocol?: string;
  remoteIPAddress?: string;
  remotePort?: number;
  fromCache?: 'disk' | 'memory' | 'serviceWorker' | 'prefetch';
  timing?: any;
  encodedDataLength?: number;
  errorText?: string;
  canceled?: boolean;
  blockedReason?: string;
  redirectedFrom?: number;
  redirectedTo?: number;
  request: BodySlot;
  response: BodySlot;
  messages?: NetworkMessage[];
  messageCount?: number;
  messagesDropped?: number;
}

export interface NetworkOptions {
  bodies: BodyMode;
  maxBodyBytes: number;
  maxRequests: number;
}

interface PendingExtra {
  request?: Headers;
  response?: Headers;
}

export interface NetworkState {
  enabled: boolean;
  startedAt?: number;
  options: NetworkOptions;
  /** By seq, in insertion (= seq) order. */
  records: Map<number, NetworkRecord>;
  /** `${key}\n${requestId}` -> latest hop of that request. */
  latest: Map<string, NetworkRecord>;
  pendingExtra: Map<string, PendingExtra>;
  ready: Map<string, Promise<void>>;
  nextSeq: number;
  dropped: number;
  bodyBytes: number;
  evictedBodies: number;
  errors: string[];
}

export interface NetworkSessionHost extends ChildStartHost {
  targets: Map<string, { sessionId: string; type: string }>;
  ended?: unknown;
  network: NetworkState;
}

export function createNetworkState(): NetworkState {
  return {
    enabled: false,
    options: {
      bodies: 'api',
      maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
      maxRequests: DEFAULT_MAX_REQUESTS,
    },
    records: new Map(),
    latest: new Map(),
    pendingExtra: new Map(),
    ready: new Map(),
    nextSeq: 1,
    dropped: 0,
    bodyBytes: 0,
    evictedBodies: 0,
    errors: [],
  };
}

/** Empties the table; seq keeps counting so an old seq never names a new request. */
export function clearNetworkTable(state: NetworkState): number {
  const cleared = state.records.size;
  state.records.clear();
  state.latest.clear();
  state.pendingExtra.clear();
  state.bodyBytes = 0;
  state.evictedBodies = 0;
  state.dropped = 0;
  return cleared;
}

/** Detach ends Network in Chrome; the table stays readable. */
export function endNetwork(state: NetworkState) {
  state.enabled = false;
  state.ready.clear();
}

function noteError(state: NetworkState, message: string) {
  state.errors.push(message);
  if (state.errors.length > 20) state.errors.shift();
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function send(host: NetworkSessionHost, key: string, method: string, params: object = {}) {
  return cdpSessionManager.sendCommand(host.tabId, method, params, key || undefined);
}

function enableOn(host: NetworkSessionHost, key: string) {
  return once(host.network.ready, key, () =>
    send(host, key, 'Network.enable', ENABLE_PARAMS).then(() => undefined),
  );
}

/**
 * Starts recording on the root session (failure rejects the call) and every attached frame or
 * worker child (failures are returned per child). Starting again needs a stop first.
 */
export async function startNetwork(
  host: NetworkSessionHost,
  options: NetworkOptions,
): Promise<{ sessions: string[]; childErrors: Array<{ sessionId: string; error: string }> }> {
  const state = host.network;
  if (state.enabled) {
    throw new Error(
      'NETWORK_ACTIVE: network recording is already on in this session; stop it first',
    );
  }
  clearNetworkTable(state);
  state.options = options;
  state.errors = [];
  state.enabled = true;
  try {
    // Before enabling current children: a child created from now on waits for its Network.enable.
    await holdChildStart(host, 'network');
    await enableOn(host, '');
  } catch (error) {
    state.enabled = false;
    await releaseChildStart(host, 'network').catch(() => undefined);
    throw error;
  }
  state.startedAt = Date.now();
  const sessions = ['root'];
  const childErrors: Array<{ sessionId: string; error: string }> = [];
  for (const target of [...host.targets.values()]) {
    if (!NETWORK_TARGETS.has(target.type)) continue;
    try {
      await enableOn(host, target.sessionId);
      sessions.push(target.sessionId);
    } catch (error) {
      childErrors.push({ sessionId: target.sessionId, error: message(error) });
    }
  }
  return { sessions, childErrors };
}

/** Enables a new frame or worker child before the hub resumes it; failures are listed. */
export async function setupNetworkChild(
  host: NetworkSessionHost,
  sessionId: string,
  type: string | undefined,
) {
  if (!host.network.enabled || !NETWORK_TARGETS.has(type ?? '')) return;
  try {
    await enableOn(host, sessionId);
  } catch (error) {
    noteError(host.network, `enable in ${sessionId}: ${message(error)}`);
  }
}

/** Network.disable everywhere it was enabled, after bodies already being read are stored. */
export async function disableNetwork(host: NetworkSessionHost): Promise<string[]> {
  const state = host.network;
  if (!state.enabled) return [];
  await Promise.allSettled(
    [...state.records.values()].flatMap((record) =>
      [record.request.pending, record.response.pending].filter(Boolean),
    ),
  );
  state.enabled = false;
  const keys = [...state.ready.keys()];
  state.ready.clear();
  const errors: string[] = [];
  for (const key of keys) {
    if (key && !host.targets.has(key)) continue;
    try {
      await send(host, key, 'Network.disable');
    } catch (error) {
      errors.push(`${key || 'root'}: ${message(error)}`);
    }
  }
  return errors;
}

export async function stopNetwork(host: NetworkSessionHost): Promise<string[]> {
  const errors = await disableNetwork(host);
  try {
    await releaseChildStart(host, 'network');
  } catch (error) {
    errors.push(`disable wait on start: ${message(error)}`);
  }
  return errors;
}

function base64Bytes(text: string): number {
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((text.length * 3) / 4) - padding);
}

function storeBody(
  state: NetworkState,
  record: NetworkRecord,
  part: BodyPart,
  text: string,
  base64: boolean,
) {
  // Dropped or cleared while Chrome was reading it.
  if (state.records.get(record.seq) !== record) return;
  const slot = record[part];
  if (slot.stored) state.bodyBytes -= slot.stored.bytes;
  const max = state.options.maxBodyBytes;
  let stored: StoredBody;
  if (base64) {
    const totalBytes = base64Bytes(text);
    stored =
      totalBytes > max
        ? {
            text: text.slice(0, Math.floor(max / 3) * 4),
            base64,
            bytes: Math.floor(max / 3) * 3,
            totalBytes,
            truncated: true,
          }
        : { text, base64, bytes: totalBytes, totalBytes, truncated: false };
  } else {
    const bytes = encoder.encode(text);
    if (bytes.length > max) {
      // A cut inside a multi-byte character decodes to one trailing U+FFFD.
      const kept = decoder.decode(bytes.subarray(0, max)).replace(/�$/, '');
      stored = {
        text: kept,
        base64,
        bytes: encoder.encode(kept).length,
        totalBytes: bytes.length,
        truncated: true,
      };
    } else {
      stored = { text, base64, bytes: bytes.length, totalBytes: bytes.length, truncated: false };
    }
  }
  slot.stored = stored;
  slot.error = undefined;
  slot.evicted = false;
  state.bodyBytes += stored.bytes;
  for (const older of state.records.values()) {
    if (state.bodyBytes <= BODY_BUDGET_BYTES) break;
    if (older === record) continue;
    for (const olderSlot of [older.request, older.response]) {
      if (!olderSlot.stored) continue;
      state.bodyBytes -= olderSlot.stored.bytes;
      olderSlot.stored = undefined;
      olderSlot.evicted = true;
      state.evictedBodies += 1;
    }
  }
}

async function readBody(host: NetworkSessionHost, record: NetworkRecord, part: BodyPart) {
  const key = part === 'response' ? (record.bodyKey ?? record.key) : record.key;
  const result =
    part === 'response'
      ? await send(host, key, 'Network.getResponseBody', { requestId: record.requestId })
      : await send(host, key, 'Network.getRequestPostData', {
          requestId: record.requestId,
        });
  const text = part === 'response' ? result.body : result.postData;
  storeBody(host.network, record, part, String(text ?? ''), result.base64Encoded === true);
}

function capture(host: NetworkSessionHost, record: NetworkRecord, part: BodyPart) {
  const slot = record[part];
  const pending = readBody(host, record, part)
    .catch((error) => {
      slot.error = message(error);
    })
    .finally(() => {
      if (slot.pending === pending) slot.pending = undefined;
    });
  slot.pending = pending;
}

function unavailable(record: NetworkRecord, part: BodyPart, reason: string): Error {
  const slot = record[part];
  const why = slot.evicted
    ? 'evicted by the 32 MB body budget; '
    : slot.error
      ? `capture failed: ${slot.error}; `
      : '';
  return new Error(
    `NETWORK_BODY_UNAVAILABLE: the ${part} body of seq ${record.seq} is not stored (${why}live read: ${reason}). ` +
      'Bodies are kept from loadingFinished for the types chosen by start bodies; Chrome drops them after the document navigates',
  );
}

/** Stored body, else a live read from Chrome (kept for later reads). */
export async function loadBody(
  host: NetworkSessionHost,
  record: NetworkRecord,
  part: BodyPart,
): Promise<StoredBody> {
  const slot = record[part];
  if (slot.pending) await slot.pending;
  if (slot.stored) return slot.stored;
  const label = `seq ${record.seq}`;
  if (part === 'request') {
    if (!record.hasPostData) throw new Error(`NETWORK_NO_BODY: ${label} has no request body`);
  } else if (STREAM_TYPES.has(record.resourceType)) {
    throw new Error(
      `NETWORK_NO_BODY: ${label} is a ${record.resourceType}; read it with action messages`,
    );
  } else if (record.redirectedTo !== undefined) {
    throw new Error(
      `NETWORK_NO_BODY: ${label} is a redirect; the next hop is seq ${record.redirectedTo}`,
    );
  } else if (record.state === 'pending') {
    throw new Error(`NETWORK_BODY_PENDING: ${label} has not finished loading`);
  } else if (record.state === 'failed') {
    throw new Error(`NETWORK_NO_BODY: ${label} failed (${record.errorText ?? 'unknown error'})`);
  }
  const key = part === 'response' ? (record.bodyKey ?? record.key) : record.key;
  if (host.ended || (key && !host.targets.has(key))) {
    throw unavailable(record, part, 'the session that loaded it is gone');
  }
  try {
    await readBody(host, record, part);
  } catch (error) {
    throw unavailable(record, part, message(error));
  }
  if (!slot.stored) throw unavailable(record, part, 'the request left the table');
  return slot.stored;
}

function toEpoch(record: NetworkRecord, timestamp: unknown): number {
  return typeof timestamp === 'number' && record.monotonicStart !== undefined
    ? Math.round(record.startedAt + (timestamp - record.monotonicStart) * 1000)
    : Date.now();
}

function createRecord(
  state: NetworkState,
  key: string,
  requestId: string,
  fields: Pick<NetworkRecord, 'url' | 'method' | 'resourceType' | 'startedAt' | 'requestHeaders'>,
): NetworkRecord {
  const id = `${key}\n${requestId}`;
  const record: NetworkRecord = {
    seq: state.nextSeq++,
    key,
    requestId,
    state: 'pending',
    ...fields,
    request: {},
    response: {},
  };
  const extra = state.pendingExtra.get(id);
  if (extra) {
    state.pendingExtra.delete(id);
    if (extra.request) record.requestHeadersExtra = extra.request;
    if (extra.response) record.responseHeadersExtra = extra.response;
  }
  if (STREAM_TYPES.has(record.resourceType)) record.messages = [];
  state.records.set(record.seq, record);
  state.latest.set(id, record);
  while (state.records.size > state.options.maxRequests) {
    const oldest = state.records.values().next().value!;
    state.records.delete(oldest.seq);
    for (const slot of [oldest.request, oldest.response]) {
      if (slot.stored) state.bodyBytes -= slot.stored.bytes;
    }
    const oldestId = `${oldest.key}\n${oldest.requestId}`;
    if (state.latest.get(oldestId) === oldest) state.latest.delete(oldestId);
    state.dropped += 1;
  }
  return record;
}

function stash(state: NetworkState, id: string): PendingExtra {
  let extra = state.pendingExtra.get(id);
  if (!extra) {
    if (state.pendingExtra.size >= MAX_PENDING_EXTRA) {
      state.pendingExtra.delete(state.pendingExtra.keys().next().value!);
    }
    extra = {};
    state.pendingExtra.set(id, extra);
  }
  return extra;
}

function applyResponse(record: NetworkRecord, response: any) {
  if (!response || typeof response !== 'object') return;
  record.status = response.status;
  record.statusText = response.statusText;
  record.mimeType = response.mimeType;
  record.responseHeaders = response.headers ?? {};
  if (response.protocol) record.protocol = response.protocol;
  if (response.remoteIPAddress) record.remoteIPAddress = response.remoteIPAddress;
  if (typeof response.remotePort === 'number') record.remotePort = response.remotePort;
  if (response.timing) record.timing = response.timing;
  if (response.fromDiskCache) record.fromCache = 'disk';
  else if (response.fromServiceWorker) record.fromCache = 'serviceWorker';
  else if (response.fromPrefetchCache) record.fromCache = 'prefetch';
}

function wantsBody(state: NetworkState, record: NetworkRecord): boolean {
  const mode = state.options.bodies;
  if (mode === 'none' || STREAM_TYPES.has(record.resourceType)) return false;
  return mode === 'all' || API_TYPES.has(record.resourceType);
}

function pushMessage(
  record: NetworkRecord,
  entry: Omit<NetworkMessage, 'index' | 'ts' | 'data' | 'length'>,
  data: unknown,
  timestamp: unknown,
) {
  record.messages ??= [];
  record.messageCount = (record.messageCount ?? 0) + 1;
  const text = String(data ?? '');
  record.messages.push({
    index: record.messageCount,
    ts: toEpoch(record, timestamp),
    ...entry,
    data: text.length > MAX_MESSAGE_CHARS ? text.slice(0, MAX_MESSAGE_CHARS) : text,
    length: text.length,
    ...(text.length > MAX_MESSAGE_CHARS ? { truncated: true } : {}),
  });
  if (record.messages.length > MAX_MESSAGES) {
    record.messages.shift();
    record.messagesDropped = (record.messagesDropped ?? 0) + 1;
  }
}

/** Updates the table from one event while recording is on; the event filter does not apply. */
export function trackNetworkEvent(
  host: NetworkSessionHost,
  method: string,
  params: any,
  sessionId: string | undefined,
) {
  const state = host.network;
  if (method === 'Target.detachedFromTarget') {
    if (params?.sessionId) state.ready.delete(params.sessionId);
    return;
  }
  if (!state.enabled || !method.startsWith('Network.') || typeof params?.requestId !== 'string') {
    return;
  }
  const key = sessionId ?? '';
  const id = `${key}\n${params.requestId}`;
  let current = state.latest.get(id);
  let fromParent = false;
  if (!current && key && method !== 'Network.requestWillBeSent') {
    // A cross-site iframe's navigation is requested in the root session; the rest of it arrives
    // in the iframe's child session under the same requestId.
    current = state.latest.get(`
${params.requestId}`);
    fromParent = current !== undefined;
  }
  switch (method) {
    case 'Network.requestWillBeSent': {
      const request = params.request ?? {};
      if (current && params.redirectResponse) {
        applyResponse(current, params.redirectResponse);
        current.state = 'complete';
        current.endedAt = toEpoch(current, params.timestamp);
      }
      const record = createRecord(state, key, params.requestId, {
        url: String(request.url ?? '') + (request.urlFragment ?? ''),
        method: String(request.method ?? 'GET'),
        resourceType: params.type ?? 'Other',
        startedAt:
          typeof params.wallTime === 'number' ? Math.round(params.wallTime * 1000) : Date.now(),
        requestHeaders: request.headers ?? {},
      });
      if (typeof params.timestamp === 'number') record.monotonicStart = params.timestamp;
      if (params.frameId) record.frameId = params.frameId;
      if (params.loaderId) record.loaderId = params.loaderId;
      if (params.documentURL) record.documentURL = params.documentURL;
      if (params.initiator) record.initiator = params.initiator;
      if (current && params.redirectResponse) {
        record.redirectedFrom = current.seq;
        current.redirectedTo = record.seq;
      }
      if (request.hasPostData || typeof request.postData === 'string') {
        record.hasPostData = true;
        if (typeof request.postData === 'string') {
          storeBody(state, record, 'request', request.postData, false);
        } else if (state.options.bodies !== 'none') {
          // Longer than maxPostDataSize: Chrome keeps it only until the document navigates.
          capture(host, record, 'request');
        }
      }
      return;
    }
    case 'Network.requestWillBeSentExtraInfo':
      if (current && !current.requestHeadersExtra) current.requestHeadersExtra = params.headers;
      else stash(state, id).request = params.headers;
      return;
    case 'Network.responseReceivedExtraInfo': {
      let target = current;
      // The redirect response's wire headers can arrive after the next hop's requestWillBeSent.
      if (
        current?.redirectedFrom !== undefined &&
        current.status === undefined &&
        params.statusCode >= 300 &&
        params.statusCode < 400
      ) {
        const previous = state.records.get(current.redirectedFrom);
        if (previous && !previous.responseHeadersExtra) target = previous;
      }
      if (target && !target.responseHeadersExtra) target.responseHeadersExtra = params.headers;
      else stash(state, id).response = params.headers;
      return;
    }
    case 'Network.requestServedFromCache':
      if (current) current.fromCache ??= 'memory';
      return;
    case 'Network.responseReceived':
      if (!current) return;
      applyResponse(current, params.response);
      if (params.type) current.resourceType = params.type;
      return;
    case 'Network.loadingFinished':
      if (!current) return;
      current.state = 'complete';
      current.endedAt = toEpoch(current, params.timestamp);
      if (typeof params.encodedDataLength === 'number') {
        current.encodedDataLength = params.encodedDataLength;
      }
      if (fromParent) current.bodyKey = key;
      if (wantsBody(state, current)) capture(host, current, 'response');
      return;
    case 'Network.loadingFailed':
      if (!current) return;
      current.state = 'failed';
      current.endedAt = toEpoch(current, params.timestamp);
      current.errorText = params.errorText;
      if (params.canceled) current.canceled = true;
      if (params.blockedReason) current.blockedReason = params.blockedReason;
      return;
    case 'Network.webSocketCreated': {
      const record = createRecord(state, key, params.requestId, {
        url: String(params.url ?? ''),
        method: 'GET',
        resourceType: 'WebSocket',
        startedAt: Date.now(),
        requestHeaders: {},
      });
      if (params.initiator) record.initiator = params.initiator;
      return;
    }
    case 'Network.webSocketWillSendHandshakeRequest':
      if (!current) return;
      if (typeof params.wallTime === 'number')
        current.startedAt = Math.round(params.wallTime * 1000);
      if (typeof params.timestamp === 'number') current.monotonicStart = params.timestamp;
      current.requestHeaders = params.request?.headers ?? {};
      return;
    case 'Network.webSocketHandshakeResponseReceived': {
      if (!current) return;
      const response = params.response ?? {};
      current.status = response.status;
      current.statusText = response.statusText;
      current.responseHeaders = response.headers ?? {};
      if (response.requestHeaders) current.requestHeadersExtra = response.requestHeaders;
      current.state = 'open';
      return;
    }
    case 'Network.webSocketFrameSent':
    case 'Network.webSocketFrameReceived':
      if (!current) return;
      pushMessage(
        current,
        {
          direction: method === 'Network.webSocketFrameSent' ? 'sent' : 'received',
          opcode: params.response?.opcode,
        },
        params.response?.payloadData,
        params.timestamp,
      );
      return;
    case 'Network.webSocketFrameError':
      if (current) current.errorText = params.errorMessage;
      return;
    case 'Network.webSocketClosed':
      if (!current) return;
      current.state = 'closed';
      current.endedAt = toEpoch(current, params.timestamp);
      return;
    case 'Network.eventSourceMessageReceived':
      if (!current) return;
      pushMessage(
        current,
        { direction: 'event', event: params.eventName, id: params.eventId },
        params.data,
        params.timestamp,
      );
      return;
    default:
      return;
  }
}

export function requestHeadersOf(record: NetworkRecord): { headers: Headers; source: string } {
  return record.requestHeadersExtra
    ? { headers: record.requestHeadersExtra, source: 'wire' }
    : { headers: record.requestHeaders, source: 'renderer' };
}

export function responseHeadersOf(record: NetworkRecord): { headers: Headers; source: string } {
  return record.responseHeadersExtra
    ? { headers: record.responseHeadersExtra, source: 'wire' }
    : { headers: record.responseHeaders ?? {}, source: 'renderer' };
}

/** HTTP/2 pseudo headers (:authority, :path) are never credentials. */
export function isSensitiveHeader(name: string): boolean {
  return !name.startsWith(':') && isSensitiveKey(name);
}

export function findHeader(headers: Headers | undefined, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

function pairNames(value: string | undefined, separator: string): string[] {
  if (!value) return [];
  return value
    .split(separator)
    .map((part) => part.split(';')[0].split('=')[0].trim())
    .filter(Boolean);
}

/** Names of the credentials a request carried and received; never their values. */
export function authSummary(record: NetworkRecord) {
  const request = requestHeadersOf(record).headers;
  const response = responseHeadersOf(record).headers;
  const summary = {
    requestHeaders: Object.keys(request).filter(isSensitiveHeader),
    responseHeaders: Object.keys(response).filter(isSensitiveHeader),
    cookies: pairNames(findHeader(request, 'cookie'), ';'),
    setCookies: pairNames(findHeader(response, 'set-cookie'), '\n'),
  };
  const present = Object.entries(summary).filter(([, names]) => names.length > 0);
  return present.length ? Object.fromEntries(present) : undefined;
}
