import { defineConfig } from 'wxt';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { CHROME_EXTENSION_KEY } from '../../packages/shared/src/constants';
import { config } from 'dotenv';
import { existsSync, readdirSync } from 'fs';
import { relative, resolve, sep } from 'path';

config({ path: resolve(process.cwd(), '.env') });
config({ path: resolve(process.cwd(), '.env.local') });

const WXT_OUT_DIR = process.env.WXT_OUT_DIR?.trim();
const STATIC_ASSET_DIRS = ['inject-scripts', '_locales'] as const;
const MCP_HTTP_HOST = (process.env.CHROME_MCP_HOST || process.env.MCP_HTTP_HOST || '127.0.0.1')
  .trim()
  .replace(/^https?:\/\//, '')
  .replace(/\/+$/, '');
// Detect dev mode early for manifest-level switches
const IS_DEV = process.env.NODE_ENV !== 'production' && process.env.MODE !== 'production';

function collectStaticAssets(baseDirName: (typeof STATIC_ASSET_DIRS)[number]) {
  const baseDir = resolve(process.cwd(), baseDirName);
  if (!existsSync(baseDir)) return [];

  const assets: Array<{ absoluteSrc: string; relativeDest: string }> = [];
  const walk = (currentDir: string) => {
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const absolutePath = resolve(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }

      if (entry.isFile()) {
        const relativePath = relative(baseDir, absolutePath).split(sep).join('/');
        assets.push({
          absoluteSrc: absolutePath,
          relativeDest: `${baseDirName}/${relativePath}`,
        });
      }
    }
  };

  walk(baseDir);
  return assets;
}

const STATIC_PUBLIC_ASSETS = STATIC_ASSET_DIRS.flatMap((dir) => collectStaticAssets(dir));

// See https://wxt.dev/api/config.html
export default defineConfig({
  outDir: WXT_OUT_DIR || undefined,
  modules: [],
  hooks: {
    // WXT reads web-accessible resources during the build, so copy these files
    // through WXT's own public-asset pipeline instead of relying on Vite timing.
    'build:publicAssets': (_, assets) => {
      assets.push(...STATIC_PUBLIC_ASSETS);
    },
  },
  webExt: {
    disabled: true,
  },
  manifest: {
    key: CHROME_EXTENSION_KEY,
    default_locale: 'zh_CN',
    name: '__MSG_extensionName__',
    description: '__MSG_extensionDescription__',
    permissions: [
      'nativeMessaging',
      'tabs',
      'tabGroups',
      'activeTab',
      'scripting',
      'downloads',
      'webRequest',
      'webNavigation',
      'debugger',
      'history',
      'bookmarks',
      'offscreen',
      'storage',
      'clipboardRead',
      'clipboardWrite',
    ],
    host_permissions: ['<all_urls>'],
    action: {
      default_title: 'AIEasyBrowser',
      default_icon: {
        16: 'icon/16.png',
        32: 'icon/32.png',
      },
    },
    web_accessible_resources: [
      {
        resources: ['/inject-scripts/*'],
        matches: ['<all_urls>'],
      },
    ],
    // 注意：以下安全策略在开发环境会阻断 dev server 的资源加载，
    // 只在生产环境启用，开发环境交由 WXT 默认策略处理。
    ...(IS_DEV
      ? {}
      : {
          cross_origin_embedder_policy: { value: 'require-corp' as const },
          cross_origin_opener_policy: { value: 'same-origin' as const },
          content_security_policy: {
            // Allow inline styles injected by Vite (compiled CSS) and data images used in UI thumbnails
            extension_pages:
              "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:;",
          },
        }),
  },
  vite: (env) => ({
    define: {
      __MCP_HTTP_HOST__: JSON.stringify(MCP_HTTP_HOST || '127.0.0.1'),
    },
    plugins: [
      // Production assets use WXT's public-asset hook above. A second copy during
      // writeBundle can race WXT's manifest validation on clean Windows builds.
      ...(env.mode !== 'production'
        ? [
            viteStaticCopy({
              targets: [
                {
                  src: 'inject-scripts/*.js',
                  dest: 'inject-scripts',
                },
                {
                  src: '_locales/**/*',
                  dest: '_locales',
                },
              ],
              hook: 'writeBundle',
              watch: {} as any,
            }) as any,
          ]
        : []),
    ],
    build: {
      // Must stay >= es2017. Functions passed to chrome.scripting.executeScript({ func }) are
      // serialized and run in the page; with a lower target esbuild rewrites `async` into the
      // bundle-level `__async` helper (and object spread into `__spreadValues`), which does not
      // exist in the page, so the injected call throws and executeScript returns `null`.
      // MV3 already requires Chrome 88+, which supports everything in es2020.
      target: 'es2020',
      // 非生产环境下生成sourcemap
      sourcemap: env.mode !== 'production',
      // 禁用gzip 压缩大小报告，因为压缩大型文件可能会很慢
      reportCompressedSize: false,
      // chunk大小超过1500kb是触发警告
      chunkSizeWarningLimit: 1500,
      minify: false,
    },
  }),
});
