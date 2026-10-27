import { afterEach, describe, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('local bridge URL in the extension', () => {
  test.each([
    ['', 'http://127.0.0.1:12307'],
    ['localhost', 'http://localhost:12307'],
    ['::1', 'http://[::1]:12307'],
    ['[::1]', 'http://[::1]:12307'],
  ])(
    'formats the configured host %j without invalid or duplicate IPv6 brackets',
    async (host, expected) => {
      vi.stubGlobal('__BRIDGE_HTTP_HOST__', host);
      const { getLocalServerBaseUrl } = await import('./constants');
      expect(getLocalServerBaseUrl(12307)).toBe(expected);
      expect(new URL(getLocalServerBaseUrl('23456')).port).toBe('23456');
    },
  );
});
