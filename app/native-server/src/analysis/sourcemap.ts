import { AnyMap, originalPositionFor, type TraceMap } from '@jridgewell/trace-mapping';
import { AnalysisError } from './errors';
import { byteLength, clip, shown } from './text';

/** Parses and validates a v3 source map; `sections` maps are flattened. */
export function parseSourceMap(text: string): TraceMap {
  // XSSI guard some servers prepend; the spec allows stripping the first line.
  const body = text.startsWith(")]}'") ? text.slice(text.indexOf('\n') + 1) : text;
  let raw: any;
  try {
    raw = JSON.parse(body);
  } catch (error) {
    throw new AnalysisError('SOURCEMAP_INVALID', `not JSON: ${(error as Error).message}`);
  }
  if (!raw || typeof raw !== 'object' || raw.version !== 3) {
    throw new AnalysisError('SOURCEMAP_INVALID', 'version must be 3');
  }
  const sectioned = Array.isArray(raw.sections);
  if (!sectioned && (!Array.isArray(raw.sources) || typeof raw.mappings !== 'string')) {
    throw new AnalysisError('SOURCEMAP_INVALID', 'sources array and mappings string are required');
  }
  try {
    return AnyMap(raw);
  } catch (error) {
    throw new AnalysisError('SOURCEMAP_INVALID', (error as Error).message);
  }
}

interface SourceEntry {
  index: number;
  source: string;
  hasContent: boolean;
  contentLength?: number;
}

function sourceEntries(map: TraceMap): SourceEntry[] {
  return map.sources.map((source, index) => {
    const content = map.sourcesContent?.[index];
    return {
      index,
      source: source ?? '',
      hasContent: typeof content === 'string',
      ...(typeof content === 'string' ? { contentLength: content.length } : {}),
    };
  });
}

export interface PageOptions {
  cursor: number;
  limit: number;
  maxOutputBytes: number;
  sanitize: boolean;
}

export function describeMap(text: string, page: PageOptions) {
  const map = parseSourceMap(text);
  const entries = sourceEntries(map);
  const out: SourceEntry[] = [];
  let used = 0;
  let redacted = false;
  let index = page.cursor;
  for (; index < entries.length && out.length < page.limit; index += 1) {
    const view = shown(clip(entries[index].source, 1000), page.sanitize);
    redacted ||= view.redacted;
    const entry = { ...entries[index], source: view.text };
    const size = byteLength(entry);
    if (out.length > 0 && used + size > page.maxOutputBytes) break;
    out.push(entry);
    used += size;
  }
  return {
    ...(map.file ? { file: map.file } : {}),
    sourceCount: entries.length,
    sourcesWithContent: entries.filter((entry) => entry.hasContent).length,
    sources: out,
    hasMore: index < entries.length,
    ...(index < entries.length ? { nextCursor: String(index) } : {}),
    ...(redacted ? { redacted: true } : {}),
  };
}

/** `line`/`column` are 0-based generated positions; the result is 0-based as well. */
export function lookup(text: string, line: number, column: number, sanitize: boolean) {
  const map = parseSourceMap(text);
  const found = originalPositionFor(map, { line: line + 1, column });
  if (found.source === null) return { found: false as const };
  // Report the source as `load` lists it, not trace-mapping's normalized form.
  const sourceIndex = map.resolvedSources.indexOf(found.source);
  const source = shown(map.sources[sourceIndex] ?? found.source, sanitize);
  const name = found.name === null ? undefined : shown(found.name, sanitize);
  return {
    found: true as const,
    sourceIndex,
    source: source.text,
    line: found.line - 1,
    column: found.column,
    ...(name ? { name: name.text } : {}),
    ...(source.redacted || name?.redacted ? { redacted: true } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// restore

export interface RestoreFile {
  index: number;
  source: string;
  /** Relative path under outDir, '/'-separated. */
  path: string;
  content: string;
}

export interface RestoreSkip {
  index: number;
  source: string;
  reason: 'no-content' | 'empty-path' | 'path-conflict';
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const MAX_SEGMENT = 120;

/** Makes one path segment valid on Windows, macOS and Linux. */
export function safeSegment(segment: string): string {
  let out = '';
  for (const char of segment) {
    const code = char.charCodeAt(0);
    out += code < 0x20 || '<>:"|?*\\/'.includes(char) ? '_' : char;
  }
  out = out.replace(/[. ]+$/, (tail) => '_'.repeat(tail.length));
  if (RESERVED.test(out)) out = '_' + out;
  if (out.length > MAX_SEGMENT) {
    const dot = out.lastIndexOf('.');
    const ext = dot > 0 && out.length - dot <= 16 ? out.slice(dot) : '';
    out = out.slice(0, MAX_SEGMENT - ext.length) + ext;
  }
  return out;
}

/**
 * Turns a source URL such as `webpack://app/./src/a.js?x` into relative segments.
 * `..` is clamped at the root the way URL resolution does, so nothing escapes outDir.
 */
export function sourceSegments(source: string): string[] {
  let rest = source.replace(/\\/g, '/');
  if (/^[a-zA-Z]:\//.test(rest)) {
    // Windows drive path: keep the letter as a directory.
    rest = rest[0] + rest.slice(2);
  } else {
    rest = rest.replace(/^[a-zA-Z][a-zA-Z0-9+.-]+:\/*/, '');
  }
  const segments: string[] = [];
  for (const part of rest.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') segments.pop();
    else segments.push(safeSegment(part));
  }
  return segments;
}

export function withSuffix(path: string, n: number): string {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  return dot > slash + 1 ? `${path.slice(0, dot)}~${n}${path.slice(dot)}` : `${path}~${n}`;
}

/** Plans the files to write. Paths are unique case-insensitively and never nest under a file. */
export function planRestore(text: string): {
  files: RestoreFile[];
  skipped: RestoreSkip[];
} {
  const map = parseSourceMap(text);
  const files: RestoreFile[] = [];
  const skipped: RestoreSkip[] = [];
  const filePaths = new Set<string>();
  const dirPaths = new Set<string>();
  map.sources.forEach((rawSource, index) => {
    const source = rawSource ?? '';
    const content = map.sourcesContent?.[index];
    if (typeof content !== 'string') {
      skipped.push({ index, source, reason: 'no-content' });
      return;
    }
    const segments = sourceSegments(source);
    if (!segments.length) {
      skipped.push({ index, source, reason: 'empty-path' });
      return;
    }
    const dirs: string[] = [];
    for (let depth = 1; depth < segments.length; depth += 1) {
      dirs.push(segments.slice(0, depth).join('/').toLowerCase());
    }
    if (dirs.some((dir) => filePaths.has(dir))) {
      skipped.push({ index, source, reason: 'path-conflict' });
      return;
    }
    let path = segments.join('/');
    for (let n = 1; filePaths.has(path.toLowerCase()) || dirPaths.has(path.toLowerCase()); n += 1) {
      path = withSuffix(segments.join('/'), n);
    }
    filePaths.add(path.toLowerCase());
    for (const dir of dirs) dirPaths.add(dir);
    files.push({ index, source, path, content });
  });
  return { files, skipped };
}
