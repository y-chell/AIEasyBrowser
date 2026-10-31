import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from '@jest/globals';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { computeJob } from './compute';
import { runAnalysisTool, type AnalysisContext } from './index';

const FIXTURES = path.join(__dirname, '__fixtures__');
const prod = fs.readFileSync(path.join(FIXTURES, 'webpack-prod.js'), 'utf8');
const prodMap = fs.readFileSync(path.join(FIXTURES, 'webpack-prod.js.map'), 'utf8');

let dir: string;
let invoke: jest.Mock<AnalysisContext['invoke']>;
let server: http.Server;
let origin: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/static/webpack-prod.js.map') res.end(prodMap);
    else res.writeHead(404).end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((done) => server.close(done)));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aieasybrowser-analysis-'));
  invoke = jest.fn();
});
afterEach(() => {
  expect(path.dirname(dir)).toBe(path.resolve(os.tmpdir()));
  fs.rmSync(dir, { recursive: true, force: true });
});

const context = (): AnalysisContext => ({
  invoke,
  signal: new AbortController().signal,
  run: async (job) => computeJob(job),
});
const call = (name: string, args: Record<string, unknown>) =>
  runAnalysisTool(name, args, context());

/** Serves `text` as a held script in pages of `pageSize` code units. */
function serveScript(text: string, script: Record<string, unknown>, pageSize = 1000) {
  invoke.mockImplementation(async (_name, args: any) => {
    const end = Math.min(text.length, args.offset + Math.min(args.length, pageSize));
    return {
      script: {
        scriptId: '42',
        url: `${origin}/static/app.js?v=1`,
        startLine: 0,
        startColumn: 0,
        ...script,
      },
      totalLength: text.length,
      offset: args.offset,
      endOffset: end,
      text: text.slice(args.offset, end),
      hasMore: end < text.length,
    };
  });
}

describe('argument rules', () => {
  test.each([
    [{ action: 'search', kind: 'call' }, /pass exactly one of file, text, scriptId/],
    [{ action: 'search', kind: 'call', text: 'a', file: 'b' }, /pass exactly one of/],
    [{ action: 'search', kind: 'call', text: 'a', tabId: 1 }, /tabId is only valid with scriptId/],
    [{ action: 'search', text: 'a' }, /search requires kind/],
    [{ action: 'search', kind: 'selector', text: 'a' }, /kind selector requires selector/],
    [
      { action: 'search', kind: 'call', text: 'a', selector: 'X' },
      /selector requires kind selector/,
    ],
    [{ action: 'search', kind: 'call', text: 'a', limit: 0 }, /limit must be an integer in 1..500/],
    [{ action: 'search', kind: 'call', text: 'a', cursor: 'x' }, /cursor must come from/],
    [{ action: 'search', kind: 'call', text: 'a', cursor: '9' }, /cursor is past the match list/],
    [
      { action: 'search', kind: 'call', text: 'a', outDir: 'C:/x' },
      /search does not accept outDir/,
    ],
    [{ action: 'beautify', file: 'relative.js' }, /file must be an absolute path/],
    [{ action: 'beautify', text: 'a', overwrite: true }, /overwrite requires outFile/],
    [{ action: 'beautify', text: 'a', outFile: '/x.js', offset: 1 }, /offset does not apply/],
    [{ action: 'unpack', text: prod, overwrite: true }, /overwrite requires outDir/],
  ])('rejects %j', async (args, message) => {
    await expect(call('analysis_code', args)).rejects.toThrow(message);
    expect(invoke).not.toHaveBeenCalled();
  });

  test('reports missing and invalid input files explicitly', async () => {
    await expect(
      call('analysis_code', { action: 'beautify', file: path.join(dir, 'none.js') }),
    ).rejects.toThrow(/^INPUT_READ_FAILED: .*none\.js: ENOENT/);
    const latin1 = path.join(dir, 'latin1.js');
    fs.writeFileSync(latin1, Buffer.from([0x61, 0xe9, 0x62]));
    await expect(call('analysis_code', { action: 'beautify', file: latin1 })).rejects.toThrow(
      /^INPUT_READ_FAILED: .*is not valid UTF-8$/,
    );
  });
});

describe('analysis_code', () => {
  test('beautify pages the formatted text and picks the language from the extension', async () => {
    const css = path.join(dir, 'a.css');
    fs.writeFileSync(css, '\ufeffa{color:red}b{color:blue}');
    const first: any = await call('analysis_code', { action: 'beautify', file: css, length: 10 });
    expect(first).toMatchObject({
      source: { type: 'file', file: css },
      language: 'css',
      offset: 0,
      endOffset: 10,
      text: 'a {\n  colo',
      hasMore: true,
    });
    const next: any = await call('analysis_code', { action: 'beautify', file: css, offset: 10 });
    expect(first.text + next.text).toBe('a {\n  color: red\n}\n\nb {\n  color: blue\n}\n');
    expect(next.hasMore).toBe(false);
  });

  test('beautify writes outFile once and refuses to replace it without overwrite', async () => {
    const outFile = path.join(dir, 'nested', 'out.js');
    const args = { action: 'beautify', text: 'if(a){b()}', outFile };
    await expect(call('analysis_code', args)).resolves.toMatchObject({ outFile, language: 'js' });
    expect(fs.readFileSync(outFile, 'utf8')).toBe('if (a) {\n  b()\n}\n');
    await expect(call('analysis_code', args)).rejects.toThrow(/^OUTPUT_EXISTS: /);
    await expect(
      call('analysis_code', { ...args, text: 'c()', overwrite: true }),
    ).resolves.toBeTruthy();
    expect(fs.readFileSync(outFile, 'utf8')).toBe('c()\n');
  });

  test('unpack writes one file per module and a manifest', async () => {
    const outDir = path.join(dir, 'modules');
    const text = fs.readFileSync(path.join(FIXTURES, 'webpack-dev.js'), 'utf8');
    const result: any = await call('analysis_code', { action: 'unpack', text, outDir });
    expect(result).toMatchObject({
      formats: ['webpack'],
      moduleCount: 1,
      manifest: path.join(outDir, 'manifest.json'),
      modules: [{ id: './src/util.mjs', file: '._src_util.mjs.js' }],
      hasMore: false,
    });
    const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
    expect(manifest.modules[0]).toMatchObject({ id: './src/util.mjs', file: '._src_util.mjs.js' });
    const module = fs.readFileSync(path.join(outDir, '._src_util.mjs.js'), 'utf8');
    expect(module).toBe(
      text.slice(manifest.modules[0].offset, manifest.modules[0].endOffset) + '\n',
    );
    await expect(call('analysis_code', { action: 'unpack', text, outDir })).rejects.toThrow(
      /^OUTPUT_EXISTS/,
    );
  });

  test('reads a held script in pages and reports resource-relative locations', async () => {
    const body = 'x();\n'.repeat(400) + 'secretCall();';
    serveScript(body, { startLine: 10, startColumn: 4, sessionId: 'S1' });
    const result: any = await call('analysis_code', {
      action: 'search',
      scriptId: '42',
      sessionId: 'S1',
      tabId: 7,
      kind: 'call',
      query: 'secretCall',
    });
    expect(invoke.mock.calls.map(([, args]: any) => args.offset)).toEqual([0, 1000, 2000]);
    expect(invoke.mock.calls[0]).toEqual([
      'chrome_cdp_scripts',
      expect.objectContaining({
        action: 'source',
        scriptId: '42',
        sessionId: 'S1',
        tabId: 7,
        sanitizeOutput: false,
      }),
    ]);
    expect(result.source).toEqual({
      type: 'script',
      scriptId: '42',
      sessionId: 'S1',
      url: `${origin}/static/app.js`,
      startLine: 10,
      startColumn: 4,
      length: body.length,
    });
    expect(result.matches[0]).toMatchObject({ line: 410, column: 0, offset: 2000 });
  });

  test('rejects held scripts above the input limit before reading them', async () => {
    invoke.mockResolvedValue({
      script: { scriptId: '1' },
      totalLength: 60 * 1024 * 1024,
      offset: 0,
      endOffset: 1,
      text: 'x',
      hasMore: true,
    });
    await expect(call('analysis_code', { action: 'unpack', scriptId: '1' })).rejects.toThrow(
      /^INPUT_TOO_LARGE: /,
    );
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe('analysis_sourcemap', () => {
  test('loads the map of a held script through its sourceMappingURL and looks up a hit', async () => {
    serveScript(prod, { sourceMapURL: 'webpack-prod.js.map', startLine: 2, startColumn: 0 });
    const loaded: any = await call('analysis_sourcemap', {
      action: 'load',
      scriptId: '42',
      limit: 1,
    });
    expect(loaded).toMatchObject({
      source: { type: 'script', sourceMapURL: `${origin}/static/webpack-prod.js.map` },
      sourceCount: 11,
      nextCursor: '1',
    });
    const found: any = await call('analysis_sourcemap', {
      action: 'lookup',
      scriptId: '42',
      line: 2,
      column: prod.indexOf('btoa'),
    });
    expect(found).toMatchObject({
      generated: { line: 2, column: 76 },
      original: { found: true, source: 'webpack://gen/./src/util.mjs', line: 1, name: 'btoa' },
    });
    await expect(
      call('analysis_sourcemap', { action: 'lookup', scriptId: '42', line: 1 }),
    ).rejects.toThrow(/is before the start of script 42/);
  });

  test('fails explicitly when a script has no map or a non-http map URL', async () => {
    serveScript('x()', {});
    await expect(call('analysis_sourcemap', { action: 'load', scriptId: '42' })).rejects.toThrow(
      /^SOURCEMAP_NOT_FOUND: script 42 has no sourceMappingURL$/,
    );
    serveScript('x()', { url: 'file:///C:/app.js', sourceMapURL: 'app.js.map' });
    await expect(call('analysis_sourcemap', { action: 'load', scriptId: '42' })).rejects.toThrow(
      /^SOURCEMAP_FETCH_FAILED: file:…: only http, https and data/,
    );
    serveScript('x()', { url: '', sourceMapURL: 'app.js.map' });
    await expect(call('analysis_sourcemap', { action: 'load', scriptId: '42' })).rejects.toThrow(
      /cannot be resolved without a script url/,
    );
  });

  test('restores sources from a url under outDir', async () => {
    const outDir = path.join(dir, 'src');
    const result: any = await call('analysis_sourcemap', {
      action: 'restore',
      url: `${origin}/static/webpack-prod.js.map`,
      outDir,
    });
    expect(result).toMatchObject({ outDir, written: 11, skippedCount: 0 });
    expect(fs.readFileSync(path.join(outDir, 'gen', 'src', 'util.mjs'), 'utf8')).toContain(
      'btoa(secret + path)',
    );
    await expect(
      call('analysis_sourcemap', { action: 'restore', text: prodMap, outDir }),
    ).rejects.toThrow(/^OUTPUT_EXISTS: .*load script exists/);
  });

  test('rejects lookup without line and restore without outDir', async () => {
    await expect(call('analysis_sourcemap', { action: 'lookup', text: prodMap })).rejects.toThrow(
      /lookup requires line/,
    );
    await expect(call('analysis_sourcemap', { action: 'restore', text: prodMap })).rejects.toThrow(
      /restore requires outDir/,
    );
  });
});

describe('analysis_decode', () => {
  test('decodes in the calling thread', async () => {
    await expect(call('analysis_decode', { action: 'hex', text: '6869' })).resolves.toMatchObject({
      text: 'hi',
    });
    await expect(
      call('analysis_decode', { action: 'hex', text: '6869', limit: 1 }),
    ).rejects.toThrow(/analysis_decode hex does not accept limit/);
  });
});
