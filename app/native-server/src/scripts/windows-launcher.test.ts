import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveNodeCandidate } from './doctor';

const describeWindows = process.platform === 'win32' ? describe : describe.skip;
const HOST_ARGS = ['chrome-extension://coleelkpegcobndoloaofalgnkhiamll/', '42'];
let fixtureRoot: string;
let hostDir: string;

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aieasybrowser-host-'));
  hostDir = path.join(fixtureRoot, 'host ! & (space) %fixture%');
  fs.mkdirSync(hostDir);
  fs.copyFileSync(path.join(__dirname, 'run_host.bat'), path.join(hostDir, 'run_host.bat'));
  fs.copyFileSync(
    path.join(__dirname, '__fixtures__', 'native-host.cjs'),
    path.join(hostDir, 'index.js'),
  );
  fs.writeFileSync(path.join(hostDir, 'node_path.txt'), process.execPath);
});

afterEach(() => {
  expect(path.dirname(path.resolve(fixtureRoot))).toBe(path.resolve(os.tmpdir()));
  expect(path.basename(fixtureRoot)).toMatch(/^aieasybrowser-host-/);
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

function runHost(input = Buffer.alloc(0), exitCode = 0) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path') delete env[key];
  }
  env.PATH = '';
  env.AIEASYBROWSER_HOST_WRAPPER = path.join(hostDir, 'run_host.bat');
  env.AIEASYBROWSER_FIXTURE_EXIT_CODE = String(exitCode);
  env.CHROME_MCP_NODE_PATH = path.join(fixtureRoot, 'unrelated-node.exe');
  const child = spawnSync(
    process.env.ComSpec ||
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'),
    ['/d', '/s', '/c', `""%AIEASYBROWSER_HOST_WRAPPER%" ${HOST_ARGS.join(' ')}"`],
    {
      cwd: fixtureRoot,
      input,
      env,
      windowsHide: true,
      windowsVerbatimArguments: true,
      timeout: 10000,
    },
  );
  if (child.error) throw child.error;
  return child;
}

function nativeFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length);
  return Buffer.concat([header, payload]);
}

describeWindows('Windows Native Messaging launcher', () => {
  test('preserves binary frames and Chrome arguments without PATH or PowerShell', () => {
    const input = Buffer.concat([
      nativeFrame({ text: '\u4e2d\u6587', control: '\u0000', padding: 'x'.repeat(32768) }),
      nativeFrame({ second: true }),
    ]);
    const result = runHost(input);

    expect(result.status).toBe(0);
    expect(result.stdout).toEqual(input);
    expect(result.stderr.toString('utf8')).toBe(
      `native-host-fixture:${JSON.stringify(HOST_ARGS)}\n`,
    );
    expect(resolveNodeCandidate(hostDir)).toMatchObject({
      nodePath: process.execPath,
      source: 'node_path.txt',
      nodePathFile: { valid: true },
    });
  });

  test('preserves a failing host exit code without polluting stdout', () => {
    const input = nativeFrame({ failure: true });
    const result = runHost(input, 7);
    expect(result.status).toBe(7);
    expect(result.stdout).toEqual(input);
    expect(result.stderr.toString('utf8')).toContain('native-host-fixture:');
  });

  test.each([
    ['LF', '\n'],
    ['CRLF', '\r\n'],
  ])('accepts a %s-terminated recorded path and ignores subsequent lines', (_name, separator) => {
    fs.writeFileSync(
      path.join(hostDir, 'node_path.txt'),
      `${separator}; recorded Node${separator}${separator}${process.execPath}${separator}ignored${separator}`,
    );
    const result = runHost();
    expect(JSON.stringify(result.stderr.toString('utf8'))).toBe(
      JSON.stringify(`native-host-fixture:${JSON.stringify(HOST_ARGS)}\n`),
    );
    expect(result.status).toBe(0);
    expect(resolveNodeCandidate(hostDir)).toMatchObject({
      nodePath: process.execPath,
      nodePathFile: { valid: true },
    });
  });

  test.each([
    ['missing', 'Node.js path file not found'],
    ['empty', 'Node.js path file is empty'],
    ['invalid-first-line', 'Recorded Node.js executable not found'],
    ['stale', 'Recorded Node.js executable not found'],
    ['directory', 'Recorded Node.js path is a directory'],
  ])('rejects a %s Node path instead of searching for another installation', (kind, message) => {
    const nodePathFile = path.join(hostDir, 'node_path.txt');
    if (kind === 'missing') {
      fs.unlinkSync(nodePathFile);
    } else {
      const value =
        kind === 'invalid-first-line'
          ? `${path.join(fixtureRoot, 'missing-node.exe')}\r\n${process.execPath}`
          : kind === 'empty'
            ? ''
            : kind === 'directory'
              ? path.dirname(process.execPath)
              : path.join(fixtureRoot, 'missing-node.exe');
      fs.writeFileSync(nodePathFile, value);
    }
    const result = runHost();
    expect(result.status).toBe(1);
    expect(result.stdout).toEqual(Buffer.alloc(0));
    expect(result.stderr.toString('utf8')).toContain(message);
    const resolution = resolveNodeCandidate(hostDir);
    expect(resolution.nodePath).toBeUndefined();
    if (kind !== 'missing') expect(resolution.nodePathFile.valid).toBe(false);
  });

  test('rejects a missing entrypoint before executing Node.js', () => {
    fs.unlinkSync(path.join(hostDir, 'index.js'));
    const result = runHost();
    expect(result.status).toBe(1);
    expect(result.stdout).toEqual(Buffer.alloc(0));
    expect(result.stderr.toString('utf8')).toContain('Native host entrypoint not found');
    expect(result.stderr.toString('utf8')).not.toContain('native-host-fixture:');
  });
});
