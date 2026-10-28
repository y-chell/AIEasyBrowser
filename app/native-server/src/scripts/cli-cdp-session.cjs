'use strict';

// Real-browser acceptance for chrome_cdp_session: held sessions across independent CLI
// processes, event buffering, OOPIF/worker child sessions, task isolation and cleanup.
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

async function runCdpSession() {
  const runId = randomUUID().replaceAll('-', '');
  const name = 'cdps_' + runId.slice(0, 8);
  const other = name + '_other';
  const probe = name + '_probe';
  const marker = 'cdp-marker-' + runId.slice(0, 8);
  const tabs = [];
  const urls = [];
  let fixture;
  let started = false;
  const ok = (session, args, label) => assertOk(runCli(session, args), label || args[1] || args[0]);
  const call = (session, tool, args, label) =>
    ok(session, ['call', tool, JSON.stringify(args)], label || tool).result;
  const cdpSession = (session, args) =>
    call(session, 'chrome_cdp_session', args, 'cdp_session ' + args.action);
  const attachedByUs = (tabId) =>
    jsValue(
      ok(probe, [
        'eval',
        'const targets = await chrome.debugger.getTargets(); return targets.filter((t) => t.tabId === ' +
          tabId +
          ' && t.attached).map((t) => t.type);',
      ]),
    );

  return runWithCleanup(
    async () => {
      const health = ok(name, ['health']).result;
      assert(
        health.schema.toolNames.includes('chrome_cdp_session'),
        'running extension lacks chrome_cdp_session; rebuild and reload it first',
      );
      fixture = await createFixtureServer(runId);
      const pageUrl = fixture.origin + '/long?record=' + name + '&mode=geometry';
      urls.push(pageUrl);
      const tabId = ok(name, ['open', pageUrl, '--background']).result.tabId;
      tabs.push(tabId);
      ok(name, [
        'wait',
        JSON.stringify({
          kind: 'javascript',
          predicate:
            'document.readyState === "complete" && document.querySelector("#cross")?.contentWindow?.length === 0',
        }),
      ]);
      const probeUrl = 'chrome-extension://' + EXTENSION_ID + '/offscreen.html';
      tabs.push(ok(probe, ['open', probeUrl, '--background']).result.tabId);

      // 1. start in one process; the attach outlives it.
      const start = cdpSession(name, {
        action: 'start',
        events: ['Runtime.consoleAPICalled', 'Target'],
      });
      started = true;
      assert.equal(start.active, true);
      assert(attachedByUs(tabId).includes('page'), 'held session not attached after start');

      // 2. Runtime.enable in a second process; domain state must persist in the held session.
      call(name, 'chrome_cdp_command', { method: 'Runtime.enable' });
      call(name, 'chrome_cdp_command', {
        method: 'Runtime.evaluate',
        params: { expression: 'console.log(' + JSON.stringify(marker) + ')' },
      });
      const page = cdpSession(name, { action: 'events' });
      const consoleEvent = page.events.find(
        (event) =>
          event.method === 'Runtime.consoleAPICalled' &&
          JSON.stringify(event.params).includes(marker),
      );
      assert(consoleEvent, 'console event from a separate CLI process was not buffered');
      assert.equal(page.missed, 0);

      // 3. The cross-site iframe is a child target addressable by sessionId.
      const status = cdpSession(name, { action: 'status' });
      const frame = status.targets.find(
        (target) => target.type === 'iframe' && target.url.includes('/long-frame'),
      );
      assert(frame, 'OOPIF child target missing: ' + JSON.stringify(status.targets));
      const frameEval = call(name, 'chrome_cdp_command', {
        method: 'Runtime.evaluate',
        params: { expression: 'location.origin', returnByValue: true },
        sessionId: frame.sessionId,
      });
      assert.equal(frameEval.success, true, JSON.stringify(frameEval));
      assert.equal(frameEval.sessionId, frame.sessionId);
      assert.match(frameEval.result.result.value, /^http:\/\/localhost:\d+$/);

      // 4. A dedicated worker created after start is auto-attached too.
      ok(name, [
        'eval',
        'window.__w = new Worker(URL.createObjectURL(new Blob(["self.onmessage = () => {}"], {type: "text/javascript"}))); return true',
      ]);
      let worker;
      for (let attempt = 0; attempt < 20 && !worker; attempt += 1) {
        worker = cdpSession(name, { action: 'status' }).targets.find(
          (target) => target.type === 'worker',
        );
        if (!worker) await new Promise((resolve) => setTimeout(resolve, 150));
      }
      assert(worker, 'dedicated worker was not auto-attached');
      const workerEval = call(name, 'chrome_cdp_command', {
        method: 'Runtime.evaluate',
        params: { expression: 'typeof WorkerGlobalScope', returnByValue: true },
        sessionId: worker.sessionId,
      });
      assert.equal(workerEval.result.result.value, 'function');

      // 5. Negative cases fail before Chrome and leave the session intact.
      const unknown = assertFailure(
        runCli(name, [
          'call',
          'chrome_cdp_command',
          JSON.stringify({ method: 'Runtime.evaluate', sessionId: 'not-a-session' }),
        ]),
        'unknown child session',
      );
      assert.equal(errorCode(unknown), 'CDP_UNKNOWN_SESSION');
      const foreignArgs = { tabId };
      for (const [tool, args] of [
        ['chrome_cdp_session', { ...foreignArgs, action: 'events' }],
        ['chrome_cdp_session', { ...foreignArgs, action: 'stop' }],
        [
          'chrome_cdp_command',
          { ...foreignArgs, method: 'Runtime.evaluate', sessionId: frame.sessionId },
        ],
      ]) {
        const foreign = assertFailure(
          runCli(other, ['call', tool, JSON.stringify(args)]),
          'foreign task ' + tool,
        );
        assert.equal(errorCode(foreign), 'CDP_SESSION_OWNED', JSON.stringify(foreign));
      }
      const again = assertFailure(
        runCli(name, ['call', 'chrome_cdp_session', JSON.stringify({ action: 'start' })]),
        'second start',
      );
      assert.equal(errorCode(again), 'CDP_SESSION_ACTIVE');
      assert.equal(cdpSession(name, { action: 'status' }).active, true);

      // 6. stop detaches; nothing of ours remains attached to the tab.
      assert.equal(cdpSession(name, { action: 'stop' }).stopped, true);
      started = false;
      assert.deepEqual(attachedByUs(tabId), [], 'debugger still attached after stop');
      assert.equal(cdpSession(name, { action: 'status' }).started, false);

      // 7. Closing the tab ends the session: no debug target remains and later calls fail.
      cdpSession(name, { action: 'start', events: ['Runtime.consoleAPICalled'] });
      started = true;
      call(name, 'chrome_cdp_command', { method: 'Runtime.enable' });
      call(name, 'chrome_cdp_command', {
        method: 'Runtime.evaluate',
        params: { expression: 'console.log("before-close")' },
      });
      call(probe, 'chrome_close_tabs', { tabIds: [tabId] });
      const closedProbe = jsValue(
        ok(probe, [
          'eval',
          'const targets = await chrome.debugger.getTargets(); return targets.some((t) => t.tabId === ' +
            tabId +
            ');',
        ]),
      );
      assert.equal(closedProbe, false, 'closed tab still listed as debug target');
      const closedRead = assertFailure(
        runCli(name, ['call', 'chrome_cdp_session', JSON.stringify({ action: 'events' })]),
        'events after tab close',
      );
      assert.equal(closedRead.error.code, 'TARGET_CLOSED');
      started = false;

      return {
        ok: true,
        runId,
        crossProcessConsoleEvent: consoleEvent.seq,
        oopifSession: { type: frame.type, origin: frameEval.result.result.value },
        workerSession: worker.type,
        rejected: ['CDP_UNKNOWN_SESSION', 'CDP_SESSION_OWNED x3', 'CDP_SESSION_ACTIVE'],
        detachedAfterStop: true,
        closedTabTargetGone: true,
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
        if (stop.response?.ok !== true && stop.response?.error?.code !== 'TARGET_CLOSED') {
          errors.push('stop held session: ' + stop.stdout);
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
  runCdpSession()
    .then((result) => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch((error) => {
      process.stderr.write(String(error.stack || error) + '\n');
      if (error instanceof AggregateError)
        for (const cause of error.errors) process.stderr.write(String(cause.stack || cause) + '\n');
      process.exitCode = 1;
    });

module.exports = { runCdpSession };
