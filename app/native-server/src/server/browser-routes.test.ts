import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { BRIDGE_ENV } from '../constant';
import type { NativeMessagingHost } from '../native-messaging-host';
import { Server } from './index';

let server: Server;
let send: jest.Mock<NativeMessagingHost['sendRequestToExtensionAndWait']>;
const success = (data: unknown) => ({
  status: 'success',
  data: { content: [], structuredContent: data },
});
const previousEnv = {
  token: process.env[BRIDGE_ENV.AUTH_TOKEN],
};

beforeEach(() => {
  delete process.env[BRIDGE_ENV.AUTH_TOKEN];
  send = jest.fn(async (payload) => {
    if (payload.name === 'get_windows_and_tabs')
      return success({ windows: [{ id: 1, tabs: [{ id: 7 }] }] });
    if (payload.name === 'chrome_scan_compact')
      return success({
        tabId: 7,
        frames: [{ frameId: 0, documentId: 'doc-7', elements: [{ ref: 'ref_1' }] }],
      });
    return success({ success: true, schema: { toolCount: 39 } });
  });
  server = new Server();
  server.setNativeHost({ sendRequestToExtensionAndWait: send } as unknown as NativeMessagingHost);
});
afterEach(async () => {
  await server.getInstance().close();
  for (const [key, value] of Object.entries({
    [BRIDGE_ENV.AUTH_TOKEN]: previousEnv.token,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
const post = (
  payload: unknown,
  headers: Record<string, string> = {},
  remoteAddress = '127.0.0.1',
) =>
  server.getInstance().inject({
    method: 'POST',
    url: '/browser',
    headers: { host: '127.0.0.1:12307', ...headers },
    payload,
    remoteAddress,
  });

describe('direct browser HTTP route', () => {
  test('executes JSON commands without an MCP session or initialize/tools/list', async () => {
    const response = await post({ command: 'health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      result: { schema: { toolCount: 39 }, bridge: { transport: 'cli' } },
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({
      name: 'chrome_health',
      context: { transport: 'cli' },
    });
    expect(response.headers['mcp-session-id']).toBeUndefined();
  });
  test('rejects a JSON-RPC handshake without creating a session or calling Chrome', async () => {
    const response = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { capabilities: {}, clientInfo: { name: 'fixture', version: '1' } },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENT' },
      actionStatus: 'not_started',
    });
    expect(response.json()).not.toHaveProperty('jsonrpc');
    expect(response.headers['mcp-session-id']).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    const sessions = await post({ command: 'session', mode: 'list' });
    expect(sessions.json().result).toEqual([]);
  });
  test.each([
    [{ host: 'localhost.evil.test' }, '127.0.0.1', 'Forbidden Host'],
    [{ origin: 'https://fixture.test' }, '127.0.0.1', 'Forbidden Origin'],
    [{}, '192.0.2.10', 'Browser CLI is only available over loopback'],
  ] as const)('rejects a forbidden caller %j/%s', async (headers, remoteAddress, message) => {
    const response = await post({ command: 'health' }, headers, remoteAddress);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toBe(message);
    expect(send).not.toHaveBeenCalled();
  });
  test('checks the configured bearer token for local CLI requests', async () => {
    await server.getInstance().close();
    process.env[BRIDGE_ENV.AUTH_TOKEN] = 'fixture-local-token';
    server = new Server();
    server.setNativeHost({ sendRequestToExtensionAndWait: send } as unknown as NativeMessagingHost);
    const rejected = await post({ command: 'health' });
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json()).toMatchObject({
      ok: false,
      error: { code: 'UNAUTHORIZED', message: 'Unauthorized' },
      actionStatus: 'not_started',
    });
    expect(rejected.json()).not.toHaveProperty('jsonrpc');
    expect(send).not.toHaveBeenCalled();
    const accepted = await post(
      { command: 'health' },
      { authorization: 'Bearer fixture-local-token' },
    );
    expect(accepted.statusCode).toBe(200);
  });
  test('accepts IPv6 loopback and reports parameter errors with one JSON response', async () => {
    expect((await post({ command: 'health' }, { host: '[::1]:12307' }, '::1')).statusCode).toBe(
      200,
    );
    const rejected = await post({
      command: 'act',
      actions: [{ op: 'click', ref: 'r', unknown: true }],
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENT' },
      actionStatus: 'not_started',
    });
  });
  test('times out after an action completed, cancels the extension wait and releases the workflow', async () => {
    await post({ command: 'use', tabId: 7, session: 'task' });
    const ref = (await post({ command: 'scan', session: 'task' })).json().result.elements[0].ref;
    send.mockImplementation(async (payload) => {
      if (payload.name === 'chrome_assert') return new Promise(() => undefined);
      return success({ success: true });
    });
    const response = await post({
      command: 'act',
      session: 'task',
      timeoutMs: 30,
      actions: [{ op: 'fill', ref, value: 'complete' }],
      expect: { kind: 'text', text: 'never' },
    });
    expect(response.statusCode).toBe(504);
    expect(response.json()).toMatchObject({
      error: { code: 'TIMEOUT' },
      phase: 'expect',
      actionStatus: 'completed',
      completed: 1,
    });
    const assertion = send.mock.calls.find(([payload]) => payload.name === 'chrome_assert');
    expect(assertion?.[3]?.signal?.aborted).toBe(true);
    expect((await post({ command: 'health', session: 'task' })).statusCode).toBe(200);
  });
  test('aborts the native request when the real HTTP client disconnects', async () => {
    let started!: () => void;
    const sent = new Promise<void>((resolve) => {
      started = resolve;
    });
    send.mockImplementation(async (payload) => {
      if (payload.name === 'chrome_health') {
        started();
        return new Promise(() => undefined);
      }
      return success({ success: true });
    });
    const endpoint = await server.getInstance().listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();
    const pending = fetch(`${endpoint}/browser`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"command":"health","session":"disconnect"}',
      signal: controller.signal,
    }).catch(() => undefined);
    await sent;
    controller.abort();
    await pending;
    const nativeSignal = send.mock.calls[0][3]?.signal;
    for (let index = 0; index < 50 && !nativeSignal?.aborted; index++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(nativeSignal?.aborted).toBe(true);
    send.mockResolvedValue(success({ success: true }));
    const recovered = await fetch(`${endpoint}/browser`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"command":"health","session":"disconnect"}',
    });
    expect(((await recovered.json()) as any).ok).toBe(true);
  });
});
