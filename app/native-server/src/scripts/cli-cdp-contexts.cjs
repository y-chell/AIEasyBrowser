'use strict';

// Real-browser acceptance for B4 execution contexts: chrome_javascript in any frame (same-process,
// same-URL siblings, cross-process OOPIF and a frame nested inside it) in MAIN or ISOLATED world,
// in dedicated/service/shared workers, and the failures that must not run code elsewhere.
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

const EXTENSION_ID = 'coleelkpegcobndoloaofalgnkhiamll';

function errorCode(response) {
  return /([A-Z_]{6,}):/.exec(response.error.message)?.[1];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runCdpContexts() {
  const runId = randomUUID().replaceAll('-', '');
  const name = 'cdpctx_' + runId.slice(0, 8);
  const other = name + '_other';
  const probe = name + '_probe';
  const tabs = [];
  const urls = [];
  let fixture;
  let started = false;
  let serviceWorker = false;
  const ok = (session, args, label) => assertOk(runCli(session, args), label || args[1] || args[0]);
  const call = (session, tool, args, label) =>
    ok(session, ['call', tool, JSON.stringify(args)], label || tool).result;
  const js = (args, session = name) => {
    const result = call(session, 'chrome_javascript', args, 'javascript ' + JSON.stringify(args));
    return { ...result, value: jsValue({ result }) };
  };
  const jsFails = (args, session = name) =>
    errorCode(
      assertFailure(
        runCli(session, ['call', 'chrome_javascript', JSON.stringify(args)]),
        'javascript must fail ' + JSON.stringify(args),
      ),
    );
  const cdpSession = (args, session = name) =>
    call(session, 'chrome_cdp_session', args, 'cdp_session ' + args.action);
  const debugTargets = (filter) =>
    jsValue(
      ok(probe, [
        'eval',
        'const targets = await chrome.debugger.getTargets(); return targets.filter((t) => ' +
          filter +
          // Target IDs are 32-hex and redacted in output; the filter selects by ID instead.
          ').map((t) => ({ type: t.type, attached: t.attached }));',
      ]),
    );

  return runWithCleanup(
    async () => {
      const session = ok(name, ['describe', 'chrome_cdp_session']).result;
      assert(
        session.inputSchema.properties.action.enum.includes('workers'),
        'running extension lacks B4 chrome_cdp_session workers; rebuild and reload it first',
      );
      fixture = await createFixtureServer(runId);
      const pageUrl = fixture.origin + '/frames?workers=1&run=' + name;
      urls.push(pageUrl);
      const tabId = ok(name, ['open', pageUrl, '--background']).result.tabId;
      tabs.push(tabId);
      ok(name, [
        'wait',
        JSON.stringify({ kind: 'javascript', predicate: 'document.readyState === "complete"' }),
      ]);
      // Page CSP forbids eval in the page itself; none of the CDP paths below depend on it.
      assert.equal(jsValue(ok(name, ['eval', 'return window.pageEval'])), 'EvalError');
      serviceWorker = true;
      assert.equal(jsValue(ok(name, ['eval', 'return await window.swReady'])), 'ready');
      tabs.push(
        ok(probe, [
          'open',
          'chrome-extension://' + EXTENSION_ID + '/offscreen.html',
          '--background',
        ]).result.tabId,
      );

      const frames = call(name, 'chrome_list_frames', { includeDetails: false }).frames;
      const frameOf = (query) => {
        const matches = frames.filter((frame) => frame.url.includes(query));
        assert.equal(matches.length, 1, 'frame ' + query + ': ' + JSON.stringify(frames));
        return matches[0].frameId;
      };
      const same = frameOf('name=same');
      const [dupA, dupB] = frames
        .filter((frame) => frame.url.endsWith('name=dup'))
        .map((frame) => frame.frameId)
        .sort((a, b) => a - b);
      const cross = frameOf('name=cross&nest=1');
      const nested = frameOf('name=cross-nested');
      assert(dupA !== undefined && dupB !== undefined, 'two same-URL frames expected');

      // 1. Same-process frame, MAIN world: page globals of that frame, not the top frame.
      const sameMain = js({
        frameId: same,
        code: 'return [window.frameName, location.search, typeof window.runMarker]',
      });
      assert.deepEqual(sameMain.value, ['same', '?name=same', 'undefined']);
      assert.equal(sameMain.world, 'MAIN');
      assert.equal(sameMain.sessionId, undefined);
      // CLI eval --frame is the same path (KI-08 failed here with an unsafe-eval CSP error).
      assert.equal(
        jsValue(ok(name, ['eval', '--frame', String(same), 'return window.frameName'])),
        'same',
      );

      // 2. Same-URL siblings: each frameId reaches its own document. The marker written through
      // chrome_javascript is read back with the frame-scoped DOM query, an independent path.
      const dupAResult = js({ frameId: dupA, code: 'document.body.dataset.mark = "A"; return 1' });
      const dupBResult = js({ frameId: dupB, code: 'document.body.dataset.mark = "B"; return 1' });
      assert.notEqual(dupAResult.cdpFrameId, dupBResult.cdpFrameId);
      for (const [frameId, mark] of [
        [dupA, 'A'],
        [dupB, 'B'],
      ]) {
        const found = call(name, 'chrome_query_elements', { frameId, selector: 'body' }).elements;
        assert.equal(found[0].attributes['data-mark'], mark, 'marker of frame ' + frameId);
      }

      // 3. ISOLATED world: shares the DOM, not page globals; its globals persist across calls.
      const isolated = js({
        frameId: same,
        world: 'ISOLATED',
        code: 'globalThis.isoMark = 5; return [typeof window.frameName, document.querySelector("#name").textContent]',
      });
      assert.deepEqual(isolated.value, ['undefined', 'same']);
      assert.equal(isolated.world, 'ISOLATED');
      assert.equal(
        js({ frameId: same, world: 'ISOLATED', code: 'return globalThis.isoMark' }).value,
        5,
      );
      assert.equal(
        js({ frameId: same, code: 'return typeof globalThis.isoMark' }).value,
        'undefined',
      );
      const topIsolated = js({
        world: 'ISOLATED',
        code: 'return [typeof window.runMarker, document.title]',
      });
      assert.deepEqual(topIsolated.value, ['undefined', 'Frames fixture ' + runId]);

      // 4. A frame JS predicate waits in that frame.
      ok(name, [
        'wait',
        '--frame',
        String(same),
        '--no-scan',
        JSON.stringify({ kind: 'javascript', predicate: 'window.frameName === "same"' }),
      ]);

      // 5. A cross-process frame without a held session fails and runs nothing anywhere.
      const marker = 'window.leak = "' + runId + '"; return location.origin';
      assert.equal(jsFails({ frameId: cross, code: marker }), 'CDP_SESSION_NOT_STARTED');
      assert.equal(js({ code: 'return typeof window.leak' }).value, 'undefined');

      // 6. With the task's held session the OOPIF root and the frame nested inside it run there.
      cdpSession({ action: 'start' });
      started = true;
      const crossMain = js({ frameId: cross, code: 'return [location.origin, window.frameName]' });
      assert.match(crossMain.value[0], /^http:\/\/localhost:\d+$/);
      assert.equal(crossMain.value[1], 'cross');
      assert(crossMain.sessionId, 'OOPIF result reports its child session');
      const status = cdpSession({ action: 'status' });
      const oopif = status.targets.find((target) => target.type === 'iframe');
      assert.equal(crossMain.sessionId, oopif.sessionId);
      assert.equal(crossMain.cdpFrameId, oopif.targetId);
      const nestedMain = js({ frameId: nested, code: 'return window.frameName' });
      assert.equal(nestedMain.value, 'cross-nested');
      assert.equal(nestedMain.sessionId, oopif.sessionId);
      const nestedIsolated = js({
        frameId: nested,
        world: 'ISOLATED',
        code: 'return [typeof window.frameName, location.search]',
      });
      assert.deepEqual(nestedIsolated.value, ['undefined', '?name=cross-nested']);
      assert.equal(js({ code: 'return typeof window.leak' }).value, 'undefined');
      // Another task cannot borrow this task's child session.
      assert.equal(
        jsFails({ tabId, frameId: cross, code: 'return 1' }, other),
        'CDP_SESSION_OWNED',
      );

      // 7. Workers: dedicated and service worker child sessions, shared worker by target ID.
      let listed;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        listed = cdpSession({ action: 'workers' });
        const types = listed.sessions.map((target) => target.type);
        if (types.includes('worker') && types.includes('service_worker')) break;
        await sleep(150);
      }
      const child = (type) => listed.sessions.find((target) => target.type === type);
      assert(child('worker') && child('service_worker'), JSON.stringify(listed));
      // The 32-hex runId would be redacted as a token in the output, so compare it in the worker.
      const workerCode =
        'return [self.workerKind, self.runMarker === ' +
        JSON.stringify(runId) +
        ', typeof WorkerGlobalScope]';
      assert.deepEqual(js({ sessionId: child('worker').sessionId, code: workerCode }).value, [
        'dedicated',
        true,
        'function',
      ]);
      assert.deepEqual(
        js({ sessionId: child('service_worker').sessionId, code: workerCode }).value,
        ['service', true, 'function'],
      );
      const shared = listed.browserTargets.find((target) => target.url.includes('kind=shared'));
      assert(shared, 'shared worker not listed: ' + JSON.stringify(listed.browserTargets));
      assert.deepEqual(js({ workerTargetId: shared.workerTargetId, code: workerCode }).value, [
        'shared',
        true,
        'function',
      ]);
      assert.deepEqual(
        debugTargets('t.id === ' + JSON.stringify(shared.workerTargetId)),
        [{ type: 'worker', attached: false }],
        'shared worker still attached after the call',
      );

      // 8. Explicit failures before or instead of execution.
      const rejected = {
        unknownFrame: jsFails({ frameId: 999999, code: 'return 1' }),
        unknownWorker: jsFails({ workerTargetId: 'not-a-target', code: 'return 1' }),
        unknownSession: jsFails({ sessionId: 'not-a-session', code: 'return 1' }),
        twoContexts: jsFails({ frameId: same, sessionId: oopif.sessionId, code: 'return 1' }),
        isolatedWorker: jsFails({
          sessionId: child('worker').sessionId,
          world: 'ISOLATED',
          code: 'return 1',
        }),
      };
      assert.deepEqual(rejected, {
        unknownFrame: 'FRAME_NOT_FOUND',
        unknownWorker: 'WORKER_NOT_FOUND',
        unknownSession: 'CDP_UNKNOWN_SESSION',
        twoContexts: 'INVALID_ARGUMENT',
        isolatedWorker: 'INVALID_ARGUMENT',
      });

      // 9. stop leaves no attach on the tab; the OOPIF frame is refused again.
      assert.equal(cdpSession({ action: 'stop' }).stopped, true);
      started = false;
      assert.deepEqual(debugTargets('t.tabId === ' + tabId + ' && t.attached'), []);
      assert.equal(jsFails({ frameId: cross, code: 'return 1' }), 'CDP_SESSION_NOT_STARTED');

      return {
        ok: true,
        runId,
        frames: {
          same: sameMain.cdpFrameId,
          dupDistinct: dupAResult.cdpFrameId !== dupBResult.cdpFrameId,
          oopif: crossMain.value[0],
          nested: nestedMain.value,
        },
        isolated: { persists: true, hiddenFromMain: true },
        workers: ['dedicated', 'service', 'shared'],
        rejected,
        detachedAfterStop: true,
        cleaned: true,
      };
    },
    async () => {
      const errors = [];
      if (started && tabs[0] !== undefined) {
        const stop = runCli(name, [
          'call',
          'chrome_cdp_session',
          JSON.stringify({ tabId: tabs[0], action: 'stop' }),
        ]);
        if (stop.response?.ok !== true) errors.push('stop held session: ' + stop.stdout);
      }
      if (serviceWorker && tabs[0] !== undefined) {
        // Registrations outlive the tab; remove this run's so later runs start clean.
        const removed = runCli(name, [
          'eval',
          'const all = await navigator.serviceWorker.getRegistrations(); for (const r of all) await r.unregister(); return (await navigator.serviceWorker.getRegistrations()).length',
        ]);
        if (removed.response?.ok !== true || jsValue(removed.response) !== 0) {
          errors.push('unregister service worker: ' + removed.stdout);
        }
      }
      errors.push(...cleanupTargets(runCli, [name, other, probe], urls, tabs));
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
  runCdpContexts()
    .then((result) => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch((error) => {
      process.stderr.write(String(error.stack || error) + '\n');
      if (error instanceof AggregateError)
        for (const cause of error.errors) process.stderr.write(String(cause.stack || cause) + '\n');
      process.exitCode = 1;
    });

module.exports = { runCdpContexts };
