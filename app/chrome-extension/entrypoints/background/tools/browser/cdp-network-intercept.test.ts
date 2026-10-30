import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cdpNetworkTool } from './cdp-network';
import { cdpSessionTool } from './cdp-session';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { clearCdpSessionsForTest, peekSession } from '@/utils/cdp-event-hub';
import { globToRegExp } from '@/utils/cdp-network-intercept';
import { replayExpression } from '@/utils/cdp-network-replay';

vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: {
    attach: vi.fn(),
    detach: vi.fn(),
    sendCommand: vi.fn(),
    withSession: vi.fn(async (_tabId: number, _owner: string, fn: () => Promise<unknown>) => fn()),
  },
}));

type EventListener = (source: any, method: string, params?: any) => void;
let eventListeners: EventListener[];
let detachListeners: Array<(source: any, reason: string) => void>;
let calls: Array<[string, any, string | undefined]>;
let failOn: Set<string>;
let evaluate: (params: any, sessionId?: string) => any;

const A = { owner: 'cli:A', strictTarget: true };
const FRAME = 'OOPIF-1';
const WORKER = 'WORKER-1';
const SW = 'SW-1';

function emit(method: string, params?: unknown, sessionId?: string) {
  for (const listener of eventListeners) listener({ tabId: 7, sessionId }, method, params);
}

function body(result: any) {
  expect(result.isError, result.content?.[0]?.text).toBe(false);
  return JSON.parse(result.content[0].text);
}

function errorText(result: any): string {
  expect(result.isError).toBe(true);
  return result.content[0].text;
}

const network = (args: Record<string, unknown>, context: any = A) =>
  cdpNetworkTool.execute({ tabId: 7, ...args } as any, context);
const session = (args: Record<string, unknown>) =>
  cdpSessionTool.execute({ tabId: 7, ...args } as any, A);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const sent = (method: string) => calls.filter((call) => call[0] === method);
const at = (call: [string, any, string | undefined]) => `${call[0]}@${call[2] ?? ''}`;

function attach(sessionId: string, type: string, waitingForDebugger = false) {
  emit('Target.attachedToTarget', {
    sessionId,
    targetInfo: { targetId: `T-${sessionId}`, type, url: `http://x.test/${type}` },
    waitingForDebugger,
  });
}

function willSend(id: string, extra: Record<string, unknown> = {}, sessionId?: string) {
  emit(
    'Network.requestWillBeSent',
    {
      requestId: id,
      frameId: 'F-main',
      request: { url: 'http://x.test/api', method: 'POST', headers: { 'X-Trace': 't1' } },
      type: 'Fetch',
      timestamp: 1,
      wallTime: 1_700_000_000,
      ...extra,
    },
    sessionId,
  );
}

function pause(
  id: string,
  networkId: string | undefined,
  extra: Record<string, unknown> = {},
  sessionId?: string,
) {
  emit(
    'Fetch.requestPaused',
    {
      requestId: id,
      ...(networkId ? { networkId } : {}),
      frameId: 'F-main',
      resourceType: 'Fetch',
      request: {
        url: 'http://x.test/api',
        method: 'POST',
        headers: { 'X-Trace': 't1', Authorization: 'Bearer a' },
      },
      ...extra,
    },
    sessionId,
  );
}

async function started(rule?: Record<string, unknown>) {
  body(await session({ action: 'start' }));
  attach(FRAME, 'iframe');
  attach(WORKER, 'worker');
  attach(SW, 'service_worker');
  await flush();
  body(await network({ action: 'start' }));
  if (rule) return body(await network({ action: 'intercept', rule }));
  return undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearCdpSessionsForTest();
  eventListeners = [];
  detachListeners = [];
  calls = [];
  failOn = new Set();
  evaluate = () => ({
    result: { value: { status: 200, headers: [], preview: 'ok', url: 'http://x.test/api' } },
  });
  vi.stubGlobal('chrome', {
    tabs: {
      get: vi.fn(async (id: number) =>
        id === 7 ? { id, windowId: 1 } : Promise.reject(new Error('No tab')),
      ),
      query: vi.fn(async () => [{ id: 7, windowId: 1, active: true }]),
      onRemoved: { addListener: vi.fn() },
    },
    windows: { getLastFocused: vi.fn(async () => ({ id: 1 })) },
    debugger: {
      onEvent: { addListener: (fn: EventListener) => eventListeners.push(fn) },
      onDetach: { addListener: (fn: any) => detachListeners.push(fn) },
    },
  });
  vi.mocked(cdpSessionManager.attach).mockResolvedValue(undefined);
  vi.mocked(cdpSessionManager.detach).mockResolvedValue(undefined);
  vi.mocked(cdpSessionManager.sendCommand).mockImplementation(
    async (_tabId: number, method: string, params?: any, sessionId?: string) => {
      calls.push([method, params, sessionId]);
      if (failOn.has(`${method}@${sessionId ?? ''}`)) throw new Error(`${method} failed`);
      if (method === 'Page.getFrameTree')
        return { frameTree: { frame: { id: `F-${sessionId ?? 'main'}` } } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 41 };
      if (method === 'Runtime.evaluate') return evaluate(params, sessionId);
      return {};
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('globToRegExp', () => {
  test('follows Chrome urlPattern: * any run, ? one char, backslash escapes', () => {
    expect(globToRegExp('*://*/api/*').test('https://a.test/api/x?y=1')).toBe(true);
    expect(globToRegExp('*://*/api/*').test('https://a.test/apix')).toBe(false);
    expect(globToRegExp('http://a.test/?.js').test('http://a.test/a.js')).toBe(true);
    expect(globToRegExp('http://a.test/?.js').test('http://a.test/ab.js')).toBe(false);
    expect(globToRegExp('*a\\*b').test('xa*b')).toBe(true);
    expect(globToRegExp('*a\\*b').test('xaZb')).toBe(false);
    expect(globToRegExp('*.(x)+[y]').test('q.(x)+[y]')).toBe(true);
  });
});

describe('chrome_cdp_network interception', () => {
  test('rules are validated before any CDP call', async () => {
    body(await session({ action: 'start' }));
    body(await network({ action: 'start' }));
    calls = [];
    for (const [args, text] of [
      [{ action: 'intercept' }, 'intercept requires rule'],
      [{ action: 'intercept', rule: { action: 'log' } }, 'rule.urlPattern'],
      [{ action: 'intercept', rule: { urlPattern: '*', action: 'x' } }, 'rule.action must be'],
      [
        { action: 'intercept', rule: { urlPattern: '*', action: 'log', status: 1 } },
        'does not apply to action log',
      ],
      [
        {
          action: 'intercept',
          rule: { urlPattern: '*', action: 'continue', stage: 'response', url: 'http://a/' },
        },
        'ignores request changes at the response stage',
      ],
      [
        { action: 'intercept', rule: { urlPattern: '*', action: 'continue', url: 'nope' } },
        'absolute URL',
      ],
      [
        {
          action: 'intercept',
          rule: { urlPattern: '*', action: 'continue', headers: { 'a b': 'x' } },
        },
        'invalid header name',
      ],
      [
        {
          action: 'intercept',
          rule: { urlPattern: '*', action: 'continue', headers: { a: 'x\r\nb: y' } },
        },
        'without CR',
      ],
      [
        { action: 'intercept', rule: { urlPattern: '*', action: 'fulfill', status: 99 } },
        'rule.status',
      ],
      [
        {
          action: 'intercept',
          rule: { urlPattern: '*', action: 'fulfill', body: '%%', bodyBase64: true },
        },
        'base64',
      ],
      [
        { action: 'intercept', rule: { urlPattern: '*', action: 'fail', errorReason: 'Nope' } },
        'rule.errorReason',
      ],
      [
        { action: 'intercept', rule: { urlPattern: '*', action: 'log', resourceTypes: ['Xhr'] } },
        'resourceTypes',
      ],
      [
        { action: 'list', rule: { urlPattern: '*', action: 'log' } },
        'rule applies to intercept only',
      ],
      [{ action: 'unintercept' }, 'unintercept requires ruleId'],
    ] as const) {
      const message = errorText(await network(args));
      expect(message).toContain('INVALID_ARGUMENT');
      expect(message).toContain(text);
    }
    expect(calls).toEqual([]);
  });

  test('intercept needs recording on', async () => {
    body(await session({ action: 'start' }));
    expect(
      errorText(await network({ action: 'intercept', rule: { urlPattern: '*', action: 'log' } })),
    ).toContain('NETWORK_NOT_RECORDING');
    body(await network({ action: 'start' }));
    body(await network({ action: 'stop' }));
    expect(
      errorText(await network({ action: 'intercept', rule: { urlPattern: '*', action: 'log' } })),
    ).toContain('NETWORK_NOT_RECORDING');
  });

  test('enables Fetch in the root, the iframe and the service worker, not the dedicated worker', async () => {
    body(await session({ action: 'start' }));
    attach(FRAME, 'iframe');
    attach(WORKER, 'worker');
    attach(SW, 'service_worker');
    await flush();
    body(await network({ action: 'start' }));
    calls = [];
    const added = body(
      await network({
        action: 'intercept',
        rule: { urlPattern: '*api*', action: 'log', resourceTypes: ['XHR', 'Fetch'] },
      }),
    );
    expect(added.rule).toMatchObject({ id: 'rule-1', stage: 'request', hits: 0 });
    expect(calls.map(at)).toEqual(['Fetch.enable@', `Fetch.enable@${FRAME}`, `Fetch.enable@${SW}`]);
    expect(calls[0][1]).toEqual({
      patterns: [
        { urlPattern: '*api*', resourceType: 'XHR', requestStage: 'Request' },
        { urlPattern: '*api*', resourceType: 'Fetch', requestStage: 'Request' },
      ],
    });
    // A second rule re-sends the union; a response-stage rule adds its own pattern.
    calls = [];
    body(
      await network({
        action: 'intercept',
        rule: { urlPattern: '*.js', stage: 'response', action: 'log' },
      }),
    );
    expect(calls[0][1].patterns).toContainEqual({ urlPattern: '*.js', requestStage: 'Response' });
    expect(calls[0][1].patterns).toHaveLength(3);
  });

  test('a root Fetch.enable failure rolls the rule back', async () => {
    await started();
    failOn.add('Fetch.enable@');
    expect(
      errorText(await network({ action: 'intercept', rule: { urlPattern: '*', action: 'log' } })),
    ).toContain('Fetch.enable failed');
    expect(body(await network({ action: 'rules' })).rules).toEqual([]);
    expect(peekSession(7)!.network.intercept.rules.size).toBe(0);
  });

  test('a child Fetch.enable failure is returned per child', async () => {
    await started();
    failOn.add(`Fetch.enable@${FRAME}`);
    const added = body(
      await network({ action: 'intercept', rule: { urlPattern: '*', action: 'log' } }),
    );
    expect(added.childErrors).toEqual([{ sessionId: FRAME, error: 'Fetch.enable failed' }]);
  });

  test('continue applies url, method, merged headers, removeHeaders, and base64 postData', async () => {
    await started({
      urlPattern: '*api*',
      action: 'continue',
      url: 'http://x.test/api2',
      method: 'PUT',
      headers: { 'x-trace': 'changed', 'X-New': '1' },
      removeHeaders: ['Authorization'],
      postData: '{"v":"汉"}',
    });
    willSend('N1');
    calls = [];
    pause('I1', 'N1');
    await flush();
    expect(calls.map(at)).toEqual(['Fetch.continueRequest@']);
    const args = calls[0][1];
    expect(args).toMatchObject({ requestId: 'I1', url: 'http://x.test/api2', method: 'PUT' });
    expect(args.headers).toEqual([
      { name: 'x-trace', value: 'changed' },
      { name: 'X-New', value: '1' },
    ]);
    expect(
      new TextDecoder().decode(Uint8Array.from(atob(args.postData), (c) => c.charCodeAt(0))),
    ).toBe('{"v":"汉"}');
    const list = body(await network({ action: 'list' }));
    expect(list.requests[0].intercepted).toEqual(['rule-1:continue']);
    const detail = body(await network({ action: 'get', seq: 1 })).request;
    expect(detail.intercepts[0]).toMatchObject({
      ruleId: 'rule-1',
      stage: 'request',
      action: 'continue',
      changes: [
        'url',
        'method',
        'postData',
        'header x-trace',
        'header X-New',
        'remove header Authorization',
      ],
    });
  });

  test('fulfill, fail and log send their commands; unmatched pauses continue', async () => {
    await started();
    body(
      await network({
        action: 'intercept',
        rule: {
          urlPattern: '*mock*',
          action: 'fulfill',
          status: 418,
          headers: { 'Content-Type': 'text/plain' },
          body: 'mocked',
        },
      }),
    );
    body(
      await network({
        action: 'intercept',
        rule: { urlPattern: '*block*', action: 'fail', errorReason: 'BlockedByClient' },
      }),
    );
    body(await network({ action: 'intercept', rule: { urlPattern: '*seen*', action: 'log' } }));
    calls = [];
    pause('I1', undefined, { request: { url: 'http://x.test/mock', method: 'GET', headers: {} } });
    pause('I2', undefined, { request: { url: 'http://x.test/block', method: 'GET', headers: {} } });
    pause('I3', undefined, { request: { url: 'http://x.test/seen', method: 'GET', headers: {} } });
    pause('I4', undefined, { request: { url: 'http://x.test/other', method: 'GET', headers: {} } });
    await flush();
    expect(calls.map((call) => [call[0], call[1].requestId])).toEqual([
      ['Fetch.fulfillRequest', 'I1'],
      ['Fetch.failRequest', 'I2'],
      ['Fetch.continueRequest', 'I3'],
      ['Fetch.continueRequest', 'I4'],
    ]);
    expect(calls[0][1]).toEqual({
      requestId: 'I1',
      responseCode: 418,
      responseHeaders: [{ name: 'Content-Type', value: 'text/plain' }],
      body: btoa('mocked'),
    });
    expect(calls[1][1].errorReason).toBe('BlockedByClient');
    expect(calls[2][1]).toEqual({ requestId: 'I3' });
    const rules = body(await network({ action: 'rules' }));
    expect(rules.rules.map((rule: any) => rule.hits)).toEqual([1, 1, 1]);
    expect(rules).toMatchObject({ intercepting: true, paused: 4, unmatched: 1 });
    expect(rules.recent.map((note: any) => note.action)).toEqual([
      'fulfill',
      'fail',
      'log',
      'pass',
    ]);
  });

  test('response-stage pauses match response rules only and report the status', async () => {
    await started();
    body(await network({ action: 'intercept', rule: { urlPattern: '*', action: 'fail' } }));
    body(
      await network({
        action: 'intercept',
        rule: { urlPattern: '*', stage: 'response', action: 'fulfill', status: 500 },
      }),
    );
    willSend('N1');
    calls = [];
    pause('I1', 'N1', { responseStatusCode: 200, responseHeaders: [] });
    await flush();
    expect(calls.map((call) => call[0])).toEqual(['Fetch.fulfillRequest']);
    const note = body(await network({ action: 'get', seq: 1 })).request.intercepts[0];
    expect(note).toMatchObject({
      ruleId: 'rule-2',
      stage: 'response',
      responseStatus: 200,
      status: 500,
    });
  });

  test('a failing rule command is continued unchanged and the error recorded', async () => {
    await started({ urlPattern: '*', action: 'fulfill', status: 200 });
    failOn.add('Fetch.fulfillRequest@');
    willSend('N1');
    calls = [];
    pause('I1', 'N1');
    await flush();
    expect(calls.map(at)).toEqual(['Fetch.fulfillRequest@', 'Fetch.continueRequest@']);
    const note = body(await network({ action: 'get', seq: 1 })).request.intercepts[0];
    expect(note.error).toBe('Fetch.fulfillRequest failed; continued unchanged');
    expect(body(await network({ action: 'rules' })).errors[0]).toContain('rule-1');
  });

  test('a pause after the last rule was removed is still continued', async () => {
    await started({ urlPattern: '*', action: 'fail' });
    body(await network({ action: 'unintercept', ruleId: 'rule-1' }));
    calls = [];
    pause('I1', undefined);
    await flush();
    expect(calls.map(at)).toEqual(['Fetch.continueRequest@']);
  });

  test('a pause before its row and a dedicated worker pause in the root link to the row', async () => {
    await started({ urlPattern: '*', action: 'log' });
    pause('I1', 'N1');
    await flush();
    willSend('N1');
    // The worker's Network events are in its own session; its pause arrives in the root.
    willSend('W1', {}, WORKER);
    pause('I2', 'W1');
    // An OOPIF request pauses in the OOPIF session.
    willSend('C1', {}, FRAME);
    pause('I3', 'C1', {}, FRAME);
    await flush();
    const rows = body(await network({ action: 'list' })).requests;
    expect(rows.map((row: any) => [row.sessionId, row.intercepted])).toEqual([
      [undefined, ['rule-1:log']],
      [WORKER, ['rule-1:log']],
      [FRAME, ['rule-1:log']],
    ]);
    expect(sent('Fetch.continueRequest').map((call) => call[2])).toEqual([
      undefined,
      undefined,
      FRAME,
    ]);
  });

  test('a new iframe or service worker child gets Fetch before it resumes; a worker does not', async () => {
    await started({ urlPattern: '*', action: 'log' });
    calls = [];
    attach('OOPIF-2', 'iframe', true);
    attach('WORKER-2', 'worker', true);
    await flush();
    expect(calls.map(at).filter((entry) => entry.endsWith('OOPIF-2'))).toEqual([
      'Network.enable@OOPIF-2',
      'Fetch.enable@OOPIF-2',
      'Runtime.runIfWaitingForDebugger@OOPIF-2',
    ]);
    expect(calls.map(at).filter((entry) => entry.endsWith('WORKER-2'))).toEqual([
      'Network.enable@WORKER-2',
      'Runtime.runIfWaitingForDebugger@WORKER-2',
    ]);
  });

  test('unintercept all, network stop, and session stop disable Fetch everywhere', async () => {
    await started({ urlPattern: '*', action: 'log' });
    body(await network({ action: 'intercept', rule: { urlPattern: '*x*', action: 'log' } }));
    calls = [];
    expect(body(await network({ action: 'unintercept', ruleId: 'rule-1' }))).toMatchObject({
      removed: ['rule-1'],
      rules: 1,
    });
    expect(sent('Fetch.disable')).toEqual([]);
    expect(errorText(await network({ action: 'unintercept', ruleId: 'rule-9' }))).toContain(
      'INTERCEPT_RULE_NOT_FOUND',
    );
    calls = [];
    expect(body(await network({ action: 'unintercept', ruleId: 'all' })).removed).toEqual([
      'rule-2',
    ]);
    expect(sent('Fetch.disable').map(at)).toEqual([
      'Fetch.disable@',
      `Fetch.disable@${FRAME}`,
      `Fetch.disable@${SW}`,
    ]);

    body(await network({ action: 'intercept', rule: { urlPattern: '*', action: 'log' } }));
    calls = [];
    body(await network({ action: 'stop' }));
    expect(calls.map(at).slice(0, 4)).toEqual([
      'Fetch.disable@',
      `Fetch.disable@${FRAME}`,
      `Fetch.disable@${SW}`,
      'Network.disable@',
    ]);
    expect(body(await network({ action: 'rules' })).intercepting).toBe(false);

    body(await network({ action: 'start' }));
    body(await network({ action: 'intercept', rule: { urlPattern: '*', action: 'log' } }));
    calls = [];
    body(await session({ action: 'stop' }));
    expect(sent('Fetch.disable')).toHaveLength(3);
  });

  test('a detach drops the rules without CDP calls', async () => {
    await started({ urlPattern: '*', action: 'log' });
    for (const listener of detachListeners) listener({ tabId: 7 }, 'target_closed');
    calls = [];
    expect(body(await network({ action: 'rules' })).intercepting).toBe(false);
    expect(calls).toEqual([]);
  });

  test('rules redact header values and long bodies are cut', async () => {
    await started({
      urlPattern: '*',
      action: 'fulfill',
      headers: { Authorization: 'Bearer secret' },
      body: 'ab '.repeat(1000),
    });
    const rule = body(await network({ action: 'rules' })).rules[0];
    expect(rule.headers.Authorization).toBe('[REDACTED]');
    expect(rule.bodyChars).toBe(3000);
    expect(rule.body.length).toBe(1003);
    expect(rule).not.toHaveProperty('matcher');
  });
});

describe('chrome_cdp_network replay', () => {
  const sourceId = (params: any) => /sourceURL=aeb-replay:\/\/(\d+)/.exec(params.expression)?.[1];

  test('method and body must be explicit; checked before CDP IO', async () => {
    await started();
    willSend('N1', {
      request: {
        url: 'http://x.test/api',
        method: 'POST',
        headers: {},
        postData: 'orig',
        hasPostData: true,
      },
    });
    calls = [];
    for (const [replay, text] of [
      [undefined, 'replay requires replay'],
      [{}, 'replay.method is required'],
      [{ method: 'POST' }, 'exactly one of replay.body'],
      [{ method: 'POST', body: 'x', useOriginalBody: true }, 'exactly one of replay.body'],
      [{ method: 'GET', body: 'x' }, 'not allowed with GET'],
      [{ method: 'HEAD', useOriginalBody: true }, 'not allowed with HEAD'],
      [{ method: 'POST', body: '', url: 'relative' }, 'absolute URL'],
      [{ method: 'POST', body: '', credentials: 'all' }, 'replay.credentials'],
    ] as const) {
      const message = errorText(
        await network({ action: 'replay', seq: 1, ...(replay ? { replay } : {}) }),
      );
      expect(message).toContain('INVALID_ARGUMENT');
      expect(message).toContain(text);
    }
    expect(errorText(await network({ action: 'replay', replay: { method: 'GET' } }))).toContain(
      'replay requires seq',
    );
    expect(calls).toEqual([]);
  });

  test('replays in an isolated world of the frame and links the new row', async () => {
    await started();
    willSend('N1', {
      request: {
        url: 'http://x.test/api',
        method: 'POST',
        headers: { 'X-Trace': 't1', 'Content-Type': 'text/plain', Cookie: 'a=b', 'sec-ch-ua': 'x' },
        postData: 'orig',
        hasPostData: true,
      },
    });
    evaluate = (params) => {
      willSend('N2', {
        initiator: {
          type: 'script',
          stack: { callFrames: [{ url: `aeb-replay://${sourceId(params)}` }] },
        },
      });
      return {
        result: {
          value: {
            status: 201,
            statusText: 'Created',
            url: 'http://x.test/api',
            headers: [['content-type', 'application/json']],
            bodyChars: 2,
            preview: '{}',
          },
        },
      };
    };
    calls = [];
    const result = body(
      await network({
        action: 'replay',
        seq: 1,
        replay: {
          method: 'post',
          useOriginalBody: true,
          headers: { 'X-Trace': 'again' },
          removeHeaders: ['content-type'],
        },
      }),
    );
    expect(calls.map(at)).toEqual(['Page.createIsolatedWorld@', 'Runtime.evaluate@']);
    expect(calls[0][1]).toEqual({ frameId: 'F-main', worldName: 'aeb-replay' });
    const evaluateArgs = calls[1][1];
    expect(evaluateArgs).toMatchObject({ contextId: 41, awaitPromise: true, returnByValue: true });
    const data = JSON.parse(
      /\}\)\((\{[\s\S]*\})\)\n\/\/# sourceURL/.exec(evaluateArgs.expression)![1],
    );
    expect(data).toMatchObject({
      url: 'http://x.test/api',
      method: 'POST',
      headers: { 'X-Trace': 'again' },
      body: 'orig',
      credentials: 'include',
      timeoutMs: 30000,
    });
    expect(result).toMatchObject({
      replayOf: 1,
      seqs: [2],
      linked: true,
      sentFrom: { kind: 'page' },
      request: { method: 'POST', droppedHeaders: ['Cookie', 'sec-ch-ua'], body: 'set' },
      response: { status: 201, headers: { 'content-type': 'application/json' }, preview: '{}' },
    });
    const rows = body(await network({ action: 'list' })).requests;
    expect(rows.map((row: any) => [row.seq, row.replayOf, row.replays])).toEqual([
      [1, undefined, [2]],
      [2, 1, undefined],
    ]);
  });

  test('a worker request is replayed in the worker scope without an isolated world', async () => {
    await started();
    willSend('W1', { request: { url: 'http://x.test/w', method: 'GET', headers: {} } }, WORKER);
    calls = [];
    const result = body(
      await network({ action: 'replay', seq: 1, replay: { method: 'GET', credentials: 'omit' } }),
    );
    expect(calls.map(at)).toEqual([`Runtime.evaluate@${WORKER}`]);
    expect(calls[0][1]).not.toHaveProperty('contextId');
    expect(result).toMatchObject({
      sentFrom: { sessionId: WORKER, kind: 'worker' },
      linked: false,
      seqs: [],
    });
  });

  test('a cross-site iframe document replays in the child session that loaded it', async () => {
    await started();
    willSend('D1', {
      type: 'Document',
      frameId: 'F-OOPIF',
      request: { url: 'http://y.test/', method: 'GET', headers: {} },
    });
    emit('Network.loadingFinished', { requestId: 'D1', timestamp: 2 }, FRAME);
    await flush();
    calls = [];
    body(await network({ action: 'replay', seq: 1, replay: { method: 'GET' } }));
    expect(calls.map(at)).toEqual([
      `Page.getFrameTree@${FRAME}`,
      `Page.createIsolatedWorld@${FRAME}`,
      `Runtime.evaluate@${FRAME}`,
    ]);
  });

  test('fetch errors, timeouts, gone sessions, paused pages, and missing bodies are reported', async () => {
    await started();
    willSend('N1');
    evaluate = () => ({ result: { value: { error: 'Failed to fetch', name: 'TypeError' } } });
    expect(body(await network({ action: 'replay', seq: 1, replay: { method: 'GET' } })).error).toBe(
      'Failed to fetch',
    );
    evaluate = () => ({ result: { value: { error: 'aborted', name: 'AbortError' } } });
    expect(
      body(await network({ action: 'replay', seq: 1, replay: { method: 'GET', timeoutMs: 2000 } }))
        .error,
    ).toBe('timed out after 2000 ms');
    evaluate = () => ({ exceptionDetails: { text: 'Uncaught' } });
    expect(
      errorText(await network({ action: 'replay', seq: 1, replay: { method: 'GET' } })),
    ).toContain('REPLAY_FAILED');
    expect(
      errorText(
        await network({
          action: 'replay',
          seq: 1,
          replay: { method: 'POST', useOriginalBody: true },
        }),
      ),
    ).toContain('NETWORK_NO_BODY');
    peekSession(7)!.debug.pauses.set('', {} as any);
    expect(
      errorText(await network({ action: 'replay', seq: 1, replay: { method: 'GET' } })),
    ).toContain('REPLAY_PAGE_PAUSED');
    peekSession(7)!.debug.pauses.delete('');
    failOn.add('Page.createIsolatedWorld@');
    expect(
      errorText(await network({ action: 'replay', seq: 1, replay: { method: 'GET' } })),
    ).toContain('REPLAY_CONTEXT_UNAVAILABLE');
    willSend('C1', {}, FRAME);
    emit('Target.detachedFromTarget', { sessionId: FRAME });
    expect(
      errorText(await network({ action: 'replay', seq: 2, replay: { method: 'GET' } })),
    ).toContain('the session that sent seq 2 is gone');
    body(await network({ action: 'stop' }));
    expect(
      errorText(await network({ action: 'replay', seq: 1, replay: { method: 'GET' } })),
    ).toContain('NETWORK_NOT_RECORDING');
  });

  test('the replay script embeds its input as JSON and names itself for linking', () => {
    const source = replayExpression('7', { url: 'http://x/"); alert(1); ("', method: 'GET' });
    expect(source.endsWith('//# sourceURL=aeb-replay://7')).toBe(true);
    expect(source).toContain(JSON.stringify('http://x/"); alert(1); ("'));
    // The script itself must parse.
    expect(
      () => new Function(`return ${source.replace(/\n\/\/# sourceURL.*$/, '')}`),
    ).not.toThrow();
  });
});
