import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cdpProfileTool } from './cdp-profile';
import { cdpSessionTool } from './cdp-session';
import { performanceStartTraceTool } from './performance';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { clearCdpSessionsForTest, peekSession } from '@/utils/cdp-event-hub';
import { addRange, buildCpuProfile, summarizeProfile } from '@/utils/cdp-profile';
import { resetTracingLockForTest } from '@/utils/cdp-tracing-lock';

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
let failOn: Map<string, Error>;
let results: Map<string, unknown>;
let downloads: Array<{ url: string; filename: string }>;
let traceValues: any[];
let coverage: Map<string, any[]>;

const A = { owner: 'cli:A', strictTarget: true };
const CHILD = 'OOPIF-1';
const WORKER = 'WORKER-1';
const ROOT_FRAME = 'F-ROOT';

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

const profile = (args: Record<string, unknown>, context: any = A) =>
  cdpProfileTool.execute({ tabId: 7, ...args } as any, context);
const session = (args: Record<string, unknown>, context: any = A) =>
  cdpSessionTool.execute({ tabId: 7, ...args } as any, context);
const sent = (method: string) => calls.filter((call) => call[0] === method);

async function start() {
  body(await session({ action: 'start' }));
  emit('Target.attachedToTarget', {
    sessionId: CHILD,
    targetInfo: { targetId: 'T-OOPIF', type: 'iframe', url: 'http://localhost:8000/child' },
    waitingForDebugger: false,
  });
  emit('Target.attachedToTarget', {
    sessionId: WORKER,
    targetInfo: { targetId: 'T-WORKER', type: 'worker', url: 'http://127.0.0.1:8000/w.js' },
    waitingForDebugger: false,
  });
  calls = [];
}

const frame = (id: number, functionName: string, extra: object = {}, parent?: number) => ({
  id,
  callFrame: { functionName, scriptId: 0, codeType: 'JS', ...extra },
  ...(parent !== undefined ? { parent } : {}),
});

const APP = { scriptId: 5, url: 'http://127.0.0.1:8000/app.js?token=abcdefghijklmnopqrst' };

function pageTrace() {
  return [
    { name: 'thread_name', pid: 10, tid: 11, args: { name: 'CrRendererMain' } },
    { name: 'Profile', pid: 10, tid: 11, id: '0x1', args: { data: { startTime: 1000 } } },
    {
      name: 'ProfileChunk',
      pid: 10,
      tid: 12,
      id: '0x1',
      args: {
        data: {
          cpuProfile: {
            nodes: [
              frame(1, '(root)'),
              frame(2, '(program)', {}, 1),
              frame(3, '', APP, 1),
              frame(4, 'hot', { ...APP, lineNumber: 1, columnNumber: 5 }, 3),
            ],
            samples: [4, 4],
          },
          timeDeltas: [100, 1000],
        },
      },
    },
    {
      // Nodes keep arriving in later chunks.
      name: 'ProfileChunk',
      pid: 10,
      tid: 12,
      id: '0x1',
      args: {
        data: {
          cpuProfile: {
            nodes: [
              frame(5, 'leaf', { ...APP, lineNumber: 2, columnNumber: 6 }, 4),
              frame(6, '(idle)', {}, 1),
            ],
            samples: [5, 6, 2],
          },
          timeDeltas: [1000, 1000, 1000],
        },
      },
    },
    { name: 'FunctionCall', pid: 10, tid: 11, args: { data: { frame: ROOT_FRAME } } },
    { name: 'FunctionCall', pid: 10, tid: 11, args: { data: { frame: 'F-OTHER-TAB' } } },
    // Worker thread, attributed by TracingSessionIdForWorker.
    {
      name: 'TracingSessionIdForWorker',
      pid: 10,
      tid: 20,
      args: { data: { frame: ROOT_FRAME, workerId: 'T-WORKER', workerThreadId: 20 } },
    },
    { name: 'Profile', pid: 10, tid: 20, id: '0x2', args: { data: { startTime: 2000 } } },
    {
      name: 'ProfileChunk',
      pid: 10,
      tid: 21,
      id: '0x2',
      args: {
        data: {
          cpuProfile: {
            nodes: [
              frame(1, '(root)'),
              frame(2, 'self.onmessage', { scriptId: 3, url: 'http://127.0.0.1:8000/w.js' }, 1),
            ],
            samples: [2, 2],
          },
          timeDeltas: [0, 500],
        },
      },
    },
    // OOPIF process without frame events: attributed by script origin.
    { name: 'Profile', pid: 30, tid: 31, id: '0x1', args: { data: { startTime: 3000 } } },
    {
      name: 'ProfileChunk',
      pid: 30,
      tid: 32,
      id: '0x1',
      args: {
        data: {
          cpuProfile: {
            nodes: [
              frame(1, '(root)'),
              frame(2, 'childHot', { scriptId: 9, url: 'http://localhost:8000/child' }, 1),
            ],
            samples: [2],
          },
          timeDeltas: [0],
        },
      },
    },
    // A thread that never sampled.
    { name: 'Profile', pid: 10, tid: 99, id: '0x3', args: { data: { startTime: 1 } } },
    { name: 'RunTask', pid: 10, tid: 11, args: {} },
  ];
}

const SHEETS: Record<string, any[]> = {
  '': [
    {
      styleSheetId: 's1',
      sourceURL: 'http://127.0.0.1:8000/style.css',
      origin: 'regular',
      length: 100,
    },
    {
      styleSheetId: 's2',
      sourceURL: 'http://127.0.0.1:8000/',
      origin: 'regular',
      isInline: true,
      startLine: 2,
      startColumn: 7,
      length: 50,
    },
  ],
  [CHILD]: [{ styleSheetId: 'c1', sourceURL: 'http://localhost:8000/child', length: 40 }],
};

let counts: Record<string, number>;

beforeEach(() => {
  vi.clearAllMocks();
  clearCdpSessionsForTest();
  resetTracingLockForTest();
  eventListeners = [];
  detachListeners = [];
  calls = [];
  failOn = new Map();
  results = new Map();
  downloads = [];
  traceValues = pageTrace();
  coverage = new Map();
  counts = { Map: 3, 'app.Leak': 10 };
  vi.stubGlobal('chrome', {
    tabs: {
      get: vi.fn(async (id: number) =>
        id === 7
          ? { id, windowId: 1, url: 'http://127.0.0.1:8000/' }
          : Promise.reject(new Error('No tab')),
      ),
      query: vi.fn(async () => [
        { id: 7, windowId: 1, active: true, url: 'http://127.0.0.1:8000/' },
      ]),
      onRemoved: { addListener: vi.fn() },
    },
    windows: { getLastFocused: vi.fn(async () => ({ id: 1 })) },
    debugger: {
      onEvent: {
        addListener: (fn: EventListener) => eventListeners.push(fn),
        removeListener: (fn: EventListener) =>
          (eventListeners = eventListeners.filter((item) => item !== fn)),
      },
      onDetach: { addListener: (fn: any) => detachListeners.push(fn) },
    },
    runtime: { getManifest: () => ({ version: '9.9.9' }) },
    downloads: {
      download: vi.fn(async (options: { url: string; filename: string }) => {
        downloads.push(options);
        return downloads.length;
      }),
      search: vi.fn(async ({ id }: { id: number }) => [
        { id, state: 'complete', filename: `E:\\Download\\${downloads[id - 1].filename}` },
      ]),
    },
  });
  vi.mocked(cdpSessionManager.attach).mockResolvedValue(undefined);
  vi.mocked(cdpSessionManager.detach).mockResolvedValue(undefined);
  vi.mocked(cdpSessionManager.sendCommand).mockImplementation(
    async (_tabId: number, method: string, params?: any, sessionId?: string) => {
      const key = sessionId ?? '';
      calls.push([method, params, sessionId]);
      const failure = failOn.get(`${method}@${key}`);
      if (failure) throw failure;
      if (results.has(`${method}@${key}`)) return results.get(`${method}@${key}`);
      switch (method) {
        case 'Page.getFrameTree':
          return {
            frameTree: {
              frame: { id: ROOT_FRAME, url: 'http://127.0.0.1:8000/' },
              childFrames: [{ frame: { id: 'F-SAME', url: 'http://127.0.0.1:8000/same' } }],
            },
          };
        case 'CSS.enable':
          for (const header of SHEETS[key] || [])
            emit('CSS.styleSheetAdded', { header }, sessionId);
          return {};
        case 'CSS.takeCoverageDelta': {
          const delta = coverage.get(key) || [];
          coverage.delete(key);
          return { coverage: delta, timestamp: 1 };
        }
        case 'CSS.stopRuleUsageTracking':
          return { ruleUsage: coverage.get(`${key}/final`) || [] };
        case 'Tracing.end':
          queueMicrotask(() => {
            emit('Tracing.dataCollected', { value: traceValues });
            emit('Tracing.tracingComplete', { dataLossOccurred: false });
          });
          return {};
        case 'Runtime.evaluate': {
          const path = /globalThis\.([\w.$]+);/.exec(params.expression)?.[1] ?? '';
          return path in counts
            ? { result: { type: 'object', objectId: `proto:${path}` } }
            : { result: { type: 'undefined' } };
        }
        case 'Runtime.queryObjects':
          return { objects: { objectId: `found:${params.prototypeObjectId.slice(6)}` } };
        case 'Runtime.callFunctionOn':
          return { result: { value: counts[params.objectId.slice(6)] } };
        case 'Runtime.getHeapUsage':
          return { usedSize: 1000 + counts.Map, totalSize: 4000, embedderHeapUsedSize: 7 };
        default:
          return {};
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('chrome_cdp_profile', () => {
  test('requires a held session and rejects bad arguments before CDP IO', async () => {
    expect(errorText(await profile({ action: 'status' }, {}))).toContain('CDP_SESSION_NOT_STARTED');
    expect(errorText(await profile({ action: 'status' }))).toContain('CDP_SESSION_NOT_STARTED');
    await start();
    const rejected = [
      { action: 'snapshot' },
      { action: 'cpuStart', top: 5 },
      { action: 'heapSample' },
      { action: 'heapSample', constructors: ['Map; alert(1)'] },
      { action: 'heapSample', constructors: ['a..b'] },
      { action: 'heapDiff', from: 1 },
      { action: 'cssReport', constructors: ['Map'] },
    ];
    for (const args of rejected) {
      expect(errorText(await profile(args))).toContain('INVALID_ARGUMENT');
    }
    expect(calls).toEqual([]);
    expect(errorText(await profile({ action: 'cssReport' }))).toContain('CSS_COVERAGE_NOT_STARTED');
    expect(errorText(await profile({ action: 'cpuStop' }))).toContain('CPU_PROFILE_NOT_STARTED');
  });

  test('CSS coverage merges deltas per sheet in the page and the OOPIF', async () => {
    await start();
    const started = body(await profile({ action: 'cssStart' }));
    expect(started.sessions).toEqual(['root', CHILD]);
    // Not tracked in the worker, which has no CSS domain.
    expect(sent('CSS.startRuleUsageTracking').map((call) => call[2])).toEqual([undefined, CHILD]);
    expect(errorText(await profile({ action: 'cssStart' }))).toContain('CSS_COVERAGE_ACTIVE');

    coverage.set('', [
      { styleSheetId: 's1', startOffset: 0, endOffset: 20, used: true },
      { styleSheetId: 's1', startOffset: 10, endOffset: 30, used: true },
      { styleSheetId: 's2', startOffset: 0, endOffset: 50, used: true },
      { styleSheetId: 'ghost', startOffset: 0, endOffset: 5, used: true },
    ]);
    coverage.set(CHILD, [{ styleSheetId: 'c1', startOffset: 0, endOffset: 10, used: true }]);
    const first = body(await profile({ action: 'cssReport' }));
    expect(
      first.sheets.map((sheet: any) => [sheet.styleSheetId, sheet.usedChars, sheet.unusedChars]),
    ).toEqual([
      ['s1', 30, 70],
      ['c1', 10, 30],
      ['s2', 50, 0],
    ]);
    expect(first.totals).toMatchObject({
      sheets: 3,
      totalChars: 190,
      usedChars: 90,
      unusedChars: 100,
    });
    expect(first.sheets[1].sessionId).toBe(CHILD);
    expect(first.sheets[2]).toMatchObject({ inline: true, startLine: 2, startColumn: 7 });
    expect(first.unknownSheetRules).toBe(1);

    // The final usage from stop is merged; the report then stays readable.
    coverage.set('/final', [{ styleSheetId: 's1', startOffset: 30, endOffset: 40, used: true }]);
    calls = [];
    const stopped = body(await profile({ action: 'cssStop', sessionId: 'root' }));
    expect(stopped.tracking).toBe(false);
    expect(stopped.sheets.map((sheet: any) => [sheet.styleSheetId, sheet.usedChars])).toEqual([
      ['s1', 40],
      ['s2', 50],
    ]);
    expect(sent('CSS.disable').map((call) => call[2])).toEqual([undefined, CHILD]);
    expect(body(await profile({ action: 'cssReport', url: 'child' })).sheets).toHaveLength(1);
    expect(errorText(await profile({ action: 'cssStop' }))).toContain('CSS_COVERAGE_NOT_STARTED');
  });

  test('a failed root cssStart leaves nothing tracking', async () => {
    await start();
    failOn.set('CSS.startRuleUsageTracking@', new Error('boom'));
    expect(errorText(await profile({ action: 'cssStart' }))).toContain('CSS_COVERAGE_FAILED');
    expect(body(await profile({ action: 'status' })).css.tracking).toBe(false);
    failOn.clear();
    failOn.set(`CSS.enable@${CHILD}`, new Error('child gone'));
    const started = body(await profile({ action: 'cssStart' }));
    expect(started.sessions).toEqual(['root']);
    expect(started.childErrors[0]).toContain('child gone');
  });

  test('ranges merge without double counting', () => {
    const ranges: Array<[number, number]> = [];
    addRange(ranges, 10, 20);
    addRange(ranges, 30, 40);
    addRange(ranges, 15, 35);
    addRange(ranges, 50, 50);
    addRange(ranges, 0, 5);
    expect(ranges).toEqual([
      [0, 5],
      [10, 40],
    ]);
  });

  test('cpuStop writes one .cpuprofile per sampled thread and attributes it', async () => {
    body(await session({ action: 'start', events: ['Tracing'] }));
    emit('Target.attachedToTarget', {
      sessionId: CHILD,
      targetInfo: { targetId: 'T-OOPIF', type: 'iframe', url: 'http://localhost:8000/child' },
    });
    emit('Target.attachedToTarget', {
      sessionId: WORKER,
      targetInfo: { targetId: 'T-WORKER', type: 'worker', url: 'http://127.0.0.1:8000/w.js' },
    });
    expect(body(await profile({ action: 'cpuStart' })).recording).toBe(true);
    expect(sent('Tracing.start')[0][1].categories).toContain('disabled-by-default-v8.cpu_profiler');
    expect(errorText(await profile({ action: 'cpuStart' }))).toContain('CPU_PROFILE_ACTIVE');

    const stopped = body(await profile({ action: 'cpuStop', top: 5 }));
    expect(stopped.threadsWithoutSamples).toBe(1);
    const [page, worker, iframe] = stopped.profiles;
    expect([page.target, worker.target, iframe.target]).toEqual(['page', 'worker', 'iframe']);
    expect(page).toMatchObject({
      pid: 10,
      tid: 11,
      thread: 'CrRendererMain',
      otherFrames: 1,
      samples: 5,
      durationMs: 4.1,
      busyMs: 3,
      idleMs: 1,
    });
    expect(
      page.hotspots.map((spot: any) => [
        spot.functionName,
        spot.lineNumber,
        spot.columnNumber,
        spot.scriptId,
        spot.selfMs,
        spot.totalMs,
        spot.selfPercent,
      ]),
    ).toEqual([
      ['hot', 1, 5, '5', 2, 3, 66.7],
      ['leaf', 2, 6, '5', 1, 1, 33.3],
    ]);
    expect(page.hotspots[0].url).not.toContain('abcdefghijklmnop');
    expect(worker).toMatchObject({ sessionId: WORKER, targetId: 'T-WORKER', tid: 20 });
    expect(worker.hotspots[0]).toMatchObject({ functionName: 'self.onmessage', selfMs: 0.5 });
    expect(iframe).toMatchObject({ sessionId: CHILD, targetId: 'T-OOPIF', pid: 30 });

    expect(downloads.map((item) => item.filename)).toEqual([
      expect.stringMatching(/^cpu_tab7_.+_page\.cpuprofile$/),
      expect.stringMatching(/_worker\.cpuprofile$/),
      expect.stringMatching(/_iframe\.cpuprofile$/),
    ]);
    expect(page.path).toBe(`E:\\Download\\${downloads[0].filename}`);
    const file = JSON.parse(atob(downloads[0].url.split(',')[1]));
    expect(file.startTime).toBe(1000);
    expect(file.endTime).toBe(5100);
    expect(file.samples).toEqual([4, 4, 5, 6, 2]);
    expect(file.nodes.find((node: any) => node.id === 4)).toMatchObject({
      hitCount: 2,
      children: [5],
      callFrame: { functionName: 'hot', scriptId: '5', lineNumber: 1, columnNumber: 5 },
    });
    expect(JSON.stringify(file)).not.toContain('abcdefghijklmnop');

    // Trace data of the recorder never entered the B1 ring buffer.
    const events = body(await session({ action: 'events' })).events;
    expect(events.filter((event: any) => event.method.startsWith('Tracing.'))).toEqual([]);
    // After cpuStop a trace started by the agent is buffered as usual.
    emit('Tracing.tracingComplete', {});
    expect(
      body(await session({ action: 'events' })).events.map((event: any) => event.method),
    ).toEqual(['Tracing.tracingComplete']);
  });

  test('Tracing is one per browser: profile and performance_start_trace exclude each other', async () => {
    await start();
    body(await profile({ action: 'cpuStart' }));
    const trace = await performanceStartTraceTool.execute({});
    expect(errorText(trace)).toContain('TRACE_BUSY');
    body(await profile({ action: 'cpuStop' }));
    // Released: the performance trace can start, and then blocks cpuStart.
    const started = await performanceStartTraceTool.execute({});
    expect(started.isError).toBe(false);
    expect(errorText(await profile({ action: 'cpuStart' }))).toContain('TRACE_BUSY');
    emit('Tracing.tracingComplete', {});
    body(await profile({ action: 'cpuStart' }));
    // A trace started outside AEB is reported with the same code.
    body(await profile({ action: 'cpuStop' }));
    failOn.set(
      'Tracing.start@',
      new Error('Tracing has already been started (possibly in another tab).'),
    );
    expect(errorText(await profile({ action: 'cpuStart' }))).toMatch(
      /CPU_PROFILE_FAILED: TRACE_BUSY/,
    );
    failOn.clear();
    body(await profile({ action: 'cpuStart' }));
  });

  test('a failed performance_start_trace releases the lock and its listener', async () => {
    await start();
    const listeners = eventListeners.length;
    failOn.set('Tracing.start@', new Error('no tracing'));
    expect(errorText(await performanceStartTraceTool.execute({}))).toContain('no tracing');
    expect(eventListeners).toHaveLength(listeners);
    failOn.clear();
    body(await profile({ action: 'cpuStart' }));
  });

  test('session stop ends the trace and CSS tracking and releases the lock', async () => {
    await start();
    body(await profile({ action: 'cssStart' }));
    body(await profile({ action: 'cpuStart' }));
    body(await session({ action: 'stop' }));
    expect(sent('Tracing.end')).toHaveLength(1);
    expect(sent('CSS.stopRuleUsageTracking')).toHaveLength(2);
    expect((await performanceStartTraceTool.execute({})).isError).toBe(false);
  });

  test('a detach while recording releases the lock without CDP calls', async () => {
    await start();
    body(await profile({ action: 'cpuStart' }));
    calls = [];
    for (const listener of detachListeners) listener({ tabId: 7 }, 'canceled_by_user');
    expect(calls).toEqual([]);
    expect(peekSession(7)?.profile.cpu).toBeUndefined();
    expect((await performanceStartTraceTool.execute({})).isError).toBe(false);
    expect(errorText(await profile({ action: 'cpuStart' }))).toContain('CDP_SESSION_ENDED');
  });

  test('recursion counts a function once per sample in total time', () => {
    const cpu = buildCpuProfile(
      {
        pid: 1,
        id: '0x1',
        startTime: 0,
        nodes: new Map([
          [1, { callFrame: { functionName: '(root)' } }],
          [2, { callFrame: { functionName: 'fib', url: 'a.js', lineNumber: 0 }, parent: 1 }],
          [3, { callFrame: { functionName: 'fib', url: 'a.js', lineNumber: 0 }, parent: 2 }],
        ]),
        samples: [3, 2],
        timeDeltas: [0, 1000],
      },
      (value) => value,
    );
    const summary = summarizeProfile(cpu, 10);
    expect(summary.hotspots).toEqual([
      expect.objectContaining({ functionName: 'fib', selfMs: 1, totalMs: 1, columnNumber: -1 }),
    ]);
  });

  test('heap samples count instances per constructor and diff two samples', async () => {
    await start();
    const first = body(
      await profile({ action: 'heapSample', constructors: ['Map', 'app.Leak', 'Map'] }),
    );
    expect(first.sample).toBe(1);
    expect(Object.keys(first.counts)).toEqual(['Map', 'app.Leak']);
    expect(first.counts['app.Leak'].count).toBe(10);
    expect(first.usage).toEqual({ usedSize: 1003, totalSize: 4000, embedderHeapUsedSize: 7 });
    // Every prototype and result handle is released.
    expect(sent('Runtime.releaseObjectGroup')).toHaveLength(2);

    counts = { Map: 5, 'app.Leak': 510 };
    const second = body(await profile({ action: 'heapSample', constructors: ['app.Leak', 'Map'] }));
    const diff = body(
      await profile({ action: 'heapDiff', from: first.sample, to: second.sample }),
    ).diff;
    expect(diff.constructors).toEqual([
      { constructor: 'app.Leak', before: 10, after: 510, delta: 500 },
      { constructor: 'Map', before: 3, after: 5, delta: 2 },
    ]);
    expect(diff.usedSizeDelta).toBe(2);

    const child = body(
      await profile({ action: 'heapSample', constructors: ['Map'], sessionId: WORKER }),
    );
    expect(child.sessionId).toBe(WORKER);
    expect(sent('Runtime.queryObjects').at(-1)?.[2]).toBe(WORKER);
    expect(errorText(await profile({ action: 'heapDiff', from: 1, to: child.sample }))).toContain(
      'HEAP_SAMPLE_MISMATCH',
    );
    expect(errorText(await profile({ action: 'heapDiff', from: 1, to: 99 }))).toContain(
      'HEAP_SAMPLE_NOT_FOUND',
    );
    expect(errorText(await profile({ action: 'heapSample', constructors: ['Missing'] }))).toContain(
      'HEAP_CONSTRUCTOR_NOT_FOUND',
    );
    expect(
      errorText(await profile({ action: 'heapSample', constructors: ['Map'], sessionId: 'nope' })),
    ).toContain('CDP_UNKNOWN_SESSION');

    const usage = body(await profile({ action: 'heapUsage' }));
    expect(usage.sessions.map((item: any) => item.sessionId)).toEqual(['root', CHILD, WORKER]);
    expect(
      body(await profile({ action: 'status' })).heapSamples.map((item: any) => item.sample),
    ).toEqual([1, 2, 3]);
  });

  test('a paused session is not evaluated in', async () => {
    await start();
    peekSession(7)!.debug.pauses.set('', { reason: 'other', seq: 1 } as any);
    calls = [];
    expect(errorText(await profile({ action: 'heapSample', constructors: ['Map'] }))).toContain(
      'PROFILE_PAGE_PAUSED',
    );
    expect(calls).toEqual([]);
    // CSS and Tracing answer while paused (measured), so they are not blocked.
    body(await profile({ action: 'cssStart' }));
    body(await profile({ action: 'heapSample', constructors: ['Map'], sessionId: CHILD }));
  });
});
