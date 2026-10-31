import path from 'path';
import type { BundleModule, CodeLanguage, SearchKind } from './code';
import type { AnalysisJob } from './compute';
import { AnalysisError, invalid } from './errors';
import { displayUrl, fetchText } from './fetch';
import {
  loadScript,
  readInputFile,
  requireAbsolute,
  writeFiles,
  writeOutputFile,
  type InvokeTool,
  type ScriptInfo,
} from './io';
import { runInWorker, type JobRunner } from './runner';
import { safeSegment, withSuffix, type RestoreFile, type RestoreSkip } from './sourcemap';
import { decode, type DecodeAction } from './decode';
import { byteLength, clip, fitBytes, shown, ZERO_BASE, type TextBase } from './text';

export { AnalysisError } from './errors';

export const ANALYSIS_TOOLS = ['analysis_code', 'analysis_sourcemap', 'analysis_decode'] as const;

export function isAnalysisTool(name: string): boolean {
  return (ANALYSIS_TOOLS as readonly string[]).includes(name);
}

export interface AnalysisContext {
  /** Calls an extension tool in the command's browser session. */
  invoke: InvokeTool;
  signal: AbortSignal;
  run?: JobRunner;
}

type Args = Record<string, any>;

const DEFAULT_MAX_OUTPUT_BYTES = 51_200;
const MAX_OUTPUT_BYTES = 2_000_000;
const SAMPLE_LIMIT = 100;

const SOURCE = ['file', 'text', 'scriptId', 'sessionId', 'tabId'];
const CODE_PARAMS: Record<string, string[]> = {
  beautify: [
    ...SOURCE,
    'language',
    'outFile',
    'overwrite',
    'offset',
    'length',
    'maxOutputBytes',
    'sanitizeOutput',
  ],
  unpack: [...SOURCE, 'outDir', 'overwrite', 'cursor', 'limit', 'maxOutputBytes'],
  search: [
    ...SOURCE,
    'kind',
    'query',
    'selector',
    'isRegex',
    'caseSensitive',
    'contextChars',
    'cursor',
    'limit',
    'maxOutputBytes',
    'sanitizeOutput',
  ],
};
const MAP_SOURCE = ['file', 'url', 'text', 'scriptId', 'sessionId', 'tabId'];
const SOURCEMAP_PARAMS: Record<string, string[]> = {
  load: [...MAP_SOURCE, 'cursor', 'limit', 'maxOutputBytes', 'sanitizeOutput'],
  lookup: [...MAP_SOURCE, 'line', 'column', 'sanitizeOutput'],
  restore: [...MAP_SOURCE, 'outDir', 'overwrite'],
};

function checkParams(tool: string, args: Args, allowed: Record<string, string[]>): string {
  const action = String(args.action);
  const names = allowed[action];
  if (!names) invalid(`${tool}: unknown action ${action}`);
  const extra = Object.keys(args).filter((key) => key !== 'action' && !names.includes(key));
  if (extra.length) invalid(`${tool} ${action} does not accept ${extra.join(', ')}`);
  return action;
}

function integer(args: Args, name: string, fallback: number, min: number, max: number): number {
  const value = args[name];
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    invalid(`${name} must be an integer in ${min}..${max}`);
  }
  return value;
}

function cursorOf(args: Args): number {
  if (args.cursor === undefined) return 0;
  if (!/^\d+$/.test(args.cursor)) invalid('cursor must come from a previous nextCursor');
  return Number(args.cursor);
}

function pageArgs(args: Args) {
  return {
    cursor: cursorOf(args),
    limit: integer(args, 'limit', 50, 1, 500),
    maxOutputBytes: integer(
      args,
      'maxOutputBytes',
      DEFAULT_MAX_OUTPUT_BYTES,
      1000,
      MAX_OUTPUT_BYTES,
    ),
  };
}

interface LoadedSource {
  text: string;
  base: TextBase;
  /** Describes the input in results; never contains the text itself. */
  source: Record<string, unknown>;
  file?: string;
  script?: ScriptInfo;
}

function describeScript(script: ScriptInfo) {
  return {
    type: 'script',
    scriptId: script.scriptId,
    ...(script.sessionId ? { sessionId: script.sessionId } : {}),
    url: script.url ? displayUrl(script.url) : '',
    startLine: script.startLine,
    startColumn: script.startColumn,
  };
}

function exactlyOne(args: Args, names: string[]): string {
  const given = names.filter((name) => args[name] !== undefined);
  if (given.length !== 1) invalid(`pass exactly one of ${names.join(', ')}`);
  if (given[0] !== 'scriptId') {
    for (const name of ['sessionId', 'tabId']) {
      if (args[name] !== undefined) invalid(`${name} is only valid with scriptId`);
    }
  }
  return given[0];
}

async function loadCode(args: Args, context: AnalysisContext): Promise<LoadedSource> {
  const kind = exactlyOne(args, ['file', 'text', 'scriptId']);
  if (kind === 'file') {
    const file = requireAbsolute('file', args.file);
    const text = await readInputFile(file, context.signal);
    return { text, base: ZERO_BASE, source: { type: 'file', file, length: text.length }, file };
  }
  if (kind === 'text') {
    return { text: args.text, base: ZERO_BASE, source: { type: 'text', length: args.text.length } };
  }
  const { script, text } = await loadScript(
    context.invoke,
    { scriptId: args.scriptId, sessionId: args.sessionId, tabId: args.tabId },
    context.signal,
  );
  return {
    text,
    base: { line: script.startLine, column: script.startColumn },
    source: { ...describeScript(script), length: text.length },
    script,
  };
}

function run(context: AnalysisContext, job: AnalysisJob): Promise<any> {
  return (context.run ?? runInWorker)(job, context.signal);
}

function languageOf(args: Args, input: LoadedSource): CodeLanguage {
  if (args.language) return args.language;
  const ext = input.file ? path.extname(input.file).toLowerCase() : '';
  if (ext === '.css') return 'css';
  if (ext === '.html' || ext === '.htm') return 'html';
  return 'js';
}

async function beautifyAction(args: Args, context: AnalysisContext) {
  if (args.outFile !== undefined) {
    for (const name of ['offset', 'length', 'maxOutputBytes', 'sanitizeOutput']) {
      if (args[name] !== undefined) invalid(`${name} does not apply when outFile is set`);
    }
  } else if (args.overwrite !== undefined) {
    invalid('overwrite requires outFile');
  }
  const input = await loadCode(args, context);
  const language = languageOf(args, input);
  const output: string = await run(context, { kind: 'beautify', text: input.text, language });
  if (args.outFile !== undefined) {
    const outFile = await writeOutputFile(
      args.outFile,
      output,
      args.overwrite === true,
      context.signal,
    );
    return {
      source: input.source,
      language,
      outFile,
      length: output.length,
      bytes: byteLength(output),
    };
  }
  const offset = integer(args, 'offset', 0, 0, Number.MAX_SAFE_INTEGER);
  if (offset > output.length) invalid(`offset ${offset} is past output length ${output.length}`);
  const length = integer(args, 'length', 20_000, 1, MAX_OUTPUT_BYTES);
  const maxBytes = integer(
    args,
    'maxOutputBytes',
    DEFAULT_MAX_OUTPUT_BYTES,
    1000,
    MAX_OUTPUT_BYTES,
  );
  const end = Math.min(output.length, offset + length);
  const limitedEnd = Math.max(fitBytes(output, offset, end, maxBytes), Math.min(end, offset + 1));
  const sanitize = args.sanitizeOutput !== false;
  const view = shown(output.slice(offset, limitedEnd), sanitize);
  return {
    source: input.source,
    language,
    totalLength: output.length,
    offset,
    endOffset: limitedEnd,
    text: view.text,
    ...(limitedEnd < end ? { truncatedByBytes: true } : {}),
    hasMore: limitedEnd < output.length,
    ...(view.redacted ? { redacted: true } : {}),
    sanitizeOutput: sanitize,
  };
}

/** File name per module id; unique case-insensitively and never `manifest.json`. */
function moduleFiles(modules: BundleModule[]): string[] {
  const used = new Set(['manifest.json']);
  return modules.map((module) => {
    const base = safeSegment(module.id) || '_';
    let name = `${base}.js`;
    for (let n = 1; used.has(name.toLowerCase()); n += 1) name = withSuffix(`${base}.js`, n);
    used.add(name.toLowerCase());
    return name;
  });
}

async function unpackAction(args: Args, context: AnalysisContext) {
  if (args.overwrite !== undefined && args.outDir === undefined)
    invalid('overwrite requires outDir');
  const outDir = args.outDir === undefined ? undefined : requireAbsolute('outDir', args.outDir);
  const page = pageArgs(args);
  const input = await loadCode(args, context);
  const result: { formats: string[]; modules: BundleModule[] } = await run(context, {
    kind: 'unpack',
    text: input.text,
    base: input.base,
  });
  if (page.cursor > result.modules.length) invalid('cursor is past the module list');
  const files = outDir ? moduleFiles(result.modules) : undefined;
  if (outDir && files) {
    const manifest = {
      source: input.source,
      formats: result.formats,
      modules: result.modules.map((module, index) => ({ ...module, file: files[index] })),
    };
    await writeFiles(
      outDir,
      [
        ...result.modules.map((module, index) => ({
          path: files[index],
          content: input.text.slice(module.offset, module.endOffset) + '\n',
        })),
        { path: 'manifest.json', content: JSON.stringify(manifest, null, 2) + '\n' },
      ],
      args.overwrite === true,
      context.signal,
    );
  }
  const entries: object[] = [];
  let used = 0;
  let index = page.cursor;
  for (; index < result.modules.length && entries.length < page.limit; index += 1) {
    const module = result.modules[index];
    const { deps, endOffset, ...rest } = module;
    const entry = {
      ...rest,
      id: clip(module.id, 300),
      length: endOffset - module.offset,
      deps: deps.slice(0, SAMPLE_LIMIT).map((dep) => clip(dep, 300)),
      ...(deps.length > SAMPLE_LIMIT ? { depCount: deps.length } : {}),
      ...(files ? { file: files[index] } : {}),
    };
    const size = byteLength(entry);
    if (entries.length > 0 && used + size > page.maxOutputBytes) break;
    entries.push(entry);
    used += size;
  }
  return {
    source: input.source,
    formats: result.formats,
    moduleCount: result.modules.length,
    ...(outDir ? { outDir, manifest: path.join(outDir, 'manifest.json') } : {}),
    modules: entries,
    hasMore: index < result.modules.length,
    ...(index < result.modules.length ? { nextCursor: String(index) } : {}),
  };
}

async function searchAction(args: Args, context: AnalysisContext) {
  const kind: SearchKind | undefined = args.kind;
  if (!kind) invalid('search requires kind');
  if (kind === 'selector') {
    if (!args.selector) invalid('kind selector requires selector');
    for (const name of ['query', 'isRegex', 'caseSensitive']) {
      if (args[name] !== undefined) invalid(`${name} does not apply to kind selector`);
    }
  } else if (args.selector !== undefined) {
    invalid('selector requires kind selector');
  }
  const page = pageArgs(args);
  const contextChars = integer(args, 'contextChars', 80, 0, 500);
  const input = await loadCode(args, context);
  const result = await run(context, {
    kind: 'search',
    text: input.text,
    base: input.base,
    options: {
      kind,
      query: args.query,
      selector: args.selector,
      isRegex: args.isRegex === true,
      caseSensitive: args.caseSensitive === true,
      contextChars,
      cursor: page.cursor,
      limit: page.limit,
      maxOutputBytes: page.maxOutputBytes,
      sanitize: args.sanitizeOutput !== false,
    },
  });
  if (page.cursor > result.total) invalid('cursor is past the match list');
  return { source: input.source, ...result };
}

async function analysisCode(args: Args, context: AnalysisContext) {
  const action = checkParams('analysis_code', args, CODE_PARAMS);
  if (action === 'beautify') return beautifyAction(args, context);
  if (action === 'unpack') return unpackAction(args, context);
  return searchAction(args, context);
}

// ---------------------------------------------------------------------------------------------

interface LoadedMap {
  text: string;
  source: Record<string, unknown>;
  script?: ScriptInfo;
}

async function loadMap(args: Args, context: AnalysisContext): Promise<LoadedMap> {
  const kind = exactlyOne(args, ['file', 'url', 'text', 'scriptId']);
  if (kind === 'file') {
    const file = requireAbsolute('file', args.file);
    return { text: await readInputFile(file, context.signal), source: { type: 'file', file } };
  }
  if (kind === 'text') return { text: args.text, source: { type: 'text' } };
  if (kind === 'url') {
    return {
      text: await fetchText(args.url, context.signal),
      source: { type: 'url', url: displayUrl(args.url) },
    };
  }
  // Only the script header is needed; the map URL is resolved like DevTools does.
  const page = await context.invoke('chrome_cdp_scripts', {
    action: 'source',
    scriptId: args.scriptId,
    ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
    ...(args.tabId !== undefined ? { tabId: args.tabId } : {}),
    offset: 0,
    length: 1,
    sanitizeOutput: false,
  });
  const script = page.script as ScriptInfo;
  if (!script.sourceMapURL) {
    throw new AnalysisError(
      'SOURCEMAP_NOT_FOUND',
      `script ${script.scriptId} has no sourceMappingURL`,
    );
  }
  let mapUrl: string;
  try {
    mapUrl = script.url
      ? new URL(script.sourceMapURL, script.url).href
      : new URL(script.sourceMapURL).href;
  } catch {
    throw new AnalysisError(
      'SOURCEMAP_NOT_FOUND',
      `sourceMappingURL of script ${script.scriptId} cannot be resolved without a script url`,
    );
  }
  if (!/^(https?|data):/.test(mapUrl)) {
    throw new AnalysisError(
      'SOURCEMAP_FETCH_FAILED',
      `${displayUrl(mapUrl)}: only http, https and data source map URLs are fetched`,
    );
  }
  return {
    text: await fetchText(mapUrl, context.signal),
    source: { ...describeScript(script), sourceMapURL: displayUrl(mapUrl) },
    script,
  };
}

async function analysisSourcemap(args: Args, context: AnalysisContext) {
  const action = checkParams('analysis_sourcemap', args, SOURCEMAP_PARAMS);
  const sanitize = args.sanitizeOutput !== false;
  if (action === 'load') {
    const page = { ...pageArgs(args), sanitize };
    const map = await loadMap(args, context);
    const result = await run(context, { kind: 'mapLoad', text: map.text, page });
    if (page.cursor > result.sourceCount) invalid('cursor is past the source list');
    return { source: map.source, ...result };
  }
  if (action === 'lookup') {
    if (args.line === undefined) invalid('lookup requires line');
    const line = integer(args, 'line', 0, 0, Number.MAX_SAFE_INTEGER);
    const column = integer(args, 'column', 0, 0, Number.MAX_SAFE_INTEGER);
    const map = await loadMap(args, context);
    // Script positions are resource-relative; the map covers the script text only.
    const generatedLine = line - (map.script?.startLine ?? 0);
    const generatedColumn = generatedLine === 0 ? column - (map.script?.startColumn ?? 0) : column;
    if (generatedLine < 0 || generatedColumn < 0) {
      invalid(
        `line ${line}, column ${column} is before the start of script ${map.script?.scriptId}`,
      );
    }
    const original = await run(context, {
      kind: 'mapLookup',
      text: map.text,
      line: generatedLine,
      column: generatedColumn,
      sanitize,
    });
    return { source: map.source, generated: { line, column }, original };
  }
  if (args.outDir === undefined) invalid('restore requires outDir');
  const outDir = requireAbsolute('outDir', args.outDir);
  const map = await loadMap(args, context);
  const plan: { files: RestoreFile[]; skipped: RestoreSkip[] } = await run(context, {
    kind: 'mapRestore',
    text: map.text,
  });
  await writeFiles(outDir, plan.files, args.overwrite === true, context.signal);
  return {
    source: map.source,
    outDir,
    written: plan.files.length,
    files: plan.files.slice(0, SAMPLE_LIMIT).map((file) => ({
      index: file.index,
      source: clip(file.source, 300),
      path: file.path,
    })),
    ...(plan.files.length > SAMPLE_LIMIT ? { filesTruncated: true } : {}),
    skippedCount: plan.skipped.length,
    skipped: plan.skipped
      .slice(0, SAMPLE_LIMIT)
      .map((skip) => ({ ...skip, source: clip(skip.source, 300) })),
  };
}

function analysisDecode(args: Args) {
  checkParams('analysis_decode', args, {
    base64: ['text', 'maxOutputBytes', 'sanitizeOutput'],
    base64url: ['text', 'maxOutputBytes', 'sanitizeOutput'],
    hex: ['text', 'maxOutputBytes', 'sanitizeOutput'],
    url: ['text', 'maxOutputBytes', 'sanitizeOutput'],
    jwt: ['text', 'maxOutputBytes', 'sanitizeOutput'],
  });
  return decode(args.action as DecodeAction, args.text, {
    maxOutputBytes: integer(
      args,
      'maxOutputBytes',
      DEFAULT_MAX_OUTPUT_BYTES,
      1000,
      MAX_OUTPUT_BYTES,
    ),
    sanitize: args.sanitizeOutput !== false,
  });
}

/** Runs an analysis_* tool in Native. Arguments are already schema-validated. */
export async function runAnalysisTool(
  name: string,
  args: Args,
  context: AnalysisContext,
): Promise<unknown> {
  context.signal.throwIfAborted();
  if (name === 'analysis_code') return analysisCode(args, context);
  if (name === 'analysis_sourcemap') return analysisSourcemap(args, context);
  if (name === 'analysis_decode') return analysisDecode(args);
  invalid(`unknown analysis tool ${name}`);
}
