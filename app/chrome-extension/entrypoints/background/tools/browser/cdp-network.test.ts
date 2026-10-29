import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cdpNetworkTool } from './cdp-network';
import { cdpInjectTool } from './cdp-inject';
import { cdpSessionTool } from './cdp-session';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { clearCdpSessionsForTest, peekSession } from '@/utils/cdp-event-hub';

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
let calls: Array<[string, any, string | undefined]>;
let failOn: Set<string>;
let bodies: Map<string, { body: string; base64Encoded: boolean }>;
let downloads: Array<{ url: string; filename: string }>;
let downloadStates: string[];
let detachListeners: Array<(source: any, reason: string) => void>;

const A = { owner: 'cli:A', strictTarget: true };
const FRAME = 'OOPIF-1';
const WORKER = 'WORKER-1';

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
const session = (args: Record<string, unknown>, context: any = A) =>
  cdpSessionTool.execute({ tabId: 7, ...args } as any, context);
const inject = (args: Record<string, unknown>) =>
  cdpInjectTool.execute({ tabId: 7, ...args } as any, A);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const sent = (method: string) => calls.filter((call) => call[0] === method);

function attach(sessionId: string, type: string, waitingForDebugger = false) {
  emit('Target.attachedToTarget', {
    sessionId,
    targetInfo: { targetId: `T-${sessionId}`, type, url: `http://x.test/${type}` },
    waitingForDebugger,
  });
}

async function start(events: string[] = [], options: Record<string, unknown> = {}) {
  body(await session({ action: 'start', events }));
  return body(await network({ action: 'start', ...options }));
}

/** One request through its usual events; extra info both before and after the main events. */
function request(
  id: string,
  {
    url = 'http://x.test/api',
    method = 'GET',
    type = 'Fetch',
    status = 200,
    postData,
    sessionId,
    finish = true,
  }: {
    url?: string;
    method?: string;
    type?: string;
    status?: number;
    postData?: string;
    sessionId?: string;
    finish?: boolean;
  } = {},
) {
  emit(
    'Network.requestWillBeSentExtraInfo',
    { requestId: id, headers: { Cookie: 'sid=abc; theme=dark', Authorization: 'Bearer t0k' } },
    sessionId,
  );
  emit(
    'Network.requestWillBeSent',
    {
      requestId: id,
      loaderId: 'L1',
      documentURL: 'http://x.test/',
      request: {
        url,
        method,
        headers: { 'X-Trace': 'trace-1' },
        ...(postData !== undefined ? { postData, hasPostData: true } : {}),
      },
      timestamp: 100,
      wallTime: 1_700_000_000,
      initiator: {
        type: 'script',
        stack: {
          callFrames: [
            { functionName: 'send', url: 'http://x.test/a.js', lineNumber: 3, columnNumber: 9 },
          ],
        },
      },
      type,
    },
    sessionId,
  );
  emit(
    'Network.responseReceived',
    {
      requestId: id,
      type,
      response: {
        status,
        statusText: 'OK',
        headers: { 'Content-Type': 'application/json' },
        mimeType: 'application/json',
        protocol: 'http/1.1',
        remoteIPAddress: '127.0.0.1',
        remotePort: 80,
        timing: {
          requestTime: 100,
          dnsStart: -1,
          dnsEnd: -1,
          connectStart: -1,
          connectEnd: -1,
          sslStart: -1,
          sslEnd: -1,
          sendStart: 1,
          sendEnd: 2,
          receiveHeadersEnd: 10,
        },
      },
    },
    sessionId,
  );
  emit(
    'Network.responseReceivedExtraInfo',
    {
      requestId: id,
      statusCode: status,
      headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'sid=new; Path=/\ntheme=light' },
    },
    sessionId,
  );
  if (finish) {
    emit(
      'Network.loadingFinished',
      { requestId: id, timestamp: 100.25, encodedDataLength: 42 },
      sessionId,
    );
  }
}

function dataUrlText(url: string): string {
  const binary = atob(url.slice(url.indexOf(',') + 1));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

beforeEach(() => {
  vi.clearAllMocks();
  clearCdpSessionsForTest();
  eventListeners = [];
  calls = [];
  failOn = new Set();
  bodies = new Map();
  downloads = [];
  downloadStates = ['in_progress', 'complete'];
  detachListeners = [];
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
    runtime: { getManifest: () => ({ version: '9.9.9' }) },
    downloads: {
      download: vi.fn(async (options: { url: string; filename: string }) => {
        downloads.push(options);
        return 55;
      }),
      search: vi.fn(async () => [
        { id: 55, state: downloadStates.shift() ?? 'complete', filename: 'E:\\Download\\x.har' },
      ]),
    },
  });
  vi.mocked(cdpSessionManager.attach).mockResolvedValue(undefined);
  vi.mocked(cdpSessionManager.detach).mockResolvedValue(undefined);
  vi.mocked(cdpSessionManager.sendCommand).mockImplementation(
    async (_tabId: number, method: string, params?: any, sessionId?: string) => {
      calls.push([method, params, sessionId]);
      if (failOn.has(`${method}@${sessionId ?? ''}`)) throw new Error(`${method} failed`);
      if (method === 'Network.getResponseBody') {
        const stored = bodies.get(`${sessionId ?? ''}/${params.requestId}`);
        if (!stored) throw new Error('No resource with given identifier found');
        return stored;
      }
      if (method === 'Network.getRequestPostData') {
        return { postData: 'x'.repeat(70_000), base64Encoded: false };
      }
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: '1' };
      return {};
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('chrome_cdp_network tool', () => {
  test('requires an owned session and a started table', async () => {
    expect(errorText(await network({ action: 'list' }, {}))).toContain('CDP_SESSION_NOT_STARTED');
    body(await session({ action: 'start' }));
    expect(errorText(await network({ action: 'list' }))).toContain('NETWORK_NOT_STARTED');
    expect(errorText(await network({ action: 'list' }, { owner: 'cli:B' }))).toContain(
      'CDP_SESSION_OWNED',
    );
  });

  test('bad arguments fail before any CDP call', async () => {
    body(await session({ action: 'start' }));
    calls = [];
    for (const [args, message] of [
      [{ action: 'nope' }, 'action must be'],
      [{ action: 'start', bodies: 'some' }, 'bodies must be'],
      [{ action: 'get' }, 'get requires seq'],
      [{ action: 'body', seq: 0 }, 'body requires seq'],
      [{ action: 'list', part: 'request' }, 'part applies to body only'],
      [{ action: 'list', state: 'done' }, 'state must be'],
      [{ action: 'har', filename: '../x' }, 'filename must be'],
    ] as const) {
      const text = errorText(await network(args));
      expect(text).toContain('INVALID_ARGUMENT');
      expect(text).toContain(message);
    }
    expect(calls).toEqual([]);
  });

  test('start holds new children, enables root then frame and worker children', async () => {
    body(await session({ action: 'start' }));
    attach(FRAME, 'iframe');
    attach(WORKER, 'worker');
    attach('OTHER', 'browser');
    await flush();
    calls = [];
    const result = body(await network({ action: 'start' }));
    expect(result).toMatchObject({
      recording: true,
      bodies: 'api',
      maxBodyBytes: 1048576,
      maxRequests: 2000,
      sessions: ['root', FRAME, WORKER],
    });
    expect(calls.map(([method, , sessionId]) => `${method}@${sessionId ?? ''}`)).toEqual([
      'Target.setAutoAttach@',
      'Network.enable@',
      `Network.enable@${FRAME}`,
      `Network.enable@${WORKER}`,
    ]);
    expect(calls[0][1]).toEqual({ autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    expect(calls[1][1]).toMatchObject({ maxPostDataSize: 65536 });
    expect(errorText(await network({ action: 'start' }))).toContain('NETWORK_ACTIVE');
  });

  test('a root enable failure leaves recording off and children unpaused', async () => {
    body(await session({ action: 'start' }));
    failOn.add('Network.enable@');
    expect(errorText(await network({ action: 'start' }))).toContain('Network.enable failed');
    expect(sent('Target.setAutoAttach').map((call) => call[1].waitForDebuggerOnStart)).toEqual([
      false,
      true,
      false,
    ]);
    expect(errorText(await network({ action: 'list' }))).toContain('NETWORK_NOT_STARTED');
  });

  test('a paused new child gets inject scripts and Network before it resumes', async () => {
    await start();
    body(await inject({ action: 'add', source: 'x' }));
    calls = [];
    attach('OOPIF-2', 'iframe', true);
    attach('WORKER-2', 'worker', true);
    await flush();
    const order = calls.map(([method, , sessionId]) => `${method}@${sessionId}`);
    expect(order.filter((entry) => entry.endsWith('OOPIF-2'))).toEqual([
      'Page.enable@OOPIF-2',
      'Page.addScriptToEvaluateOnNewDocument@OOPIF-2',
      'Network.enable@OOPIF-2',
      'Runtime.runIfWaitingForDebugger@OOPIF-2',
    ]);
    expect(order.filter((entry) => entry.endsWith('WORKER-2'))).toEqual([
      'Network.enable@WORKER-2',
      'Runtime.runIfWaitingForDebugger@WORKER-2',
    ]);
  });

  test('a failed child enable still resumes the child and is reported', async () => {
    await start();
    failOn.add('Network.enable@OOPIF-3');
    failOn.add('Runtime.runIfWaitingForDebugger@OOPIF-3');
    attach('OOPIF-3', 'iframe', true);
    await flush();
    expect(sent('Runtime.runIfWaitingForDebugger')).toHaveLength(1);
    expect(body(await network({ action: 'list' })).networkErrors).toEqual([
      'enable in OOPIF-3: Network.enable failed',
    ]);
    expect(body(await session({ action: 'status' })).childStartErrors).toEqual([
      'resume OOPIF-3: Runtime.runIfWaitingForDebugger failed',
    ]);
  });

  test('records a request with wire headers, body, auth names, and redaction', async () => {
    await start();
    bodies.set('/R1', {
      body: '{"ok":true,"token":"abcdefghijklmnopqrstuvwx"}',
      base64Encoded: false,
    });
    request('R1', { method: 'POST', postData: '{"q":1}', status: 201 });
    await flush();
    expect(sent('Network.getResponseBody')).toEqual([
      ['Network.getResponseBody', { requestId: 'R1' }, undefined],
    ]);
    const listed = body(await network({ action: 'list' }));
    expect(listed.requests).toEqual([
      {
        seq: 1,
        method: 'POST',
        url: 'http://x.test/api',
        type: 'Fetch',
        state: 'complete',
        status: 201,
        mimeType: 'application/json',
        durationMs: 250,
        transferBytes: 42,
        bodyBytes: 46,
      },
    ]);
    const detail = body(await network({ action: 'get', seq: 1 })).request;
    expect(detail.request.headers).toEqual({ Cookie: '[REDACTED]', Authorization: '[REDACTED]' });
    expect(detail.request.headersSource).toBe('wire');
    expect(detail.request.body).toEqual({ bytes: 7, preview: '{"q":1}' });
    expect(detail.response.headers['Set-Cookie']).toBe('[REDACTED]');
    expect(detail.response.headers['Content-Type']).toBe('application/json');
    expect(detail.auth).toEqual({
      requestHeaders: ['Cookie', 'Authorization'],
      responseHeaders: ['Set-Cookie'],
      cookies: ['sid', 'theme'],
      setCookies: ['sid', 'theme'],
    });
    expect(detail.initiator.stack[0]).toMatchObject({ functionName: 'send', lineNumber: 3 });
    expect(detail.timings).toMatchObject({ send: 1, wait: 8 });
    expect(detail.startedAt).toBe(1_700_000_000_000);
    const raw = body(await network({ action: 'get', seq: 1, sanitizeOutput: false })).request;
    expect(raw.request.headers.Authorization).toBe('Bearer t0k');
  });

  test('network events reach the event buffer only through the session filter', async () => {
    await start();
    request('R1');
    expect(body(await session({ action: 'events', after: 0 })).events).toEqual([]);
    expect(body(await network({ action: 'list' })).total).toBe(1);
    body(await network({ action: 'stop' }));
    body(await session({ action: 'stop' }));
    await start(['Network.loadingFinished']);
    request('R2');
    expect(
      body(await session({ action: 'events', after: 0 })).events.map((event: any) => event.method),
    ).toEqual(['Network.loadingFinished']);
  });

  test('redirect hops are linked rows and the redirect wire headers go to the first hop', async () => {
    await start();
    emit('Network.requestWillBeSent', {
      requestId: 'R1',
      request: { url: 'http://x.test/old', method: 'GET', headers: {} },
      timestamp: 1,
      wallTime: 1000,
      type: 'Document',
    });
    emit('Network.requestWillBeSent', {
      requestId: 'R1',
      request: { url: 'http://x.test/new', method: 'GET', headers: {} },
      redirectResponse: { status: 302, statusText: 'Found', headers: { Location: '/new' } },
      timestamp: 1.1,
      wallTime: 1000.1,
      type: 'Document',
    });
    emit('Network.responseReceivedExtraInfo', {
      requestId: 'R1',
      statusCode: 302,
      headers: { Location: '/new', 'Set-Cookie': 'a=1' },
    });
    const rows = body(await network({ action: 'list' })).requests;
    expect(rows.map((item: any) => [item.seq, item.url, item.state, item.status ?? null])).toEqual([
      [1, 'http://x.test/old', 'complete', 302],
      [2, 'http://x.test/new', 'pending', null],
    ]);
    expect(rows[0].redirectedTo).toBe(2);
    expect(body(await network({ action: 'get', seq: 1 })).request.response.headersSource).toBe(
      'wire',
    );
    expect(body(await network({ action: 'get', seq: 2 })).request.redirectedFrom).toBe(1);
    expect(errorText(await network({ action: 'body', seq: 1 }))).toContain('is a redirect');
  });

  test('child requests are read from the child session and filtered by sessionId', async () => {
    body(await session({ action: 'start' }));
    attach(FRAME, 'iframe');
    await flush();
    body(await network({ action: 'start' }));
    bodies.set(`${FRAME}/C1`, { body: 'child', base64Encoded: false });
    request('C1', { sessionId: FRAME });
    request('R1');
    await flush();
    expect(sent('Network.getResponseBody').map((call) => call[2])).toEqual([FRAME, undefined]);
    const child = body(await network({ action: 'list', sessionId: FRAME })).requests;
    expect(child.map((item: any) => [item.seq, item.sessionId])).toEqual([[1, FRAME]]);
    expect(body(await network({ action: 'list', sessionId: 'root' })).requests).toHaveLength(1);
    expect(body(await network({ action: 'body', seq: 1 })).text).toBe('child');
  });

  test('an OOPIF navigation requested in the root finishes in the child and is read there', async () => {
    body(await session({ action: 'start' }));
    body(await network({ action: 'start' }));
    emit('Network.requestWillBeSent', {
      requestId: 'NAV',
      request: { url: 'http://y.test/child', method: 'GET', headers: {} },
      timestamp: 1,
      wallTime: 1,
      type: 'Document',
    });
    emit('Network.responseReceived', {
      requestId: 'NAV',
      type: 'Document',
      response: { status: 200, headers: {}, mimeType: 'text/html' },
    });
    attach('OOPIF-9', 'iframe', true);
    await flush();
    bodies.set('OOPIF-9/NAV', { body: '<p>child</p>', base64Encoded: false });
    emit('Network.loadingFinished', { requestId: 'NAV', timestamp: 1.5 }, 'OOPIF-9');
    await flush();
    expect(body(await network({ action: 'list' })).requests).toEqual([
      expect.objectContaining({ seq: 1, state: 'complete', bodyBytes: 12 }),
    ]);
    expect(body(await network({ action: 'body', seq: 1 })).text).toBe('<p>child</p>');
  });

  test('body pages text by chars within maxOutputBytes and binary as base64 by bytes', async () => {
    await start();
    const text = '汉'.repeat(1000);
    bodies.set('/T', { body: text, base64Encoded: false });
    const binary = Uint8Array.from({ length: 300 }, (_, index) => index % 256);
    bodies.set('/B', { body: btoa(String.fromCharCode(...binary)), base64Encoded: true });
    request('T');
    request('B');
    await flush();
    const first = body(await network({ action: 'body', seq: 1, maxOutputBytes: 1000 }));
    expect(first).toMatchObject({
      offset: 0,
      endOffset: 333,
      unit: 'chars',
      totalChars: 1000,
      hasMore: true,
    });
    const next = body(await network({ action: 'body', seq: 1, offset: 990 }));
    expect(next).toMatchObject({ endOffset: 1000, hasMore: false, text: '汉'.repeat(10) });
    const bin = body(await network({ action: 'body', seq: 2, offset: 100, length: 50 }));
    expect(bin).toMatchObject({
      base64: true,
      offset: 100,
      endOffset: 150,
      unit: 'bytes',
      totalBytes: 300,
    });
    expect(Array.from(atob(bin.data), (char) => char.charCodeAt(0))).toEqual(
      Array.from(binary.subarray(100, 150)),
    );
  });

  test('bodies are truncated to maxBodyBytes and the 32 MB budget evicts oldest first', async () => {
    await start([], { maxBodyBytes: 10 * 1024 * 1024 });
    for (const id of ['A', 'B', 'C', 'D']) {
      bodies.set(`/${id}`, { body: 'x'.repeat(11 * 1024 * 1024), base64Encoded: false });
      request(id);
      await flush();
    }
    const listed = body(await network({ action: 'list' }));
    expect(listed.bodyBytes).toBe(30 * 1024 * 1024);
    expect(listed.evictedBodies).toBe(1);
    const latest = body(await network({ action: 'body', seq: 4, offset: 0, length: 10 }));
    expect(latest).toMatchObject({ totalBytes: 11 * 1024 * 1024, captureTruncated: true });
    expect(body(await network({ action: 'get', seq: 1 })).request.response.body).toEqual({
      evicted: true,
    });
    // An evicted body is read again from Chrome while it still exists.
    expect(body(await network({ action: 'body', seq: 1, length: 3 })).text).toBe('xxx');
  });

  test('bodies outside the start set are read on demand; unavailable reads explain why', async () => {
    await start();
    bodies.set('/S', { body: 'js', base64Encoded: false });
    request('S', { type: 'Script' });
    request('G', { type: 'Fetch' });
    request('P', { finish: false });
    emit('Network.webSocketCreated', { requestId: 'W', url: 'ws://x.test/ws' });
    await flush();
    expect(sent('Network.getResponseBody').map((call) => call[1].requestId)).toEqual(['G']);
    expect(body(await network({ action: 'body', seq: 1 })).text).toBe('js');
    const gone = errorText(await network({ action: 'body', seq: 2 }));
    expect(gone).toContain('NETWORK_BODY_UNAVAILABLE');
    expect(gone).toContain('capture failed: No resource with given identifier found');
    expect(errorText(await network({ action: 'body', seq: 3 }))).toContain('NETWORK_BODY_PENDING');
    expect(errorText(await network({ action: 'body', seq: 4 }))).toContain('action messages');
    expect(errorText(await network({ action: 'body', seq: 1, part: 'request' }))).toContain(
      'has no request body',
    );
    expect(errorText(await network({ action: 'get', seq: 99 }))).toContain(
      'NETWORK_REQUEST_NOT_FOUND',
    );
  });

  test('a request body above maxPostDataSize is read at once', async () => {
    await start();
    emit('Network.requestWillBeSent', {
      requestId: 'U',
      request: { url: 'http://x.test/up', method: 'POST', headers: {}, hasPostData: true },
      timestamp: 1,
      wallTime: 1,
      type: 'Fetch',
    });
    await flush();
    expect(sent('Network.getRequestPostData')).toEqual([
      ['Network.getRequestPostData', { requestId: 'U' }, undefined],
    ]);
    expect(body(await network({ action: 'body', seq: 1, part: 'request' })).totalBytes).toBe(
      70_000,
    );
  });

  test('WebSocket frames and EventSource messages page by index', async () => {
    await start();
    emit('Network.webSocketCreated', { requestId: 'W', url: 'ws://x.test/ws' });
    emit('Network.webSocketWillSendHandshakeRequest', {
      requestId: 'W',
      timestamp: 5,
      wallTime: 2000,
      request: { headers: { Cookie: 'sid=1' } },
    });
    emit('Network.webSocketHandshakeResponseReceived', {
      requestId: 'W',
      timestamp: 5.1,
      response: {
        status: 101,
        statusText: 'Switching Protocols',
        headers: { Upgrade: 'websocket' },
      },
    });
    emit('Network.webSocketFrameSent', {
      requestId: 'W',
      timestamp: 5.2,
      response: { opcode: 1, mask: true, payloadData: 'ping' },
    });
    emit('Network.webSocketFrameReceived', {
      requestId: 'W',
      timestamp: 5.3,
      response: { opcode: 1, mask: false, payloadData: 'echo:ping' },
    });
    emit('Network.webSocketClosed', { requestId: 'W', timestamp: 6 });
    request('E', { type: 'EventSource', finish: false });
    for (let index = 1; index <= 3; index += 1) {
      emit('Network.eventSourceMessageReceived', {
        requestId: 'E',
        timestamp: 100 + index,
        eventName: 'tick',
        eventId: String(index),
        data: `tick-${index}`,
      });
    }
    const ws = body(await network({ action: 'messages', seq: 1 }));
    expect(ws).toMatchObject({ type: 'WebSocket', state: 'closed', total: 2, hasMore: false });
    expect(
      ws.messages.map((item: any) => [item.index, item.direction, item.data, item.ts]),
    ).toEqual([
      [1, 'sent', 'ping', 2_000_200],
      [2, 'received', 'echo:ping', 2_000_300],
    ]);
    expect(body(await network({ action: 'list', types: ['websocket'] })).requests[0]).toMatchObject(
      {
        status: 101,
        state: 'closed',
        messages: 2,
      },
    );
    const sse = body(await network({ action: 'messages', seq: 2, after: 1, limit: 1 }));
    expect(sse.messages).toEqual([
      expect.objectContaining({
        index: 2,
        direction: 'event',
        event: 'tick',
        id: '2',
        data: 'tick-2',
      }),
    ]);
    expect(sse).toMatchObject({ nextAfter: 2, hasMore: true });
    expect(errorText(await network({ action: 'messages', seq: 3 }))).toContain(
      'NETWORK_REQUEST_NOT_FOUND',
    );
  });

  test('maxRequests drops the oldest rows', async () => {
    await start([], { bodies: 'none', maxRequests: 10 });
    for (let index = 1; index <= 12; index += 1) request(`R${index}`);
    const listed = body(await network({ action: 'list' }));
    expect(listed.total).toBe(10);
    expect(listed.dropped).toBe(2);
    expect(listed.requests[0].seq).toBe(3);
    expect(sent('Network.getResponseBody')).toEqual([]);
  });

  test('list filters and pages by seq within maxOutputBytes', async () => {
    await start([], { bodies: 'none' });
    request('R1', { url: 'http://x.test/a?kind=json', method: 'POST', status: 201 });
    request('R2', { url: 'http://x.test/b', type: 'Script' });
    request('R3', { url: 'http://x.test/c', status: 404 });
    expect(
      body(await network({ action: 'list', method: 'post' })).requests.map((r: any) => r.seq),
    ).toEqual([1]);
    expect(
      body(await network({ action: 'list', types: ['Script'] })).requests.map((r: any) => r.seq),
    ).toEqual([2]);
    expect(
      body(await network({ action: 'list', status: 404 })).requests.map((r: any) => r.seq),
    ).toEqual([3]);
    expect(
      body(await network({ action: 'list', url: 'KIND=' })).requests.map((r: any) => r.seq),
    ).toEqual([1]);
    const page = body(await network({ action: 'list', limit: 2 }));
    expect(page).toMatchObject({ nextAfter: 2, hasMore: true });
    expect(
      body(await network({ action: 'list', after: 2 })).requests.map((r: any) => r.seq),
    ).toEqual([3]);
  });

  test('har writes redacted HAR 1.2 through downloads and returns the path', async () => {
    await start();
    bodies.set('/R1', { body: '{"ok":true}', base64Encoded: false });
    request('R1', {
      url: 'http://x.test/api?token=secret123&page=2',
      method: 'POST',
      postData: 'a=1',
    });
    await flush();
    const result = body(await network({ action: 'har', filename: 'case1' }));
    expect(result).toMatchObject({
      path: 'E:\\Download\\x.har',
      entries: 1,
      downloadId: 55,
      includeBodies: true,
      redacted: true,
    });
    expect(downloads[0].filename).toBe('case1.har');
    const har = JSON.parse(dataUrlText(downloads[0].url));
    expect(result.bytes).toBe(new TextEncoder().encode(JSON.stringify(har)).length);
    const entry = har.log.entries[0];
    expect(har.log).toMatchObject({
      version: '1.2',
      creator: { name: 'AIEasyBrowser', version: '9.9.9' },
    });
    expect(entry.request.cookies).toEqual([
      { name: 'sid', value: '[REDACTED]' },
      { name: 'theme', value: '[REDACTED]' },
    ]);
    expect(entry.request.queryString).toEqual([
      { name: 'token', value: '[REDACTED]' },
      { name: 'page', value: '2' },
    ]);
    expect(entry.response.cookies.map((cookie: any) => cookie.name)).toEqual(['sid', 'theme']);
    expect(
      entry.response.headers.filter((header: any) => header.name === 'Set-Cookie'),
    ).toHaveLength(2);
    expect(entry.response.content).toMatchObject({ size: 11, text: '{"ok":true}' });
    expect(entry.request.postData.text).toBe('a=1');
    expect(entry.timings).toMatchObject({ send: 1, wait: 8 });
    expect(entry).toMatchObject({ time: 250, _resourceType: 'fetch', _seq: 1 });
  });

  test('har without bodies or redaction, and an interrupted download fails', async () => {
    await start();
    bodies.set('/R1', { body: 'body', base64Encoded: false });
    request('R1');
    await flush();
    body(await network({ action: 'har', includeBodies: false, sanitizeOutput: false }));
    const har = JSON.parse(dataUrlText(downloads[0].url));
    expect(downloads[0].filename).toMatch(/^network_tab7_.*\.har$/);
    expect(har.log.entries[0].response.content.text).toBeUndefined();
    expect(har.log.entries[0].request.cookies[0].value).toBe('abc');
    downloadStates = ['interrupted'];
    expect(errorText(await network({ action: 'har' }))).toContain('HAR_WRITE_FAILED');
  });

  test('stop disables Network everywhere, releases children, and keeps the table', async () => {
    body(await session({ action: 'start' }));
    attach(FRAME, 'iframe');
    await flush();
    body(await network({ action: 'start' }));
    request('R1', { finish: false });
    calls = [];
    expect(body(await network({ action: 'stop' }))).toMatchObject({
      recording: false,
      requests: 1,
    });
    expect(
      calls.map(([method, params, sessionId]) => [
        method,
        sessionId,
        params?.waitForDebuggerOnStart,
      ]),
    ).toEqual([
      ['Network.disable', undefined, undefined],
      ['Network.disable', FRAME, undefined],
      ['Target.setAutoAttach', undefined, false],
    ]);
    request('R2');
    expect(body(await network({ action: 'list' }))).toMatchObject({ recording: false, total: 1 });
    expect(body(await network({ action: 'clear' }))).toEqual(
      expect.objectContaining({ cleared: 1, recording: false }),
    );
    // A restart empties the table; seq keeps counting (R2 arrived while off and was not recorded).
    body(await network({ action: 'start' }));
    request('R3');
    expect(body(await network({ action: 'list' })).requests.map((r: any) => r.seq)).toEqual([2]);
  });

  test('session stop disables Network; a detach keeps the table readable', async () => {
    await start();
    calls = [];
    body(await session({ action: 'stop' }));
    expect(sent('Network.disable')).toHaveLength(1);
    await start();
    bodies.set('/R1', { body: 'kept', base64Encoded: false });
    request('R1');
    request('R2', { type: 'Script' });
    await flush();
    for (const listener of detachListeners) listener({ tabId: 7 }, 'target_closed');
    expect(peekSession(7)!.network.enabled).toBe(false);
    calls = [];
    expect(body(await network({ action: 'list' }))).toMatchObject({ recording: false, total: 2 });
    expect(body(await network({ action: 'body', seq: 1 })).text).toBe('kept');
    expect(errorText(await network({ action: 'body', seq: 2 }))).toContain(
      'the session that loaded it is gone',
    );
    expect(body(await network({ action: 'stop' }))).toMatchObject({ recording: false });
    expect(errorText(await network({ action: 'start' }))).toContain('CDP_SESSION_ENDED');
    expect(calls).toEqual([]);
    expect(cdpNetworkTool.skipsTargetLock()).toBe(true);
  });
});
