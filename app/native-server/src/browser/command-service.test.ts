import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { NativeMessagingHost } from '../native-messaging-host';
import { BrowserCommandService } from './command-service';
import { BrowserCommandError } from './protocol';
import { setLogDirForTests } from '../util/diag-log';

let logDir: string;

beforeEach(() => {
  logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aieasybrowser-command-log-'));
  setLogDirForTests(logDir);
});

afterEach(() => {
  setLogDirForTests(undefined);
  expect(path.dirname(path.resolve(logDir))).toBe(path.resolve(os.tmpdir()));
  expect(path.basename(logDir)).toMatch(/^aieasybrowser-command-log-/);
  fs.rmSync(logDir, { recursive: true, force: true });
});

function readLogRecords(): Array<Record<string, any>> {
  const target = path.join(logDir, 'native-server.log');
  if (!fs.existsSync(target)) return [];
  return fs
    .readFileSync(target, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const success = (payload: unknown) => ({
  status: 'success',
  data: { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload },
});
const failure = (message: string) => ({
  status: 'success',
  data: { isError: true, content: [{ type: 'text', text: message }] },
});
function scanFixture(tabId = 7, documentId = `doc-${tabId}`, frameId = 0) {
  return {
    success: true,
    tabId,
    title: 'Fixture',
    url: `https://fixture.test/${tabId}`,
    frames: [
      {
        frameId,
        documentId,
        url: `https://fixture.test/${tabId}`,
        readyState: 'complete',
        elements: [
          {
            ref: 'ref_1',
            kind: 'input:text',
            role: 'textbox',
            text: 'Search',
            attrs: { id: 'search', placeholder: 'Find', hasValue: false },
            enabled: true,
            selector: '#search',
            rect: { x: 10, y: 10, width: 100, height: 20 },
          },
        ],
        textBlocks: [{ tag: 'h1', text: 'Page fixture' }],
        truncated: {},
      },
    ],
    errors: [],
  };
}

let service: BrowserCommandService;
let send: jest.Mock<NativeMessagingHost['sendRequestToExtensionAndWait']>;
let defaultReply: (payload: any) => Promise<any>;
const run = (command: Record<string, unknown>, signal = new AbortController().signal) =>
  service.execute({ session: 'task', ...command }, signal);

beforeEach(() => {
  defaultReply = async ({ name, args }) => {
    if (name === 'get_windows_and_tabs')
      return success({
        windows: [
          {
            id: 1,
            tabs: [7, 8].map((id) => ({
              id,
              url: `https://fixture.test/${id}`,
              title: `Tab ${id}`,
              active: id === 7,
            })),
          },
        ],
      });
    if (name === 'chrome_scan_compact') return success(scanFixture(args.tabId));
    if (name === 'chrome_health') return success({ schema: { toolCount: 39 } });
    if (name === 'chrome_navigate')
      return success({ success: true, tabId: args.tabId ?? 20, url: args.url });
    if (name === 'chrome_javascript') return success({ ok: true, output: 'evaluated' });
    return success({ success: true, passed: true });
  };
  send = jest.fn(defaultReply);
  service = new BrowserCommandService(
    () => ({ sendRequestToExtensionAndWait: send }) as unknown as NativeMessagingHost,
  );
});

async function selectedScan(session = 'task') {
  expect((await run({ command: 'use', tabId: 7, session })).ok).toBe(true);
  const scanned = await run({ command: 'scan', session });
  expect(scanned.ok).toBe(true);
  return (scanned.result as any).elements[0].ref as string;
}

describe('named CLI browser workflows', () => {
  test('keeps the selected tab across commands without switching browser focus', async () => {
    await run({ command: 'use', tabId: 8 });
    const page = await run({ command: 'scan' });
    expect((page.result as any).tabId).toBe(8);
    expect(send.mock.calls.map(([payload]) => payload.name)).toEqual([
      'get_windows_and_tabs',
      'chrome_scan_compact',
    ]);
    expect(send.mock.calls[1][0]).toMatchObject({
      args: { tabId: 8 },
      context: { transport: 'cli', sessionId: expect.stringMatching(/^cli:/) },
    });
  });

  test('runs fill, explicit assertion and new scan in order, with a fresh handle', async () => {
    const ref = await selectedScan();
    send.mockClear();
    const acted = await run({
      command: 'act',
      actions: [{ op: 'fill', ref, value: 'hello' }],
      expect: { kind: 'element', selector: '#search', state: 'visible' },
    });
    expect(acted.ok).toBe(true);
    expect(send.mock.calls.map(([payload]) => payload.name)).toEqual([
      'chrome_fill_or_select',
      'chrome_assert',
      'chrome_scan_compact',
    ]);
    expect(send.mock.calls[0][0]).toMatchObject({
      args: { tabId: 7, frameId: 0, ref: 'ref_1', value: 'hello' },
      context: { documentId: 'doc-7' },
    });
    expect((acted.result as any).page.elements[0].ref).not.toBe(ref);
    const expired = await run({ command: 'act', actions: [{ op: 'click', ref }] });
    expect(expired).toMatchObject({
      ok: false,
      error: { code: 'STALE_REF' },
      actionStatus: 'not_started',
      completed: 0,
    });
    expect(send).toHaveBeenCalledTimes(3);
  });

  test('preserves boolean false and resolves duplicate raw refs to their own frames', async () => {
    await run({ command: 'use', tabId: 7 });
    send.mockImplementation(async (payload) =>
      payload.name === 'chrome_scan_compact'
        ? success({
            ...scanFixture(),
            frames: [...scanFixture().frames, ...scanFixture(7, 'iframe-doc', 5).frames],
          })
        : defaultReply(payload),
    );
    const scanned = await run({ command: 'scan' });
    const ref = (scanned.result as any).elements[1].ref;
    const acted = await run({
      command: 'act',
      actions: [
        { op: 'fill', ref, value: false },
        { op: 'press', keys: 'Enter', frameId: 5 },
      ],
      scan: false,
    });
    expect(acted).toMatchObject({ ok: true, result: { completed: 2 } });
    expect(
      send.mock.calls.find(([payload]) => payload.name === 'chrome_fill_or_select')?.[0],
    ).toMatchObject({
      args: { frameId: 5, value: false },
      context: { documentId: 'iframe-doc' },
    });
    expect(
      send.mock.calls.find(([payload]) => payload.name === 'chrome_keyboard')?.[0],
    ).toMatchObject({ args: { frameId: 5, keys: 'Enter' }, context: { documentId: 'iframe-doc' } });
    expect((await run({ command: 'session' })).result).toMatchObject({ refs: 0 });
  });

  test('rejects foreign-session handles and validates the entire batch before dispatch', async () => {
    const ref = await selectedScan('A');
    await selectedScan('B');
    send.mockClear();
    expect(
      await run({ command: 'act', session: 'B', actions: [{ op: 'click', ref }] }),
    ).toMatchObject({ error: { code: 'STALE_REF' } });
    expect(
      await run({
        command: 'act',
        session: 'A',
        actions: [
          { op: 'fill', ref, value: 'first' },
          { op: 'click', ref: 'unknown' },
        ],
      }),
    ).toMatchObject({ actionStatus: 'not_started', completed: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  test.each([
    { command: 'scan', limit: 0 },
    { command: 'scan', frameId: -1 },
    { command: 'act', actions: [{ op: 'fill', ref: 'r', value: null }] },
    { command: 'act', actions: [{ op: 'click', ref: 'r', selector: '#bad' }] },
    { command: 'act', actions: [] },
    {
      command: 'act',
      actions: [{ op: 'click', ref: 'r' }],
      expect: { kind: 'url', match: 'changed' },
    },
    { command: 'wait', condition: { kind: 'text', text: 'x', unknown: true } },
    { command: 'call', tool: 'chrome_health', args: [] },
    { command: 'health', session: '../bad' },
    { command: 'health', unexpected: 1 },
    { command: 'unknown' },
  ])('rejects invalid command input before browser IO: %j', async (command) => {
    expect(await run(command)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENT' },
      actionStatus: 'not_started',
    });
    expect(send).not.toHaveBeenCalled();
  });

  test('requires explicit targets and does not select an active tab after a closed-target failure', async () => {
    expect(await run({ command: 'scan' })).toMatchObject({ error: { code: 'NO_TARGET' } });
    expect(await run({ command: 'eval', code: 'return 1' })).toMatchObject({
      error: { code: 'NO_TARGET' },
      actionStatus: 'not_started',
    });
    expect(await run({ command: 'use', tabId: 999 })).toMatchObject({
      error: { code: 'TARGET_CLOSED' },
    });
    expect((await run({ command: 'session' })).result).not.toHaveProperty('tabId', 999);
  });

  test('recognizes document preflight rejection as not started, even at the same URL', async () => {
    const ref = await selectedScan();
    send.mockResolvedValueOnce({ status: 'error', error: 'STALE_DOCUMENT: the page refreshed' });
    const failed = await run({ command: 'act', actions: [{ op: 'click', ref }] });
    expect(failed).toMatchObject({
      error: { code: 'STALE_DOCUMENT' },
      phase: 'action',
      actionStatus: 'not_started',
      completed: 0,
    });
  });

  test('reports completed actions when a later assertion fails, without retrying', async () => {
    const ref = await selectedScan();
    send.mockImplementation(async (payload) =>
      payload.name === 'chrome_assert'
        ? failure('assert failed: missing text')
        : defaultReply(payload),
    );
    const failed = await run({
      command: 'act',
      actions: [{ op: 'fill', ref, value: 'changed' }],
      expect: { kind: 'text', text: 'missing' },
    });
    expect(failed).toMatchObject({
      ok: false,
      phase: 'expect',
      actionStatus: 'completed',
      completed: 1,
    });
    expect(
      send.mock.calls.filter(([payload]) => payload.name === 'chrome_fill_or_select'),
    ).toHaveLength(1);
  });

  test('reports an unknown second action and a completed first action', async () => {
    const ref = await selectedScan();
    send.mockImplementation(async (payload) =>
      payload.name === 'chrome_click_element'
        ? failure('Page connection lost')
        : defaultReply(payload),
    );
    const failed = await run({
      command: 'act',
      actions: [
        { op: 'fill', ref, value: 'first' },
        { op: 'click', ref },
      ],
    });
    expect(failed).toMatchObject({
      phase: 'action',
      actionStatus: 'unknown',
      completed: 1,
      failedAction: 1,
    });
  });

  test('reports completed actions when the final scan fails and leaves no usable partial scan', async () => {
    const ref = await selectedScan();
    send.mockImplementation(async (payload) =>
      payload.name === 'chrome_scan_compact'
        ? success({
            ...scanFixture(),
            frames: [...scanFixture().frames, { frameId: 9, elements: [] }],
          })
        : defaultReply(payload),
    );
    expect(
      await run({ command: 'act', actions: [{ op: 'fill', ref, value: 'done' }] }),
    ).toMatchObject({
      phase: 'scan',
      actionStatus: 'completed',
      completed: 1,
      error: { code: 'INVALID_SCAN' },
    });
    expect(await run({ command: 'act', actions: [{ op: 'press', keys: 'Enter' }] })).toMatchObject({
      error: { code: 'STALE_REF' },
    });
    expect((await run({ command: 'session' })).result).toMatchObject({ refs: 0 });
  });

  test('enforces global element/text/frame/error budgets across many frames', async () => {
    await run({ command: 'use', tabId: 7 });
    send.mockResolvedValueOnce(
      success({
        ...scanFixture(),
        frames: Array.from({ length: 30 }, (_, id) => scanFixture(7, `doc-${id}`, id).frames[0]),
        errors: Array(20).fill('frame error'),
      }),
    );
    const result = (await run({ command: 'scan', limit: 2, text: 1 })).result as any;
    expect(result.elements).toHaveLength(2);
    expect(result.text).toHaveLength(1);
    expect(result.frames).toHaveLength(20);
    expect(result.errors).toHaveLength(10);
    expect(result.truncated).toBe(true);
    expect(result.elements[0]).not.toHaveProperty('selector');
    expect(result.elements[0]).not.toHaveProperty('rect');
  });

  test('releases busy sessions on cancellation and ignores a late scan reply', async () => {
    await run({ command: 'use', tabId: 7 });
    const slow = deferred<any>();
    send.mockReturnValueOnce(slow.promise);
    const controller = new AbortController();
    const pending = run({ command: 'scan' }, controller.signal);
    expect(await run({ command: 'health' })).toMatchObject({ error: { code: 'SESSION_BUSY' } });
    expect((await run({ command: 'session', mode: 'list' })).result).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'task', busy: true })]),
    );
    expect((await run({ command: 'health', session: 'other' })).ok).toBe(true);
    controller.abort(new BrowserCommandError('CANCELLED', 'cancelled fixture'));
    expect(await pending).toMatchObject({ error: { code: 'CANCELLED' } });
    await run({ command: 'use', tabId: 8 });
    const latest = await run({ command: 'scan' });
    slow.resolve(success(scanFixture(7)));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const state = (await run({ command: 'session' })).result as any;
    expect(state.tabId).toBe(8);
    expect(state.snapshot).toBe((latest.result as any).snapshot);
    expect(state.refs).toBe(1);
  });

  test('rejects old handles after forgetting a session or restarting the bridge', async () => {
    const ref = await selectedScan();
    await run({ command: 'session', mode: 'forget' });
    const next = await selectedScan();
    expect(next).not.toBe(ref);
    expect(await run({ command: 'act', actions: [{ op: 'click', ref }] })).toMatchObject({
      error: { code: 'STALE_REF' },
    });
    service = new BrowserCommandService(
      () => ({ sendRequestToExtensionAndWait: send }) as unknown as NativeMessagingHost,
    );
    await selectedScan();
    expect(await run({ command: 'act', actions: [{ op: 'click', ref: next }] })).toMatchObject({
      error: { code: 'STALE_REF' },
    });
  });

  test('supports open/current, wait, eval and explicit focus without MCP handshakes', async () => {
    expect(
      (await run({ command: 'open', url: 'https://fixture.test/new', background: true })).result,
    ).toMatchObject({ tabId: 20 });
    expect(send.mock.calls[0][0].args.tabId).toBeUndefined();
    await run({ command: 'open', url: 'https://fixture.test/current', current: true });
    expect(send.mock.calls[1][0].args.tabId).toBe(20);
    await run({ command: 'wait', condition: { kind: 'javascript', predicate: 'true' } });
    expect((await run({ command: 'eval', code: 'return 1' })).result).toMatchObject({
      output: 'evaluated',
    });
    await run({ command: 'use', tabId: 8, focus: true });
    expect(send.mock.calls.at(-1)?.[0]).toMatchObject({
      name: 'chrome_switch_tab',
      args: { tabId: 8 },
    });
  });

  test('discovers one schema on demand and rejects undeclared advanced arguments', async () => {
    expect((await run({ command: 'tools', query: 'clipboard' })).result).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'chrome_clipboard' })]),
    );
    expect((await run({ command: 'describe', tool: 'chrome_clipboard' })).result).toHaveProperty(
      'inputSchema',
    );
    expect(send).not.toHaveBeenCalled();
    expect(
      await run({
        command: 'call',
        tool: 'chrome_network_capture',
        args: { action: 'start', tabId: 7 },
      }),
    ).toMatchObject({ error: { code: 'INVALID_ARGUMENT' } });
    expect(await run({ command: 'describe', tool: 'unknown' })).toMatchObject({
      error: { code: 'INVALID_ARGUMENT' },
    });
    await run({ command: 'use', tabId: 7 });
    await run({ command: 'call', tool: 'chrome_get_element_html', args: { selector: '#search' } });
    expect(send.mock.calls.at(-1)?.[0]).toMatchObject({ args: { tabId: 7, selector: '#search' } });
    await run({ command: 'call', tool: 'chrome_close_tabs' });
    expect(send.mock.calls.at(-1)?.[0].args).toEqual({ tabIds: [7] });
  });

  test('bounds session state, lists targets, and frees capacity explicitly', async () => {
    for (let index = 0; index < 64; index++)
      await run({ command: 'session', session: `s${index}` });
    expect(await run({ command: 'session', session: 'overflow' })).toMatchObject({
      error: { code: 'SESSION_LIMIT' },
    });
    expect((await run({ command: 'session', session: 's0', mode: 'list' })).result).toHaveProperty(
      'length',
      64,
    );
    expect((await run({ command: 'session', mode: 'list' })).result).toHaveProperty('length', 64);
    expect((await run({ command: 'session', session: 'unknown', mode: 'forget' })).ok).toBe(true);
    await run({ command: 'session', session: 's0', mode: 'forget' });
    expect((await run({ command: 'session', session: 'overflow' })).ok).toBe(true);
  });

  test('preserves image attachments from explicitly requested advanced tools', async () => {
    await run({ command: 'use', tabId: 7 });
    send.mockResolvedValueOnce({
      status: 'success',
      data: {
        structuredContent: { success: true, width: 2, height: 2 },
        content: [{ type: 'image', mimeType: 'image/png', data: 'fixture-base64' }],
      },
    });
    expect(
      (await run({ command: 'call', tool: 'chrome_computer', args: { action: 'screenshot' } }))
        .result,
    ).toEqual({
      data: { success: true, width: 2, height: 2 },
      attachments: [{ type: 'image', mimeType: 'image/png', data: 'fixture-base64' }],
    });
  });

  test('does not invent a required tab for target-independent advanced operations', async () => {
    expect(
      (
        await run({
          command: 'call',
          tool: 'chrome_clipboard',
          args: { action: 'read_text' },
        })
      ).ok,
    ).toBe(true);
    expect(send.mock.calls[0][0].args).toEqual({ action: 'read_text' });
    expect(await run({ command: 'call', tool: 'chrome_close_tabs' })).toMatchObject({
      error: { code: 'NO_TARGET' },
      actionStatus: 'not_started',
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('reports bridge unavailability and already-cancelled commands before dispatch', async () => {
    service = new BrowserCommandService(() => null);
    expect(await run({ command: 'health' })).toMatchObject({
      error: { code: 'BRIDGE_UNAVAILABLE' },
    });
    const controller = new AbortController();
    controller.abort(new BrowserCommandError('CANCELLED', 'already cancelled'));
    expect(await run({ command: 'health' }, controller.signal)).toMatchObject({
      error: { code: 'CANCELLED' },
      actionStatus: 'not_started',
    });
    expect(await run({ command: 'session', mode: 'list' }, controller.signal)).toMatchObject({
      error: { code: 'CANCELLED' },
      actionStatus: 'not_started',
    });
    expect(send).not.toHaveBeenCalled();
  });

  test('records command and tool lifecycle with matching correlation ids', async () => {
    await selectedScan();
    const records = readLogRecords();
    const events = records.map((record) => record.event);

    expect(events).toContain('command.done');
    expect(events).toContain('tool.start');
    expect(events).toContain('tool.ok');

    // One CLI command fans out to several tool calls; all of them must name the tool
    // that actually ran so a failure can be tied to a phase.
    const scans = records.filter(
      (record) => record.event === 'command.done' && record.tool === 'scan',
    );
    expect(scans.length).toBeGreaterThan(0);
    for (const done of scans) {
      expect(typeof done.session).toBe('string');
      expect(typeof done.durationMs).toBe('number');
    }

    const toolStarts = records.filter((record) => record.event === 'tool.start');
    expect(toolStarts.length).toBeGreaterThan(0);
    for (const start of toolStarts) {
      expect(typeof start.tool).toBe('string');
      expect(typeof start.nativeRequestId).toBe('string');
    }
  });

  test('records an argument rejection without dispatching to the extension', async () => {
    const response = await run({ command: 'scan', limit: 999 });
    expect(response).toMatchObject({ error: { code: 'INVALID_ARGUMENT' } });
    expect(send).not.toHaveBeenCalled();

    const rejected = readLogRecords().find((record) => record.event === 'command.rejected');
    expect(rejected).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(rejected).not.toHaveProperty('error');
    expect(rejected).not.toHaveProperty('session');
    expect(rejected).not.toHaveProperty('tool');
  });

  test('records a failing phase without logging page content', async () => {
    const ref = await selectedScan();
    send.mockImplementationOnce(async () => failure('TARGET_CLOSED: tab went away'));
    const response = await run({ command: 'act', actions: [{ op: 'click', ref }], scan: false });
    expect(response).toMatchObject({ ok: false, phase: 'action', actionStatus: 'not_started' });

    const records = readLogRecords();
    const failed = records.find(
      (record) => record.event === 'tool.failed' && record.code === 'TARGET_CLOSED',
    );
    expect(failed).toBeDefined();
    expect(failed?.tool).toBe('chrome_click_element');
    expect(failed).not.toHaveProperty('error');
    const commandFailed = records.filter((record) => record.event === 'command.failed').at(-1);
    expect(commandFailed).toMatchObject({ phase: 'action', actionStatus: 'not_started' });
    expect(commandFailed).not.toHaveProperty('error');
    // Records carry identifiers and outcome only; the page text never enters the log.
    expect(JSON.stringify(records)).not.toContain('Fixture');
  });

  test('keeps correlation ids separate when two sessions run concurrently', async () => {
    let releaseFirst!: () => void;
    let markStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    send.mockImplementationOnce(async () => {
      markStarted();
      await firstGate;
      return success({
        windows: [
          {
            windowId: 1,
            tabs: [{ tabId: 7, title: 'A', url: 'https://a.test/', active: true }],
          },
        ],
      });
    });

    const first = service.execute(
      { session: 'A', command: 'tabs' },
      new AbortController().signal,
      'review-A',
    );
    await started;
    const second = await service.execute(
      { session: 'B', command: 'tools' },
      new AbortController().signal,
      'review-B',
    );
    expect(second.ok).toBe(true);
    releaseFirst();
    await first;

    const records = readLogRecords();
    const startsForA = records.filter(
      (record) => record.event === 'tool.start' && record.requestId === 'review-A',
    );
    const donesForA = records.filter(
      (record) => record.event === 'command.done' && record.requestId === 'review-A',
    );
    expect(startsForA.length).toBeGreaterThan(0);
    expect(donesForA).toHaveLength(1);
    expect(records.some((record) => record.requestId === 'review-B')).toBe(true);
    const aToolIds = new Set(startsForA.map((record) => record.nativeRequestId));
    for (const record of records) {
      if (record.requestId === 'review-B' && aToolIds.has(record.nativeRequestId)) {
        throw new Error(`correlation leak: ${JSON.stringify(record)}`);
      }
    }
  });

  test('does not log tool.ok when a successful transport result fails to decode', async () => {
    const ref = await selectedScan();
    send.mockImplementationOnce(async () => ({
      status: 'success',
      data: {
        success: false,
        engine: 'cdp',
        error: { kind: 'runtime_error', message: 'FORM_VALUE_FIXTURE' },
      },
    }));
    await run({ command: 'act', actions: [{ op: 'click', ref }], scan: false });

    const records = readLogRecords();
    const lastStart = records.filter((record) => record.event === 'tool.start').at(-1);
    const nativeId = lastStart?.nativeRequestId;
    expect(nativeId).toBeDefined();

    const okForCall = records.some(
      (record) => record.event === 'tool.ok' && record.nativeRequestId === nativeId,
    );
    const failedForCall = records.some(
      (record) => record.event === 'tool.failed' && record.nativeRequestId === nativeId,
    );
    expect(okForCall).toBe(false);
    expect(failedForCall).toBe(true);
    expect(JSON.stringify(records)).not.toContain('FORM_VALUE_FIXTURE');
  });
});
