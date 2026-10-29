'use strict';

// Real-browser acceptance for chrome_cdp_scripts: script table from Debugger.scriptParsed on a
// held chrome_cdp_session, paged source reads of a large one-line bundle, cross-script search
// with resource-relative locations, OOPIF/worker scripts, navigation pruning and cleanup.
const assert = require('node:assert/strict');
const http = require('node:http');
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

// CDP line/column (UTF-16) of the first occurrence of needle in a resource.
function locate(text, needle) {
  const offset = text.indexOf(needle);
  assert(offset >= 0, 'needle not in resource: ' + needle);
  const before = text.slice(0, offset);
  const lines = before.split(/\r\n|[\n\r\u2028\u2029]/);
  return { line: lines.length - 1, column: lines[lines.length - 1].length };
}

async function runCdpScripts() {
  const runId = randomUUID().replaceAll('-', '');
  const name = 'cdpscr_' + runId.slice(0, 8);
  const other = name + '_other';
  const probe = name + '_probe';
  const tabs = [];
  const urls = [];
  let fixture;
  let started = false;
  const ok = (session, args, label) => assertOk(runCli(session, args), label || args[1] || args[0]);
  const call = (session, tool, args, label) =>
    ok(session, ['call', tool, JSON.stringify(args)], label || tool).result;
  const scripts = (args) => call(name, 'chrome_cdp_scripts', args, 'cdp_scripts ' + args.action);
  const fails = (session, tool, args, label) =>
    errorCode(assertFailure(runCli(session, ['call', tool, JSON.stringify(args)]), label));
  const attachedByUs = (tabId) =>
    jsValue(
      ok(probe, [
        'eval',
        'const targets = await chrome.debugger.getTargets(); return targets.filter((t) => t.tabId === ' +
          tabId +
          ' && t.attached).map((t) => t.type);',
      ]),
    );
  const waitLoaded = () =>
    ok(name, [
      'wait',
      JSON.stringify({
        kind: 'javascript',
        predicate:
          'document.readyState === "complete" && window.evalMarker && document.querySelector("#cross")?.contentWindow?.length === 0',
      }),
    ]);

  return runWithCleanup(
    async () => {
      const health = ok(name, ['health']).result;
      assert(
        health.schema.toolNames.includes('chrome_cdp_scripts'),
        'running extension lacks chrome_cdp_scripts; rebuild and reload it first',
      );
      fixture = await createFixtureServer(runId);
      const pageUrl = fixture.origin + '/scripts?record=' + name;
      const bundleUrl = fixture.origin + '/scripts-bundle.js?run=' + runId;
      urls.push(pageUrl);
      const [html, bundle] = await Promise.all([fetchText(pageUrl), fetchText(bundleUrl)]);
      const tabId = ok(name, ['open', pageUrl, '--background']).result.tabId;
      tabs.push(tabId);
      waitLoaded();
      tabs.push(
        ok(probe, [
          'open',
          'chrome-extension://' + EXTENSION_ID + '/offscreen.html',
          '--background',
        ]).result.tabId,
      );

      // 1. Without a held session the tool refuses and nothing is attached.
      assert.equal(
        fails(name, 'chrome_cdp_scripts', { action: 'list' }, 'list before start'),
        'CDP_SESSION_NOT_STARTED',
      );
      assert.deepEqual(attachedByUs(tabId), []);

      call(name, 'chrome_cdp_session', { action: 'start' }, 'cdp_session start');
      started = true;

      // 2. list (separate CLI process) enables Debugger and sees scripts parsed before start.
      const listed = scripts({ action: 'list', limit: 1000 });
      const root = listed.scripts.filter((script) => !script.sessionId);
      const external = root.find((script) => script.url === bundleUrl);
      assert(external, 'bundle missing: ' + JSON.stringify(listed.scripts.map((s) => s.url)));
      assert.equal(external.kind, 'external');
      assert.equal(external.target, 'page');
      assert.equal(external.length, bundle.length);
      assert.equal(external.sourceMapURL, 'scripts-bundle.js.map');
      const inline = root.filter((script) => script.kind === 'inline' && script.url === pageUrl);
      assert.equal(inline.length, 2, 'two inline <script> blocks: ' + JSON.stringify(inline));
      assert(
        root.some((script) => script.kind === 'eval'),
        'eval script missing',
      );
      const frameTarget = call(name, 'chrome_cdp_session', { action: 'status' }).targets.find(
        (target) => target.type === 'iframe',
      );
      assert(frameTarget, 'OOPIF child target missing');
      const frameScript = listed.scripts.find(
        (script) => script.sessionId === frameTarget.sessionId,
      );
      assert(frameScript, 'OOPIF scripts missing from the table');
      assert.equal(frameScript.target, 'iframe');
      assert(!listed.scripts.some((script) => script.context === 'isolated'));

      // 3. Paged source of the one-line bundle reassembles exactly, each page within budget.
      let offset = 0;
      let rebuilt = '';
      let pages = 0;
      for (;;) {
        const page = scripts({
          action: 'source',
          scriptId: external.scriptId,
          offset,
          length: 100000,
          maxOutputBytes: 60000,
          sanitizeOutput: false,
        });
        assert(Buffer.byteLength(page.text) <= 60000, 'source page exceeds maxOutputBytes');
        assert.equal(page.offset, offset);
        rebuilt += page.text;
        pages += 1;
        if (!page.hasMore) break;
        offset = page.endOffset;
      }
      assert.equal(rebuilt, bundle, 'paged bundle differs from the served file');
      assert(pages >= 5, 'bundle should need several pages, got ' + pages);
      const defaultPage = scripts({ action: 'source', scriptId: external.scriptId });
      assert.equal(defaultPage.redacted, undefined, 'plain bundle code was redacted');
      assert(defaultPage.hasMore && defaultPage.endOffset <= 20000);

      // 4. Inline script lines are resource-relative.
      const inlineLoc = locate(html, "window.inlineMarker = 'inline-");
      const inlineScript = inline.find(
        (script) => script.startLine <= inlineLoc.line && script.endLine >= inlineLoc.line,
      );
      const inlineLine = scripts({
        action: 'source',
        scriptId: inlineScript.scriptId,
        line: inlineLoc.line,
        lineCount: 1,
      });
      assert(inlineLine.text.includes('inline-' + runId), JSON.stringify(inlineLine));

      // 5. search: one query across the bundle, inline, eval, and OOPIF scripts.
      const found = scripts({ action: 'search', query: runId, maxMatches: 50 });
      const at = (predicate, label) => {
        const match = found.matches.find(predicate);
        assert(
          match,
          label +
            ' hit missing: ' +
            JSON.stringify({
              ...found,
              matches: found.matches.map((m) => [m.scriptId, m.line, m.column]),
            }),
        );
        return match;
      };
      const bundleHit = at((m) => m.scriptId === external.scriptId, 'bundle');
      assert.deepEqual(
        { line: bundleHit.line, column: bundleHit.column, offset: bundleHit.offset },
        { ...locate(bundle, runId), offset: bundle.indexOf(runId) },
      );
      assert.equal(bundleHit.match, runId);
      const inlineHit = at(
        (m) => m.scriptId === inlineScript.scriptId && m.before.endsWith('inline-'),
        'inline',
      );
      assert.deepEqual(
        { line: inlineHit.line, column: inlineHit.column },
        locate(html, runId + "';"),
      );
      // Other extensions may add their own eval scripts; pick the fixture's by content.
      const evalHit = at(
        (m) =>
          m.before.endsWith("evalMarker = 'eval-") &&
          root.some((script) => script.scriptId === m.scriptId && script.kind === 'eval'),
        'eval',
      );
      assert.equal(evalHit.line, 0);
      const frameHit = scripts({
        action: 'search',
        query: 'dataset.lastEvent',
        sessionId: frameTarget.sessionId,
      });
      assert.equal(frameHit.matches.length, 1, JSON.stringify(frameHit));
      assert.equal(frameHit.matches[0].sessionId, frameTarget.sessionId);

      // Paging the same search one hit at a time yields the same hits.
      const paged = [];
      let cursor;
      do {
        const page = scripts({ action: 'search', query: runId, maxMatches: 1, cursor });
        paged.push(...page.matches);
        cursor = page.cursor;
      } while (cursor);
      assert.deepEqual(
        paged.map((m) => [m.scriptId, m.sessionId, m.offset]),
        found.matches.map((m) => [m.scriptId, m.sessionId, m.offset]),
      );

      // 6. skipAllPauses: a `debugger;` statement does not freeze the page.
      assert.equal(jsValue(ok(name, ['eval', 'return pauseProbe()'])), 'not-paused');

      // 7. A worker created now is enabled on attach and its scripts become searchable.
      const workerMarker = 'worker-' + runId;
      const workerSource =
        'self.marker = ' + JSON.stringify(workerMarker) + '; onmessage = () => {}';
      ok(name, [
        'eval',
        'window.__w = new Worker(URL.createObjectURL(new Blob([' +
          JSON.stringify(workerSource) +
          '], {type: "text/javascript"}))); return true',
      ]);
      let workerHit;
      for (let attempt = 0; attempt < 20 && !workerHit; attempt += 1) {
        workerHit = scripts({ action: 'search', query: workerMarker }).matches.find(
          (match) => match.sessionId,
        );
        if (!workerHit) await new Promise((resolve) => setTimeout(resolve, 200));
      }
      assert(workerHit, 'worker script not found');
      const workerScript = scripts({ action: 'list', sessionId: workerHit.sessionId }).scripts[0];
      assert.equal(workerScript.target, 'worker');

      // 8. Negative cases fail before Chrome IO.
      assert.equal(
        fails(name, 'chrome_cdp_scripts', { action: 'source', scriptId: '999999' }, 'unknown id'),
        'SCRIPT_NOT_FOUND',
      );
      assert.equal(
        fails(
          name,
          'chrome_cdp_scripts',
          { action: 'search', query: '(', isRegex: true },
          'bad regex',
        ),
        'INVALID_ARGUMENT',
      );
      assert.equal(
        fails(other, 'chrome_cdp_scripts', { tabId, action: 'list' }, 'foreign task'),
        'CDP_SESSION_OWNED',
      );

      // 9. Navigation drops the old document's scripts; the new document's are listed once.
      const nextUrl = pageUrl + '&nav=1';
      urls.push(nextUrl);
      call(name, 'chrome_navigate', { url: nextUrl, tabId }, 'navigate');
      waitLoaded();
      let afterNav;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        afterNav = scripts({ action: 'list', sessionId: '', limit: 1000 }).scripts;
        if (afterNav.some((script) => script.url === nextUrl)) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      assert(
        !afterNav.some((script) => script.url === pageUrl),
        'old document scripts survived navigation: ' + JSON.stringify(afterNav.map((s) => s.url)),
      );
      assert.equal(afterNav.filter((script) => script.url === nextUrl).length, 2);
      assert.equal(afterNav.filter((script) => script.url === bundleUrl).length, 1);
      const navSource = scripts({
        action: 'source',
        scriptId: afterNav.find((script) => script.url === bundleUrl).scriptId,
        offset: bundle.indexOf(runId),
        length: runId.length,
      });
      assert.equal(navSource.text, runId);

      // 10. stop disables Debugger and detaches; later calls fail.
      assert.equal(call(name, 'chrome_cdp_session', { action: 'stop' }).stopped, true);
      started = false;
      assert.deepEqual(attachedByUs(tabId), [], 'debugger still attached after stop');
      assert.equal(
        fails(name, 'chrome_cdp_scripts', { action: 'list' }, 'list after stop'),
        'CDP_SESSION_NOT_STARTED',
      );

      return {
        ok: true,
        runId,
        scripts: {
          root: root.length,
          inline: inline.length,
          oopif: listed.scripts.filter((s) => s.sessionId === frameTarget.sessionId).length,
        },
        bundle: { length: bundle.length, bytes: Buffer.byteLength(bundle), pages },
        hits: {
          bundle: [bundleHit.line, bundleHit.column],
          inline: [inlineHit.line, inlineHit.column],
          searchMatches: found.matches.length,
        },
        worker: workerScript.target,
        navigationPruned: true,
        detachedAfterStop: true,
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
  runCdpScripts()
    .then((result) => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch((error) => {
      process.stderr.write(String(error.stack || error) + '\n');
      if (error instanceof AggregateError)
        for (const cause of error.errors) process.stderr.write(String(cause.stack || cause) + '\n');
      process.exitCode = 1;
    });

module.exports = { runCdpScripts };
