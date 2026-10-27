import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CHROME_EXTENSION_ID } from 'aieasybrowser-shared';
import { BRIDGE_ENV } from '../constant';
import { browserFailure } from '../browser/protocol';

export const DEFAULT_CHROME_EXTENSION_ORIGIN = `chrome-extension://${CHROME_EXTENSION_ID}`;

export interface HttpSecurityConfig {
  listenHost: string;
  authToken?: string;
  allowedHosts: ReadonlySet<string>;
  allowedOrigins: ReadonlySet<string>;
}

export type HttpSecurityGuard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export function isLoopbackRemoteAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().split('%', 1)[0];
  if (normalized === '::1') return true;
  const ipv4 = normalized.startsWith('::ffff:') ? normalized.slice(7) : normalized;
  return isIP(ipv4) === 4 && ipv4.startsWith('127.');
}

export function parseHttpSecurityConfig(options: {
  listenHost: string;
  env?: Readonly<Record<string, string | undefined>>;
}): HttpSecurityConfig {
  const raw = options.listenHost.trim().toLowerCase();
  const ipv6 = isIP(raw) === 6 || /^\[[^\]]+\]$/.test(raw);
  const host = parseHostHeader(isIP(raw) === 6 ? `[${raw}]` : raw);
  if (!host || (!ipv6 && raw.includes(':')) || !isLoopbackHost(host)) {
    throw new Error(`${BRIDGE_ENV.HOST} must be a loopback host without a port.`);
  }
  const authToken = (options.env ?? process.env)[BRIDGE_ENV.AUTH_TOKEN]?.trim() || undefined;
  if (authToken && /\s/.test(authToken)) {
    throw new Error(`${BRIDGE_ENV.AUTH_TOKEN} must not contain whitespace.`);
  }
  return {
    listenHost: host.startsWith('[') ? host.slice(1, -1) : host,
    authToken,
    allowedHosts: new Set(['localhost', '127.0.0.1', '[::1]', host]),
    allowedOrigins: new Set([DEFAULT_CHROME_EXTENSION_ORIGIN]),
  };
}

export function createHttpSecurityGuard(config: HttpSecurityConfig): HttpSecurityGuard {
  return async (request, reply) => {
    if (!isLoopbackRemoteAddress(request.socket.remoteAddress)) {
      reply
        .code(403)
        .send(browserFailure('FORBIDDEN', 'Browser CLI is only available over loopback'));
      return;
    }
    const host = getRequestHost(request);
    if (!host || !config.allowedHosts.has(host)) {
      reply.code(403).send(browserFailure('FORBIDDEN', 'Forbidden Host'));
      return;
    }
    const origin = getSingleHeader(request.headers.origin);
    if (origin === null || (origin !== undefined && !config.allowedOrigins.has(origin))) {
      reply.code(403).send(browserFailure('FORBIDDEN', 'Forbidden Origin'));
      return;
    }
    if (config.authToken) {
      const authorization = getSingleHeader(request.headers.authorization);
      const suppliedToken = authorization?.match(/^Bearer ([^\s]+)$/)?.[1];
      if (!suppliedToken || !tokensEqual(config.authToken, suppliedToken)) {
        reply.header('WWW-Authenticate', 'Bearer');
        reply.code(401).send(browserFailure('UNAUTHORIZED', 'Unauthorized'));
      }
    }
  };
}

/** Parse Host independently of URL normalization, which accepts ambiguous numeric hosts. */
export function parseHostHeader(value: string): string | null {
  const raw = value.trim();
  if (!raw || /[\s/@\\?#%]/.test(raw)) return null;
  if (raw.startsWith('[')) {
    const match = raw.match(/^\[([^\]]+)](?::(\d{1,5}))?$/);
    if (!match || isIP(match[1]) !== 6 || !isValidOptionalPort(match[2])) return null;
    return new URL(`http://[${match[1]}]`).hostname.toLowerCase();
  }
  const colonIndex = raw.lastIndexOf(':');
  if (colonIndex !== -1) {
    if (raw.indexOf(':') !== colonIndex || !isValidOptionalPort(raw.slice(colonIndex + 1))) {
      return null;
    }
    return normalizeHostname(raw.slice(0, colonIndex));
  }
  return normalizeHostname(raw);
}

function getRequestHost(request: FastifyRequest): string | null {
  const host = getSingleHeader(request.headers.host);
  if (host === null) return null;
  if (host !== undefined) return parseHostHeader(host);
  const authority = getSingleHeader(request.headers[':authority']);
  return authority === undefined || authority === null ? null : parseHostHeader(authority);
}

function getSingleHeader(value: string | string[] | undefined): string | null | undefined {
  return Array.isArray(value) ? null : value;
}

function tokensEqual(expected: string, supplied: string): boolean {
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  const suppliedDigest = createHash('sha256').update(supplied, 'utf8').digest();
  return timingSafeEqual(expectedDigest, suppliedDigest);
}

function normalizeHostname(value: string): string | null {
  const hostname = value.toLowerCase().replace(/\.$/, '');
  if (!hostname || hostname.length > 253) return null;
  if (isIP(hostname) === 4) return hostname;
  if (/^[\d.]+$/.test(hostname)) return null;
  const labels = hostname.split('.');
  if (
    labels.some(
      (label) =>
        !label ||
        label.length > 63 ||
        !/^[a-z0-9-]+$/.test(label) ||
        label.startsWith('-') ||
        label.endsWith('-'),
    )
  )
    return null;
  return hostname;
}

function isValidOptionalPort(value: string | undefined): boolean {
  if (value === undefined) return true;
  if (!/^\d+$/.test(value)) return false;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '[::1]' || (isIP(host) === 4 && host.startsWith('127.'));
}
