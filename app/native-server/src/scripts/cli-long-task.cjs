'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const {
  runCli,
  assertOk,
  assertFailure,
  pageElements,
  findRef,
  jsValue,
  createFixtureServer,
  cleanupTargets,
  runWithCleanup,
  readLogRecords,
} = require('./cli-regression.cjs');

const BUDGET = ['--limit', '40', '--text', '10'];
const INPUT = {
  first: 'Ada',
  last: 'Lovelace',
  email: 'ada@fixture.test',
  country: 'CN',
  agree: true,
};
const ACTION_TOOLS = new Set([
  'chrome_click_element',
  'chrome_fill_or_select',
  'chrome_keyboard',
  'chrome_computer',
]);

function summarize(rows, records, sessionIds, since) {
  const tools = records.filter(
    (record) =>
      record.ts >= since && record.event === 'tool.start' && sessionIds.includes(record.session),
  );
  const ids = new Set(tools.map((record) => record.nativeRequestId));
  const confirmed = new Set(
    records
      .filter((record) => record.event === 'tool.ok' && ids.has(record.nativeRequestId))
      .map((record) => record.nativeRequestId),
  );
  const roundTrips = records.filter(
    (record) =>
      ids.has(record.nativeRequestId) &&
      ['extension.ok', 'extension.error', 'extension.cancelled', 'extension.timeout'].includes(
        record.event,
      ),
  );
  assert(tools.length > 0 && roundTrips.length > 0, 'missing browser timing evidence');
  assert(
    roundTrips.length === ids.size &&
      new Set(roundTrips.map((record) => record.nativeRequestId)).size === ids.size &&
      roundTrips.every((record) => Number.isFinite(record.durationMs) && record.durationMs >= 0),
    'incomplete or duplicate browser timing evidence',
  );
  const failures = rows
    .filter((row) => !row.ok)
    .map(({ command, code, phase, actionStatus }) => ({ command, code, phase, actionStatus }));
  return {
    agentEquivalentCalls: rows.length,
    browserToolCalls: tools.length,
    dispatchedActions: tools.filter((record) => ACTION_TOOLS.has(record.tool)).length,
    confirmedActions: tools.filter(
      (record) => ACTION_TOOLS.has(record.tool) && confirmed.has(record.nativeRequestId),
    ).length,
    jsonBytes: rows.reduce((sum, row) => sum + row.bytes, 0),
    coldCliWallMs: Math.round(rows.reduce((sum, row) => sum + row.wallMs, 0)),
    browserRoundTripMs: Math.round(roundTrips.reduce((sum, record) => sum + record.durationMs, 0)),
    failures,
    calls: rows,
  };
}

function compare(baseline, batched) {
  for (const key of ['agentEquivalentCalls', 'jsonBytes', 'coldCliWallMs']) {
    assert(baseline[key] > 0 && Number.isFinite(batched[key]), 'invalid comparison metric: ' + key);
  }
  assert.equal(
    baseline.confirmedActions,
    batched.confirmedActions,
    'batch changed the number of confirmed actions',
  );
  return Object.fromEntries(
    ['agentEquivalentCalls', 'jsonBytes', 'coldCliWallMs', 'browserRoundTripMs'].map((key) => [
      key,
      { baseline: baseline[key], batched: batched[key], delta: batched[key] - baseline[key] },
    ]),
  );
}

async function workflow(runId, sample, variant, fixture, logPath) {
  const prefix =
    'long_' + runId.slice(0, 8) + '_' + sample + '_' + (variant === 'baseline' ? '0' : '1');
  const taskA = prefix + '_a';
  const taskB = prefix + '_b';
  const driver = prefix + '_driver';
  const names = [taskA, taskB, driver];
  const key = prefix;
  const urls = ['A', 'B'].map((tag) => fixture.origin + '/long?record=' + key + '&tag=' + tag);
  const tabs = [];
  const rows = [];
  const run = (task, args, measured = false) => {
    const started = performance.now();
    const result = runCli(task, args);
    if (measured)
      rows.push({
        command: args[0],
        wallMs: Math.round(performance.now() - started),
        bytes: Buffer.byteLength(result.stdout),
        ok: result.response.ok,
        code: result.response.error?.code,
        phase: result.response.phase,
        actionStatus: result.response.actionStatus,
      });
    return result;
  };
  const ok = (task, args, measured = true) =>
    assertOk(run(task, args, measured), task + ' ' + args[0]);
  const observe = (task, code, measured = true) => jsValue(ok(task, ['eval', code], measured));
  let ready = false;
  return runWithCleanup(
    async () => {
      for (const [index, task] of [taskA, taskB].entries()) {
        const opened = ok(task, ['open', urls[index], '--background'], false);
        tabs.push(opened.result.tabId);
        ok(
          task,
          [
            'wait',
            JSON.stringify({
              kind: 'javascript',
              predicate:
                'document.readyState === "complete" && typeof window.__snapshot === "function"',
            }),
          ],
          false,
        );
      }
      ready = true;
      ok(driver, ['use', String(tabs[0])], false);
      const sessionIds = names.map(
        (name) => ok(name, ['session'], false).result.snapshot.split('.')[0],
      );
      const since = new Date().toISOString();
      const started = performance.now();
      let scanned = ok(taskA, ['scan', ...BUDGET]);
      assert.equal(scanned.result.truncated, true, 'budget truncation was hidden');
      assert.equal(scanned.result.errors.length, 0);
      if (variant === 'baseline') {
        for (const [id, value] of Object.entries(INPUT)) {
          const args = [
            'fill',
            findRef(pageElements(scanned), id),
            typeof value === 'string' ? value : JSON.stringify(value),
          ];
          if (typeof value !== 'string') args.push('--json-value');
          scanned = ok(taskA, args);
        }
        scanned = ok(taskA, [
          'click',
          findRef(pageElements(scanned), 'submit'),
          '--expect',
          JSON.stringify({ kind: 'text', text: 'Complete' }),
        ]);
      } else {
        const elements = pageElements(scanned);
        const actions = Object.entries(INPUT).map(([id, value]) => ({
          op: 'fill',
          ref: findRef(elements, id),
          value,
        }));
        actions.push({ op: 'click', ref: findRef(elements, 'submit') });
        scanned = ok(taskA, [
          'act',
          JSON.stringify(actions),
          '--expect',
          JSON.stringify({ kind: 'text', text: 'Complete' }),
        ]);
        assert.equal(scanned.result.completed, 6);
      }
      const oldRef = findRef(pageElements(scanned), 'submit');
      ok(taskB, ['wait', JSON.stringify({ kind: 'text', text: 'Saved: Ada Lovelace' })]);
      assert.deepEqual(observe(taskB, 'return window.__snapshot().record'), INPUT);
      const before = observe(driver, 'return performance.timeOrigin');
      ok(driver, [
        'call',
        'chrome_navigate',
        JSON.stringify({ tabId: tabs[0], refresh: true, background: true }),
      ]);
      ok(driver, [
        'call',
        'chrome_wait_for',
        JSON.stringify({
          tabId: tabs[0],
          condition: {
            kind: 'javascript',
            predicate: 'document.readyState === "complete" && performance.timeOrigin !== ' + before,
          },
        }),
      ]);
      const stale = assertFailure(run(taskA, ['click', oldRef], true), 'old document ref');
      assert.equal(stale.error.code, 'STALE_DOCUMENT');
      assert.equal(stale.completed, 0);
      scanned = ok(taskA, ['scan', ...BUDGET]);
      const failed = assertFailure(
        run(
          taskA,
          [
            'click',
            findRef(pageElements(scanned), 'fail-once'),
            '--expect',
            JSON.stringify({ kind: 'text', text: 'Never appears' }),
            '--timeout',
            '700',
          ],
          true,
        ),
        'failed check after completed action',
      );
      assert.equal(failed.actionStatus, 'completed');
      assert.equal(failed.phase, 'expect');
      assert.equal(failed.completed, 1);
      const final = observe(taskA, 'return window.__snapshot()');
      assert.equal(final.clicks, 1, 'failed check replayed the action');
      assert.deepEqual(final.record, INPUT);
      const metrics = summarize(rows, readLogRecords(logPath), sessionIds, since);
      return { sample, variant, taskWallMs: Math.round(performance.now() - started), ...metrics };
    },
    async () => {
      const errors = [];
      if (ready)
        for (const task of [taskA, taskB]) {
          try {
            assert.equal(
              observe(task, 'return window.__cleanup()', false),
              true,
              'fixture storage remains',
            );
          } catch (error) {
            errors.push(String(error));
          }
        }
      errors.push(...cleanupTargets((task, args) => run(task, args), names, urls, tabs));
      if (errors.length) throw new Error(errors.join('\n'));
    },
  );
}

async function auditGuards(runId, fixture) {
  const names = ['guard_' + runId.slice(0, 8), 'guard_' + runId.slice(0, 8) + '_driver'];
  const url = fixture.origin + '/long?record=' + names[0] + '&tag=A';
  const tabs = [];
  const ok = (task, args) => assertOk(runCli(task, args), args[0]);
  return runWithCleanup(
    async () => {
      tabs.push(ok(names[0], ['open', url, '--background']).result.tabId);
      ok(names[0], [
        'wait',
        JSON.stringify({
          kind: 'javascript',
          predicate: 'typeof window.__snapshot === "function"',
        }),
      ]);
      ok(names[1], ['use', String(tabs[0])]);
      const observations = {};
      for (const [name, id] of [
        ['detached', 'replace-target'],
        ['disabled', 'disabled-target'],
        ['covered', 'covered-target'],
      ]) {
        const scanned = ok(names[0], ['scan', ...BUDGET]);
        const ref = findRef(pageElements(scanned), id);
        if (name === 'detached') ok(names[1], ['eval', 'window.__replaceTarget(); return true']);
        const result = runCli(names[0], ['click', ref, '--no-scan']);
        assertFailure(result, 'non-actionable ' + name);
        assert.equal(
          result.response.error.code,
          name === 'detached' ? 'STALE_REF' : 'NOT_INTERACTABLE',
        );
        assert.equal(result.response.actionStatus, 'not_started');
        assert.equal(result.response.completed, 0);
        observations[name] = {
          status: result.status,
          response: result.response,
          state: jsValue(ok(names[1], ['eval', 'return window.__snapshot()'])),
        };
        assert.equal(
          observations[name].state.effects[name],
          0,
          'rejected target received an event',
        );
      }
      const fill = runCli(names[0], [
        'call',
        'chrome_fill_or_select',
        JSON.stringify({ selector: '#disabled-field', value: 'changed' }),
      ]);
      assertFailure(fill, 'disabled input');
      assert.equal(fill.response.error.code, 'NOT_INTERACTABLE');
      observations.disabledFill = {
        status: fill.status,
        response: fill.response,
        state: jsValue(ok(names[1], ['eval', 'return window.__snapshot()'])),
      };
      assert.equal(observations.disabledFill.state.disabledValue, 'unchanged');
      const missing = runCli(names[0], [
        'call',
        'chrome_click_element',
        JSON.stringify({ selector: '#missing' }),
      ]);
      observations.missing = { status: missing.status, response: missing.response };
      assertFailure(missing, 'missing selector');
      const ambiguous = runCli(names[0], [
        'call',
        'chrome_click_element',
        JSON.stringify({ selector: '.duplicate' }),
      ]);
      assertFailure(ambiguous, 'ambiguous selector');
      assert.equal(ambiguous.response.error.code, 'NOT_INTERACTABLE');
      const scanned = ok(names[0], ['scan', ...BUDGET]);
      ok(names[0], ['click', findRef(pageElements(scanned), 'duplicate-b'), '--no-scan']);
      const state = jsValue(ok(names[1], ['eval', 'return window.__snapshot()']));
      assert.equal(state.effects.duplicateA, 0);
      assert.equal(state.effects.duplicateB, 1);
      observations.duplicate = { selectedB: true, untouchedA: true };
      return observations;
    },
    async () => {
      const errors = cleanupTargets(runCli, names, [url], tabs);
      if (errors.length) throw new Error(errors.join('\n'));
    },
  );
}

function pngDimensions(base64) {
  const bytes = Buffer.from(base64, 'base64');
  assert(
    bytes.length >= 24 &&
      bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    'invalid PNG screenshot',
  );
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function frameInputOutcome(attributes, events) {
  const count = Number(attributes['data-count']);
  assert(count === 0 || count === 1, 'frame received duplicate or invalid input');
  assert.equal(attributes['data-trusted'], count === 1 ? 'true' : 'false');
  if (count === 0) {
    assert(
      events.some((event) => event.target === 'cross' && event.trusted),
      'frame input failed without container hit evidence',
    );
  }
  return { status: count === 1 ? 'delivered' : 'container_only', count, trusted: count === 1 };
}

async function auditGeometry(runId, fixture) {
  const name = 'geom_' + runId.slice(0, 8);
  const url = fixture.origin + '/long?record=' + name + '&mode=geometry';
  const tabs = [];
  const ok = (args) => assertOk(runCli(name, args), 'geometry ' + args[0]);
  const evaluate = (code) => jsValue(ok(['eval', code]));
  const call = (tool, args) => ok(['call', tool, JSON.stringify(args)]);
  const point = () =>
    evaluate(
      'const r = document.querySelector("#point").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }',
    );
  const click = (coordinates) =>
    call('chrome_computer', { action: 'left_click', coordinates, background: true });
  const frameTarget = (frameId) => {
    const result = call('chrome_query_elements', { frameId, selector: '#frame-target' }).result;
    assert.deepEqual(result.errors, [], 'frame query hid an error');
    assert.equal(result.elements.length, 1);
    assert.equal(result.elements[0].frameId, frameId);
    return result.elements[0];
  };
  return runWithCleanup(
    async () => {
      tabs.push(ok(['open', url, '--background']).result.tabId);
      ok([
        'wait',
        JSON.stringify({
          kind: 'javascript',
          predicate:
            'document.readyState === "complete" && typeof window.__snapshot === "function"',
        }),
      ]);
      const viewport = evaluate(
        'window.scrollTo(0, 500); return { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scrollY }',
      );
      assert.equal(viewport.scrollY, 500);
      const image = call('chrome_cdp_command', {
        method: 'Page.captureScreenshot',
        params: { format: 'png' },
        sanitizeOutput: false,
        maxOutputBytes: 500000,
      });
      const pixels = pngDimensions(image.result.result.data);
      assert(
        Math.abs(pixels.width - viewport.width * viewport.dpr) <= 1,
        'PNG width is not viewport times DPR',
      );
      assert(
        Math.abs(pixels.height - viewport.height * viewport.dpr) <= 1,
        'PNG height is not viewport times DPR',
      );
      // A full-page capture used to silently change later coordinate units.
      // Keep the capture in memory only; no download or file is created.
      call('chrome_screenshot', {
        name: 'long-task-geometry',
        fullPage: true,
        storeBase64: false,
        savePng: false,
        background: true,
      });
      const original = point();
      if (viewport.dpr !== 1) {
        click({ x: original.x * viewport.dpr, y: original.y * viewport.dpr });
        assert.equal(
          evaluate('return window.__effects.point'),
          0,
          'pixel-space negative sample unexpectedly hit target',
        );
      }
      const cssClick = click(point());
      const firstState = evaluate('return window.__effects');
      assert.equal(
        firstState.point,
        1,
        'CSS click failed: ' + JSON.stringify({ viewport, original, cssClick, firstState }),
      );
      evaluate('document.querySelector("#point").style.left = "500px"; return true');
      click(original);
      assert.equal(
        evaluate('return window.__effects.point'),
        1,
        'old coordinate unexpectedly hit moved target',
      );
      click(point());
      assert.deepEqual(
        evaluate('return { count: window.__effects.point, trusted: window.__effects.trusted }'),
        { count: 2, trusted: true },
      );
      assert.equal(
        evaluate(
          'try { document.querySelector("#cross").contentWindow.document.body; return false; } catch { return true; }',
        ),
        true,
        'iframe is not cross-origin',
      );
      const frameList = call('chrome_list_frames', {});
      const frames = frameList.result.frames;
      assert(Array.isArray(frames), 'frame listing returned no frames');
      const child = frames.find(
        (frame) => frame.frameId !== 0 && frame.url.includes('/long-frame'),
      );
      assert(child, 'cross-origin frame missing');
      const scanned = ok(['scan', '--frame', String(child.frameId), ...BUDGET]);
      ok(['click', findRef(pageElements(scanned), 'frame-target'), '--no-scan']);
      assert.equal(
        frameTarget(child.frameId).attributes['data-count'],
        '0',
        'synthetic click passed trusted-only frame control',
      );
      // Observe with this disposable tab active. A container hit must not be
      // reported as successful delivery to the child control.
      ok(['use', String(tabs[0]), '--focus']);
      const inner = frameTarget(child.frameId).center;
      const outer = evaluate(
        'const r = document.querySelector("#cross").getBoundingClientRect(); return { x: r.x, y: r.y }',
      );
      const frameClick = click({ x: outer.x + inner.x, y: outer.y + inner.y });
      const finalFrame = frameTarget(child.frameId).attributes;
      const frameInput = frameInputOutcome(
        finalFrame,
        evaluate('return window.__coordinateEvents'),
      );
      const invalidFrame = runCli(name, ['scan', '--frame', '999999']);
      assertFailure(invalidFrame, 'absent frame');
      return {
        viewport,
        pixels,
        cssClicks: 2,
        trusted: true,
        layoutShiftReMeasured: true,
        fullPageCaptureDidNotScaleInput: true,
        crossOrigin: true,
        syntheticFrameCount: 0,
        trustedFrameCount: frameInput.count,
        trustedFramePassed: frameInput.trusted,
        frameInputStatus: frameInput.status,
        frameClick: { inner, outer, result: frameClick.result },
        frameInputFocused: true,
        frameReadTool: 'chrome_query_elements',
        absentFrameRejected: true,
      };
    },
    async () => {
      const errors = cleanupTargets(runCli, [name], [url], tabs);
      if (errors.length) throw new Error(errors.join('\n'));
    },
  );
}

async function runLongTask(samples = 3) {
  assert(
    Number.isInteger(samples) && samples >= 1 && samples <= 10,
    'samples must be an integer in 1..10',
  );
  const runId = randomUUID().replaceAll('-', '');
  const preflight = 'long_' + runId.slice(0, 8) + '_preflight';
  const results = [];
  let fixture;
  return runWithCleanup(
    async () => {
      const doctor = runCli(preflight, ['doctor', '--json']);
      assert.equal(doctor.status, 0, doctor.stdout);
      const logPath = doctor.response.checks.find((check) => check.id === 'logs').details.path;
      assertOk(runCli(preflight, ['health']), 'browser preflight');
      fixture = await createFixtureServer(runId);
      for (let sample = 0; sample < samples; sample++) {
        const order = sample % 2 ? ['batched', 'baseline'] : ['baseline', 'batched'];
        const pair = {};
        for (const variant of order)
          pair[variant] = await workflow(runId, sample, variant, fixture, logPath);
        results.push({
          sample,
          baseline: pair.baseline,
          batched: pair.batched,
          comparison: compare(pair.baseline, pair.batched),
        });
      }
      const guards = await auditGuards(runId, fixture);
      const geometry = await auditGeometry(runId, fixture);
      return {
        ok: true,
        runId,
        samples,
        budget: { elements: 40, text: 10 },
        results,
        guards,
        geometry,
        limitations: geometry.trustedFramePassed ? [] : ['cross_frame_trusted_not_delivered'],
        cleaned: true,
      };
    },
    async () => {
      const errors = cleanupTargets(runCli, [preflight], []);
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
  runLongTask(process.argv[2] === undefined ? 3 : Number(process.argv[2]))
    .then((result) => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch((error) => {
      process.stderr.write(String(error.stack || error) + '\n');
      if (error instanceof AggregateError)
        for (const cause of error.errors) process.stderr.write(String(cause.stack || cause) + '\n');
      process.exitCode = 1;
    });

module.exports = {
  summarize,
  compare,
  pngDimensions,
  frameInputOutcome,
  runLongTask,
  auditGeometry,
};
