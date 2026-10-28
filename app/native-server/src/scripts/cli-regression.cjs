'use strict';

const assert = require('node:assert/strict');
const { fork, spawn, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

const CLI_PATH = path.resolve(__dirname, '..', '..', 'dist', 'cli.js');
const FIXTURE_PATH = path.join(__dirname, '__fixtures__', 'cli-regression-server.cjs');
const CHILD_TIMEOUT_MS = 30_000;

function bridgeConfig() {
  return require('../../dist/constant');
}

function responseFromRun(run, label) {
  if (run.error) throw new Error(label + ' could not start: ' + run.error.message);
  const stdout = Buffer.isBuffer(run.stdout)
    ? run.stdout.toString('utf8')
    : String(run.stdout || '');
  try {
    return JSON.parse(stdout.trim());
  } catch (error) {
    throw new Error(
      label +
        ' did not print one JSON response: ' +
        (error instanceof Error ? error.message : String(error)) +
        '; status=' +
        run.status +
        '; signal=' +
        run.signal +
        '; stderr=' +
        String(run.stderr || ''),
    );
  }
}

function runProcess(executable, args, label, options = {}) {
  const child = spawnSync(executable, args, {
    cwd: path.resolve(__dirname, '..', '..'),
    encoding: 'utf8',
    timeout: options.timeoutMs || CHILD_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
    env: process.env,
  });
  return {
    status: child.status,
    signal: child.signal,
    stdout: child.stdout || '',
    stderr: child.stderr || '',
    error: child.error,
    response: responseFromRun(child, label),
  };
}

function runCli(session, args, options = {}) {
  const { getBridgeBaseUrl } = bridgeConfig();
  return runProcess(
    process.execPath,
    [CLI_PATH, '--url', getBridgeBaseUrl(), '--session', session, ...args],
    session + ' ' + args[0],
    options,
  );
}

function startCli(session, args) {
  const startedAt = Date.now();
  const { getBridgeBaseUrl } = bridgeConfig();
  const commandArgs = [CLI_PATH, '--url', getBridgeBaseUrl(), '--session', session, ...args];
  const child = spawn(process.execPath, commandArgs, {
    cwd: path.resolve(__dirname, '..', '..'),
    windowsHide: true,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => {
      let response;
      try {
        response = JSON.parse(stdout.trim());
      } catch {
        // The caller reports malformed output with the captured process result.
      }
      resolve({ status, signal, stdout, stderr, response, elapsedMs: Date.now() - startedAt });
    });
  });
  return { child, completion, commandLine: [process.execPath, ...commandArgs].join(' ') };
}

function interruptCli(run, reason) {
  assert(Number.isInteger(run.child.pid), 'started CLI has no PID');
  process.stderr.write(
    'Interrupting test CLI child PID ' +
      run.child.pid +
      ' (node): ' +
      run.commandLine +
      ' [' +
      reason +
      ']\n',
  );
  if (!run.child.kill('SIGINT'))
    throw new Error('could not interrupt test CLI child PID ' + run.child.pid);
}

function assertOk(run, label) {
  assert.equal(
    run.status,
    0,
    label + ' exit status; response=' + run.stdout + '; stderr=' + run.stderr,
  );
  assert.equal(run.response && run.response.ok, true, label + ' response: ' + run.stdout);
  return run.response;
}

function assertFailure(run, label) {
  assert.notEqual(run.status, 0, label + ' should use a non-zero exit status');
  assert.equal(run.response && run.response.ok, false, label + ' must print JSON failure');
  return run.response;
}

async function createFixtureServer(runId) {
  // A separate process keeps serving while this process synchronously waits for CLI calls.
  const child = fork(FIXTURE_PATH, [runId], {
    windowsHide: true,
    execArgv: [],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  const signals = new Set();
  const waiters = new Map();
  child.on('message', (message) => {
    if (message.type !== 'signal') return;
    signals.add(message.name);
    waiters.get(message.name)?.();
  });
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  const port = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) =>
      reject(new Error('fixture server exited before ready: ' + code + ' ' + stderr)),
    );
    child.once('message', (message) => {
      if (message.type !== 'ready' || !Number.isInteger(message.port)) {
        reject(new Error('invalid fixture server readiness message'));
      } else resolve(message.port);
    });
  });
  return {
    origin: 'http://127.0.0.1:' + port,
    waitForSignal: (name) =>
      new Promise((resolve, reject) => {
        if (signals.has(name)) {
          resolve();
          return;
        }
        const timeout = setTimeout(() => {
          waiters.delete(name);
          reject(new Error('fixture signal not observed: ' + name));
        }, 15000);
        waiters.set(name, () => {
          clearTimeout(timeout);
          waiters.delete(name);
          resolve();
        });
      }),
    close: async () => {
      if (child.connected) child.send({ type: 'close' });
      const code = await exited;
      assert.equal(code, 0, 'fixture server cleanup failed: ' + stderr);
    },
  };
}

function cleanupTargets(run, sessionNames, urls, tabIds = []) {
  const errors = [];
  const cleanupSession = sessionNames[0] + '_cleanup';
  if (urls.length || tabIds.length) {
    try {
      const tabs = assertOk(run(cleanupSession, ['tabs']), 'locate created fixture tabs').result
        .tabs;
      assert(Array.isArray(tabs), 'tabs response was not an array');
      const ownIds = tabs
        .filter((tab) => tabIds.includes(tab.tabId) || urls.includes(tab.url))
        .map((tab) => tab.tabId);
      if (ownIds.length) {
        assertOk(
          run(cleanupSession, ['call', 'chrome_close_tabs', JSON.stringify({ tabIds: ownIds })]),
          'close created fixture tabs',
        );
      }
    } catch (error) {
      errors.push(String(error));
    }
  }
  if (urls.length || tabIds.length) {
    try {
      const tabs = assertOk(run(cleanupSession, ['tabs']), 'verify tab cleanup').result.tabs;
      assert(Array.isArray(tabs), 'tabs response was not an array');
      assert(
        !tabs.some((tab) => urls.includes(tab.url) || tabIds.includes(tab.tabId)),
        'fixture tabs remain',
      );
    } catch (error) {
      errors.push(String(error));
    }
  }
  for (const session of [...new Set([...sessionNames, cleanupSession])]) {
    try {
      const result = run(session, ['session', '--forget']);
      if (result.status !== 0 || result.response?.ok !== true) {
        errors.push('failed to forget fixture task ' + session + ': ' + result.stdout);
      }
    } catch (error) {
      errors.push('failed to forget fixture task ' + session + ': ' + String(error));
    }
  }
  try {
    // Listing sessions does not create a task, even after this task was forgotten.
    const sessions = assertOk(
      run(cleanupSession, ['session', '--list']),
      'verify task cleanup',
    ).result;
    assert(Array.isArray(sessions), 'session list was not an array');
    assert(
      !sessions.some((item) => [...sessionNames, cleanupSession].includes(item.name)),
      'fixture tasks remain',
    );
  } catch (error) {
    errors.push(String(error));
  }
  return errors;
}

async function runWithCleanup(work, cleanup) {
  let value;
  let workError;
  let cleanupError;
  try {
    value = await work();
  } catch (error) {
    workError = error;
  }
  try {
    await cleanup();
  } catch (error) {
    cleanupError = error;
  }
  if (workError && cleanupError) {
    throw new AggregateError(
      [workError, cleanupError],
      'regression failed and cleanup also failed',
    );
  }
  if (workError) throw workError;
  if (cleanupError) throw cleanupError;
  return value;
}

function pageElements(response) {
  const elements = response.result?.elements || response.result?.page?.elements;
  assert(Array.isArray(elements), 'scan did not return elements');
  return elements;
}

function findRef(elements, id) {
  const element = elements.find((item) => item.id === id);
  assert(element && typeof element.ref === 'string', 'scan did not expose #' + id);
  return element.ref;
}

function jsValue(response) {
  const result = response.result?.result ?? response.result?.output;
  if (typeof result !== 'string') return result;
  try {
    return JSON.parse(result);
  } catch {
    return result;
  }
}

async function testLegacyRoutes() {
  const { getBridgeBaseUrl, getBridgeAuthHeaders } = bridgeConfig();
  const headers = getBridgeAuthHeaders();
  for (const route of ['/mcp', '/sse', '/messages']) {
    const response = await fetch(new URL(route, getBridgeBaseUrl()), {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 404, 'legacy route ' + route + ' must remain removed');
  }
}

async function testPendingSession(run, start, taskA, taskB, sameTargetSession) {
  const target = assertOk(run(taskA, ['session']), 'read task A target').result.tabId;
  assert(Number.isInteger(target), 'task A has no selected tab');
  assertOk(run(sameTargetSession, ['use', String(target)]), 'select same target in a second task');
  const pending = start(taskA, [
    'wait',
    JSON.stringify({ kind: 'javascript', predicate: 'window.__lockReady === true' }),
    '--timeout',
    '9000',
  ]);
  await new Promise((resolve) => setTimeout(resolve, 350));
  const busy = run(taskA, ['health']);
  assert.equal(busy.response?.error?.code, 'SESSION_BUSY', 'same task must remain locked');
  assert.equal(busy.status, 3, 'same-task lock must be a browser operation failure');
  const sameTarget = start(sameTargetSession, ['scan']);
  const otherStarted = Date.now();
  assertOk(run(taskB, ['scan']), 'other target scan while task A is waiting');
  assert(Date.now() - otherStarted < 4_000, 'other target was blocked by the pending target');
  const completed = await pending.completion;
  assertOk(completed, 'pending task wait');
  const queued = await sameTarget.completion;
  assertOk(queued, 'same target scan after the previous target operation');
  assert(queued.elapsedMs >= 1_000, 'same target scan did not wait for the overlapping operation');
  assertOk(run(taskA, ['health']), 'task continues after wait completion');
}

async function testTimeoutContinuation(run, taskA) {
  const condition = JSON.stringify({
    kind: 'javascript',
    predicate: 'window.__timeoutReady === true',
  });
  const timedOut = run(taskA, ['wait', condition, '--timeout', '650'], { timeoutMs: 8_000 });
  assertFailure(timedOut, 'short wait');
  assert.equal(timedOut.response.phase, 'wait');
  assertOk(run(taskA, ['health']), 'task query after timeout');
  assertOk(
    run(taskA, ['wait', condition, '--timeout', '8000'], { timeoutMs: 12_000 }),
    'resumed wait after timeout',
  );
}

async function testCancellationContinuation(start, run, taskA) {
  const pending = start(taskA, [
    'wait',
    JSON.stringify({ kind: 'javascript', predicate: 'window.__disconnectReady === true' }),
    '--timeout',
    '30000',
  ]);
  await new Promise((resolve) => setTimeout(resolve, 350));
  interruptCli(pending, 'simulate CLI disconnect');
  const cancelled = await pending.completion;
  if (process.platform === 'win32') {
    // Node terminates the Windows child rather than delivering a POSIX SIGINT handler.
    assert.equal(cancelled.signal, 'SIGINT', 'client termination was not observed');
  } else {
    assert.equal(cancelled.status, 130, 'SIGINT cancellation should use the documented exit code');
    assert.equal(cancelled.response?.error?.code, 'CANCELLED');
  }
  assertOk(run(taskA, ['health']), 'task query after client disconnect');
}

function readLogRecords(logPath) {
  return [logPath, ...Array.from({ length: 5 }, (_, i) => logPath + '.' + (i + 1))]
    .filter((file) => fs.existsSync(file))
    .flatMap((file) =>
      fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    );
}

function testAdvancedInputContract(run, task, logPath) {
  const snapshot = assertOk(run(task, ['session']), 'read contract-test task').result.snapshot;
  const sessionId = snapshot.split('.')[0];
  const starts = () =>
    readLogRecords(logPath).filter(
      (record) => record.event === 'tool.start' && record.session === sessionId,
    );
  const before = starts().map((record) => record.nativeRequestId);
  const invalid = [
    ['chrome_javascript', {}, 'args/code'],
    ['chrome_switch_tab', { tabId: '7' }, 'args/tabId'],
    ['chrome_screenshot', { savePng: 'false' }, 'args/savePng'],
    ['chrome_clipboard', { action: 'delete' }, 'args/action'],
    ['chrome_wait_for', { condition: { kind: 'text', extra: true } }, 'args/condition/extra'],
    ['chrome_cdp_batch', { commands: [{}] }, 'args/commands/0/method'],
    ['chrome_fill_or_select', { value: null }, 'args/value'],
  ];
  for (const [tool, args, pointer] of invalid) {
    const rejected = run(task, ['call', tool, JSON.stringify(args)]);
    const response = assertFailure(rejected, 'invalid advanced input for ' + tool);
    assert.equal(rejected.status, 2);
    assert.equal(response.error?.code, 'INVALID_ARGUMENT');
    assert(response.error.message.includes(pointer), 'missing rejected argument path ' + pointer);
    assert.equal(response.actionStatus, 'not_started');
    assert.equal(response.completed, 0);
  }
  assert.deepEqual(
    starts().map((record) => record.nativeRequestId),
    before,
    'invalid advanced input reached Native Messaging',
  );
  assertOk(run(task, ['describe', 'chrome_cdp_batch']), 'describe tool with required arguments');
  const cdp = assertOk(
    run(task, [
      'call',
      'chrome_cdp_command',
      JSON.stringify({
        method: 'Runtime.evaluate',
        params: { expression: '({ fixture: "P3", values: [0, false] })', returnByValue: true },
      }),
    ]),
    'valid free CDP params',
  );
  assert.deepEqual(cdp.result.result.result.value, { fixture: 'P3', values: [0, false] });
  return { rejectedBeforeDispatch: invalid.length, freeCdpParams: true };
}

async function testLateExecution(start, run, taskA, taskB, fixture, logPath, mode) {
  const tabId = assertOk(run(taskA, ['session']), 'read late-execution target').result.tabId;
  const since = new Date().toISOString();
  const pending = start(taskA, [
    'call',
    'chrome_javascript',
    JSON.stringify({
      code: 'return await window.__lateFailure(' + JSON.stringify(mode) + ')',
      timeoutMs: 15000,
    }),
    '--timeout',
    mode === 'timeout' ? '2000' : '30000',
  ]);
  await fixture.waitForSignal(mode + '-start');
  if (mode === 'disconnect')
    interruptCli(pending, 'disconnect while page Promise is still running');
  const ended = await pending.completion;
  if (mode === 'timeout') {
    assertFailure(ended, 'deadline before page Promise settles');
    assert.equal(ended.response.error?.code, 'TIMEOUT');
    assert.equal(ended.status, 3);
  } else if (process.platform === 'win32') {
    assert.equal(ended.signal, 'SIGINT');
  } else {
    assert.equal(ended.status, 130);
    assert.equal(ended.response?.error?.code, 'CANCELLED');
  }
  assertOk(run(taskA, ['health']), 'task query while abandoned page Promise is pending');
  const queued = start(taskA, ['scan']);
  const otherStarted = Date.now();
  assertOk(run(taskB, ['scan']), 'other target remains available after ' + mode);
  assert(Date.now() - otherStarted < 4000, 'unrelated target waited on abandoned execution');
  const scanned = await queued.completion;
  assertOk(scanned, 'same target resumes after late failure');
  assert(scanned.elapsedMs >= 1000, 'same target lock was released before old execution finished');
  await fixture.waitForSignal(mode + '-end');
  assert.deepEqual(
    jsValue(
      assertOk(
        run(taskA, [
          'eval',
          'return ({ output: document.querySelector("#output").textContent, unhandled: window.__unhandledRejections })',
        ]),
        'late effect',
      ),
    ),
    { output: 'Late failure ' + mode, unhandled: 0 },
  );
  const records = readLogRecords(logPath).filter((record) => record.ts >= since);
  const invocation = records.find(
    (record) =>
      record.event === 'tool.start' &&
      record.tool === 'chrome_javascript' &&
      record.tabId === tabId,
  );
  assert(invocation, 'missing diagnostic evidence of original execution');
  assert(
    records.some(
      (record) =>
        record.event === 'extension.cancelled' &&
        record.nativeRequestId === invocation.nativeRequestId,
    ),
    'transport cancellation was not observed',
  );
  assert(
    !records.some(
      (record) =>
        record.event === 'tool.ok' && record.nativeRequestId === invocation.nativeRequestId,
    ),
    'cancelled invocation committed a late success',
  );
  assert(
    !records.some(
      (record) => record.event === 'process.unhandled_rejection' && record.pid === invocation.pid,
    ),
    'late failure produced an unhandled rejection in the bridge',
  );
  return { mode, sameTargetWaitMs: scanned.elapsedMs, unhandled: 0 };
}

async function testHttpsCopy(run, session, runId, urls, tabIds) {
  const url = 'https://github.com/?aieasybrowser-regression=' + runId;
  urls.push(url);
  const opened = assertOk(run(session, ['open', url, '--background']), 'open isolated HTTPS copy');
  assert(Number.isInteger(opened.result?.tabId), 'HTTPS copy returned no tab ID');
  tabIds.push(opened.result.tabId);
  assertOk(
    run(session, [
      'wait',
      JSON.stringify({
        kind: 'javascript',
        predicate: 'location.origin === "https://github.com" && document.readyState === "complete"',
      }),
      '--timeout',
      '20000',
    ]),
    'wait for real HTTPS document',
  );
  const marker = '__csp_' + runId;
  const code = [
    'const marker = ' + JSON.stringify(marker) + ';',
    'let directive = null;',
    'const onViolation = (event) => { if (event.blockedURI === "inline") directive = event.effectiveDirective; };',
    'document.addEventListener("securitypolicyviolation", onViolation);',
    'const script = document.createElement("script");',
    'try {',
    '  script.textContent = "globalThis." + marker + " = true;";',
    '  document.head.appendChild(script);',
    '  await new Promise((resolve) => setTimeout(resolve, 200));',
    '  return { origin: location.origin, secure: isSecureContext, inlineBlocked: globalThis[marker] !== true, directive };',
    '} finally {',
    '  script.remove(); delete globalThis[marker];',
    '  document.removeEventListener("securitypolicyviolation", onViolation);',
    '}',
  ].join('\n');
  const evidence = jsValue(
    assertOk(run(session, ['eval', code]), 'CDP JavaScript under real HTTPS CSP'),
  );
  assert.deepEqual(
    evidence,
    {
      origin: 'https://github.com',
      secure: true,
      inlineBlocked: true,
      directive: 'script-src-elem',
    },
    'HTTPS page did not demonstrate enforced inline-script CSP',
  );
  assertOk(run(session, ['scan', '--limit', '5', '--text', '2']), 'scan real HTTPS copy');
  return evidence;
}

async function runRegression() {
  const runId = randomUUID().replaceAll('-', '');
  const baseName = 'reg_' + runId.slice(0, 10);
  const taskA = baseName + '_a';
  const taskB = baseName + '_b';
  const preflightSession = baseName + '_preflight';
  const sameTargetSession = taskA + '_same_target';
  const httpsSession = baseName + '_https';
  const sessionNames = [taskA, taskB, preflightSession, sameTargetSession, httpsSession];
  const urls = [];
  const tabIds = [];
  const inFlight = new Set();
  let fixture;
  let commands = 0;
  const run = (session, args, options) => {
    commands += 1;
    return runCli(session, args, options);
  };
  const start = (session, args) => {
    commands += 1;
    const pending = startCli(session, args);
    inFlight.add(pending.completion);
    pending.completion.catch(() => undefined);
    return pending;
  };

  const result = await runWithCleanup(
    async () => {
      const health = assertOk(run(preflightSession, ['health']), 'extension preflight');
      assert(health.result?.extension?.id, 'AIEasyBrowser extension is not connected');
      const doctor = run(preflightSession, ['doctor', '--json']);
      assert.equal(doctor.status, 0, 'doctor prerequisite: ' + doctor.stdout);
      const logs = doctor.response.checks?.find((check) => check.id === 'logs');
      assert.equal(
        logs?.status,
        'ok',
        'diagnostic log must be available for late-failure evidence',
      );
      await testLegacyRoutes();
      fixture = await createFixtureServer(runId);
      for (const tag of ['A', 'B']) {
        urls.push(fixture.origin + '/?run=' + runId + '&tag=' + tag);
      }

      const openedA = assertOk(run(taskA, ['open', urls[0], '--background']), 'open fixture A');
      assert(Number.isInteger(openedA.result?.tabId), 'open A returned no tab ID');
      tabIds.push(openedA.result.tabId);
      const openedB = assertOk(run(taskB, ['open', urls[1], '--background']), 'open fixture B');
      assert(Number.isInteger(openedB.result?.tabId), 'open B returned no tab ID');
      tabIds.push(openedB.result.tabId);
      const navA = run(
        taskA,
        [
          'wait',
          JSON.stringify({ kind: 'url', value: urls[0], match: 'equals' }),
          '--timeout',
          '15000',
        ],
        { timeoutMs: 18_000 },
      );
      if (navA.status !== 0) {
        const listed = run(taskA, ['tabs']);
        const tab = listed.response?.result?.tabs?.find(
          (item) => item.tabId === openedA.result.tabId,
        );
        throw new Error(
          'fixture A navigation did not finish; result=' +
            navA.stdout +
            '; observed=' +
            JSON.stringify(tab) +
            '; fixture origin=' +
            fixture.origin,
        );
      }
      assertOk(
        run(
          taskB,
          [
            'wait',
            JSON.stringify({ kind: 'url', value: urls[1], match: 'equals' }),
            '--timeout',
            '15000',
          ],
          {
            timeoutMs: 18_000,
          },
        ),
        'wait for fixture B navigation',
      );
      const listedTabs = assertOk(run(taskA, ['tabs']), 'list test tabs');
      const matchingTabs = listedTabs.result?.tabs?.filter((tab) => urls.includes(tab.url)) || [];
      assert.equal(
        matchingTabs.length,
        2,
        'only the two fixture URLs should match: ' +
          JSON.stringify({
            openedA: openedA.result,
            openedB: openedB.result,
            listedCount: listedTabs.result?.tabs?.length,
          }),
      );
      assert.deepEqual(
        matchingTabs.map((tab) => tab.url).sort(),
        [...urls].sort(),
        'test labels must isolate the two fixture URLs',
      );

      assertOk(run(taskA, ['use', String(openedA.result.tabId)]), 'select task A tab');
      assertOk(run(taskB, ['use', String(openedB.result.tabId)]), 'select task B tab');
      const firstA = assertOk(run(taskA, ['scan', '--limit', '50', '--text', '20']), 'scan A');
      const firstB = assertOk(run(taskB, ['scan', '--limit', '50', '--text', '20']), 'scan B');
      assert(firstA.result.url.includes('tag=A'), 'task A selected the wrong test label');
      assert(firstB.result.url.includes('tag=B'), 'task B selected the wrong test label');
      const staleAcrossTask = run(taskB, ['click', findRef(pageElements(firstA), 'add')]);
      assert.equal(staleAcrossTask.response.error?.code, 'STALE_REF');
      assert.equal(staleAcrossTask.status, 3);

      const rescannedA = assertOk(run(taskA, ['scan']), 'rescan task A');
      const staleAfterScan = run(taskA, ['click', findRef(pageElements(firstA), 'add')]);
      assert.equal(staleAfterScan.response.error?.code, 'STALE_REF');
      assert.equal(staleAfterScan.status, 3);

      const inputRef = findRef(pageElements(rescannedA), 'entry');
      const buttonRef = findRef(pageElements(rescannedA), 'add');
      const acted = assertOk(
        run(taskA, [
          'act',
          JSON.stringify([
            { op: 'fill', ref: inputRef, value: 'alpha' },
            { op: 'click', ref: buttonRef },
          ]),
          '--expect',
          JSON.stringify({ kind: 'text', text: 'Added: alpha A' }),
        ]),
        'fill, click, assert and rescan',
      );
      assert.equal(acted.result.actionStatus, 'completed');
      assert.equal(acted.result.completed, 2);
      assert.equal(acted.result.page.url, urls[0]);
      const untouchedB = jsValue(
        assertOk(
          run(taskB, [
            'eval',
            'return ({ count: window.__clickCount, value: document.querySelector("#entry").value })',
          ]),
          'verify task B was not changed by task A',
        ),
      );
      assert.deepEqual(untouchedB, { count: 0, value: '' });

      const afterActRef = findRef(pageElements(acted), 'add');
      const failedExpectation = run(taskA, [
        'act',
        JSON.stringify([{ op: 'click', ref: afterActRef }]),
        '--expect',
        JSON.stringify({ kind: 'text', text: 'NEVER-RENDERED' }),
        '--timeout',
        '2000',
      ]);
      const actionFailure = assertFailure(failedExpectation, 'postcondition failure after click');
      assert.equal(actionFailure.phase, 'expect');
      assert.equal(actionFailure.actionStatus, 'completed');
      assert.equal(actionFailure.completed, 1);
      const clickState = assertOk(
        run(taskA, ['eval', 'return window.__clickCount']),
        'verify completed click was not replayed',
      );
      assert.equal(jsValue(clickState), 2, 'postcondition failure must not replay the click');

      const beforeRefresh = jsValue(
        assertOk(
          run(taskA, [
            'eval',
            'return ({ timeOrigin: performance.timeOrigin, readyState: document.readyState })',
          ]),
          'read document before refresh',
        ),
      );
      const refBeforeRefresh = findRef(
        pageElements(assertOk(run(taskA, ['scan']), 'pre-refresh scan')),
        'add',
      );
      const tabA = openedA.result.tabId;
      // Refresh from another task so task A still holds the old document-bound ref.
      assertOk(
        run(taskB, [
          'call',
          'chrome_navigate',
          JSON.stringify({ tabId: tabA, refresh: true, background: true }),
        ]),
        'reload same fixture URL from another task',
      );
      assertOk(
        run(
          taskB,
          [
            'call',
            'chrome_wait_for',
            JSON.stringify({
              tabId: tabA,
              condition: {
                kind: 'javascript',
                predicate:
                  'document.readyState === "complete" && performance.timeOrigin !== ' +
                  beforeRefresh.timeOrigin,
              },
              timeoutMs: 10000,
            }),
            '--timeout',
            '10000',
          ],
          { timeoutMs: 15_000 },
        ),
        'wait for refreshed document',
      );
      const afterRefresh = jsValue(
        assertOk(
          run(taskB, [
            'call',
            'chrome_javascript',
            JSON.stringify({
              tabId: tabA,
              code: 'return ({ timeOrigin: performance.timeOrigin, readyState: document.readyState })',
            }),
          ]),
          'read refreshed document',
        ),
      );
      assert.equal(afterRefresh.readyState, 'complete');
      assert.notEqual(
        afterRefresh.timeOrigin,
        beforeRefresh.timeOrigin,
        'same-URL reload must change timeOrigin',
      );
      const staleAfterRefresh = run(taskA, ['click', refBeforeRefresh]);
      assert.equal(staleAfterRefresh.response.error?.code, 'STALE_DOCUMENT');
      assert.equal(staleAfterRefresh.response.completed, 0);
      assertOk(run(taskA, ['scan']), 'fresh scan after stale document rejection');

      const invalidJson = run(taskA, ['act', '{']);
      const invalidJsonResponse = assertFailure(invalidJson, 'invalid CLI JSON');
      assert.equal(invalidJson.status, 2);
      assert.equal(invalidJsonResponse.error?.code, 'INVALID_ARGUMENT');
      const undeclared = run(taskA, [
        'call',
        'chrome_health',
        JSON.stringify({ undeclared: true }),
      ]);
      assertFailure(undeclared, 'undeclared tool parameter');
      assert.equal(undeclared.status, 2);
      assert.equal(undeclared.response.error?.code, 'INVALID_ARGUMENT');
      const invalidCondition = run(
        taskA,
        ['wait', JSON.stringify({ kind: 'javascript', predicate: '(' }), '--timeout', '5000'],
        { timeoutMs: 9_000 },
      );
      assertFailure(invalidCondition, 'invalid JavaScript condition');
      assert.equal(invalidCondition.response.phase, 'wait');
      const inputContract = testAdvancedInputContract(run, taskA, logs.details.path);

      assertOk(run(taskA, ['open', urls[0], '--current']), 'reload before timeout fixture');
      await testTimeoutContinuation(run, taskA);
      assertOk(run(taskA, ['open', urls[0], '--current']), 'reload before disconnect fixture');
      await testCancellationContinuation(start, run, taskA);
      assertOk(run(taskA, ['open', urls[0], '--current']), 'reload before target-lock fixture');
      await testPendingSession(run, start, taskA, taskB, sameTargetSession);
      const lateExecutions = [];
      lateExecutions.push(
        await testLateExecution(start, run, taskA, taskB, fixture, logs.details.path, 'timeout'),
      );
      lateExecutions.push(
        await testLateExecution(start, run, taskA, taskB, fixture, logs.details.path, 'disconnect'),
      );
      const httpsCsp = await testHttpsCopy(run, httpsSession, runId, urls, tabIds);
      return { runId, inputContract, lateExecutions, httpsCsp };
    },
    async () => {
      const pendingResults = await Promise.allSettled([...inFlight]);
      const cleanupErrors = pendingResults
        .filter((result) => result.status === 'rejected')
        .map((result) => 'CLI child process failed: ' + String(result.reason));
      cleanupErrors.push(...cleanupTargets(run, sessionNames, urls, tabIds));
      if (fixture) {
        try {
          await fixture.close();
        } catch (error) {
          cleanupErrors.push('failed to close fixture server: ' + String(error));
        }
      }
      if (cleanupErrors.length) throw new Error(cleanupErrors.join('\n'));
    },
  );
  return { ...result, commands, createdTabs: tabIds.length };
}

if (require.main === module) {
  runRegression()
    .then((result) => {
      process.stdout.write(JSON.stringify({ ok: true, ...result, cleaned: true }) + '\n');
    })
    .catch((error) => {
      process.stderr.write(
        'CLI regression failed: ' + (error instanceof Error ? error.stack : String(error)) + '\n',
      );
      if (error instanceof AggregateError) {
        for (const cause of error.errors) {
          process.stderr.write(String(cause instanceof Error ? cause.stack : cause) + '\n');
        }
      }
      process.exitCode = 1;
    });
}

module.exports = {
  runCli,
  assertOk,
  assertFailure,
  pageElements,
  findRef,
  jsValue,
  cleanupTargets,
  createFixtureServer,
  interruptCli,
  parseCliRun: responseFromRun,
  runProcess,
  readLogRecords,
  testHttpsCopy,
  testAdvancedInputContract,
  runWithCleanup,
};
