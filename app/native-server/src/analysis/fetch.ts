import http from 'http';
import https from 'https';
import fetch from 'node-fetch';
import { AnalysisError } from './errors';

export const MAX_FETCH_BYTES = 50 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

/** URL without query and fragment, for error messages: those often carry tokens. */
export function displayUrl(url: string): string {
  if (url.startsWith('data:')) return 'data:…';
  try {
    const parsed = new URL(url);
    return parsed.origin === 'null' ? `${parsed.protocol}…` : parsed.origin + parsed.pathname;
  } catch {
    return '(invalid URL)';
  }
}

function fetchFailed(url: string, detail: string): never {
  throw new AnalysisError('SOURCEMAP_FETCH_FAILED', `${displayUrl(url)}: ${detail}`);
}

// Node reads HTTP(S)_PROXY / NO_PROXY itself when an agent is created with `proxyEnv`.
const PROXY_VARIABLES = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];

export function nodeSupportsProxyEnv(version = process.versions.node): boolean {
  const [major, minor] = version.split('.').map(Number);
  return major >= 25 || (major === 24 && minor >= 5) || (major === 22 && minor >= 21);
}

function agentFor(url: URL, env: NodeJS.ProcessEnv): http.Agent | undefined {
  if (!PROXY_VARIABLES.some((name) => env[name])) return undefined;
  if (!nodeSupportsProxyEnv()) {
    fetchFailed(
      url.href,
      `a proxy is configured but Node ${process.versions.node} cannot use it (needs >=22.21 or >=24.5)`,
    );
  }
  // `proxyEnv` is newer than the @types/node in use.
  const options = { proxyEnv: env } as http.AgentOptions;
  return url.protocol === 'https:' ? new https.Agent(options) : new http.Agent(options);
}

function decodeDataUrl(url: string): string {
  const match = /^data:([^,]*),(.*)$/s.exec(url);
  if (!match) throw new AnalysisError('SOURCEMAP_INVALID', 'malformed data: URL');
  try {
    if (/;base64$/i.test(match[1])) return Buffer.from(match[2], 'base64').toString('utf8');
    return decodeURIComponent(match[2]);
  } catch (error) {
    throw new AnalysisError(
      'SOURCEMAP_INVALID',
      `malformed data: URL: ${(error as Error).message}`,
    );
  }
}

/** Fetches an http(s) or data: URL as text. */
export async function fetchText(
  url: string,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AnalysisError('INVALID_ARGUMENT', `url is not an absolute URL: ${displayUrl(url)}`);
  }
  if (parsed.protocol === 'data:') return decodeDataUrl(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AnalysisError('INVALID_ARGUMENT', `unsupported URL scheme ${parsed.protocol}`);
  }
  const agent = agentFor(parsed, env);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(onAbort, FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(parsed.href, {
      agent,
      follow: MAX_REDIRECTS,
      size: MAX_FETCH_BYTES,
      compress: true,
      signal: controller.signal as any,
    });
    if (!response.ok) fetchFailed(url, `HTTP ${response.status}`);
    return await response.text();
  } catch (error) {
    if (error instanceof AnalysisError) throw error;
    if (signal.aborted) throw signal.reason ?? error;
    const failure = error as { type?: string; message?: string };
    if (failure.type === 'aborted') fetchFailed(url, `timed out after ${FETCH_TIMEOUT_MS} ms`);
    if (failure.type === 'max-size') fetchFailed(url, `larger than ${MAX_FETCH_BYTES} bytes`);
    if (failure.type === 'max-redirect') fetchFailed(url, `more than ${MAX_REDIRECTS} redirects`);
    // node-fetch messages repeat the full URL; keep only the cause.
    const detail = String(failure.message ?? error).replace(/https?:\/\/\S+/g, (found) =>
      displayUrl(found),
    );
    return fetchFailed(url, detail);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    agent?.destroy();
  }
}
