import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { writeNodePathFile } from './utils';

jest.mock('fs');
jest.mock('child_process');
jest.mock('./utils', () => ({ writeNodePathFile: jest.fn() }));

const distDir = path.resolve(__dirname, '..', '..', 'dist');

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(fs.mkdirSync).mockReturnValue(undefined);
  jest.mocked(fs.readdirSync).mockReturnValue(['old.js', 'mcp'] as any);
  jest.mocked(fs.rmSync).mockReturnValue(undefined);
  jest.mocked(fs.existsSync).mockReturnValue(true);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());

function runBuild() {
  jest.isolateModules(() => require('./build'));
}

describe('native build output cleanup', () => {
  test('removes stale output children without deleting the host working directory', () => {
    runBuild();
    expect(fs.rmSync).toHaveBeenCalledWith(path.join(distDir, 'old.js'), {
      recursive: true,
      force: true,
    });
    expect(fs.rmSync).toHaveBeenCalledWith(path.join(distDir, 'mcp'), {
      recursive: true,
      force: true,
    });
    expect(fs.rmSync).not.toHaveBeenCalledWith(distDir, expect.anything());
    expect(execSync).toHaveBeenCalledWith('tsc', { stdio: 'inherit' });
    expect(writeNodePathFile).toHaveBeenCalledWith(distDir, process.execPath);
  });

  test('builds into an empty or newly created output directory', () => {
    jest.mocked(fs.readdirSync).mockReturnValue([]);
    runBuild();
    expect(fs.mkdirSync).toHaveBeenCalledWith(distDir, { recursive: true });
    expect(fs.rmSync).not.toHaveBeenCalled();
    expect(execSync).toHaveBeenCalledTimes(1);
  });

  test('stops before compilation if stale output cannot be deleted', () => {
    jest.mocked(fs.rmSync).mockImplementation(() => {
      throw new Error('EPERM fixture');
    });
    expect(runBuild).toThrow('EPERM fixture');
    expect(execSync).not.toHaveBeenCalled();
    expect(writeNodePathFile).not.toHaveBeenCalled();
  });

  test('stops if the output directory cannot be created', () => {
    jest.mocked(fs.mkdirSync).mockImplementation(() => {
      throw new Error('EACCES fixture');
    });
    expect(runBuild).toThrow('EACCES fixture');
    expect(fs.rmSync).not.toHaveBeenCalled();
    expect(execSync).not.toHaveBeenCalled();
  });
});
