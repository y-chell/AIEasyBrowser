import { cdpSessionManager } from '@/utils/cdp-session-manager';

/**
 * Script table of a held CDP session, fed by Debugger.scriptParsed on the root and child sessions.
 *
 * Coordinates follow CDP: lines and columns are 0-based and resource-relative (an inline script
 * starts at its startLine/startColumn inside the HTML), offsets and lengths are UTF-16 code units
 * like Debugger.scriptParsed.length. That keeps search hits usable as Debugger.setBreakpointByUrl
 * locations without conversion.
 */

export const MAX_SCRIPTS = 5000;
const SOURCE_CACHE_BUDGET = 32 * 1024 * 1024;
// DevTools front-end value; without it V8 keeps every collected script for getScriptSource.
const MAX_SCRIPTS_CACHE_SIZE = 100 * 1024 * 1024;

export type ScriptKind = 'external' | 'inline' | 'eval' | 'sourceURL';

export interface ScriptRecord {
  seq: number;
  scriptId: string;
  /** Child CDP session (OOPIF or worker); absent for the tab's root session. */
  sessionId?: string;
  url: string;
  kind: ScriptKind;
  /** page | iframe | worker | service_worker | shared_worker ... (child target type for children). */
  target: string;
  /** default | isolated | worker, from executionContextAuxData. */
  context?: string;
  frameId?: string;
  executionContextId: number;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  length?: number;
  hash: string;
  sourceMapURL?: string;
  isModule?: boolean;
  language?: string;
  failedToParse?: boolean;
}

interface CachedSource {
  text: string;
  wasm: boolean;
  lineStarts?: number[];
}

export interface ScriptTable {
  records: Map<string, ScriptRecord>;
  nextSeq: number;
  dropped: number;
  debugger: 'off' | 'enabling' | 'on';
  enabling?: Promise<void>;
  errors: string[];
  cache: Map<string, CachedSource>;
  cacheBytes: number;
}

/** Minimal view of the owning held session, so this module does not import the hub at runtime. */
export interface ScriptSessionHost {
  tabId: number;
  targets: Map<string, { sessionId: string; type: string }>;
  scripts: ScriptTable;
}

export function createScriptTable(): ScriptTable {
  return {
    records: new Map(),
    nextSeq: 1,
    dropped: 0,
    debugger: 'off',
    errors: [],
    cache: new Map(),
    cacheBytes: 0,
  };
}

export function scriptKey(sessionId: string | undefined, scriptId: string): string {
  return `${sessionId ?? ''}\u0000${scriptId}`;
}

function classify(params: any): ScriptKind {
  if (!params.url) return 'eval';
  if (params.hasSourceURL) return 'sourceURL';
  // A <script> element cannot begin at 0:0 of its document; external files always do.
  return params.startLine || params.startColumn ? 'inline' : 'external';
}

function dropCached(table: ScriptTable, key: string) {
  const cached = table.cache.get(key);
  if (!cached) return;
  table.cache.delete(key);
  table.cacheBytes -= cached.text.length * 2;
}

function removeRecord(table: ScriptTable, key: string) {
  table.records.delete(key);
  dropCached(table, key);
}

function addScript(
  host: ScriptSessionHost,
  params: any,
  sessionId: string | undefined,
  failed: boolean,
) {
  if (typeof params?.scriptId !== 'string') return;
  const table = host.scripts;
  const key = scriptKey(sessionId, params.scriptId);
  const aux = params.executionContextAuxData;
  const record: ScriptRecord = {
    seq: table.nextSeq++,
    scriptId: params.scriptId,
    ...(sessionId ? { sessionId } : {}),
    url: typeof params.url === 'string' ? params.url : '',
    kind: classify(params),
    target: sessionId ? (host.targets.get(sessionId)?.type ?? 'unknown') : 'page',
    ...(typeof aux?.type === 'string' ? { context: aux.type } : {}),
    ...(typeof aux?.frameId === 'string' ? { frameId: aux.frameId } : {}),
    executionContextId: params.executionContextId,
    startLine: params.startLine ?? 0,
    startColumn: params.startColumn ?? 0,
    endLine: params.endLine ?? 0,
    endColumn: params.endColumn ?? 0,
    ...(typeof params.length === 'number' ? { length: params.length } : {}),
    hash: params.hash ?? '',
    ...(params.sourceMapURL ? { sourceMapURL: params.sourceMapURL } : {}),
    ...(params.isModule ? { isModule: true } : {}),
    ...(params.scriptLanguage && params.scriptLanguage !== 'JavaScript'
      ? { language: params.scriptLanguage }
      : {}),
    ...(failed ? { failedToParse: true } : {}),
  };
  removeRecord(table, key);
  table.records.set(key, record);
  while (table.records.size > MAX_SCRIPTS) {
    const oldest = table.records.keys().next().value as string;
    removeRecord(table, oldest);
    table.dropped += 1;
  }
}

function forgetWhere(table: ScriptTable, predicate: (record: ScriptRecord) => boolean) {
  for (const [key, record] of table.records) {
    if (predicate(record)) removeRecord(table, key);
  }
}

/** Updates the table from one debugger event; called for every event of a held session. */
export function trackScriptEvent(
  host: ScriptSessionHost,
  method: string,
  params: any,
  sessionId: string | undefined,
) {
  const table = host.scripts;
  switch (method) {
    case 'Debugger.scriptParsed':
      addScript(host, params, sessionId, false);
      break;
    case 'Debugger.scriptFailedToParse':
      addScript(host, params, sessionId, true);
      break;
    case 'Page.frameNavigated': {
      const frame = params?.frame;
      if (!frame?.id || params?.type === 'BackForwardCacheRestore') break;
      // A committed navigation destroys the frame's old contexts and their scripts. The main
      // frame takes its subframes along; Debugger reports the new document's scripts afterwards.
      const isMain = !frame.parentId;
      forgetWhere(
        table,
        (record) => record.sessionId === sessionId && (isMain || record.frameId === frame.id),
      );
      break;
    }
    case 'Target.attachedToTarget':
      if (table.debugger !== 'off' && params?.sessionId) {
        void enableChild(host, params.sessionId, params.targetInfo?.type);
      }
      break;
    case 'Target.detachedFromTarget':
      if (params?.sessionId) {
        forgetWhere(table, (record) => record.sessionId === params.sessionId);
      }
      break;
  }
}

export function clearScripts(table: ScriptTable) {
  table.records.clear();
  table.cache.clear();
  table.cacheBytes = 0;
  table.debugger = 'off';
  table.enabling = undefined;
}

function noteError(table: ScriptTable, message: string) {
  table.errors.push(message);
  if (table.errors.length > 20) table.errors.shift();
}

async function enableDebugger(tabId: number, sessionId?: string) {
  await cdpSessionManager.sendCommand(
    tabId,
    'Debugger.enable',
    { maxScriptsCacheSize: MAX_SCRIPTS_CACHE_SIZE },
    sessionId,
  );
  // Enabling Debugger arms existing `debugger;` statements; do not freeze the user's page.
  await cdpSessionManager.sendCommand(
    tabId,
    'Debugger.setSkipAllPauses',
    { skip: true },
    sessionId,
  );
}

async function enableChild(host: ScriptSessionHost, sessionId: string, type: string | undefined) {
  try {
    // Page events let an OOPIF's navigation prune its scripts; workers have no Page domain.
    if (type === 'iframe') {
      await cdpSessionManager.sendCommand(host.tabId, 'Page.enable', {}, sessionId);
    }
    await enableDebugger(host.tabId, sessionId);
  } catch (error) {
    noteError(
      host.scripts,
      `Debugger.enable in ${type ?? 'child'} ${sessionId}: ${error instanceof Error ? error.message : error}`,
    );
  }
}

/**
 * Enables the Debugger domain once per held session (root and current children); later children
 * are enabled on attach. Debugger.enable replays scriptParsed for every live script.
 */
export async function ensureScriptDebugger(host: ScriptSessionHost): Promise<void> {
  const table = host.scripts;
  if (table.debugger === 'on') return;
  if (!table.enabling) {
    table.debugger = 'enabling';
    table.enabling = (async () => {
      try {
        await cdpSessionManager.sendCommand(host.tabId, 'Page.enable', {});
        await enableDebugger(host.tabId);
        // Child failures are recorded per target; the root table is still usable.
        await Promise.all(
          [...host.targets.values()].map((target) =>
            enableChild(host, target.sessionId, target.type),
          ),
        );
        table.debugger = 'on';
      } catch (error) {
        table.debugger = 'off';
        throw error;
      } finally {
        table.enabling = undefined;
      }
    })();
  }
  await table.enabling;
}

/** Disables the root Debugger domain on stop, which also resumes a paused page. */
export async function disableScriptDebugger(host: ScriptSessionHost): Promise<void> {
  const enabled = host.scripts.debugger !== 'off';
  clearScripts(host.scripts);
  if (enabled) await cdpSessionManager.sendCommand(host.tabId, 'Debugger.disable', {});
}

export function findScript(
  table: ScriptTable,
  scriptId: string,
  sessionId: string | undefined,
): ScriptRecord | undefined {
  return table.records.get(scriptKey(sessionId, scriptId));
}

/** Script source, cached per session with an LRU byte budget. */
export async function loadScriptSource(
  host: ScriptSessionHost,
  record: ScriptRecord,
): Promise<CachedSource> {
  const table = host.scripts;
  const key = scriptKey(record.sessionId, record.scriptId);
  const cached = table.cache.get(key);
  if (cached) {
    table.cache.delete(key);
    table.cache.set(key, cached);
    return cached;
  }
  let result: { scriptSource?: string; bytecode?: string };
  try {
    result = await cdpSessionManager.sendCommand(
      host.tabId,
      'Debugger.getScriptSource',
      { scriptId: record.scriptId },
      record.sessionId,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // V8 answers "No script for id: N" once the script was collected or its context destroyed.
    if (/No script for id/i.test(message)) {
      removeRecord(table, key);
      throw new Error(`SCRIPT_GONE: script ${record.scriptId} no longer exists in the page`);
    }
    throw error;
  }
  const source: CachedSource = {
    text: result.scriptSource ?? '',
    // Chrome also returns an empty `bytecode` for some JavaScript scripts, so only the parsed language identifies wasm.
    wasm: record.language === 'WebAssembly',
  };
  const bytes = source.text.length * 2;
  if (bytes <= SOURCE_CACHE_BUDGET && table.records.has(key)) {
    table.cache.set(key, source);
    table.cacheBytes += bytes;
    while (table.cacheBytes > SOURCE_CACHE_BUDGET) {
      dropCached(table, table.cache.keys().next().value as string);
    }
  }
  return source;
}

// Line terminators recognised by V8 for script line numbers.
const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/g;

export function lineStarts(source: CachedSource): number[] {
  if (!source.lineStarts) {
    const starts = [0];
    LINE_BREAK.lastIndex = 0;
    for (let match = LINE_BREAK.exec(source.text); match; match = LINE_BREAK.exec(source.text)) {
      starts.push(match.index + match[0].length);
    }
    source.lineStarts = starts;
  }
  return source.lineStarts;
}

/** Script-relative offset to CDP resource-relative line/column. */
export function toLocation(
  record: ScriptRecord,
  starts: number[],
  offset: number,
): { line: number; column: number } {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  const column = offset - starts[low];
  return {
    line: record.startLine + low,
    column: low === 0 ? record.startColumn + column : column,
  };
}
