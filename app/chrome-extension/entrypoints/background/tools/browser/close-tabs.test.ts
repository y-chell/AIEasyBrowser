import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { closeTabsTool } from './common';

let tabs: chrome.tabs.Tab[];
let query: ReturnType<typeof vi.fn>;
let remove: ReturnType<typeof vi.fn>;
const exactUrl = 'https://fixture.test/path?mode=test#first';

beforeEach(() => {
  tabs = [
    { id: 1, windowId: 1, url: exactUrl, active: false },
    { id: 2, windowId: 1, url: 'https://fixture.test/path/child?mode=test#first', active: false },
    { id: 3, windowId: 1, url: 'https://fixture.test/path?mode=keep#first', active: true },
    { id: 4, windowId: 1, url: 'https://fixture.test/path?mode=test#second', active: false },
  ] as chrome.tabs.Tab[];
  query = vi.fn(async (options: { active?: boolean; url?: string }) => {
    if (options.active) return tabs.filter((tab) => tab.active);
    return [...tabs];
  });
  remove = vi.fn(async (ids: number[]) => {
    tabs = tabs.filter((tab) => !ids.includes(tab.id!));
  });
  vi.stubGlobal('chrome', { tabs: { query, remove } });
});

afterEach(() => vi.unstubAllGlobals());

describe('exact URL tab closing', () => {
  test('closes the exact path without removing child paths, other queries or other hashes', async () => {
    const closed = await closeTabsTool.execute({ url: exactUrl });
    expect(closed.isError).toBe(false);
    expect(remove).toHaveBeenCalledWith([1]);
    expect(tabs.map((tab) => tab.id)).toEqual([2, 3, 4]);
    expect(query).toHaveBeenCalledWith({});
  });

  test('normalizes the origin-only URL but does not remove other paths', async () => {
    tabs.push({ id: 5, windowId: 1, url: 'https://fixture.test/' } as chrome.tabs.Tab);
    await closeTabsTool.execute({ url: 'https://fixture.test' });
    expect(remove).toHaveBeenCalledWith([5]);
    expect(tabs.map((tab) => tab.id)).toEqual([1, 2, 3, 4]);
  });

  test('matches the requested URL while initial navigation is still pending', async () => {
    tabs = [{ id: 5, windowId: 1, url: 'about:blank', pendingUrl: exactUrl }] as chrome.tabs.Tab[];
    await closeTabsTool.execute({ url: exactUrl });
    expect(remove).toHaveBeenCalledWith([5]);
  });

  test('passes explicit match patterns to Chrome unchanged', async () => {
    query.mockImplementation(async (options) => (options.url ? [tabs[0]] : [tabs[2]]));
    const pattern = 'https://fixture.test/path?mode=test*';
    await closeTabsTool.execute({ url: pattern });
    expect(query).toHaveBeenCalledWith({ url: pattern });
    expect(remove).toHaveBeenCalledWith([1]);
  });

  test('does not close anything when the exact URL is absent', async () => {
    const closed = await closeTabsTool.execute({ url: 'https://fixture.test/path?mode=absent' });
    expect(JSON.parse((closed.content[0] as { text: string }).text)).toMatchObject({
      success: false,
      closedCount: 0,
    });
    expect(remove).not.toHaveBeenCalled();
  });

  test('rejects an invalid concrete URL instead of expanding it into a pattern', async () => {
    const closed = await closeTabsTool.execute({ url: 'not a URL' });
    expect(closed.isError).toBe(true);
    expect(query).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  test('reports a rejected Chrome match pattern without deleting tabs', async () => {
    query.mockRejectedValue(new Error('Invalid URL pattern'));
    const closed = await closeTabsTool.execute({ url: 'not-a-pattern*' });
    expect(closed.isError).toBe(true);
    expect(remove).not.toHaveBeenCalled();
  });
});
