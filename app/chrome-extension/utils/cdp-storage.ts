import { cdpSessionManager } from '@/utils/cdp-session-manager';
import type { HeldSession } from '@/utils/cdp-event-hub';

/**
 * Storage of a tab held by chrome_cdp_session (chrome_cdp_storage).
 *
 * Measured on Chrome 156:
 * - chrome.debugger does not expose the DOMStorage and IndexedDB domains to extensions (-32601
 *   "wasn't found", in the root and in OOPIF child sessions). local/sessionStorage and IndexedDB are
 *   therefore read through the page APIs in an isolated world of a frame of the origin: the isolated
 *   world shares the frame's storage partition (writes are visible to the main world, also in a
 *   cross-site iframe) and is not affected by a page that patched Storage or indexedDB.
 *   indexedDB.open(name) without a version opens an existing database read-only in practice.
 * - CacheStorage works, but a storage key is only accepted in the session that renders the frame:
 *   the key of a cross-site iframe ("http://localhost:P/^0http://127.0.0.1") fails in the root
 *   session with "No frame found for given storage key" and works in its child session;
 *   securityOrigin does not select a partitioned key. Storage.getStorageKeyForFrame works in both.
 *   While the session is paused in the debugger CacheStorage commands never answer, like page JS,
 *   so both check the pause state first.
 * - Cookies use Network.getCookies/setCookie/deleteCookies on the root session, not chrome.cookies:
 *   the extension has no cookies permission and one cookie path is enough. Network covers httpOnly,
 *   partitioned cookies (partitionKey in the result), and cookies of cross-site iframes, and
 *   answers while the page is paused. getCookies without urls returns the cookies of every frame
 *   of the tab including OOPIFs; with urls it matches each url by scheme, host, and path (a Secure
 *   cookie is not returned for http except on localhost/127.0.0.1). setCookie with a domain uses
 *   it even when it does not match the url, so the tool checks that itself. SameSite=None without
 *   Secure returns success:false; Partitioned without Secure throws "Sanitizing cookie failed"; a
 *   Secure cookie for a non-local http url returns success:true and is never visible. deleteCookies
 *   without partitionKey deletes only the unpartitioned cookie, a wrong partitionKey deletes
 *   nothing, and neither reports it, so deletion lists matches before and verifies after.
 *   Storage.getCookies returns the whole browser's cookies and is not used.
 * Iframes nested inside a cross-site iframe are not covered (B1 attaches one level).
 */

export const STORAGE_WORLD = 'aeb-storage';
export const PAGE_TIMEOUT_MS = 10_000;
/** Strings longer than this are cut in the page; the tool truncates further after redaction. */
export const PAGE_MAX_STRING_CHARS = 100_000;
const MAX_DATABASES = 100;
const MAX_CACHE_SCAN = 2000;

export interface StorageTarget {
  origin: string;
  storageKey: string;
  /** '' = the tab's root session, else the child sessionId. */
  key: string;
  frameId: string;
  url: string;
  frames: number;
}

interface FrameNode {
  frame: { id: string; url: string; securityOrigin?: string };
  childFrames?: FrameNode[];
}

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

function send<T = any>(host: HeldSession, key: string, method: string, params: object) {
  return cdpSessionManager.sendCommand<T>(host.tabId, method, params, key || undefined);
}

export function httpOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

/** Origins with storage in the tab: the root session and every attached cross-site iframe. */
export async function storageTargets(host: HeldSession): Promise<StorageTarget[]> {
  const keys = [
    '',
    ...[...host.targets.values()]
      .filter((target) => target.type === 'iframe')
      .map((target) => target.sessionId),
  ];
  const targets: StorageTarget[] = [];
  for (const key of keys) {
    let tree: FrameNode;
    try {
      tree = (await send<{ frameTree: FrameNode }>(host, key, 'Page.getFrameTree', {})).frameTree;
    } catch (error) {
      // A child that detached between status and this call simply has no storage to offer.
      if (!key) throw error;
      continue;
    }
    const groups = new Map<string, { frameId: string; url: string; frames: number }>();
    const walk = (node: FrameNode) => {
      const origin = httpOrigin(node.frame.securityOrigin) ?? httpOrigin(node.frame.url);
      if (origin) {
        const group = groups.get(origin);
        if (group) group.frames += 1;
        else groups.set(origin, { frameId: node.frame.id, url: node.frame.url, frames: 1 });
      }
      for (const child of node.childFrames || []) walk(child);
    };
    walk(tree);
    for (const [origin, group] of groups) {
      let storageKey: string | undefined;
      try {
        storageKey = (
          await send<{ storageKey: string }>(host, key, 'Storage.getStorageKeyForFrame', {
            frameId: group.frameId,
          })
        ).storageKey;
      } catch {
        // The frame navigated away meanwhile; it is listed again once it has a document.
        continue;
      }
      targets.push({ origin, storageKey, key, ...group });
    }
  }
  return targets;
}

/** The single storage partition of origin in the tab; other partitions fail instead of guessing. */
export async function resolveOrigin(host: HeldSession, origin: string): Promise<StorageTarget> {
  const all = await storageTargets(host);
  const matching = all.filter((target) => target.origin === origin);
  if (!matching.length) {
    fail(
      'STORAGE_ORIGIN_NOT_FOUND',
      `no frame of tab ${host.tabId} has origin ${origin}; origins: ${[...new Set(all.map((target) => target.origin))].join(', ') || 'none'}`,
    );
  }
  const keys = new Set(matching.map((target) => target.storageKey));
  if (keys.size > 1) {
    fail(
      'STORAGE_ORIGIN_AMBIGUOUS',
      `origin ${origin} has ${keys.size} storage partitions in tab ${host.tabId} (${[...keys].join(', ')})`,
    );
  }
  return matching[0];
}

export function requireRunning(host: HeldSession, target: StorageTarget) {
  if (host.debug.pauses.has(target.key)) {
    fail(
      'STORAGE_PAGE_PAUSED',
      `the ${target.key ? `session ${target.key}` : 'page'} of ${target.origin} is paused in the debugger; resume it first`,
    );
  }
}

/**
 * Page-side wrapper: the input is JSON data, never code. The frame's origin is checked before the
 * body runs, so a navigation between resolve and evaluate cannot write into another origin.
 */
export function pageExpression(body: string, input: Record<string, unknown>): string {
  return `(async (input) => {
  const fail = (code, message) => ({ error: { code, message } });
  if (self.origin !== input.origin) return fail('STORAGE_FRAME_CHANGED', 'the frame now has origin ' + self.origin + '; call origins again');
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(fail('STORAGE_TIMEOUT', 'storage did not answer in ' + input.timeoutMs + ' ms')), input.timeoutMs); });
  const work = (async () => {
    try {
${body}
    } catch (error) {
      return fail('STORAGE_SCRIPT_FAILED', String((error && error.name) || 'Error') + ': ' + String((error && error.message) || error));
    }
  })();
  try { return await Promise.race([work, timeout]); } finally { clearTimeout(timer); }
})(${JSON.stringify(input)})`;
}

export async function runInFrame(
  host: HeldSession,
  target: StorageTarget,
  body: string,
  input: Record<string, unknown>,
): Promise<any> {
  requireRunning(host, target);
  let contextId: number;
  try {
    contextId = (
      await send<{ executionContextId: number }>(host, target.key, 'Page.createIsolatedWorld', {
        frameId: target.frameId,
        worldName: STORAGE_WORLD,
      })
    ).executionContextId;
  } catch (error) {
    fail(
      'STORAGE_FRAME_CHANGED',
      `frame of ${target.origin} is gone or not ready (${error instanceof Error ? error.message : error}); call origins again`,
    );
  }
  const result = await send(host, target.key, 'Runtime.evaluate', {
    expression: pageExpression(body, {
      ...input,
      origin: target.origin,
      timeoutMs: PAGE_TIMEOUT_MS,
    }),
    contextId,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    fail(
      'STORAGE_SCRIPT_FAILED',
      result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'exception',
    );
  }
  const value = result.result?.value;
  if (value?.error) fail(value.error.code, value.error.message);
  return value;
}

const AREA = `
      let area;
      try {
        area = input.area === 'local' ? localStorage : sessionStorage;
      } catch (error) {
        return fail('STORAGE_UNAVAILABLE', input.area + 'Storage is not available in this frame: ' + String((error && error.message) || error));
      }`;

export const ITEMS_BODY = `${AREA}
      let keys = [];
      for (let index = 0; index < area.length; index += 1) keys.push(area.key(index));
      keys.sort();
      if (input.key !== undefined) keys = keys.filter((key) => key === input.key);
      else if (input.prefix) keys = keys.filter((key) => key.startsWith(input.prefix));
      const page = keys.slice(input.offset, input.offset + input.limit);
      return { total: keys.length, items: page.map((key) => {
        const value = area.getItem(key);
        return value.length > input.maxStringChars ? { key, value: value.slice(0, input.maxStringChars), chars: value.length } : { key, value };
      }) };`;

export const SET_ITEM_BODY = `${AREA}
      const previous = area.getItem(input.key);
      try {
        area.setItem(input.key, input.value);
      } catch (error) {
        return fail('STORAGE_WRITE_FAILED', String(error && error.name) + ': ' + String(error && error.message));
      }
      return previous === null ? { created: true } : { created: false, previousChars: previous.length };`;

export const REMOVE_ITEM_BODY = `${AREA}
      if (area.getItem(input.key) === null) return fail('STORAGE_KEY_NOT_FOUND', 'key ' + JSON.stringify(input.key) + ' is not in ' + input.area + 'Storage of ' + input.origin);
      area.removeItem(input.key);
      return { removed: true };`;

export const CLEAR_ITEMS_BODY = `${AREA}
      const count = area.length;
      area.clear();
      return { cleared: count };`;

const IDB = `
      const request = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      const names = (await indexedDB.databases()).map((info) => info.name).filter(Boolean);
      // Opening without a version never upgrades an existing database; a missing one is aborted
      // in onupgradeneeded, which also removes the empty database it would have created.
      const open = (name) => new Promise((resolve, reject) => {
        const r = indexedDB.open(name);
        r.onupgradeneeded = () => r.transaction.abort();
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      const ser = (v, d) => {
        if (v === null || typeof v === 'boolean') return v;
        if (typeof v === 'number') return Number.isFinite(v) ? v : { $type: 'Number', value: String(v) };
        if (typeof v === 'string') return v.length > input.maxStringChars ? { $type: 'String', chars: v.length, text: v.slice(0, input.maxStringChars) } : v;
        if (typeof v === 'bigint') return { $type: 'BigInt', value: v.toString() };
        if (typeof v === 'undefined') return { $type: 'undefined' };
        if (typeof v !== 'object') return { $type: typeof v };
        if (d > 8) return { $type: 'MaxDepth' };
        if (v instanceof Date) return { $type: 'Date', iso: Number.isNaN(v.getTime()) ? 'Invalid Date' : v.toISOString() };
        if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
          const bytes = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
          const head = bytes.subarray(0, 3072);
          let text = '';
          for (const byte of head) text += String.fromCharCode(byte);
          return { $type: v.constructor.name, bytes: bytes.length, base64: btoa(text), ...(bytes.length > head.length ? { truncated: true } : {}) };
        }
        if (v instanceof Blob) return { $type: v instanceof File ? 'File' : 'Blob', size: v.size, type: v.type, ...(v instanceof File ? { name: v.name } : {}) };
        if (v instanceof RegExp) return { $type: 'RegExp', source: String(v) };
        if (v instanceof Map) return { $type: 'Map', size: v.size, entries: [...v].slice(0, 200).map(([k, x]) => [ser(k, d + 1), ser(x, d + 1)]) };
        if (v instanceof Set) return { $type: 'Set', size: v.size, values: [...v].slice(0, 200).map((x) => ser(x, d + 1)) };
        if (v instanceof Error) return { $type: 'Error', name: v.name, message: v.message };
        if (Array.isArray(v)) {
          const out = v.slice(0, 200).map((x) => ser(x, d + 1));
          if (v.length > 200) out.push({ $type: 'More', count: v.length - 200 });
          return out;
        }
        const out = {};
        const keys = Object.keys(v);
        for (const key of keys.slice(0, 200)) out[key] = ser(v[key], d + 1);
        if (keys.length > 200) out.$more = keys.length - 200;
        return out;
      };`;

export const DATABASES_BODY = `${IDB}
      const sorted = [...new Set(names)].sort();
      const databases = [];
      for (const name of sorted.slice(0, ${MAX_DATABASES})) {
        let db;
        try {
          db = await open(name);
        } catch (error) {
          databases.push({ name, error: String((error && error.message) || error) });
          continue;
        }
        try {
          const storeNames = [...db.objectStoreNames];
          const tx = storeNames.length ? db.transaction(storeNames, 'readonly') : undefined;
          const stores = storeNames.map((storeName) => {
            const store = tx.objectStore(storeName);
            return {
              name: storeName,
              keyPath: store.keyPath,
              autoIncrement: store.autoIncrement,
              count: request(store.count()),
              indexes: [...store.indexNames].map((indexName) => {
                const index = store.index(indexName);
                return { name: indexName, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
              }),
            };
          });
          for (const store of stores) store.count = await store.count;
          databases.push({ name, version: db.version, stores });
        } finally {
          db.close();
        }
      }
      return { total: sorted.length, databases };`;

export const READ_STORE_BODY = `${IDB}
      if (!names.includes(input.database)) return fail('IDB_DATABASE_NOT_FOUND', 'database ' + JSON.stringify(input.database) + ' does not exist in ' + input.origin + '; databases: ' + (names.join(', ') || 'none'));
      const db = await open(input.database);
      try {
        if (!db.objectStoreNames.contains(input.store)) return fail('IDB_STORE_NOT_FOUND', 'database ' + input.database + ' has no store ' + JSON.stringify(input.store) + '; stores: ' + ([...db.objectStoreNames].join(', ') || 'none'));
        const tx = db.transaction(input.store, 'readonly');
        let source = tx.objectStore(input.store);
        if (input.index !== undefined) {
          if (!source.indexNames.contains(input.index)) return fail('IDB_INDEX_NOT_FOUND', 'store ' + input.store + ' has no index ' + JSON.stringify(input.index) + '; indexes: ' + ([...source.indexNames].join(', ') || 'none'));
          source = source.index(input.index);
        }
        let range;
        try {
          const r = input.range;
          range = !r ? undefined
            : 'only' in r ? IDBKeyRange.only(r.only)
            : r.lower !== undefined && r.upper !== undefined ? IDBKeyRange.bound(r.lower, r.upper, !!r.lowerOpen, !!r.upperOpen)
            : r.lower !== undefined ? IDBKeyRange.lowerBound(r.lower, !!r.lowerOpen)
            : IDBKeyRange.upperBound(r.upper, !!r.upperOpen);
        } catch (error) {
          return fail('INVALID_ARGUMENT', 'range is not a valid key range: ' + String((error && error.message) || error));
        }
        const total = await request(source.count(range));
        const entries = await new Promise((resolve, reject) => {
          const rows = [];
          let skipped = input.offset === 0;
          const cursor = source.openCursor(range, input.direction);
          cursor.onerror = () => reject(cursor.error);
          cursor.onsuccess = () => {
            const c = cursor.result;
            if (!c) return resolve(rows);
            if (!skipped) { skipped = true; c.advance(input.offset); return; }
            rows.push({ key: ser(c.key, 0), ...(input.index !== undefined ? { primaryKey: ser(c.primaryKey, 0) } : {}), value: ser(c.value, 0) });
            if (rows.length >= input.limit) return resolve(rows);
            c.continue();
          };
        });
        return { total, entries };
      } finally {
        db.close();
      }`;

export interface CacheEntry {
  requestURL: string;
  requestMethod: string;
  requestHeaders: Array<{ name: string; value: string }>;
  responseStatus: number;
  responseStatusText: string;
  responseType: string;
  responseTime: number;
  responseHeaders: Array<{ name: string; value: string }>;
}

export async function cacheNames(host: HeldSession, target: StorageTarget) {
  requireRunning(host, target);
  const { caches } = await send<{ caches: Array<{ cacheId: string; cacheName: string }> }>(
    host,
    target.key,
    'CacheStorage.requestCacheNames',
    { storageKey: target.storageKey },
  );
  return caches;
}

export async function cacheIdOf(host: HeldSession, target: StorageTarget, name: string) {
  const caches = await cacheNames(host, target);
  const found = caches.find((cache) => cache.cacheName === name);
  if (!found) {
    fail(
      'CACHE_NOT_FOUND',
      `${target.origin} has no cache ${JSON.stringify(name)}; caches: ${caches.map((cache) => cache.cacheName).join(', ') || 'none'}`,
    );
  }
  return found.cacheId;
}

export async function cacheEntries(
  host: HeldSession,
  target: StorageTarget,
  cacheId: string,
  skipCount: number,
  pageSize: number,
  pathFilter?: string,
) {
  return send<{ cacheDataEntries: CacheEntry[]; returnCount: number }>(
    host,
    target.key,
    'CacheStorage.requestEntries',
    { cacheId, skipCount, pageSize, ...(pathFilter ? { pathFilter } : {}) },
  );
}

/** Entry for url (its request headers are needed for Vary matching) and its body as base64. */
export async function cachedResponse(
  host: HeldSession,
  target: StorageTarget,
  cacheId: string,
  url: string,
) {
  const pathFilter = new URL(url).pathname;
  let entry: CacheEntry | undefined;
  for (let skip = 0; !entry && skip < MAX_CACHE_SCAN; skip += 100) {
    const page = await cacheEntries(host, target, cacheId, skip, 100, pathFilter);
    entry = page.cacheDataEntries.find((item) => item.requestURL === url);
    if (page.cacheDataEntries.length < 100) break;
  }
  if (!entry) {
    fail('CACHE_ENTRY_NOT_FOUND', `the cache has no entry for ${url}; list cacheEntries first`);
  }
  const { response } = await send<{ response: { body: string } }>(
    host,
    target.key,
    'CacheStorage.requestCachedResponse',
    { cacheId, requestURL: url, requestHeaders: entry.requestHeaders },
  );
  return { entry, base64: response.body };
}

export interface CookieInput {
  name: string;
  value: string;
  url: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  expires?: number;
  partitionKey?: PartitionKey;
}

export interface PartitionKey {
  topLevelSite: string;
  hasCrossSiteAncestor: boolean;
}

export interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  size: number;
  httpOnly: boolean;
  secure: boolean;
  session: boolean;
  sameSite?: string;
  partitionKey?: PartitionKey;
}

export async function getCookies(host: HeldSession, urls?: string[]): Promise<CdpCookie[]> {
  const result = await send<{ cookies: CdpCookie[] }>(
    host,
    '',
    'Network.getCookies',
    urls ? { urls } : {},
  );
  return result.cookies ?? [];
}

const samePartition = (a?: PartitionKey, b?: PartitionKey) =>
  (!a && !b) ||
  (!!a &&
    !!b &&
    a.topLevelSite === b.topLevelSite &&
    a.hasCrossSiteAncestor === b.hasCrossSiteAncestor);

const bareDomain = (domain: string) => domain.replace(/^\./, '').toLowerCase();

const hints = (input: CookieInput) =>
  [
    input.sameSite === 'None' && !input.secure ? 'SameSite=None requires secure:true' : '',
    input.partitionKey && !input.secure ? 'a partitioned cookie requires secure:true' : '',
    input.secure && !/^https:|^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(input.url)
      ? 'a Secure cookie needs an https url (or localhost)'
      : '',
  ].filter(Boolean);

export async function setCookie(host: HeldSession, input: CookieInput): Promise<CdpCookie> {
  let result: { success?: boolean };
  try {
    result = await send(host, '', 'Network.setCookie', input);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    fail('COOKIE_REJECTED', [`Chrome rejected the cookie (${reason})`, ...hints(input)].join('; '));
  }
  if (result.success === false) {
    fail('COOKIE_REJECTED', ['Chrome rejected the cookie', ...hints(input)].join('; '));
  }
  const stored = (await getCookies(host, [input.url])).find(
    (cookie) =>
      cookie.name === input.name &&
      samePartition(cookie.partitionKey, input.partitionKey) &&
      (!input.domain || bareDomain(cookie.domain) === bareDomain(input.domain)) &&
      cookie.path === (input.path ?? cookie.path),
  );
  if (!stored) {
    fail(
      'COOKIE_REJECTED',
      [`Chrome accepted the cookie but it is not visible for ${input.url}`, ...hints(input)].join(
        '; ',
      ),
    );
  }
  return stored;
}

export interface CookieMatch {
  name: string;
  url: string;
  domain?: string;
  path?: string;
  partitionKey?: PartitionKey;
}

/** Deletes exactly the cookies matching the input, then verifies none of them remain. */
export async function deleteCookie(host: HeldSession, match: CookieMatch): Promise<CdpCookie[]> {
  const select = (cookies: CdpCookie[], anyPartition = false) =>
    cookies.filter(
      (cookie) =>
        cookie.name === match.name &&
        (!match.domain || bareDomain(cookie.domain) === bareDomain(match.domain)) &&
        (match.path === undefined || cookie.path === match.path) &&
        (anyPartition || samePartition(cookie.partitionKey, match.partitionKey)),
    );
  const before = await getCookies(host, [match.url]);
  const targets = select(before);
  if (!targets.length) {
    const others = select(before, true).filter((cookie) => cookie.partitionKey);
    fail(
      'COOKIE_NOT_FOUND',
      `no ${match.partitionKey ? 'cookie in that partition' : 'unpartitioned cookie'} named ${match.name} for ${match.url}` +
        (others.length
          ? `; partitioned ones exist, pass their partitionKey: ${others.map((cookie) => JSON.stringify(cookie.partitionKey)).join(', ')}`
          : ''),
    );
  }
  for (const cookie of targets) {
    await send(host, '', 'Network.deleteCookies', {
      name: cookie.name,
      domain: cookie.domain,
      path: cookie.path,
      ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {}),
    });
  }
  const left = select(await getCookies(host, [match.url]));
  if (left.length) {
    fail(
      'COOKIE_DELETE_INCOMPLETE',
      `${left.length} of ${targets.length} matching cookies are still set (${left.map((cookie) => `${cookie.domain}${cookie.path}`).join(', ')})`,
    );
  }
  return targets;
}
