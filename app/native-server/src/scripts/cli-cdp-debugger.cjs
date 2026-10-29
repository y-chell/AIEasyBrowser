'use strict';

// Real-browser acceptance for chrome_cdp_debugger on a held chrome_cdp_session: url breakpoint
// hit read from separate CLI processes (stack, scopes, evaluate, steps), conditional breakpoint,
// logpoint, XHR and event-listener breakpoints, an OOPIF child session, navigation, and stop
// while paused. Breakpoint lines are located from marker comments in the served fixture.
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const {
  runCli,
  startCli,
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

function fetchText(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (text += chunk));
        response.on('end', () => resolve(text));
      })
      .on('error', reject);
  });
}

function lineOf(text, needle) {
  const offset = text.indexOf(needle);
  assert(offset >= 0, 'needle not in resource: ' + needle);
  return text.slice(0, offset).split('\n').length - 1;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runCdpDebugger() {
  const runId = randomUUID().replaceAll('-', '');
  const name = 'cdpdbg_' + runId.slice(0, 8);
  const trigger = name + '_trigger';
  const other = name + '_other';
  const probe = name + '_probe';
  const tabs = [];
  const urls = [];
  let fixture;
  let started = false;
  const ok = (session, args, label) => assertOk(runCli(session, args), label || args[1] || args[0]);
  const call = (session, tool, args, label) =>
    ok(session, ['call', tool, JSON.stringify(args)], label || tool).result;
  const dbg = (args) => call(name, 'chrome_cdp_debugger', args, 'cdp_debugger ' + args.action);
  const fails = (session, tool, args, label) =>
    errorCode(assertFailure(runCli(session, ['call', tool, JSON.stringify(args)]), label));
  const evalIn = (session, code) => jsValue(ok(session, ['eval', code]));
  const attachedByUs = (tabId) =>
    jsValue(
      ok(probe, [
        'eval',
        'const targets = await chrome.debugger.getTargets(); return targets.filter((t) => t.tabId === ' +
          tabId +
          ' && t.attached).map((t) => t.type);',
      ]),
    );
  const scope = (pause, type) => pause.frames[0].scopes.find((entry) => entry.type === type);
  const props = (args) =>
    Object.fromEntries(
      dbg({ action: 'properties', ...args }).properties.map((prop) => [prop.name, prop.value]),
    );

  return runWithCleanup(
    async () => {
      const health = ok(name, ['health']).result;
      assert(
        health.schema.toolNames.includes('chrome_cdp_debugger'),
        'running extension lacks chrome_cdp_debugger; rebuild and reload it first',
      );
      fixture = await createFixtureServer(runId);
      const pageUrl = fixture.origin + '/debugger?record=' + name;
      const appUrl = fixture.origin + '/debugger-app.js?run=' + runId;
      urls.push(pageUrl);
      const app = await fetchText(appUrl);
      const at = (marker) => lineOf(app, '// @@' + marker);
      const tabId = ok(name, ['open', pageUrl, '--background']).result.tabId;
      tabs.push(tabId);
      const waitLoaded = () =>
        ok(name, [
          'wait',
          JSON.stringify({
            kind: 'javascript',
            predicate:
              'document.readyState === "complete" && typeof compute === "function" && document.querySelector("#cross")?.contentWindow?.length === 0',
          }),
        ]);
      waitLoaded();
      ok(trigger, ['use', String(tabId)]);
      tabs.push(
        ok(probe, [
          'open',
          'chrome-extension://' + EXTENSION_ID + '/offscreen.html',
          '--background',
        ]).result.tabId,
      );

      // 1. Without a held session the tool refuses and nothing is attached.
      assert.equal(
        fails(name, 'chrome_cdp_debugger', { action: 'status' }, 'status before start'),
        'CDP_SESSION_NOT_STARTED',
      );
      assert.deepEqual(attachedByUs(tabId), []);
      call(
        name,
        'chrome_cdp_session',
        { action: 'start', events: ['Runtime.consoleAPICalled'] },
        'cdp_session start',
      );
      started = true;
      assert.deepEqual(
        { paused: dbg({ action: 'status' }).paused, armed: dbg({ action: 'status' }).armed },
        { paused: false, armed: [] },
      );

      // 2. url breakpoint; a wait in one CLI process returns the pause triggered by another.
      const bp = dbg({ action: 'setBreakpoint', url: appUrl, line: at('doubled') }).breakpoint;
      assert.equal(bp.resolved, true, JSON.stringify(bp));
      assert.equal(bp.locations[0].line, at('doubled'));
      const waiting = startCli(name, [
        'call',
        'chrome_cdp_debugger',
        JSON.stringify({ action: 'wait', timeoutMs: 15000 }),
      ]);
      await sleep(500);
      assert.equal(evalIn(trigger, 'return later(21)'), 'scheduled');
      const waited = await waiting.completion;
      assert.equal(waited.status, 0, 'wait: ' + waited.stdout + waited.stderr);
      const pause = waited.response.result.pause;
      assert.equal(
        waited.response.result.paused,
        true,
        JSON.stringify(waited.response) + ' elapsed ' + waited.elapsedMs,
      );
      assert.deepEqual(pause.hitBreakpoints, [bp.id]);
      assert.deepEqual(
        pause.frames.slice(0, 2).map((frame) => [frame.functionName, frame.location.line]),
        [
          ['compute', at('doubled')],
          ['trigger', at('trigger')],
        ],
      );
      assert.equal(pause.frames[0].location.url, appUrl);
      const status = dbg({ action: 'status' });
      assert.equal(status.pauses[0].seq, pause.seq);
      assert.equal(status.breakpoints[0].hits, 1);
      assert.deepEqual(
        call(name, 'chrome_cdp_session', { action: 'status' }).paused.map((p) => p.seq),
        [pause.seq],
      );

      // 3. Locals from another process: own scope, redacted secret, evaluate in the frame.
      const local = scope(pause, 'local');
      const locals = props({ scopeIndex: local.index });
      assert.deepEqual(locals.input, { type: 'number', value: 21 });
      assert.deepEqual(locals.scale, { type: 'number', value: 2 });
      assert.equal(locals.token.redacted, true, JSON.stringify(locals.token));
      const rawLocals = props({ scopeIndex: local.index, sanitizeOutput: false });
      assert.equal(rawLocals.token.value, 'tok-' + runId);
      assert.equal(dbg({ action: 'evaluate', expression: 'input * 3' }).result.value, 63);
      assert.match(
        dbg({ action: 'evaluate', expression: 'missingName' }).exception,
        /ReferenceError/,
      );

      // 4. Steps: over to the next line, then out to the caller.
      const over = dbg({ action: 'stepOver' });
      assert.equal(over.paused, true, JSON.stringify(over));
      assert.equal(over.pause.frames[0].location.line, at('label'));
      assert.equal(dbg({ action: 'evaluate', expression: 'doubled' }).result.value, 42);
      const out = dbg({ action: 'stepOut' });
      assert.equal(out.paused, true, JSON.stringify(out));
      assert.equal(out.pause.frames[0].functionName, 'trigger');
      assert.equal(dbg({ action: 'resume' }).resumed, true);
      assert.deepEqual(evalIn(trigger, 'return window.dbgResults'), [42]);

      // 4b. A synchronous call stuck on the paused page holds the tab lock; debugger control
      // from the owning task still gets through, and resume lets the stuck call finish.
      const stuckSeq = dbg({ action: 'status' }).lastPauseSeq;
      const stuck = startCli(trigger, ['eval', 'trigger(11); return window.dbgResults']);
      const stuckPause = dbg({ action: 'wait', after: stuckSeq, timeoutMs: 10000 });
      assert.equal(stuckPause.paused, true, JSON.stringify(stuckPause));
      assert.equal(stuckPause.pause.frames[0].functionName, 'compute');
      assert.equal(
        call(name, 'chrome_cdp_scripts', { action: 'list', url: appUrl }).scripts.length,
        1,
      );
      assert.equal(dbg({ action: 'resume' }).resumed, true);
      const unstuck = await stuck.completion;
      assert.equal(unstuck.status, 0, 'stuck eval: ' + unstuck.stdout + unstuck.stderr);
      assert.deepEqual(jsValue(unstuck.response), [42, 22]);

      // 5. Without breakpoints the session is disarmed: `debugger;` does not pause.
      dbg({ action: 'removeBreakpoint', breakpointId: bp.id });
      assert.deepEqual(dbg({ action: 'status' }).armed, []);
      assert.equal(evalIn(trigger, 'return pauseProbe()'), 'not-paused');

      // 6. Conditional breakpoint pauses only when the condition holds.
      const conditional = dbg({
        action: 'setBreakpoint',
        url: appUrl,
        line: at('doubled'),
        condition: 'input > 100',
      }).breakpoint;
      const before = dbg({ action: 'status' }).lastPauseSeq;
      evalIn(trigger, 'return later(5)');
      assert.equal(dbg({ action: 'wait', after: before, timeoutMs: 1500 }).timedOut, true);
      assert.deepEqual(evalIn(trigger, 'return window.dbgResults'), [42, 22, 10]);
      evalIn(trigger, 'return later(500)');
      const hit500 = dbg({ action: 'wait', after: before, timeoutMs: 10000 }).pause;
      assert.deepEqual(props({ scopeIndex: scope(hit500, 'local').index }).input, {
        type: 'number',
        value: 500,
      });
      dbg({ action: 'resume' });
      dbg({ action: 'removeBreakpoint', breakpointId: conditional.id });

      // 7. Logpoint logs through console without pausing.
      call(name, 'chrome_cdp_command', { method: 'Runtime.enable' });
      const logMarker = 'aeb-log-' + runId.slice(0, 8);
      const logpoint = dbg({
        action: 'setBreakpoint',
        url: appUrl,
        line: at('return'),
        logMessage: JSON.stringify(logMarker) + ', doubled',
      }).breakpoint;
      const beforeLog = dbg({ action: 'status' }).lastPauseSeq;
      evalIn(trigger, 'return later(7)');
      assert.equal(dbg({ action: 'wait', after: beforeLog, timeoutMs: 1500 }).timedOut, true);
      let logged;
      for (let attempt = 0; attempt < 20 && !logged; attempt += 1) {
        logged = call(name, 'chrome_cdp_session', { action: 'events', limit: 1000 }).events.find(
          (event) => event.params?.args?.[0]?.value === logMarker,
        );
        if (!logged) await sleep(200);
      }
      assert(logged, 'logpoint console event missing');
      assert.equal(logged.params.args[1].value, 14);
      dbg({ action: 'removeBreakpoint', breakpointId: logpoint.id });

      // 8. XHR/fetch breakpoint.
      const xhr = dbg({ action: 'setBreakpoint', xhrUrl: '/debugger-xhr' }).breakpoint;
      evalIn(trigger, 'return sendXhr()');
      const xhrPause = dbg({ action: 'wait', after: beforeLog, timeoutMs: 10000 }).pause;
      assert.equal(xhrPause.reason, 'XHR', JSON.stringify(xhrPause));
      assert.match(JSON.stringify(xhrPause.data), /debugger-xhr/);
      dbg({ action: 'removeBreakpoint', breakpointId: xhr.id });
      dbg({ action: 'resume' });

      // 9. Event-listener breakpoint; every listener call pauses until removed.
      const click = dbg({ action: 'setBreakpoint', eventName: 'click' }).breakpoint;
      let clickSeq = dbg({ action: 'status' }).lastPauseSeq;
      evalIn(trigger, 'return clickLater()');
      const clickPause = dbg({ action: 'wait', after: clickSeq, timeoutMs: 10000 }).pause;
      assert.equal(clickPause.reason, 'EventListener', JSON.stringify(clickPause));
      dbg({ action: 'removeBreakpoint', breakpointId: click.id });
      clickSeq = clickPause.seq;
      for (let resumed = 0; resumed < 10; resumed += 1) {
        dbg({ action: 'resume' });
        const next = dbg({ action: 'wait', after: clickSeq, timeoutMs: 500 });
        if (!next.paused) break;
        clickSeq = next.pause.seq;
      }
      assert.equal(evalIn(trigger, 'return window.dbgClicks'), 1);

      // 10. OOPIF child session: breakpoint and pause in that session only.
      const frameTarget = call(name, 'chrome_cdp_session', { action: 'status' }).targets.find(
        (target) => target.type === 'iframe',
      );
      assert(frameTarget, 'OOPIF target missing');
      const frameUrl = frameTarget.url;
      const frameHtml = await fetchText(frameUrl);
      const frameBp = dbg({
        action: 'setBreakpoint',
        url: frameUrl,
        line: lineOf(frameHtml, 'dataset.lastEvent'),
        sessionId: frameTarget.sessionId,
      }).breakpoint;
      assert.equal(frameBp.resolved, true, JSON.stringify(frameBp));
      const frameSeq = dbg({ action: 'status' }).lastPauseSeq;
      call(name, 'chrome_cdp_command', {
        method: 'Runtime.evaluate',
        params: {
          expression: 'setTimeout(() => document.querySelector("button").click(), 300); 1',
        },
        sessionId: frameTarget.sessionId,
      });
      const framePause = dbg({ action: 'wait', after: frameSeq, timeoutMs: 10000 });
      assert.equal(framePause.pause.sessionId, frameTarget.sessionId);
      assert.equal(framePause.pause.frames[0].location.url, frameUrl);
      assert.deepEqual(dbg({ action: 'status' }).armed.sort(), [frameTarget.sessionId].sort());
      dbg({
        action: 'removeBreakpoint',
        breakpointId: frameBp.id,
        sessionId: frameTarget.sessionId,
      });
      dbg({ action: 'resume', sessionId: frameTarget.sessionId });

      // 11. Navigation: the url breakpoint applies to the new document, the scriptId one does not.
      const appScript = call(name, 'chrome_cdp_scripts', { action: 'list', url: appUrl })
        .scripts[0];
      const byUrl = dbg({ action: 'setBreakpoint', url: appUrl, line: at('doubled') }).breakpoint;
      const byScript = dbg({
        action: 'setBreakpoint',
        scriptId: appScript.scriptId,
        line: at('label'),
      }).breakpoint;
      const nextUrl = pageUrl + '&nav=1';
      urls.push(nextUrl);
      call(name, 'chrome_navigate', { url: nextUrl, tabId }, 'navigate');
      waitLoaded();
      const navSeq = dbg({ action: 'status' }).lastPauseSeq;
      evalIn(trigger, 'return later(3)');
      const navPause = dbg({ action: 'wait', after: navSeq, timeoutMs: 10000 }).pause;
      assert.deepEqual(navPause.hitBreakpoints, [byUrl.id]);
      dbg({ action: 'resume' });
      // The scriptId breakpoint was bound to the old document's script instance.
      const staleHit = dbg({ action: 'wait', after: navPause.seq, timeoutMs: 1500 });
      assert.equal(staleHit.timedOut, true, 'old scriptId breakpoint hit after reload');
      dbg({ action: 'removeBreakpoint', breakpointId: byUrl.id });
      const staleRemoval = runCli(name, [
        'call',
        'chrome_cdp_debugger',
        JSON.stringify({ action: 'removeBreakpoint', breakpointId: byScript.id }),
      ]);
      const staleRemoved =
        staleRemoval.response?.ok === true ? true : staleRemoval.response?.error?.message;
      assert.deepEqual(dbg({ action: 'status' }).breakpoints, [], 'breakpoints left after removal');

      // 12. Negative cases.
      assert.equal(
        fails(name, 'chrome_cdp_debugger', { action: 'resume' }, 'resume not paused'),
        'DEBUGGER_NOT_PAUSED',
      );
      assert.equal(
        fails(name, 'chrome_cdp_debugger', { action: 'evaluate', expression: '1' }, 'eval'),
        'DEBUGGER_NOT_PAUSED',
      );
      assert.equal(
        fails(
          name,
          'chrome_cdp_debugger',
          { action: 'removeBreakpoint', breakpointId: 'nope' },
          'unknown bp',
        ),
        'BREAKPOINT_NOT_FOUND',
      );
      assert.equal(
        fails(name, 'chrome_cdp_debugger', { action: 'setBreakpoint', url: appUrl }, 'no line'),
        'INVALID_ARGUMENT',
      );
      assert.equal(
        fails(other, 'chrome_cdp_debugger', { tabId, action: 'status' }, 'foreign task'),
        'CDP_SESSION_OWNED',
      );

      // 13. stop while paused resumes the page and detaches.
      dbg({ action: 'setBreakpoint', url: appUrl, line: at('doubled') });
      const stopSeq = dbg({ action: 'status' }).lastPauseSeq;
      evalIn(trigger, 'return later(4)');
      assert.equal(dbg({ action: 'wait', after: stopSeq, timeoutMs: 10000 }).paused, true);
      assert.equal(call(name, 'chrome_cdp_session', { action: 'stop' }).stopped, true);
      started = false;
      let resumedResults;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        resumedResults = evalIn(trigger, 'return window.dbgResults');
        if (resumedResults.includes(8)) break;
        await sleep(200);
      }
      assert.deepEqual(resumedResults, [6, 8], 'page did not resume after stop');
      assert.deepEqual(attachedByUs(tabId), [], 'debugger still attached after stop');
      assert.equal(
        fails(name, 'chrome_cdp_debugger', { action: 'status' }, 'status after stop'),
        'CDP_SESSION_NOT_STARTED',
      );

      return {
        ok: true,
        runId,
        crossProcessWait: { pauseSeq: pause.seq, waitMs: waited.elapsedMs },
        stuckCallResumed: { evalMs: unstuck.elapsedMs },
        frames: pause.frames.slice(0, 2).map((frame) => frame.functionName),
        locals: { input: locals.input.value, tokenRedacted: locals.token.redacted === true },
        steps: { over: over.pause.frames[0].location.line, out: out.pause.frames[0].functionName },
        conditional: 'skipped 5, paused 500',
        logpoint: logged.params.args.map((arg) => arg.value),
        xhr: xhrPause.reason,
        event: clickPause.reason,
        oopif: framePause.pause.frames[0].functionName,
        navigation: { urlBreakpoint: 'hit', scriptIdBreakpoint: 'not hit', staleRemoved },
        stopWhilePaused: 'resumed',
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
        if (stop.response?.ok !== true && stop.response?.error?.code !== 'TARGET_CLOSED') {
          errors.push('stop held session: ' + stop.stdout);
        }
      }
      errors.push(...cleanupTargets(runCli, [name, trigger, other, probe], urls, tabs));
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
  runCdpDebugger()
    .then((result) => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch((error) => {
      process.stderr.write(String(error.stack || error) + '\n');
      if (error instanceof AggregateError)
        for (const cause of error.errors) process.stderr.write(String(cause.stack || cause) + '\n');
      process.exitCode = 1;
    });

module.exports = { runCdpDebugger };
