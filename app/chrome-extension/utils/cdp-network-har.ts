import {
  findHeader,
  isSensitiveHeader,
  requestHeadersOf,
  responseHeadersOf,
  STREAM_TYPES,
  type Headers,
  type NetworkRecord,
} from '@/utils/cdp-network';
import { isSensitiveKey, redactInlineSecrets } from '@/utils/output-sanitizer';

/** HAR 1.2 (http://www.softwareishard.com/blog/har-12-spec/) with Chrome DevTools' extensions. */

export const REDACTED = '[REDACTED]';

export interface HarOptions {
  includeBodies: boolean;
  sanitize: boolean;
  creatorVersion: string;
  browserVersion?: string;
}

/** Elapsed ms between two ResourceTiming marks, -1 when either is missing (HAR's "not applicable"). */
function span(timing: any, start: string, end: string): number {
  const from = timing?.[start];
  const to = timing?.[end];
  return typeof from === 'number' && typeof to === 'number' && from >= 0 && to >= from
    ? Math.round((to - from) * 1000) / 1000
    : -1;
}

/** HAR timings from ResourceTiming (ms offsets from requestTime) and the total time. */
export function phaseTimings(record: NetworkRecord, totalMs: number) {
  const timing = record.timing;
  if (!timing) {
    return { blocked: -1, dns: -1, connect: -1, ssl: -1, send: 0, wait: totalMs, receive: 0 };
  }
  const dns = span(timing, 'dnsStart', 'dnsEnd');
  const connect = span(timing, 'connectStart', 'connectEnd');
  const ssl = span(timing, 'sslStart', 'sslEnd');
  const send = Math.max(0, span(timing, 'sendStart', 'sendEnd'));
  const wait = Math.max(0, span(timing, 'sendEnd', 'receiveHeadersEnd'));
  const firstStart = [timing.dnsStart, timing.connectStart, timing.sendStart].find(
    (value) => typeof value === 'number' && value >= 0,
  );
  const blocked = typeof firstStart === 'number' ? Math.round(firstStart * 1000) / 1000 : -1;
  const used = Math.max(0, blocked) + Math.max(0, dns) + Math.max(0, connect) + send + wait;
  return {
    blocked,
    dns,
    connect,
    ssl,
    send,
    wait,
    receive: Math.max(0, Math.round((totalMs - used) * 1000) / 1000),
  };
}

function httpVersion(protocol: string | undefined): string {
  if (!protocol) return 'HTTP/1.1';
  if (protocol === 'h2') return 'HTTP/2.0';
  if (protocol === 'h3') return 'HTTP/3';
  return protocol.toUpperCase();
}

class Redactor {
  redacted = false;

  constructor(private readonly sanitize: boolean) {}

  text(value: string): string {
    if (!this.sanitize) return value;
    const result = redactInlineSecrets(value);
    this.redacted ||= result.redacted;
    return result.text;
  }

  value(sensitive: boolean, value: string): string {
    if (!this.sanitize || !sensitive) return value;
    this.redacted = true;
    return REDACTED;
  }
}

/** Set-Cookie arrives as one header joined by newlines. */
function headerList(headers: Headers, redact: Redactor) {
  return Object.entries(headers).flatMap(([name, value]) =>
    String(value)
      .split('\n')
      .map((line) => ({ name, value: redact.value(isSensitiveHeader(name), line) })),
  );
}

function cookieList(header: string | undefined, separator: string, redact: Redactor) {
  if (!header) return [];
  return header
    .split(separator)
    .map((part) => part.split(';')[0].trim())
    .filter(Boolean)
    .map((pair) => {
      const index = pair.indexOf('=');
      const name = index < 0 ? pair : pair.slice(0, index);
      return { name, value: redact.value(true, index < 0 ? '' : pair.slice(index + 1)) };
    });
}

function queryList(url: string, redact: Redactor) {
  try {
    return [...new URL(url).searchParams].map(([name, value]) => ({
      name,
      value: redact.value(isSensitiveKey(name), value),
    }));
  } catch {
    return [];
  }
}

function entryOf(record: NetworkRecord, options: HarOptions, redact: Redactor) {
  const request = requestHeadersOf(record).headers;
  const response = responseHeadersOf(record).headers;
  const totalMs = Math.max(0, (record.endedAt ?? record.startedAt) - record.startedAt);
  const mimeType = record.mimeType ?? findHeader(response, 'content-type') ?? 'x-unknown';
  const content: Record<string, unknown> = { size: -1, mimeType };
  const body = record.response.stored;
  if (body) {
    content.size = body.totalBytes;
    if (options.includeBodies) {
      content.text = body.base64 ? body.text : redact.text(body.text);
      if (body.base64) content.encoding = 'base64';
      if (body.truncated) content._truncated = true;
    }
  } else if (record.response.evicted || record.response.error) {
    content.comment = record.response.evicted
      ? 'body evicted by the 32 MB body budget'
      : `body not captured: ${record.response.error}`;
  }
  const entry: Record<string, unknown> = {
    startedDateTime: new Date(record.startedAt).toISOString(),
    time: totalMs,
    request: {
      method: record.method,
      url: redact.text(record.url),
      httpVersion: httpVersion(record.protocol),
      cookies: cookieList(findHeader(request, 'cookie'), ';', redact),
      headers: headerList(request, redact),
      queryString: queryList(record.url, redact),
      headersSize: -1,
      bodySize: record.request.stored?.totalBytes ?? (record.hasPostData ? -1 : 0),
    },
    response: {
      status: record.status ?? 0,
      statusText: record.statusText ?? (record.errorText ? record.errorText : ''),
      httpVersion: httpVersion(record.protocol),
      cookies: cookieList(findHeader(response, 'set-cookie'), '\n', redact),
      headers: headerList(response, redact),
      content,
      redirectURL: findHeader(response, 'location') ?? '',
      headersSize: -1,
      bodySize: record.encodedDataLength ?? -1,
    },
    cache: {},
    timings: phaseTimings(record, totalMs),
    _resourceType: record.resourceType.toLowerCase(),
    _seq: record.seq,
  };
  const postData = record.request.stored;
  if (postData && options.includeBodies) {
    (entry.request as Record<string, unknown>).postData = {
      mimeType: findHeader(request, 'content-type') ?? '',
      text: postData.base64 ? postData.text : redact.text(postData.text),
      ...(postData.base64 ? { _encoding: 'base64' } : {}),
    };
  }
  if (record.remoteIPAddress) entry.serverIPAddress = record.remoteIPAddress;
  if (record.errorText) entry._error = record.errorText;
  if (record.key) entry._sessionId = record.key;
  if (STREAM_TYPES.has(record.resourceType) && options.includeBodies && record.messages) {
    entry._webSocketMessages = record.messages.map((item) => ({
      type: item.direction === 'sent' ? 'send' : 'receive',
      time: item.ts / 1000,
      ...(item.opcode !== undefined ? { opcode: item.opcode } : {}),
      ...(item.event !== undefined ? { event: item.event } : {}),
      data: redact.text(item.data),
    }));
  }
  return entry;
}

export function buildHar(records: NetworkRecord[], options: HarOptions) {
  const redact = new Redactor(options.sanitize);
  const entries = records.map((record) => entryOf(record, options, redact));
  return {
    har: {
      log: {
        version: '1.2',
        creator: { name: 'AIEasyBrowser', version: options.creatorVersion },
        ...(options.browserVersion
          ? { browser: { name: 'Chrome', version: options.browserVersion } }
          : {}),
        pages: [],
        entries,
      },
    },
    redacted: redact.redacted,
  };
}
