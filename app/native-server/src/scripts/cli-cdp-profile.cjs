'use strict';

// Real-browser acceptance for B8 chrome_cdp_profile on a held chrome_cdp_session: CSS coverage in
// the page and a cross-site iframe (exact used/unused lengths, deltas merged), a CPU profile per
// thread (page, OOPIF, dedicated worker) with the expected hot functions, scriptIds that match
// chrome_cdp_scripts and .cpuprofile files in Downloads, heap instance counts with a known growth,
// the paused-page check, repeated starts, other tasks, and cleanup on session stop. It profiles
// only the fixture tab it opens and deletes every file it wrote.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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

// Same text as /profile.css of the fixture server.
const PROFILE_CSS =
  '.profile-used{font-weight:bold}.profile-unused-a{color:green}.profile-unused-b{margin:3px}';
const USED_RULE = '.profile-used{font-weight:bold}';
const SECOND_RULE = '.profile-unused-a{color:green}';
const LEAKS = 1000;

function errorCode(response) {
  return /([A-Z_]{6,}):/.exec(response.error.message)?.[1];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runCdpProfile() {
  const runId = randomUUID().replaceAll('-', '');
  const name = 'cdpprof_' + runId.slice(0, 8);
  const other = name + '_other';
  const tabs = [];
  const urls = [];
  const files = [];
  let fixture;
  let started = false;
  const ok = (session, args, label) => assertOk(runCli(session, args), label || args[1] || args[0]);
  const call = (session, tool, args, label) =>
    ok(session, ['call', tool, JSON.stringify(args)], label || tool).result;
  const fails = (session, tool, args, label) =>
    errorCode(assertFailure(runCli(session, ['call', tool, JSON.stringify(args)]), label || tool));
  // Session ids are 32-hex and would be redacted in output; read them raw.
  const prof = (args) =>
    call(name, 'chrome_cdp_profile', { sanitizeOutput: false, ...args }, 'profile ' + args.action);
  const shown = (args) => call(name, 'chrome_cdp_profile', args, 'profile ' + args.action);
  const profFails = (args) =>
    fails(name, 'chrome_cdp_profile', { sanitizeOutput: false, ...args }, 'profile ' + args.action);
  const cdpSession = (args) =>
    call(
      name,
      'chrome_cdp_session',
      { sanitizeOutput: false, ...args },
      'cdp_session ' + args.action,
    );
  const dbg = (args) => call(name, 'chrome_cdp_debugger', args, 'cdp_debugger ' + args.action);
  const evalPage = (code) => jsValue(ok(name, ['eval', code]));
  const evalIn = (sessionId, code) =>
    jsValue({ result: call(name, 'chrome_javascript', { sessionId, code }) });
  const waitLoaded = async () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const state = runCli(name, [
        'eval',
        'return document.readyState === "complete" && !!window.profileFixture && typeof document.getElementById("cross").contentWindow === "object"',
      ]);
      if (state.response?.ok === true && jsValue(state.response) === true) return;
      await sleep(200);
    }
    throw new Error('fixture did not finish loading');
  };
  const waitTargets = async () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const targets = cdpSession({ action: 'status' }).targets;
      const iframe = targets.find((target) => target.type === 'iframe');
      const worker = targets.find((target) => target.type === 'worker');
      if (iframe && worker) return { iframe, worker };
      await sleep(200);
    }
    throw new Error('OOPIF and worker child sessions did not attach');
  };
  // Only files this run wrote, named by the tool for this tab, are removed.
  const removeFile = (file) => {
    assert.match(path.basename(file), new RegExp('^cpu_tab' + tabs[0] + '_.+\\.cpuprofile$'));
    fs.rmSync(file, { force: true });
  };

  return runWithCleanup(
    async () => {
      const health = ok(name, ['health']).result;
      assert(
        health.schema.toolNames.includes('chrome_cdp_profile'),
        'running extension lacks chrome_cdp_profile; rebuild and reload it first',
      );
      fixture = await createFixtureServer(runId);
      const top = fixture.origin;
      const pageUrl = top + '/profile?run=' + name;
      urls.push(pageUrl);
      tabs.push(ok(name, ['open', pageUrl, '--background']).result.tabId);
      await waitLoaded();

      // 1. Without a held session nothing is profiled.
      assert.equal(profFails({ action: 'status' }), 'CDP_SESSION_NOT_STARTED');
      cdpSession({ action: 'start', events: ['Page.frameNavigated'] });
      started = true;
      const { iframe, worker } = await waitTargets();

      // 2. CSS coverage: exact lengths of profile.css, a delta merged on the next report.
      const cssStarted = prof({ action: 'cssStart' });
      assert.deepEqual(cssStarted.sessions, ['root', iframe.sessionId]);
      assert.equal(profFails({ action: 'cssStart' }), 'CSS_COVERAGE_ACTIVE');
      const sheetOf = (report) => {
        const sheet = report.sheets.find((item) => item.url.endsWith('/profile.css'));
        assert(
          sheet,
          'profile.css in report: ' + JSON.stringify(report.sheets.map((item) => item.url)),
        );
        return sheet;
      };
      const firstCss = sheetOf(prof({ action: 'cssReport', url: 'profile.css' }));
      assert.deepEqual(
        [firstCss.totalChars, firstCss.usedChars, firstCss.unusedChars],
        [PROFILE_CSS.length, USED_RULE.length, PROFILE_CSS.length - USED_RULE.length],
      );
      evalPage(
        'const el = document.createElement("div"); el.className = "profile-unused-a"; document.body.appendChild(el); return el.getBoundingClientRect().width >= 0',
      );
      const childSheet = prof({ action: 'cssReport', sessionId: iframe.sessionId }).sheets.find(
        (item) => item.url.includes('/profile-child'),
      );
      assert(childSheet && childSheet.inline, 'inline sheet of the OOPIF');
      assert(childSheet.usedChars > 0 && childSheet.unusedChars > 0, JSON.stringify(childSheet));
      const cssStopped = prof({ action: 'cssStop' });
      const finalCss = sheetOf(cssStopped);
      assert.equal(finalCss.usedChars, USED_RULE.length + SECOND_RULE.length);
      assert.equal(cssStopped.tracking, false);
      assert.equal(profFails({ action: 'cssStop' }), 'CSS_COVERAGE_NOT_STARTED');
      assert.equal(
        sheetOf(prof({ action: 'cssReport', url: 'profile.css' })).usedChars,
        finalCss.usedChars,
      );

      // 3. CPU profile per thread; scriptIds are those of chrome_cdp_scripts in the same session.
      const scripts = (sessionId) =>
        call(name, 'chrome_cdp_scripts', {
          action: 'list',
          limit: 500,
          sanitizeOutput: false,
          ...(sessionId ? { sessionId } : {}),
        }).scripts;
      const appScript = scripts().find((item) => item.url.includes('/profile-app.js'));
      const childScript = scripts(iframe.sessionId).find((item) =>
        item.url.includes('/profile-child'),
      );
      const workerScript = scripts(worker.sessionId).find((item) =>
        item.url.includes('/profile-worker.js'),
      );
      assert(appScript && childScript && workerScript, 'fixture scripts listed');
      assert.equal(prof({ action: 'cpuStart' }).recording, true);
      assert.equal(profFails({ action: 'cpuStart' }), 'CPU_PROFILE_ACTIVE');
      assert.equal(prof({ action: 'status' }).cpu.recording, true);
      evalPage('return window.profileFixture.hot(400)');
      evalIn(iframe.sessionId, 'return profileChildHot(300)');
      evalIn(worker.sessionId, 'return profileWorkerHot(300)');
      // Default redaction: the token in the script url must not appear in output or files.
      const cpu = shown({ action: 'cpuStop', top: 10 });
      files.push(...cpu.profiles.map((item) => item.path));
      const byTarget = (target) => {
        const found = cpu.profiles.filter((item) => item.target === target);
        assert.equal(
          found.length,
          1,
          target +
            ' profiles: ' +
            JSON.stringify(cpu.profiles.map((item) => [item.target, item.thread])),
        );
        return found[0];
      };
      const hot = (item, functionName) => {
        const spot = item.hotspots.find((entry) => entry.functionName === functionName);
        assert(
          spot,
          functionName + ' in ' + JSON.stringify(item.hotspots.map((entry) => entry.functionName)),
        );
        return spot;
      };
      const page = byTarget('page');
      const pageHot = hot(page, 'profileHot');
      assert.deepEqual(
        [pageHot.scriptId, pageHot.lineNumber, page.sessionId],
        // 0-based line of `function profileHot` in cli-profile-app.js.
        [appScript.scriptId, 13, undefined],
      );
      assert(pageHot.url.includes('/profile-app.js') && !pageHot.url.includes('aebprofile0123'));
      assert(page.busyMs >= 200, 'page busy ' + page.busyMs);
      const child = byTarget('iframe');
      assert.equal(child.sessionId, iframe.sessionId);
      assert.equal(hot(child, 'profileChildHot').scriptId, childScript.scriptId);
      const workerProfile = byTarget('worker');
      assert.equal(workerProfile.sessionId, worker.sessionId);
      const workerHot = hot(workerProfile, 'profileWorkerHot');
      assert.deepEqual([workerHot.scriptId, workerHot.lineNumber], [workerScript.scriptId, 3]);
      for (const item of cpu.profiles) {
        assert.equal(path.dirname(item.path), path.dirname(files[0]));
        const text = fs.readFileSync(item.path, 'utf8');
        assert.equal(Buffer.byteLength(text), item.bytes);
        assert(!text.includes('aebprofile0123'), 'token redacted in ' + item.path);
        const parsed = JSON.parse(text);
        assert(parsed.nodes.length > 1 && parsed.samples.length === parsed.timeDeltas.length);
        assert(parsed.endTime > parsed.startTime);
      }
      assert.equal(profFails({ action: 'cpuStop' }), 'CPU_PROFILE_NOT_STARTED');

      // 4. Heap: usage per session, instance counts with a known growth between two samples.
      const usage = prof({ action: 'heapUsage' });
      assert.deepEqual(usage.sessions.map((item) => item.type).sort(), [
        'iframe',
        'page',
        'worker',
      ]);
      assert(usage.sessions.every((item) => item.usedSize > 0 && item.totalSize >= item.usedSize));
      evalPage('return window.profileFixture.release()');
      const before = prof({ action: 'heapSample', constructors: ['ProfileLeak', 'Worker'] });
      assert.deepEqual([before.counts.ProfileLeak.count, before.counts.Worker.count], [0, 1]);
      assert.equal(evalPage('return window.profileFixture.grow(' + LEAKS + ')'), LEAKS);
      const after = prof({ action: 'heapSample', constructors: ['ProfileLeak', 'Worker'] });
      const diff = prof({ action: 'heapDiff', from: before.sample, to: after.sample }).diff;
      assert.deepEqual(diff.constructors, [
        { constructor: 'ProfileLeak', before: 0, after: LEAKS, delta: LEAKS },
        { constructor: 'Worker', before: 1, after: 1, delta: 0 },
      ]);
      const freezeMs = after.counts.ProfileLeak.ms;
      const inWorker = prof({
        action: 'heapSample',
        constructors: ['Object'],
        sessionId: worker.sessionId,
      });
      assert(inWorker.counts.Object.count > 0);
      const heapRejected = {
        missing: profFails({ action: 'heapSample', constructors: ['NoSuchCtor'] }),
        mismatch: profFails({ action: 'heapDiff', from: after.sample, to: inWorker.sample }),
        unknownSample: profFails({ action: 'heapDiff', from: 1, to: 999 }),
        unknownSession: profFails({ action: 'heapSample', constructors: ['Map'], sessionId: 'X' }),
      };
      assert.deepEqual(heapRejected, {
        missing: 'HEAP_CONSTRUCTOR_NOT_FOUND',
        mismatch: 'HEAP_SAMPLE_MISMATCH',
        unknownSample: 'HEAP_SAMPLE_NOT_FOUND',
        unknownSession: 'CDP_UNKNOWN_SESSION',
      });
      evalPage('return window.profileFixture.release()');

      // 5. Paused page: no evaluation there; CSS, Tracing, and other sessions still answer.
      const requested = dbg({ action: 'pause', timeoutMs: 0 });
      evalIn(iframe.sessionId, 'parent.postMessage("tick", "*"); return 1');
      const paused = requested.paused ? requested : dbg({ action: 'wait', timeoutMs: 10000 });
      assert.equal(paused.paused, true, JSON.stringify(paused));
      const pausedCalls = {
        heapSample: profFails({ action: 'heapSample', constructors: ['ProfileLeak'] }),
      };
      assert.deepEqual(pausedCalls, { heapSample: 'PROFILE_PAGE_PAUSED' });
      assert.equal(prof({ action: 'cssStart' }).tracking, true);
      assert(prof({ action: 'cssReport', url: 'profile.css' }).sheets.length === 1);
      assert.equal(prof({ action: 'cpuStart' }).recording, true);
      prof({ action: 'heapSample', constructors: ['Object'], sessionId: worker.sessionId });
      assert.equal(dbg({ action: 'resume' }).resumed, true);

      // 6. Other tasks cannot use the held session.
      assert.equal(
        fails(other, 'chrome_cdp_profile', { tabId: tabs[0], action: 'status' }),
        'CDP_SESSION_OWNED',
      );

      // 7. Session stop ends the running trace and CSS tracking and releases the browser lock.
      assert.deepEqual(prof({ action: 'status' }).css.tracking, true);
      cdpSession({ action: 'stop' });
      started = false;
      cdpSession({ action: 'start', events: [] });
      started = true;
      const restarted = prof({ action: 'status' });
      assert.deepEqual([restarted.cpu.recording, restarted.css.tracking], [false, false]);
      assert.equal(prof({ action: 'cpuStart' }).recording, true);
      cdpSession({ action: 'stop' });
      started = false;

      return {
        ok: true,
        runId,
        css: {
          totalChars: firstCss.totalChars,
          usedChars: firstCss.usedChars,
          afterDelta: finalCss.usedChars,
          oopif: true,
        },
        cpu: {
          profiles: cpu.profiles.map((item) => item.target).sort(),
          pageHot: pageHot.selfMs,
          files: files.length,
        },
        heap: { growth: diff.constructors[0].delta, freezeMs },
        heapRejected,
        pausedCalls,
        cleaned: true,
      };
    },
    async () => {
      const errors = [];
      if (started && tabs[0] !== undefined) {
        const quiet = (tool, args) =>
          runCli(name, ['call', tool, JSON.stringify({ tabId: tabs[0], ...args })]);
        quiet('chrome_cdp_debugger', { action: 'resume' });
        // Ends a running trace and CSS tracking.
        const stop = quiet('chrome_cdp_session', { action: 'stop' });
        if (stop.response?.ok !== true) errors.push('stop held session: ' + stop.stdout);
      }
      for (const file of files) {
        try {
          removeFile(file);
          if (fs.existsSync(file)) errors.push('profile file remains: ' + file);
        } catch (error) {
          errors.push(String(error));
        }
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
  runCdpProfile()
    .then((result) => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch((error) => {
      process.stderr.write(String(error.stack || error) + '\n');
      if (error instanceof AggregateError)
        for (const cause of error.errors) process.stderr.write(String(cause.stack || cause) + '\n');
      process.exitCode = 1;
    });

module.exports = { runCdpProfile };
