import { describe, expect, test } from '@jest/globals';
import { decode } from './decode';

const opts = { maxOutputBytes: 51_200, sanitize: true };
const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('decode', () => {
  test('decodes base64, base64url and hex to UTF-8 text or binary hex', () => {
    expect(decode('base64', 'aGVs bG8=\n', opts)).toEqual({
      action: 'base64',
      encoding: 'utf8',
      byteLength: 5,
      text: 'hello',
    });
    expect(decode('base64url', '5Lit5paH', opts)).toMatchObject({ text: '中文' });
    expect(decode('hex', '0x48690a', opts)).toMatchObject({ text: 'Hi\n' });
    expect(decode('hex', 'ff00', opts)).toEqual({
      action: 'hex',
      encoding: 'binary',
      byteLength: 2,
      hex: 'ff00',
    });
  });

  test('percent-decodes url components', () => {
    expect(decode('url', 'a%20b%2Fc%E4%B8%AD+d', opts)).toEqual({
      action: 'url',
      text: 'a b/c中+d',
    });
  });

  test('decodes JWT header and payload without verifying, with ISO claim times', () => {
    const token = `${b64url({ alg: 'HS256' })}.${b64url({ sub: 'u1', exp: 1_700_000_000 })}.c2ln`;
    expect(decode('jwt', token, opts)).toEqual({
      action: 'jwt',
      header: { alg: 'HS256' },
      payload: { sub: 'u1', exp: 1_700_000_000 },
      times: { exp: '2023-11-14T22:13:20.000Z' },
      signatureLength: 4,
      verified: false,
    });
  });

  test('redacts secrets inside decoded strings unless sanitize is off', () => {
    const inner = 'Bearer abcdefghijklmnopqrstuvwxyz0123456789';
    const encoded = Buffer.from(inner).toString('base64');
    const shown = decode('base64', encoded, opts);
    expect(shown).toMatchObject({ redacted: true });
    expect(JSON.stringify(shown)).not.toContain('abcdefghijklmnop');
    expect(decode('base64', encoded, { ...opts, sanitize: false })).toMatchObject({ text: inner });
  });

  test.each([
    ['base64', 'a$b=', /^DECODE_FAILED: input is not base64$/],
    ['base64', 'abcde', /length is invalid/],
    ['base64url', 'ab+/', /input is not base64url/],
    ['hex', 'abc', /odd number of digits/],
    ['hex', 'zz', /input is not hex/],
    ['url', '%E4%B8', /invalid percent-encoding/],
    ['jwt', 'a.b', /3 dot-separated parts/],
    ['jwt', 'a.b.c.d.e', /JWE \(5 parts\) is not supported/],
    ['jwt', `${b64url({ alg: 'x' })}.bm90IGpzb24.sig`, /JWT payload is not JSON/],
    ['jwt', `${b64url([1])}.${b64url({})}.sig`, /JWT header is not a JSON object/],
  ] as const)('rejects invalid %s input %s', (action, text, message) => {
    expect(() => decode(action, text, opts)).toThrow(message);
  });

  test('fails when the result exceeds maxOutputBytes', () => {
    const big = Buffer.from('x'.repeat(3000)).toString('base64');
    expect(() => decode('base64', big, { maxOutputBytes: 1000, sanitize: false })).toThrow(
      /^OUTPUT_TOO_LARGE: /,
    );
  });
});
