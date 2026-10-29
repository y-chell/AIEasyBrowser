import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cdpInjectTool } from './cdp-inject';
import { cdpSessionTool } from './cdp-session';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { clearCdpSessionsForTest, peekSession } from '@/utils/cdp-event-hub';
import { hookSource, type HookSpec } from '@/utils/cdp-hook-runtime';

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
let nextIdentifier: number;

const A = { owner: 'cli:A', strictTarget: true };
const B = { owner: 'cli:B', strictTarget: true };
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

const inject = (args: Record<string, unknown>, context: any = A) =>
  cdpInjectTool.execute({ tabId: 7, ...args } as any, context);
const session = (args: Record<string, unknown>, context: any = A) =>
  cdpSessionTool.execute({ tabId: 7, ...args } as any, context);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const sent = (method: string) => calls.filter((call) => call[0] === method);
const binding = () => peekSession(7)!.inject.bindingName;

function attach(sessionId: string, type: string, waitingForDebugger = false) {
  emit('Target.attachedToTarget', {
    sessionId,
    targetInfo: { targetId: `T-${sessionId}`, type, url: `http://x.test/${type}` },
    waitingForDebugger,
  });
}

async function start(events: string[] = []) {
  body(await session({ action: 'start', events }));
}

beforeEach(() => {
  vi.clearAllMocks();
  clearCdpSessionsForTest();
  eventListeners = [];
  calls = [];
  failOn = new Set();
  nextIdentifier = 1;
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
      onDetach: { addListener: vi.fn() },
    },
  });
  vi.mocked(cdpSessionManager.attach).mockResolvedValue(undefined);
  vi.mocked(cdpSessionManager.detach).mockResolvedValue(undefined);
  vi.mocked(cdpSessionManager.sendCommand).mockImplementation(
    async (_tabId: number, method: string, params?: any, sessionId?: string) => {
      calls.push([method, params, sessionId]);
      if (failOn.has(`${method}@${sessionId ?? ''}`)) throw new Error(`${method} failed`);
      if (method === 'Page.addScriptToEvaluateOnNewDocument') {
        return { identifier: String(nextIdentifier++) };
      }
      return {};
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('chrome_cdp_inject tool', () => {
  test('requires an owned, active session', async () => {
    expect(errorText(await inject({ action: 'list' }, {}))).toContain('CDP_SESSION_NOT_STARTED');
    expect(errorText(await inject({ action: 'list' }))).toContain('CDP_SESSION_NOT_STARTED');
    await start();
    expect(errorText(await inject({ action: 'list' }, B))).toContain('CDP_SESSION_OWNED');
  });

  test('add registers on the root and attached OOPIFs, not workers, and pauses new children', async () => {
    await start();
    attach(FRAME, 'iframe');
    attach(WORKER, 'worker');
    calls = [];
    const result = body(
      await inject({ action: 'add', source: 'window.early = 1', worldName: 'probe' }),
    );
    expect(result.injection).toMatchObject({
      id: 'inj-1',
      type: 'script',
      worldName: 'probe',
      runImmediately: false,
      sourceBytes: 16,
      sessions: ['root', FRAME],
    });
    expect(calls).toEqual([
      ['Page.enable', {}, undefined],
      [
        'Page.addScriptToEvaluateOnNewDocument',
        { source: 'window.early = 1', worldName: 'probe', runImmediately: false },
        undefined,
      ],
      [
        'Target.setAutoAttach',
        { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
        undefined,
      ],
      ['Page.enable', {}, FRAME],
      [
        'Page.addScriptToEvaluateOnNewDocument',
        { source: 'window.early = 1', worldName: 'probe', runImmediately: false },
        FRAME,
      ],
    ]);
    expect(sent('Runtime.addBinding')).toEqual([]);
  });

  test('hook enables the binding, runs immediately by default, and embeds only data', async () => {
    await start();
    attach(FRAME, 'iframe');
    const result = body(
      await inject({ action: 'hook', hook: 'function', path: 'window.app.sign', maxRecords: 3 }),
    );
    expect(result.injection).toMatchObject({
      type: 'hook',
      kind: 'function',
      path: 'window.app.sign',
      access: 'both',
      maxRecords: 3,
      stackDepth: 5,
      runImmediately: true,
      installed: 0,
      records: 0,
      sessions: ['root', FRAME],
    });
    const name = binding();
    expect(name).toMatch(/^__aeb_[0-9a-f]{16}$/);
    expect(sent('Runtime.addBinding')).toEqual([
      ['Runtime.addBinding', { name }, undefined],
      ['Runtime.addBinding', { name }, FRAME],
    ]);
    const source = sent('Page.addScriptToEvaluateOnNewDocument')[0][1].source as string;
    expect(source).toContain(JSON.stringify(name));
    expect(source).toContain('["app","sign"]');
    expect(source).toContain('//# sourceURL=aeb-hook://inj-1');
  });

  test.each([
    [{ action: 'add' }, 'non-empty source'],
    [{ action: 'add', source: 'x', hook: 'fetch' }, 'add does not take hook'],
    [{ action: 'add', source: 'x', worldName: 'bad world' }, 'worldName'],
    [{ action: 'hook' }, 'function, property, fetch, or xhr'],
    [{ action: 'hook', hook: 'function' }, 'dotted property path'],
    [{ action: 'hook', hook: 'function', path: 'a..b' }, 'dotted property path'],
    [{ action: 'hook', hook: 'function', path: 'a["b"]' }, 'dotted property path'],
    [{ action: 'hook', hook: 'property', path: 'window' }, 'must name a property'],
    [{ action: 'hook', hook: 'fetch', path: 'fetch' }, 'takes no path'],
    [{ action: 'hook', hook: 'function', path: 'f', access: 'get' }, 'property hooks only'],
    [{ action: 'hook', hook: 'xhr', source: 'x' }, 'no source or worldName'],
    [{ action: 'remove' }, 'remove requires id'],
    [{ action: 'patch' }, 'action must be'],
  ])('rejects %j before any CDP IO', async (args, message) => {
    await start();
    calls = [];
    const text = errorText(await inject(args));
    expect(text).toContain('INVALID_ARGUMENT');
    expect(text).toContain(message);
    expect(calls).toEqual([]);
  });

  test('a root registration failure leaves no injection and does not pause children', async () => {
    await start();
    failOn.add('Page.addScriptToEvaluateOnNewDocument@');
    expect(errorText(await inject({ action: 'add', source: 'x' }))).toContain('failed');
    expect(sent('Target.setAutoAttach')).toHaveLength(1);
    expect(body(await inject({ action: 'list' }))).toMatchObject({
      injections: [],
      waitOnStart: false,
    });
  });

  test('child registration failures are reported per child', async () => {
    await start();
    attach(FRAME, 'iframe');
    failOn.add(`Page.enable@${FRAME}`);
    const result = body(await inject({ action: 'add', source: 'x' }));
    expect(result.injection.sessions).toEqual(['root']);
    expect(result.childErrors).toEqual([{ sessionId: FRAME, error: 'Page.enable failed' }]);
  });

  test('a paused new OOPIF is registered before it is resumed; workers are resumed', async () => {
    await start();
    body(await inject({ action: 'hook', hook: 'fetch' }));
    calls = [];
    attach('OOPIF-2', 'iframe', true);
    attach('WORKER-2', 'worker', true);
    await flush();
    const order = calls.map(([method, , sessionId]) => `${method}@${sessionId}`);
    expect(order.filter((entry) => entry.endsWith('OOPIF-2'))).toEqual([
      'Page.enable@OOPIF-2',
      'Runtime.enable@OOPIF-2',
      'Runtime.addBinding@OOPIF-2',
      'Page.addScriptToEvaluateOnNewDocument@OOPIF-2',
      'Runtime.runIfWaitingForDebugger@OOPIF-2',
    ]);
    expect(order.filter((entry) => entry.endsWith('WORKER-2'))).toEqual([
      'Runtime.runIfWaitingForDebugger@WORKER-2',
    ]);
  });

  test('a failed child registration still resumes the child and is listed', async () => {
    await start();
    body(await inject({ action: 'add', source: 'x' }));
    failOn.add('Page.enable@OOPIF-3');
    attach('OOPIF-3', 'iframe', true);
    await flush();
    expect(sent('Runtime.runIfWaitingForDebugger')).toEqual([
      ['Runtime.runIfWaitingForDebugger', {}, 'OOPIF-3'],
    ]);
    expect(body(await inject({ action: 'list' })).errors).toEqual([
      'register in OOPIF-3: Page.enable failed',
    ]);
  });

  test('hook records are buffered as AEB.hook whatever the filter; raw calls never', async () => {
    await start(['Network']);
    const { injection } = body(await inject({ action: 'hook', hook: 'function', path: 'f' }));
    const name = binding();
    emit('Runtime.bindingCalled', {
      name,
      payload: JSON.stringify({ id: injection.id, type: 'installed', phase: 'start', href: 'h' }),
    });
    emit(
      'Runtime.bindingCalled',
      {
        name,
        payload: JSON.stringify({ id: injection.id, type: 'call', args: ['x'], href: 'h' }),
      },
      FRAME,
    );
    emit('Runtime.bindingCalled', { name, payload: '{not json' });
    emit('Runtime.bindingCalled', {
      name,
      payload: JSON.stringify({ id: 'inj-99', type: 'call' }),
    });
    emit('Runtime.bindingCalled', { name: 'pageBinding', payload: '1' });
    const events = body(await session({ action: 'events', after: 0 })).events;
    expect(events.map((event: any) => [event.method, event.sessionId, event.params])).toEqual([
      [
        'AEB.hook',
        undefined,
        { hookId: injection.id, kind: 'function', type: 'installed', phase: 'start', href: 'h' },
      ],
      [
        'AEB.hook',
        FRAME,
        { hookId: injection.id, kind: 'function', type: 'call', args: ['x'], href: 'h' },
      ],
    ]);
    const listed = body(await inject({ action: 'list' }));
    expect(listed.rejectedBindingCalls).toBe(2);
    expect(listed.injections[0]).toMatchObject({ installed: 1, records: 1 });
  });

  test('install failures are kept per hook', async () => {
    await start();
    const { injection } = body(await inject({ action: 'hook', hook: 'function', path: 'f' }));
    emit(
      'Runtime.bindingCalled',
      {
        name: binding(),
        payload: JSON.stringify({ id: injection.id, type: 'failed', error: 'owner', href: 'h' }),
      },
      FRAME,
    );
    expect(body(await inject({ action: 'list' })).injections[0].failures).toEqual([
      { href: 'h', error: 'owner', sessionId: FRAME },
    ]);
  });

  test('remove unregisters everywhere, drops later records, and stops pausing children', async () => {
    await start();
    attach(FRAME, 'iframe');
    const { injection } = body(await inject({ action: 'hook', hook: 'xhr' }));
    calls = [];
    body(await inject({ action: 'remove', id: injection.id }));
    expect(calls).toEqual([
      ['Page.removeScriptToEvaluateOnNewDocument', { identifier: '1' }, undefined],
      ['Page.removeScriptToEvaluateOnNewDocument', { identifier: '2' }, FRAME],
      [
        'Target.setAutoAttach',
        { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
        undefined,
      ],
    ]);
    emit('Runtime.bindingCalled', {
      name: binding(),
      payload: JSON.stringify({ id: injection.id, type: 'xhr' }),
    });
    expect(body(await session({ action: 'events', after: 0 })).events).toEqual([]);
    expect(errorText(await inject({ action: 'remove', id: injection.id }))).toContain(
      'INJECTION_NOT_FOUND',
    );
  });

  test('a detached child drops its registrations', async () => {
    await start();
    attach(FRAME, 'iframe');
    body(await inject({ action: 'add', source: 'x' }));
    emit('Target.detachedFromTarget', { sessionId: FRAME });
    calls = [];
    expect(body(await inject({ action: 'list' })).injections[0].sessions).toEqual(['root']);
    body(await inject({ action: 'remove', id: 'inj-1' }));
    expect(sent('Page.removeScriptToEvaluateOnNewDocument')).toHaveLength(1);
  });

  test('stop forgets injections; a new session starts empty', async () => {
    await start();
    body(await inject({ action: 'add', source: 'x' }));
    body(await session({ action: 'stop' }));
    await start();
    expect(body(await inject({ action: 'list' }))).toMatchObject({
      injections: [],
      waitOnStart: false,
    });
  });

  test('list and remove skip the tab lock; add and hook keep it', () => {
    expect(cdpInjectTool.skipsTargetLock({ action: 'list' })).toBe(true);
    expect(cdpInjectTool.skipsTargetLock({ action: 'remove' })).toBe(true);
    expect(cdpInjectTool.skipsTargetLock({ action: 'add' })).toBe(false);
    expect(cdpInjectTool.skipsTargetLock({ action: 'hook' })).toBe(false);
  });
});

describe('page hook runtime', () => {
  const NAME = '__aeb_test';

  function page(extra: Record<string, unknown> = {}, readyState = 'complete') {
    const messages: any[] = [];
    const listeners: Record<string, Array<() => void>> = {};
    const doc: any = {
      readyState,
      addEventListener: (type: string, fn: () => void) => (listeners[type] ||= []).push(fn),
    };
    const g: any = {
      [NAME]: (payload: string) => messages.push(JSON.parse(payload)),
      location: { href: 'http://page.test/' },
      document: doc,
      addEventListener: (type: string, fn: () => void) => (listeners[type] ||= []).push(fn),
      ...extra,
    };
    const fire = (type: string) => (listeners[type] || []).forEach((fn) => fn());
    return { g, messages, fire, doc };
  }

  function run(g: any, spec: Partial<HookSpec>) {
    const full: HookSpec = {
      id: 'inj-1',
      kind: 'function',
      parts: [],
      access: 'both',
      maxRecords: 100,
      stackDepth: 2,
      sourceUrl: 'aeb-hook://inj-1',
      ...spec,
    };
    // Executes the exact string sent to Chrome: proves the runtime is self-contained.
    new Function('globalThis', hookSource(NAME, full))(g);
  }

  const records = (messages: any[]) => messages.filter((message) => message.type !== 'installed');

  test('function hook records calls, this, return values, throws and construct', () => {
    class Signer {
      value: string;
      constructor(value: string) {
        this.value = value;
      }
    }
    const app = {
      sign(this: any, input: string) {
        return `${input}!`;
      },
      fail() {
        throw new TypeError('nope');
      },
      Signer,
    };
    const { g, messages } = page({ app });
    run(g, { parts: ['app', 'sign'] });
    run(g, { id: 'inj-2', parts: ['app', 'fail'] });
    run(g, { id: 'inj-3', parts: ['app', 'Signer'] });
    expect(g.app.sign('x')).toBe('x!');
    expect(() => g.app.fail()).toThrow('nope');
    expect(new g.app.Signer('v').value).toBe('v');
    expect(messages.filter((message) => message.type === 'installed')).toHaveLength(3);
    const [call, threw, built] = records(messages);
    expect(call).toMatchObject({
      id: 'inj-1',
      type: 'call',
      path: 'app.sign',
      args: ['x'],
      result: 'x!',
      href: 'http://page.test/',
    });
    expect(call.this).toBe('[Object]');
    expect(Array.isArray(call.stack)).toBe(true);
    expect(call.stack.join('\n')).not.toContain('aeb-hook://');
    expect(threw).toMatchObject({
      path: 'app.fail',
      threw: { error: 'TypeError', message: 'nope' },
    });
    expect(built).toMatchObject({ path: 'app.Signer', construct: true, args: ['v'] });
  });

  test('previews are bounded and do not run getters', () => {
    let getterRan = false;
    const arg = {
      long: 'a'.repeat(300),
      get secret() {
        getterRan = true;
        return 's';
      },
      nested: { deeper: { deepest: 1 } },
      list: Array.from({ length: 12 }, (_, i) => i),
      bytes: new Uint8Array(4),
    };
    const { g, messages } = page({ f: (_value: unknown) => undefined });
    run(g, { parts: ['f'] });
    g.f(arg);
    const preview = records(messages)[0].args[0];
    expect(getterRan).toBe(false);
    expect(preview.long).toMatch(/^a{200}\.\.\.\[300 chars\]$/);
    expect(preview.secret).toBe('[getter]');
    expect(preview.nested).toEqual({ deeper: '[Object]' });
    expect(preview.list).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, '...[12 items]']);
    expect(preview.bytes).toBe('[Uint8Array 4 bytes]');
    expect(records(messages)[0].result).toBe('[undefined]');
  });

  test('a missing function is retried after DOMContentLoaded handlers and fails only after load', async () => {
    const late = page({}, 'loading');
    run(late.g, { parts: ['app', 'sign'] });
    expect(late.messages).toEqual([]);
    // The page creates its object in its own DOMContentLoaded handler, registered after ours.
    late.fire('DOMContentLoaded');
    late.g.app = { sign: () => 1 };
    await flush();
    expect(late.messages).toEqual([
      { id: 'inj-1', type: 'installed', phase: 'DOMContentLoaded', href: 'http://page.test/' },
    ]);
    late.fire('load');
    expect(late.messages).toHaveLength(1);

    const never = page({}, 'loading');
    run(never.g, { parts: ['app', 'sign'] });
    never.fire('DOMContentLoaded');
    await flush();
    never.fire('load');
    expect(never.messages).toEqual([
      {
        id: 'inj-1',
        type: 'failed',
        phase: 'load',
        error: 'owner object not found',
        href: 'http://page.test/',
      },
    ]);
  });

  test('a frozen function fails with the reason instead of pretending', () => {
    const app = {};
    Object.defineProperty(app, 'sign', { value: () => 1, writable: false, configurable: false });
    const { g, messages } = page({ app });
    run(g, { parts: ['app', 'sign'] });
    expect(messages).toEqual([
      expect.objectContaining({
        type: 'failed',
        error: 'property is neither configurable nor writable',
      }),
    ]);
  });

  test('property hook observes a global assigned later and keeps its value', () => {
    const { g, messages } = page();
    run(g, { kind: 'property', parts: ['__STATE__'] });
    g.__STATE__ = { user: 1 };
    expect(g.__STATE__).toEqual({ user: 1 });
    expect(records(messages).map((message) => [message.type, message.path, message.value])).toEqual(
      [
        ['set', '__STATE__', { user: 1 }],
        ['get', '__STATE__', { user: 1 }],
      ],
    );
  });

  test('property hook wraps a prototype accessor with the real receiver', () => {
    const jar: string[] = [];
    const proto = {};
    Object.defineProperty(proto, 'cookie', {
      get(this: any) {
        return `${this.tag}:${jar.join(';')}`;
      },
      set(this: any, value: string) {
        jar.push(`${this.tag}=${value}`);
      },
      configurable: true,
    });
    const { g, messages, doc } = page();
    Object.setPrototypeOf(doc, proto);
    doc.tag = 'doc';
    run(g, { kind: 'property', parts: ['document', 'cookie'], access: 'set' });
    g.document.cookie = 'a=1';
    expect(g.document.cookie).toBe('doc:doc=a=1');
    expect(records(messages)).toEqual([
      expect.objectContaining({ type: 'set', path: 'document.cookie', value: 'a=1' }),
    ]);
  });

  test('maxRecords stops a document with a single limit notice', () => {
    const { g, messages } = page({ f: () => 1 });
    run(g, { parts: ['f'], maxRecords: 2, stackDepth: 0 });
    for (let i = 0; i < 5; i++) g.f(i);
    expect(records(messages).map((message) => message.type)).toEqual(['call', 'call', 'limit']);
    expect(records(messages)[0].stack).toBeUndefined();
  });

  test('fetch hook records header names, never values, and keeps rejections unhandled', async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.includes('fail')) throw new TypeError('network');
      return { status: 201 };
    });
    const { g, messages } = page({ fetch });
    run(g, { kind: 'fetch' });
    const response = await g.fetch('/api/sign', {
      method: 'post',
      headers: { Authorization: 'Bearer secret', 'X-Sign': 'abc' },
      body: '{"a":1}',
    });
    expect(response.status).toBe(201);
    await expect(g.fetch('/fail')).rejects.toThrow('network');
    const [ok, failed] = records(messages);
    expect(ok).toMatchObject({
      type: 'fetch',
      method: 'POST',
      url: '/api/sign',
      headerNames: ['Authorization', 'X-Sign'],
      body: '{"a":1}',
      status: 201,
    });
    expect(JSON.stringify(ok)).not.toContain('secret');
    expect(failed).toMatchObject({ url: '/fail', rejected: { error: 'TypeError' } });
  });

  test('xhr hook records the request once it ends', () => {
    class FakeXhr {
      status = 0;
      listeners: Array<() => void> = [];
      open(_method: string, _url: string) {}
      setRequestHeader(_name: string, _value: string) {}
      send(_body?: unknown) {}
      addEventListener(_type: string, fn: () => void) {
        this.listeners.push(fn);
      }
    }
    const { g, messages } = page({ XMLHttpRequest: FakeXhr });
    run(g, { kind: 'xhr' });
    const xhr = new g.XMLHttpRequest();
    xhr.open('get', '/data');
    xhr.setRequestHeader('X-Token', 'value');
    xhr.send();
    expect(records(messages)).toEqual([]);
    xhr.status = 200;
    xhr.listeners.forEach((fn: () => void) => fn());
    expect(records(messages)).toEqual([
      expect.objectContaining({
        type: 'xhr',
        method: 'GET',
        url: '/data',
        headerNames: ['X-Token'],
        status: 200,
      }),
    ]);
    expect(JSON.stringify(messages)).not.toContain('value');
  });
});
