# Magic Tools · Chrome 扩展版

[Magic Tools](https://github.com/freewu/magic-tools) 开发者工具箱的 Chrome 扩展（Manifest V3）版本。
点击浏览器工具栏上的扩展图标即可打开完整工具箱；已有标签页时直接聚焦，不会重复开一堆页面。

上游版本：**v2.25.0**（Tauri 桌面版 + Web 版，同一套 React 代码）。

## 功能

170+ 个纯前端小工具，全部在本地运行、不联网也能用：

- 编解码 / 加解密：Base64、URL、Hex、JWT、AES、RSA、SM2 / SM3 / SM4 / SM9、Hash、bcrypt…
- 格式化 / 转换：JSON、YAML、XML、SQL、Markdown、时间戳、Cron、JSONL…
- 图片处理：压缩、裁剪、水印、格式转换、矢量描摹、二维码生成 / 识别…
- 生成器：UUID、密码、Mock 数据、CRS 申请文件、盾牌徽标…
- 网络查询：DNS(DoH)、IP 归属、网站 TDK 检测、Sitemap 检测…（MTR / Whois 需要原生网络能力，扩展版不提供）
- 娱乐：NES / GameBoy / Sega 模拟器、扫雷、白板、番茄时钟、屏幕录制…

## 构建与安装

```bash
npm install
npm run build          # 产物在 dist/
```

安装（未打包的本地扩展）：

1. 打开 `chrome://extensions/`
2. 右上角开启「开发者模式」
3. 点击「加载已解压的扩展程序」，选择本仓库的 `dist/` 目录
4. 工具栏出现 Magic Tools 图标 → 点击即打开工具箱

> `dist/` 就是最终扩展目录：`manifest.json` + `background.js` + 页面资源都在根目录。

扩展图标（`dist/icons/icon{16,32,48,128}.png`）与页面 logo（`dist/logo.png`）在构建期由
`assets/logo.png` 自动生成（零依赖 Lanczos3 缩放，见 `scripts/icon.mjs`），仓库里没有必要
再提交一份图标。换品牌图只需替换 `assets/logo.png` 后重新 `npm run build`；想单独看看
生成结果可执行 `node scripts/icon.mjs /tmp/out`。`assets/logo.png` 当前是 512×512
（由 2048 品牌母版降采样而来），图标全部为降采样、不会发糊；`dist/logo.png` 输出为 256×256，
只会用于启动图 / favicon，不会把大图塞进产物。

打包成商店可分发的 zip：

```bash
npm run package        # 生成 release/magic-tools-chrome-v<version>.zip
```

## 发布（GitHub Actions）

`.github/workflows/release.yml` 在**推送 tag** 时自动构建并发布，不用本地打包上传：

```bash
# 1) 先把版本号改成一致的两处: package.json + src/public/manifest.json
# 2) 提交后打 tag 推送，剩下的交给 Actions
npm version patch --no-git-tag-version   # 仅示例: 改 package.json 版本
# 手动把 src/public/manifest.json 的 "version" 改成同一个值，提交
git commit -am "chore: release v2.26.0"
git tag v2.26.0
git push origin main v2.26.0
```

流水线做的事：`npm ci` → `npm run typecheck` → `npm run package`（内含 `vite build`）→
校验 zip 根目录有 `manifest.json` 与 `icons/*.png` 并做 CRC 校验 → 生成 `.sha256` →
上传 artifact → 用 `gh release create --generate-notes` 建 Release，附 `zip` 和 `zip.sha256`。

版本号三处（tag / `package.json` / `src/public/manifest.json`）必须一致，
否则 `scripts/package.mjs` 会直接报错退出（避免出现 zip 名字与实际安装版本对不上）。

也想手动跑：Actions → **Release** → *Run workflow*，留空 `tag` 就只构建并保留 artifact，
填了 `tag` 则额外创建对应的 Release。

开发调试（普通 Vite 开发服务器，页面功能与扩展内一致，只是没有 `chrome.*` API）：

```bash
npm run dev            # http://localhost:1212
```

## 目录结构

```
src/
  index.html           入口 HTML（CSP 由 manifest 统一管控, 无内联脚本）
  index.tsx            React 入口（HashRouter）
  Main.tsx             布局 / 主题 / 语言 / 更新提示
  App/<Tool>/          各工具（index.tsx + define.tsx + lib.ts + lang.ts）
  App/app-modules.ts   import.meta.glob 自动注册工具
  lib/bridge.ts        运行环境桥接层（替代上游的 lib/tauri.ts）
  public/              原样拷入产物根目录:
    manifest.json      MV3 清单
    background.js      后台 service worker（图标点击 / 首次安装）
    emulatorjs/
assets/                品牌图 / 头像 / 语言旗标等静态资源（被 src 引用）
  logo.png             唯一品牌图: 构建期由它派生扩展图标与页面 logo
scripts/icon.mjs       零依赖 PNG 工具: 由 logo.png 缩放生成 16/32/48/128 图标
scripts/package.mjs    零依赖 zip 打包脚本
vite.config.mts        root=src, publicDir=src/public, target=chrome105
.github/workflows/    release.yml: 推 tag 自动构建 + 打包 + 发 Release
```

## 与桌面版 / Web 版的差异

| 方面 | 桌面版 (Tauri) | 本扩展 |
| --- | --- | --- |
| 打开方式 | 独立窗口 | 工具栏图标 → 标签页（已开则聚焦） |
| DNS 查询 | 系统解析 | 公共 DoH（Google / Cloudflare / 阿里 / 腾讯） |
| Whois / MTR 查询 | TCP 43 直连 / 原始 ICMP | **未迁移**（浏览器沙箱无法实现，扩展里不提供这两个工具） |
| 网站 TDK / Sitemap 抓取 | Rust 侧 HTTP | 页面内 `fetch`（依赖 `<all_urls>` 主机权限绕过 CORS） |
| 保存文件 | 系统保存对话框 | 浏览器下载（`<a download>`，批量导出自动改名去重） |
| 主题 / 语言同步 | Tauri 事件 | `BroadcastChannel`（多标签页互相同步，不回环） |
| 屏幕录制 | —— | 支持（扩展页面是安全上下文，可直接 `getDisplayMedia`） |
| 自动更新 | GitHub Releases | 无（由 Chrome 商店或手动更新） |

`lib/bridge.ts` 是唯一的环境适配点：`isExtensionPage()` / `isDesktopApp()`（恒为 `false`）、
`openUrl`、各类 `save*File`、主题与语言广播。其余业务代码与上游保持一致。

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `<all_urls>`（主机权限） | 「网站 TDK 检测」「Sitemap 检测」「IP 归属」等工具需要直接抓取任意站点页面，扩展页面借此绕过 CORS |
| `tabs` | 点击图标时查找已有的工具箱标签页并聚焦，避免重复开页 |
| `storage` | 工具配置与收藏 |
| `notifications` | 番茄时钟阶段完成提醒 |
| `clipboardWrite` | 各工具的「复制」按钮 |

CSP（`manifest.json`）：`script-src 'self' 'wasm-unsafe-eval'; object-src 'self'` —— `wasm-unsafe-eval`
供矢量描摹 / SM 系列算法等 WebAssembly 模块使用（MV3 不允许 `unsafe-eval`，也不接受 `script-src` 里出现 `blob:`，
因此 NES 模拟器的 AudioWorklet 在扩展内可能没有声音，画面与操作不受影响）。

启动后不再查询 GitHub Releases 检查更新（扩展的更新交给 Chrome 应用商店），因此除各工具自身发起的请求外不产生额外网络流量。

其它受 CSP 影响的细节：

- 「即时渲染 Markdown」的工具栏图标：Vditor 原生用「同步 XHR + 内联脚本」注入 SVG 图标表，
  MV3 会拦掉内联脚本导致图标空白。构建时（`vite.config.mts` 的 `transformIndexHtml`）把
  `vditor/dist/js/icons/ant.js` 里的图标表抽出来静态注入 `index.html`，因此图标正常。
- NES / GameBoy 模拟器的声音：AudioWorklet 需要 `blob:` 的脚本源，MV3 不允许，
  音频初始化会静默失败（控制台一条 `audio unavailable` 警告），画面与操作不受影响。

## 测试与类型检查

```bash
npm run typecheck      # tsc --noEmit
npm test               # jest（387 个测试文件, 从上游完整继承）
```

## 致谢

界面与工具实现均来自 [freewu/magic-tools](https://github.com/freewu/magic-tools)（MIT）。
