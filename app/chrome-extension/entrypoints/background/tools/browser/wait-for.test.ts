import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createStructuredToolResult } from '@/common/tool-handler';
import { javascriptTool } from './javascript';
import { assertTool, waitForTool } from './wait-for';

vi.mock('./computer', () => ({ computerTool: { execute: vi.fn() } }));
vi.mock('./javascript', () => ({ javascriptTool: { execute: vi.fn() } }));

beforeEach(() => {
  vi.stubGlobal('document', { readyState: 'complete' });
  vi.stubGlobal('chrome', {
    tabs: { get: vi.fn(async (id) => ({ id, windowId: 1 })) },
    scripting: {
      executeScript: vi.fn(async () => {
        throw new Error('Page CSP forbids unsafe-eval');
      }),
    },
  });
  vi.mocked(javascriptTool.execute).mockReset();
  vi.mocked(javascriptTool.execute).mockImplementation(async ({ code }) => {
    try {
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      const value = await new AsyncFunction(code)();
      return createStructuredToolResult({ success: true, result: String(value), engine: 'cdp' });
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: false, error: { message: (error as Error).message } }),
          },
        ],
      };
    }
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('JavaScript condition execution', () => {
  test.each([
    'document.readyState === "complete"',
    '() => document.readyState === "complete"',
    'function () { return true; }',
    '({ready: true}).ready',
    '"await is just text"',
  ])('evaluates %s without page-world string eval', async (predicate) => {
    const result = await assertTool.execute({
      tabId: 7,
      timeoutMs: 500,
      condition: { kind: 'javascript', predicate },
    });
    expect(result.structuredContent).toMatchObject({ passed: true, observed: true });
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(javascriptTool.execute).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 7, maxOutputBytes: 1024 }),
    );
  });
  test('does not interpret the string output "false" as truthy', async () => {
    const failed = await waitForTool.execute({
      tabId: 7,
      timeoutMs: 10,
      condition: { kind: 'javascript', predicate: 'false' },
    });
    expect(failed.isError).toBe(true);
    expect(failed.content[0]).toMatchObject({
      text: expect.stringContaining('last observed: false'),
    });
  });
  test('polls a false predicate until it becomes true and retains explicit frame targeting', async () => {
    vi.mocked(javascriptTool.execute).mockResolvedValueOnce(
      createStructuredToolResult({ success: true, result: 'false' }),
    );
    const passed = await waitForTool.execute({
      tabId: 7,
      frameId: 5,
      timeoutMs: 500,
      pollIntervalMs: 50,
      condition: { kind: 'javascript', predicate: 'true' },
    });
    expect(passed.isError).toBe(false);
    expect(javascriptTool.execute).toHaveBeenCalledTimes(2);
    expect(javascriptTool.execute).toHaveBeenCalledWith(expect.objectContaining({ frameId: 5 }));
  });
  test.each(['Promise.resolve(true)', 'async () => true'])(
    'rejects asynchronous predicates with an explicit error: %s',
    async (predicate) => {
      const failed = await assertTool.execute({
        tabId: 7,
        timeoutMs: 10,
        condition: { kind: 'javascript', predicate },
      });
      expect(failed.isError).toBe(true);
      expect(failed.content[0]).toMatchObject({
        text: expect.stringContaining('must be synchronous'),
      });
    },
  );
  test('rejects top-level await rather than awaiting it inside the JS tool wrapper', async () => {
    const failed = await assertTool.execute({
      tabId: 7,
      timeoutMs: 10,
      condition: { kind: 'javascript', predicate: 'await Promise.resolve(true)' },
    });
    expect(failed.isError).toBe(true);
    expect(failed.content[0]).toMatchObject({ text: expect.stringContaining('assert failed') });
  });
  test('reports execution/serialization failure instead of treating absent output as a match', async () => {
    vi.mocked(javascriptTool.execute).mockResolvedValue(
      createStructuredToolResult({ success: true, result: 'redacted' }),
    );
    const failed = await assertTool.execute({
      tabId: 7,
      timeoutMs: 10,
      condition: { kind: 'javascript', predicate: 'true' },
    });
    expect(failed.isError).toBe(true);
    expect(failed.content[0]).toMatchObject({
      text: expect.stringContaining('returned no boolean result'),
    });
    expect(javascriptTool.execute).toHaveBeenCalledOnce();
  });
  test('fails immediately on an engine error instead of converting it into a false predicate', async () => {
    vi.mocked(javascriptTool.execute).mockResolvedValue({
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify({ success: false, error: { message: 'Engine CSP error' } }),
        },
      ],
    });
    const failed = await assertTool.execute({
      tabId: 7,
      timeoutMs: 10_000,
      condition: { kind: 'javascript', predicate: 'true' },
    });
    expect(failed.content[0]).toMatchObject({ text: 'assert failed: Engine CSP error' });
    expect(javascriptTool.execute).toHaveBeenCalledOnce();
  });
  test('does not start another poll or return success after cancellation', async () => {
    const controller = new AbortController();
    vi.mocked(javascriptTool.execute).mockImplementation(async () => {
      controller.abort();
      return createStructuredToolResult({ success: true, result: 'true' });
    });
    await expect(
      waitForTool.execute(
        { tabId: 7, condition: { kind: 'javascript', predicate: 'true' } },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(javascriptTool.execute).toHaveBeenCalledOnce();
  });
  test('consumes a late predicate rejection after cancellation', async () => {
    let reject!: (error: Error) => void;
    const controller = new AbortController();
    vi.mocked(javascriptTool.execute).mockReturnValue(
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
    );
    const pending = waitForTool
      .execute(
        { tabId: 7, condition: { kind: 'javascript', predicate: 'true' } },
        { signal: controller.signal },
      )
      .catch((error) => error);
    await vi.waitFor(() => expect(javascriptTool.execute).toHaveBeenCalledOnce());
    controller.abort();
    expect(await pending).toMatchObject({ name: 'AbortError' });
    reject(new Error('late predicate failure'));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
