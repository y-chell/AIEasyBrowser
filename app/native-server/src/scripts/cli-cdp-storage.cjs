'use strict';

// Real-browser acceptance for B7 chrome_cdp_storage on a held chrome_cdp_session: cookies
// (httpOnly, partitioned in a cross-site iframe, set/delete by exact identity, rejections),
// local/sessionStorage per origin in the top frame and the OOPIF, IndexedDB listing and paged
// range reads, Cache Storage entries and bodies, redaction, the paused-page check, and cleanup.
// Every cookie, key, database, and cache it creates starts with the run tag; it reads and deletes
// only those, because 127.0.0.1 and localhost cookies are shared with other local apps.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  runCli,
  assertOk,
  assertFailure,
  jsValue,
  createFixtureServer,
  cleanupTargets,
  runWithCleanup,
} = require('./cli-regression.cjs');

function errorCode(response) {
  return /([A-Z_]{6,}):/.exec(response.error.message)?.[1];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runCdpStorage() {
  const runId = randomUUID().replaceAll('-', '');
  const name = 'cdpsto_' + runId.slice(0, 8);
  const other = name + '_other';
  const tag = 'aebst' + runId.slice(0, 10);
  const tabs = [];
  const urls = [];
  let fixture;
  let started = false;
  let child;
  const ok = (session, args, label) => assertOk(runCli(session, args), label || args[1] || args[0]);
  const call = (session, tool, args, label) =>
    ok(session, ['call', tool, JSON.stringify(args)], label || tool).result;
  const fails = (session, tool, args, label) =>
    errorCode(assertFailure(runCli(session, ['call', tool, JSON.stringify(args)]), label || tool));
  // Session ids are 32-hex and would be redacted in output; read them raw.
  const store = (args) =>
    call(name, 'chrome_cdp_storage', { sanitizeOutput: false, ...args }, 'storage ' + args.action);
  const shown = (args) => call(name, 'chrome_cdp_storage', args, 'storage ' + args.action);
  const storeFails = (args) => fails(name, 'chrome_cdp_storage', args, 'storage ' + args.action);
  const cdpSession = (args) => call(name, 'chrome_cdp_session', args, 'cdp_session ' + args.action);
  const dbg = (args) => call(name, 'chrome_cdp_debugger', args, 'cdp_debugger ' + args.action);
  const evalPage = (code) => jsValue(ok(name, ['eval', code]));
  const evalChild = (code) =>
    jsValue({ result: call(name, 'chrome_javascript', { sessionId: child.sessionId, code }) });
  const own = (cookies) => cookies.filter((cookie) => cookie.name.startsWith(tag));
  const waitLoaded = async () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const state = runCli(name, [
        'eval',
        'return document.readyState === "complete" && !!window.storageFixture && document.getElementById("cross").contentWindow.length === 0',
      ]);
      if (state.response?.ok === true && jsValue(state.response) === true) return;
      await sleep(200);
    }
    throw new Error('fixture did not finish loading');
  };

  return runWithCleanup(
    async () => {
      const health = ok(name, ['health']).result;
      assert(
        health.schema.toolNames.includes('chrome_cdp_storage'),
        'running extension lacks chrome_cdp_storage; rebuild and reload it first',
      );
      fixture = await createFixtureServer(runId);
      const top = fixture.origin;
      const sub = 'http://localhost:' + new URL(top).port;
      const pageUrl = top + '/storage?run=' + name;
      urls.push(pageUrl);
      tabs.push(ok(name, ['open', pageUrl, '--background']).result.tabId);
      await waitLoaded();

      // 1. Without a held session nothing is read.
      assert.equal(storeFails({ action: 'origins' }), 'CDP_SESSION_NOT_STARTED');
      cdpSession({ action: 'start', events: ['Page.frameNavigated'] });
      started = true;
      child = cdpSession({ action: 'status' }).targets.find((target) => target.type === 'iframe');
      assert(child, 'OOPIF child attached');
      assert.equal(
        evalPage('return await window.storageFixture.seed(' + JSON.stringify(tag) + ', "top")'),
        top,
      );
      assert.equal(
        evalChild('return await window.storageFixture.seed(' + JSON.stringify(tag) + ', "sub")'),
        sub,
      );

      // 2. Origins: the top frame in the root session, the OOPIF in its child session.
      const origins = store({ action: 'origins' }).origins;
      assert.deepEqual(
        origins.map((entry) => [entry.origin, entry.sessionId ?? 'root', entry.storageKey]),
        [
          [top, 'root', top + '/'],
          [sub, child.sessionId, sub + '/^0http://127.0.0.1'],
        ],
      );

      // 3. Cookies: httpOnly on the top origin, partitioned in the cross-site child.
      const host = store({
        action: 'setCookie',
        name: tag + '_host',
        value: 'host-' + runId,
        url: top + '/',
        httpOnly: true,
      }).cookie;
      assert.deepEqual(
        [host.domain, host.path, host.httpOnly, host.session, host.value],
        ['127.0.0.1', '/', true, true, 'host-' + runId],
      );
      const partitionKey = { topLevelSite: 'http://127.0.0.1', hasCrossSiteAncestor: true };
      const chip = store({
        action: 'setCookie',
        name: tag + '_chip',
        value: 'chip-' + runId,
        url: sub + '/',
        secure: true,
        sameSite: 'None',
        partitionKey,
        expires: Math.floor(Date.now() / 1000) + 3600,
      }).cookie;
      assert.deepEqual(chip.partitionKey, partitionKey);
      assert.equal(typeof chip.expires, 'number');
      evalPage(
        'document.cookie = ' + JSON.stringify(tag + '_js=js-' + runId + '; Path=/') + '; return 1',
      );
      evalChild(
        'document.cookie = ' +
          JSON.stringify(
            tag + '_jschip=jschip-' + runId + '; Path=/; Secure; SameSite=None; Partitioned',
          ) +
          '; return 1',
      );
      // httpOnly is hidden from the page but listed; the child page sees its partitioned cookie.
      assert.deepEqual(
        evalPage('return window.storageFixture.cookieNames(' + JSON.stringify(tag) + ')'),
        [tag + '_js'],
      );
      assert.deepEqual(
        evalChild('return window.storageFixture.cookieNames(' + JSON.stringify(tag) + ')'),
        [tag + '_chip', tag + '_jschip'],
      );
      const everyFrame = own(store({ action: 'cookies', limit: 1000 }).cookies);
      assert.deepEqual(
        everyFrame.map((cookie) => [cookie.name, cookie.domain, !!cookie.partitionKey]).sort(),
        [
          [tag + '_chip', 'localhost', true],
          [tag + '_host', '127.0.0.1', false],
          [tag + '_js', '127.0.0.1', false],
          [tag + '_jschip', 'localhost', true],
        ],
      );
      const forSub = own(store({ action: 'cookies', url: sub + '/' }).cookies);
      assert.deepEqual(forSub.map((cookie) => cookie.name).sort(), [
        tag + '_chip',
        tag + '_jschip',
      ]);
      const redacted = shown({ action: 'cookies', url: top + '/', name: tag + '_host' });
      assert.deepEqual(
        redacted.cookies.map((cookie) => [cookie.value, cookie.valueChars]),
        [['[REDACTED]', ('host-' + runId).length]],
      );
      assert(!JSON.stringify(redacted).includes(runId), 'cookie value hidden by default');

      // 4. Cookie rejections and exact deletion.
      const cookieRejected = {
        sameSiteNone: storeFails({
          action: 'setCookie',
          name: tag + '_bad',
          value: 'x',
          url: top + '/',
          sameSite: 'None',
        }),
        foreignDomain: storeFails({
          action: 'setCookie',
          name: tag + '_bad',
          value: 'x',
          url: top + '/',
          domain: 'example.com',
        }),
        notInTab: storeFails({
          action: 'setCookie',
          name: tag + '_bad',
          value: 'x',
          url: 'http://example.invalid/',
        }),
        pastExpiry: storeFails({
          action: 'setCookie',
          name: tag + '_host',
          value: 'x',
          url: top + '/',
          expires: 1,
        }),
        unpartitioned: storeFails({ action: 'deleteCookie', name: tag + '_chip', url: sub + '/' }),
      };
      assert.deepEqual(cookieRejected, {
        sameSiteNone: 'COOKIE_REJECTED',
        foreignDomain: 'INVALID_ARGUMENT',
        notInTab: 'STORAGE_ORIGIN_NOT_FOUND',
        pastExpiry: 'INVALID_ARGUMENT',
        unpartitioned: 'COOKIE_NOT_FOUND',
      });
      assert.deepEqual(own(store({ action: 'cookies', name: tag + '_bad' }).cookies), []);
      const deleted = store({
        action: 'deleteCookie',
        name: tag + '_chip',
        url: sub + '/',
        partitionKey,
      }).deleted;
      assert.deepEqual(
        deleted.map((cookie) => [cookie.name, cookie.domain]),
        [[tag + '_chip', 'localhost']],
      );
      assert.deepEqual(
        evalChild('return window.storageFixture.cookieNames(' + JSON.stringify(tag) + ')'),
        [tag + '_jschip'],
      );

      // 5. local/sessionStorage: one origin and area per call, visible to the page.
      store({ action: 'setItem', origin: top, area: 'local', key: tag + '_a', value: 'top-a' });
      store({ action: 'setItem', origin: sub, area: 'local', key: tag + '_a', value: 'sub-a' });
      store({ action: 'setItem', origin: top, area: 'session', key: tag + '_s', value: 'top-s' });
      store({
        action: 'setItem',
        origin: top,
        area: 'local',
        key: tag + '_profile',
        value: JSON.stringify({ name: 'n', password: 'pw-' + runId }),
      });
      store({
        action: 'setItem',
        origin: top,
        area: 'local',
        key: tag + '_token',
        value: 'tk-' + runId,
      });
      store({
        action: 'setItem',
        origin: top,
        area: 'local',
        key: tag + '_big',
        value: 'word '.repeat(3000),
      });
      const overwritten = store({
        action: 'setItem',
        origin: top,
        area: 'local',
        key: tag + '_a',
        value: 'top-a2',
      });
      assert.deepEqual([overwritten.created, overwritten.previousChars], [false, 5]);
      assert.equal(
        evalPage('return window.storageFixture.read("local", ' + JSON.stringify(tag + '_a') + ')'),
        'top-a2',
      );
      assert.equal(
        evalChild('return window.storageFixture.read("local", ' + JSON.stringify(tag + '_a') + ')'),
        'sub-a',
      );
      assert.equal(
        evalPage(
          'return window.storageFixture.read("session", ' + JSON.stringify(tag + '_s') + ')',
        ),
        'top-s',
      );
      const topItems = shown({
        action: 'items',
        origin: top,
        area: 'local',
        prefix: tag,
        maxOutputBytes: 2000,
      });
      const byKey = Object.fromEntries(topItems.items.map((item) => [item.key, item]));
      assert.deepEqual(Object.keys(byKey), [
        tag + '_a',
        tag + '_big',
        tag + '_profile',
        tag + '_token',
      ]);
      assert.equal(topItems.total, 4);
      assert.equal(byKey[tag + '_a'].value, 'top-a2');
      assert.equal(byKey[tag + '_token'].value, '[REDACTED]');
      assert.deepEqual(JSON.parse(byKey[tag + '_profile'].value), {
        name: 'n',
        password: '[REDACTED]',
      });
      assert.deepEqual([byKey[tag + '_big'].chars, byKey[tag + '_big'].truncated], [15000, true]);
      assert(!JSON.stringify(topItems).includes(runId), 'storage secrets hidden by default');
      const raw = store({ action: 'items', origin: top, area: 'local', key: tag + '_token' });
      assert.deepEqual(
        raw.items.map((item) => item.value),
        ['tk-' + runId],
      );
      const subItems = store({ action: 'items', origin: sub, area: 'local', prefix: tag });
      assert.deepEqual(
        [subItems.storageKey, subItems.items.map((item) => item.value)],
        [sub + '/^0http://127.0.0.1', ['sub-a']],
      );
      const paged = store({ action: 'items', origin: top, area: 'local', prefix: tag, limit: 3 });
      assert.deepEqual([paged.items.length, paged.nextOffset, paged.hasMore], [3, 3, true]);
      assert.equal(
        store({ action: 'removeItem', origin: top, area: 'local', key: tag + '_big' }).removed,
        true,
      );
      const storageRejected = {
        removedAgain: storeFails({
          action: 'removeItem',
          origin: top,
          area: 'local',
          key: tag + '_big',
        }),
        foreignOrigin: storeFails({ action: 'items', origin: 'https://linux.do', area: 'local' }),
        notOrigin: storeFails({ action: 'items', origin: top + '/storage', area: 'local' }),
        wrongParam: storeFails({ action: 'clearItems', origin: top, area: 'local', key: tag }),
        // Closed schema: rejected by the native server before the extension.
        schema: assertFailure(
          runCli(name, ['call', 'chrome_cdp_storage', '{"action":"clearAll"}']),
          'unknown action',
        ).error.code,
      };
      assert.deepEqual(storageRejected, {
        removedAgain: 'STORAGE_KEY_NOT_FOUND',
        foreignOrigin: 'STORAGE_ORIGIN_NOT_FOUND',
        notOrigin: 'INVALID_ARGUMENT',
        wrongParam: 'INVALID_ARGUMENT',
        schema: 'INVALID_ARGUMENT',
      });
      // clearItems empties one area of one origin; the run's sessionStorage holds only its key.
      assert.equal(
        store({ action: 'clearItems', origin: top, area: 'session' }).cleared >= 1,
        true,
      );
      assert.equal(
        evalPage(
          'return window.storageFixture.read("session", ' + JSON.stringify(tag + '_s') + ')',
        ),
        null,
      );
      assert.equal(
        evalPage('return window.storageFixture.read("local", ' + JSON.stringify(tag + '_a') + ')'),
        'top-a2',
      );

      // 6. IndexedDB: structure, paged range reads through the store and an index.
      const dbName = tag + '-db';
      const databases = store({ action: 'databases', origin: top }).databases.filter((db) =>
        db.name.startsWith(tag),
      );
      assert.deepEqual(databases, [
        {
          name: dbName,
          version: 3,
          stores: [
            { name: 'plain', keyPath: null, autoIncrement: true, count: 1, indexes: [] },
            {
              name: 'records',
              keyPath: 'id',
              autoIncrement: false,
              count: 31,
              indexes: [{ name: 'byKind', keyPath: 'kind', unique: false, multiEntry: false }],
            },
          ],
        },
      ]);
      const read = (args) =>
        store({ action: 'readStore', origin: top, database: dbName, store: 'records', ...args });
      const first = read({ limit: 5 });
      assert.deepEqual(
        [first.total, first.entries.map((entry) => entry.key), first.nextOffset, first.hasMore],
        [31, [1, 2, 3, 4, 5], 5, true],
      );
      const second = read({ offset: 5, limit: 2 });
      assert.deepEqual(
        second.entries.map((entry) => entry.value.label),
        ['top-6', 'top-7'],
      );
      const ranged = read({
        range: { lower: 10, upper: 20, upperOpen: true },
        direction: 'prev',
        limit: 3,
      });
      assert.deepEqual(
        [ranged.total, ranged.entries.map((entry) => entry.key)],
        [10, [19, 18, 17]],
      );
      const kindC = read({ index: 'byKind', range: { only: 'c' }, limit: 100 });
      assert.deepEqual(
        [kindC.total, kindC.entries.map((entry) => [entry.key, entry.primaryKey]).slice(0, 2)],
        [
          10,
          [
            ['c', 3],
            ['c', 6],
          ],
        ],
      );
      const secretRow = shown({
        action: 'readStore',
        origin: top,
        database: dbName,
        store: 'records',
        range: { only: 31 },
      });
      assert.equal(secretRow.redacted, true);
      assert.deepEqual(secretRow.entries[0].value.token, '[REDACTED]');
      assert.deepEqual(secretRow.entries[0].value.nested.password, '[REDACTED]');
      assert.deepEqual(secretRow.entries[0].value.bytes, {
        $type: 'Uint8Array',
        bytes: 4,
        base64: 'AAEC/w==',
      });
      assert.deepEqual(secretRow.entries[0].value.when, {
        $type: 'Date',
        iso: '1970-01-01T00:00:00.000Z',
      });
      assert(!JSON.stringify(secretRow).includes(runId), 'IndexedDB secrets hidden by default');
      assert.equal(read({ range: { only: 31 } }).entries[0].value.token, 'tok-' + tag);
      const subRead = store({
        action: 'readStore',
        origin: sub,
        database: dbName,
        store: 'records',
        limit: 1,
      });
      assert.equal(subRead.entries[0].value.label, 'sub-1');
      const idbRejected = {
        database: storeFails({
          action: 'readStore',
          origin: top,
          database: tag + '-none',
          store: 'records',
        }),
        store: storeFails({ action: 'readStore', origin: top, database: dbName, store: 'none' }),
        index: storeFails({
          action: 'readStore',
          origin: top,
          database: dbName,
          store: 'records',
          index: 'none',
        }),
        range: storeFails({
          action: 'readStore',
          origin: top,
          database: dbName,
          store: 'records',
          range: { lower: 5, upper: 1 },
        }),
      };
      assert.deepEqual(idbRejected, {
        database: 'IDB_DATABASE_NOT_FOUND',
        store: 'IDB_STORE_NOT_FOUND',
        index: 'IDB_INDEX_NOT_FOUND',
        range: 'INVALID_ARGUMENT',
      });
      // A missing database is not created by the read.
      assert.deepEqual(
        evalPage(
          'return (await window.storageFixture.check(' + JSON.stringify(tag) + ')).databases',
        ),
        [dbName],
      );

      // 7. Cache Storage, including the OOPIF's partitioned cache in its own session.
      const cacheName = tag + '-cache';
      assert(store({ action: 'caches', origin: top }).caches.includes(cacheName));
      const entries = store({ action: 'cacheEntries', origin: top, cache: cacheName });
      assert.deepEqual(entries.entries.map((entry) => [entry.url, entry.status]).sort(), [
        [top + '/storage-cached.bin', 200],
        [top + '/storage-cached.json', 200],
      ]);
      assert.equal(entries.total, 2);
      const filtered = store({
        action: 'cacheEntries',
        origin: top,
        cache: cacheName,
        pathFilter: '.json',
      });
      assert.deepEqual(
        filtered.entries.map((entry) => entry.url),
        [top + '/storage-cached.json'],
      );
      const json = shown({
        action: 'cacheResponse',
        origin: top,
        cache: cacheName,
        url: top + '/storage-cached.json',
      });
      assert.deepEqual(
        [json.mimeType, json.unit, JSON.parse(json.text).side, json.redacted],
        ['application/json', 'chars', 'top', true],
      );
      assert(!json.text.includes('abcdefghijklmnop'), 'cached token redacted');
      const binary = store({
        action: 'cacheResponse',
        origin: top,
        cache: cacheName,
        url: top + '/storage-cached.bin',
      });
      assert.deepEqual([binary.base64, binary.data, binary.totalBytes], [true, 'AAECA/8=', 5]);
      const subJson = store({
        action: 'cacheResponse',
        origin: sub,
        cache: cacheName,
        url: sub + '/storage-cached.json',
      });
      assert.equal(JSON.parse(subJson.text).side, 'sub');
      const cacheRejected = {
        cache: storeFails({ action: 'cacheEntries', origin: top, cache: tag + '-none' }),
        entry: storeFails({
          action: 'cacheResponse',
          origin: top,
          cache: cacheName,
          url: top + '/none',
        }),
      };
      assert.deepEqual(cacheRejected, { cache: 'CACHE_NOT_FOUND', entry: 'CACHE_ENTRY_NOT_FOUND' });

      // 8. Paused top frame: page JS and CacheStorage would hang, so they fail at once; cookies
      // and the running OOPIF still answer. Nothing evaluates in the paused page.
      const requested = dbg({ action: 'pause', timeoutMs: 0 });
      evalChild('parent.postMessage("tick", "*"); return 1');
      const paused = requested.paused ? requested : dbg({ action: 'wait', timeoutMs: 10000 });
      assert.equal(paused.paused, true, JSON.stringify(paused));
      const pausedCalls = {
        items: storeFails({ action: 'items', origin: top, area: 'local' }),
        databases: storeFails({ action: 'databases', origin: top }),
        caches: storeFails({ action: 'caches', origin: top }),
      };
      assert.deepEqual(pausedCalls, {
        items: 'STORAGE_PAGE_PAUSED',
        databases: 'STORAGE_PAGE_PAUSED',
        caches: 'STORAGE_PAGE_PAUSED',
      });
      assert.equal(own(store({ action: 'cookies', url: top + '/' }).cookies).length, 2);
      assert.equal(store({ action: 'items', origin: sub, area: 'local', prefix: tag }).total, 1);
      assert(store({ action: 'caches', origin: sub }).caches.includes(cacheName));
      assert.equal(dbg({ action: 'resume' }).resumed, true);
      assert.equal(
        store({ action: 'items', origin: top, area: 'local', key: tag + '_a' }).total,
        1,
      );

      // 9. Other tasks cannot use the held session.
      assert.equal(
        fails(other, 'chrome_cdp_storage', { tabId: tabs[0], action: 'origins' }),
        'CDP_SESSION_OWNED',
      );

      // 10. Cleanup through the tool and the pages leaves nothing of the run.
      for (const cookie of own(store({ action: 'cookies', limit: 1000 }).cookies)) {
        const domainUrl = (cookie.domain === 'localhost' ? sub : top) + cookie.path;
        store({
          action: 'deleteCookie',
          name: cookie.name,
          url: domainUrl,
          ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {}),
        });
      }
      const empty = { databases: [], caches: [], local: [], tabArea: [], jar: [] };
      assert.deepEqual(
        evalPage('return await window.storageFixture.cleanup(' + JSON.stringify(tag) + ')'),
        empty,
      );
      assert.deepEqual(
        evalChild('return await window.storageFixture.cleanup(' + JSON.stringify(tag) + ')'),
        empty,
      );
      assert.deepEqual(own(store({ action: 'cookies', limit: 1000 }).cookies), []);

      return {
        ok: true,
        runId,
        origins: origins.length,
        cookies: {
          httpOnly: true,
          partitioned: true,
          everyFrame: everyFrame.length,
          exactDelete: true,
        },
        cookieRejected,
        storage: { perOrigin: true, redacted: true, truncated: true },
        storageRejected,
        indexedDB: {
          stores: databases[0].stores.length,
          rangePaged: true,
          index: true,
          binary: true,
        },
        idbRejected,
        cacheStorage: { entries: entries.total, text: true, binary: true, oopif: true },
        cacheRejected,
        pausedCalls,
        cleaned: true,
      };
    },
    async () => {
      const errors = [];
      if (started && tabs[0] !== undefined) {
        const quiet = (tool, args) =>
          runCli(name, ['call', tool, JSON.stringify({ tabId: tabs[0], ...args })]);
        // Resume first: cleanup evaluates in the page.
        quiet('chrome_cdp_debugger', { action: 'resume' });
        const listed = quiet('chrome_cdp_storage', {
          action: 'cookies',
          limit: 1000,
          sanitizeOutput: false,
        });
        const port = fixture && new URL(fixture.origin).port;
        for (const cookie of listed.response?.ok ? own(listed.response.result.cookies) : []) {
          const host = cookie.domain === 'localhost' ? 'http://localhost:' + port : fixture.origin;
          quiet('chrome_cdp_storage', {
            action: 'deleteCookie',
            name: cookie.name,
            url: host + cookie.path,
            ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {}),
          });
        }
        const code = 'return await window.storageFixture.cleanup(' + JSON.stringify(tag) + ')';
        const topClean = runCli(name, ['eval', code]);
        if (topClean.response?.ok !== true) errors.push('clean top storage: ' + topClean.stdout);
        if (child) {
          const childClean = quiet('chrome_javascript', { sessionId: child.sessionId, code });
          if (childClean.response?.ok !== true)
            errors.push('clean child storage: ' + childClean.stdout);
        }
        const stop = quiet('chrome_cdp_session', { action: 'stop' });
        if (stop.response?.ok !== true) errors.push('stop held session: ' + stop.stdout);
      }
      errors.push(...cleanupTargets(runCli, [name, other], urls, tabs));
      if (fixture) {
        try {
          await fixture.close();
        } catch (error) {
          errors.push(String(error));
        }
      }
      if (errors.length) throw new Error(errors.join('\n'));
    },
  );
}

if (require.main === module)
  runCdpStorage()
    .then((result) => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch((error) => {
      process.stderr.write(String(error.stack || error) + '\n');
      if (error instanceof AggregateError)
        for (const cause of error.errors) process.stderr.write(String(cause.stack || cause) + '\n');
      process.exitCode = 1;
    });

module.exports = { runCdpStorage };
