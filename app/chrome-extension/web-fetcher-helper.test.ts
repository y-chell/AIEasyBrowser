import { afterEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { webFetcherTool } from './entrypoints/background/tools/browser/web-fetcher';

// WXT already depends on linkedom. Resolve it from WXT so these injected-script
// tests can exercise the bundled Readability without adding a project dependency.
const require = createRequire(import.meta.url);
const { parseHTML } = createRequire(require.resolve('wxt'))('linkedom');
const helperSource = readFileSync(
  new URL('./inject-scripts/web-fetcher-helper.js', import.meta.url),
  'utf8',
);

const question =
  '想给一个新注册的域名配置 DNS 解析，注册商只允许指定名称服务器。希望找到支持自定义记录、稳定解析和记录导出的管理服务，大家有什么选择经验可以分享？';
const utilityText = '工具面板，偏好设置，任务信息，查看状态，调整布局，保存配置，恢复默认值。';
const paragraphs = (text: string, count = 12) =>
  Array.from({ length: count }, () => `<p>${text}</p>`).join('');

type StyleRules = Record<string, Record<string, string>>;

function fixture(body: string, styles: StyleRules = {}, head = '') {
  const { document } = parseHTML(
    `<!doctype html><html lang="zh"><head><title>DNS 解析管理网站推荐</title>${head}</head><body>${body}</body></html>`,
  );
  const originalHtml = document.documentElement.outerHTML;
  const getComputedStyle = vi.fn((element: any) => {
    const style = { display: 'block', visibility: 'visible', opacity: '1', position: 'static' };
    for (const [selector, rule] of Object.entries(styles)) {
      if (element.matches(selector)) Object.assign(style, rule);
    }
    return style;
  });
  const window = { getComputedStyle };
  let listener: any;
  const context = vm.createContext({
    window,
    document,
    console,
    URL,
    chrome: {
      runtime: {
        onMessage: {
          addListener: (callback: any) => {
            listener = callback;
          },
        },
      },
    },
  });
  const tab = {
    id: 7,
    windowId: 1,
    url: 'https://example.test/topic/current',
    title: document.title,
  };
  const chrome = {
    tabs: {
      query: vi.fn(async () => [tab]),
      get: vi.fn(async () => tab),
      update: vi.fn(),
      sendMessage: vi.fn(
        async (_tabId, message) => new Promise((resolve) => listener(message, {}, resolve)),
      ),
    },
    windows: { update: vi.fn() },
    scripting: {
      executeScript: vi.fn(async ({ files }) => {
        expect(files).toEqual(['inject-scripts/web-fetcher-helper.js']);
        vm.runInContext(helperSource, context);
      }),
    },
  };
  vi.stubGlobal('chrome', chrome);
  const request = async (selector?: string) => {
    const result = await webFetcherTool.execute({ textContent: true, background: true, selector });
    expect(result.isError).toBe(false);
    const content = JSON.parse((result.content[0] as { text: string }).text);
    expect(content.textContentError).toBeUndefined();
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(chrome.windows.update).not.toHaveBeenCalled();
    expect(document.documentElement.outerHTML).toBe(originalHtml);
    return content;
  };
  return { request, document, getComputedStyle };
}

afterEach(() => vi.unstubAllGlobals());

describe('web fetcher main text extraction', () => {
  test('extracts a short article instead of a visible fixed utility and its CSS-hidden settings', async () => {
    const page = fixture(
      `<main><p>社区公告：欢迎大家文明交流，阅读版规，分享问题和讨论解决方案。</p></main>
       <section><article><p>${question}</p></article></section>
       <div class="utility-shell">${paragraphs(utilityText)}
         <section class="preferences">${paragraphs('隐藏设置，账号配置，主题选择，面板管理，自动执行任务。', 30)}</section>
       </div>`,
      { '.utility-shell': { position: 'fixed' }, '.preferences': { display: 'none' } },
    );
    const result = await page.request();
    expect(result.textContent).toContain(question);
    expect(result.textContent).not.toContain(utilityText);
    expect(result.textContent).not.toContain('隐藏设置');
  });

  test.each([
    { display: 'none' },
    { visibility: 'hidden' },
    { opacity: '0' },
  ] as StyleRules[string][])(
    'removes CSS-hidden competing panels with computed style %j',
    async (hiddenStyle) => {
      const page = fixture(
        `<article><p>${question}</p></article><section class="preferences">${paragraphs(utilityText, 30)}</section>`,
        { '.preferences': hiddenStyle },
      );
      const result = await page.request();
      expect(result.textContent).toContain(question);
      expect(result.textContent).not.toContain(utilityText);
    },
  );

  test('does not reintroduce hidden panels when Readability finds no article', async () => {
    const page = fixture(
      `<section class="preferences">${paragraphs(utilityText)}</section>
       <script>globalThis.secretConfiguration = 'not page text';</script>
       <style>.preferences { opacity: 0; }</style>`,
      { '.preferences': { opacity: '0' } },
    );
    expect((await page.request()).textContent).toBe('');
  });

  test('uses a semantic main without requiring an article tag', async () => {
    const page = fixture(
      `<main><p>${question}</p></main><div class="utility-shell">${paragraphs(utilityText)}</div>`,
      { '.utility-shell': { position: 'fixed' } },
    );
    const result = await page.request();
    expect(result.textContent).toContain(question);
    expect(result.textContent).not.toContain(utilityText);
  });

  test('keeps ordinary prose when there is no article or main landmark', async () => {
    const page = fixture(`<div>${paragraphs(question)}</div>`);
    expect((await page.request()).textContent).toContain(question);
  });

  test('keeps fixed content when it is the only substantive content', async () => {
    const page = fixture(`<div class="reader">${paragraphs(question)}</div>`, {
      '.reader': { position: 'fixed' },
    });
    expect((await page.request()).textContent).toContain(question);
  });

  test('keeps an article inside a fixed application layout', async () => {
    const page = fixture(`<div class="reader"><article>${paragraphs(question)}</article></div>`, {
      '.reader': { position: 'fixed' },
    });
    expect((await page.request()).textContent).toContain(question);
  });

  test('keeps fixed prose within an article', async () => {
    const page = fixture(`<article><div class="reader">${paragraphs(question)}</div></article>`, {
      '.reader': { position: 'fixed' },
    });
    expect((await page.request()).textContent).toContain(question);
  });

  test('does not use a hidden article to justify removing the actual fixed content', async () => {
    const page = fixture(
      `<article class="old-route">${paragraphs('An earlier article, with unrelated text, from another route.')}</article>
       <div class="reader">${paragraphs(question)}</div>`,
      { '.old-route': { display: 'none' }, '.reader': { position: 'fixed' } },
    );
    const result = await page.request();
    expect(result.textContent).toContain(question);
    expect(result.textContent).not.toContain('An earlier article');
  });

  test('extracts current body text even when SPA description metadata is stale', async () => {
    const page = fixture(
      `<article><p>${question}</p></article><div class="utility-shell">${paragraphs(utilityText)}</div>`,
      { '.utility-shell': { position: 'fixed' } },
      '<meta name="description" content="Previous route: a different question about hardware.">',
    );
    const result = await page.request();
    expect(result.textContent).toContain(question);
    expect(result.textContent).not.toContain('Previous route');
    expect(result.textContent).not.toContain(utilityText);
  });

  test('keeps the explicitly selected floating panel unchanged', async () => {
    const page = fixture(
      `<article><p>${question}</p></article><div class="utility-shell">${paragraphs(utilityText)}</div>`,
      { '.utility-shell': { position: 'fixed' } },
    );
    const selectedText = page.document.querySelector('.utility-shell').innerText;
    expect((await page.request('.utility-shell')).textContent).toBe(selectedText);
    expect(page.getComputedStyle).not.toHaveBeenCalled();
  });
});
