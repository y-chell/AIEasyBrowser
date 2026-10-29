import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cdpDebuggerTool } from './cdp-debugger';
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
let detachListeners: Array<(source: any, reason: string) => void>;
let calls: Array<[string, any, string | undefined]>;
/** Fake V8 skipAllPauses per session ('' = page), as set by the tool. */
let skip: Map<string, boolean>;
let pauseRequested: Set<string>;

const A = { owner: 'cli:A', strictTarget: true };
const B = { owner: 'cli:B', strictTarget: true };
const APP = 'http://app.test/app.js';

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

const dbg = (args: Record<string, unknown>, context: any = A) =>
  cdpDebuggerTool.execute({ tabId: 7, ...args } as any, context);

function frame(id: string, line: number, scriptId = '20') {
  return {
    callFrameId: id,
    functionName: 'compute',
    location: { scriptId, lineNumber: line, columnNumber: 4 },
    url: '',
    scopeChain: [
      { type: 'local', object: { type: 'object', objectId: `scope-local-${id}` } },
      { type: 'global', object: { type: 'object', objectId: 'scope-global' } },
    ],
    this: { type: 'object', className: 'Window', description: 'Window', objectId: 'this-1' },
  };
}

/** Emits Debugger.paused the way V8 does: only when pauses are not skipped. */
function hit(line: number, extra: Record<string, unknown> = {}, sessionId?: string) {
  if (skip.get(sessionId ?? '') !== false) return false;
  emit(
    'Debugger.paused',
    { reason: 'other', callFrames: [frame(`f${line}`, line), frame('outer', 30)], ...extra },
    sessionId,
  );
  return true;
}

const PROPS: Record<string, any> = {
  'scope-local-f12': {
    result: [
      { name: 'input', value: { type: 'number', value: 21, description: '21' } },
      { name: 'token', value: { type: 'string', value: 'abc-secret' } },
      {
        name: 'cfg',
        value: { type: 'object', className: 'Object', description: 'Object', objectId: 'cfg-1' },
      },
    ],
  },
  'cfg-1': {
    result: [
      { name: 'mode', value: { type: 'string', value: 'fast' } },
      { name: 'password', value: { type: 'string', value: 'hunter2' } },
      { name: 'size', get: { type: 'function' } },
    ],
    internalProperties: [
      { name: '[[Prototype]]', value: { type: 'object', description: 'Object', objectId: 'p' } },
    ],
  },
};

async function startSession() {
  body(await cdpSessionTool.execute({ tabId: 7, action: 'start' } as any, A));
}

beforeEach(() => {
  vi.clearAllMocks();
  clearCdpSessionsForTest();
  eventListeners = [];
  detachListeners = [];
  calls = [];
  skip = new Map();
  pauseRequested = new Set();
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
      const key = sessionId ?? '';
      switch (method) {
        case 'Debugger.enable':
          if (!sessionId) {
            emit('Debugger.scriptParsed', {
              scriptId: '20',
              url: APP,
              startLine: 0,
              startColumn: 0,
              endLine: 40,
              endColumn: 0,
              executionContextId: 1,
              hash: 'h',
              executionContextAuxData: { isDefault: true, type: 'default', frameId: 'F0' },
            });
          }
          return { debuggerId: 'd' };
        case 'Debugger.setSkipAllPauses':
          skip.set(key, params.skip);
          return {};
        case 'Debugger.setBreakpointByUrl':
          return {
            breakpointId: `1:${params.lineNumber}:0:${params.url ?? params.urlRegex}`,
            locations: [{ scriptId: '20', lineNumber: params.lineNumber, columnNumber: 4 }],
          };
        case 'Debugger.setBreakpoint':
          return {
            breakpointId: '20:5:0',
            actualLocation: { ...params.location, columnNumber: 2 },
          };
        case 'Debugger.pause':
          pauseRequested.add(key);
          return {};
        case 'Debugger.resume':
          emit('Debugger.resumed', {}, sessionId);
          return {};
        case 'Debugger.stepOver':
          emit('Debugger.resumed', {}, sessionId);
          hit(13, { reason: 'step' }, sessionId);
          return {};
        case 'Debugger.stepOut':
          // Runs to completion: no further pause.
          emit('Debugger.resumed', {}, sessionId);
          return {};
        case 'Debugger.evaluateOnCallFrame':
          if (params.expression === 'boom()') {
            return {
              result: { type: 'object', subtype: 'error', objectId: 'err' },
              exceptionDetails: {
                text: 'Uncaught',
                exception: { description: 'ReferenceError: boom' },
              },
            };
          }
          return { result: { type: 'number', value: 42, description: '42' } };
        case 'Runtime.getProperties':
          return PROPS[params.objectId] ?? { result: [] };
        default:
          return {};
      }
    },
  );
});
afterEach(() => {
  clearCdpSessionsForTest();
  vi.unstubAllGlobals();
});

const waiterRegistered = () => vi.waitFor(() => expect(peekSession(7)?.debug.waiters.size).toBe(1));

const sent = (method: string) => calls.filter(([name]) => name === method);

describe('chrome_cdp_debugger preconditions', () => {
  test('requires a held session of the same task and validates before IO', async () => {
    expect(errorText(await dbg({ action: 'status' }))).toContain('CDP_SESSION_NOT_STARTED');
    await startSession();
    expect(errorText(await dbg({ action: 'status' }, B))).toContain('CDP_SESSION_OWNED');
    for (const args of [
      { action: 'setBreakpoint', url: APP },
      { action: 'setBreakpoint', url: APP, scriptId: '20', line: 1 },
      { action: 'setBreakpoint', xhrUrl: '', line: 3 },
      { action: 'setBreakpoint', urlRegex: '(', line: 1 },
      { action: 'removeBreakpoint' },
      { action: 'evaluate' },
      { action: 'properties' },
      { action: 'blackbox', patterns: ['['] },
      { action: 'jump' },
    ]) {
      expect(errorText(await dbg(args)), JSON.stringify(args)).toContain('INVALID_ARGUMENT');
    }
    expect(sent('Debugger.enable')).toHaveLength(0);
    expect(errorText(await dbg({ action: 'wait', sessionId: 'nope' }))).toContain(
      'CDP_UNKNOWN_SESSION',
    );
  });
});

describe('chrome_cdp_debugger breakpoints', () => {
  test('url breakpoint arms the session and removing the last one disarms it', async () => {
    await startSession();
    const set = body(await dbg({ action: 'setBreakpoint', url: APP, line: 12 })).breakpoint;
    expect(set).toMatchObject({
      id: `1:12:0:${APP}`,
      kind: 'line',
      url: APP,
      line: 12,
      resolved: true,
      locations: [{ scriptId: '20', line: 12, column: 4 }],
      hits: 0,
    });
    // B2 enabled with skip; arming turns it off only after the breakpoint exists.
    const order = calls.map(([method, params]) =>
      method === 'Debugger.setSkipAllPauses' ? `skip:${params.skip}` : method,
    );
    expect(order.indexOf('Debugger.setBreakpointByUrl')).toBeLessThan(
      order.lastIndexOf('skip:false'),
    );
    expect(skip.get('')).toBe(false);
    const status = body(await dbg({ action: 'status' }));
    expect(status).toMatchObject({ paused: false, armed: ['page'] });
    expect(status.breakpoints.map((b: any) => b.id)).toEqual([set.id]);

    body(await dbg({ action: 'removeBreakpoint', breakpointId: set.id }));
    expect(sent('Debugger.removeBreakpoint')[0][1]).toEqual({ breakpointId: set.id });
    expect(skip.get('')).toBe(true);
    expect(errorText(await dbg({ action: 'removeBreakpoint', breakpointId: set.id }))).toContain(
      'BREAKPOINT_NOT_FOUND',
    );
  });

  test('condition and logMessage become one CDP condition', async () => {
    await startSession();
    await dbg({ action: 'setBreakpoint', url: APP, line: 3, condition: 'x > 2' });
    await dbg({ action: 'setBreakpoint', url: APP, line: 4, logMessage: "'v', x" });
    await dbg({ action: 'setBreakpoint', url: APP, line: 5, condition: 'x', logMessage: 'x' });
    expect(sent('Debugger.setBreakpointByUrl').map(([, params]) => params.condition)).toEqual([
      'x > 2',
      "(console.log('v', x\n), false)",
      '(x\n) && (console.log(x\n), false)',
    ]);
  });

  test('scriptId, xhr, and event breakpoints use their own CDP methods', async () => {
    await startSession();
    expect(errorText(await dbg({ action: 'setBreakpoint', scriptId: '99', line: 1 }))).toContain(
      'SCRIPT_NOT_FOUND',
    );
    const byScript = body(await dbg({ action: 'setBreakpoint', scriptId: '20', line: 5 }));
    expect(byScript.breakpoint).toMatchObject({ id: '20:5:0', scriptId: '20', resolved: true });
    const xhr = body(await dbg({ action: 'setBreakpoint', xhrUrl: '/api/sign' })).breakpoint;
    const event = body(await dbg({ action: 'setBreakpoint', eventName: 'click' })).breakpoint;
    expect([xhr.id, event.id]).toEqual(['xhr:/api/sign', 'event:*:click']);
    expect(sent('DOMDebugger.setXHRBreakpoint')[0][1]).toEqual({ url: '/api/sign' });
    expect(sent('DOMDebugger.setEventListenerBreakpoint')[0][1]).toEqual({ eventName: 'click' });
    body(await dbg({ action: 'removeBreakpoint', breakpointId: xhr.id }));
    body(await dbg({ action: 'removeBreakpoint', breakpointId: event.id }));
    expect(sent('DOMDebugger.removeXHRBreakpoint')[0][1]).toEqual({ url: '/api/sign' });
    expect(sent('DOMDebugger.removeEventListenerBreakpoint')[0][1]).toEqual({ eventName: 'click' });
    expect(skip.get('')).toBe(false);
  });
});

describe('chrome_cdp_debugger pauses', () => {
  test('wait returns the breakpoint pause with frames, scopes, and hit counts', async () => {
    await startSession();
    const bp = body(await dbg({ action: 'setBreakpoint', url: APP, line: 12 })).breakpoint;
    expect(body(await dbg({ action: 'wait', timeoutMs: 0 }))).toMatchObject({
      paused: false,
      timedOut: true,
    });
    const waiting = dbg({ action: 'wait', timeoutMs: 5000 });
    expect(hit(12, { hitBreakpoints: [bp.id] })).toBe(true);
    const waited = body(await waiting);
    expect(waited.paused).toBe(true);
    expect(waited.pause).toMatchObject({
      seq: 1,
      reason: 'other',
      hitBreakpoints: [bp.id],
      totalFrames: 2,
    });
    expect(waited.pause.frames[0]).toMatchObject({
      index: 0,
      functionName: 'compute',
      location: { scriptId: '20', line: 12, column: 4, url: APP },
      scopes: [
        { index: 0, type: 'local', objectId: 'scope-local-f12' },
        { index: 1, type: 'global', objectId: 'scope-global' },
      ],
      this: { type: 'object', className: 'Window', objectId: 'this-1' },
    });
    // An existing pause answers immediately; after=seq waits for a newer one.
    expect(body(await dbg({ action: 'wait' })).pause.seq).toBe(1);
    expect(body(await dbg({ action: 'wait', after: 1, timeoutMs: 0 })).timedOut).toBe(true);
    const status = body(await dbg({ action: 'status' }));
    expect(status.paused).toBe(true);
    expect(status.breakpoints[0].hits).toBe(1);
    expect(
      body(await cdpSessionTool.execute({ tabId: 7, action: 'status' } as any, A)).paused,
    ).toEqual([{ reason: 'other', seq: 1 }]);
  });

  test('evaluate and properties read the paused frame; resume releases and disarms', async () => {
    await startSession();
    const bp = body(await dbg({ action: 'setBreakpoint', url: APP, line: 12 })).breakpoint;
    hit(12);
    const value = body(await dbg({ action: 'evaluate', expression: 'input * 2' }));
    expect(value).toMatchObject({
      pauseSeq: 1,
      frameIndex: 0,
      result: { type: 'number', value: 42 },
    });
    expect(sent('Debugger.evaluateOnCallFrame')[0][1]).toMatchObject({
      callFrameId: 'f12',
      objectGroup: 'aeb-debugger',
      silent: true,
      returnByValue: false,
    });
    expect(
      body(await dbg({ action: 'evaluate', expression: 'boom()', frameIndex: 1 })),
    ).toMatchObject({
      frameIndex: 1,
      exception: 'ReferenceError: boom',
    });
    expect(sent('Debugger.evaluateOnCallFrame')[1][1].callFrameId).toBe('outer');
    expect(errorText(await dbg({ action: 'evaluate', expression: '1', frameIndex: 5 }))).toContain(
      'FRAME_NOT_FOUND',
    );

    const props = body(await dbg({ action: 'properties', scopeIndex: 0, depth: 1 }));
    expect(props).toMatchObject({ scopeType: 'local', objectId: 'scope-local-f12' });
    expect(props.properties).toEqual([
      { name: 'input', value: { type: 'number', value: 21 } },
      { name: 'token', value: { type: 'string', value: '<redacted>', redacted: true } },
      {
        name: 'cfg',
        value: { type: 'object', className: 'Object', description: 'Object', objectId: 'cfg-1' },
        properties: [
          { name: 'mode', value: { type: 'string', value: 'fast' } },
          { name: 'password', value: { type: 'string', value: '<redacted>', redacted: true } },
          { name: 'size', accessor: true },
          {
            name: '[[Prototype]]',
            kind: 'internal',
            value: { type: 'object', description: 'Object', objectId: 'p' },
          },
        ],
      },
    ]);
    const raw = body(await dbg({ action: 'properties', scopeIndex: 0, sanitizeOutput: false }));
    expect(raw.properties[1].value.value).toBe('abc-secret');
    const capped = body(await dbg({ action: 'properties', objectId: 'cfg-1', maxProperties: 2 }));
    expect(capped.properties).toHaveLength(2);
    expect(capped.truncated).toBe(true);

    expect(body(await dbg({ action: 'resume' }))).toEqual(
      expect.objectContaining({ resumed: true }),
    );
    expect(sent('Runtime.releaseObjectGroup')[0][1]).toEqual({ objectGroup: 'aeb-debugger' });
    // The breakpoint keeps the page armed.
    expect(skip.get('')).toBe(false);
    expect(errorText(await dbg({ action: 'resume' }))).toContain('DEBUGGER_NOT_PAUSED');
    body(await dbg({ action: 'removeBreakpoint', breakpointId: bp.id }));
    expect(skip.get('')).toBe(true);
  });

  test('steps return the next pause or running', async () => {
    await startSession();
    await dbg({ action: 'setBreakpoint', url: APP, line: 12 });
    hit(12);
    const stepped = body(await dbg({ action: 'stepOver' }));
    expect(stepped).toMatchObject({ paused: true, pause: { seq: 2, reason: 'step' } });
    expect(stepped.pause.frames[0].location.line).toBe(13);
    const out = body(await dbg({ action: 'stepOut', timeoutMs: 0 }));
    expect(out).toMatchObject({ paused: false, running: true });
    expect(body(await dbg({ action: 'status' })).paused).toBe(false);
    expect(errorText(await dbg({ action: 'stepInto' }))).toContain('DEBUGGER_NOT_PAUSED');
  });

  test('pause on an idle page stays pending until resume cancels it', async () => {
    await startSession();
    const pending = body(await dbg({ action: 'pause', timeoutMs: 0 }));
    expect(pending).toMatchObject({ paused: false, pending: true });
    expect(skip.get('')).toBe(false);
    expect(body(await dbg({ action: 'status' })).pausePending).toEqual(['page']);
    expect(body(await dbg({ action: 'resume' }))).toMatchObject({
      resumed: false,
      cancelledPause: true,
    });
    expect(skip.get('')).toBe(true);
    pauseRequested.clear();

    const paused = dbg({ action: 'pause', timeoutMs: 5000 });
    await vi.waitFor(() => expect(pauseRequested.has('')).toBe(true));
    hit(12, { reason: 'other' });
    expect(body(await paused)).toMatchObject({ paused: true, pause: { seq: 1 } });
    body(await dbg({ action: 'resume' }));
    expect(skip.get('')).toBe(true);
  });

  test('resume disarms a session left armed by a step that ran to completion', async () => {
    await startSession();
    const paused = dbg({ action: 'pause', timeoutMs: 5000 });
    await vi.waitFor(() => expect(pauseRequested.has('')).toBe(true));
    hit(12);
    body(await paused);
    expect(body(await dbg({ action: 'stepOut', timeoutMs: 0 })).running).toBe(true);
    expect(body(await dbg({ action: 'status' })).armed).toEqual(['page']);
    expect(body(await dbg({ action: 'resume' }))).toEqual(
      expect.objectContaining({ resumed: false, disarmed: ['page'] }),
    );
    expect(skip.get('')).toBe(true);
    expect(errorText(await dbg({ action: 'resume' }))).toContain('DEBUGGER_NOT_PAUSED');
  });

  test('child sessions pause independently', async () => {
    await startSession();
    emit('Target.attachedToTarget', {
      sessionId: 'W1',
      targetInfo: { targetId: 't1', type: 'worker', url: 'blob:x' },
    });
    // Children attached before the first debugger call are enabled by it.
    body(await dbg({ action: 'status' }));
    await vi.waitFor(() =>
      expect(sent('Debugger.enable').some(([, , s]) => s === 'W1')).toBe(true),
    );
    await dbg({ action: 'setBreakpoint', url: APP, line: 12 });
    const worker = body(
      await dbg({ action: 'setBreakpoint', url: 'blob:x', line: 0, sessionId: 'W1' }),
    );
    expect(worker.breakpoint.sessionId).toBe('W1');
    expect(skip.get('W1')).toBe(false);
    const waiting = dbg({ action: 'wait', timeoutMs: 5000 });
    hit(0, {}, 'W1');
    expect(body(await waiting).pause.sessionId).toBe('W1');
    hit(12);
    expect(errorText(await dbg({ action: 'evaluate', expression: '1' }))).toContain(
      'DEBUGGER_AMBIGUOUS',
    );
    body(await dbg({ action: 'resume', sessionId: 'W1' }));
    expect(sent('Debugger.resume').at(-1)![2]).toBe('W1');
    expect(body(await dbg({ action: 'evaluate', expression: '1' })).sessionId).toBeUndefined();
    emit('Target.detachedFromTarget', { sessionId: 'W1' });
    expect(
      body(await dbg({ action: 'status' })).breakpoints.map((b: any) => b.sessionId ?? 'page'),
    ).toEqual(['page']);
  });

  test('blackbox replaces the pattern list', async () => {
    await startSession();
    body(await dbg({ action: 'blackbox', patterns: ['vendor\\.js$'] }));
    expect(body(await dbg({ action: 'status' })).blackbox).toEqual([
      { patterns: ['vendor\\.js$'] },
    ]);
    body(await dbg({ action: 'blackbox', patterns: [] }));
    expect(sent('Debugger.setBlackboxPatterns').map(([, params]) => params.patterns)).toEqual([
      ['vendor\\.js$'],
      [],
    ]);
    expect(body(await dbg({ action: 'status' })).blackbox).toBeUndefined();
  });
});

describe('chrome_cdp_debugger lifecycle', () => {
  test('stop while paused skips pauses and resumes before disabling Debugger', async () => {
    await startSession();
    await dbg({ action: 'setBreakpoint', url: APP, line: 12 });
    hit(12);
    await dbg({ action: 'evaluate', expression: 'input' });
    const waiting = dbg({ action: 'wait', after: 1, timeoutMs: 5000 }, A);
    await waiterRegistered();
    calls = [];
    body(await cdpSessionTool.execute({ tabId: 7, action: 'stop' } as any, A));
    const order = calls.map(([method, params]) =>
      method === 'Debugger.setSkipAllPauses' ? `skip:${params.skip}` : method,
    );
    expect(order.slice(0, 4)).toEqual([
      'skip:true',
      'Debugger.resume',
      'Runtime.releaseObjectGroup',
      'Debugger.disable',
    ]);
    expect(errorText(await waiting)).toContain('CDP_SESSION_ENDED');
  });

  test('Chrome detach ends a pending wait', async () => {
    await startSession();
    const waiting = dbg({ action: 'wait', timeoutMs: 5000 });
    await waiterRegistered();
    for (const listener of detachListeners) listener({ tabId: 7 }, 'canceled_by_user');
    expect(errorText(await waiting)).toContain('CDP_SESSION_ENDED');
  });
});

describe('target lock', () => {
  test('debugger control skips the tab lock; session start keeps it', async () => {
    const { cdpScriptsTool } = await import('./cdp-scripts');
    expect(cdpDebuggerTool.skipsTargetLock()).toBe(true);
    expect(cdpScriptsTool.skipsTargetLock()).toBe(true);
    expect(cdpSessionTool.skipsTargetLock({ action: 'stop' })).toBe(true);
    expect(cdpSessionTool.skipsTargetLock({ action: 'start' })).toBe(false);
  });
});
