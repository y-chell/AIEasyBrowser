import { cdpSessionManager } from '@/utils/cdp-session-manager';
import type { NetworkRecord, NetworkSessionHost } from '@/utils/cdp-network';

/**
 * Fetch interception of one held session (chrome_cdp_network intercept / rules / unintercept).
 *
 * Chrome facts this relies on (measured on Chrome 156): Fetch.enable on the tab's root session does
 * not pause requests of a cross-site iframe or a service worker; each of those child sessions needs
 * its own Fetch.enable, and a re-created iframe comes back without it (it is enabled while held
 * paused on start, together with Network). A dedicated worker session has no Fetch domain
 * ("'Fetch.enable' wasn't found"): its requests pause in the parent session, with networkId equal
 * to the requestId of the worker session's Network events. Subresource events arrive as
 * requestWillBeSent, requestPaused, then the ExtraInfo events; requestPaused may still come first,
 * so a note without its row is kept until the row appears. At the Request stage continueRequest
 * applies url, method, headers, and postData (sent base64); at the Response stage it accepts but
 * ignores those overrides, so only plain continue, fulfill, and fail are allowed there. A fulfilled
 * request gets responseReceived and loadingFinished but no responseReceivedExtraInfo, and its body
 * is readable with getResponseBody; failRequest ends in loadingFailed (net::ERR_*.Inspector).
 * Fetch.disable and detach both release requests that are still paused.
 *
 * Every paused request is answered by the handler at once: there is no manual hold, so removing a
 * rule, stopping, or an error in a rule can never leave a page waiting. Re-sending Fetch.enable
 * replaces the patterns of that session.
 */

export type InterceptStage = 'request' | 'response';
export type InterceptAction = 'continue' | 'fulfill' | 'fail' | 'log';

export const MAX_RULES = 50;
export const MAX_FULFILL_BODY_BYTES = 2 * 1024 * 1024;
const MAX_PATTERN_CHARS = 2000;
const MAX_PENDING_NOTES = 500;
const MAX_RECENT = 50;
const MAX_NOTES_PER_RECORD = 10;
const FETCH_TARGETS = new Set(['iframe', 'service_worker']);
export const RESOURCE_TYPES = [
  'Document',
  'Stylesheet',
  'Image',
  'Media',
  'Font',
  'Script',
  'TextTrack',
  'XHR',
  'Fetch',
  'Prefetch',
  'EventSource',
  'WebSocket',
  'Manifest',
  'SignedExchange',
  'Ping',
  'CSPViolationReport',
  'Preflight',
  'FedCM',
  'Other',
];
export const ERROR_REASONS = [
  'Failed',
  'Aborted',
  'TimedOut',
  'AccessDenied',
  'ConnectionClosed',
  'ConnectionReset',
  'ConnectionRefused',
  'ConnectionAborted',
  'ConnectionFailed',
  'NameNotResolved',
  'InternetDisconnected',
  'AddressUnreachable',
  'BlockedByClient',
  'BlockedByResponse',
];

export interface RuleInput {
  urlPattern: string;
  resourceTypes?: string[];
  stage?: InterceptStage;
  action: InterceptAction;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  removeHeaders?: string[];
  postData?: string;
  status?: number;
  body?: string;
  bodyBase64?: boolean;
  errorReason?: string;
}

export interface InterceptRule extends RuleInput {
  id: string;
  stage: InterceptStage;
  matcher: RegExp;
  addedAt: number;
  hits: number;
}

export interface InterceptNote {
  ruleId?: string;
  stage: InterceptStage;
  action: InterceptAction | 'pass';
  ts: number;
  changes?: string[];
  status?: number;
  errorReason?: string;
  responseStatus?: number;
  error?: string;
}

export interface InterceptState {
  rules: Map<string, InterceptRule>;
  nextId: number;
  /** Sessions where Fetch.enable was sent ('' = root). */
  enabled: Set<string>;
  /** Serializes Fetch.enable / disable so the last sent patterns are the current ones. */
  sync: Promise<void>;
  inFlight: Set<Promise<void>>;
  /** networkId -> notes whose row did not exist yet. */
  pending: Map<string, InterceptNote[]>;
  recent: Array<InterceptNote & { url: string; seq?: number; sessionId?: string }>;
  paused: number;
  unmatched: number;
  errors: string[];
}

export function createInterceptState(): InterceptState {
  return {
    rules: new Map(),
    nextId: 1,
    enabled: new Set(),
    sync: Promise.resolve(),
    inFlight: new Set(),
    pending: new Map(),
    recent: [],
    paused: 0,
    unmatched: 0,
    errors: [],
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function noteError(state: InterceptState, text: string) {
  state.errors.push(text);
  if (state.errors.length > 20) state.errors.shift();
}

function send(host: NetworkSessionHost, key: string, method: string, params: object = {}) {
  return cdpSessionManager.sendCommand(host.tabId, method, params, key || undefined);
}

/** Chrome's urlPattern glob: '*' any run, '?' one character, backslash escapes. */
export function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '\\' && index + 1 < pattern.length) {
      index += 1;
      source += pattern[index].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    } else if (char === '*') source += '[\\s\\S]*';
    else if (char === '?') source += '[\\s\\S]';
    else source += char.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

function patterns(state: InterceptState) {
  const list: Array<{ urlPattern: string; resourceType?: string; requestStage: string }> = [];
  const seen = new Set<string>();
  for (const rule of state.rules.values()) {
    const stage = rule.stage === 'response' ? 'Response' : 'Request';
    for (const resourceType of rule.resourceTypes?.length ? rule.resourceTypes : [undefined]) {
      const id = `${rule.urlPattern}\n${resourceType ?? ''}\n${stage}`;
      if (seen.has(id)) continue;
      seen.add(id);
      list.push({
        urlPattern: rule.urlPattern,
        ...(resourceType ? { resourceType } : {}),
        requestStage: stage,
      });
    }
  }
  return list;
}

function fetchKeys(host: NetworkSessionHost): string[] {
  return [
    '',
    ...[...host.targets.values()]
      .filter((target) => FETCH_TARGETS.has(target.type))
      .map((target) => target.sessionId),
  ];
}

/**
 * Sends the current patterns to the root session (failure rejects) and every iframe and service
 * worker child (failures returned), or Fetch.disable everywhere when no rule is left.
 */
function syncFetch(
  host: NetworkSessionHost,
): Promise<{ childErrors: Array<{ sessionId: string; error: string }> }> {
  const state = host.network.intercept;
  const run = state.sync.then(async () => {
    const childErrors: Array<{ sessionId: string; error: string }> = [];
    if (state.rules.size === 0) {
      const keys = [...state.enabled];
      state.enabled.clear();
      for (const key of keys) {
        if (key && !host.targets.has(key)) continue;
        try {
          await send(host, key, 'Fetch.disable');
        } catch (error) {
          if (!key) throw error;
          childErrors.push({ sessionId: key, error: message(error) });
        }
      }
      return { childErrors };
    }
    const params = { patterns: patterns(state) };
    for (const key of fetchKeys(host)) {
      try {
        await send(host, key, 'Fetch.enable', params);
        state.enabled.add(key);
      } catch (error) {
        if (!key) throw error;
        childErrors.push({ sessionId: key, error: message(error) });
      }
    }
    return { childErrors };
  });
  state.sync = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Fetch.enable on a new iframe or service worker child before the hub resumes it. */
export async function setupInterceptChild(
  host: NetworkSessionHost,
  sessionId: string,
  type: string | undefined,
) {
  const state = host.network.intercept;
  if (state.rules.size === 0 || !FETCH_TARGETS.has(type ?? '')) return;
  try {
    await send(host, sessionId, 'Fetch.enable', { patterns: patterns(state) });
    state.enabled.add(sessionId);
  } catch (error) {
    noteError(state, `enable in ${sessionId}: ${message(error)}`);
  }
}

export async function addRule(host: NetworkSessionHost, input: RuleInput) {
  const state = host.network.intercept;
  if (state.rules.size >= MAX_RULES) {
    throw new Error(`INTERCEPT_LIMIT: at most ${MAX_RULES} rules per session; remove one`);
  }
  if (input.urlPattern.length > MAX_PATTERN_CHARS) {
    throw new Error(`INVALID_ARGUMENT: urlPattern is longer than ${MAX_PATTERN_CHARS} chars`);
  }
  const rule: InterceptRule = {
    ...input,
    stage: input.stage ?? 'request',
    id: `rule-${state.nextId++}`,
    matcher: globToRegExp(input.urlPattern),
    addedAt: Date.now(),
    hits: 0,
  };
  state.rules.set(rule.id, rule);
  try {
    const { childErrors } = await syncFetch(host);
    return { rule, childErrors };
  } catch (error) {
    state.rules.delete(rule.id);
    // Put the previous patterns back (or disable when this was the only rule).
    await syncFetch(host).catch(() => undefined);
    throw error;
  }
}

/** Removes one rule or all; Fetch is disabled when none is left. */
export async function removeRules(
  host: NetworkSessionHost,
  id: string,
): Promise<{ removed: string[]; errors: string[] }> {
  const state = host.network.intercept;
  let removed: string[];
  if (id === 'all') {
    removed = [...state.rules.keys()];
    state.rules.clear();
  } else {
    if (!state.rules.has(id)) {
      throw new Error(`INTERCEPT_RULE_NOT_FOUND: no rule ${id} in this session; call action rules`);
    }
    state.rules.delete(id);
    removed = [id];
  }
  const errors: string[] = [];
  try {
    const { childErrors } = await syncFetch(host);
    errors.push(...childErrors.map((item) => `${item.sessionId}: ${item.error}`));
  } catch (error) {
    errors.push(`root: ${message(error)}`);
  }
  return { removed, errors };
}

/** Drops every rule and disables Fetch after paused requests being answered are done. */
export async function stopIntercept(host: NetworkSessionHost): Promise<string[]> {
  const state = host.network.intercept;
  await Promise.allSettled([...state.inFlight]);
  if (state.rules.size === 0 && state.enabled.size === 0) return [];
  return (await removeRules(host, 'all')).errors;
}

/** Detach released paused requests and ended Fetch in Chrome. */
export function endIntercept(state: InterceptState) {
  state.rules.clear();
  state.enabled.clear();
}

function stageOf(params: any): InterceptStage {
  return params.responseStatusCode !== undefined || params.responseErrorReason !== undefined
    ? 'response'
    : 'request';
}

export function matchRule(
  state: InterceptState,
  url: string,
  resourceType: string,
  stage: InterceptStage,
): InterceptRule | undefined {
  for (const rule of state.rules.values()) {
    if (rule.stage !== stage) continue;
    if (rule.resourceTypes?.length && !rule.resourceTypes.includes(resourceType)) continue;
    if (rule.matcher.test(url)) return rule;
  }
  return undefined;
}

const encoder = new TextEncoder();

function toBase64(text: string): string {
  const bytes = encoder.encode(text);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

/** The CDP command that answers a paused request under a rule, and what it changes. */
export function ruleCommand(
  rule: InterceptRule,
  params: any,
): { method: string; args: Record<string, unknown>; note: Partial<InterceptNote> } {
  const requestId = params.requestId;
  switch (rule.action) {
    case 'fail': {
      const errorReason = rule.errorReason ?? 'Failed';
      return {
        method: 'Fetch.failRequest',
        args: { requestId, errorReason },
        note: { errorReason },
      };
    }
    case 'fulfill': {
      const status = rule.status ?? 200;
      const headers = Object.entries(rule.headers ?? {}).map(([name, value]) => ({ name, value }));
      const body = rule.body ?? '';
      return {
        method: 'Fetch.fulfillRequest',
        args: {
          requestId,
          responseCode: status,
          responseHeaders: headers,
          body: rule.bodyBase64 ? body : toBase64(body),
        },
        note: { status },
      };
    }
    case 'continue': {
      if (rule.stage === 'response')
        return { method: 'Fetch.continueRequest', args: { requestId }, note: {} };
      const changes: string[] = [];
      const args: Record<string, unknown> = { requestId };
      if (rule.url !== undefined) {
        args.url = rule.url;
        changes.push('url');
      }
      if (rule.method !== undefined) {
        args.method = rule.method;
        changes.push('method');
      }
      if (rule.postData !== undefined) {
        args.postData = toBase64(rule.postData);
        changes.push('postData');
      }
      if (rule.headers || rule.removeHeaders) {
        const remove = new Set(
          [...(rule.removeHeaders ?? []), ...Object.keys(rule.headers ?? {})].map((name) =>
            name.toLowerCase(),
          ),
        );
        const original = Object.entries((params.request?.headers ?? {}) as Record<string, string>);
        args.headers = [
          ...original
            .filter(([name]) => !remove.has(name.toLowerCase()))
            .map(([name, value]) => ({ name, value })),
          ...Object.entries(rule.headers ?? {}).map(([name, value]) => ({ name, value })),
        ];
        for (const name of Object.keys(rule.headers ?? {})) changes.push(`header ${name}`);
        for (const name of rule.removeHeaders ?? []) changes.push(`remove header ${name}`);
      }
      return { method: 'Fetch.continueRequest', args, note: changes.length ? { changes } : {} };
    }
    default:
      return { method: 'Fetch.continueRequest', args: { requestId }, note: {} };
  }
}

/** The row a paused request belongs to: same session first, else a worker's session. */
function findRecord(
  host: NetworkSessionHost,
  key: string,
  networkId: string,
): NetworkRecord | undefined {
  const latest = host.network.latest;
  const own = latest.get(`${key}\n${networkId}`);
  if (own) return own;
  for (const [id, record] of latest) {
    if (id.endsWith(`\n${networkId}`)) return record;
  }
  return undefined;
}

export function attachNote(record: NetworkRecord, note: InterceptNote) {
  record.intercepts ??= [];
  record.intercepts.push(note);
  if (record.intercepts.length > MAX_NOTES_PER_RECORD) record.intercepts.shift();
}

function link(
  host: NetworkSessionHost,
  key: string,
  params: any,
  note: InterceptNote,
  url: string,
) {
  const state = host.network.intercept;
  const networkId: string | undefined = params.networkId;
  const record = networkId ? findRecord(host, key, networkId) : undefined;
  if (record) attachNote(record, note);
  else if (networkId) {
    if (state.pending.size >= MAX_PENDING_NOTES)
      state.pending.delete(state.pending.keys().next().value!);
    const list = state.pending.get(networkId) ?? [];
    list.push(note);
    state.pending.set(networkId, list);
  }
  state.recent.push({
    ...note,
    url: url.length > 300 ? `${url.slice(0, 300)}...` : url,
    ...(record ? { seq: record.seq } : {}),
    ...(key ? { sessionId: key } : {}),
  });
  if (state.recent.length > MAX_RECENT) state.recent.shift();
}

/** Notes that arrived before the row of this request existed. */
export function takePendingNotes(
  state: InterceptState,
  requestId: string,
): InterceptNote[] | undefined {
  const notes = state.pending.get(requestId);
  if (notes) state.pending.delete(requestId);
  return notes;
}

/** Answers one paused request; the fallback continue runs whatever went wrong before it. */
async function handlePaused(host: NetworkSessionHost, key: string, params: any) {
  const state = host.network.intercept;
  state.paused += 1;
  const stage = stageOf(params);
  const url = String(params.request?.url ?? '') + (params.request?.urlFragment ?? '');
  const rule = matchRule(state, url, String(params.resourceType ?? ''), stage);
  const note: InterceptNote = {
    stage,
    action: rule ? rule.action : 'pass',
    ts: Date.now(),
    ...(rule ? { ruleId: rule.id } : {}),
    ...(stage === 'response' && typeof params.responseStatusCode === 'number'
      ? { responseStatus: params.responseStatusCode }
      : {}),
  };
  let answered = false;
  try {
    if (rule) {
      rule.hits += 1;
      const command = ruleCommand(rule, params);
      Object.assign(note, command.note);
      await send(host, key, command.method, command.args);
    } else {
      state.unmatched += 1;
      await send(host, key, 'Fetch.continueRequest', { requestId: params.requestId });
    }
    answered = true;
  } catch (error) {
    note.error = message(error);
  }
  if (!answered && rule) {
    try {
      await send(host, key, 'Fetch.continueRequest', { requestId: params.requestId });
      note.error += '; continued unchanged';
    } catch (error) {
      // Fetch.disable or detach released it already.
      note.error += `; release: ${message(error)}`;
    }
  }
  if (note.error) noteError(state, `${rule?.id ?? 'pass'} ${url.slice(0, 200)}: ${note.error}`);
  link(host, key, params, note, url);
}

export function trackInterceptEvent(
  host: NetworkSessionHost,
  method: string,
  params: any,
  sessionId: string | undefined,
) {
  const state = host.network.intercept;
  if (method === 'Target.detachedFromTarget') {
    if (params?.sessionId) state.enabled.delete(params.sessionId);
    return;
  }
  if (method !== 'Fetch.requestPaused' || typeof params?.requestId !== 'string') return;
  // Answered even with no rule left: a pause that raced a removal must not hang the page.
  const pending = handlePaused(host, sessionId ?? '', params).finally(() => {
    state.inFlight.delete(pending);
  });
  state.inFlight.add(pending);
}

export function ruleView(rule: InterceptRule) {
  const { matcher: _matcher, ...view } = rule;
  return view;
}
