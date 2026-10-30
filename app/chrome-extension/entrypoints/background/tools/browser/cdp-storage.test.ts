import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cdpStorageTool } from './cdp-storage';
import { cdpSessionTool } from './cdp-session';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { clearCdpSessionsForTest, peekSession } from '@/utils/cdp-event-hub';
import { pageExpression } from '@/utils/cdp-storage';

vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: {
    attach: vi.fn(),
    detach: vi.fn(),
    sendCommand: vi.fn(),
    withSession: vi.fn(async (_tabId: number, _owner: string, fn: () => Promise<unknown>) => fn()),
  },
}));

type EventListener = (source: any, method: string, params?: any) => void;
let eventListeners: EventListener[];
let calls: Array<[string, any, string | undefined]>;
let failOn: Map<string, Error>;
let results: Map<string, unknown>;
let cookies: any[];
let stores: Map<string, FakeStorage>;
/** Origin the evaluated frame reports, per session key; set to simulate a navigation. */
let frameOrigin: Map<string, string>;
let evaluateValue: unknown;

const A = { owner: 'cli:A', strictTarget: true };
const CHILD = 'OOPIF-1';
const TOP = 'http://127.0.0.1:8000';
const SUB = 'http://localhost:8000';
const TOP_KEY = `${TOP}/`;
const SUB_KEY = `${SUB}/^0http://127.0.0.1`;

class FakeStorage {
  map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value));
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  clear() {
    this.map.clear();
  }
}

function emit(method: string, params?: unknown, sessionId?: string) {
  for (const listener of eventListeners) listener({ tabId: 7, sessionId }, method, params);
}

function body(result: any) {
  expect(result.isError, result.content?.[0]?.text).toBe(false);
  return JSON.parse(result.content[0].text);
}

function errorText(result: any): string {
  expect(result.isError).toBe(true);
  return result.content[0].text;
}

const storage = (args: Record<string, unknown>, context: any = A) =>
  cdpStorageTool.execute({ tabId: 7, ...args } as any, context);
const session = (args: Record<string, unknown>, context: any = A) =>
  cdpSessionTool.execute({ tabId: 7, ...args } as any, context);
const sent = (method: string) => calls.filter((call) => call[0] === method);

async function start() {
  body(await session({ action: 'start' }));
  emit('Target.attachedToTarget', {
    sessionId: CHILD,
    targetInfo: { targetId: `T-${CHILD}`, type: 'iframe', url: `${SUB}/child` },
    waitingForDebugger: false,
  });
  calls = [];
}

function frameTree(key: string) {
  return key
    ? { frameTree: { frame: { id: 'F-SUB', url: `${SUB}/child`, securityOrigin: SUB } } }
    : {
        frameTree: {
          frame: { id: 'F-TOP', url: `${TOP}/page?token=abcdefghijklmnop`, securityOrigin: TOP },
          childFrames: [
            { frame: { id: 'F-SAME', url: `${TOP}/same`, securityOrigin: TOP } },
            { frame: { id: 'F-BLANK', url: 'about:blank', securityOrigin: '://' } },
          ],
        },
      };
}

async function evaluate(expression: string, key: string) {
  if (evaluateValue !== undefined) return { result: { value: evaluateValue } };
  const area = (name: string) => {
    const id = `${key}/${name}`;
    if (!stores.has(id)) stores.set(id, new FakeStorage());
    return stores.get(id);
  };
  vi.stubGlobal('self', { origin: frameOrigin.get(key) ?? (key ? SUB : TOP) });
  vi.stubGlobal('localStorage', area('local'));
  vi.stubGlobal('sessionStorage', area('session'));
  return { result: { value: await (0, eval)(expression) } };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearCdpSessionsForTest();
  eventListeners = [];
  calls = [];
  failOn = new Map();
  results = new Map();
  stores = new Map();
  frameOrigin = new Map();
  evaluateValue = undefined;
  cookies = [
    {
      name: 'sid',
      value: 'secret-1',
      domain: '127.0.0.1',
      path: '/',
      expires: -1,
      size: 11,
      httpOnly: true,
      secure: false,
      session: true,
      sameSite: 'Lax',
    },
    {
      name: 'chip',
      value: 'secret-2',
      domain: 'localhost',
      path: '/',
      expires: 2e9,
      size: 12,
      httpOnly: false,
      secure: true,
      session: false,
      sameSite: 'None',
      partitionKey: { topLevelSite: 'http://127.0.0.1', hasCrossSiteAncestor: true },
    },
  ];
  vi.stubGlobal('chrome', {
    tabs: {
      get: vi.fn(async (id: number) =>
        id === 7 ? { id, windowId: 1 } : Promise.reject(new Error('No tab')),
      ),
      query: vi.fn(async () => [{ id: 7, windowId: 1, active: true }]),
      onRemoved: { addListener: vi.fn() },
    },
    windows: { getLastFocused: vi.fn(async () => ({ id: 1 })) },
    debugger: {
      onEvent: { addListener: (fn: EventListener) => eventListeners.push(fn) },
      onDetach: { addListener: vi.fn() },
    },
  });
  vi.mocked(cdpSessionManager.attach).mockResolvedValue(undefined);
  vi.mocked(cdpSessionManager.detach).mockResolvedValue(undefined);
  vi.mocked(cdpSessionManager.sendCommand).mockImplementation(
    async (_tabId: number, method: string, params?: any, sessionId?: string) => {
      const key = sessionId ?? '';
      calls.push([method, params, sessionId]);
      const failure = failOn.get(`${method}@${key}`);
      if (failure) throw failure;
      if (results.has(`${method}@${key}`)) return results.get(`${method}@${key}`);
      if (method === 'Page.getFrameTree') return frameTree(key);
      if (method === 'Storage.getStorageKeyForFrame') {
        return {
          storageKey:
            params.frameId === 'F-SUB'
              ? SUB_KEY
              : params.frameId === 'F-SUB2'
                ? `${TOP}/^0http://localhost`
                : TOP_KEY,
        };
      }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: key ? 22 : 11 };
      if (method === 'Runtime.evaluate') return evaluate(params.expression, key);
      if (method === 'Network.getCookies') return { cookies };
      if (method === 'Network.deleteCookies') {
        cookies = cookies.filter(
          (cookie) =>
            !(
              cookie.name === params.name &&
              cookie.domain === params.domain &&
              cookie.path === params.path &&
              JSON.stringify(cookie.partitionKey) === JSON.stringify(params.partitionKey)
            ),
        );
        return {};
      }
      return {};
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('chrome_cdp_storage tool', () => {
  test('requires an owned session and skips the tab lock', async () => {
    expect(cdpStorageTool.skipsTargetLock()).toBe(true);
    expect(errorText(await storage({ action: 'origins' }, {}))).toContain(
      'CDP_SESSION_NOT_STARTED',
    );
    expect(errorText(await storage({ action: 'origins' }))).toContain('CDP_SESSION_NOT_STARTED');
    await start();
    expect(errorText(await storage({ action: 'origins' }, { owner: 'cli:B' }))).toContain(
      'CDP_SESSION_OWNED',
    );
  });

  test('bad arguments fail before any CDP call', async () => {
    await start();
    for (const [args, message] of [
      [{ action: 'clearAll' }, 'action must be'],
      [{ action: 'origins', origin: TOP }, 'origin does not apply to origins'],
      [{ action: 'cookies', area: 'local' }, 'area does not apply to cookies'],
      [{ action: 'items', area: 'local' }, 'origin must be an http(s) origin'],
      [{ action: 'items', origin: `${TOP}/page`, area: 'local' }, 'origin must be'],
      [{ action: 'items', origin: TOP }, 'area must be local or session'],
      [{ action: 'items', origin: TOP, area: 'local', key: 'a', prefix: 'b' }, 'key or prefix'],
      [{ action: 'setItem', origin: TOP, area: 'local', key: 'a' }, 'value must be'],
      [{ action: 'setCookie', name: 'a', value: 'b', url: 'ftp://x' }, 'url must be'],
      [{ action: 'setCookie', name: 'a b', value: 'b', url: TOP }, 'name must be'],
      [{ action: 'setCookie', name: 'a', value: 'b;c', url: TOP }, 'value must be'],
      [
        { action: 'setCookie', name: 'a', value: 'b', url: TOP, domain: 'example.com' },
        'does not cover',
      ],
      [{ action: 'setCookie', name: 'a', value: 'b', url: TOP, expires: 1 }, 'future time'],
      [
        {
          action: 'deleteCookie',
          name: 'a',
          url: TOP,
          partitionKey: { topLevelSite: 'http://a:1', hasCrossSiteAncestor: false },
        },
        'partitionKey must be',
      ],
      [{ action: 'readStore', origin: TOP, database: 'd', store: 's', range: {} }, 'range needs'],
      [
        {
          action: 'readStore',
          origin: TOP,
          database: 'd',
          store: 's',
          range: { only: 1, lower: 0 },
        },
        'cannot be combined',
      ],
      [
        {
          action: 'readStore',
          origin: TOP,
          database: 'd',
          store: 's',
          range: { upperOpen: true, lower: 1 },
        },
        'upperOpen needs',
      ],
      [
        { action: 'readStore', origin: TOP, database: 'd', store: 's', range: { lower: NaN } },
        'IndexedDB key',
      ],
      [
        {
          action: 'readStore',
          origin: TOP,
          database: 'd',
          store: 's',
          range: { lower: [[[[[1]]]]] },
        },
        'IndexedDB key',
      ],
      [{ action: 'cacheResponse', origin: TOP, cache: 'c', url: '/x' }, 'url must be'],
    ] as Array<[Record<string, unknown>, string]>) {
      const text = errorText(await storage(args));
      expect(text, JSON.stringify(args)).toContain('INVALID_ARGUMENT');
      expect(text, JSON.stringify(args)).toContain(message);
    }
    expect(calls).toEqual([]);
  });

  test('origins groups frames by origin across the root and child sessions', async () => {
    await start();
    const result = body(await storage({ action: 'origins' }));
    expect(result.origins).toEqual([
      { origin: TOP, storageKey: TOP_KEY, url: `${TOP}/page?token=<redacted>`, frames: 2 },
      { origin: SUB, storageKey: SUB_KEY, sessionId: CHILD, url: `${SUB}/child`, frames: 1 },
    ]);
    expect(sent('Storage.getStorageKeyForFrame').map((call) => [call[1].frameId, call[2]])).toEqual(
      [
        ['F-TOP', undefined],
        ['F-SUB', CHILD],
      ],
    );
  });

  test('a storage origin must exist in the tab and have one partition', async () => {
    await start();
    expect(
      errorText(await storage({ action: 'items', origin: 'https://linux.do', area: 'local' })),
    ).toContain(
      `STORAGE_ORIGIN_NOT_FOUND: no frame of tab 7 has origin https://linux.do; origins: ${TOP}, ${SUB}`,
    );
    results.set(`Page.getFrameTree@${CHILD}`, {
      frameTree: { frame: { id: 'F-SUB2', url: `${TOP}/x`, securityOrigin: TOP } },
    });
    expect(errorText(await storage({ action: 'items', origin: TOP, area: 'local' }))).toContain(
      'STORAGE_ORIGIN_AMBIGUOUS',
    );
    expect(sent('Runtime.evaluate')).toEqual([]);
  });

  test('items, setItem, removeItem and clearItems touch only one origin and area', async () => {
    await start();
    const set = (origin: string, area: string, key: string, value: string) =>
      storage({ action: 'setItem', origin, area, key, value });
    expect(body(await set(SUB, 'local', 'b7', 'child'))).toMatchObject({
      origin: SUB,
      storageKey: SUB_KEY,
      area: 'local',
      key: 'b7',
      created: true,
    });
    expect(body(await set(TOP, 'local', 'b7', 'top'))).toMatchObject({ created: true });
    expect(body(await set(TOP, 'local', 'b7', 'top2'))).toMatchObject({
      created: false,
      previousChars: 3,
    });
    body(await set(TOP, 'session', 'b7', 'sess'));
    expect(stores.get(`${CHILD}/local`)!.map.get('b7')).toBe('child');
    expect(stores.get('/local')!.map.get('b7')).toBe('top2');
    // The write ran in an isolated world of the frame's own session.
    expect(sent('Page.createIsolatedWorld')[0]).toEqual([
      'Page.createIsolatedWorld',
      { frameId: 'F-SUB', worldName: 'aeb-storage' },
      CHILD,
    ]);
    expect(sent('Runtime.evaluate')[0][1]).toMatchObject({ contextId: 22, awaitPromise: true });

    body(await set(TOP, 'local', 'b7x', 'other'));
    const items = body(
      await storage({ action: 'items', origin: TOP, area: 'local', prefix: 'b7', limit: 1 }),
    );
    expect(items).toMatchObject({
      total: 2,
      offset: 0,
      items: [{ key: 'b7', value: 'top2', chars: 4 }],
      nextOffset: 1,
      hasMore: true,
    });
    expect(
      body(await storage({ action: 'removeItem', origin: TOP, area: 'local', key: 'b7' })),
    ).toMatchObject({ removed: true });
    expect(
      errorText(await storage({ action: 'removeItem', origin: TOP, area: 'local', key: 'b7' })),
    ).toContain('STORAGE_KEY_NOT_FOUND');
    expect(
      body(await storage({ action: 'clearItems', origin: TOP, area: 'session' })),
    ).toMatchObject({
      cleared: 1,
    });
    expect(stores.get('/local')!.map.size).toBe(1);
    expect(stores.get(`${CHILD}/local`)!.map.size).toBe(1);
  });

  test('storage values are redacted by name and content unless sanitizeOutput is false', async () => {
    await start();
    const local = new FakeStorage();
    stores.set('/local', local);
    local.setItem('access_token', 'abc');
    local.setItem('profile', JSON.stringify({ name: 'n', password: 'p', nested: { apiKey: 'k' } }));
    local.setItem('note', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123');
    local.setItem('plain', 'word '.repeat(1000));
    const shown = body(
      await storage({ action: 'items', origin: TOP, area: 'local', maxOutputBytes: 4000 }),
    );
    const byKey = Object.fromEntries(shown.items.map((item: any) => [item.key, item]));
    expect(shown.redacted).toBe(true);
    expect(byKey.access_token.value).toBe('[REDACTED]');
    expect(JSON.parse(byKey.profile.value)).toEqual({
      name: 'n',
      password: '[REDACTED]',
      nested: { apiKey: '[REDACTED]' },
    });
    expect(byKey.note.value).not.toContain('abcdefghijklmnop');
    const raw = body(
      await storage({ action: 'items', origin: TOP, area: 'local', sanitizeOutput: false }),
    );
    expect(raw.items.find((item: any) => item.key === 'access_token').value).toBe('abc');
    expect(raw.items.find((item: any) => item.key === 'plain')).toMatchObject({ chars: 5000 });
    expect(raw.redacted).toBeUndefined();
    const cut = body(
      await storage({
        action: 'items',
        origin: TOP,
        area: 'local',
        key: 'plain',
        maxOutputBytes: 1000,
      }),
    );
    expect(cut.items[0]).toMatchObject({ chars: 5000, truncated: true });
    expect(cut.items[0].value.length).toBe(250);
  });

  test('a frame that navigated to another origin is not written', async () => {
    await start();
    frameOrigin.set('', 'https://linux.do');
    expect(
      errorText(
        await storage({ action: 'setItem', origin: TOP, area: 'local', key: 'k', value: 'v' }),
      ),
    ).toContain('STORAGE_FRAME_CHANGED');
    expect(stores.get('/local')?.map.size ?? 0).toBe(0);
    failOn.set('Page.createIsolatedWorld@', new Error('No frame for given id found'));
    expect(errorText(await storage({ action: 'items', origin: TOP, area: 'local' }))).toContain(
      'STORAGE_FRAME_CHANGED',
    );
  });

  test('storage and cache need the frame running, cookies do not', async () => {
    await start();
    peekSession(7)!.debug.pauses.set('', {} as any);
    for (const args of [
      { action: 'items', origin: TOP, area: 'local' },
      { action: 'databases', origin: TOP },
      { action: 'caches', origin: TOP },
    ]) {
      expect(errorText(await storage(args))).toContain('STORAGE_PAGE_PAUSED');
    }
    expect(sent('Runtime.evaluate')).toEqual([]);
    expect(sent('CacheStorage.requestCacheNames')).toEqual([]);
    // Only the root is paused: the cross-site child still answers.
    body(await storage({ action: 'items', origin: SUB, area: 'local' }));
    body(await storage({ action: 'cookies' }));
  });

  test('cookies are redacted, scoped to frames of the tab, and paged', async () => {
    await start();
    const all = body(await storage({ action: 'cookies' }));
    expect(sent('Network.getCookies')[0]).toEqual(['Network.getCookies', {}, undefined]);
    expect(all).toMatchObject({ scope: 'every frame of the tab', total: 2, hasMore: false });
    expect(all.cookies[0]).toMatchObject({
      name: 'sid',
      value: '[REDACTED]',
      valueChars: 8,
      session: true,
      httpOnly: true,
    });
    expect(all.cookies[1]).toMatchObject({
      name: 'chip',
      expires: 2e9,
      partitionKey: { topLevelSite: 'http://127.0.0.1', hasCrossSiteAncestor: true },
    });
    const raw = body(
      await storage({
        action: 'cookies',
        url: `${SUB}/child`,
        name: 'chip',
        sanitizeOutput: false,
      }),
    );
    expect(sent('Network.getCookies')[1][1]).toEqual({ urls: [`${SUB}/child`] });
    expect(raw.cookies).toEqual([expect.objectContaining({ name: 'chip', value: 'secret-2' })]);
    expect(raw.cookies[0].valueChars).toBeUndefined();
    calls = [];
    expect(errorText(await storage({ action: 'cookies', url: 'https://linux.do/' }))).toContain(
      'STORAGE_ORIGIN_NOT_FOUND',
    );
    expect(sent('Network.getCookies')).toEqual([]);
    const paged = body(await storage({ action: 'cookies', offset: 1, limit: 1 }));
    expect(paged).toMatchObject({ offset: 1, nextOffset: 2, hasMore: false });
  });

  test('setCookie validates, sets on the root session, and reads the cookie back', async () => {
    await start();
    vi.mocked(cdpSessionManager.sendCommand).mockClear();
    const stored = {
      name: 'b7',
      value: 'v',
      domain: 'localhost',
      path: '/',
      expires: -1,
      size: 3,
      httpOnly: true,
      secure: true,
      session: true,
      sameSite: 'None',
      partitionKey: { topLevelSite: 'http://127.0.0.1', hasCrossSiteAncestor: true },
    };
    results.set('Network.setCookie@', { success: true });
    cookies.push(stored);
    const args = {
      action: 'setCookie',
      name: 'b7',
      value: 'v',
      url: `${SUB}/`,
      secure: true,
      httpOnly: true,
      sameSite: 'None',
      partitionKey: stored.partitionKey,
    };
    const result = body(await storage(args));
    expect(result.cookie).toMatchObject({
      name: 'b7',
      value: '[REDACTED]',
      partitionKey: stored.partitionKey,
    });
    expect(sent('Network.setCookie')).toEqual([
      [
        'Network.setCookie',
        {
          name: 'b7',
          value: 'v',
          url: `${SUB}/`,
          secure: true,
          httpOnly: true,
          sameSite: 'None',
          partitionKey: stored.partitionKey,
        },
        undefined,
      ],
    ]);
    results.set('Network.setCookie@', { success: false });
    expect(errorText(await storage({ ...args, secure: false, partitionKey: undefined }))).toContain(
      'COOKIE_REJECTED: Chrome rejected the cookie; SameSite=None requires secure:true',
    );
    results.delete('Network.setCookie@');
    failOn.set('Network.setCookie@', new Error('Sanitizing cookie failed'));
    expect(errorText(await storage({ ...args, secure: false, sameSite: 'Lax' }))).toContain(
      'Sanitizing cookie failed); a partitioned cookie requires secure:true',
    );
    failOn.clear();
    results.set('Network.setCookie@', { success: true });
    expect(
      errorText(await storage({ ...args, name: 'gone', partitionKey: undefined, sameSite: 'Lax' })),
    ).toContain('COOKIE_REJECTED: Chrome accepted the cookie but it is not visible');
  });

  test('deleteCookie deletes exact identities and needs partitionKey for partitioned cookies', async () => {
    await start();
    expect(
      errorText(await storage({ action: 'deleteCookie', name: 'chip', url: `${SUB}/` })),
    ).toContain('COOKIE_NOT_FOUND: no unpartitioned cookie named chip');
    expect(
      errorText(await storage({ action: 'deleteCookie', name: 'chip', url: `${SUB}/` })),
    ).toContain(
      'pass their partitionKey: {"topLevelSite":"http://127.0.0.1","hasCrossSiteAncestor":true}',
    );
    expect(sent('Network.deleteCookies')).toEqual([]);
    const partitionKey = { topLevelSite: 'http://127.0.0.1', hasCrossSiteAncestor: true };
    const result = body(
      await storage({ action: 'deleteCookie', name: 'chip', url: `${SUB}/`, partitionKey }),
    );
    expect(result.deleted).toEqual([expect.objectContaining({ name: 'chip', partitionKey })]);
    expect(sent('Network.deleteCookies')).toEqual([
      [
        'Network.deleteCookies',
        { name: 'chip', domain: 'localhost', path: '/', partitionKey },
        undefined,
      ],
    ]);
    expect(cookies.map((cookie) => cookie.name)).toEqual(['sid']);
    // A delete Chrome ignores is reported, not claimed.
    results.set('Network.deleteCookies@', {});
    vi.mocked(cdpSessionManager.sendCommand).mockClear();
    expect(
      errorText(await storage({ action: 'deleteCookie', name: 'sid', url: `${TOP}/` })),
    ).toContain('COOKIE_DELETE_INCOMPLETE');
  });

  test('readStore pages records and redacts sensitive fields but keeps binary payloads', async () => {
    await start();
    evaluateValue = {
      total: 3,
      entries: [
        {
          key: 1,
          value: { user: 'u', token: 't', blob: { $type: 'Uint8Array', bytes: 2, base64: 'AAE=' } },
        },
        { key: 2, value: 'Bearer abcdefghijklmnopqrstuvwxyz0123' },
      ],
    };
    const args = {
      action: 'readStore',
      origin: TOP,
      database: 'db',
      store: 's',
      range: { lower: 1, upperOpen: true, upper: [2, 'a'] },
      direction: 'prev',
      offset: 0,
      limit: 2,
    };
    const result = body(await storage(args));
    expect(result).toMatchObject({
      database: 'db',
      store: 's',
      total: 3,
      nextOffset: 2,
      hasMore: true,
      redacted: true,
    });
    expect(result.entries[0].value).toEqual({
      user: 'u',
      token: '[REDACTED]',
      blob: { $type: 'Uint8Array', bytes: 2, base64: 'AAE=' },
    });
    expect(result.entries[1].value).not.toContain('abcdefghijklmnop');
    const expression = sent('Runtime.evaluate')[0][1].expression as string;
    expect(expression).toContain('"range":{"lower":1,"upper":[2,"a"],"upperOpen":true}');
    expect(expression).toContain('"direction":"prev"');
    const raw = body(await storage({ ...args, sanitizeOutput: false }));
    expect(raw.entries[0].value.token).toBe('t');
    evaluateValue = {
      error: { code: 'IDB_STORE_NOT_FOUND', message: 'database db has no store "s"' },
    };
    expect(errorText(await storage(args))).toContain(
      'IDB_STORE_NOT_FOUND: database db has no store "s"',
    );
  });

  test('caches run in the session that renders the origin, with its storage key', async () => {
    await start();
    results.set(`CacheStorage.requestCacheNames@${CHILD}`, {
      caches: [{ cacheId: 'C1', cacheName: 'b7-cache', securityOrigin: SUB, storageKey: SUB_KEY }],
    });
    const entry = {
      requestURL: `${SUB}/data.json`,
      requestMethod: 'GET',
      requestHeaders: [{ name: 'Authorization', value: 'Bearer x' }],
      responseTime: 1,
      responseStatus: 200,
      responseStatusText: 'OK',
      responseType: 'basic',
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
    };
    results.set(`CacheStorage.requestEntries@${CHILD}`, {
      cacheDataEntries: [entry],
      returnCount: 3,
    });
    results.set(`CacheStorage.requestCachedResponse@${CHILD}`, {
      response: {
        body: Buffer.from('{"ok":true,"apiKey":"Bearer abcdefghijklmnopqrstuvwxyz0123"}').toString(
          'base64',
        ),
      },
    });
    expect(body(await storage({ action: 'caches', origin: SUB }))).toMatchObject({
      caches: ['b7-cache'],
    });
    expect(sent('CacheStorage.requestCacheNames')).toEqual([
      ['CacheStorage.requestCacheNames', { storageKey: SUB_KEY }, CHILD],
    ]);
    const entries = body(
      await storage({ action: 'cacheEntries', origin: SUB, cache: 'b7-cache', limit: 1 }),
    );
    expect(entries).toMatchObject({ total: 3, nextOffset: 1, hasMore: true });
    expect(entries.entries[0].requestHeaders).toEqual({ Authorization: '[REDACTED]' });
    const response = body(
      await storage({
        action: 'cacheResponse',
        origin: SUB,
        cache: 'b7-cache',
        url: `${SUB}/data.json`,
      }),
    );
    expect(response).toMatchObject({
      status: 200,
      mimeType: 'application/json',
      unit: 'chars',
      hasMore: false,
    });
    expect(response.text).toContain('"ok":true');
    expect(response.text).not.toContain('abcdefghijklmnop');
    expect(sent('CacheStorage.requestCachedResponse')[0][1]).toEqual({
      cacheId: 'C1',
      requestURL: `${SUB}/data.json`,
      requestHeaders: entry.requestHeaders,
    });
    results.set(`CacheStorage.requestCachedResponse@${CHILD}`, {
      response: { body: Buffer.from([0, 255, 1]).toString('base64') },
    });
    results.set(`CacheStorage.requestEntries@${CHILD}`, {
      cacheDataEntries: [
        { ...entry, responseHeaders: [{ name: 'Content-Type', value: 'image/png' }] },
      ],
      returnCount: 1,
    });
    expect(
      body(
        await storage({
          action: 'cacheResponse',
          origin: SUB,
          cache: 'b7-cache',
          url: `${SUB}/data.json`,
        }),
      ),
    ).toMatchObject({
      base64: true,
      data: 'AP8B',
      totalBytes: 3,
    });
    expect(
      errorText(
        await storage({
          action: 'cacheResponse',
          origin: SUB,
          cache: 'b7-cache',
          url: `${SUB}/nope`,
        }),
      ),
    ).toContain('CACHE_ENTRY_NOT_FOUND');
    expect(errorText(await storage({ action: 'caches', origin: SUB, cache: 'x' }))).toContain(
      'INVALID_ARGUMENT',
    );
    expect(
      errorText(await storage({ action: 'cacheEntries', origin: SUB, cache: 'other' })),
    ).toContain('CACHE_NOT_FOUND: http://localhost:8000 has no cache "other"; caches: b7-cache');
  });

  test('page scripts embed input as JSON data and time out', async () => {
    const expression = pageExpression('return { echo: input.x };', { x: '"); alert(1); ("' });
    expect(expression).toContain(JSON.stringify({ x: '"); alert(1); ("' }));
    vi.stubGlobal('self', { origin: TOP });
    expect(
      await (0, eval)(
        pageExpression('return { echo: input.x };', { x: 'a', origin: TOP, timeoutMs: 100 }),
      ),
    ).toEqual({ echo: 'a' });
    expect(
      await (0, eval)(
        pageExpression('await new Promise(() => {});', { origin: TOP, timeoutMs: 10 }),
      ),
    ).toEqual({ error: { code: 'STORAGE_TIMEOUT', message: 'storage did not answer in 10 ms' } });
  });
});
