import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import {
  BRIDGE_ENV,
  BRIDGE_VERSION,
  getBridgeAuthHeaders,
  getBridgeAuthToken,
  getBridgeBaseUrl,
  getBridgeHost,
  getBridgePort,
} from './index';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  for (const name of Object.values(BRIDGE_ENV)) delete process.env[name];
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('AIEasyBrowser local bridge configuration', () => {
  test('reports the native package version and default local endpoint', () => {
    expect(BRIDGE_VERSION).toBe(require('../../package.json').version);
    expect(getBridgeHost()).toBe('127.0.0.1');
    expect(getBridgePort()).toBe(12307);
    expect(getBridgeBaseUrl()).toBe('http://127.0.0.1:12307');
    expect(getBridgeAuthToken()).toBeUndefined();
    expect(getBridgeAuthHeaders()).toEqual({});
  });

  test('uses the configured host, port and bearer token', () => {
    process.env[BRIDGE_ENV.HOST] = ' localhost ';
    process.env[BRIDGE_ENV.PORT] = ' 4567 ';
    process.env[BRIDGE_ENV.AUTH_TOKEN] = ' local-token ';
    expect(getBridgeBaseUrl()).toBe('http://localhost:4567');
    expect(getBridgeAuthToken()).toBe('local-token');
    expect(getBridgeAuthHeaders()).toEqual({ Authorization: 'Bearer local-token' });
  });

  test.each(['::1', '[::1]'])('brackets IPv6 exactly once: %s', (host) => {
    process.env[BRIDGE_ENV.HOST] = host;
    expect(getBridgeBaseUrl()).toBe('http://[::1]:12307');
  });

  test.each(['', '   '])('uses defaults for empty configuration %j', (value) => {
    for (const name of Object.values(BRIDGE_ENV)) process.env[name] = value;
    expect(getBridgeBaseUrl()).toBe('http://127.0.0.1:12307');
    expect(getBridgeAuthHeaders()).toEqual({});
  });

  test.each([
    ['1', 1],
    ['65535', 65535],
    ['012307', 12307],
  ])('accepts an integer port %s', (input, expected) => {
    process.env[BRIDGE_ENV.PORT] = input;
    expect(getBridgePort()).toBe(expected);
  });

  test.each(['0', '65536', '-1', '123abc', '1.5', '+1', '1e3', '0x300f'])(
    'rejects an invalid port %j rather than silently choosing a default',
    (input) => {
      process.env[BRIDGE_ENV.PORT] = input;
      expect(getBridgePort).toThrow('AIEASYBROWSER_PORT must be an integer between 1 and 65535');
    },
  );

  test('does not consume removed MCP configuration names', () => {
    process.env.CHROME_MCP_HOST = '192.0.2.10';
    process.env.CHROME_MCP_BIND_HOST = '0.0.0.0';
    process.env.CHROME_MCP_PORT = '4567';
    process.env.CHROME_MCP_AUTH_TOKEN = 'old-token';
    process.env.MCP_HTTP_HOST = 'remote.test';
    process.env.MCP_HTTP_PORT = '2345';
    process.env.MCP_HTTP_AUTH_TOKEN = 'older-token';
    expect(getBridgeBaseUrl()).toBe('http://127.0.0.1:12307');
    expect(getBridgeAuthHeaders()).toEqual({});
  });
});
