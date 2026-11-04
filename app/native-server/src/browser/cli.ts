import { Command, InvalidArgumentError } from 'commander';
import * as fs from 'node:fs';
import { isIP } from 'node:net';
import { getBridgeBaseUrl, getBridgeAuthHeaders } from '../constant';
import { BrowserCommandError, browserFailure, type BrowserCommandResponse } from './protocol';

export const BROWSER_COMMAND_NAMES = new Set([
  'health',
  'tabs',
  'use',
  'open',
  'scan',
  'act',
  'click',
  'fill',
  'press',
  'wait',
  'eval',
  'tools',
  'describe',
  'call',
  'session',
]);

export function parseInteger(value: string, min: number, max: number): number {
  if (!/^\d+$/.test(value))
    throw new InvalidArgumentError(`Expected an integer between ${min} and ${max}`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new InvalidArgumentError(`Expected an integer between ${min} and ${max}`);
  }
  return number;
}

export function readCliInput(value: string): string {
  if (!value.startsWith('@')) return value;
  try {
    return fs.readFileSync(value === '@-' ? 0 : value.slice(1), 'utf8');
  } catch (error) {
    throw new BrowserCommandError(
      'INVALID_ARGUMENT',
      `Cannot read input: ${(error as Error).message}`,
    );
  }
}

export function parseCliJson(value: string): unknown {
  try {
    return JSON.parse(readCliInput(value));
  } catch (error) {
    if (error instanceof BrowserCommandError) throw error;
    throw new BrowserCommandError('INVALID_ARGUMENT', `Invalid JSON: ${(error as Error).message}`);
  }
}

export function getBrowserEndpoint(value?: string): string {
  const endpoint = value ?? getBridgeBaseUrl();
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new BrowserCommandError(
      'INVALID_ARGUMENT',
      '--url must be an absolute loopback HTTP URL',
    );
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== 'http:' ||
    !(
      hostname === 'localhost' ||
      hostname === '[::1]' ||
      (isIP(hostname) === 4 && hostname.startsWith('127.'))
    ) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['/', '/browser'].includes(url.pathname)
  ) {
    throw new BrowserCommandError(
      'INVALID_ARGUMENT',
      '--url must be a loopback HTTP URL with no credentials, query, or fragment',
    );
  }
  return new URL('/browser', url).href;
}

export function browserExitCode(response: BrowserCommandResponse): number {
  if (response.ok) return 0;
  if (response.error?.code === 'INVALID_ARGUMENT') return 2;
  if (
    [
      'CONNECTION_FAILED',
      'BRIDGE_UNAVAILABLE',
      'HTTP_ERROR',
      'INVALID_RESPONSE',
      'FORBIDDEN',
      'UNAUTHORIZED',
    ].includes(response.error?.code || '')
  )
    return 4;
  if (response.error?.code === 'CANCELLED') return 130;
  return 3;
}

export async function requestBrowserCommand(
  payload: Record<string, unknown>,
  options: { url?: string; timeout?: number },
  signal?: AbortSignal,
): Promise<BrowserCommandResponse> {
  const endpoint = getBrowserEndpoint(options.url);
  const controller = new AbortController();
  const cancelled = () =>
    controller.abort(new BrowserCommandError('CANCELLED', 'CLI command cancelled'));
  signal?.addEventListener('abort', cancelled, { once: true });
  if (signal?.aborted) cancelled();
  // Give the server time to return its phase and completed-action count before the client deadline.
  const timer = setTimeout(
    () =>
      controller.abort(
        new BrowserCommandError(
          'CONNECTION_FAILED',
          'Bridge did not reply before the client deadline; any sent action may have completed',
        ),
      ),
    (options.timeout ?? 60_000) + 1_500,
  );
  try {
    controller.signal.throwIfAborted();
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getBridgeAuthHeaders() },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return {
        ...browserFailure('INVALID_RESPONSE', `Bridge returned non-JSON HTTP ${response.status}`),
        actionStatus: 'unknown',
      };
    }
    if (data && typeof data === 'object') {
      const payload = data as BrowserCommandResponse;
      const valid =
        payload.ok === true
          ? Object.prototype.hasOwnProperty.call(payload, 'result')
          : payload.ok === false &&
            typeof payload.error?.code === 'string' &&
            typeof payload.error.message === 'string';
      if (valid && (response.ok || payload.ok === false)) return payload;
      if (response.ok) {
        return {
          ...browserFailure('INVALID_RESPONSE', 'Bridge returned an invalid browser response'),
          actionStatus: 'unknown',
        };
      }
    }
    const message = (data as { error?: { message?: string } })?.error?.message;
    return {
      ...browserFailure(
        'HTTP_ERROR',
        message || `Bridge returned HTTP ${response.status} without a browser response`,
      ),
      actionStatus: 'unknown',
    };
  } catch (error) {
    const cause = controller.signal.aborted ? controller.signal.reason : error;
    return {
      ...browserFailure(
        cause instanceof BrowserCommandError ? cause.code : 'CONNECTION_FAILED',
        cause instanceof Error ? cause.message : String(cause),
      ),
      actionStatus: 'unknown',
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancelled);
  }
}

export function registerBrowserCommands(program: Command): void {
  program
    .option('--session <name>', 'Named browser task session', 'default')
    .option('--url <url>', 'Loopback bridge URL (default: configured host/port)')
    .option(
      '--timeout <ms>',
      'Overall command deadline, 1..120000 ms',
      (value) => parseInteger(value, 1, 120_000),
      60_000,
    );

  const run = async (command: Command, payload: Record<string, unknown>) => {
    const options = command.optsWithGlobals();
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    try {
      const response = await requestBrowserCommand(
        { ...payload, session: options.session, timeoutMs: options.timeout },
        options,
        controller.signal,
      );
      process.stdout.write(`${JSON.stringify(response)}\n`);
      process.exitCode = browserExitCode(response);
    } finally {
      process.removeListener('SIGINT', cancel);
      process.removeListener('SIGTERM', cancel);
    }
  };
  const actionOptions = (command: Command) =>
    command
      .option('--expect <json>', 'Postcondition JSON or @file/@-')
      .option('--no-scan', 'Do not return a new scan; old refs still expire');
  const act = (command: Command, actions: unknown[]) =>
    run(command, {
      command: 'act',
      actions,
      scan: command.opts().scan,
      ...(command.opts().expect ? { expect: parseCliJson(command.opts().expect) } : {}),
    });

  program
    .command('health')
    .description('Check the extension and CLI bridge')
    .action((_options, command) => run(command, { command: 'health' }));
  program
    .command('tabs')
    .description('List browser tabs')
    .option('--match <text>', 'Filter title/URL')
    .action((options, command) => run(command, { command: 'tabs', match: options.match }));
  program
    .command('use <tabId>')
    .description('Select an existing tab without changing browser focus')
    .option('--focus', 'Activate the tab and focus its window')
    .action((tabId, options, command) =>
      run(command, {
        command: 'use',
        tabId: parseInteger(tabId, 1, Number.MAX_SAFE_INTEGER),
        focus: Boolean(options.focus),
      }),
    );
  program
    .command('open <url>')
    .description('Open/reuse a URL; does not assert site readiness')
    .option('--current', 'Navigate the selected tab instead of opening/reusing another tab')
    .option('--background', 'Do not activate the tab or focus its window')
    .action((url, options, command) =>
      run(command, {
        command: 'open',
        url,
        current: Boolean(options.current),
        background: Boolean(options.background),
      }),
    );
  program
    .command('scan')
    .description('Return bounded page information and versioned refs')
    .option(
      '--limit <n>',
      'Global element limit, 1..200',
      (value) => parseInteger(value, 1, 200),
      40,
    )
    .option(
      '--text <n>',
      'Global text block limit, 0..80',
      (value) => parseInteger(value, 0, 80),
      10,
    )
    .option('--frame <id>', 'Scan one frame', (value) =>
      parseInteger(value, 0, Number.MAX_SAFE_INTEGER),
    )
    .action((options, command) =>
      run(command, {
        command: 'scan',
        limit: options.limit,
        text: options.text,
        frameId: options.frame,
      }),
    );
  actionOptions(
    program
      .command('act <json>')
      .description('Run ordered click/fill/press actions, check, and rescan'),
  ).action((json, _options, command) => {
    const parsed = parseCliJson(json);
    return act(command, Array.isArray(parsed) ? parsed : [parsed]);
  });
  actionOptions(program.command('click <ref>').description('Click a ref from the latest scan'))
    .option('--double', 'Double-click the element')
    .option('--trusted', 'Send trusted CDP mouse input (top frame only)')
    .action((ref, options, command) =>
      act(command, [
        {
          op: 'click',
          ref,
          double: Boolean(options.double),
          ...(options.trusted ? { trusted: true } : {}),
        },
      ]),
    );
  actionOptions(
    program
      .command('fill <ref> <value>')
      .description('Fill a control; value is a string unless --json-value is used'),
  )
    .option('--json-value', 'Parse value as a JSON string, number, or boolean')
    .action((ref, value, options, command) =>
      act(command, [{ op: 'fill', ref, value: options.jsonValue ? parseCliJson(value) : value }]),
    );
  actionOptions(
    program
      .command('press <keys>')
      .description('Press keys in the scanned frame (for example Enter or Ctrl+A)'),
  )
    .option('--frame <id>', 'Target scanned frame', (value) =>
      parseInteger(value, 0, Number.MAX_SAFE_INTEGER),
    )
    .option('--trusted', 'Send trusted CDP key events to the focused element')
    .action((keys, options, command) =>
      act(command, [
        {
          op: 'press',
          keys,
          frameId: options.frame,
          ...(options.trusted ? { trusted: true } : {}),
        },
      ]),
    );
  program
    .command('wait <json>')
    .description('Wait for an explicit condition and rescan')
    .option('--frame <id>', 'Target frame', (value) =>
      parseInteger(value, 0, Number.MAX_SAFE_INTEGER),
    )
    .option('--no-scan', 'Return only the condition result')
    .action((json, options, command) =>
      run(command, {
        command: 'wait',
        condition: parseCliJson(json),
        frameId: options.frame,
        scan: options.scan,
      }),
    );
  program
    .command('eval <code>')
    .description('Execute JS or @file/@- in the selected tab; expires refs')
    .option('--frame <id>', 'Target frame', (value) =>
      parseInteger(value, 0, Number.MAX_SAFE_INTEGER),
    )
    .action((code, options, command) =>
      run(command, { command: 'eval', code: readCliInput(code), frameId: options.frame }),
    );
  program
    .command('tools [query]')
    .description('Discover advanced tools without loading their schemas')
    .action((query, _options, command) => run(command, { command: 'tools', query }));
  program
    .command('describe <tool>')
    .description('Return one advanced tool schema')
    .action((tool, _options, command) => run(command, { command: 'describe', tool }));
  program
    .command('call <tool> [json]')
    .description('Call an advanced browser tool with JSON or @file/@-; expires refs')
    .action((tool, json, _options, command) =>
      run(command, { command: 'call', tool, args: json === undefined ? {} : parseCliJson(json) }),
    );
  program
    .command('session')
    .description('Inspect or forget named task sessions')
    .option('--list', 'List sessions')
    .option('--forget', 'Forget this session without closing its tab')
    .action((options, command) => {
      if (options.list && options.forget)
        throw new BrowserCommandError(
          'INVALID_ARGUMENT',
          '--list and --forget are mutually exclusive',
        );
      return run(command, {
        command: 'session',
        mode: options.list ? 'list' : options.forget ? 'forget' : 'show',
      });
    });
}
