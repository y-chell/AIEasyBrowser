import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';
import path from 'node:path';

const REPLY_TIMEOUT_MS = 5_000;
const IDLE_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_LENGTH = 4_096;

export class DisplayWakeError extends Error {
  constructor(
    readonly detail: string,
    readonly code: 'DISPLAY_WAKE_FAILED' | 'DISPLAY_WAKE_LOST' = 'DISPLAY_WAKE_FAILED',
  ) {
    super(`${code}: ${detail}`);
    this.name = 'DisplayWakeError';
  }
}

interface Reply {
  type: 'ready' | 'awake';
  resolve: () => void;
  reject: (error: DisplayWakeError) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Helper {
  child: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  running: Set<(error: DisplayWakeError) => void>;
  replies: Reply[];
  leases: number;
  stopped: boolean;
  error?: DisplayWakeError;
  idleTimer?: ReturnType<typeof setTimeout>;
  output: string;
  stderr: string;
}

interface DisplayAwakeOptions {
  platform?: NodeJS.Platform;
  spawn?: (
    command: string,
    args: readonly string[],
    options: SpawnOptionsWithoutStdio,
  ) => ChildProcessWithoutNullStreams;
}

function abortable<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    // Keep observing the protocol reply after abort, so its ACK cannot satisfy another lease.
    pending.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}

/** Windows only; other platforms execute the callback without spawning a helper. */
export class DisplayAwakeManager {
  private helper?: Helper;
  private readonly platform: NodeJS.Platform;
  private readonly spawnHelper: NonNullable<DisplayAwakeOptions['spawn']>;

  constructor(options: DisplayAwakeOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.spawnHelper = options.spawn ?? spawn;
  }

  async withDisplayAwake<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const lease = await this.acquire(signal);
    try {
      signal?.throwIfAborted();
      if (lease.helper?.error) throw lease.helper.error;
      const helper = lease.helper;
      if (!helper) return await run();
      let onFailure!: (error: DisplayWakeError) => void;
      const lost = new Promise<never>((_resolve, reject) => {
        onFailure = (error) => reject(new DisplayWakeError(error.detail, 'DISPLAY_WAKE_LOST'));
      });
      void lost.catch(() => {});
      helper.running.add(onFailure);
      try {
        // Once the callback starts, a lost helper must not be reported as a not-started action.
        return await Promise.race([run(), lost]);
      } finally {
        helper.running.delete(onFailure);
      }
    } finally {
      lease.release();
    }
  }

  clearForTests(): void {
    if (this.helper) this.fail(this.helper, 'display-awake manager cleared');
  }

  private async acquire(signal?: AbortSignal): Promise<{ helper?: Helper; release: () => void }> {
    signal?.throwIfAborted();
    if (this.platform !== 'win32') return { release: () => {} };
    const helper = this.helper ?? this.start();
    clearTimeout(helper.idleTimer);
    helper.leases += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      helper.leases -= 1;
      if (helper.leases === 0 && !helper.stopped) {
        helper.idleTimer = setTimeout(() => this.stop(helper), IDLE_TIMEOUT_MS);
        helper.idleTimer.unref();
      }
    };
    try {
      await abortable(helper.ready, signal);
      signal?.throwIfAborted();
      if (helper.error) throw helper.error;
      const awake = this.expectReply(helper, 'awake');
      try {
        helper.child.stdin.write('wake\n');
      } catch (error) {
        this.fail(helper, `cannot write wake: ${(error as Error).message}`);
      }
      await abortable(awake, signal);
      signal?.throwIfAborted();
      if (helper.error) throw helper.error;
      return { helper, release };
    } catch (error) {
      release();
      throw error;
    }
  }

  private start(): Helper {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnHelper(
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
    } catch (error) {
      throw new DisplayWakeError(`cannot start pwsh: ${(error as Error).message}`);
    }
    const helper: Helper = {
      child,
      ready: Promise.resolve(),
      running: new Set(),
      replies: [],
      leases: 0,
      stopped: false,
      output: '',
      stderr: '',
    };
    this.helper = helper;
    helper.ready = this.expectReply(helper, 'ready');
    void helper.ready.catch(() => {});
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onOutput(helper, chunk));
    child.stderr.on('data', (chunk: string) => {
      helper.stderr = (helper.stderr + chunk).slice(-MAX_OUTPUT_LENGTH);
    });
    child.on('error', (error) => this.fail(helper, `pwsh error: ${error.message}`));
    child.on('exit', (code, signal) =>
      this.fail(helper, `pwsh exited (${signal ?? `code ${code}`})`),
    );
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      stream.on('error', (error) => this.fail(helper, `pwsh pipe error: ${error.message}`));
      // Pipes must not keep Node alive: process exit closes stdin and the worker clears its state.
      (stream as typeof stream & { unref?: () => void }).unref?.();
    }
    child.stdout.on('end', () => this.fail(helper, 'pwsh closed its response pipe'));
    child.unref();
    return helper;
  }

  private expectReply(helper: Helper, type: Reply['type']): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(helper, `pwsh ${type} timed out after ${REPLY_TIMEOUT_MS} ms`),
        REPLY_TIMEOUT_MS,
      );
      helper.replies.push({ type, resolve, reject, timer });
    });
  }

  private onOutput(helper: Helper, chunk: string): void {
    if (helper.stopped) return;
    helper.output += chunk;
    let newline: number;
    while ((newline = helper.output.indexOf('\n')) !== -1) {
      const line = helper.output.slice(0, newline).replace(/\r$/, '');
      helper.output = helper.output.slice(newline + 1);
      let message: { type?: string; protocol?: number; message?: string } | null;
      try {
        message = JSON.parse(line);
      } catch {
        this.fail(helper, 'invalid JSON from pwsh');
        return;
      }
      const reply = helper.replies[0];
      if (
        !reply ||
        message?.type !== reply.type ||
        (reply.type === 'ready' && message.protocol !== 1)
      ) {
        this.fail(helper, `unexpected pwsh response: ${line.slice(0, 160)}`);
        return;
      }
      helper.replies.shift();
      clearTimeout(reply.timer);
      reply.resolve();
    }
    if (helper.output.length > MAX_OUTPUT_LENGTH) {
      this.fail(helper, 'pwsh response exceeded the line limit');
    }
  }

  private fail(helper: Helper, detail: string): void {
    if (helper.stopped) return;
    helper.stopped = true;
    helper.error = new DisplayWakeError(
      detail + (helper.stderr.trim() ? `: ${helper.stderr.trim()}` : ''),
    );
    if (this.helper === helper) this.helper = undefined;
    clearTimeout(helper.idleTimer);
    for (const reply of helper.replies.splice(0)) {
      clearTimeout(reply.timer);
      reply.reject(helper.error);
    }
    for (const onFailure of helper.running) onFailure(helper.error);
    helper.running.clear();
    helper.child.stdin.destroy();
    // Terminating a failed/unresponsive worker also drops its thread execution-state request.
    helper.child.kill();
  }

  private stop(helper: Helper): void {
    if (helper.stopped) return;
    helper.stopped = true;
    if (this.helper === helper) this.helper = undefined;
    clearTimeout(helper.idleTimer);
    helper.child.stdin.end('stop\n');
  }
}

const manager = new DisplayAwakeManager();

export function withDisplayAwake<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return manager.withDisplayAwake(run, signal);
}

export function clearForTests(): void {
  manager.clearForTests();
}
