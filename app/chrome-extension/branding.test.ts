import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const LOGO_SHA256 = '7096e7b9273be740d5cd83999554f7449901dc9744168a6ca8f166a6d527b5d9';
const OLD_ICON_SHA256 = '321ad24fd73e0488f15581bf3e3f218f658d32308d71ef7319f6feb4810cc207';
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

describe('independent project branding', () => {
  test.each([
    '../../package.json',
    'package.json',
    '../native-server/package.json',
    '../../packages/shared/package.json',
  ])('starts %s at the independent project version', (relativePath) => {
    const pkg = JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8'));
    expect(pkg.version).toBe('0.1.0');
    expect(pkg.version).not.toBe('1.0.20');
  });

  test('preserves the supplied logo as the original asset', () => {
    const logo = readFileSync(new URL('assets/logo.png', import.meta.url));
    expect(createHash('sha256').update(logo).digest('hex')).toBe(LOGO_SHA256);
  });

  test.each([16, 32, 48, 96, 128])('ships a transparent %d pixel PNG, not the old icon', (size) => {
    const icon = readFileSync(new URL(`public/icon/${size}.png`, import.meta.url));
    expect(icon.subarray(0, PNG_SIGNATURE.length)).toEqual(PNG_SIGNATURE);
    expect(icon.toString('ascii', 12, 16)).toBe('IHDR');
    expect(icon.readUInt32BE(16)).toBe(size);
    expect(icon.readUInt32BE(20)).toBe(size);
    expect(icon[24]).toBe(8);
    expect(icon[25]).toBe(6);
    expect(createHash('sha256').update(icon).digest('hex')).not.toBe(OLD_ICON_SHA256);
  });
});
