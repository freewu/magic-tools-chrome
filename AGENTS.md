# AGENTS.md

面向在本仓库工作的 AI 代理（人类贡献者也适用）。目标：改动可交付、可回溯、不把仓库弄脏。

## 交付流程（必须遵守）

**开发任务完成后不要停在「代码改好了」，必须提交并推送到远程：**

1. 自检：`npm run typecheck`；改动涉及业务逻辑 / 工具页面时再跑 `npm test`。
2. 审阅改动：`git status` + `git diff`，确认没有混入无关文件、调试代码、临时脚本（`.tmp-*`）。
3. 提交：按 Conventional Commits 写信息，`feat:` / `fix:` / `refactor:` / `docs:` / `ci:` / `chore:`。
   多个不相关的改动拆成多个 commit，不要一锅炖。
4. 推送：`git push origin HEAD`（当前仓库远程是 `https://github.com/freewu/magic-tools-chrome`）。
   若远程拒绝（非快进），先 `git pull --rebase`，再推。
5. 汇报：分支名、commit hash、push 结果；失败要把原始报错贴出来，不要静默跳过。

**不要提交**：`dist/`、`release/`、`node_modules/`、`.jest-cache`、`*.tsbuildinfo`（已在 `.gitignore`），
以及根目录的临时品牌图 `logo.png` 等本地产物。

**发版不是普通提交**：Release 由 tag 触发（见下），不要用「改版本号 + push」代替发版，也不要在日常提交里动版本号。

## 项目速览

Magic Tools 的 Chrome 扩展（Manifest V3）版：React 18 + antd + Vite，170+ 个纯前端小工具，
`src/lib/bridge.ts` 是唯一运行环境适配层（替代上游 Tauri 版）。

```bash
npm run dev         # Vite 开发服务器 http://localhost:1212（无 chrome.* API）
npm run build       # 产物 dist/，即可加载的扩展目录
npm run package     # build + 打 zip 到 release/
npm run typecheck   # tsc --noEmit
npm test            # jest（387 个测试文件，耗时较长）
```

## 关键约定

- **图标只有一个来源**：`assets/logo.png`。构建期由 `scripts/icon.mjs`（零依赖 PNG 解码 / Lanczos3 缩放）
  生成 `dist/icons/icon{16,32,48,128}.png` 与 `dist/logo.png`，`vite.config.mts` 的 `brandAssets` 插件负责落盘，
  开发服务器用同一批内存数据。**不要把生成好的图标文件提交回仓库**，换图标只替换 `assets/logo.png`。
- **版本号三处一致**：`package.json`、`src/public/manifest.json`、发布 tag。
  `scripts/package.mjs` 会校验，不一致直接失败，避免「zip 名字和实际安装版本不符」。
- **发版流程**：改上面两处版本号 → 提交 → `git tag vX.Y.Z && git push origin main vX.Y.Z`。
  `.github/workflows/release.yml` 会构建、校验 zip、生成 sha256 并创建 GitHub Release。
- **MV3 CSP**：扩展页面 `script-src 'self'`，不允许内联脚本 / `unsafe-eval`（`wasm-unsafe-eval` 可用）。
  第三方库依赖内联脚本或 `blob:` worker 时，在 `vite.config.mts` 里构建期处理（参考 Vditor 图标表注入）。
- **新增工具**：`src/App/<Tool>/`（`index.tsx` + `define.tsx` + `lib.ts` + `lang.ts`），
  `src/App/app-modules.ts` 用 `import.meta.glob` 自动注册，无需手动登记。
- **脚本零依赖**：`scripts/` 下（打包 zip、图标生成）不引入第三方库，用 node 标准库实现。

## 风格

- 注释用中文，说明「为什么」而不是复述代码；对外文案保持简中，其余语言走 `lang.ts`。
- TypeScript strict，无 `any` 兜底；不要为过编译而放宽 `tsconfig`。
- 改动尽量小：不做无关重构、不重排格式、不顺手升级依赖。
