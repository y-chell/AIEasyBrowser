import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cdpScriptsTool } from './cdp-scripts';
import { cdpSessionTool } from './cdp-session';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { clearCdpSessionsForTest } from '@/utils/cdp-event-hub';

vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: {
    attach: vi.fn(),
    detach: vi.fn(),
    sendCommand: vi.fn(),
    withSession: vi.fn(async (_tabId: number, _owner: string, fn: () => Promise<unknown>) => fn()),
  },
}));

type EventListener = (source: any, method: string, params?: any) => void;
let eventListeners: EventListener[];
let detachListeners: Array<(source: any, reason: string) => void>;

const A = { owner: 'cli:A', strictTarget: true };
const B = { owner: 'cli:B', strictTarget: true };

function emit(method: string, params?: unknown, sessionId?: string) {
  for (const listener of eventListeners) listener({ tabId: 7, sessionId }, method, params);
}

function body(result: any) {
  expect(result.isError, result.content?.[0]?.text).toBe(false);
  return JSON.parse(result.content[0].text);
}

function errorText(result: any): string {
  expect(result.isError).toBe(true);
  return result.content[0].text;
}

const scripts = (args: Record<string, unknown>, context: any = A) =>
  cdpScriptsTool.execute({ tabId: 7, ...args } as any, context);

const BUNDLE = 'var a=1&&b;function sign(x){return x+"TOKEN"}\nsign(2);\nconsole.log("tail")';
const INLINE = 'window.cfg = {k: 1};\nsign(window.cfg)';
const SECRET = 'const auth = "Bearer abcdefghijklmnop";\nsign(auth)';

interface FakeScript {
  scriptId: string;
  url: string;
  source: string;
  startLine?: number;
  startColumn?: number;
  sessionId?: string;
  aux?: Record<string, unknown>;
  hasSourceURL?: boolean;
  wasm?: boolean;
}

let live: FakeScript[];

function parsedParams(script: FakeScript) {
  const lines = script.source.split('\n');
  return {
    scriptId: script.scriptId,
    url: script.url,
    startLine: script.startLine ?? 0,
    startColumn: script.startColumn ?? 0,
    endLine: (script.startLine ?? 0) + lines.length - 1,
    endColumn: lines[lines.length - 1].length,
    executionContextId: 1,
    hash: 'h' + script.scriptId,
    executionContextAuxData: script.aux ?? { isDefault: true, type: 'default', frameId: 'F0' },
    length: script.source.length,
    ...(script.hasSourceURL ? { hasSourceURL: true } : {}),
    ...(script.scriptId === '10' ? { sourceMapURL: 'bundle.js.map' } : {}),
    scriptLanguage: script.wasm ? 'WebAssembly' : 'JavaScript',
  };
}

async function startSession() {
  body(await cdpSessionTool.execute({ tabId: 7, action: 'start' } as any, A));
}

beforeEach(() => {
  vi.clearAllMocks();
  clearCdpSessionsForTest();
  eventListeners = [];
  detachListeners = [];
  live = [
    { scriptId: '10', url: 'http://app.test/bundle.js', source: BUNDLE },
    { scriptId: '11', url: 'http://app.test/', source: INLINE, startLine: 5, startColumn: 12 },
    { scriptId: '12', url: '', source: '1+1' },
    {
      scriptId: '13',
      url: 'chrome-extension://x/content.js',
      source: 'injected()',
      aux: { isDefault: false, type: 'isolated', frameId: 'F0' },
    },
  ];
  vi.stubGlobal('chrome', {
    tabs: {
      get: vi.fn(async (id: number) =>
        id === 7 ? { id, windowId: 1 } : Promise.reject(new Error('No tab')),
      ),
      query: vi.fn(async () => [{ id: 7, windowId: 1, active: true }]),
      onRemoved: { addListener: vi.fn() },
    },
    windows: { getLastFocused: vi.fn(async () => ({ id: 1 })) },
    debugger: {
      onEvent: { addListener: (fn: EventListener) => eventListeners.push(fn) },
      onDetach: { addListener: (fn: any) => detachListeners.push(fn) },
    },
  });
  vi.mocked(cdpSessionManager.attach).mockResolvedValue(undefined);
  vi.mocked(cdpSessionManager.detach).mockResolvedValue(undefined);
  vi.mocked(cdpSessionManager.sendCommand).mockImplementation(
    async (_tabId: number, method: string, params?: any, sessionId?: string) => {
      if (method === 'Debugger.enable') {
        // Chrome replays scriptParsed for live scripts before the enable result.
        for (const script of live.filter((item) => item.sessionId === sessionId)) {
          emit('Debugger.scriptParsed', parsedParams(script), sessionId);
        }
        return { debuggerId: 'd' };
      }
      if (method === 'Debugger.getScriptSource') {
        const script = live.find(
          (item) => item.scriptId === params.scriptId && item.sessionId === sessionId,
        );
        if (!script) throw new Error(`No script for id: ${params.scriptId}`);
        // Chrome may attach an empty bytecode to plain JavaScript as well.
        return script.wasm
          ? { scriptSource: '', bytecode: 'AGFzbQ==' }
          : { scriptSource: script.source, bytecode: '' };
      }
      return {};
    },
  );
});
afterEach(() => {
  clearCdpSessionsForTest();
  vi.unstubAllGlobals();
});

describe('chrome_cdp_scripts preconditions', () => {
  test('requires a held session of the same task', async () => {
    expect(errorText(await scripts({ action: 'list' }, {}))).toContain('CDP_SESSION_NOT_STARTED');
    expect(errorText(await scripts({ action: 'list' }))).toContain('CDP_SESSION_NOT_STARTED');
    await startSession();
    expect(errorText(await scripts({ action: 'list' }, B))).toContain('CDP_SESSION_OWNED');
    expect(cdpSessionManager.sendCommand).not.toHaveBeenCalledWith(
      7,
      'Debugger.enable',
      expect.anything(),
      undefined,
    );
  });

  test.each([
    [{ action: 'source' }, 'requires scriptId'],
    [{ action: 'source', scriptId: '10', offset: 0, line: 1 }, 'not both'],
    [{ action: 'search' }, 'non-empty query'],
    [{ action: 'search', query: '(', isRegex: true }, 'not a valid regular expression'],
    [{ action: 'search', query: 'x', cursor: 'bogus' }, 'cursor must be'],
    [{ action: 'list', sessionId: 'ghost' }, 'CDP_UNKNOWN_SESSION'],
  ])('rejects %j before enabling the debugger', async (args, message) => {
    await startSession();
    vi.mocked(cdpSessionManager.sendCommand).mockClear();
    expect(errorText(await scripts(args))).toContain(message);
    expect(cdpSessionManager.sendCommand).not.toHaveBeenCalled();
  });
});

describe('chrome_cdp_scripts list', () => {
  test('enables Debugger once with skipAllPauses and classifies replayed scripts', async () => {
    await startSession();
    const listed = body(await scripts({ action: 'list' }));
    expect(cdpSessionManager.sendCommand).toHaveBeenCalledWith(7, 'Page.enable', {});
    expect(cdpSessionManager.sendCommand).toHaveBeenCalledWith(
      7,
      'Debugger.enable',
      { maxScriptsCacheSize: 100 * 1024 * 1024 },
      undefined,
    );
    expect(cdpSessionManager.sendCommand).toHaveBeenCalledWith(
      7,
      'Debugger.setSkipAllPauses',
      { skip: true },
      undefined,
    );
    expect(listed.scripts.map((script: any) => [script.scriptId, script.kind])).toEqual([
      ['10', 'external'],
      ['11', 'inline'],
      ['12', 'eval'],
    ]);
    expect(listed.scripts[0]).toMatchObject({
      target: 'page',
      context: 'default',
      sourceMapURL: 'bundle.js.map',
      length: BUNDLE.length,
      hash: 'h10',
    });
    expect(listed).toMatchObject({ total: 3, hasMore: false, dropped: 0 });

    const withIsolated = body(await scripts({ action: 'list', includeIsolated: true }));
    expect(withIsolated.scripts.map((script: any) => script.scriptId)).toContain('13');
    expect(
      vi
        .mocked(cdpSessionManager.sendCommand)
        .mock.calls.filter((call) => call[1] === 'Debugger.enable'),
    ).toHaveLength(1);
  });

  test('filters by url, kind, and pages with a seq cursor', async () => {
    await startSession();
    expect(
      body(await scripts({ action: 'list', url: 'BUNDLE' })).scripts.map((s: any) => s.scriptId),
    ).toEqual(['10']);
    expect(
      body(await scripts({ action: 'list', kind: 'inline' })).scripts.map((s: any) => s.scriptId),
    ).toEqual(['11']);
    const first = body(await scripts({ action: 'list', limit: 2 }));
    expect(first).toMatchObject({ hasMore: true, nextAfter: 2 });
    const second = body(await scripts({ action: 'list', after: first.nextAfter }));
    expect(second.scripts.map((s: any) => s.scriptId)).toEqual(['12']);
  });

  test('enables existing and later child sessions and labels worker scripts', async () => {
    await startSession();
    emit('Target.attachedToTarget', {
      sessionId: 'frame-1',
      targetInfo: { targetId: 'T1', type: 'iframe', url: 'http://other.test/' },
    });
    live.push({
      scriptId: '10',
      url: 'http://other.test/f.js',
      source: 'f()',
      sessionId: 'frame-1',
    });
    await scripts({ action: 'list' });
    expect(cdpSessionManager.sendCommand).toHaveBeenCalledWith(7, 'Page.enable', {}, 'frame-1');

    live.push({ scriptId: '3', url: 'blob:w', source: 'onmessage=1', sessionId: 'worker-1' });
    emit('Target.attachedToTarget', {
      sessionId: 'worker-1',
      targetInfo: { targetId: 'T2', type: 'worker', url: 'blob:w' },
    });
    await vi.waitFor(() =>
      expect(cdpSessionManager.sendCommand).toHaveBeenCalledWith(
        7,
        'Debugger.enable',
        expect.anything(),
        'worker-1',
      ),
    );
    expect(cdpSessionManager.sendCommand).not.toHaveBeenCalledWith(
      7,
      'Page.enable',
      {},
      'worker-1',
    );
    const listed = body(await scripts({ action: 'list' })).scripts;
    // Same scriptId in two isolates stays two entries.
    expect(listed.filter((s: any) => s.scriptId === '10').map((s: any) => s.target)).toEqual([
      'page',
      'iframe',
    ]);
    expect(listed.find((s: any) => s.sessionId === 'worker-1')).toMatchObject({ target: 'worker' });
    expect(
      body(await scripts({ action: 'list', sessionId: '' })).scripts.every(
        (s: any) => !s.sessionId,
      ),
    ).toBe(true);
  });

  test('drops scripts of navigated frames and detached children', async () => {
    live.push({
      scriptId: '20',
      url: 'http://app.test/sub.js',
      source: 'sub()',
      aux: { type: 'default', frameId: 'F1' },
    });
    await startSession();
    emit('Target.attachedToTarget', {
      sessionId: 'frame-1',
      targetInfo: { targetId: 'T1', type: 'iframe', url: 'http://other.test/' },
    });
    live.push({
      scriptId: '5',
      url: 'http://other.test/f.js',
      source: 'f()',
      sessionId: 'frame-1',
    });
    await scripts({ action: 'list' });

    emit('Page.frameNavigated', { frame: { id: 'F1', parentId: 'F0' }, type: 'Navigation' });
    let ids = body(await scripts({ action: 'list' })).scripts.map((s: any) => s.scriptId);
    expect(ids).not.toContain('20');
    expect(ids).toContain('10');

    emit('Target.detachedFromTarget', { sessionId: 'frame-1' });
    expect(
      body(await scripts({ action: 'list' })).scripts.some((s: any) => s.sessionId === 'frame-1'),
    ).toBe(false);

    emit('Page.frameNavigated', { frame: { id: 'F0' }, type: 'Navigation' });
    emit(
      'Debugger.scriptParsed',
      parsedParams({ scriptId: '30', url: 'http://app.test/new.js', source: 'n()' }),
    );
    ids = body(await scripts({ action: 'list' })).scripts.map((s: any) => s.scriptId);
    expect(ids).toEqual(['30']);
  });
});

describe('chrome_cdp_scripts source', () => {
  test('reads offset slices, continues with endOffset, and caches the source', async () => {
    await startSession();
    const first = body(await scripts({ action: 'source', scriptId: '10', length: 12 }));
    expect(first).toMatchObject({
      offset: 0,
      endOffset: 12,
      text: BUNDLE.slice(0, 12),
      hasMore: true,
      totalLength: BUNDLE.length,
      totalLines: 3,
      startLocation: { line: 0, column: 0 },
    });
    // Source code with `=`, `&&` and `;` is not blocked as a cookie/query string.
    expect(first.redacted).toBeUndefined();
    const rest = body(
      await scripts({ action: 'source', scriptId: '10', offset: first.endOffset, length: 1e6 }),
    );
    expect(first.text + rest.text).toBe(BUNDLE);
    expect(rest.hasMore).toBe(false);
    expect(
      vi
        .mocked(cdpSessionManager.sendCommand)
        .mock.calls.filter((call) => call[1] === 'Debugger.getScriptSource'),
    ).toHaveLength(1);
  });

  test('caps the slice by UTF-8 bytes', async () => {
    live[0].source = '汉'.repeat(1000);
    await startSession();
    const page = body(await scripts({ action: 'source', scriptId: '10', maxOutputBytes: 1000 }));
    expect(page).toMatchObject({ endOffset: 333, truncatedByBytes: true, hasMore: true });
  });

  test('reads resource-relative lines of an inline script', async () => {
    await startSession();
    const page = body(await scripts({ action: 'source', scriptId: '11', line: 6, lineCount: 1 }));
    expect(page.text).toBe('sign(window.cfg)');
    expect(page.startLocation).toEqual({ line: 6, column: 0 });
    expect(errorText(await scripts({ action: 'source', scriptId: '11', line: 2 }))).toContain(
      'outside script lines 5..6',
    );
  });

  test('redacts embedded secrets unless sanitizeOutput is false', async () => {
    live[0].source = SECRET;
    await startSession();
    const safe = body(await scripts({ action: 'source', scriptId: '10' }));
    expect(safe.text).not.toContain('abcdefghijklmnop');
    expect(safe.redacted).toBe(true);
    const raw = body(await scripts({ action: 'source', scriptId: '10', sanitizeOutput: false }));
    expect(raw.text).toBe(SECRET);
  });

  test('distinguishes unknown, collected, and wasm scripts', async () => {
    live.push({ scriptId: '40', url: 'http://app.test/m.wasm', source: '', wasm: true });
    await startSession();
    await scripts({ action: 'list' });
    expect(errorText(await scripts({ action: 'source', scriptId: '99' }))).toContain(
      'SCRIPT_NOT_FOUND',
    );
    expect(errorText(await scripts({ action: 'source', scriptId: '40' }))).toContain(
      'SCRIPT_NOT_TEXT',
    );
    live = live.filter((script) => script.scriptId !== '12');
    expect(errorText(await scripts({ action: 'source', scriptId: '12' }))).toContain('SCRIPT_GONE');
    expect(
      body(await scripts({ action: 'list' })).scripts.map((s: any) => s.scriptId),
    ).not.toContain('12');
  });
});

describe('chrome_cdp_scripts search', () => {
  test('returns resource-relative line:column, offset, and snippets across scripts', async () => {
    await startSession();
    const result = body(await scripts({ action: 'search', query: 'sign(', contextChars: 4 }));
    expect(
      result.matches.map((match: any) => [match.scriptId, match.line, match.column, match.offset]),
    ).toEqual([
      ['10', 0, 20, 20],
      ['10', 1, 0, 46],
      ['11', 6, 0, 21],
    ]);
    expect(result.matches[0]).toMatchObject({ before: 'ion ', match: 'sign(', after: 'x){r' });
    expect(result).toMatchObject({ scriptsSearched: 3, hasMore: false });
  });

  test('applies the inline startColumn to hits on the first line', async () => {
    await startSession();
    const hit = body(await scripts({ action: 'search', query: 'cfg', url: 'app.test/' }));
    expect(hit.matches[0]).toMatchObject({ scriptId: '11', line: 5, column: 12 + 7, offset: 7 });
  });

  test('pages with a cursor without repeating or skipping matches', async () => {
    await startSession();
    const all = body(await scripts({ action: 'search', query: 'sign' })).matches;
    const seen: any[] = [];
    let cursor: string | undefined;
    do {
      const page = body(await scripts({ action: 'search', query: 'sign', maxMatches: 1, cursor }));
      seen.push(...page.matches);
      cursor = page.cursor;
      expect(page.hasMore).toBe(cursor !== undefined);
    } while (cursor);
    expect(seen).toEqual(all);
  });

  test('supports regex, case sensitivity, and zero-length matches', async () => {
    await startSession();
    expect(
      body(await scripts({ action: 'search', query: 'token', caseSensitive: true })).matches,
    ).toHaveLength(0);
    expect(body(await scripts({ action: 'search', query: 'token' })).matches).toHaveLength(1);
    const regex = body(
      await scripts({ action: 'search', query: 'function\\s+(\\w+)', isRegex: true }),
    );
    expect(regex.matches[0]).toMatchObject({ match: 'function sign', matchLength: 13 });
    const empty = body(
      await scripts({ action: 'search', query: '^', isRegex: true, scriptId: '12' }),
    );
    expect(empty.matches).toHaveLength(1);
  });

  test('reports per-script failures without hiding other matches', async () => {
    await startSession();
    await scripts({ action: 'list' });
    live = live.filter((script) => script.scriptId !== '10');
    const result = body(await scripts({ action: 'search', query: 'sign' }));
    expect(result.scriptErrors).toEqual([
      { scriptId: '10', error: 'SCRIPT_GONE: script 10 no longer exists in the page' },
    ]);
    expect(result.matches.map((match: any) => match.scriptId)).toEqual(['11']);
  });

  test('redacts secrets in snippets while keeping raw offsets', async () => {
    live[0].source = SECRET;
    await startSession();
    const result = body(await scripts({ action: 'search', query: 'sign', scriptId: '10' }));
    expect(result.matches[0].offset).toBe(SECRET.indexOf('sign'));
    expect(JSON.stringify(result)).not.toContain('abcdefghijklmnop');
  });
});

describe('chrome_cdp_scripts with session lifecycle', () => {
  test('stop disables Debugger and a later session starts with an empty table', async () => {
    await startSession();
    await scripts({ action: 'list' });
    body(await cdpSessionTool.execute({ tabId: 7, action: 'stop' } as any, A));
    expect(cdpSessionManager.sendCommand).toHaveBeenCalledWith(7, 'Debugger.disable', {});
    expect(errorText(await scripts({ action: 'list' }))).toContain('CDP_SESSION_NOT_STARTED');

    live = [];
    await startSession();
    expect(body(await scripts({ action: 'list' })).scripts).toEqual([]);
  });

  test('stop without scripts use does not touch Debugger', async () => {
    await startSession();
    body(await cdpSessionTool.execute({ tabId: 7, action: 'stop' } as any, A));
    expect(cdpSessionManager.sendCommand).not.toHaveBeenCalledWith(7, 'Debugger.disable', {});
  });

  test('an ended session rejects script calls', async () => {
    await startSession();
    await scripts({ action: 'list' });
    for (const listener of detachListeners) listener({ tabId: 7 }, 'canceled_by_user');
    expect(errorText(await scripts({ action: 'list' }))).toContain('CDP_SESSION_ENDED');
  });
});
