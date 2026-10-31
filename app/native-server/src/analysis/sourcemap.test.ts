import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { describeMap, lookup, parseSourceMap, planRestore, sourceSegments } from './sourcemap';

const mapText = fs.readFileSync(
  path.join(__dirname, '__fixtures__', 'webpack-prod.js.map'),
  'utf8',
);
const bundle = fs.readFileSync(path.join(__dirname, '__fixtures__', 'webpack-prod.js'), 'utf8');
const page = { cursor: 0, limit: 50, maxOutputBytes: 51_200, sanitize: true };

const map = (sources: string[], contents?: Array<string | null>) =>
  JSON.stringify({ version: 3, sources, sourcesContent: contents, names: [], mappings: 'AAAA' });

describe('parseSourceMap', () => {
  test('accepts v3 maps, an XSSI prefix and indexed maps with sections', () => {
    expect(parseSourceMap(mapText).sources).toHaveLength(11);
    expect(parseSourceMap(")]}'\n" + map(['a.js'])).sources).toEqual(['a.js']);
    const indexed = JSON.stringify({
      version: 3,
      sections: [
        { offset: { line: 0, column: 0 }, map: JSON.parse(map(['a.js'], ['A'])) },
        { offset: { line: 5, column: 0 }, map: JSON.parse(map(['b.js'], ['B'])) },
      ],
    });
    expect(parseSourceMap(indexed).sources).toEqual(['a.js', 'b.js']);
  });

  test.each([
    ['not JSON', '{', /^SOURCEMAP_INVALID: not JSON/],
    [
      'wrong version',
      JSON.stringify({ version: 2, sources: [], mappings: '' }),
      /version must be 3/,
    ],
    [
      'missing mappings',
      JSON.stringify({ version: 3, sources: [] }),
      /mappings string are required/,
    ],
  ])('rejects %s', (_label, text, message) => {
    expect(() => parseSourceMap(text)).toThrow(message);
  });
});

describe('describeMap', () => {
  test('lists sources with content flags and pages with cursor', () => {
    const first = describeMap(mapText, { ...page, limit: 2 });
    expect(first).toMatchObject({
      file: 'webpack-prod.js',
      sourceCount: 11,
      sourcesWithContent: 11,
      hasMore: true,
      nextCursor: '2',
    });
    expect(first.sources[1]).toEqual({
      index: 1,
      source: 'webpack://gen/./src/util.mjs',
      hasContent: true,
      contentLength: 128,
    });
    const last = describeMap(mapText, { ...page, cursor: 10 });
    expect(last).toMatchObject({ hasMore: false, sources: [{ index: 10 }] });
  });
});

describe('lookup', () => {
  test('maps a 0-based generated position to the original, reporting the listed source', () => {
    expect(lookup(mapText, 0, bundle.indexOf('btoa'), true)).toEqual({
      found: true,
      sourceIndex: 1,
      source: 'webpack://gen/./src/util.mjs',
      line: 1,
      column: 0,
      name: 'btoa',
    });
  });

  test('reports positions without a mapping as not found', () => {
    expect(lookup(mapText, 500, 0, true)).toEqual({ found: false });
  });
});

describe('restore planning', () => {
  test('drops URL schemes, clamps .. at the root and keeps drive letters as directories', () => {
    expect(sourceSegments('webpack://app/./src/a.js')).toEqual(['app', 'src', 'a.js']);
    expect(sourceSegments('http://host:8080/x/y.js?v=1')).toEqual(['host_8080', 'x', 'y.js_v=1']);
    expect(sourceSegments('../../../etc/passwd')).toEqual(['etc', 'passwd']);
    expect(sourceSegments('C:\\work\\a.ts')).toEqual(['C', 'work', 'a.ts']);
    expect(sourceSegments('webpack:///./node_modules/x/CON.js')).toEqual([
      'node_modules',
      'x',
      '_CON.js',
    ]);
    expect(sourceSegments('a/trailing. /b<|>.js')).toEqual(['a', 'trailing__', 'b___.js']);
  });

  test('writes sources with content once, renaming case-insensitive duplicates', () => {
    const plan = planRestore(
      map(
        ['src/A.js', 'src/a.js', 'src/b.js', 'src/a.js/x.js', 'webpack://', 'missing.js'],
        ['1', '2', '3', '4', '5', null],
      ),
    );
    expect(plan.files.map(({ path, content }) => [path, content])).toEqual([
      ['src/A.js', '1'],
      ['src/a~1.js', '2'],
      ['src/b.js', '3'],
    ]);
    expect(plan.skipped).toEqual([
      { index: 3, source: 'src/a.js/x.js', reason: 'path-conflict' },
      { index: 4, source: 'webpack://', reason: 'empty-path' },
      { index: 5, source: 'missing.js', reason: 'no-content' },
    ]);
  });

  test('renames a file that would replace an existing directory', () => {
    const plan = planRestore(map(['src/a/x.js', 'src/a'], ['1', '2']));
    expect(plan.files.map((file) => file.path)).toEqual(['src/a/x.js', 'src/a~1']);
  });
});
