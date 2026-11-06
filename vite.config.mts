import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { createLogger, defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { buildBrandAssets } from './scripts/icon.mjs';

// ---------------- 构建日志降噪 (仅过滤第三方包的两条固定告警) ----------------
const THIRD_PARTY_NOISE = [
  "new URL('vtracer_bg.wasm', import.meta.url) doesn't exist at build time",
];

const isThirdPartyNoise = (msg: unknown): boolean => {
  if (typeof msg !== 'string') return false;
  return THIRD_PARTY_NOISE.some((noise) => msg.includes(noise));
};

/** 过滤 vtracer 的静态资源告警 (经 logger.warnOnce 输出, 需包装 logger 才能拦住) */
const quietLogger = () => {
  const logger = createLogger();
  const warn = logger.warn.bind(logger);
  const warnOnce = logger.warnOnce.bind(logger);
  logger.warn = (msg, options) => { if (!isThirdPartyNoise(msg)) warn(msg, options); };
  logger.warnOnce = (msg, options) => { if (!isThirdPartyNoise(msg)) warnOnce(msg, options); };
  return logger;
};

// ---------------- Vditor 运行时资源 (仅「即时渲染 Markdown」使用) ----------------
// Vditor 的 lute 引擎 / 图标 / 语言包 / 代码高亮 / katex / 表情图都在运行期按 URL 拉取,
// 扩展内离线可用必须随包携带。这里把用到的子集在构建时拷到 dist/vditor, 开发服务器
// 直接用中间件从 node_modules 读取; 仓库不提交这批大文件 (~5MB)。
// 资源子路径与 src/App/VditorMarkdown/lib.ts 的 vditorCdn/MARKDOWN 前缀一一对应。
const VDITOR_ROOT = resolve(process.cwd(), 'node_modules/vditor');

const VDITOR_FILES = [
  'dist/css/content-theme/light.css',
  'dist/css/content-theme/dark.css',
  'dist/js/i18n/zh_CN.js',
  'dist/js/i18n/zh_TW.js',
  'dist/js/i18n/en_US.js',
  'dist/js/icons/ant.js',
  'dist/js/lute/lute.min.js',
  'dist/js/highlight.js/highlight.min.js',
  'dist/js/highlight.js/third-languages.js',
  'dist/js/highlight.js/styles/github.min.css',
  'dist/js/highlight.js/styles/github-dark.min.css',
  'dist/js/katex/katex.min.js',
  'dist/js/katex/katex.min.css',
  'dist/js/katex/mhchem.min.js',
];

const VDITOR_DIRS: { path: string; keep?: (name: string) => boolean }[] = [
  { path: 'dist/images/emoji' },
  { path: 'dist/js/katex/fonts', keep: (name) => name.endsWith('.woff2') },
];

const VDITOR_MIME: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

const copyDir = (from: string, to: string, keep?: (name: string) => boolean) => {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    if (entry.isDirectory()) {
      copyDir(src, join(to, entry.name), keep);
    } else if (!keep || keep(entry.name)) {
      cpSync(src, join(to, entry.name));
    }
  }
};

const copyVditorAssets = (dest: string) => {
  if (!existsSync(VDITOR_ROOT)) return;
  for (const rel of VDITOR_FILES) {
    const src = join(VDITOR_ROOT, rel);
    if (!existsSync(src)) continue;
    const out = join(dest, rel);
    mkdirSync(dirname(out), { recursive: true });
    cpSync(src, out);
  }
  for (const dir of VDITOR_DIRS) {
    const src = join(VDITOR_ROOT, dir.path);
    if (!existsSync(src)) continue;
    copyDir(src, join(dest, dir.path), dir.keep);
  }
};

/**
 * Vditor 的图标精灵 (dist/js/icons/ant.js) 用「同步 XHR + 内联脚本」把 <symbol> 表插进页面,
 * Chrome 扩展的 CSP (script-src 'self') 会拦掉内联脚本, 结果工具栏图标全部空白。
 * 这里在构建期把那段内联脚本里的 SVG 标记取出来, 作为静态 HTML 注入 index.html,
 * 并补上 Vditor 用来判断「图标已就绪」的 id: 之后 Vditor 看到 id 存在就不再加载图标脚本。
 */
const vditorIconSprite = (): string => {
  const file = join(VDITOR_ROOT, 'dist/js/icons/ant.js');
  if (!existsSync(file)) return '';
  const raw = readFileSync(file, 'utf8');
  const matched = raw.match(/insertAdjacentHTML\(\s*['"]afterbegin['"]\s*,\s*`([\s\S]*)`\s*\)/);
  if (!matched) return '';
  return matched[1].replace('<svg ', '<svg id="vditorIconScript" ', 1);
};

/** 构建时把 Vditor 运行时资源拷进产物, 开发时用中间件从 node_modules 直接读取 */
const vditorAssets = (): Plugin => {
  let outDir = resolve(process.cwd(), 'dist');
  return {
    name: 'magictools-vditor-assets',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        const sprite = vditorIconSprite();
        if (!sprite) return html;
        return html.replace('<body>', `<body>\n    ${sprite}`);
      },
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0].split('#')[0];
        if (!path.startsWith('/vditor/')) {
          next();
          return;
        }
        const file = resolve(VDITOR_ROOT, decodeURIComponent(path.slice('/vditor/'.length)));
        if (!file.startsWith(VDITOR_ROOT) || !existsSync(file) || !statSync(file).isFile()) {
          next();
          return;
        }
        res.setHeader('Content-Type', VDITOR_MIME[extname(file).toLowerCase()] ?? 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(readFileSync(file));
      });
    },
    closeBundle() {
      copyVditorAssets(join(outDir, 'vditor'));
    },
  };
};

// ---------------- 品牌图标 (assets/logo.png 为唯一来源) ----------------
// manifest.json 的 icons / action.default_icon 只接受位图, 且分别需要 16/32/48/128 尺寸;
// 页面 favicon 与启动图用的是 logo.png。构建期由 assets/logo.png 一并派生出这些文件
// (Lanczos3 缩放, 见 scripts/icon.mjs), 仓库里不再保存重复的图标文件。
const LOGO_FILE = resolve(process.cwd(), 'assets/logo.png');

/** 把 logo.png 派生的图标写进产物目录, 开发时用中间件从内存返回同一批内容 */
const brandAssets = (): Plugin => {
  let outDir = resolve(process.cwd(), 'dist');
  let cache: Map<string, Buffer> | null = null;
  const bundle = () => {
    cache ??= buildBrandAssets(LOGO_FILE);
    return cache;
  };
  return {
    name: 'magictools-brand-assets',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0].split('#')[0].replace(/^\//, '');
        const file = bundle().get(path);
        if (!file) {
          next();
          return;
        }
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(file);
      });
    },
    closeBundle() {
      try {
        for (const [name, content] of bundle()) {
          const file = join(outDir, name);
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, content);
        }
      } catch (error) {
        this.warn(`由 assets/logo.png 生成扩展图标失败: ${(error as Error).message}`);
      }
    },
  };
};

// Chrome 扩展 (Manifest V3) 前端构建
// - 入口 src/index.html + src/index.tsx, root 设为 src
// - publicDir = src/public: manifest.json / background.js / emulatorjs 原样拷入产物根目录,
//   扩展图标与 logo.png 由 brandAssets 插件从 assets/logo.png 生成,
//   最终 dist/ 即「可加载的扩展目录」(chrome://extensions -> 加载已解压的扩展程序)
// - base './': chrome-extension:// 页面与任意子路径部署都能正确解析相对资源
export default defineConfig({
  root: 'src',
  base: './',
  customLogger: quietLogger(),
  publicDir: 'public',
  plugins: [react(), vditorAssets(), brandAssets()],
  server: {
    port: 1212,
    strictPort: true,
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    // Chrome 105+ (MV3 要求的最低版本远低于此), 不向低版本转译
    target: 'chrome105',
    sourcemap: false,
    chunkSizeWarningLimit: 1100,
    rollupOptions: {
      // 过滤第 2 条第三方告警: 只有 importer 是 SM9 的 gmssl.js 时才忽略
      onwarn(warning, defaultHandler) {
        const msg = warning.message ?? '';
        if (msg.includes('has been externalized for browser compatibility') && msg.includes('gmssl.js')) return;
        defaultHandler(warning);
      },
      output: {
        // 分包: 主入口 (layout/App 注册表) 只留业务骨架, 框架/UI/工具依赖拆成独立 vendor chunk,
        // 供懒加载页面按需复用 (与上游桌面/Web 版保持一致的策略)。
        codeSplitting: {
          groups: [
            { name: 'vendor-react', priority: 100, test: /vite\/preload-helper|node_modules\/(?:react|react-dom|react-router|react-router-dom|scheduler|use-sync-external-store|@remix-run|object-assign|loose-envify|prop-types)\// },
            { name: 'app-lang', priority: 95, test: /[\\/]src[\\/]App[\\/][^\\/]+[\\/]lang\.ts$/ },
            { name: 'vendor-antd', priority: 90, test: /node_modules\/(?:antd|rc-[^/]+|@rc-component|dayjs|classnames|@ant-design)\// },
            { name: 'vendor-sql', priority: 85, test: /node_modules\/(?:sql-formatter|nearley|moo|discontinuous-range|ret|railroad-diagrams)\// },
            { name: 'vendor-highlight', priority: 84, test: /node_modules\/highlight\.js\// },
            { name: 'vendor-yaml', priority: 83, test: /node_modules\/yaml\// },
            { name: 'vendor-crypto', priority: 82, test: /node_modules\/(?:crypto-js|bcryptjs)\// },
            { name: 'vendor-barcode', priority: 81, test: /node_modules\/jsbarcode\// },
            { name: 'vendor-pinyin', priority: 80, test: /node_modules\/pinyin-pro\// },
            { name: 'vendor-pele', priority: 70, test: /node_modules\/pele\// },
            { name: 'vendor-mermaid', priority: 60, test: /node_modules\/(?:mermaid|@mermaid-js|@braintree|@iconify|@upsetjs|cytoscape|cytoscape-[^/]+|d3|d3-[^/]+|dagre-d3-es|dompurify|es-toolkit|fastdom|katex|khroma|marked|roughjs|ts-dedent|uuid)\// },
            { name: 'vendor-vditor', priority: 50, test: /node_modules\/(?:vditor|diff-match-patch)\// },
            {
              name: 'vendor-misc',
              priority: 10,
              test: (id) =>
                id.includes('node_modules') &&
                !/node_modules\/(?:@excalidraw|@radix-ui|jotai|jotai-scope|fractional-indexing|image-blob-reduce|open-color|perfect-freehand|pako|browser-fs-access|es6-promise-pool|fuzzy|canvas-roundrect-polyfill|i18next|@babel\/runtime|points-on-curve|tunnel-rat|png-chunk-text|png-chunks-encode|png-chunks-extract|use-isomorphic-layout-effect|react-is)\//.test(id) &&
                !id.includes('node_modules/@shikijs/langs') &&
                !id.includes('node_modules/svgo/dist/svgo.browser.js') &&
                !id.includes('node_modules/vtracer-wasm/'),
            },
          ],
        },
      },
    },
  },
});
