import { redactInlineSecrets } from 'aieasybrowser-shared';

/** Resource-relative position of the first character of an analysed text (0-based, as in CDP). */
export interface TextBase {
  line: number;
  column: number;
}

export const ZERO_BASE: TextBase = { line: 0, column: 0 };

// Same line terminators as V8 and chrome_cdp_scripts, so locations agree with B2.
const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/g;

export function lineStarts(text: string): number[] {
  const starts = [0];
  LINE_BREAK.lastIndex = 0;
  for (let match = LINE_BREAK.exec(text); match; match = LINE_BREAK.exec(text)) {
    starts.push(match.index + match[0].length);
  }
  return starts;
}

export function locate(
  starts: number[],
  offset: number,
  base: TextBase,
): { line: number; column: number } {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  const column = offset - starts[low];
  return { line: base.line + low, column: low === 0 ? base.column + column : column };
}

/** Largest end <= `end` whose slice from `start` fits in maxBytes of UTF-8, never splitting a pair. */
export function fitBytes(text: string, start: number, end: number, maxBytes: number): number {
  let bytes = 0;
  let index = start;
  while (index < end) {
    const code = text.charCodeAt(index);
    const pair = code >= 0xd800 && code <= 0xdbff && index + 1 < end;
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : pair ? 4 : 3;
    if (bytes + size > maxBytes) break;
    bytes += size;
    index += pair ? 2 : 1;
  }
  return index;
}

export function byteLength(value: unknown): number {
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

export function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

/** Redaction for text shown on stdout; files keep the original bytes. */
export function shown(text: string, sanitize: boolean): { text: string; redacted: boolean } {
  return sanitize ? redactInlineSecrets(text) : { text, redacted: false };
}
