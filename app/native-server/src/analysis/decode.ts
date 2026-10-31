import { AnalysisError } from './errors';
import { byteLength, clip, shown } from './text';

export type DecodeAction = 'base64' | 'base64url' | 'hex' | 'url' | 'jwt';

const MAX_LEAF_CHARS = 4000;

function fail(detail: string): never {
  throw new AnalysisError('DECODE_FAILED', detail);
}

function base64Bytes(input: string, alphabet: 'base64' | 'base64url'): Buffer {
  const text = input.replace(/\s+/g, '');
  const pattern = alphabet === 'base64' ? /^[A-Za-z0-9+/]*={0,2}$/ : /^[A-Za-z0-9_-]*={0,2}$/;
  if (!text || !pattern.test(text)) fail(`input is not ${alphabet}`);
  const padded = text.includes('=');
  if ((padded && text.length % 4 !== 0) || text.replace(/=+$/, '').length % 4 === 1) {
    fail(`${alphabet} length is invalid`);
  }
  return Buffer.from(text, alphabet);
}

function hexBytes(input: string): Buffer {
  const text = input.replace(/\s+/g, '').replace(/^0x/i, '');
  if (!text || !/^[0-9a-fA-F]*$/.test(text)) fail('input is not hex');
  if (text.length % 2 !== 0) fail('hex input has an odd number of digits');
  return Buffer.from(text, 'hex');
}

/** UTF-8 text when the bytes are valid UTF-8, otherwise hex. */
function bytesResult(bytes: Buffer) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { encoding: 'utf8' as const, byteLength: bytes.length, text };
  } catch {
    return { encoding: 'binary' as const, byteLength: bytes.length, hex: bytes.toString('hex') };
  }
}

function jwtPart(part: string, label: string): Record<string, unknown> {
  const bytes = base64Bytes(part, 'base64url');
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    fail(`JWT ${label} is not JSON: ${(error as Error).message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`JWT ${label} is not a JSON object`);
  }
  return value as Record<string, unknown>;
}

function decodeJwt(input: string) {
  const parts = input.trim().split('.');
  if (parts.length === 5) fail('JWE (5 parts) is not supported');
  if (parts.length !== 3) fail('JWT must have 3 dot-separated parts');
  const header = jwtPart(parts[0], 'header');
  const payload = jwtPart(parts[1], 'payload');
  const times: Record<string, string> = {};
  for (const claim of ['iat', 'nbf', 'exp']) {
    const value = payload[claim];
    if (typeof value === 'number' && Number.isFinite(value)) {
      const date = new Date(value * 1000);
      if (!Number.isNaN(date.getTime())) times[claim] = date.toISOString();
    }
  }
  return {
    header,
    payload,
    ...(Object.keys(times).length ? { times } : {}),
    signatureLength: parts[2].length,
    // Decoding never checks the signature.
    verified: false,
  };
}

/** Redacts and clips every string leaf. */
function present(value: unknown, sanitize: boolean, state: { redacted: boolean }): unknown {
  if (typeof value === 'string') {
    const view = shown(clip(value, MAX_LEAF_CHARS), sanitize);
    state.redacted ||= view.redacted;
    return view.text;
  }
  if (Array.isArray(value)) return value.map((item) => present(item, sanitize, state));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = present(item, sanitize, state);
    return out;
  }
  return value;
}

export function decode(
  action: DecodeAction,
  text: string,
  options: { maxOutputBytes: number; sanitize: boolean },
) {
  let result: Record<string, unknown>;
  switch (action) {
    case 'base64':
    case 'base64url':
      result = bytesResult(base64Bytes(text, action));
      break;
    case 'hex':
      result = bytesResult(hexBytes(text));
      break;
    case 'url':
      try {
        result = { text: decodeURIComponent(text) };
      } catch (error) {
        fail(`invalid percent-encoding: ${(error as Error).message}`);
      }
      break;
    case 'jwt':
      result = decodeJwt(text);
      break;
  }
  const state = { redacted: false };
  const out = present(result, options.sanitize, state) as Record<string, unknown>;
  if (state.redacted) out.redacted = true;
  if (byteLength(out) > options.maxOutputBytes) {
    throw new AnalysisError(
      'OUTPUT_TOO_LARGE',
      `decoded result is ${byteLength(out)} bytes, above maxOutputBytes ${options.maxOutputBytes}`,
    );
  }
  return { action, ...out };
}
