import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { BRIDGE_ENV } from '../constant';
import { BrowserType, getBrowserConfig } from './browser-config';
import { EXTENSION_ID, HOST_NAME } from './constant';
import { collectDoctorReport } from './doctor';

jest.mock('fs');
jest.mock('child_process');
jest.mock('./utils', () => ({
  getLogDir: () => '/fixture/aieasybrowser/logs',
  colorText: (text: string) => text,
}));
// Doctor reports on the log target without touching the real file system.
jest.mock('../util/diag-log', () => ({
  probeLogWritable: () => ({ ok: true, path: '/fixture/aieasybrowser/logs/native-server.log' }),
}));

const ORIGINAL_ENV = { ...process.env };
const distDir = path.resolve(__dirname, '..', '..', 'dist');
const wrapperPath = path.join(
  distDir,
  process.platform === 'win32' ? 'run_host.bat' : 'run_host.sh',
);
const browser = getBrowserConfig(BrowserType.CHROME);
const fetchMock = jest.fn<typeof fetch>();

beforeEach(() => {
  jest.clearAllMocks();
  for (const name of Object.values(BRIDGE_ENV)) delete process.env[name];
  const existingPaths = new Set([
    wrapperPath,
    path.join(distDir, 'index.js'),
    path.join(distDir, 'node_path.txt'),
    browser.userManifestPath,
    process.execPath,
    '/fixture/aieasybrowser/logs',
  ]);
  jest.mocked(fs.existsSync).mockImplementation((file) => existingPaths.has(String(file)));
  jest.mocked(fs.accessSync).mockReturnValue(undefined);
  jest
    .mocked(fs.statSync)
    .mockReturnValue({ isFile: () => true, isDirectory: () => false } as fs.Stats);
  jest.mocked(fs.readFileSync).mockImplementation(((file: fs.PathOrFileDescriptor) => {
    if (String(file) === path.join(distDir, 'node_path.txt')) return process.execPath;
    if (String(file) === browser.userManifestPath)
      return JSON.stringify({
        name: HOST_NAME,
        type: 'stdio',
        path: wrapperPath,
        allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
      });
    throw new Error(`Unexpected fixture read: ${file}`);
  }) as typeof fs.readFileSync);
  jest.mocked(execFileSync).mockImplementation(((command: string, argv: string[]) => {
    if (command === process.execPath) return 'v22.0.0\n';
    if (command === 'reg' && argv[1] === browser.registryKey) {
      return `    (Default)    REG_SZ    ${browser.userManifestPath}\n`;
    }
    throw new Error('Registry fixture key not found');
  }) as typeof execFileSync);
  fetchMock.mockReset().mockResolvedValue(new Response('{"status":"ok","message":"pong"}'));
  jest.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  jest.restoreAllMocks();
});

describe('CLI-only bridge diagnostics', () => {
  test('diagnoses the built host without a removed protocol config file', async () => {
    const report = await collectDoctorReport({ browser: 'chrome' });
    expect(report.ok).toBe(true);
    expect(report.checks.find((check) => check.id === 'host.files')).toMatchObject({
      status: 'ok',
      details: { wrapperPath, nodeScriptPath: path.join(distDir, 'index.js') },
    });
    expect(report.checks.find((check) => check.id === 'bridge.config')).toMatchObject({
      status: 'ok',
      message: 'http://127.0.0.1:12307',
      details: { host: '127.0.0.1', port: 12307, authenticated: false },
    });
    expect(report.checks.find((check) => check.id === 'connectivity')?.status).toBe('ok');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:12307/ping',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(report.checks.some((check) => check.id === 'port.constant')).toBe(false);
    expect(
      jest
        .mocked(fs.readFileSync)
        .mock.calls.every(([file]) => !String(file).endsWith('stdio-config.json')),
    ).toBe(true);
  });

  test('uses the configured IPv6 URL and port without disclosing the token', async () => {
    process.env[BRIDGE_ENV.HOST] = '::1';
    process.env[BRIDGE_ENV.PORT] = '23456';
    process.env[BRIDGE_ENV.AUTH_TOKEN] = 'fixture-secret-token';
    const report = await collectDoctorReport({ browser: 'chrome' });
    expect(report.environment.nativeHost.expectedPort).toBe(23456);
    expect(report.checks.find((check) => check.id === 'bridge.config')).toMatchObject({
      status: 'ok',
      message: 'http://[::1]:23456',
      details: { host: '::1', port: 23456, authenticated: true },
    });
    expect(fetchMock.mock.calls[0][0]).toBe('http://[::1]:23456/ping');
    expect(JSON.stringify(report)).not.toContain('fixture-secret-token');
  });

  test.each([
    [BRIDGE_ENV.HOST, '192.0.2.10'],
    [BRIDGE_ENV.PORT, '123abc'],
    [BRIDGE_ENV.AUTH_TOKEN, 'token with spaces'],
  ])('reports invalid %s before any HTTP request', async (name, value) => {
    process.env[name] = value;
    const report = await collectDoctorReport({ browser: 'chrome' });
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.id === 'bridge.config')).toMatchObject({
      status: 'error',
      message: expect.stringContaining(name),
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(report.checks.some((check) => check.id === 'connectivity')).toBe(false);
  });

  test.each([
    [404, '{"message":"not found"}', 'HTTP 404'],
    [200, '{"status":"ok","message":"not the bridge"}', 'Unexpected response from bridge /ping'],
    [200, 'null', 'Unexpected response from bridge /ping'],
  ])(
    'does not call an unrelated HTTP %s response a healthy bridge',
    async (status, body, message) => {
      fetchMock.mockResolvedValueOnce(new Response(body, { status }));
      const report = await collectDoctorReport({ browser: 'chrome' });
      expect(report.checks.find((check) => check.id === 'connectivity')).toMatchObject({
        status: 'warn',
        message: expect.stringContaining(message),
      });
      expect(report.nextSteps).toContain(
        'Enable or reload AIEasyBrowser in chrome://extensions, then re-run doctor',
      );
      expect(report.nextSteps.join(' ')).not.toContain('Click "Connect"');
    },
  );

  test.each([
    [new Error('Network fixture failure'), 'Network fixture failure'],
    [new DOMException('Aborted fixture', 'AbortError'), 'Timeout after 1500ms'],
  ])(
    'reports a connectivity failure without throwing away the installation report',
    async (error, message) => {
      fetchMock.mockRejectedValueOnce(error);
      const report = await collectDoctorReport({ browser: 'chrome' });
      expect(report.checks.find((check) => check.id === 'host.files')?.status).toBe('ok');
      expect(report.checks.find((check) => check.id === 'connectivity')).toMatchObject({
        status: 'warn',
        message: expect.stringContaining(message),
      });
    },
  );
});

describe('log check', () => {
  test('reports the probed log target rather than only the directory', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'ok', message: 'pong' }), { status: 200 }),
    );
    const report = await collectDoctorReport({ browser: 'chrome' });
    const logs = report.checks.find((check) => check.id === 'logs');
    expect(logs?.status).toBe('ok');
    expect(String(logs?.message)).toContain('/fixture/aieasybrowser/logs/native-server.log');
    expect(logs?.details).toMatchObject({
      path: '/fixture/aieasybrowser/logs/native-server.log',
      writable: true,
    });
  });

  test.each(['EACCES: permission denied', 'log lock busy: native-server.log.lock'])(
    'surfaces log failure %s with an actionable next step',
    async (error) => {
      const diag = jest.requireMock('../util/diag-log') as {
        probeLogWritable: () => { ok: boolean; path: string; error?: string };
      };
      const original = diag.probeLogWritable;
      diag.probeLogWritable = () => ({
        ok: false,
        path: '/fixture/aieasybrowser/logs/native-server.log',
        error,
      });
      try {
        const report = await collectDoctorReport({ browser: 'chrome' });
        const logs = report.checks.find((check) => check.id === 'logs');
        expect(logs?.status).toBe('error');
        expect(String(logs?.message)).toContain(error);
        expect(report.nextSteps.join(' ')).toContain('/fixture/aieasybrowser/logs');
        expect(report.nextSteps.join(' ')).toContain('verify its recorded owner has exited');
      } finally {
        diag.probeLogWritable = original;
      }
    },
  );
});
