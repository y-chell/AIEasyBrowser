'use strict';

// Real-browser acceptance for B6 chrome_cdp_network on a held chrome_cdp_session: the request
// table across the top frame, a cross-site OOPIF and its re-created session after reload; wire
// headers with redaction and auth names; JSON, binary, and truncated multi-byte bodies; request
// bodies; WebSocket frames and EventSource messages; HAR files; stop; rejections; and the
// webRequest-only chrome_network_capture left after removing its debugger backend.
const assert = require('node:assert/strict');
const fs = require('node:fs');
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

async function runCdpNetwork() {
  const runId = randomUUID().replaceAll('-', '');
  const name = 'cdpnet_' + runId.slice(0, 8);
  const other = name + '_other';
  const probe = name + '_probe';
  const secret = 'hidden-' + runId;
  const tabs = [];
  const urls = [];
  const downloadIds = [];
  let fixture;
  let started = false;
  const ok = (session, args, label) => assertOk(runCli(session, args), label || args[1] || args[0]);
  const call = (session, tool, args, label) =>
    ok(session, ['call', tool, JSON.stringify(args)], label || tool).result;
  const fails = (session, tool, args, label) =>
    errorCode(assertFailure(runCli(session, ['call', tool, JSON.stringify(args)]), label || tool));
  const net = (args) => call(name, 'chrome_cdp_network', args, 'cdp_network ' + args.action);
  const cdpSession = (args) => call(name, 'chrome_cdp_session', args, 'cdp_session ' + args.action);
  const evalPage = (code) => jsValue(ok(name, ['eval', code]));
  const debugTargets = (filter) =>
    jsValue(
      ok(probe, [
        'eval',
        'const targets = await chrome.debugger.getTargets(); return targets.filter((t) => ' +
          filter +
          ').map((t) => ({ type: t.type, attached: t.attached }));',
      ]),
    );
  const rows = (filter = {}) => {
    const all = [];
    let after = 0;
    for (;;) {
      const page = net({ action: 'list', after, sanitizeOutput: false, ...filter });
      all.push(...page.requests);
      after = page.nextAfter;
      if (!page.hasMore) return all;
    }
  };
  // Bodies are read after loadingFinished; wait until the matching row settled.
  const waitRow = async (predicate, label) => {
    let seen;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      seen = rows();
      const found = seen.filter(predicate);
      if (found.length) return found[found.length - 1];
      await sleep(200);
    }
    throw new Error(label + ' not recorded: ' + JSON.stringify(seen).slice(0, 3000));
  };
  const waitLoaded = async () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const state = runCli(name, [
        'eval',
        'return document.readyState === "complete" && typeof window.netJson === "function"',
      ]);
      if (state.response?.ok === true && jsValue(state.response) === true) return;
      await sleep(200);
    }
    throw new Error('fixture did not finish loading');
  };
  const childSession = () =>
    cdpSession({ action: 'status' }).targets.find((target) => target.type === 'iframe');
  const childFetch = (sessionId) =>
    jsValue({
      result: call(name, 'chrome_javascript', {
        sessionId,
        code: 'return await window.childFetch()',
      }),
    });
  const readHar = (result) => {
    const text = fs.readFileSync(result.path, 'utf8');
    assert.equal(Buffer.byteLength(text), result.bytes, 'HAR size on disk');
    return { text, har: JSON.parse(text) };
  };

  return runWithCleanup(
    async () => {
      const health = ok(name, ['health']).result;
      assert(
        health.schema.toolNames.includes('chrome_cdp_network'),
        'running extension lacks chrome_cdp_network; rebuild and reload it first',
      );
      fixture = await createFixtureServer(runId);
      const pageUrl = fixture.origin + '/net?run=' + name;
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

      // 1. Without a held session or before start nothing is recorded.
      assert.equal(
        fails(name, 'chrome_cdp_network', { action: 'list' }, 'list before session'),
        'CDP_SESSION_NOT_STARTED',
      );
      cdpSession({ action: 'start', events: ['Page.frameNavigated'] });
      started = true;
      assert.equal(
        fails(name, 'chrome_cdp_network', { action: 'list' }, 'list before start'),
        'NETWORK_NOT_STARTED',
      );
      const child = childSession();
      assert(child, 'OOPIF child attached');
      const startResult = net({ action: 'start' });
      assert.deepEqual(startResult.sessions, ['root', child.sessionId]);
      assert.equal(startResult.bodies, 'api');

      // 2. Traffic: JSON twice (the second carries the cookie the first set), binary, big, child.
      const first = evalPage('return await window.netJson("a")');
      const second = evalPage('return await window.netJson("b")');
      assert.equal(first[0], 201);
      const binary = evalPage('return await window.netGet("binary")');
      assert.deepEqual(binary.slice(0, 2), [200, 1024]);
      const big = evalPage('return (await window.netGet("big")).slice(0, 2)');
      assert.deepEqual(big, [200, 2_100_000]);
      const childResult = childFetch(child.sessionId);
      assert.equal(childResult[0], 200);
      const sse = evalPage('return await window.netSse()');
      assert.equal(sse.length, 3);
      const echo = evalPage('return await window.netWs()');
      assert.equal(echo, 'echo:ping-' + runId);

      // 3. JSON request: wire headers redacted by default, auth names, both bodies.
      const json = await waitRow(
        (row) => row.url.endsWith('kind=json') && row.bodyBytes !== undefined,
        'second json request',
      );
      const detail = net({ action: 'get', seq: json.seq }).request;
      assert.equal(detail.method, 'POST');
      assert.equal(detail.status, 201);
      assert.equal(detail.request.headersSource, 'wire');
      assert.equal(detail.request.headers.Authorization, '[REDACTED]');
      assert.equal(detail.request.headers.Cookie, '[REDACTED]');
      assert.equal(detail.request.headers['X-Trace'], 'trace-b');
      assert.equal(detail.response.headers['Set-Cookie'], '[REDACTED]');
      // Cookies are not port-scoped: other local apps' 127.0.0.1 cookies come along.
      assert.deepEqual([...detail.auth.requestHeaders].sort(), ['Authorization', 'Cookie']);
      assert.deepEqual(detail.auth.responseHeaders, ['Set-Cookie']);
      assert(detail.auth.cookies.includes('net_session'), 'cookie names include net_session');
      assert.deepEqual(detail.auth.setCookies, ['net_session']);
      assert.equal(detail.request.body.preview, '{"value":"b"}');
      assert.equal(detail.initiator.type, 'script');
      assert(detail.initiator.stack.length > 0, 'initiator stack');
      assert(!JSON.stringify(detail).includes(secret), 'no secret in redacted detail');
      const raw = call(name, 'chrome_cdp_network', {
        action: 'get',
        seq: json.seq,
        sanitizeOutput: false,
      }).request;
      assert.equal(raw.request.headers.Authorization, 'Bearer ' + secret);
      const responseBody = net({ action: 'body', seq: json.seq, sanitizeOutput: false });
      assert.equal(responseBody.text, second[1]);
      const requestBody = net({ action: 'body', seq: json.seq, part: 'request' });
      assert.equal(requestBody.text, '{"value":"b"}');

      // 4. Binary as base64 by bytes; the 2.1 MB body kept to 1 MB in whole characters.
      const bin = rows().find((row) => row.url.endsWith('kind=binary'));
      const slice = net({ action: 'body', seq: bin.seq, offset: 250, length: 10 });
      assert.equal(slice.base64, true);
      assert.deepEqual(
        [...Buffer.from(slice.data, 'base64')],
        [250, 251, 252, 253, 254, 255, 0, 1, 2, 3],
      );
      const bigRow = await waitRow(
        (row) => row.url.endsWith('kind=big') && row.bodyBytes !== undefined,
        'big body',
      );
      const bigHead = net({ action: 'body', seq: bigRow.seq });
      assert.equal(bigHead.captureTruncated, true);
      assert.equal(bigHead.totalBytes, 2_100_000);
      assert.equal(bigHead.storedBytes, 349_525 * 3);
      assert.equal(bigHead.totalChars, 349_525);
      assert.equal(bigHead.hasMore, true);
      assert.equal(bigHead.text, '汉'.repeat(bigHead.endOffset));
      const bigTail = net({ action: 'body', seq: bigRow.seq, offset: 349_500 });
      assert.deepEqual([bigTail.endOffset, bigTail.hasMore], [349_525, false]);

      // 5. The OOPIF request is in the child session with its body.
      const childRow = await waitRow(
        (row) => row.url.endsWith('kind=child') && row.bodyBytes !== undefined,
        'child request',
      );
      assert.equal(childRow.sessionId, child.sessionId);
      assert.equal(
        net({ action: 'body', seq: childRow.seq, sanitizeOutput: false }).text,
        childResult[1],
      );
      assert.equal(rows({ sessionId: child.sessionId }).length >= 1, true);

      // 6. EventSource and WebSocket messages.
      const sseRow = rows({ types: ['EventSource'] })[0];
      const sseMessages = net({ action: 'messages', seq: sseRow.seq, sanitizeOutput: false });
      assert.deepEqual(
        sseMessages.messages.map((item) => [item.event, item.id, item.data]),
        [1, 2, 3].map((index) => ['tick', String(index), 'tick-' + index + '-' + runId]),
      );
      const wsRow = rows({ types: ['WebSocket'] })[0];
      assert.equal(wsRow.status, 101);
      const wsMessages = net({ action: 'messages', seq: wsRow.seq, sanitizeOutput: false });
      assert.deepEqual(
        wsMessages.messages.map((item) => [item.direction, item.data]),
        [
          ['sent', 'ping-' + runId],
          ['received', 'echo:ping-' + runId],
        ],
      );
      assert.equal(
        fails(name, 'chrome_cdp_network', { action: 'body', seq: wsRow.seq }, 'ws body'),
        'NETWORK_NO_BODY',
      );

      // 7. The table ignores the event filter, which buffered no Network event.
      const buffered = cdpSession({ action: 'events', after: 0, limit: 1000 }).events;
      assert(!buffered.some((event) => event.method.startsWith('Network.')));

      // 8. Reload: earlier bodies stay readable; the re-created OOPIF is enabled before it runs.
      evalPage('setTimeout(() => location.reload(), 0); return 1');
      await sleep(500);
      await waitLoaded();
      assert.equal(
        net({ action: 'body', seq: json.seq, sanitizeOutput: false }).text,
        second[1],
        'body kept across navigation',
      );
      let reloadedChild;
      for (let attempt = 0; attempt < 25 && !reloadedChild; attempt += 1) {
        const found = childSession();
        if (found && found.sessionId !== child.sessionId) reloadedChild = found;
        else await sleep(200);
      }
      assert(reloadedChild, 'OOPIF re-attached as a new child session');
      // Its navigation is requested in the root session and finishes in the new child session.
      const childUrl = fixture.origin.replace('127.0.0.1', 'localhost') + '/net-child';
      const reloadedDocument = await waitRow(
        (row) =>
          row.url === childUrl &&
          row.seq > wsRow.seq &&
          row.state === 'complete' &&
          row.bodyBytes !== undefined,
        're-created OOPIF document',
      );
      assert.equal(reloadedDocument.sessionId, undefined);
      assert(
        net({ action: 'body', seq: reloadedDocument.seq }).text.includes('window.childFetch'),
        'OOPIF document body read from its child session',
      );
      childFetch(reloadedChild.sessionId);
      const reloadedFetch = await waitRow(
        (row) =>
          row.sessionId === reloadedChild.sessionId &&
          row.url.endsWith('kind=child') &&
          row.bodyBytes !== undefined,
        're-created OOPIF fetch',
      );
      assert.equal(reloadedFetch.status, 200);

      // 9. HAR: redacted by default, raw on request; files are written and complete.
      const harResult = net({ action: 'har', filename: name });
      downloadIds.push(harResult.downloadId);
      assert.equal(harResult.path.endsWith(name + '.har'), true, harResult.path);
      const redacted = readHar(harResult);
      assert.equal(redacted.har.log.version, '1.2');
      assert.equal(redacted.har.log.entries.length, harResult.entries);
      assert(!redacted.text.includes(secret), 'no secret in the redacted HAR');
      const harJson = redacted.har.log.entries.find((entry) => entry._seq === json.seq);
      assert.deepEqual(
        harJson.request.cookies.find((cookie) => cookie.name === 'net_session'),
        { name: 'net_session', value: '[REDACTED]' },
      );
      assert(harJson.request.cookies.every((cookie) => cookie.value === '[REDACTED]'));
      assert.equal(harJson.request.postData.text, '{"value":"b"}');
      assert.equal(harJson.response.status, 201);
      assert.equal(JSON.parse(harJson.response.content.text).trace, 'trace-b');
      const harWs = redacted.har.log.entries.find((entry) => entry._seq === wsRow.seq);
      assert.equal(harWs._webSocketMessages.length, 2);
      const rawHarResult = net({
        action: 'har',
        filename: name + '-raw',
        types: ['Fetch'],
        sanitizeOutput: false,
      });
      downloadIds.push(rawHarResult.downloadId);
      const rawHar = readHar(rawHarResult);
      assert(rawHar.har.log.entries.every((entry) => entry._resourceType === 'fetch'));
      assert(rawHar.text.includes('Bearer ' + secret), 'raw HAR keeps credentials');

      // 10. Interception: rules answer paused requests in the root, the OOPIF, and a worker.
      const intercept = (rule) => net({ action: 'intercept', rule }).rule.id;
      const continueRule = intercept({
        urlPattern: '*kind=json*',
        action: 'continue',
        headers: { 'X-Trace': 'trace-intercepted' },
        postData: '{"value":"intercepted"}',
      });
      const mockRule = intercept({
        urlPattern: '*kind=mock*',
        action: 'fulfill',
        status: 418,
        headers: { 'Content-Type': 'text/plain' },
        body: 'mocked-' + runId,
      });
      const failRule = intercept({
        urlPattern: '*kind=blocked*',
        action: 'fail',
        errorReason: 'BlockedByClient',
      });
      const logRule = intercept({ urlPattern: '*kind=*worker*', action: 'log' });
      const childRule = intercept({ urlPattern: '*kind=child*', action: 'log' });
      const lateRule = intercept({
        urlPattern: '*kind=late*',
        stage: 'response',
        action: 'fulfill',
        status: 203,
        body: 'late-' + runId,
      });
      const modified = evalPage('return await window.netJson("orig")');
      assert.equal(modified[0], 201);
      assert.deepEqual(
        [JSON.parse(modified[1]).trace, JSON.parse(modified[1]).body],
        ['trace-intercepted', '{"value":"intercepted"}'],
        'the server saw the changed header and body',
      );
      assert.deepEqual(evalPage('return await window.netGet("mock")'), [
        418,
        ('mocked-' + runId).length,
        'mocked-' + runId,
      ]);
      assert.equal(evalPage('return await window.netGet("blocked")')[0], 'error');
      assert.deepEqual(evalPage('return (await window.netGet("late")).slice(0, 3)'), [
        203,
        ('late-' + runId).length,
        'late-' + runId,
      ]);
      const interceptChild = childSession();
      childFetch(interceptChild.sessionId);
      evalPage('window.netWorker = new Worker("/frames-worker.js?kind=dedicated"); return 1');
      let worker;
      for (let attempt = 0; attempt < 25 && !worker; attempt += 1) {
        worker = cdpSession({ action: 'status' }).targets.find(
          (target) => target.type === 'worker',
        );
        if (!worker) await sleep(200);
      }
      assert(worker, 'dedicated worker attached');
      const workerStatus = call(name, 'chrome_javascript', {
        sessionId: worker.sessionId,
        // Read the body: an unread worker response never reports loadingFinished, so the row stays pending.
        code: 'const r = await fetch("/net-api?kind=worker"); await r.text(); return r.status',
      });
      assert.equal(jsValue({ result: workerStatus }), 200);
      const interceptedRow = (suffix, predicate = () => true) =>
        waitRow(
          (row) =>
            row.url.endsWith(suffix) &&
            row.intercepted &&
            row.state !== 'pending' &&
            predicate(row),
          'intercepted ' + suffix,
        );
      const modifiedRow = await interceptedRow('kind=json', (row) => row.seq > reloadedFetch.seq);
      assert.deepEqual(modifiedRow.intercepted, [continueRule + ':continue']);
      const modifiedDetail = net({ action: 'get', seq: modifiedRow.seq }).request;
      assert.deepEqual(modifiedDetail.intercepts[0].changes, ['postData', 'header X-Trace']);
      const mockRow = await interceptedRow('kind=mock');
      assert.deepEqual([mockRow.status, mockRow.intercepted], [418, [mockRule + ':fulfill']]);
      assert.equal(
        net({ action: 'body', seq: mockRow.seq, sanitizeOutput: false }).text,
        'mocked-' + runId,
      );
      const blockedRow = await interceptedRow('kind=blocked');
      assert.equal(blockedRow.state, 'failed');
      assert.match(blockedRow.error, /ERR_BLOCKED_BY_CLIENT/);
      assert.deepEqual(blockedRow.intercepted, [failRule + ':fail']);
      const lateRow = await interceptedRow('kind=late');
      assert.equal(lateRow.status, 203);
      assert.equal(
        net({ action: 'get', seq: lateRow.seq }).request.intercepts[0].responseStatus,
        200,
        'response stage saw the real status',
      );
      assert.deepEqual(lateRow.intercepted, [lateRule + ':fulfill']);
      const childLogged = await interceptedRow('kind=child', (row) => row.seq > modifiedRow.seq);
      assert.equal(childLogged.sessionId, interceptChild.sessionId);
      assert.deepEqual(childLogged.intercepted, [childRule + ':log']);
      const workerRow = await interceptedRow('kind=worker');
      assert.equal(
        workerRow.sessionId,
        worker.sessionId,
        'worker request linked to the worker row',
      );
      assert.deepEqual(workerRow.intercepted, [logRule + ':log']);
      const ruleList = net({ action: 'rules' });
      assert.deepEqual(
        ruleList.rules.map((rule) => [rule.id, rule.hits]),
        [
          [continueRule, 1],
          [mockRule, 1],
          [failRule, 1],
          [logRule, 1],
          [childRule, 1],
          [lateRule, 1],
        ],
      );
      assert(
        ruleList.sessions.includes('root') && ruleList.sessions.includes(interceptChild.sessionId),
      );
      assert(!ruleList.sessions.includes(worker.sessionId), 'no Fetch in the dedicated worker');
      assert.equal(ruleList.errors, undefined, JSON.stringify(ruleList.errors));
      assert.deepEqual(net({ action: 'unintercept', ruleId: mockRule }).removed, [mockRule]);
      assert.equal(
        evalPage('return (await window.netGet("mock"))[0]'),
        200,
        'removed rule no longer applies',
      );
      assert.equal(net({ action: 'unintercept', ruleId: 'all' }).rules, 0);
      assert.equal(
        evalPage('return (await window.netGet("blocked"))[0]'),
        200,
        'no rule after all',
      );

      // 11. Replay: explicit method and body, from the frame or worker that sent it, linked by seq.
      const replayed = net({
        action: 'replay',
        seq: modifiedRow.seq,
        sanitizeOutput: false,
        replay: {
          method: 'POST',
          body: '{"value":"replayed"}',
          headers: { 'X-Trace': 'trace-replay' },
        },
      });
      assert.equal(replayed.response.status, 201);
      const replayedEcho = JSON.parse(replayed.response.preview);
      assert.deepEqual(
        [replayedEcho.body, replayedEcho.trace],
        ['{"value":"replayed"}', 'trace-replay'],
      );
      assert(
        replayed.request.droppedHeaders === undefined ||
          !replayed.request.droppedHeaders.includes('X-Trace'),
      );
      assert.equal(replayed.linked, true);
      const replayRow = rows().find((row) => row.seq === replayed.seqs[0]);
      assert.equal(replayRow.replayOf, modifiedRow.seq);
      assert(
        rows()
          .find((row) => row.seq === modifiedRow.seq)
          .replays.includes(replayRow.seq),
      );
      const replayDetail = net({
        action: 'get',
        seq: replayRow.seq,
        sanitizeOutput: false,
      }).request;
      assert(replayDetail.auth.cookies.includes('net_session'), 'replay carried the page cookies');
      const originalBody = net({ action: 'body', seq: json.seq, part: 'request' }).text;
      const again = net({
        action: 'replay',
        seq: json.seq,
        sanitizeOutput: false,
        replay: { method: 'POST', useOriginalBody: true },
      });
      assert.equal(JSON.parse(again.response.preview).body, originalBody);
      const childReplay = net({
        action: 'replay',
        seq: childLogged.seq,
        sanitizeOutput: false,
        replay: { method: 'GET' },
      });
      assert.equal(childReplay.response.status, 200);
      assert.equal(childReplay.sentFrom.sessionId, interceptChild.sessionId);
      assert.equal(JSON.parse(childReplay.response.preview).kind, 'child');
      const workerReplay = net({ action: 'replay', seq: workerRow.seq, replay: { method: 'GET' } });
      assert.deepEqual(
        [workerReplay.response.status, workerReplay.sentFrom.kind, workerReplay.linked],
        [200, 'worker', true],
      );

      // 12. Rejections.
      const rejected = {
        otherTask: fails(other, 'chrome_cdp_network', { tabId, action: 'list' }, 'other task'),
        unknownSeq: fails(name, 'chrome_cdp_network', { action: 'get', seq: 999_999 }),
        notStream: fails(name, 'chrome_cdp_network', { action: 'messages', seq: json.seq }),
        activeAgain: fails(name, 'chrome_cdp_network', { action: 'start' }),
        badFile: fails(name, 'chrome_cdp_network', { action: 'har', filename: '../x' }),
        replayNoBody: fails(name, 'chrome_cdp_network', {
          action: 'replay',
          seq: json.seq,
          replay: { method: 'POST' },
        }),
        responseChange: fails(name, 'chrome_cdp_network', {
          action: 'intercept',
          rule: { urlPattern: '*', stage: 'response', action: 'continue', url: fixture.origin },
        }),
        unknownRule: fails(name, 'chrome_cdp_network', {
          action: 'unintercept',
          ruleId: 'rule-999',
        }),
        // Closed schemas reject these in the native server, before the extension.
        badAction: assertFailure(
          runCli(name, ['call', 'chrome_cdp_network', '{"action":"resend"}']),
          'unknown action',
        ).error.code,
        noDebuggerCapture: assertFailure(
          runCli(name, [
            'call',
            'chrome_network_capture',
            '{"action":"start","needResponseBody":true}',
          ]),
          'needResponseBody',
        ).error.code,
      };
      assert.deepEqual(rejected, {
        otherTask: 'CDP_SESSION_OWNED',
        unknownSeq: 'NETWORK_REQUEST_NOT_FOUND',
        notStream: 'NETWORK_NO_MESSAGES',
        activeAgain: 'NETWORK_ACTIVE',
        badFile: 'INVALID_ARGUMENT',
        replayNoBody: 'INVALID_ARGUMENT',
        responseChange: 'INVALID_ARGUMENT',
        unknownRule: 'INTERCEPT_RULE_NOT_FOUND',
        badAction: 'INVALID_ARGUMENT',
        noDebuggerCapture: 'INVALID_ARGUMENT',
      });

      // 13. stop disables Fetch with a rule left, keeps the table readable, records nothing more.
      intercept({ urlPattern: '*kind=mock*', action: 'fulfill', status: 418 });
      assert.equal(evalPage('return (await window.netGet("mock"))[0]'), 418);
      await waitRow(
        (row) => row.url.endsWith('kind=mock') && row.status === 418 && row.seq > workerRow.seq,
        'mock before stop',
      );
      const total = rows().length;
      assert.deepEqual(net({ action: 'stop' }), {
        success: true,
        tool: 'chrome_cdp_network',
        tabId,
        recording: false,
        requests: total,
      });
      evalPage('return await window.netJson("after-stop")');
      assert.equal(
        evalPage('return (await window.netGet("mock"))[0]'),
        200,
        'Fetch off after stop',
      );
      await sleep(300);
      assert.equal(rows().length, total);
      assert.equal(net({ action: 'clear' }).cleared, total);

      // 14. Session stop with a rule on: nothing attached, the page loads and fetches normally.
      net({ action: 'start' });
      intercept({ urlPattern: '*kind=mock*', action: 'fulfill', status: 418 });
      assert.equal(evalPage('return (await window.netGet("mock"))[0]'), 418);
      assert.equal(cdpSession({ action: 'stop' }).stopped, true);
      assert.equal(
        evalPage('return (await window.netGet("mock"))[0]'),
        200,
        'Fetch off after session stop',
      );
      started = false;
      assert.deepEqual(debugTargets('t.tabId === ' + tabId + ' && t.attached'), []);
      evalPage('setTimeout(() => location.reload(), 0); return 1');
      await sleep(500);
      await waitLoaded();
      assert.equal(evalPage('return (await window.netJson("clean"))[0]'), 201);
      assert.deepEqual(debugTargets('t.tabId === ' + tabId + ' && t.attached'), []);

      // 15. The webRequest capture still works on its own.
      // A match pattern without a port matches every port.
      const capturePattern = fixture.origin.replace(/:\d+$/, '') + '/net?run=' + name + '*';
      const captureStart = call(name, 'chrome_network_capture', {
        action: 'start',
        url: capturePattern,
      });
      assert.equal(captureStart.backend, 'webRequest');
      evalPage('return await window.netJson("capture")');
      const captured = call(name, 'chrome_network_capture', { action: 'stop' });
      assert.equal(captured.backend, 'webRequest');
      assert(
        captured.requests.some((request) => String(request.url).includes('kind=json')),
        'webRequest capture saw the fetch: ' + JSON.stringify(captured).slice(0, 1000),
      );

      return {
        ok: true,
        runId,
        table: { requests: total, oopif: true, recreatedOopif: true, eventFilterIgnored: true },
        headers: { wire: true, redacted: true, authNames: true },
        bodies: {
          json: true,
          request: true,
          binaryBase64: true,
          truncated: { totalBytes: bigHead.totalBytes, storedBytes: bigHead.storedBytes },
          keptAcrossReload: true,
        },
        streams: { sse: sseMessages.total, websocket: wsMessages.total },
        har: { entries: harResult.entries, bytes: harResult.bytes, redacted: true, raw: true },
        intercept: {
          continueModified: true,
          fulfill: 418,
          fail: blockedRow.error,
          responseStage: lateRow.status,
          oopif: true,
          dedicatedWorker: true,
          releasedOnStop: true,
          releasedOnSessionStop: true,
        },
        replay: {
          explicitBody: replayRow.seq,
          originalBody: true,
          oopif: childReplay.response.status,
          worker: workerReplay.response.status,
          cookies: true,
        },
        rejected,
        webRequestCapture: captured.requests.length,
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
      if (downloadIds.length && tabs[1] !== undefined) {
        const removed = runCli(probe, [
          'eval',
          'for (const id of ' +
            JSON.stringify(downloadIds) +
            ') { await chrome.downloads.removeFile(id).catch(() => {}); await chrome.downloads.erase({ id }); } return 1',
        ]);
        if (removed.response?.ok !== true) errors.push('remove HAR files: ' + removed.stdout);
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
  runCdpNetwork()
    .then((result) => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch((error) => {
      process.stderr.write(String(error.stack || error) + '\n');
      if (error instanceof AggregateError)
        for (const cause of error.errors) process.stderr.write(String(cause.stack || cause) + '\n');
      process.exitCode = 1;
    });

module.exports = { runCdpNetwork };
