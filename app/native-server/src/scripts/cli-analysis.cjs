'use strict';

// Real-browser acceptance for the Native-side analysis tools: decode and text input without the
// page, then a held chrome_cdp_session page script read through chrome_cdp_scripts for
// sourcemap load/lookup/restore, bundle unpack, AST search and beautify to a file.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const {
  runCli,
  assertOk,
  assertFailure,
  createFixtureServer,
  cleanupTargets,
  runWithCleanup,
} = require('./cli-regression.cjs');

const ANALYSIS_TOOLS = ['analysis_code', 'analysis_decode', 'analysis_sourcemap'];
// Same token as /analysis/nomap.js in the fixture server.
const jwtText =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZWIiLCJleHAiOjQxMDI0NDQ4MDB9.c2lnbmF0dXJlLWJ5dGVz';

function errorCode(response) {
  return /([A-Z_]{6,}):/.exec(response.error.message)?.[1];
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (text += chunk));
        response.on('end', () => resolve(text));
      })
      .on('error', reject);
  });
}

// 0-based line/column (UTF-16) of the first occurrence of needle in a resource.
function locate(text, needle) {
  const offset = text.indexOf(needle);
  assert(offset >= 0, 'needle not in resource: ' + needle);
  const lines = text.slice(0, offset).split(/\r\n|[\n\r\u2028\u2029]/);
  return { line: lines.length - 1, column: lines[lines.length - 1].length, offset };
}

async function runAnalysis() {
  const runId = randomUUID().replaceAll('-', '');
  const name = 'analysis_' + runId.slice(0, 8);
  const tabs = [];
  const urls = [];
  let fixture;
  let started = false;
  let outRoot;
  const ok = (args, label) => assertOk(runCli(name, args), label || args[1] || args[0]);
  const call = (tool, args, label) =>
    ok(['call', tool, JSON.stringify(args)], label || tool + ' ' + args.action).result;
  const fails = (tool, args, label) =>
    errorCode(assertFailure(runCli(name, ['call', tool, JSON.stringify(args)]), label));

  return runWithCleanup(
    async () => {
      const health = ok(['health']).result;
      for (const tool of ANALYSIS_TOOLS)
        assert(
          health.schema.toolNames.includes(tool),
          'running extension lacks ' + tool + '; rebuild and reload it first',
        );
      outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aeb-analysis-'));

      // 1. Decode and text input run in Native before any tab exists.
      const jwt = call('analysis_decode', {
        action: 'jwt',
        text: jwtText,
      });
      assert.deepEqual(jwt.header, { alg: 'HS256' });
      assert.equal(jwt.payload.sub, 'aeb');
      assert.equal(jwt.times.exp, '2100-01-01T00:00:00.000Z');
      assert.equal(jwt.verified, false);
      assert.equal(
        fails('analysis_decode', { action: 'hex', text: 'abc' }, 'odd hex'),
        'DECODE_FAILED',
      );
      assert.equal(
        fails('analysis_code', { action: 'unpack', text: 'var plain = 1;' }, 'plain unpack'),
        'BUNDLE_FORMAT_UNKNOWN',
      );
      assert.equal(
        fails('analysis_code', { action: 'search', kind: 'call', text: 'a(' }, 'bad syntax'),
        'PARSE_FAILED',
      );

      // 2. Page scripts: the webpack bundle with a served map, one without and one with a 404 map.
      fixture = await createFixtureServer(runId);
      const pageUrl = fixture.origin + '/analysis?run=' + runId;
      const bundleUrl = fixture.origin + '/analysis/webpack-prod.js';
      urls.push(pageUrl);
      const [bundle, mapText] = await Promise.all([
        fetchText(bundleUrl),
        fetchText(bundleUrl + '.map'),
      ]);
      const sourceMap = JSON.parse(mapText);
      tabs.push(ok(['open', pageUrl, '--background']).result.tabId);
      ok([
        'wait',
        JSON.stringify({
          kind: 'javascript',
          predicate:
            'document.readyState === "complete" && window.aebAnalysis && window.analysisRun === "' +
            runId +
            '" && window.analysisBad === 1',
        }),
      ]);
      call('chrome_cdp_session', { action: 'start' });
      started = true;
      const listed = call('chrome_cdp_scripts', { action: 'list', limit: 1000 }).scripts;
      const byUrl = (url) => {
        const script = listed.find((item) => !item.sessionId && item.url === url);
        assert(script, url + ' missing: ' + JSON.stringify(listed.map((item) => item.url)));
        return script;
      };
      const external = byUrl(bundleUrl);
      const nomap = byUrl(fixture.origin + '/analysis/nomap.js');
      const badmap = byUrl(fixture.origin + '/analysis/badmap.js');
      assert.equal(external.length, bundle.length);
      assert.equal(external.sourceMapURL, 'webpack-prod.js.map');

      // 3. sourcemap load resolves the relative map URL against the script and fetches it.
      const loaded = call('analysis_sourcemap', { action: 'load', scriptId: external.scriptId });
      assert.equal(loaded.source.type, 'script');
      assert.equal(loaded.source.sourceMapURL, bundleUrl + '.map');
      assert.equal(loaded.sourceCount, sourceMap.sources.length);
      assert.deepEqual(
        loaded.sources.map((item) => item.source),
        sourceMap.sources,
      );
      const withContent = sourceMap.sourcesContent.filter((item) => typeof item === 'string');
      assert.equal(loaded.sourcesWithContent, withContent.length);

      // 4. lookup and search agree on the script-relative position of btoa.
      const btoa = locate(bundle, 'btoa');
      const looked = call('analysis_sourcemap', {
        action: 'lookup',
        scriptId: external.scriptId,
        line: external.startLine + btoa.line,
        column: btoa.column,
      });
      assert.deepEqual(looked.generated, { line: btoa.line, column: btoa.column });
      assert.deepEqual(looked.original, {
        found: true,
        sourceIndex: 1,
        source: 'webpack://gen/./src/util.mjs',
        line: 1,
        column: 0,
        name: 'btoa',
      });
      assert(
        sourceMap.sourcesContent[1].split('\n')[1].includes('btoa('),
        'original line lacks btoa',
      );
      const calls = call('analysis_code', {
        action: 'search',
        scriptId: external.scriptId,
        kind: 'call',
        query: 'btoa',
      });
      assert.equal(calls.source.scriptId, external.scriptId);
      assert.equal(calls.total, 1);
      assert.deepEqual(
        {
          line: calls.matches[0].line,
          column: calls.matches[0].column,
          name: calls.matches[0].name,
        },
        { line: btoa.line, column: btoa.column, name: 'btoa' },
      );

      // 5. unpack finds the webpack module table and writes one file per module plus a manifest.
      const unpackDir = path.join(outRoot, 'modules');
      const unpacked = call('analysis_code', {
        action: 'unpack',
        scriptId: external.scriptId,
        outDir: unpackDir,
      });
      assert.deepEqual(unpacked.formats, ['webpack']);
      assert.deepEqual(
        unpacked.modules.map((module) => module.id),
        ['28'],
      );
      const moduleText = fs.readFileSync(path.join(unpackDir, unpacked.modules[0].file), 'utf8');
      assert(moduleText.includes('btoa('), 'module file lacks the module body');
      const manifest = JSON.parse(fs.readFileSync(unpacked.manifest, 'utf8'));
      assert.equal(manifest.source.scriptId, external.scriptId);
      assert.equal(
        fails(
          'analysis_code',
          { action: 'unpack', scriptId: external.scriptId, outDir: unpackDir },
          'unpack into used dir',
        ),
        'OUTPUT_EXISTS',
      );

      // 6. restore writes every source with content; a second run refuses to overwrite.
      const restoreDir = path.join(outRoot, 'sources');
      const restored = call('analysis_sourcemap', {
        action: 'restore',
        scriptId: external.scriptId,
        outDir: restoreDir,
      });
      assert.equal(restored.written, withContent.length);
      const util = restored.files.find((file) => file.source === 'webpack://gen/./src/util.mjs');
      assert(util, 'util.mjs not restored: ' + JSON.stringify(restored.files));
      assert.equal(
        fs.readFileSync(path.join(restoreDir, ...util.path.split(/[\\/]/)), 'utf8'),
        sourceMap.sourcesContent[1],
      );
      assert.equal(
        fails(
          'analysis_sourcemap',
          { action: 'restore', scriptId: external.scriptId, outDir: restoreDir },
          'restore into used dir',
        ),
        'OUTPUT_EXISTS',
      );
      const again = call('analysis_sourcemap', {
        action: 'restore',
        scriptId: external.scriptId,
        outDir: restoreDir,
        overwrite: true,
      });
      assert.equal(again.written, withContent.length);

      // 7. beautify to a file keeps the whole bundle and splits the one-line program.
      const pretty = path.join(outRoot, 'pretty.js');
      const beautified = call('analysis_code', {
        action: 'beautify',
        scriptId: external.scriptId,
        outFile: pretty,
      });
      const prettyText = fs.readFileSync(pretty, 'utf8');
      assert.equal(beautified.length, prettyText.length);
      assert(prettyText.split('\n').length > 40, 'beautified bundle is still one line');
      assert(prettyText.includes('window.aebAnalysis = {'), 'beautified text lost code');

      // 8. Scripts without a map, with an unreachable map, or unknown fail with their own codes.
      assert.equal(
        fails('analysis_sourcemap', { action: 'load', scriptId: nomap.scriptId }, 'no map'),
        'SOURCEMAP_NOT_FOUND',
      );
      assert.equal(
        fails('analysis_sourcemap', { action: 'load', scriptId: badmap.scriptId }, '404 map'),
        'SOURCEMAP_FETCH_FAILED',
      );
      assert.equal(
        fails('analysis_code', { action: 'beautify', scriptId: 'no-such-script' }, 'unknown'),
        'SCRIPT_NOT_FOUND',
      );

      // 9. Output is redacted by default; sanitizeOutput:false returns the literal.
      const strings = (sanitizeOutput) =>
        call('analysis_code', {
          action: 'search',
          scriptId: nomap.scriptId,
          kind: 'string',
          query: 'eyJ',
          sanitizeOutput,
        });
      const masked = strings(true);
      assert.equal(masked.total, 1);
      assert.equal(masked.redacted, true);
      assert(!JSON.stringify(masked).includes('c2lnbmF0dXJlLWJ5dGVz'), 'token leaked');
      assert.equal(strings(false).matches[0].value, jwtText);

      return {
        runId,
        bundleScript: external.scriptId,
        mapSources: loaded.sourceCount,
        restored: restored.written,
        modules: unpacked.moduleCount,
        prettyLines: prettyText.split('\n').length,
        lookup: looked.original,
      };
    },
    async () => {
      const errors = [];
      if (started && tabs[0] !== undefined) {
        const stop = runCli(name, [
          'call',
          'chrome_cdp_session',
          JSON.stringify({ tabId: tabs[0], action: 'stop' }),
        ]);
        if (stop.response?.ok !== true && stop.response?.error?.code !== 'TARGET_CLOSED') {
          errors.push('stop held session: ' + stop.stdout);
        }
      }
      errors.push(...cleanupTargets(runCli, [name], urls, tabs));
      if (fixture) {
        try {
          await fixture.close();
        } catch (error) {
          errors.push(String(error));
        }
      }
      if (outRoot) {
        try {
          assert(path.basename(outRoot).startsWith('aeb-analysis-'), 'unexpected out dir');
          fs.rmSync(outRoot, { recursive: true });
        } catch (error) {
          errors.push('remove ' + outRoot + ': ' + String(error));
        }
      }
      if (errors.length) throw new Error(errors.join('\n'));
    },
  );
}

if (require.main === module)
  runAnalysis()
    .then((result) => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch((error) => {
      process.stderr.write(String(error.stack || error) + '\n');
      if (error instanceof AggregateError)
        for (const cause of error.errors) process.stderr.write(String(cause.stack || cause) + '\n');
      process.exitCode = 1;
    });

module.exports = { runAnalysis };
