import { afterEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { materializeView, registerBrowserCommands } from './cli';

const directories: string[] = [];
afterEach(() => {
  jest.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    expect(path.dirname(directory)).toBe(os.tmpdir());
    expect(path.basename(directory)).toMatch(/^aieasybrowser-view-/);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// One real PNG pixel; no external source image or network dependency.
const image =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==';
const success = () => ({
  ok: true,
  session: 'pictures',
  result: {
    base64Data: image,
    base64Length: image.length,
    mimeType: 'image/png',
    captureKind: 'viewport',
    outputDimensions: { width: 1, height: 1 },
  },
});

describe('page view image handoff', () => {
  test('writes exact pixels into unique temporary files without dumping base64 to stdout metadata', () => {
    const paths = [1, 2].map(() => {
      const output = materializeView(success());
      expect(output.ok).toBe(true);
      const result = output.result as any;
      directories.push(path.dirname(result.imagePath));
      expect(path.isAbsolute(result.imagePath)).toBe(true);
      expect(fs.readFileSync(result.imagePath)).toEqual(Buffer.from(image, 'base64'));
      expect(result).toMatchObject({
        temporary: true,
        mimeType: 'image/png',
        captureKind: 'viewport',
      });
      expect(result).not.toHaveProperty('base64Data');
      expect(JSON.stringify(output)).not.toContain(image);
      return result.imagePath;
    });
    expect(paths[0]).not.toBe(paths[1]);
  });

  test.each([
    undefined,
    {},
    { mimeType: 'image/svg+xml', base64Data: image },
    { mimeType: 'image/png', base64Data: 'not base64' },
    { mimeType: 'image/jpeg', base64Data: '' },
  ])('rejects missing or malformed image output without creating files: %j', (result) => {
    const create = jest.spyOn(fs, 'mkdtempSync');
    expect(materializeView({ ok: true, result })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_RESPONSE' },
    });
    expect(create).not.toHaveBeenCalled();
  });

  test('preserves screenshot failures without creating an image', () => {
    const failure = { ok: false, error: { code: 'BROWSER_ERROR', message: 'capture failed' } };
    expect(materializeView(failure)).toBe(failure);
  });

  test('reports output IO errors', () => {
    jest.spyOn(fs, 'mkdtempSync').mockImplementation(() => {
      throw new Error('EACCES fixture');
    });
    expect(materializeView(success())).toMatchObject({
      ok: false,
      error: { code: 'OUTPUT_WRITE_FAILED', message: expect.stringContaining('EACCES fixture') },
    });
  });

  test('view grammar maps options and stdout contains a readable imagePath', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(success())));
    const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const before = process.exitCode;
    try {
      const program = new Command().exitOverride();
      registerBrowserCommands(program);
      await program.parseAsync(['--session', 'pictures', 'view', '--selector', 'article img'], {
        from: 'user',
      });
      expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toMatchObject({
        command: 'view',
        selector: 'article img',
        fullPage: false,
        session: 'pictures',
      });
      const output = JSON.parse(stdout.mock.calls[0][0] as string);
      directories.push(path.dirname(output.result.imagePath));
      expect(output.result).not.toHaveProperty('base64Data');
      expect(stdout).toHaveBeenCalledTimes(1);
    } finally {
      process.exitCode = before;
    }
  });

  test('rejects selector and full-page combination before browser IO', async () => {
    const request = jest.spyOn(globalThis, 'fetch');
    const program = new Command().exitOverride();
    registerBrowserCommands(program);
    await expect(
      program.parseAsync(['view', '--selector', 'img', '--full'], { from: 'user' }),
    ).rejects.toThrow('either');
    expect(request).not.toHaveBeenCalled();
  });
});
