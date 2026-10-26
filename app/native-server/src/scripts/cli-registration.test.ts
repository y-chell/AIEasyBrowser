import { describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

function runRegistration(args: string[] = [], fail = false, failNodePath = false) {
  const nativeRoot = path.resolve(__dirname, '..', '..');
  const child = spawnSync(
    process.execPath,
    [
      '-r',
      'ts-node/register',
      '-r',
      path.join(__dirname, '__fixtures__', 'registration.cjs'),
      path.join(nativeRoot, 'src', 'cli.ts'),
      'register',
      ...args,
    ],
    {
      cwd: nativeRoot,
      encoding: 'utf8',
      timeout: 20000,
      env: {
        ...process.env,
        AIEASYBROWSER_FIXTURE_REGISTRATION_FAIL: fail ? '1' : '0',
        AIEASYBROWSER_FIXTURE_NODE_PATH_FAIL: failNodePath ? '1' : '0',
      },
    },
  );
  if (child.error) throw child.error;
  const registration = child.stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith('registration-fixture:'));
  return {
    ...child,
    registration: registration
      ? (JSON.parse(registration.slice('registration-fixture:'.length)) as {
          browsers: string[];
          nodePathDirectory: string;
        })
      : undefined,
  };
}

describe('current-user-only registration CLI', () => {
  test('registers Chrome for the current user without automatic elevation', () => {
    const result = runRegistration();
    expect(result.status).toBe(0);
    expect(result.registration?.browsers).toEqual(['chrome']);
    expect(result.registration?.nodePathDirectory).toBe(path.resolve(__dirname, '..'));
    expect(result.stderr).not.toContain('administrator');
    expect(result.stdout).toContain('Native Messaging host registered successfully');
  });

  test.each([
    ['chromium', ['chromium']],
    ['all', ['chrome', 'chromium']],
  ])('respects an explicit browser choice: %s', (browser, expected) => {
    const result = runRegistration(['--browser', browser as string]);
    expect(result.status).toBe(0);
    expect(result.registration?.browsers).toEqual(expected);
  });

  test('returns a failure instead of escalating when user-level registration fails', () => {
    const result = runRegistration([], true);
    expect(result.status).toBe(1);
    expect(result.registration?.browsers).toEqual(['chrome']);
    expect(result.stderr).toContain('User-level Native Messaging host registration failed');
    expect(result.stdout).not.toContain('registered successfully');
    expect(result.stdout).not.toContain('sudo');
  });

  test('does not register a host when its Node.js path cannot be recorded', () => {
    const result = runRegistration([], false, true);
    expect(result.status).toBe(1);
    expect(result.registration).toBeUndefined();
    expect(result.stderr).toContain('Failed to write Node.js path: fixture failure');
    expect(result.stdout).not.toContain('registered successfully');
  });

  test('rejects invalid browser choices before attempting registration', () => {
    const result = runRegistration(['--browser', 'unknown']);
    expect(result.status).toBe(1);
    expect(result.registration).toBeUndefined();
    expect(result.stderr).toContain('Invalid browser: unknown');
  });

  test('does not expose a system-level installation mode', () => {
    const result = runRegistration(['--system']);
    expect(result.status).toBe(1);
    expect(result.registration).toBeUndefined();
    expect(result.stderr).toContain("unknown option '--system'");
  });
});
