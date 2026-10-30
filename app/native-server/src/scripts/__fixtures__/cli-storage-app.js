'use strict';

/* global window, document, location, indexedDB, caches */
// Served to the storage fixture page and its cross-site child: everything it creates is named
// after the run tag, and cleanup removes exactly that.
(() => {
  const request = (r) =>
    new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  const kind = (id) => (id % 3 === 0 ? 'c' : id % 2 ? 'a' : 'b');
  const ownKeys = (area, tag) => {
    const keys = [];
    for (let index = 0; index < area.length; index += 1) {
      if (area.key(index).startsWith(tag)) keys.push(area.key(index));
    }
    return keys.sort();
  };
  const ownCookies = (tag) =>
    document.cookie
      .split(';')
      .map((part) => part.trim().split('=')[0])
      .filter((name) => name.startsWith(tag))
      .sort();

  window.storageFixture = {
    async seed(tag, side) {
      const open = indexedDB.open(tag + '-db', 3);
      open.onupgradeneeded = () => {
        const records = open.result.createObjectStore('records', { keyPath: 'id' });
        records.createIndex('byKind', 'kind');
        open.result.createObjectStore('plain', { autoIncrement: true });
      };
      const db = await request(open);
      await new Promise((resolve, reject) => {
        const tx = db.transaction(['records', 'plain'], 'readwrite');
        const records = tx.objectStore('records');
        for (let id = 1; id <= 30; id += 1) {
          records.put({ id, kind: kind(id), label: side + '-' + id });
        }
        records.put({
          id: 31,
          kind: 'secret',
          token: 'tok-' + tag,
          nested: { password: 'pw-' + tag },
          note: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123',
          bytes: new Uint8Array([0, 1, 2, 255]),
          when: new Date(0),
        });
        tx.objectStore('plain').put('plain-' + side);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      const cache = await caches.open(tag + '-cache');
      await cache.put(
        location.origin + '/storage-cached.json',
        new Response(
          JSON.stringify({
            ok: true,
            side,
            auth: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123',
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
      );
      await cache.put(
        location.origin + '/storage-cached.bin',
        new Response(new Uint8Array([0, 1, 2, 3, 255]), {
          headers: { 'Content-Type': 'application/octet-stream' },
        }),
      );
      return location.origin;
    },
    // Only the run's own names; nothing else of the origin is touched.
    async cleanup(tag) {
      for (const name of (await indexedDB.databases()).map((info) => info.name)) {
        if (name && name.startsWith(tag)) await request(indexedDB.deleteDatabase(name));
      }
      for (const name of await caches.keys()) {
        if (name.startsWith(tag)) await caches.delete(name);
      }
      for (const area of [localStorage, sessionStorage]) {
        for (const key of ownKeys(area, tag)) area.removeItem(key);
      }
      for (const name of ownCookies(tag)) {
        document.cookie = name + '=; Path=/; Max-Age=0';
        document.cookie = name + '=; Path=/; Max-Age=0; Secure; SameSite=None; Partitioned';
      }
      return this.check(tag);
    },
    async check(tag) {
      return {
        databases: (await indexedDB.databases())
          .map((info) => info.name)
          .filter((name) => name && name.startsWith(tag)),
        caches: (await caches.keys()).filter((name) => name.startsWith(tag)),
        // Neutral names: "session" and "cookie" keys are redacted in eval output.
        local: ownKeys(localStorage, tag),
        tabArea: ownKeys(sessionStorage, tag),
        jar: ownCookies(tag),
      };
    },
    read(area, key) {
      return (area === 'local' ? localStorage : sessionStorage).getItem(key);
    },
    cookieNames: ownCookies,
  };
})();
