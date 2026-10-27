import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import type { NativeMessagingHost } from '../native-messaging-host';
import { BRIDGE_ENV } from '../constant';
import { Server } from './index';

const ORIGINAL_ENV = { ...process.env };
let server: Server;

beforeEach(() => {
  for (const name of Object.values(BRIDGE_ENV)) delete process.env[name];
  server = new Server();
});
afterEach(async () => {
  await server.getInstance().close();
  process.env = { ...ORIGINAL_ENV };
  jest.restoreAllMocks();
});

describe('local browser bridge server', () => {
  test('returns a local health response without a protocol handshake', async () => {
    const response = await server.getInstance().inject({ method: 'GET', url: '/ping' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', message: 'pong' });
    expect(response.headers['mcp-session-id']).toBeUndefined();
  });

  test.each([
    ['GET', '/mcp'],
    ['POST', '/mcp?profile=full'],
    ['DELETE', '/mcp'],
    ['GET', '/sse'],
    ['POST', '/messages?sessionId=old'],
  ] as const)('does not expose the removed %s %s transport', async (method, url) => {
    const response = await server.getInstance().inject({
      method,
      url,
      headers: { 'mcp-session-id': 'old-session' },
      ...(method === 'POST' ? { payload: { jsonrpc: '2.0', id: 1, method: 'initialize' } } : {}),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).not.toHaveProperty('jsonrpc');
    expect(response.headers['mcp-session-id']).toBeUndefined();
  });

  test.each(['/ping', '/ask-extension', '/browser', '/mcp'])(
    'rejects a remote source for %s before any route executes',
    async (url) => {
      const response = await server.getInstance().inject({
        method: url === '/browser' ? 'POST' : 'GET',
        url,
        remoteAddress: '192.0.2.20',
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'Browser CLI is only available over loopback' },
        actionStatus: 'not_started',
      });
    },
  );

  test.each(['0.0.0.0', '192.0.2.10', '::', 'remote.test', 'localhost:12307'])(
    'rejects a non-loopback or port-bearing listener %s',
    (host) => {
      process.env[BRIDGE_ENV.HOST] = host;
      expect(() => new Server()).toThrow('AIEASYBROWSER_HOST');
    },
  );

  test('starts on loopback, records the actual port, and stops without session cleanup', async () => {
    const host = {} as NativeMessagingHost;
    await server.start(0, host);
    expect(server.isRunning).toBe(true);
    const port = Number(process.env[BRIDGE_ENV.PORT]);
    expect(port).toBeGreaterThan(0);
    const response = await fetch(`http://127.0.0.1:${port}/ping`);
    expect(await response.json()).toEqual({ status: 'ok', message: 'pong' });
    await server.start(port, host);
    await server.stop();
    expect(server.isRunning).toBe(false);
    await server.stop();
  });

  test('does not report a failed listen as running or change the configured port', async () => {
    const listen = jest
      .spyOn(server.getInstance(), 'listen')
      .mockRejectedValue(new Error('EADDRINUSE fixture'));
    process.env[BRIDGE_ENV.PORT] = '4321';
    await expect(server.start(4321, {} as NativeMessagingHost)).rejects.toThrow('EADDRINUSE');
    expect(server.isRunning).toBe(false);
    expect(process.env[BRIDGE_ENV.PORT]).toBe('4321');
    expect(listen).toHaveBeenCalledWith({ port: 4321, host: '127.0.0.1' });
  });
});
