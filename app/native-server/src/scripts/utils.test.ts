import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { createHash, createPublicKey } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CHROME_EXTENSION_ID,
  CHROME_EXTENSION_KEY,
  DEFAULT_SERVER_PORT,
} from 'aieasybrowser-shared';
import {
  DEFAULT_CHROME_EXTENSION_ORIGIN,
  parseMcpHttpSecurityConfig,
} from '../server/mcp-http-security';
import { EXTENSION_ID, HOST_NAME } from './constant';
import { createManifestContent, resolvePreferredNodeExecPath, writeNodePathFile } from './utils';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_EXTENSION_ID = 'hbdgbgagpkpjffpklnamcljpakneikee';

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  jest.restoreAllMocks();
});

describe('recording the Native Messaging Node.js executable', () => {
  test('writes the executable used by the launcher', () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aieasybrowser-node-path-'));
    jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const expectedPath = resolvePreferredNodeExecPath();
      writeNodePathFile(fixtureRoot);
      expect(fs.readFileSync(path.join(fixtureRoot, 'node_path.txt'), 'utf8')).toBe(expectedPath);
      expect(fs.statSync(expectedPath).isFile()).toBe(true);
    } finally {
      expect(path.dirname(path.resolve(fixtureRoot))).toBe(path.resolve(os.tmpdir()));
      expect(path.basename(fixtureRoot)).toMatch(/^aieasybrowser-node-path-/);
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test('fails explicitly when the recorded path cannot be written', () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aieasybrowser-node-path-'));
    jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      fs.mkdirSync(path.join(fixtureRoot, 'node_path.txt'));
      expect(() => writeNodePathFile(fixtureRoot)).toThrow('Failed to write Node.js path:');
    } finally {
      expect(path.dirname(path.resolve(fixtureRoot))).toBe(path.resolve(os.tmpdir()));
      expect(path.basename(fixtureRoot)).toMatch(/^aieasybrowser-node-path-/);
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});

describe('AIEasyBrowser native host identity', () => {
  test('uses a valid public key with the same stable ID in both runtimes', () => {
    const key = Buffer.from(CHROME_EXTENSION_KEY, 'base64');
    expect(createPublicKey({ key, format: 'der', type: 'spki' }).asymmetricKeyType).toBe('rsa');
    const derivedId = createHash('sha256')
      .update(key)
      .digest('hex')
      .slice(0, 32)
      .replace(/[0-9a-f]/g, (digit) =>
        String.fromCharCode('a'.charCodeAt(0) + Number.parseInt(digit, 16)),
      );

    expect(derivedId).toBe(CHROME_EXTENSION_ID);
    expect(EXTENSION_ID).toBe(derivedId);
    expect(derivedId).not.toBe(ORIGINAL_EXTENSION_ID);
    expect(DEFAULT_SERVER_PORT).toBe(12307);
  });

  test('creates a usable manifest without user-supplied extension IDs', async () => {
    delete process.env.CHROME_EXTENSION_ID;
    delete process.env.CHROME_EXTENSION_IDS;
    const manifest = await createManifestContent();

    expect(manifest).toMatchObject({
      name: HOST_NAME,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${CHROME_EXTENSION_ID}/`],
    });
    expect(path.isAbsolute(manifest.path)).toBe(true);
    expect(path.basename(manifest.path)).toBe(
      process.platform === 'win32' ? 'run_host.bat' : 'run_host.sh',
    );
  });

  test('does not grant the original extension or wildcard origins access to this host', async () => {
    process.env.CHROME_EXTENSION_ID = ORIGINAL_EXTENSION_ID;
    process.env.CHROME_EXTENSION_IDS = `${ORIGINAL_EXTENSION_ID},*`;
    process.env.CHROME_EXTENSION_KEY = 'YOUR_PRIVATE_KEY_HERE';
    const manifest = await createManifestContent();

    expect(manifest.allowed_origins).toEqual([`chrome-extension://${CHROME_EXTENSION_ID}/`]);
    expect(manifest.allowed_origins).not.toContain(`chrome-extension://${ORIGINAL_EXTENSION_ID}/`);
    expect(manifest.allowed_origins.join(',')).not.toContain('*');
  });

  test('allows this extension instead of the original project origin in default HTTP security', () => {
    const config = parseMcpHttpSecurityConfig({ listenHost: '127.0.0.1', env: {} });
    expect(DEFAULT_CHROME_EXTENSION_ORIGIN).toBe(`chrome-extension://${CHROME_EXTENSION_ID}`);
    expect(config.allowedOrigins.has(DEFAULT_CHROME_EXTENSION_ORIGIN)).toBe(true);
    expect(config.allowedOrigins.has(`chrome-extension://${ORIGINAL_EXTENSION_ID}`)).toBe(false);
  });
});
