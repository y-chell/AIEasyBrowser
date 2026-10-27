import { describe, expect, jest, test } from '@jest/globals';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import {
  DEFAULT_CHROME_EXTENSION_ORIGIN,
  createHttpSecurityGuard,
  isLoopbackRemoteAddress,
  parseHostHeader,
  parseHttpSecurityConfig,
} from './http-security';

const TOKEN = 'fixture-local-token';

describe('loopback bridge security configuration', () => {
  test.each([
    ['127.0.0.1', '127.0.0.1'],
    ['127.0.0.2', '127.0.0.2'],
    [' LOCALHOST ', 'localhost'],
    ['::1', '::1'],
    ['[0:0:0:0:0:0:0:1]', '::1'],
  ])('accepts a loopback listener %s', (input, expected) => {
    const config = parseHttpSecurityConfig({ listenHost: input, env: {} });
    expect(config.listenHost).toBe(expected);
    expect(config.authToken).toBeUndefined();
    expect([...config.allowedHosts]).toEqual(
      expect.arrayContaining(['localhost', '127.0.0.1', '[::1]']),
    );
    expect([...config.allowedOrigins]).toEqual([DEFAULT_CHROME_EXTENSION_ORIGIN]);
  });

  test.each([
    '',
    '0.0.0.0',
    '::',
    '[::]',
    '192.0.2.10',
    'localhost.evil.test',
    '127.1',
    '2130706433',
    'localhost:12307',
    '[::1]:12307',
    'http://localhost',
    '[::1%lo]',
  ])('rejects a remote, ambiguous or malformed listener %j', (host) => {
    expect(() => parseHttpSecurityConfig({ listenHost: host, env: {} })).toThrow(
      'AIEASYBROWSER_HOST must be a loopback host without a port',
    );
  });

  test('reads only the new token configuration and does not expand allowed origins', () => {
    const config = parseHttpSecurityConfig({
      listenHost: '127.0.0.1',
      env: {
        AIEASYBROWSER_AUTH_TOKEN: ` ${TOKEN} `,
        CHROME_MCP_AUTH_TOKEN: 'old-token',
        CHROME_MCP_ALLOWED_ORIGINS: 'https://fixture.test',
        CHROME_EXTENSION_IDS: 'abcdefghijklmnopabcdefghijklmnop',
      },
    });
    expect(config.authToken).toBe(TOKEN);
    expect([...config.allowedOrigins]).toEqual([DEFAULT_CHROME_EXTENSION_ORIGIN]);
  });

  test.each(['token with spaces', 'token\tinside', 'token\ninside'])(
    'rejects whitespace within a token %j',
    (token) => {
      expect(() =>
        parseHttpSecurityConfig({
          listenHost: '127.0.0.1',
          env: { AIEASYBROWSER_AUTH_TOKEN: token },
        }),
      ).toThrow('AIEASYBROWSER_AUTH_TOKEN must not contain whitespace');
    },
  );

  test.each(['127.0.0.1', '127.255.255.255', '::1', '::ffff:127.0.0.1'])(
    'recognizes a loopback socket address %s',
    (address) => expect(isLoopbackRemoteAddress(address)).toBe(true),
  );
  test.each([
    undefined,
    '',
    'localhost',
    '127.evil.test',
    '127.1',
    '192.0.2.20',
    '::',
    '::ffff:192.0.2.20',
  ])('rejects a non-loopback socket address %j', (address) =>
    expect(isLoopbackRemoteAddress(address)).toBe(false),
  );
});

describe('strict Host parsing', () => {
  test.each([
    ['LOCALHOST:12307', 'localhost'],
    ['localhost.', 'localhost'],
    ['127.0.0.1:1', '127.0.0.1'],
    ['127.0.0.1:65535', '127.0.0.1'],
    ['[::1]', '[::1]'],
    ['[0:0:0:0:0:0:0:1]:12307', '[::1]'],
    ['localhost.evil.test:12307', 'localhost.evil.test'],
  ])('parses a complete hostname without prefix matching: %s', (input, expected) => {
    expect(parseHostHeader(input)).toBe(expected);
  });

  test.each([
    '',
    'localhost:0',
    'localhost:65536',
    'localhost:',
    'localhost:port',
    'localhost:1.5',
    'localhost:12307:12308',
    'user@localhost',
    'localhost/path',
    'localhost\\path',
    'localhost?query',
    'localhost#fragment',
    'local host',
    '-localhost',
    'localhost-',
    'localhost..',
    '127.1',
    '2130706433',
    '127.0.0.999',
    '[::1]:0',
    '[::1]:65536',
    '[::1]:port',
    '[invalid]',
    '[::1%lo]',
    '::1',
  ])('rejects malformed or ambiguous Host %j without throwing', (input) => {
    expect(parseHostHeader(input)).toBeNull();
  });
});

async function guardRequest(
  headers: Record<string, string | string[] | undefined>,
  remoteAddress: string | undefined = '127.0.0.1',
  token?: string,
) {
  const reply = {
    code: jest.fn().mockReturnThis(),
    header: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  };
  const config = parseHttpSecurityConfig({
    listenHost: '127.0.0.1',
    env: token ? { AIEASYBROWSER_AUTH_TOKEN: token } : {},
  });
  await createHttpSecurityGuard(config)(
    { headers, socket: { remoteAddress }, method: 'POST' } as unknown as FastifyRequest,
    reply as unknown as FastifyReply,
  );
  return reply;
}

describe('local HTTP guard', () => {
  test.each([
    { host: 'localhost:12307' },
    { host: '[::1]:12307', origin: DEFAULT_CHROME_EXTENSION_ORIGIN },
    { ':authority': '127.0.0.1:12307' },
  ])('accepts a local request with exact headers: %j', async (headers) => {
    const reply = await guardRequest(headers);
    expect(reply.send).not.toHaveBeenCalled();
  });

  test.each([
    {},
    { host: 'localhost.evil.test' },
    { host: '127.1' },
    { host: ['localhost', 'localhost.evil.test'] },
    { ':authority': ['localhost'] },
    { host: 'evil.test', ':authority': 'localhost' },
  ])('rejects missing, duplicate or forbidden Host %j', async (headers) => {
    const reply = await guardRequest(headers);
    expect(reply.code).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'Forbidden Host' },
      }),
    );
  });

  test.each([
    'https://fixture.test',
    'null',
    `${DEFAULT_CHROME_EXTENSION_ORIGIN}.evil`,
    `${DEFAULT_CHROME_EXTENSION_ORIGIN}/`,
    [DEFAULT_CHROME_EXTENSION_ORIGIN],
  ])('rejects an inexact or duplicate Origin %j', async (origin) => {
    const reply = await guardRequest({ host: 'localhost', origin });
    expect(reply.code).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'Forbidden Origin' },
      }),
    );
  });

  test('requires the actual socket to be loopback, regardless of forwarding headers', async () => {
    const reply = await guardRequest(
      {
        host: 'localhost',
        'x-forwarded-for': '127.0.0.1',
        authorization: `Bearer ${TOKEN}`,
      },
      '192.0.2.20',
      TOKEN,
    );
    expect(reply.code).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        error: { code: 'FORBIDDEN', message: 'Browser CLI is only available over loopback' },
      }),
    );
  });

  test('accepts the configured bearer token', async () => {
    const reply = await guardRequest(
      { host: 'localhost', authorization: `Bearer ${TOKEN}` },
      '::1',
      TOKEN,
    );
    expect(reply.send).not.toHaveBeenCalled();
  });

  test.each([
    undefined,
    'Bearer wrong',
    `Bearer ${TOKEN}extra`,
    `Bearer  ${TOKEN}`,
    `Basic ${TOKEN}`,
    [`Bearer ${TOKEN}`],
  ])('rejects missing, mismatched or duplicate credentials %j', async (authorization) => {
    const reply = await guardRequest({ host: 'localhost', authorization }, '127.0.0.1', TOKEN);
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.header).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer');
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: { code: 'UNAUTHORIZED', message: 'Unauthorized' },
        actionStatus: 'not_started',
      }),
    );
  });

  test('does not rate-limit repeated loopback requests', async () => {
    const app = Fastify();
    const config = parseHttpSecurityConfig({ listenHost: '127.0.0.1', env: {} });
    app.post('/browser', { preHandler: createHttpSecurityGuard(config) }, async () => ({
      ok: true,
    }));
    try {
      for (let index = 0; index < 70; index++) {
        const response = await app.inject({
          method: 'POST',
          url: '/browser',
          headers: { host: 'localhost:12307' },
        });
        expect(response.statusCode).toBe(200);
      }
    } finally {
      await app.close();
    }
  });
});
