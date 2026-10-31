import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { displayUrl, fetchText, nodeSupportsProxyEnv } from './fetch';

let server: http.Server;
let proxy: http.Server;
let base: string;
let proxyUrl: string;
const proxied: string[] = [];

function listen(handler: http.RequestListener): Promise<[http.Server, string]> {
  const instance = http.createServer(handler);
  return new Promise((resolve) =>
    instance.listen(0, '127.0.0.1', () =>
      resolve([instance, `http://127.0.0.1:${(instance.address() as AddressInfo).port}`]),
    ),
  );
}

beforeAll(async () => {
  [server, base] = await listen((req, res) => {
    if (req.url === '/map.json') return void res.end('{"version":3}');
    if (req.url === '/redirect') return void res.writeHead(302, { location: '/map.json' }).end();
    if (req.url === '/loop') return void res.writeHead(302, { location: '/loop' }).end();
    if (req.url === '/hang') return; // never answers
    res.writeHead(404).end('missing');
  });
  // Minimal forward proxy: plain HTTP requests arrive with an absolute URL.
  [proxy, proxyUrl] = await listen((req, res) => {
    proxied.push(req.url ?? '');
    const upstream = http.request(
      req.url!,
      { method: req.method, headers: req.headers },
      (reply) => {
        res.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(res);
      },
    );
    upstream.on('error', () => res.writeHead(502).end());
    req.pipe(upstream);
  });
});

afterAll(async () => {
  server.closeAllConnections();
  await Promise.all([server, proxy].map((s) => new Promise((done) => s.close(done))));
});

const signal = () => new AbortController().signal;
const NO_PROXY_ENV = {};

describe('fetchText', () => {
  test('fetches http text and follows redirects', async () => {
    await expect(fetchText(`${base}/map.json`, signal(), NO_PROXY_ENV)).resolves.toBe(
      '{"version":3}',
    );
    await expect(fetchText(`${base}/redirect`, signal(), NO_PROXY_ENV)).resolves.toBe(
      '{"version":3}',
    );
  });

  test('decodes base64 and percent-encoded data: URLs', async () => {
    const json = '{"version":3}';
    const b64 = `data:application/json;base64,${Buffer.from(json).toString('base64')}`;
    await expect(fetchText(b64, signal(), NO_PROXY_ENV)).resolves.toBe(json);
    await expect(
      fetchText(`data:application/json,${encodeURIComponent(json)}`, signal(), NO_PROXY_ENV),
    ).resolves.toBe(json);
  });

  test('reports HTTP errors and redirect loops without the query string', async () => {
    await expect(fetchText(`${base}/nope?token=secret`, signal(), NO_PROXY_ENV)).rejects.toThrow(
      new RegExp(`^SOURCEMAP_FETCH_FAILED: ${base}/nope: HTTP 404$`),
    );
    await expect(fetchText(`${base}/loop`, signal(), NO_PROXY_ENV)).rejects.toThrow(
      /more than 5 redirects/,
    );
  });

  test('rejects unsupported schemes and relative URLs', async () => {
    await expect(fetchText('file:///etc/passwd', signal(), NO_PROXY_ENV)).rejects.toThrow(
      /^INVALID_ARGUMENT: unsupported URL scheme file:$/,
    );
    await expect(fetchText('map.json', signal(), NO_PROXY_ENV)).rejects.toThrow(
      /^INVALID_ARGUMENT: url is not an absolute URL/,
    );
  });

  test('aborts a pending request with the abort reason', async () => {
    const controller = new AbortController();
    const reason = new Error('command timed out');
    setTimeout(() => controller.abort(reason), 50);
    await expect(fetchText(`${base}/hang`, controller.signal, NO_PROXY_ENV)).rejects.toBe(reason);
  });

  test('sends requests through HTTP_PROXY when it is set', async () => {
    proxied.length = 0;
    const env = { HTTP_PROXY: proxyUrl, NO_PROXY: '' };
    await expect(fetchText(`${base}/map.json`, signal(), env)).resolves.toBe('{"version":3}');
    expect(proxied).toEqual([`${base}/map.json`]);
  });
});

describe('helpers', () => {
  test('displayUrl drops query, fragment and data payloads', () => {
    expect(displayUrl('https://a.test/x.map?sig=1#f')).toBe('https://a.test/x.map');
    expect(displayUrl('data:application/json,{}')).toBe('data:…');
    expect(displayUrl('not a url')).toBe('(invalid URL)');
  });

  test('proxyEnv support starts at Node 22.21 and 24.5', () => {
    expect(['20.19.0', '22.20.0', '24.4.1'].map((v) => nodeSupportsProxyEnv(v))).toEqual([
      false,
      false,
      false,
    ]);
    expect(['22.21.0', '24.5.0', '25.0.0'].map((v) => nodeSupportsProxyEnv(v))).toEqual([
      true,
      true,
      true,
    ]);
  });
});
