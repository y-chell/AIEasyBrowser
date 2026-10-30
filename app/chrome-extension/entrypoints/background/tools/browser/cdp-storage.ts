import {
  createErrorResponse,
  createStructuredToolResult,
  type ToolResult,
} from '@/common/tool-handler';
import { TOOL_NAMES } from 'aieasybrowser-shared';
import { BaseBrowserToolExecutor } from '../base-browser';
import type { BrowserToolExecutionContext } from '../browser-session-context';
import { getOwnedSession, type HeldSession } from '@/utils/cdp-event-hub';
import { isSensitiveHeader } from '@/utils/cdp-network';
import { REDACTED } from '@/utils/cdp-network-har';
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  isSensitiveKey,
  redactInlineSecrets,
} from '@/utils/output-sanitizer';
import {
  cachedResponse,
  cacheEntries,
  cacheIdOf,
  cacheNames,
  CLEAR_ITEMS_BODY,
  DATABASES_BODY,
  deleteCookie,
  getCookies,
  httpOrigin,
  ITEMS_BODY,
  PAGE_MAX_STRING_CHARS,
  READ_STORE_BODY,
  REMOVE_ITEM_BODY,
  resolveOrigin,
  runInFrame,
  SET_ITEM_BODY,
  setCookie,
  storageTargets,
  type CacheEntry,
  type CdpCookie,
  type CookieInput,
  type PartitionKey,
  type StorageTarget,
} from '@/utils/cdp-storage';
import { clampInt } from './cdp';
import { decodeBase64, encodeBase64, fitBytes } from './cdp-network';

type Action =
  | 'origins'
  | 'cookies'
  | 'setCookie'
  | 'deleteCookie'
  | 'items'
  | 'setItem'
  | 'removeItem'
  | 'clearItems'
  | 'databases'
  | 'readStore'
  | 'caches'
  | 'cacheEntries'
  | 'cacheResponse';

type IdbKey = string | number | IdbKey[];

interface KeyRange {
  only?: IdbKey;
  lower?: IdbKey;
  upper?: IdbKey;
  lowerOpen?: boolean;
  upperOpen?: boolean;
}

interface CdpStorageParams {
  action?: Action;
  tabId?: number;
  windowId?: number;
  origin?: string;
  area?: 'local' | 'session';
  key?: string;
  prefix?: string;
  value?: string;
  name?: string;
  url?: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  expires?: number;
  partitionKey?: PartitionKey;
  database?: string;
  store?: string;
  index?: string;
  range?: KeyRange;
  direction?: 'next' | 'prev';
  cache?: string;
  pathFilter?: string;
  offset?: number;
  limit?: number;
  length?: number;
  maxOutputBytes?: number;
  sanitizeOutput?: boolean;
}

const COMMON = ['action', 'tabId', 'windowId', 'maxOutputBytes', 'sanitizeOutput'];
const COOKIE_FIELDS = ['domain', 'path', 'partitionKey'];
// Each action takes exactly these parameters; anything else is a mistake worth reporting.
const PARAMS: Record<Action, string[]> = {
  origins: [],
  cookies: ['url', 'name', 'offset', 'limit'],
  setCookie: [
    'name',
    'value',
    'url',
    ...COOKIE_FIELDS,
    'secure',
    'httpOnly',
    'sameSite',
    'expires',
  ],
  deleteCookie: ['name', 'url', ...COOKIE_FIELDS],
  items: ['origin', 'area', 'key', 'prefix', 'offset', 'limit'],
  setItem: ['origin', 'area', 'key', 'value'],
  removeItem: ['origin', 'area', 'key'],
  clearItems: ['origin', 'area'],
  databases: ['origin'],
  readStore: ['origin', 'database', 'store', 'index', 'range', 'direction', 'offset', 'limit'],
  caches: ['origin'],
  cacheEntries: ['origin', 'cache', 'pathFilter', 'offset', 'limit'],
  cacheResponse: ['origin', 'cache', 'url', 'offset', 'length'],
};
const ACTIONS = Object.keys(PARAMS) as Action[];
// Control characters are what the cookie syntax forbids.
// eslint-disable-next-line no-control-regex
const COOKIE_NAME = /^[^\s;=,\x00-\x1f\x7f]{1,256}$/;
// eslint-disable-next-line no-control-regex
const COOKIE_VALUE = /^[^;\x00-\x1f\x7f]{0,4096}$/;
const SITE = /^https?:\/\/[^/:?#\s]+$/;
const MAX_KEY_CHARS = 10_000;
const MAX_ITEM_CHARS = 1_000_000;
const TEXT_MIME = /^text\/|json|javascript|ecmascript|xml|x-www-form-urlencoded/i;
const encoder = new TextEncoder();

function invalid(message: string): never {
  throw new Error(`INVALID_ARGUMENT: ${message}`);
}

function bytesOf(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}

function text(value: unknown, label: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value) || value.length > max) {
    invalid(`${label} must be a ${allowEmpty ? '' : 'non-empty '}string of at most ${max} chars`);
  }
  return value;
}

function idbKey(value: unknown, label: string, depth = 0): IdbKey {
  if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) {
    return value;
  }
  if (Array.isArray(value) && depth < 4 && value.length <= 100) {
    return value.map((item) => idbKey(item, label, depth + 1));
  }
  invalid(
    `${label} must be an IndexedDB key: a string, a finite number, or an array of keys (Date and binary keys are not supported)`,
  );
}

function validateRange(input: unknown): KeyRange | undefined {
  if (input === undefined) return undefined;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    invalid('range must be an object');
  }
  const range = input as Record<string, unknown>;
  const unknown = Object.keys(range).filter(
    (key) => !['only', 'lower', 'upper', 'lowerOpen', 'upperOpen'].includes(key),
  );
  if (unknown.length) invalid(`range has unknown field ${unknown[0]}`);
  for (const flag of ['lowerOpen', 'upperOpen']) {
    if (range[flag] !== undefined && typeof range[flag] !== 'boolean') {
      invalid(`range.${flag} must be a boolean`);
    }
  }
  if (range.only !== undefined) {
    if (Object.keys(range).length > 1) invalid('range.only cannot be combined with bounds');
    return { only: idbKey(range.only, 'range.only') };
  }
  if (range.lower === undefined && range.upper === undefined) {
    invalid('range needs only, lower, or upper');
  }
  if (range.lowerOpen !== undefined && range.lower === undefined) {
    invalid('range.lowerOpen needs range.lower');
  }
  if (range.upperOpen !== undefined && range.upper === undefined) {
    invalid('range.upperOpen needs range.upper');
  }
  return {
    ...(range.lower !== undefined ? { lower: idbKey(range.lower, 'range.lower') } : {}),
    ...(range.upper !== undefined ? { upper: idbKey(range.upper, 'range.upper') } : {}),
    ...(range.lowerOpen !== undefined ? { lowerOpen: range.lowerOpen as boolean } : {}),
    ...(range.upperOpen !== undefined ? { upperOpen: range.upperOpen as boolean } : {}),
  };
}

function validatePartitionKey(value: unknown): PartitionKey | undefined {
  if (value === undefined) return undefined;
  const key = value as Record<string, unknown>;
  if (
    !key ||
    typeof key !== 'object' ||
    typeof key.topLevelSite !== 'string' ||
    !SITE.test(key.topLevelSite) ||
    typeof key.hasCrossSiteAncestor !== 'boolean' ||
    Object.keys(key).length !== 2
  ) {
    invalid(
      'partitionKey must be {topLevelSite: "https://site" (scheme and host, no port), hasCrossSiteAncestor: boolean}, as listed by cookies',
    );
  }
  return { topLevelSite: key.topLevelSite, hasCrossSiteAncestor: key.hasCrossSiteAncestor };
}

function cookieUrl(value: unknown): string {
  if (typeof value !== 'string' || !httpOrigin(value)) {
    invalid('url must be an absolute http(s) URL of a page in the tab');
  }
  return value;
}

function cookieDomain(value: unknown, url: string): string | undefined {
  if (value === undefined) return undefined;
  const host = new URL(url).hostname.toLowerCase();
  const domain = text(value, 'domain', 253).replace(/^\./, '').toLowerCase();
  if (host !== domain && !host.endsWith(`.${domain}`)) {
    invalid(`domain ${value} does not cover the url host ${host}`);
  }
  return value as string;
}

function cookiePath(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 1024) {
    invalid('path must start with "/" (at most 1024 chars)');
  }
  return value;
}

/** Redacts sensitive names and inline secrets in a tree; base64 payloads are left intact. */
function redactTree(value: unknown, maxChars: number): { value: unknown; redacted: boolean } {
  let redacted = false;
  const cut = (input: string) =>
    input.length > maxChars ? `${input.slice(0, maxChars)}...[${input.length} chars]` : input;
  const walk = (node: unknown, sanitize: boolean): unknown => {
    if (typeof node === 'string') {
      if (!sanitize) return cut(node);
      const shown = redactInlineSecrets(node);
      redacted ||= shown.redacted;
      return cut(shown.text);
    }
    if (Array.isArray(node)) return node.map((item) => walk(item, sanitize));
    if (!node || typeof node !== 'object') return node;
    const record = node as Record<string, unknown>;
    const binary = typeof record.$type === 'string' && typeof record.base64 === 'string';
    return Object.fromEntries(
      Object.entries(record).map(([key, item]) => {
        if (binary && key === 'base64') return [key, item];
        if (sanitize && key !== '$type' && isSensitiveKey(key)) {
          redacted = true;
          return [key, REDACTED];
        }
        return [key, walk(item, sanitize)];
      }),
    );
  };
  return { value: walk(value, true), redacted };
}

class CdpStorageTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.CDP_STORAGE;

  // Every action works on the held session alone; cookies must stay readable while paused.
  skipsTargetLock() {
    return true;
  }

  async execute(
    args: CdpStorageParams,
    executionContext?: BrowserToolExecutionContext,
  ): Promise<ToolResult> {
    const owner = executionContext?.owner;
    if (!owner) {
      return createErrorResponse(
        'CDP_SESSION_NOT_STARTED: chrome_cdp_storage requires a named task session',
      );
    }
    try {
      const explicit = await this.tryGetTab(args.tabId);
      if (args.tabId !== undefined && !explicit) {
        throw new Error(`TARGET_CLOSED: tab ${args.tabId} is not open`);
      }
      const tab = explicit || (await this.getActiveTabOrThrowInWindow(args.windowId));
      if (!tab.id) throw new Error('Active tab has no ID');
      // Validate before any CDP IO so a bad call reads and writes nothing.
      const run = this.prepare(args);
      const session = getOwnedSession(tab.id, owner);
      if (session.ended) {
        throw new Error(
          `CDP_SESSION_ENDED: tab ${session.tabId} debugger session ended (${session.ended.reason})`,
        );
      }
      const payload = await run(session);
      return createStructuredToolResult({
        success: true,
        tool: this.name,
        tabId: tab.id,
        action: args.action,
        ...payload,
      });
    } catch (error) {
      return createErrorResponse(
        `Error in CDP storage: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private prepare(args: CdpStorageParams): (session: HeldSession) => Promise<object> {
    const action = args.action;
    if (!action || !ACTIONS.includes(action)) invalid(`action must be ${ACTIONS.join(', ')}`);
    const allowed = PARAMS[action];
    for (const [key, value] of Object.entries(args)) {
      if (value !== undefined && !COMMON.includes(key) && !allowed.includes(key)) {
        invalid(
          `${key} does not apply to ${action}; it takes ${allowed.join(', ') || 'no parameters'}`,
        );
      }
    }
    const maxBytes = clampInt(args.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 1000, 2_000_000);
    const sanitize = args.sanitizeOutput !== false;
    const maxChars = Math.max(100, Math.floor(maxBytes / 4));
    const offset = clampInt(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const origin = allowed.includes('origin') ? this.origin(args.origin) : '';
    const area = allowed.includes('area') ? this.area(args.area) : 'local';
    const present = { maxBytes, sanitize, maxChars };

    switch (action) {
      case 'origins':
        return async (session) => ({
          origins: (await storageTargets(session)).map((target) => ({
            origin: target.origin,
            storageKey: target.storageKey,
            ...(target.key ? { sessionId: target.key } : {}),
            url: sanitize ? redactInlineSecrets(target.url).text : target.url,
            frames: target.frames,
          })),
        });
      case 'cookies': {
        const url = args.url === undefined ? undefined : cookieUrl(args.url);
        const name = args.name === undefined ? undefined : text(args.name, 'name', 256);
        const limit = clampInt(args.limit, 100, 1, 1000);
        return async (session) => {
          if (url) await this.requireTabUrl(session, url);
          const cookies = (await getCookies(session, url ? [url] : undefined))
            .filter((cookie) => name === undefined || cookie.name === name)
            .sort((a, b) =>
              `${a.domain}\0${a.path}\0${a.name}`.localeCompare(
                `${b.domain}\0${b.path}\0${b.name}`,
              ),
            );
          const page = this.page(
            cookies.slice(offset, offset + limit).map((cookie) => this.cookie(cookie, sanitize)),
            maxBytes,
          );
          return {
            ...(url ? { url } : { scope: 'every frame of the tab' }),
            total: cookies.length,
            offset,
            cookies: page.items,
            ...this.more(offset, page, cookies.length),
            sanitizeOutput: sanitize,
          };
        };
      }
      case 'setCookie': {
        const input = this.cookieInput(args);
        return async (session) => {
          await this.requireTabUrl(session, input.url);
          return { cookie: this.cookie(await setCookie(session, input), sanitize) };
        };
      }
      case 'deleteCookie': {
        const url = cookieUrl(args.url);
        const match = {
          name: text(args.name, 'name', 256),
          url,
          domain: cookieDomain(args.domain, url),
          path: cookiePath(args.path),
          partitionKey: validatePartitionKey(args.partitionKey),
        };
        return async (session) => {
          await this.requireTabUrl(session, url);
          const deleted = await deleteCookie(session, match);
          return { deleted: deleted.map((cookie) => this.cookie(cookie, sanitize)) };
        };
      }
      case 'items': {
        if (args.key !== undefined && args.prefix !== undefined) {
          invalid('items takes key or prefix, not both');
        }
        const input = {
          area,
          key: args.key === undefined ? undefined : text(args.key, 'key', MAX_KEY_CHARS),
          prefix:
            args.prefix === undefined ? undefined : text(args.prefix, 'prefix', MAX_KEY_CHARS),
          offset,
          limit: clampInt(args.limit, 100, 1, 1000),
          maxStringChars: PAGE_MAX_STRING_CHARS,
        };
        return async (session) => {
          const target = await resolveOrigin(session, origin);
          const result = await runInFrame(session, target, ITEMS_BODY, input);
          let redacted = false;
          const items = (result.items as Array<{ key: string; value: string; chars?: number }>).map(
            (item) => {
              const shown = this.item(item.key, item.value, present);
              redacted ||= shown.redacted;
              return {
                key: item.key,
                value: shown.value,
                chars: item.chars ?? item.value.length,
                ...(shown.truncated ? { truncated: true } : {}),
              };
            },
          );
          const page = this.page(items, maxBytes);
          return {
            ...this.where(target, area),
            total: result.total,
            offset,
            items: page.items,
            ...this.more(offset, page, result.total),
            ...(redacted ? { redacted: true } : {}),
            sanitizeOutput: sanitize,
          };
        };
      }
      case 'setItem': {
        const input = {
          area,
          key: text(args.key, 'key', MAX_KEY_CHARS, true),
          value: text(args.value, 'value', MAX_ITEM_CHARS, true),
        };
        return async (session) => {
          const target = await resolveOrigin(session, origin);
          const result = await runInFrame(session, target, SET_ITEM_BODY, input);
          return { ...this.where(target, area), key: input.key, ...result };
        };
      }
      case 'removeItem': {
        const input = { area, key: text(args.key, 'key', MAX_KEY_CHARS, true) };
        return async (session) => {
          const target = await resolveOrigin(session, origin);
          const result = await runInFrame(session, target, REMOVE_ITEM_BODY, input);
          return { ...this.where(target, area), key: input.key, ...result };
        };
      }
      case 'clearItems':
        return async (session) => {
          const target = await resolveOrigin(session, origin);
          const result = await runInFrame(session, target, CLEAR_ITEMS_BODY, { area });
          return { ...this.where(target, area), ...result };
        };
      case 'databases':
        return async (session) => {
          const target = await resolveOrigin(session, origin);
          const result = await runInFrame(session, target, DATABASES_BODY, {
            maxStringChars: maxChars,
          });
          return { ...this.where(target), ...result };
        };
      case 'readStore': {
        if (args.direction !== undefined && !['next', 'prev'].includes(args.direction)) {
          invalid('direction must be next or prev');
        }
        const input = {
          database: text(args.database, 'database', 1000, true),
          store: text(args.store, 'store', 1000, true),
          index: args.index === undefined ? undefined : text(args.index, 'index', 1000, true),
          range: validateRange(args.range),
          direction: args.direction ?? 'next',
          offset,
          limit: clampInt(args.limit, 20, 1, 500),
          maxStringChars: Math.min(PAGE_MAX_STRING_CHARS, maxChars),
        };
        return async (session) => {
          const target = await resolveOrigin(session, origin);
          const result = await runInFrame(session, target, READ_STORE_BODY, input);
          const shown = sanitize
            ? redactTree(result.entries, maxChars)
            : { value: result.entries, redacted: false };
          const page = this.page(shown.value as object[], maxBytes);
          return {
            ...this.where(target),
            database: input.database,
            store: input.store,
            ...(input.index !== undefined ? { index: input.index } : {}),
            total: result.total,
            offset,
            entries: page.items,
            ...this.more(offset, page, result.total),
            ...(shown.redacted ? { redacted: true } : {}),
            sanitizeOutput: sanitize,
          };
        };
      }
      case 'caches':
        return async (session) => {
          const target = await resolveOrigin(session, origin);
          const caches = await cacheNames(session, target);
          return { ...this.where(target), caches: caches.map((cache) => cache.cacheName).sort() };
        };
      case 'cacheEntries': {
        const cache = text(args.cache, 'cache', 1000, true);
        const pathFilter =
          args.pathFilter === undefined ? undefined : text(args.pathFilter, 'pathFilter', 2000);
        const limit = clampInt(args.limit, 50, 1, 500);
        return async (session) => {
          const target = await resolveOrigin(session, origin);
          const cacheId = await cacheIdOf(session, target, cache);
          const result = await cacheEntries(session, target, cacheId, offset, limit, pathFilter);
          const page = this.page(
            result.cacheDataEntries.map((entry) => this.cacheEntry(entry, sanitize)),
            maxBytes,
          );
          const shown = offset + page.items.length;
          return {
            ...this.where(target),
            cache,
            ...(pathFilter ? { pathFilter } : {}),
            offset,
            entries: page.items,
            nextOffset: shown,
            // returnCount counts the whole cache; with pathFilter only a full page means more.
            hasMore: pathFilter
              ? page.truncated || result.cacheDataEntries.length === limit
              : shown < result.returnCount,
            ...(pathFilter ? {} : { total: result.returnCount }),
            ...(page.truncated ? { pageTruncatedByBytes: true } : {}),
          };
        };
      }
      case 'cacheResponse': {
        const cache = text(args.cache, 'cache', 1000, true);
        const url = cookieUrl(args.url);
        return async (session) => {
          const target = await resolveOrigin(session, origin);
          const cacheId = await cacheIdOf(session, target, cache);
          const { entry, base64 } = await cachedResponse(session, target, cacheId, url);
          return {
            ...this.where(target),
            cache,
            ...this.cacheBody(entry, base64, args, maxBytes, sanitize),
          };
        };
      }
      default:
        invalid(`action must be ${ACTIONS.join(', ')}`);
    }
  }

  private origin(value: unknown): string {
    const origin = typeof value === 'string' ? httpOrigin(value) : undefined;
    if (!origin || origin !== value) {
      invalid(
        'origin must be an http(s) origin such as "https://example.com", as listed by origins',
      );
    }
    return origin;
  }

  private area(value: unknown): 'local' | 'session' {
    if (value !== 'local' && value !== 'session') invalid('area must be local or session');
    return value;
  }

  private cookieInput(args: CdpStorageParams): CookieInput {
    const url = cookieUrl(args.url);
    if (args.value === undefined) invalid('setCookie requires value');
    if (!COOKIE_VALUE.test(args.value)) {
      invalid('value must be at most 4096 chars without ";" or control characters');
    }
    if (typeof args.name !== 'string' || !COOKIE_NAME.test(args.name)) {
      invalid('name must be 1-256 chars without whitespace, ";", "=", "," or control characters');
    }
    for (const flag of ['secure', 'httpOnly'] as const) {
      if (args[flag] !== undefined && typeof args[flag] !== 'boolean') {
        invalid(`${flag} must be a boolean`);
      }
    }
    if (args.sameSite !== undefined && !['Strict', 'Lax', 'None'].includes(args.sameSite)) {
      invalid('sameSite must be Strict, Lax, or None');
    }
    if (args.expires !== undefined) {
      // A past expiry would silently delete the cookie; deleteCookie is the explicit way.
      if (typeof args.expires !== 'number' || !(args.expires > Date.now() / 1000)) {
        invalid(
          'expires must be a future time in seconds since the epoch (omit for a session cookie)',
        );
      }
    }
    const input: CookieInput = {
      name: args.name,
      value: args.value,
      url,
      domain: cookieDomain(args.domain, url),
      path: cookiePath(args.path),
      secure: args.secure,
      httpOnly: args.httpOnly,
      sameSite: args.sameSite,
      expires: args.expires,
      partitionKey: validatePartitionKey(args.partitionKey),
    };
    return Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    ) as unknown as CookieInput;
  }

  /** Cookie urls must belong to a frame of the tab, so a call cannot reach other sites' cookies. */
  private async requireTabUrl(session: HeldSession, url: string) {
    const origin = httpOrigin(url)!;
    const targets = await storageTargets(session);
    if (!targets.some((target) => target.origin === origin)) {
      throw new Error(
        `STORAGE_ORIGIN_NOT_FOUND: no frame of tab ${session.tabId} has origin ${origin}; origins: ${[...new Set(targets.map((target) => target.origin))].join(', ') || 'none'}`,
      );
    }
  }

  private where(target: StorageTarget, area?: string) {
    return {
      origin: target.origin,
      storageKey: target.storageKey,
      ...(area ? { area } : {}),
    };
  }

  private cookie(cookie: CdpCookie, sanitize: boolean) {
    return {
      name: cookie.name,
      value: sanitize ? REDACTED : cookie.value,
      ...(sanitize ? { valueChars: cookie.value.length } : {}),
      domain: cookie.domain,
      path: cookie.path,
      ...(cookie.session ? { session: true } : { expires: cookie.expires }),
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
      ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {}),
      size: cookie.size,
    };
  }

  private item(
    key: string,
    value: string,
    options: { sanitize: boolean; maxChars: number },
  ): { value: string; redacted: boolean; truncated: boolean } {
    let shown = value;
    let redacted = false;
    if (options.sanitize) {
      if (isSensitiveKey(key)) {
        shown = REDACTED;
        redacted = true;
      } else {
        let parsed: unknown;
        try {
          parsed = /^\s*[[{]/.test(value) ? JSON.parse(value) : undefined;
        } catch {
          parsed = undefined;
        }
        const result =
          parsed === undefined
            ? redactInlineSecrets(value)
            : (() => {
                const tree = redactTree(parsed, Number.MAX_SAFE_INTEGER);
                return {
                  text: tree.redacted ? JSON.stringify(tree.value) : value,
                  redacted: tree.redacted,
                };
              })();
        shown = result.text;
        redacted = result.redacted;
      }
    }
    const truncated = shown.length > options.maxChars;
    return { value: truncated ? shown.slice(0, options.maxChars) : shown, redacted, truncated };
  }

  private cacheEntry(entry: CacheEntry, sanitize: boolean) {
    const headers = (list: Array<{ name: string; value: string }>) =>
      Object.fromEntries(
        list.map(({ name, value }) => [
          name,
          sanitize && isSensitiveHeader(name) ? REDACTED : value,
        ]),
      );
    return {
      url: sanitize ? redactInlineSecrets(entry.requestURL).text : entry.requestURL,
      method: entry.requestMethod,
      status: entry.responseStatus,
      ...(entry.responseStatusText ? { statusText: entry.responseStatusText } : {}),
      type: entry.responseType,
      time: entry.responseTime,
      requestHeaders: headers(entry.requestHeaders),
      responseHeaders: headers(entry.responseHeaders),
    };
  }

  private cacheBody(
    entry: CacheEntry,
    base64: string,
    args: CdpStorageParams,
    maxBytes: number,
    sanitize: boolean,
  ) {
    const bytes = decodeBase64(base64);
    const mimeType = entry.responseHeaders.find(
      (header) => header.name.toLowerCase() === 'content-type',
    )?.value;
    const base = {
      url: sanitize ? redactInlineSecrets(entry.requestURL).text : entry.requestURL,
      status: entry.responseStatus,
      ...(mimeType ? { mimeType } : {}),
      totalBytes: bytes.length,
    };
    const start = clampInt(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    let decoded: string | undefined;
    if (!mimeType || TEXT_MIME.test(mimeType)) {
      try {
        decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        decoded = undefined;
      }
    }
    if (decoded === undefined) {
      if (start > bytes.length) invalid(`offset ${start} is past body length ${bytes.length}`);
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
    if (start > decoded.length) invalid(`offset ${start} is past body length ${decoded.length}`);
    const end = Math.min(
      decoded.length,
      start + clampInt(args.length, decoded.length, 1, 2_000_000),
    );
    const limitedEnd = Math.max(fitBytes(decoded, start, end, maxBytes), Math.min(end, start + 1));
    const slice = decoded.slice(start, limitedEnd);
    const shown = sanitize ? redactInlineSecrets(slice) : { text: slice, redacted: false };
    return {
      ...base,
      offset: start,
      endOffset: limitedEnd,
      unit: 'chars',
      totalChars: decoded.length,
      text: shown.text,
      hasMore: limitedEnd < decoded.length,
      ...(shown.redacted ? { redacted: true } : {}),
      sanitizeOutput: sanitize,
    };
  }

  /** Keeps the leading items that fit maxBytes, always at least one. */
  private page<T>(items: T[], maxBytes: number): { items: T[]; truncated: boolean } {
    const kept: T[] = [];
    let used = 0;
    for (const item of items) {
      const size = bytesOf(item);
      if (kept.length > 0 && used + size > maxBytes) return { items: kept, truncated: true };
      kept.push(item);
      used += size;
    }
    return { items: kept, truncated: false };
  }

  private more(offset: number, page: { items: unknown[]; truncated: boolean }, total: number) {
    const nextOffset = offset + page.items.length;
    return {
      nextOffset,
      hasMore: nextOffset < total,
      ...(page.truncated ? { pageTruncatedByBytes: true } : {}),
    };
  }
}

export const cdpStorageTool = new CdpStorageTool();
