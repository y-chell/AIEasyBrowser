import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NativeMessageType } from 'aieasybrowser-shared';
import { NativeMessagingHost } from './native-messaging-host';
import { setLogDirForTests } from './util/diag-log';

let logDir: string;

beforeEach(() => {
  // These tests exercise real request lifecycles, so keep their records out of the user log.
  logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aieasybrowser-host-log-'));
  setLogDirForTests(logDir);
});

function createHost() {
  const host = new NativeMessagingHost();
  const sendMessage = jest.spyOn(host, 'sendMessage').mockImplementation(() => undefined);
  return { host, sendMessage };
}

function readLogEvents(): string[] {
  const target = path.join(logDir, 'native-server.log');
  if (!fs.existsSync(target)) return [];
  return fs
    .readFileSync(target, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line).event as string);
}

function getRequestId(sendMessage: jest.SpiedFunction<NativeMessagingHost['sendMessage']>) {
  return (sendMessage.mock.calls[0][0] as any).requestId as string;
}

afterEach(() => {
  setLogDirForTests(undefined);
  jest.useRealTimers();
  jest.restoreAllMocks();
  expect(path.dirname(path.resolve(logDir))).toBe(path.resolve(os.tmpdir()));
  expect(path.basename(logDir)).toMatch(/^aieasybrowser-host-log-/);
  fs.rmSync(logDir, { recursive: true, force: true });
});

describe('NativeMessagingHost request lifecycle', () => {
  test('does not send a request when the signal is already aborted', async () => {
    const { host, sendMessage } = createHost();
    const controller = new AbortController();
    controller.abort();

    await expect(
      host.sendRequestToExtensionAndWait({}, NativeMessageType.CALL_TOOL, 1000, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test('cancels an in-flight request, removes its listener, and ignores a late response', async () => {
    const { host, sendMessage } = createHost();
    const controller = new AbortController();
    const removeListener = jest.spyOn(controller.signal, 'removeEventListener');
    const request = host.sendRequestToExtensionAndWait(
      { name: 'chrome_wait_for' },
      NativeMessageType.CALL_TOOL,
      1000,
      { signal: controller.signal },
    );
    const requestId = getRequestId(sendMessage);

    controller.abort();

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(sendMessage).toHaveBeenLastCalledWith({
      type: NativeMessageType.CALL_TOOL_CANCEL,
      requestId,
      payload: { requestId },
    });
    expect((host as any).pendingRequests.size).toBe(0);

    await (host as any).handleMessage({
      responseToRequestId: requestId,
      payload: { status: 'success' },
    });
    expect((host as any).pendingRequests.size).toBe(0);

    const events = readLogEvents();
    expect(events).toContain('extension.cancelled');
    expect(events).toContain('extension.late_response');
  });

  test('records a timeout with the tool name and correlation id', async () => {
    jest.useFakeTimers();
    const { host, sendMessage } = createHost();
    const request = host.sendRequestToExtensionAndWait(
      { name: 'chrome_health' },
      NativeMessageType.CALL_TOOL,
      50,
    );
    const requestId = getRequestId(sendMessage);

    jest.advanceTimersByTime(51);

    await expect(request).rejects.toThrow('Request timed out after 50ms');
    const records = fs
      .readFileSync(path.join(logDir, 'native-server.log'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const timeout = records.find((record) => record.event === 'extension.timeout');
    expect(timeout).toMatchObject({
      level: 'warn',
      tool: 'chrome_health',
      nativeRequestId: requestId,
      code: 'TIMEOUT',
    });
    expect(typeof timeout.durationMs).toBe('number');
    expect(timeout.timeoutMs).toBe(50);
  });

  test('records a successful response with its duration', async () => {
    const { host, sendMessage } = createHost();
    const request = host.sendRequestToExtensionAndWait(
      { name: 'get_windows_and_tabs' },
      NativeMessageType.CALL_TOOL,
      1000,
    );
    const requestId = getRequestId(sendMessage);
    await (host as any).handleMessage({
      responseToRequestId: requestId,
      payload: { status: 'success', data: { windows: [] } },
    });
    await expect(request).resolves.toEqual({ status: 'success', data: { windows: [] } });

    const records = fs
      .readFileSync(path.join(logDir, 'native-server.log'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const ok = records.find((record) => record.event === 'extension.ok');
    expect(ok).toMatchObject({ tool: 'get_windows_and_tabs', nativeRequestId: requestId });
  });

  test('dispatches progress without settling the request and cleans up on response', async () => {
    const { host, sendMessage } = createHost();
    const controller = new AbortController();
    const removeListener = jest.spyOn(controller.signal, 'removeEventListener');
    const onProgress = jest.fn<(progress: any) => void>();
    let settled = false;
    const request = host
      .sendRequestToExtensionAndWait({}, NativeMessageType.CALL_TOOL, 1000, {
        signal: controller.signal,
        onProgress,
      })
      .finally(() => {
        settled = true;
      });
    const requestId = getRequestId(sendMessage);

    await (host as any).handleMessage({
      type: NativeMessageType.CALL_TOOL_PROGRESS,
      requestId,
      payload: { progress: 25, total: 100, message: 'Waiting' },
    });
    await Promise.resolve();

    expect(onProgress).toHaveBeenCalledWith({ progress: 25, total: 100, message: 'Waiting' });
    expect(settled).toBe(false);
    expect((host as any).pendingRequests.size).toBe(1);

    await (host as any).handleMessage({
      responseToRequestId: requestId,
      payload: { status: 'success', data: 'done' },
    });

    await expect(request).resolves.toEqual({ status: 'success', data: 'done' });
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    expect((host as any).pendingRequests.size).toBe(0);
  });

  test('timeout removes the abort listener and cancels extension work', async () => {
    jest.useFakeTimers();
    const { host, sendMessage } = createHost();
    const controller = new AbortController();
    const removeListener = jest.spyOn(controller.signal, 'removeEventListener');
    const request = host.sendRequestToExtensionAndWait({}, NativeMessageType.CALL_TOOL, 20, {
      signal: controller.signal,
    });
    const requestId = getRequestId(sendMessage);

    jest.advanceTimersByTime(20);

    await expect(request).rejects.toThrow('Request timed out after 20ms');
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(sendMessage).toHaveBeenLastCalledWith({
      type: NativeMessageType.CALL_TOOL_CANCEL,
      requestId,
      payload: { requestId },
    });
    expect((host as any).pendingRequests.size).toBe(0);
  });

  test('records the reason when stdin disconnects', () => {
    const { host } = createHost();
    jest.spyOn(host as any, 'cleanup').mockImplementation(() => undefined);

    (host as any).handleDisconnect('STDIN_END');

    const records = fs
      .readFileSync(path.join(logDir, 'native-server.log'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const disconnected = records.find((record) => record.event === 'native.disconnected');
    expect(disconnected).toMatchObject({ code: 'STDIN_END', level: 'info' });
  });

  test('logs a startup failure before exiting', () => {
    const { host } = createHost();
    jest.spyOn(host as any, 'setupMessageHandling').mockImplementation(() => {
      throw new Error('fixture startup failure');
    });
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    host.start();

    expect(exit).toHaveBeenCalledWith(1);
    const records = fs
      .readFileSync(path.join(logDir, 'native-server.log'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(records.some((record) => record.event === 'native.start_failed')).toBe(true);
    expect(JSON.stringify(records)).not.toContain('fixture startup failure');
  });
});
