import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { beautify, parseProgram, search, unpack, type SearchOptions } from './code';
import { AnalysisError } from './errors';
import { ZERO_BASE } from './text';

const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, '__fixtures__', name), 'utf8');

const options = (overrides: Partial<SearchOptions>): SearchOptions => ({
  kind: 'function',
  isRegex: false,
  caseSensitive: false,
  contextChars: 20,
  cursor: 0,
  limit: 50,
  maxOutputBytes: 51_200,
  sanitize: true,
  ...overrides,
});

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AnalysisError);
    return (error as AnalysisError).code;
  }
  throw new Error('expected an AnalysisError');
}

describe('parseProgram', () => {
  test('accepts scripts with top-level return and ES modules', () => {
    expect(parseProgram('return 1', ZERO_BASE).sourceType).toBe('script');
    expect(parseProgram('import x from "y"; export default x', ZERO_BASE).sourceType).toBe(
      'module',
    );
  });

  test('reports the syntax error at a 0-based resource-relative location', () => {
    expect(() => parseProgram('a;\nb c', { line: 10, column: 4 })).toThrow(
      /^PARSE_FAILED: Unexpected token at line 11, column 2 \(offset 5\)$/,
    );
  });
});

describe('beautify', () => {
  test('formats js, css and html', () => {
    expect(beautify('function a(){return 1}', 'js')).toBe('function a() {\n  return 1\n}\n');
    expect(beautify('a{color:red}', 'css')).toBe('a {\n  color: red\n}\n');
    expect(beautify('<div><p>x</p></div>', 'html')).toContain('<div>\n  <p>x</p>\n</div>');
  });
});

describe('unpack', () => {
  test('finds the webpack 5 production module table through the runtime require', () => {
    const result = unpack(fixture('webpack-prod.js'), ZERO_BASE);
    expect(result.formats).toEqual(['webpack']);
    expect(result.modules).toEqual([
      { id: '28', format: 'webpack', deps: [], offset: 33, endOffset: 129, line: 0, column: 33 },
    ]);
  });

  test('finds string-keyed development modules', () => {
    const result = unpack(fixture('webpack-dev.js'), ZERO_BASE);
    expect(result.formats).toEqual(['webpack']);
    expect(result.modules.map((module) => module.id)).toEqual(['./src/util.mjs']);
  });

  test('finds webpack chunk pushes with chunk ids', () => {
    const text = fixture('webpack-chunk.js');
    const [module] = unpack(text, ZERO_BASE).modules;
    expect(module).toMatchObject({ id: '598', format: 'webpack-chunk', chunkIds: ['245'] });
    expect(text.slice(module.offset, module.endOffset)).toMatch(/^\(e,l,n\)=>\{.*\}$/);
  });

  test('finds webpack 4 array tables passed to the bootstrap IIFE, with literal deps', () => {
    const result = unpack(fixture('webpack4.js'), ZERO_BASE);
    expect(result.modules.map(({ id, deps }) => ({ id, deps }))).toEqual([
      { id: '0', deps: [] },
      { id: '1', deps: ['0'] },
    ]);
  });

  test('finds browserify modules, deps and entries', () => {
    const result = unpack(fixture('browserify.js'), ZERO_BASE);
    expect(result.formats).toEqual(['browserify']);
    expect(result.modules.map(({ id, deps, entry }) => ({ id, deps, entry }))).toEqual([
      { id: '1', deps: ['2'], entry: true },
      { id: '2', deps: [], entry: undefined },
    ]);
  });

  test('applies the script base to module locations', () => {
    const [module] = unpack(fixture('webpack-chunk.js'), { line: 3, column: 8 }).modules;
    expect(module).toMatchObject({ line: 3, column: 8 + module.offset });
  });

  test('rejects code that is not a known bundle', () => {
    expect(codeOf(() => unpack('function f(a){return a.exports}', ZERO_BASE))).toBe(
      'BUNDLE_FORMAT_UNKNOWN',
    );
    // A require-like function whose table is not made of factories.
    expect(
      codeOf(() => unpack('var t={a:1};function r(i){return t[i].call(), r.exports}', ZERO_BASE)),
    ).toBe('BUNDLE_FORMAT_UNKNOWN');
    expect(codeOf(() => unpack('var x = ;', ZERO_BASE))).toBe('PARSE_FAILED');
  });
});

describe('search', () => {
  const app = fixture('webpack-prod.js');

  test('finds calls by callee path with location, enclosing function and snippet', () => {
    const result = search(app, ZERO_BASE, options({ kind: 'call', query: 'btoa' }));
    expect(result).toMatchObject({ kind: 'call', total: 1, hasMore: false });
    expect(result.matches[0]).toEqual({
      line: 0,
      column: 76,
      offset: 76,
      endOffset: 85,
      type: 'CallExpression',
      name: 'btoa',
      enclosing: 'n',
      snippet: 't){return e+"?sig="+btoa(t+e)}r.d(t,{t:()=>o,z:()',
    });
  });

  test('names functions from declarations, variables, properties and member assignments', () => {
    const text = 'function a(){} var b=function(){}; o.c.d=()=>1; x={e(){}}; class K{f(){}}';
    const names = search(text, ZERO_BASE, options({ kind: 'function' })).matches.map(
      (match: any) => match.name,
    );
    expect(names).toEqual(['a', 'b', 'o.c.d', 'e', 'f']);
  });

  test('finds string and template literals, case-insensitively by default', () => {
    const text = 'a("Token"); b(`token-x`); c(`t${1}oken`)';
    const result = search(text, ZERO_BASE, options({ kind: 'string', query: 'TOKEN' }));
    expect(result.matches.map((match: any) => match.value)).toEqual(['Token', 'token-x']);
    const sensitive = search(
      text,
      ZERO_BASE,
      options({ kind: 'string', query: 'Token', caseSensitive: true }),
    );
    expect(sensitive.total).toBe(1);
  });

  test('supports regex queries and esquery selectors', () => {
    const regex = search(
      app,
      ZERO_BASE,
      options({ kind: 'call', query: '^r\\.d$', isRegex: true }),
    );
    expect(regex.total).toBe(1);
    const selector = search(
      app,
      ZERO_BASE,
      options({ kind: 'selector', selector: 'CallExpression[callee.name="btoa"]' }),
    );
    expect(selector.matches).toEqual([
      expect.objectContaining({ offset: 76, type: 'CallExpression', enclosing: 'n' }),
    ]);
  });

  test('pages with cursor and limit in source order', () => {
    const first = search(app, ZERO_BASE, options({ kind: 'function', limit: 2 }));
    expect(first).toMatchObject({ total: 25, hasMore: true, nextCursor: '2' });
    const second = search(app, ZERO_BASE, options({ kind: 'function', limit: 2, cursor: 2 }));
    expect((second.matches[0] as any).offset).toBeGreaterThan((first.matches[1] as any).offset);
  });

  test('stops a page at maxOutputBytes but always returns one match', () => {
    const result = search(app, ZERO_BASE, options({ kind: 'function', maxOutputBytes: 1000 }));
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result).toMatchObject({ hasMore: true, pageTruncatedByBytes: true });
  });

  test('redacts tokens in snippets and values unless sanitize is off', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXNpZ25hdHVyZQ';
    const text = `send("${jwt}")`;
    const redacted = search(text, ZERO_BASE, options({ kind: 'string' }));
    expect(redacted.redacted).toBe(true);
    expect(JSON.stringify(redacted)).not.toContain(jwt);
    const raw = search(text, ZERO_BASE, options({ kind: 'string', sanitize: false }));
    expect((raw.matches[0] as any).value).toBe(jwt);
  });

  test('walks deep nesting and reports parser stack exhaustion as PARSE_FAILED', () => {
    const deep = (n: number) => 'x=' + '['.repeat(n) + 'f()' + ']'.repeat(n);
    expect(search(deep(1000), ZERO_BASE, options({ kind: 'call' })).total).toBe(1);
    expect(() => search(deep(100_000), ZERO_BASE, options({ kind: 'call' }))).toThrow(
      /^PARSE_FAILED: Not enough stack space/,
    );
  });

  test('rejects invalid regex and selector input', () => {
    expect(codeOf(() => search(app, ZERO_BASE, options({ query: '(', isRegex: true })))).toBe(
      'INVALID_ARGUMENT',
    );
    expect(
      codeOf(() => search(app, ZERO_BASE, options({ kind: 'selector', selector: '[[' }))),
    ).toBe('INVALID_ARGUMENT');
  });
});
