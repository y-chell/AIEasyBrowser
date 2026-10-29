'use strict';

// Real-browser acceptance for B5 chrome_cdp_inject on a held chrome_cdp_session: document-start
// scripts (main and named world) in the top frame, same-process frames and a re-created OOPIF;
// function/property/fetch/xhr hooks whose records arrive as AEB.hook events; limits, removal,
// rejections, and nothing left behind after stop.
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
const WORLD = 'aeb-inject-test';

function errorCode(response) {
  return /([A-Z_]{6,}):/.exec(response.error.message)?.[1];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runCdpInject() {
  const runId = randomUUID().replaceAll('-', '');
  const name = 'cdpinj_' + runId.slice(0, 8);
  const other = name + '_other';
  const probe = name + '_probe';
  const tabs = [];
  const urls = [];
  let fixture;
  let started = false;
  const ok = (session, args, label) => assertOk(runCli(session, args), label || args[1] || args[0]);
  const call = (session, tool, args, label) =>
    ok(session, ['call', tool, JSON.stringify(args)], label || tool).result;
  const fails = (session, tool, args, label) =>
    errorCode(assertFailure(runCli(session, ['call', tool, JSON.stringify(args)]), label || tool));
  const inject = (args) => call(name, 'chrome_cdp_inject', args, 'cdp_inject ' + args.action);
  const cdpSession = (args) => call(name, 'chrome_cdp_session', args, 'cdp_session ' + args.action);
  // Frame IDs are 32-hex and would be redacted; they are passed back, not printed.
  const cdp = (method, params = {}) =>
    call(name, 'chrome_cdp_command', { method, params, sanitizeOutput: false }, method).result;
  const evalPage = (code) => jsValue(ok(name, ['eval', code]));
  const js = (args) => jsValue({ result: call(name, 'chrome_javascript', args, 'javascript') });
  const debugTargets = (filter) =>
    jsValue(
      ok(probe, [
        'eval',
        'const targets = await chrome.debugger.getTargets(); return targets.filter((t) => ' +
          filter +
          ').map((t) => ({ type: t.type, attached: t.attached }));',
      ]),
    );
  // Records are page data with test values only; read them raw so absent secrets are meaningful.
  const hookEvents = (after) => {
    const events = [];
    let cursor = after;
    for (;;) {
      const page = cdpSession({ action: 'events', after: cursor, sanitizeOutput: false });
      events.push(...page.events.filter((event) => event.method === 'AEB.hook'));
      cursor = page.nextAfter;
      if (!page.hasMore) return { events, cursor };
    }
  };
  const waitForHooks = async (after, done, label) => {
    let seen;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      seen = hookEvents(after);
      if (done(seen.events)) return seen;
      await sleep(200);
    }
    throw new Error(label + ' not recorded: ' + JSON.stringify(seen.events).slice(0, 3000));
  };
  const reload = () => {
    evalPage('setTimeout(() => location.reload(), 0); return 1');
  };
  const waitLoaded = async () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const state = runCli(name, [
        'eval',
        'return document.readyState === "complete" && !!window.app',
      ]);
      if (state.response?.ok === true && jsValue(state.response) === true) return;
      await sleep(200);
    }
    throw new Error('fixture did not finish loading after reload');
  };
  const frames = () => call(name, 'chrome_list_frames', { includeDetails: false }).frames;

  return runWithCleanup(
    async () => {
      const health = ok(name, ['health']).result;
      assert(
        health.schema.toolNames.includes('chrome_cdp_inject'),
        'running extension lacks chrome_cdp_inject; rebuild and reload it first',
      );
      fixture = await createFixtureServer(runId);
      const pageUrl = fixture.origin + '/inject?run=' + name;
      urls.push(pageUrl);
      const tabId = ok(name, ['open', pageUrl, '--background']).result.tabId;
      tabs.push(tabId);
      await waitLoaded();
      tabs.push(
        ok(probe, [
          'open',
          'chrome-extension://' + EXTENSION_ID + '/offscreen.html',
          '--background',
        ]).result.tabId,
      );

      // 1. Without a held session nothing is registered.
      assert.equal(
        fails(name, 'chrome_cdp_inject', { action: 'list' }, 'list before start'),
        'CDP_SESSION_NOT_STARTED',
      );
      assert.equal(evalPage('return window.sawEarly'), 'undefined');

      // 2. Register. The start filter does not include hook records; they arrive anyway.
      cdpSession({ action: 'start', events: ['Page.frameNavigated'] });
      started = true;
      const early = inject({
        action: 'add',
        source: 'window.__aebEarly = ' + JSON.stringify(runId) + ';',
      }).injection;
      const isolated = inject({
        action: 'add',
        source: 'globalThis.__aebIso = location.pathname;',
        worldName: WORLD,
      }).injection;
      const sign = inject({ action: 'hook', hook: 'function', path: 'window.app.sign' }).injection;
      const frameName = inject({
        action: 'hook',
        hook: 'property',
        path: 'frameName',
        access: 'set',
      }).injection;
      const title = inject({
        action: 'hook',
        hook: 'property',
        path: 'document.title',
        access: 'set',
      }).injection;
      const fetchHook = inject({ action: 'hook', hook: 'fetch' }).injection;
      const xhrHook = inject({ action: 'hook', hook: 'xhr' }).injection;
      for (const injection of [early, isolated, sign, frameName, title, fetchHook, xhrHook]) {
        assert.equal(injection.sessions.length, 2, 'root and OOPIF: ' + JSON.stringify(injection));
      }
      assert.equal(inject({ action: 'list' }).waitOnStart, true);

      // 3. Reload: every frame, including the re-created OOPIF, runs the scripts before its own.
      const beforeReload = hookEvents(0).cursor;
      reload();
      await waitLoaded();
      assert.deepEqual(evalPage('return window.sawEarly'), 'string');
      assert.equal(evalPage('return window.__aebEarly === ' + JSON.stringify(runId)), true);
      assert.equal(evalPage('return typeof window.__aebIso'), 'undefined');
      const mainFrame = cdp('Page.getFrameTree').frameTree.frame.id;
      const world = cdp('Page.createIsolatedWorld', { frameId: mainFrame, worldName: WORLD });
      assert.equal(
        cdp('Runtime.evaluate', {
          expression: 'globalThis.__aebIso',
          contextId: world.executionContextId,
          returnByValue: true,
        }).result.value,
        '/inject',
      );
      const reloaded = await waitForHooks(
        beforeReload,
        (events) =>
          ['top', 'same', 'cross', 'cross-nested'].every((value) =>
            events.some(
              (event) => event.params.hookId === frameName.id && event.params.value === value,
            ),
          ),
        'frameName sets in every frame',
      );
      const frameSets = reloaded.events.filter(
        (event) => event.params.hookId === frameName.id && event.params.type === 'set',
      );
      const crossSet = frameSets.find((event) => event.params.value === 'cross');
      const nestedSet = frameSets.find((event) => event.params.value === 'cross-nested');
      assert(crossSet.sessionId && crossSet.sessionId === nestedSet.sessionId, 'OOPIF records');
      assert.equal(frameSets.find((event) => event.params.value === 'top').sessionId, undefined);
      const status = cdpSession({ action: 'status' });
      const oopif = status.targets.find((target) => target.type === 'iframe');
      assert.equal(crossSet.sessionId, oopif.sessionId, 'records come from the new OOPIF session');
      for (const frame of frames()) {
        assert.equal(
          js({
            frameId: frame.frameId,
            code: 'return window.__aebEarly === ' + JSON.stringify(runId),
          }),
          true,
          'early script missing in frame ' + frame.frameId,
        );
      }
      const titleSet = reloaded.events.find(
        (event) => event.params.hookId === title.id && event.params.type === 'set',
      );
      assert.equal(titleSet.params.value, 'Inject fixture ' + runId);
      assert.equal(titleSet.params.path, 'document.title');
      const signInstalled = reloaded.events.filter(
        (event) => event.params.hookId === sign.id && event.params.type === 'installed',
      );
      assert.deepEqual(
        signInstalled.map((event) => [event.sessionId, event.params.phase]),
        [[undefined, 'DOMContentLoaded']],
      );

      // 4. Hook records of one page action.
      const beforeCall = reloaded.cursor;
      assert.deepEqual(evalPage('return await window.callApi("v1")'), [201, 200]);
      const called = await waitForHooks(
        beforeCall,
        (events) =>
          [sign.id, fetchHook.id, xhrHook.id].every((id) =>
            events.some((event) => event.params.hookId === id && event.params.type !== 'installed'),
          ),
        'sign/fetch/xhr records',
      );
      const record = (id) =>
        called.events.find(
          (event) => event.params.hookId === id && event.params.type !== 'installed',
        ).params;
      const signCall = record(sign.id);
      assert.deepEqual([signCall.type, signCall.args, signCall.result], ['call', ['v1'], 'sig:v1']);
      assert(
        signCall.stack.some((line) => line.includes('callApi')),
        JSON.stringify(signCall.stack),
      );
      assert(!signCall.stack.some((line) => line.includes('aeb-hook://')));
      const fetchCall = record(fetchHook.id);
      assert.equal(fetchCall.method, 'POST');
      assert.match(fetchCall.url, /\/inject-api\?via=fetch$/);
      assert.deepEqual(fetchCall.headerNames, ['X-Sign', 'Authorization']);
      assert.equal(fetchCall.body, '{"value":"v1"}');
      assert.equal(fetchCall.status, 201);
      const xhrCall = record(xhrHook.id);
      assert.deepEqual(
        [xhrCall.method, xhrCall.url, xhrCall.headerNames, xhrCall.status],
        ['GET', '/inject-api?via=xhr', ['X-Token'], 200],
      );
      assert(!JSON.stringify(called.events).includes('hidden-' + runId), 'header value leaked');

      // 5. list reports installs, records and the frames where a path did not exist.
      const listed = inject({ action: 'list' });
      const signListed = listed.injections.find((entry) => entry.id === sign.id);
      assert(signListed.installed >= 1 && signListed.records >= 1, JSON.stringify(signListed));
      assert(
        signListed.failures.some((failure) => failure.error === 'owner object not found'),
        'frames without app report the failure: ' + JSON.stringify(signListed),
      );

      // 6. maxRecords: a second hook on the same function stops after one record per document.
      const limited = inject({
        action: 'hook',
        hook: 'function',
        path: 'app.sign',
        maxRecords: 1,
        stackDepth: 0,
      }).injection;
      const beforeLimit = called.cursor;
      evalPage('app.sign("a"); app.sign("b"); app.sign("c"); return 1');
      const limitedEvents = await waitForHooks(
        beforeLimit,
        (events) =>
          events.filter((event) => event.params.hookId === sign.id && event.params.type === 'call')
            .length === 3 &&
          events.some(
            (event) => event.params.hookId === limited.id && event.params.type === 'limit',
          ),
        'limit notice',
      );
      // Frames without app report "failed"; the top document's sequence is what the limit governs.
      const limitedTypes = limitedEvents.events
        .filter((event) => event.params.hookId === limited.id && event.params.type !== 'failed')
        .filter((event) => event.params.href === pageUrl)
        .map((event) => event.params.type);
      assert.deepEqual(limitedTypes, ['installed', 'call', 'limit']);

      // 7. remove: later records of the removed hook are dropped, and it is gone after reload.
      inject({ action: 'remove', id: sign.id });
      inject({ action: 'remove', id: limited.id });
      const rejectedBefore = inject({ action: 'list' }).rejectedBindingCalls;
      evalPage('app.sign("after-remove"); return 1');
      await sleep(300);
      const afterRemove = hookEvents(limitedEvents.cursor);
      assert(!afterRemove.events.some((event) => event.params.hookId === sign.id));
      assert.equal(inject({ action: 'list' }).rejectedBindingCalls, rejectedBefore + 1);
      reload();
      await waitLoaded();
      evalPage('app.sign("after-reload"); return 1');
      await sleep(300);
      const afterReload = hookEvents(afterRemove.cursor);
      assert(
        !afterReload.events.some((event) => [sign.id, limited.id].includes(event.params.hookId)),
      );
      assert.equal(inject({ action: 'list' }).rejectedBindingCalls, rejectedBefore + 1);
      assert.equal(evalPage('return window.__aebEarly === ' + JSON.stringify(runId)), true);

      // 8. Rejections.
      const rejected = {
        otherTask: fails(other, 'chrome_cdp_inject', { tabId, action: 'list' }, 'other task'),
        badPath: fails(name, 'chrome_cdp_inject', {
          action: 'hook',
          hook: 'function',
          path: 'app["sign"]',
        }),
        unknownId: fails(name, 'chrome_cdp_inject', { action: 'remove', id: 'inj-999' }),
        // The schema enum rejects it in the native server, before the extension.
        unknownKind: assertFailure(
          runCli(name, ['call', 'chrome_cdp_inject', '{"action":"hook","hook":"websocket"}']),
          'unknown hook kind',
        ).error.code,
      };
      assert.deepEqual(rejected, {
        otherTask: 'CDP_SESSION_OWNED',
        badPath: 'INVALID_ARGUMENT',
        unknownId: 'INJECTION_NOT_FOUND',
        unknownKind: 'INVALID_ARGUMENT',
      });

      // 9. stop: no attach, nothing runs in the next document, the OOPIF loads unpaused.
      assert.equal(cdpSession({ action: 'stop' }).stopped, true);
      started = false;
      assert.deepEqual(debugTargets('t.tabId === ' + tabId + ' && t.attached'), []);
      reload();
      await waitLoaded();
      assert.deepEqual(evalPage('return [window.sawEarly, typeof window.__aebEarly]'), [
        'undefined',
        'undefined',
      ]);
      assert.equal(
        evalPage('return document.getElementById("cross").contentWindow.length'),
        1,
        'OOPIF document with its nested frame loaded',
      );
      assert.deepEqual(debugTargets('t.tabId === ' + tabId + ' && t.attached'), []);

      return {
        ok: true,
        runId,
        documentStart: { top: true, isolatedWorld: true, everyFrame: true, oopifSession: true },
        hooks: {
          function: { args: signCall.args, result: signCall.result, stack: true },
          property: ['frameName in 4 frames', 'document.title'],
          fetch: { status: fetchCall.status, headerNames: fetchCall.headerNames },
          xhr: { status: xhrCall.status },
          lateInstall: 'DOMContentLoaded',
          limit: limitedTypes,
        },
        removed: { dropped: true, notReinstalled: true },
        rejected,
        cleanAfterStop: true,
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
  runCdpInject()
    .then((result) => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch((error) => {
      process.stderr.write(String(error.stack || error) + '\n');
      if (error instanceof AggregateError)
        for (const cause of error.errors) process.stderr.write(String(cause.stack || cause) + '\n');
      process.exitCode = 1;
    });

module.exports = { runCdpInject };
