import { DEFAULT_SERVER_PORT } from 'aieasybrowser-shared';

export enum NATIVE_MESSAGE_TYPE {
  START = 'start',
  STARTED = 'started',
  STOP = 'stop',
  STOPPED = 'stopped',
  PING = 'ping',
  PONG = 'pong',
  ERROR = 'error',
}

export const NATIVE_SERVER_PORT = DEFAULT_SERVER_PORT;

const packageJson = require('../../package.json') as { version: string };
export const BRIDGE_VERSION = packageJson.version;

// Timeout constants (in milliseconds)
export const TIMEOUTS = {
  DEFAULT_REQUEST_TIMEOUT: 15000,
  EXTENSION_REQUEST_TIMEOUT: 20000,
  PROCESS_DATA_TIMEOUT: 20000,
} as const;

// Server configuration
export const SERVER_CONFIG = {
  HOST: '127.0.0.1',
  LOGGER_ENABLED: false,
} as const;

// HTTP Status codes
export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  GATEWAY_TIMEOUT: 504,
} as const;

// Error messages
export const ERROR_MESSAGES = {
  NATIVE_HOST_NOT_AVAILABLE: 'Native host connection not established.',
  SERVER_NOT_RUNNING: 'Server is not actively running.',
  REQUEST_TIMEOUT: 'Request to extension timed out.',
  INTERNAL_SERVER_ERROR: 'Internal Server Error',
} as const;

// ============================================================
// AIEasyBrowser configuration
// ============================================================

export const BRIDGE_ENV = {
  HOST: 'AIEASYBROWSER_HOST',
  PORT: 'AIEASYBROWSER_PORT',
  AUTH_TOKEN: 'AIEASYBROWSER_AUTH_TOKEN',
} as const;

export function getBridgeHost(): string {
  return process.env[BRIDGE_ENV.HOST]?.trim() || SERVER_CONFIG.HOST;
}

export function getBridgePort(): number {
  const raw = process.env[BRIDGE_ENV.PORT]?.trim();
  if (!raw) return NATIVE_SERVER_PORT;
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${BRIDGE_ENV.PORT} must be an integer between 1 and 65535.`);
  }
  return port;
}

export function getBridgeBaseUrl(): string {
  const host = getBridgeHost();
  const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${urlHost}:${getBridgePort()}`;
}

export function getBridgeAuthToken(): string | undefined {
  return process.env[BRIDGE_ENV.AUTH_TOKEN]?.trim() || undefined;
}

export function getBridgeAuthHeaders(): Record<string, string> {
  const token = getBridgeAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
