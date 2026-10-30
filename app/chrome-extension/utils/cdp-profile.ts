import { cdpSessionManager } from '@/utils/cdp-session-manager';
import type { HeldSession } from '@/utils/cdp-event-hub';
import { claimTracing, releaseTracing, tracingError } from '@/utils/cdp-tracing-lock';

/**
 * Performance and memory of a tab held by chrome_cdp_session (chrome_cdp_profile).
 *
 * Measured on Chrome 156 through chrome.debugger:
 * - Profiler, HeapProfiler and Memory are not exposed to extensions (-32601 "wasn't found") in the
 *   root session, OOPIF and worker child sessions, also on a one-shot attach. So there is no JS
 *   precise coverage, no Profiler.start/stop, no heap snapshot and no sampling heap profiler.
 * - CSS works in the root and OOPIF sessions (not in workers, which have no DOM/CSS). CSS.enable
 *   replays CSS.styleSheetAdded for existing sheets; takeCoverageDelta returns only rules that
 *   became used since the last call; stopRuleUsageTracking returns the rest. It answers while the
 *   page is paused in the debugger. A second startRuleUsageTracking is accepted silently.
 * - CPU profiles come from Tracing (root session only; child sessions have no Tracing). With
 *   disabled-by-default-v8.cpu_profiler every sampled thread of the tab emits Profile (pid, tid of
 *   the sampled thread, startTime) and ProfileChunk events keyed by pid+id (nodes with parent and
 *   callFrame, samples, timeDeltas in us), from the page process, OOPIF processes and dedicated
 *   workers alike; another tab's JS was not in the trace. The interval is ~0.5 ms whatever
 *   sampling-frequency or the .hires category says, so it is not configurable. callFrame.scriptId
 *   is the scriptId of chrome_cdp_scripts in the session of that thread. Threads are attributed by
 *   TracingSessionIdForWorker (workerId = worker targetId, workerThreadId) and by args.data.frame
 *   of devtools.timeline events (an OOPIF frame id is its targetId), else by script origins.
 * - Tracing is browser-wide: one trace at a time in all tabs (see cdp-tracing-lock). Tracing.start
 *   and end work while the page is paused.
 * - Runtime.getHeapUsage and Runtime.queryObjects work in every session. queryObjects collects
 *   garbage and walks the whole heap on the page thread, so the freeze depends on the heap more
 *   than on the count: 847 ms for 200,000 instances in a 46 MB heap (performance.now before and
 *   after), 529-563 ms for 1,000 instances in the acceptance fixture. It counts instances by
 *   prototype chain, so subclasses are included; there is no self size per constructor.
 */

export const CPU_CATEGORIES = [
  '-*',
  'disabled-by-default-v8.cpu_profiler',
  // Frame ids of main threads and TracingSessionIdForWorker, for attribution only.
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
].join(',');
export const MAX_SAMPLES = 2_000_000;
export const MAX_HEAP_SAMPLES = 20;
const MAX_THREAD_FRAMES = 50;
const TRACE_END_TIMEOUT_MS = 30_000;

export interface SheetRecord {
  key: string;
  styleSheetId: string;
  url: string;
  origin: string;
  isInline: boolean;
  isConstructed: boolean;
  length: number;
  startLine: number;
  startColumn: number;
  frameId?: string;
  removed?: boolean;
  /** Merged, sorted [start, end) ranges of used rules in UTF-16 code units. */
  used: Array<[number, number]>;
}

export interface CssState {
  active: boolean;
  /** Session keys tracking ('' = root). */
  keys: string[];
  startedAt?: number;
  stoppedAt?: number;
  sheets: Map<string, SheetRecord>;
  /** Coverage entries of sheets never announced by styleSheetAdded. */
  unknownRules: number;
}

export interface ThreadProfile {
  pid: number;
  tid?: number;
  id: string;
  startTime?: number;
  nodes: Map<number, { callFrame: any; parent?: number }>;
  samples: number[];
  timeDeltas: number[];
}

export interface CpuRecorder {
  startedAt: number;
  rootFrameId: string;
  rootOrigin?: string;
  /** Frame ids of the root frame tree (same-process iframes included). */
  rootFrames: Set<string>;
  profiles: Map<string, ThreadProfile>;
  threadNames: Map<string, string>;
  /** pid:tid -> worker targetId. */
  workerThreads: Map<string, string>;
  /** pid:tid -> frame ids seen on that thread. */
  frames: Map<string, Set<string>>;
  samples: number;
  truncated: boolean;
  completed?: () => void;
  done: Promise<void>;
}

export interface HeapSample {
  id: number;
  key: string;
  at: number;
  usage: HeapUsage;
  counts: Record<string, { count: number; ms: number }>;
}

export interface HeapUsage {
  usedSize: number;
  totalSize: number;
  embedderHeapUsedSize?: number;
  backingStorageSize?: number;
}

export interface ProfileState {
  css: CssState;
  cpu?: CpuRecorder;
  heap: HeapSample[];
  nextHeapId: number;
  errors: string[];
}

export function createProfileState(): ProfileState {
  return {
    css: { active: false, keys: [], sheets: new Map(), unknownRules: 0 },
    heap: [],
    nextHeapId: 1,
    errors: [],
  };
}

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

function send<T = any>(host: HeldSession, key: string, method: string, params: object = {}) {
  return cdpSessionManager.sendCommand<T>(host.tabId, method, params, key || undefined);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(onTimeout()), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Merges [start, end) into sorted, non-overlapping ranges. */
export function addRange(ranges: Array<[number, number]>, start: number, end: number) {
  if (!(end > start)) return;
  let index = 0;
  while (index < ranges.length && ranges[index][1] < start) index += 1;
  let from = start;
  let to = end;
  let remove = 0;
  while (index + remove < ranges.length && ranges[index + remove][0] <= to) {
    from = Math.min(from, ranges[index + remove][0]);
    to = Math.max(to, ranges[index + remove][1]);
    remove += 1;
  }
  ranges.splice(index, remove, [from, to]);
}

export function usedChars(ranges: Array<[number, number]>): number {
  return ranges.reduce((sum, [start, end]) => sum + end - start, 0);
}

function sheetKey(key: string, styleSheetId: string) {
  return `${key}\u0000${styleSheetId}`;
}

function mergeCoverage(css: CssState, key: string, entries: any[] | undefined) {
  for (const entry of entries || []) {
    if (!entry?.used) continue;
    const sheet = css.sheets.get(sheetKey(key, entry.styleSheetId));
    if (!sheet) {
      css.unknownRules += 1;
      continue;
    }
    addRange(sheet.used, entry.startOffset, entry.endOffset);
  }
}

function collectTrace(cpu: CpuRecorder, values: any[]) {
  for (const value of values) {
    const name = value?.name;
    if (name === 'Profile' || name === 'ProfileChunk') {
      const id = `${value.pid}:${value.id}`;
      let profile = cpu.profiles.get(id);
      if (!profile) {
        profile = {
          pid: value.pid,
          id: String(value.id),
          nodes: new Map(),
          samples: [],
          timeDeltas: [],
        };
        cpu.profiles.set(id, profile);
      }
      const data = value.args?.data;
      if (name === 'Profile') {
        profile.tid = value.tid;
        profile.startTime = data?.startTime;
        continue;
      }
      for (const node of data?.cpuProfile?.nodes || []) {
        profile.nodes.set(node.id, { callFrame: node.callFrame, parent: node.parent });
      }
      const samples: number[] = data?.cpuProfile?.samples || [];
      const deltas: number[] = data?.timeDeltas || [];
      if (cpu.samples + samples.length > MAX_SAMPLES) {
        cpu.truncated = true;
        continue;
      }
      // A loop, not push(...samples): chunks can be large.
      for (let index = 0; index < samples.length; index += 1) {
        profile.samples.push(samples[index]);
        profile.timeDeltas.push(deltas[index] ?? 0);
      }
      cpu.samples += samples.length;
    } else if (name === 'thread_name') {
      cpu.threadNames.set(`${value.pid}:${value.tid}`, String(value.args?.name ?? ''));
    } else if (name === 'TracingSessionIdForWorker') {
      const data = value.args?.data;
      if (data?.workerId && data.workerThreadId !== undefined) {
        cpu.workerThreads.set(`${value.pid}:${data.workerThreadId}`, data.workerId);
      }
    } else if (typeof value?.args?.data?.frame === 'string') {
      const thread = `${value.pid}:${value.tid}`;
      let frames = cpu.frames.get(thread);
      if (!frames) cpu.frames.set(thread, (frames = new Set()));
      if (frames.size < MAX_THREAD_FRAMES) frames.add(value.args.data.frame);
    }
  }
}

/**
 * Called by the hub for every event. Returns 'consumed' for trace data of our CPU recorder so
 * megabytes of trace events never enter the B1 ring buffer; everything else is buffered as usual.
 */
export function trackProfileEvent(
  host: HeldSession,
  method: string,
  params: any,
  sessionId?: string,
): 'consumed' | undefined {
  const state = host.profile;
  const key = sessionId ?? '';
  if (!sessionId && state.cpu && method.startsWith('Tracing.')) {
    if (method === 'Tracing.dataCollected') collectTrace(state.cpu, params?.value || []);
    else if (method === 'Tracing.tracingComplete') state.cpu.completed?.();
    return 'consumed';
  }
  const css = state.css;
  if (!css.active || !css.keys.includes(key)) return undefined;
  if (method === 'CSS.styleSheetAdded' && params?.header) {
    const header = params.header;
    const id = sheetKey(key, header.styleSheetId);
    if (!css.sheets.has(id)) {
      css.sheets.set(id, {
        key,
        styleSheetId: header.styleSheetId,
        url: header.sourceURL ?? '',
        origin: header.origin ?? 'regular',
        isInline: !!header.isInline,
        isConstructed: !!header.isConstructed,
        length: typeof header.length === 'number' ? header.length : 0,
        startLine: header.startLine ?? 0,
        startColumn: header.startColumn ?? 0,
        ...(header.frameId ? { frameId: header.frameId } : {}),
        used: [],
      });
    }
  } else if (method === 'CSS.styleSheetRemoved' && params?.styleSheetId) {
    const sheet = css.sheets.get(sheetKey(key, params.styleSheetId));
    if (sheet) sheet.removed = true;
  }
  return undefined;
}

function frameKeys(host: HeldSession): string[] {
  return [
    '',
    ...[...host.targets.values()]
      .filter((target) => target.type === 'iframe')
      .map((target) => target.sessionId),
  ];
}

/**
 * Tracks rule usage in the root session (failure rejects the call) and every attached cross-site
 * iframe (failures are returned). Sheets are registered by the styleSheetAdded replay of
 * CSS.enable, so the state is active before the domain is enabled.
 */
export async function startCss(host: HeldSession): Promise<{ keys: string[]; errors: string[] }> {
  const css = host.profile.css;
  if (css.active) fail('CSS_COVERAGE_ACTIVE', 'CSS coverage is already running; cssStop first');
  const keys = frameKeys(host);
  host.profile.css = {
    active: true,
    keys: [...keys],
    startedAt: Date.now(),
    sheets: new Map(),
    unknownRules: 0,
  };
  const errors: string[] = [];
  const tracking: string[] = [];
  for (const key of keys) {
    try {
      await send(host, key, 'DOM.enable');
      // Re-enable so Chrome replays styleSheetAdded even if CSS was already enabled.
      await send(host, key, 'CSS.disable').catch(() => undefined);
      await send(host, key, 'CSS.enable');
      await send(host, key, 'CSS.startRuleUsageTracking');
      tracking.push(key);
    } catch (error) {
      if (!key) {
        host.profile.css.active = false;
        host.profile.css.keys = [];
        await send(host, '', 'CSS.disable').catch(() => undefined);
        throw new Error(`CSS_COVERAGE_FAILED: ${messageOf(error)}`);
      }
      errors.push(`${key}: ${messageOf(error)}`);
    }
  }
  host.profile.css.keys = tracking;
  return { keys: tracking, errors };
}

/** Folds the rules used since the last call into the per-sheet ranges. */
export async function takeCss(host: HeldSession): Promise<string[]> {
  const css = host.profile.css;
  if (!css.active) return [];
  const errors: string[] = [];
  for (const key of css.keys) {
    try {
      const result = await send<{ coverage: any[] }>(host, key, 'CSS.takeCoverageDelta');
      mergeCoverage(css, key, result.coverage);
    } catch (error) {
      errors.push(`${key || 'root'}: ${messageOf(error)}`);
    }
  }
  return errors;
}

/** Final delta, then CSS.disable; the report stays readable. DOM stays enabled for other tools. */
export async function stopCss(host: HeldSession): Promise<string[]> {
  const css = host.profile.css;
  if (!css.active) return [];
  const errors: string[] = [];
  for (const key of css.keys) {
    try {
      const result = await send<{ ruleUsage: any[] }>(host, key, 'CSS.stopRuleUsageTracking');
      mergeCoverage(css, key, result.ruleUsage);
    } catch (error) {
      errors.push(`stop css ${key || 'root'}: ${messageOf(error)}`);
    }
    await send(host, key, 'CSS.disable').catch((error) =>
      errors.push(`disable css ${key || 'root'}: ${messageOf(error)}`),
    );
  }
  css.active = false;
  css.stoppedAt = Date.now();
  return errors;
}

interface FrameNode {
  frame: { id: string; url: string; securityOrigin?: string };
  childFrames?: FrameNode[];
}

export async function startCpu(host: HeldSession): Promise<void> {
  if (host.profile.cpu)
    fail('CPU_PROFILE_ACTIVE', 'a CPU profile is already recording; cpuStop first');
  claimTracing({ tabId: host.tabId, tool: 'chrome_cdp_profile' });
  try {
    const tree = (await send<{ frameTree: FrameNode }>(host, '', 'Page.getFrameTree')).frameTree;
    const rootFrames = new Set<string>();
    const walk = (node: FrameNode) => {
      rootFrames.add(node.frame.id);
      for (const child of node.childFrames || []) walk(child);
    };
    walk(tree);
    let completed: (() => void) | undefined;
    const done = new Promise<void>((resolve) => (completed = resolve));
    let rootOrigin: string | undefined;
    try {
      rootOrigin = new URL(tree.frame.url).origin;
    } catch {
      // about:blank and similar have no origin to attribute by.
    }
    // Registered before Tracing.start: data can arrive before the command resolves.
    host.profile.cpu = {
      startedAt: Date.now(),
      rootFrameId: tree.frame.id,
      ...(rootOrigin && rootOrigin !== 'null' ? { rootOrigin } : {}),
      rootFrames,
      profiles: new Map(),
      threadNames: new Map(),
      workerThreads: new Map(),
      frames: new Map(),
      samples: 0,
      truncated: false,
      completed,
      done,
    };
    await send(host, '', 'Tracing.start', {
      categories: CPU_CATEGORIES,
      transferMode: 'ReportEvents',
    });
  } catch (error) {
    host.profile.cpu = undefined;
    releaseTracing(host.tabId, 'chrome_cdp_profile');
    throw new Error(`CPU_PROFILE_FAILED: ${tracingError(error).message}`);
  }
}

/** Ends the trace and waits for every chunk; the recorder is returned and cleared. */
export async function stopCpu(host: HeldSession): Promise<CpuRecorder> {
  const cpu = host.profile.cpu;
  if (!cpu) fail('CPU_PROFILE_NOT_STARTED', 'no CPU profile is recording; cpuStart first');
  try {
    await send(host, '', 'Tracing.end');
    await withTimeout(
      cpu.done,
      TRACE_END_TIMEOUT_MS,
      () => new Error('CPU_PROFILE_INCOMPLETE: Tracing.tracingComplete did not arrive in 30 s'),
    );
  } catch (error) {
    throw /^[A-Z_]+:/.test(messageOf(error))
      ? error
      : new Error(`CPU_PROFILE_FAILED: ${messageOf(error)}`);
  } finally {
    host.profile.cpu = undefined;
    releaseTracing(host.tabId, 'chrome_cdp_profile');
  }
  return cpu;
}

export type Attribution =
  | { kind: 'page'; sessionId?: undefined }
  | { kind: 'iframe' | 'worker'; sessionId?: string; targetId: string; url?: string }
  | { kind: 'unknown'; sessionId?: undefined };

/** Which target a sampled thread belongs to: worker id, frame ids, then script origins. */
export function attributeThread(
  host: HeldSession,
  cpu: CpuRecorder,
  profile: ThreadProfile,
): { attribution: Attribution; otherFrames: number } {
  const thread = `${profile.pid}:${profile.tid}`;
  const targets = [...host.targets.values()];
  const workerId = cpu.workerThreads.get(thread);
  if (workerId) {
    const target = targets.find((item) => item.targetId === workerId);
    return {
      attribution: {
        kind: 'worker',
        targetId: workerId,
        ...(target ? { sessionId: target.sessionId, url: target.url } : {}),
      },
      otherFrames: 0,
    };
  }
  const iframes = targets.filter((target) => target.type === 'iframe');
  const frames = [...(cpu.frames.get(thread) || [])];
  const own = frames.filter(
    (frame) => cpu.rootFrames.has(frame) || iframes.some((target) => target.targetId === frame),
  );
  const otherFrames = frames.length - own.length;
  if (own.some((frame) => cpu.rootFrames.has(frame))) {
    return { attribution: { kind: 'page' }, otherFrames };
  }
  const frameTarget = iframes.find((target) => own.includes(target.targetId));
  if (frameTarget) {
    return {
      attribution: {
        kind: 'iframe',
        sessionId: frameTarget.sessionId,
        targetId: frameTarget.targetId,
        url: frameTarget.url,
      },
      otherFrames,
    };
  }
  // No frame event on this thread (e.g. only Runtime.evaluate ran): match script origins.
  const origins = new Set<string>();
  for (const node of profile.nodes.values()) {
    const url = node.callFrame?.url;
    if (typeof url === 'string' && /^https?:/.test(url)) {
      try {
        origins.add(new URL(url).origin);
      } catch {
        // Not a parsable url; it cannot attribute.
      }
    }
  }
  const candidates: Attribution[] = [];
  if (cpu.rootOrigin && origins.has(cpu.rootOrigin)) candidates.push({ kind: 'page' });
  for (const target of iframes) {
    try {
      if (origins.has(new URL(target.url).origin)) {
        candidates.push({
          kind: 'iframe',
          sessionId: target.sessionId,
          targetId: target.targetId,
          url: target.url,
        });
      }
    } catch {
      // Same as above.
    }
  }
  return {
    attribution: candidates.length === 1 ? candidates[0] : { kind: 'unknown' },
    otherFrames,
  };
}

export interface CpuProfileNode {
  id: number;
  callFrame: {
    functionName: string;
    scriptId: string;
    url: string;
    lineNumber: number;
    columnNumber: number;
  };
  hitCount: number;
  children?: number[];
}

export interface CpuProfile {
  nodes: CpuProfileNode[];
  startTime: number;
  endTime: number;
  samples: number[];
  timeDeltas: number[];
}

/** Chrome's .cpuprofile shape (DevTools Performance and JavaScript Profiler load it). */
export function buildCpuProfile(
  profile: ThreadProfile,
  text: (value: string) => string,
): CpuProfile {
  const ids = [...profile.nodes.keys()].sort((a, b) => a - b);
  const byId = new Map<number, CpuProfileNode>();
  for (const id of ids) {
    const frame = profile.nodes.get(id)!.callFrame || {};
    byId.set(id, {
      id,
      callFrame: {
        functionName: text(String(frame.functionName ?? '')),
        scriptId: String(frame.scriptId ?? 0),
        url: text(String(frame.url ?? '')),
        lineNumber: typeof frame.lineNumber === 'number' ? frame.lineNumber : -1,
        columnNumber: typeof frame.columnNumber === 'number' ? frame.columnNumber : -1,
      },
      hitCount: 0,
    });
  }
  for (const id of ids) {
    const parent = profile.nodes.get(id)!.parent;
    const node = parent === undefined ? undefined : byId.get(parent);
    if (node) (node.children ||= []).push(id);
  }
  for (const sample of profile.samples) {
    const node = byId.get(sample);
    if (node) node.hitCount += 1;
  }
  const startTime = profile.startTime ?? 0;
  const endTime = profile.timeDeltas.reduce((time, delta) => time + delta, startTime);
  return {
    nodes: ids.map((id) => byId.get(id)!),
    startTime,
    endTime,
    samples: profile.samples,
    timeDeltas: profile.timeDeltas,
  };
}

const SPECIAL: Record<string, 'idle' | 'program' | 'gc' | 'root'> = {
  '(idle)': 'idle',
  '(program)': 'program',
  '(garbage collector)': 'gc',
  '(root)': 'root',
};

export interface Hotspot {
  functionName: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
  scriptId: string;
  selfMs: number;
  totalMs: number;
  selfPercent: number;
}

const ms = (us: number) => Math.round(us) / 1000;

/**
 * Self time per sample is the delta to the next sample (as DevTools attributes it). Total time
 * counts a function once per sample even when it recurses.
 */
export function summarizeProfile(profile: CpuProfile, top: number) {
  const parent = new Map<number, number>();
  for (const node of profile.nodes)
    for (const child of node.children || []) parent.set(child, node.id);
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const selfUs = new Map<number, number>();
  for (let index = 0; index < profile.samples.length; index += 1) {
    const delta = profile.timeDeltas[index + 1] ?? 0;
    const id = profile.samples[index];
    selfUs.set(id, (selfUs.get(id) ?? 0) + delta);
  }
  const keyOf = (node: CpuProfileNode) =>
    `${node.callFrame.functionName}\u0000${node.callFrame.url}\u0000${node.callFrame.lineNumber}\u0000${node.callFrame.columnNumber}\u0000${node.callFrame.scriptId}`;
  const functions = new Map<string, { node: CpuProfileNode; self: number; total: number }>();
  const totals = { idle: 0, program: 0, gc: 0, root: 0 };
  let sampled = 0;
  for (const [id, self] of selfUs) {
    sampled += self;
    const node = byId.get(id);
    if (!node) continue;
    const special = SPECIAL[node.callFrame.functionName];
    if (special && !node.callFrame.url) {
      totals[special] += self;
      continue;
    }
    const seen = new Set<string>();
    for (
      let current: number | undefined = id;
      current !== undefined;
      current = parent.get(current)
    ) {
      const item = byId.get(current)!;
      if (SPECIAL[item.callFrame.functionName] && !item.callFrame.url) continue;
      const key = keyOf(item);
      let entry = functions.get(key);
      if (!entry) functions.set(key, (entry = { node: item, self: 0, total: 0 }));
      if (current === id) entry.self += self;
      if (!seen.has(key)) {
        entry.total += self;
        seen.add(key);
      }
    }
  }
  const busy = sampled - totals.idle;
  const hotspots: Hotspot[] = [...functions.values()]
    .filter((entry) => entry.self > 0)
    .sort((a, b) => b.self - a.self || b.total - a.total)
    .slice(0, top)
    .map(({ node, self, total }) => ({
      functionName: node.callFrame.functionName || '(anonymous)',
      url: node.callFrame.url,
      lineNumber: node.callFrame.lineNumber,
      columnNumber: node.callFrame.columnNumber,
      scriptId: node.callFrame.scriptId,
      selfMs: ms(self),
      totalMs: ms(total),
      selfPercent: busy > 0 ? Math.round((self / busy) * 1000) / 10 : 0,
    }));
  return {
    samples: profile.samples.length,
    durationMs: ms(profile.endTime - profile.startTime),
    busyMs: ms(busy),
    idleMs: ms(totals.idle),
    programMs: ms(totals.program),
    gcMs: ms(totals.gc),
    functions: functions.size,
    hotspots,
  };
}

export async function heapUsage(host: HeldSession, key: string): Promise<HeapUsage> {
  const usage = await send<HeapUsage>(host, key, 'Runtime.getHeapUsage');
  return {
    usedSize: usage.usedSize,
    totalSize: usage.totalSize,
    ...(usage.embedderHeapUsedSize !== undefined
      ? { embedderHeapUsedSize: usage.embedderHeapUsedSize }
      : {}),
    ...(usage.backingStorageSize !== undefined
      ? { backingStorageSize: usage.backingStorageSize }
      : {}),
  };
}

const OBJECT_GROUP = 'aeb-profile-heap';

/**
 * Live instances whose prototype chain contains path.prototype, in the session's default context.
 * path is a validated identifier path, never code from the caller.
 */
export async function countInstances(host: HeldSession, key: string, path: string) {
  try {
    const proto = await send<{ result: any; exceptionDetails?: unknown }>(
      host,
      key,
      'Runtime.evaluate',
      {
        expression: `(() => { try { const value = globalThis.${path}; return typeof value === 'function' && value.prototype && typeof value.prototype === 'object' ? value.prototype : undefined; } catch { return undefined; } })()`,
        objectGroup: OBJECT_GROUP,
        silent: true,
      },
    );
    const objectId = proto.result?.objectId;
    if (!objectId) {
      fail(
        'HEAP_CONSTRUCTOR_NOT_FOUND',
        `${path} is not a constructor with a prototype in ${key ? `session ${key}` : 'the page'}`,
      );
    }
    const started = Date.now();
    const found = await send<{ objects: { objectId: string } }>(host, key, 'Runtime.queryObjects', {
      prototypeObjectId: objectId,
      objectGroup: OBJECT_GROUP,
    });
    const elapsed = Date.now() - started;
    const length = await send<{ result: { value: number } }>(host, key, 'Runtime.callFunctionOn', {
      objectId: found.objects.objectId,
      functionDeclaration: 'function () { return this.length; }',
      returnByValue: true,
    });
    return { count: Number(length.result.value), ms: elapsed };
  } finally {
    await send(host, key, 'Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP }).catch(
      (error) => host.profile.errors.push(`release heap objects: ${messageOf(error)}`),
    );
  }
}

export async function takeHeapSample(
  host: HeldSession,
  key: string,
  constructors: string[],
): Promise<HeapSample> {
  const counts: HeapSample['counts'] = {};
  for (const path of constructors) counts[path] = await countInstances(host, key, path);
  // After counting: queryObjects collected garbage first, so usage reflects live objects.
  const usage = await heapUsage(host, key);
  const sample: HeapSample = { id: host.profile.nextHeapId++, key, at: Date.now(), usage, counts };
  host.profile.heap.push(sample);
  while (host.profile.heap.length > MAX_HEAP_SAMPLES) host.profile.heap.shift();
  return sample;
}

export function heapDiff(host: HeldSession, from: number, to: number) {
  const find = (id: number) => {
    const sample = host.profile.heap.find((item) => item.id === id);
    if (!sample) {
      fail(
        'HEAP_SAMPLE_NOT_FOUND',
        `heap sample ${id} does not exist (kept: ${host.profile.heap.map((item) => item.id).join(', ') || 'none'})`,
      );
    }
    return sample;
  };
  const before = find(from);
  const after = find(to);
  if (before.key !== after.key) {
    fail('HEAP_SAMPLE_MISMATCH', `samples ${from} and ${to} were taken in different sessions`);
  }
  const names = [...new Set([...Object.keys(before.counts), ...Object.keys(after.counts)])];
  const constructors = names
    .map((name) => {
      const a = before.counts[name]?.count;
      const b = after.counts[name]?.count;
      return {
        constructor: name,
        before: a ?? null,
        after: b ?? null,
        delta: a !== undefined && b !== undefined ? b - a : null,
      };
    })
    .sort(
      (x, y) =>
        Math.abs(y.delta ?? 0) - Math.abs(x.delta ?? 0) ||
        x.constructor.localeCompare(y.constructor),
    );
  return {
    from,
    to,
    ...(before.key ? { sessionId: before.key } : {}),
    elapsedMs: after.at - before.at,
    usedSizeDelta: after.usage.usedSize - before.usage.usedSize,
    totalSizeDelta: after.usage.totalSize - before.usage.totalSize,
    constructors,
  };
}

/** Detach or tab close: Chrome ended everything, only local state and the lock are released. */
export function endProfile(host: HeldSession) {
  const state = host.profile;
  if (state.cpu) {
    state.cpu.completed?.();
    state.cpu = undefined;
    releaseTracing(host.tabId, 'chrome_cdp_profile');
  }
  if (state.css.active) {
    state.css.active = false;
    state.css.stoppedAt = Date.now();
  }
}

/** Session stop: ends an unfinished CPU trace (discarded) and CSS tracking. */
export async function stopProfile(host: HeldSession): Promise<string[]> {
  const errors: string[] = [];
  const cpu = host.profile.cpu;
  if (cpu) {
    try {
      // The data is discarded, and the hub drops events of a stopping session, so there is
      // nothing to wait for.
      await send(host, '', 'Tracing.end');
    } catch (error) {
      errors.push(`end trace: ${messageOf(error)}`);
    } finally {
      host.profile.cpu = undefined;
      releaseTracing(host.tabId, 'chrome_cdp_profile');
    }
  }
  errors.push(...(await stopCss(host)));
  return errors;
}
