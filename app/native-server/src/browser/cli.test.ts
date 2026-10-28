import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { Command } from 'commander';
import { BRIDGE_ENV } from '../constant';
import { BrowserCommandService } from './command-service';
import type { NativeMessagingHost } from '../native-messaging-host';
import {
  browserExitCode,
  getBrowserEndpoint,
  parseCliJson,
  parseInteger,
  readCliInput,
  registerBrowserCommands,
  requestBrowserCommand,
} from './cli';

const fetchMock = jest.fn<typeof fetch>();
let stdout: jest.SpiedFunction<typeof process.stdout.write>;
const previousExitCode = process.exitCode;

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ ok: true, result: { fixture: true } }), { status: 200 }),
  );
  jest.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);
  stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  process.exitCode = undefined;
});

afterEach(() => {
  jest.restoreAllMocks();
  process.exitCode = previousExitCode;
});

async function parse(argv: string[]) {
  const command = new Command()
    .exitOverride()
    .configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  registerBrowserCommands(command);
  await command.parseAsync(argv, { from: 'user' });
  return JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
}

describe('browser CLI grammar and HTTP transport', () => {
  test('prints one JSON INVALID_ARGUMENT response and exits 2 for rejected advanced input', async () => {
    const send = jest.fn<NativeMessagingHost['sendRequestToExtensionAndWait']>();
    const service = new BrowserCommandService(
      () => ({ sendRequestToExtensionAndWait: send }) as unknown as NativeMessagingHost,
    );
    fetchMock.mockImplementation(async (_url, options) => {
      const response = await service.execute(
        JSON.parse(options?.body as string),
        new AbortController().signal,
      );
      return new Response(JSON.stringify(response), { status: response.ok ? 200 : 400 });
    });
    await parse(['call', 'chrome_cdp_batch', '{"commands":[{}]}']);
    expect(stdout).toHaveBeenCalledTimes(1);
    expect(JSON.parse(stdout.mock.calls[0][0] as string)).toMatchObject({
      ok: false,
      error: {
        code: 'INVALID_ARGUMENT',
        message: expect.stringContaining('args/commands/0/method'),
      },
      actionStatus: 'not_started',
      completed: 0,
    });
    expect(process.exitCode).toBe(2);
    expect(send).not.toHaveBeenCalled();
  });

  test.each([
    ['http://127.0.0.1:12307', 'http://127.0.0.1:12307/browser'],
    ['http://localhost:12307/browser', 'http://localhost:12307/browser'],
    ['http://[::1]:12307/', 'http://[::1]:12307/browser'],
    ['http://127.0.0.2:12307', 'http://127.0.0.2:12307/browser'],
  ])('accepts loopback bridge URL %s', (input, expected) => {
    expect(getBrowserEndpoint(input)).toBe(expected);
  });
  test.each([
    'http://localhost.evil.test:12307',
    'http://192.0.2.1:12307',
    'https://localhost:12307',
    'http://user:secret@localhost:12307',
    'http://localhost:12307/mcp?profile=full',
    'not a URL',
  ])('rejects non-CLI URL %s before connecting', (url) => {
    expect(() => getBrowserEndpoint(url)).toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  test('preserves a configured port error instead of disguising it as a --url error', () => {
    const previous = process.env[BRIDGE_ENV.PORT];
    try {
      process.env[BRIDGE_ENV.PORT] = '123abc';
      expect(() => getBrowserEndpoint()).toThrow('AIEASYBROWSER_PORT must be an integer');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(getBrowserEndpoint('http://127.0.0.1:12307')).toBe('http://127.0.0.1:12307/browser');
    } finally {
      if (previous === undefined) delete process.env[BRIDGE_ENV.PORT];
      else process.env[BRIDGE_ENV.PORT] = previous;
    }
  });

  test.each([
    ['0', 0, 80, 0],
    ['200', 1, 200, 200],
    ['01', 1, 200, 1],
  ] as const)('parses an integer %s', (input, min, max, expected) =>
    expect(parseInteger(input, min, max)).toBe(expected),
  );
  test.each(['-1', '1.5', '1ms', ' 1', '+1', '201'])('rejects integer input %j', (value) => {
    expect(() => parseInteger(value, 0, 200)).toThrow();
  });
  test('preserves JSON scalar types, raw strings, and exact file/stdin bytes', () => {
    expect(parseCliJson('false')).toBe(false);
    expect(parseCliJson('"false"')).toBe('false');
    expect(readCliInput('return "\\r\\n"')).toBe('return "\\r\\n"');
    const reader = jest.spyOn(require('node:fs'), 'readFileSync');
    reader.mockReturnValue('{"value":"line\\r\\n\\u4e2d"}');
    expect(parseCliJson('@fixture.json')).toEqual({ value: 'line\r\n\u4e2d' });
    expect(reader).toHaveBeenCalledWith('fixture.json', 'utf8');
    expect(parseCliJson('@-')).toEqual({ value: 'line\r\n\u4e2d' });
    expect(reader).toHaveBeenCalledWith(0, 'utf8');
    reader.mockImplementation(() => {
      throw new Error('ENOENT fixture');
    });
    expect(() => readCliInput('@missing.json')).toThrow('Cannot read input: ENOENT fixture');
    expect(() => parseCliJson('{not-json}')).toThrow('Invalid JSON');
  });

  test('uses one direct request and one JSON stdout response for a whole action/check/scan command', async () => {
    const payload = await parse([
      '--session',
      'github',
      '--url',
      'http://127.0.0.1:12307',
      'act',
      '[{"op":"fill","ref":"v.1.1","value":"search"}]',
      '--expect',
      '{"kind":"text","text":"result"}',
    ]);
    expect(payload).toMatchObject({
      command: 'act',
      session: 'github',
      actions: [{ op: 'fill', value: 'search' }],
      expect: { kind: 'text', text: 'result' },
      scan: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:12307/browser');
    expect(stdout).toHaveBeenCalledTimes(1);
    expect(JSON.parse(stdout.mock.calls[0][0] as string)).toEqual({
      ok: true,
      result: { fixture: true },
    });
    expect(process.exitCode).toBe(0);
  });

  test('supports globals after subcommands and distinguishes a string false from a boolean', async () => {
    let payload = await parse(['fill', 'ref', 'false', '--session', 'task']);
    expect(payload.actions[0].value).toBe('false');
    expect(payload.session).toBe('task');
    fetchMock.mockClear();
    payload = await parse(['fill', 'ref', 'false', '--json-value', '--no-scan']);
    expect(payload.actions[0].value).toBe(false);
    expect(payload.scan).toBe(false);
  });
  test.each([
    [['tabs', '--match', 'github'], { command: 'tabs', match: 'github' }],
    [['use', '7', '--focus'], { command: 'use', tabId: 7, focus: true }],
    [
      ['open', 'https://fixture.test/', '--background'],
      { command: 'open', background: true, current: false },
    ],
    [
      ['scan', '--limit', '2', '--text', '0', '--frame', '5'],
      { command: 'scan', limit: 2, text: 0, frameId: 5 },
    ],
    [
      ['click', 'ref', '--double'],
      { command: 'act', actions: [{ op: 'click', ref: 'ref', double: true }] },
    ],
    [
      ['press', 'Enter', '--frame', '5'],
      { command: 'act', actions: [{ op: 'press', keys: 'Enter', frameId: 5 }] },
    ],
    [
      ['wait', '{"kind":"url","value":"github.com"}', '--no-scan'],
      { command: 'wait', scan: false },
    ],
    [['eval', 'return 1'], { command: 'eval', code: 'return 1' }],
    [['tools', 'network'], { command: 'tools', query: 'network' }],
    [['describe', 'chrome_clipboard'], { command: 'describe', tool: 'chrome_clipboard' }],
    [
      ['call', 'chrome_clipboard', '{"action":"read_text"}'],
      { command: 'call', args: { action: 'read_text' } },
    ],
    [['session', '--forget'], { command: 'session', mode: 'forget' }],
    [['health'], { command: 'health' }],
  ])('maps CLI %j to the direct browser command', async (argv, expected) => {
    expect(await parse(argv as string[])).toMatchObject(expected);
  });
  test.each([
    ['scan', '--limit', '1.5'],
    ['act', '{bad}'],
    ['session', '--list', '--forget'],
    ['use', '-7'],
    ['fill', 'ref', '{}', '--json-value', '--unknown'],
  ])('rejects invalid CLI grammar %j without connecting', async (...argv) => {
    await expect(parse(argv)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  test.each([
    [true, undefined, 0],
    [false, 'INVALID_ARGUMENT', 2],
    [false, 'BROWSER_ERROR', 3],
    [false, 'CONNECTION_FAILED', 4],
    [false, 'FORBIDDEN', 4],
    [false, 'UNAUTHORIZED', 4],
    [false, 'CANCELLED', 130],
    [false, 'TIMEOUT', 3],
  ] as const)('maps result %s/%s to exit %s', (ok, code, expected) => {
    expect(browserExitCode({ ok, ...(code ? { error: { code, message: 'fixture' } } : {}) })).toBe(
      expected,
    );
  });
  test('returns server failure phases instead of hiding completed actions', async () => {
    const failure = {
      ok: false,
      error: { code: 'BROWSER_ERROR', message: 'assert failed' },
      phase: 'expect',
      actionStatus: 'completed',
      completed: 1,
    };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(failure), { status: 422 }));
    expect(await requestBrowserCommand({ command: 'act' }, {})).toEqual(failure);
  });
  test('reports invalid server JSON, security errors, and network failure explicitly', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>not bridge</html>', { status: 404 }));
    expect(await requestBrowserCommand({ command: 'health' }, {})).toMatchObject({
      error: { code: 'INVALID_RESPONSE' },
    });
    fetchMock.mockResolvedValueOnce(
      new Response('{"error":{"message":"Unauthorized"}}', { status: 401 }),
    );
    expect(await requestBrowserCommand({ command: 'health' }, {})).toMatchObject({
      error: { code: 'HTTP_ERROR', message: 'Unauthorized' },
    });
    fetchMock.mockRejectedValueOnce(new Error('fetch failed'));
    expect(await requestBrowserCommand({ command: 'health' }, {})).toMatchObject({
      error: { code: 'CONNECTION_FAILED' },
      actionStatus: 'unknown',
    });
  });
  test.each([
    [401, 'UNAUTHORIZED'],
    [403, 'FORBIDDEN'],
  ])('preserves a local security failure from HTTP %s', async (status, code) => {
    const failure = {
      ok: false,
      error: { code, message: 'Local bridge denied the request' },
      actionStatus: 'not_started',
    };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(failure), { status }));
    const response = await requestBrowserCommand({ command: 'health' }, {});
    expect(response).toEqual(failure);
    expect(browserExitCode(response)).toBe(4);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  test.each([{ ok: true }, { ok: false }, { unexpected: true }])(
    'rejects malformed success/status payload %j',
    async (payload) => {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }));
      expect(await requestBrowserCommand({ command: 'health' }, {})).toMatchObject({
        error: { code: 'INVALID_RESPONSE' },
      });
    },
  );
  test('does not report success when an HTTP error contains ok true', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"ok":true,"result":{}}', { status: 500 }));
    expect(await requestBrowserCommand({ command: 'health' }, {})).toMatchObject({
      error: { code: 'HTTP_ERROR' },
    });
  });
  test('passes cancellation to fetch without retrying the request', async () => {
    fetchMock.mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true,
          });
        }),
    );
    const controller = new AbortController();
    const pending = requestBrowserCommand({ command: 'eval' }, {}, controller.signal);
    controller.abort();
    expect(await pending).toMatchObject({ error: { code: 'CANCELLED' }, actionStatus: 'unknown' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
