import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { DisplayAwakeManager, DisplayWakeError } from './display-awake';

class FakeHelper extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = jest.fn(() => true);
  unref = jest.fn();
  commands: string[] = [];

  constructor() {
    super();
    this.stdin.on('data', (chunk) => this.commands.push(String(chunk)));
  }

  reply(message: unknown): void {
    this.stdout.write(JSON.stringify(message) + '\n');
  }

  exit(code = 1): void {
    this.emit('exit', code, null);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => jest.advanceTimersByTimeAsync(0);

// No test launches pwsh or calls a display API.
describe('DisplayAwakeManager', () => {
  let manager: DisplayAwakeManager;
  let helpers: FakeHelper[];
  let spawnHelper: ReturnType<typeof jest.fn<() => ChildProcessWithoutNullStreams>>;

  beforeEach(() => {
    jest.useFakeTimers();
    helpers = [];
    spawnHelper = jest.fn(() => {
      const helper = new FakeHelper();
      helpers.push(helper);
      return helper as unknown as ChildProcessWithoutNullStreams;
    });
    manager = new DisplayAwakeManager({ platform: 'win32', spawn: spawnHelper });
  });

  afterEach(() => {
    manager.clearForTests();
    jest.useRealTimers();
  });

  async function ready(helper = helpers[0]): Promise<void> {
    helper.reply({ type: 'ready', protocol: 1 });
    await flush();
  }

  async function complete<T>(running: Promise<T>, helper = helpers[0]): Promise<T> {
    await ready(helper);
    helper.reply({ type: 'awake' });
    return running;
  }

  test('waits for ready and its own wake ACK before running the callback', async () => {
    const run = jest.fn(async () => 42);
    const pending = manager.withDisplayAwake(run);
    const helper = helpers[0];
    expect(spawnHelper).toHaveBeenCalledWith(
      'pwsh',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(__dirname, '..', 'scripts', 'display-awake.ps1'),
      ],
      { stdio: 'pipe', windowsHide: true },
    );
    expect(helper.commands).toEqual([]);
    helper.stdout.write('{"type":"rea');
    await flush();
    expect(run).not.toHaveBeenCalled();
    helper.stdout.write('dy","protocol":1}\r\n');
    await flush();
    expect(helper.commands).toEqual(['wake\n']);
    expect(run).not.toHaveBeenCalled();
    helper.reply({ type: 'awake' });
    await expect(pending).resolves.toBe(42);
    expect(run).toHaveBeenCalledTimes(1);
    expect(helper.unref).toHaveBeenCalledTimes(1);
  });

  test('pulses every request while reusing an idle helper', async () => {
    await complete(manager.withDisplayAwake(async () => 'first'));
    const run = jest.fn(async () => 'second');
    const pending = manager.withDisplayAwake(run);
    await flush();
    expect(spawnHelper).toHaveBeenCalledTimes(1);
    expect(helpers[0].commands).toEqual(['wake\n', 'wake\n']);
    expect(run).not.toHaveBeenCalled();
    helpers[0].reply({ type: 'awake' });
    await expect(pending).resolves.toBe('second');
  });

  test('shares one helper across concurrent leases and only idles after the last release', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const a = manager.withDisplayAwake(() => first.promise);
    const b = manager.withDisplayAwake(() => second.promise);
    await ready();
    expect(spawnHelper).toHaveBeenCalledTimes(1);
    expect(helpers[0].commands).toEqual(['wake\n', 'wake\n']);
    helpers[0].stdout.write('{"type":"awake"}\n{"type":"awake"}\n');
    await flush();
    first.resolve('a');
    await expect(a).resolves.toBe('a');
    await jest.advanceTimersByTimeAsync(30_000);
    expect(helpers[0].stdin.writableEnded).toBe(false);
    second.resolve('b');
    await expect(b).resolves.toBe('b');
    await jest.advanceTimersByTimeAsync(29_999);
    expect(helpers[0].stdin.writableEnded).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(helpers[0].commands).toEqual(['wake\n', 'wake\n', 'stop\n']);
    expect(helpers[0].stdin.writableEnded).toBe(true);
    expect(helpers[0].kill).not.toHaveBeenCalled();
    const next = manager.withDisplayAwake(async () => 'new helper');
    await expect(complete(next, helpers[1])).resolves.toBe('new helper');
    expect(spawnHelper).toHaveBeenCalledTimes(2);
  });

  test('cancels the idle timer as soon as another acquire begins', async () => {
    await complete(manager.withDisplayAwake(async () => 'first'));
    await jest.advanceTimersByTimeAsync(29_999);
    const work = deferred<void>();
    const pending = manager.withDisplayAwake(() => work.promise);
    await flush();
    helpers[0].reply({ type: 'awake' });
    await flush();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(helpers[0].stdin.writableEnded).toBe(false);
    expect(spawnHelper).toHaveBeenCalledTimes(1);
    work.resolve();
    await pending;
  });

  test('reports a synchronous spawn failure without starting the tool', async () => {
    spawnHelper.mockImplementationOnce(() => {
      throw new Error('spawn denied');
    });
    const run = jest.fn(async () => {});
    await expect(manager.withDisplayAwake(run)).rejects.toMatchObject({
      name: 'DisplayWakeError',
      code: 'DISPLAY_WAKE_FAILED',
      message: 'DISPLAY_WAKE_FAILED: cannot start pwsh: spawn denied',
    });
    expect(run).not.toHaveBeenCalled();
  });

  test('reports an asynchronous spawn error and permits a later independent request', async () => {
    const run = jest.fn(async () => {});
    const pending = manager.withDisplayAwake(run);
    const rejected = expect(pending).rejects.toThrow('pwsh error: spawn pwsh ENOENT');
    helpers[0].emit('error', new Error('spawn pwsh ENOENT'));
    await rejected;
    expect(run).not.toHaveBeenCalled();
    expect(spawnHelper).toHaveBeenCalledTimes(1);
    const next = manager.withDisplayAwake(async () => 'ok');
    await expect(complete(next, helpers[1])).resolves.toBe('ok');
  });

  test.each(['ready', 'awake'] as const)('enforces a 5-second %s deadline', async (phase) => {
    const run = jest.fn(async () => {});
    const pending = manager.withDisplayAwake(run);
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'DISPLAY_WAKE_FAILED',
      message: `DISPLAY_WAKE_FAILED: pwsh ${phase} timed out after 5000 ms`,
    });
    if (phase === 'awake') await ready();
    await jest.advanceTimersByTimeAsync(4_999);
    expect(helpers[0].kill).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    await rejected;
    expect(helpers[0].kill).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    expect(spawnHelper).toHaveBeenCalledTimes(1);
  });

  test('does not spawn or run for a pre-aborted request', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled');
    controller.abort(reason);
    const run = jest.fn(async () => {});
    await expect(manager.withDisplayAwake(run, controller.signal)).rejects.toBe(reason);
    expect(spawnHelper).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  test('aborts one startup waiter without disturbing another lease', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled');
    const cancelledRun = jest.fn(async () => {});
    const a = manager.withDisplayAwake(cancelledRun, controller.signal);
    const rejected = expect(a).rejects.toBe(reason);
    const b = manager.withDisplayAwake(async () => 'survivor');
    controller.abort(reason);
    await rejected;
    await ready();
    expect(helpers[0].commands).toEqual(['wake\n']);
    helpers[0].reply({ type: 'awake' });
    await expect(b).resolves.toBe('survivor');
    expect(cancelledRun).not.toHaveBeenCalled();
    expect(helpers[0].kill).not.toHaveBeenCalled();
  });

  test('keeps an aborted pulse in the ACK queue so it cannot release the next request', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled');
    const cancelledRun = jest.fn(async () => {});
    const a = manager.withDisplayAwake(cancelledRun, controller.signal);
    const rejected = expect(a).rejects.toBe(reason);
    await ready();
    const survivingRun = jest.fn(async () => 'survivor');
    const b = manager.withDisplayAwake(survivingRun);
    await flush();
    controller.abort(reason);
    await rejected;
    helpers[0].reply({ type: 'awake' });
    await flush();
    expect(survivingRun).not.toHaveBeenCalled();
    helpers[0].reply({ type: 'awake' });
    await expect(b).resolves.toBe('survivor');
    expect(cancelledRun).not.toHaveBeenCalled();
    expect(helpers[0].commands).toEqual(['wake\n', 'wake\n']);
  });

  test('checks abort again after the ACK and before starting a tool', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled');
    const run = jest.fn(async () => {});
    const pending = manager.withDisplayAwake(run, controller.signal);
    const rejected = expect(pending).rejects.toBe(reason);
    await ready();
    helpers[0].reply({ type: 'awake' });
    controller.abort(reason);
    await rejected;
    expect(run).not.toHaveBeenCalled();
  });

  test.each(['ready', 'awake'] as const)('reports helper exit while awaiting %s', async (phase) => {
    const run = jest.fn(async () => {});
    const pending = manager.withDisplayAwake(run);
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'DISPLAY_WAKE_FAILED',
      message: 'DISPLAY_WAKE_FAILED: pwsh exited (code 7): native failure',
    });
    if (phase === 'awake') await ready();
    helpers[0].stderr.write('native failure\n');
    helpers[0].exit(7);
    await rejected;
    expect(run).not.toHaveBeenCalled();
    expect(spawnHelper).toHaveBeenCalledTimes(1);
  });

  test('reports DISPLAY_WAKE_LOST after a tool started, with no replay', async () => {
    const work = deferred<string>();
    const run = jest.fn(() => work.promise);
    const pending = manager.withDisplayAwake(run);
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'DISPLAY_WAKE_LOST',
      message: 'DISPLAY_WAKE_LOST: pwsh exited (code 3)',
    });
    await ready();
    helpers[0].reply({ type: 'awake' });
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
    helpers[0].exit(3);
    await rejected;
    expect(spawnHelper).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
    work.resolve('original result');
    const next = manager.withDisplayAwake(async () => 'new request');
    await expect(complete(next, helpers[1])).resolves.toBe('new request');
  });

  test('releases a lease when the business callback rejects and preserves its error', async () => {
    const reason = new Error('tool failed');
    const run = jest.fn(async () => {
      throw reason;
    });
    const pending = manager.withDisplayAwake(run);
    const rejected = expect(pending).rejects.toBe(reason);
    await ready();
    helpers[0].reply({ type: 'awake' });
    await rejected;
    expect(run).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(helpers[0].stdin.writableEnded).toBe(true);
  });

  test.each([
    'not-json',
    'null',
    '[]',
    '{"type":"ready","protocol":2}',
    '{"type":"awake"}',
    '{"type":"error","message":"native failed"}',
  ])('rejects an invalid startup response: %s', async (response) => {
    const run = jest.fn(async () => {});
    const pending = manager.withDisplayAwake(run);
    const rejected = expect(pending).rejects.toBeInstanceOf(DisplayWakeError);
    helpers[0].stdout.write(response + '\n');
    await rejected;
    expect(run).not.toHaveBeenCalled();
    expect(helpers[0].kill).toHaveBeenCalledTimes(1);
  });

  test('rejects a wrong wake ACK instead of swallowing it', async () => {
    const run = jest.fn(async () => {});
    const pending = manager.withDisplayAwake(run);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'DISPLAY_WAKE_FAILED' });
    await ready();
    helpers[0].reply({ type: 'ready', protocol: 1 });
    await rejected;
    expect(run).not.toHaveBeenCalled();
  });

  test('rejects an unsolicited second ACK before dispatch', async () => {
    const run = jest.fn(async () => {});
    const pending = manager.withDisplayAwake(run);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'DISPLAY_WAKE_FAILED' });
    await ready();
    helpers[0].stdout.write('{"type":"awake"}\n{"type":"awake"}\n');
    await rejected;
    expect(run).not.toHaveBeenCalled();
  });

  test('reports a closed response pipe instead of hanging', async () => {
    const pending = manager.withDisplayAwake(async () => {});
    const rejected = expect(pending).rejects.toThrow('pwsh closed its response pipe');
    helpers[0].stdout.emit('end');
    await rejected;
  });

  test('reports pipe errors and limits unterminated output', async () => {
    const pending = manager.withDisplayAwake(async () => {});
    const rejected = expect(pending).rejects.toThrow('pwsh pipe error: EPIPE');
    helpers[0].stdin.emit('error', new Error('EPIPE'));
    await rejected;
    const next = manager.withDisplayAwake(async () => {});
    const nextRejected = expect(next).rejects.toThrow('pwsh response exceeded the line limit');
    helpers[1].stdout.write('x'.repeat(4_097));
    await nextRejected;
  });

  test('recreates a helper after an idle child exits, without retrying an old tool', async () => {
    const run = jest.fn(async () => 'once');
    await expect(complete(manager.withDisplayAwake(run))).resolves.toBe('once');
    helpers[0].exit();
    expect(spawnHelper).toHaveBeenCalledTimes(1);
    const next = manager.withDisplayAwake(async () => 'later');
    await expect(complete(next, helpers[1])).resolves.toBe('later');
    expect(run).toHaveBeenCalledTimes(1);
  });

  test.each(['linux', 'darwin'] as const)('is an explicit no-op on %s', async (platform) => {
    manager = new DisplayAwakeManager({ platform, spawn: spawnHelper });
    const run = jest.fn(async () => 'unchanged');
    await expect(manager.withDisplayAwake(run)).resolves.toBe('unchanged');
    expect(run).toHaveBeenCalledTimes(1);
    expect(spawnHelper).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    await expect(manager.withDisplayAwake(run, controller.signal)).rejects.toBe(
      controller.signal.reason,
    );
    expect(run).toHaveBeenCalledTimes(1);
  });
});
