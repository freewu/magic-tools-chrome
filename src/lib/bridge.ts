// 浏览器 / Chrome 扩展环境下的平台能力桥接
//
// 上游 Magic Tools 是 Tauri 桌面应用, 这些能力分别由系统保存对话框、原生窗口与
// 托盘事件提供; Chrome 扩展版没有这些原生能力, 统一改用浏览器原生方式实现:
//   - 打开链接        -> chrome.tabs.create (扩展内) / <a target="_blank"> (普通页面)
//   - 保存文件        -> Blob + <a download> (下载到浏览器默认下载目录)
//   - 主题/语言同步    -> BroadcastChannel (同一扩展多个标签页之间实时同步)
//
// 与上游保持同名导出, 便于后续把上游工具的改动同步回本仓库。

/**
 * chrome.* 的最小结构类型
 *
 * 这里用结构化类型而不是全局 @types/chrome 声明: 全局声明有数 MB d.ts, 会让
 * ts-jest 为每个测试文件做类型检查时把整包类型都装进 program (本机实测慢 3~10 倍)。
 */
interface ChromeLike {
  runtime?: { id?: string };
  tabs?: { create(props: { url: string }): Promise<unknown> };
}

/** 取全局 chrome 对象 (非扩展环境为 undefined) */
function chromeApi(): ChromeLike | undefined {
  return (globalThis as { chrome?: ChromeLike }).chrome;
}

/** 是否运行在 Chrome 扩展页面中 (chrome-extension://...) */
export function isExtensionPage(): boolean {
  return !!chromeApi()?.runtime?.id;
}

/**
 * 是否运行在桌面端 (Tauri) 外壳中
 *
 * Chrome 扩展版恒为 false: 依赖原生能力的工具 (原始 ICMP / 原始 TCP) 无法在浏览器沙箱内实现,
 * 这些工具 (MTR 查询 / Whois 查询) 没有迁移到扩展版, 扩展里只保留浏览器可实现的工具。
 */
export function isDesktopApp(): boolean {
  return false;
}

/**
 * 打开外部链接
 *
 * 扩展页面内优先走 chrome.tabs.create (不受弹窗拦截影响), 其余场景回退 <a target="_blank">。
 */
export async function openUrl(url: string) {
  const api = chromeApi();
  if (isExtensionPage() && api?.tabs) {
    try {
      await api.tabs.create({ url });
      return;
    } catch (err) {
      console.error('chrome.tabs.create failed:', err);
    }
  }
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.click();
}

/** 触发一次浏览器下载 (Blob 方式, 用完即释放 object URL) */
function downloadBlob(defaultName: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = defaultName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // 延迟释放: 立刻 revoke 在部分 Chromium 版本上会让下载中断
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** data URL -> Blob (保存 canvas 生成的 PNG 等) */
function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  const head = dataUrl.slice(0, comma);
  const body = dataUrl.slice(comma + 1);
  const mime = /data:([^;]+)/.exec(head)?.[1] ?? 'application/octet-stream';
  if (!/;base64/i.test(head)) return new Blob([decodeURIComponent(body)], { type: mime });
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime });
}

/**
 * 保存 PNG 图片 (条形码 / 二维码等 canvas 生成图)
 * @param defaultName 默认文件名 (如 'barcode-code128.png')
 * @param dataUrl canvas.toDataURL('image/png') 得到的 data URL
 * @returns true = 已触发下载 (浏览器版无保存对话框, 恒为 true)
 */
export async function savePngFile(defaultName: string, dataUrl: string): Promise<boolean> {
  downloadBlob(defaultName, dataUrlToBlob(dataUrl));
  return true;
}

/**
 * 保存文本文件 (RSA/SM2 密钥导出等)
 * @param defaultName 默认文件名
 * @param content 文本内容 (UTF-8)
 * @param title 保存对话框标题 (浏览器版无对话框, 仅为与上游签名兼容)
 * @returns true = 已触发下载
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function saveTextFile(defaultName: string, content: string, title = '保存文件', opts: { filterName?: string; extensions?: string[] } = {}): Promise<boolean> {
  downloadBlob(defaultName, new Blob([content], { type: 'text/plain;charset=utf-8' }));
  return true;
}

/**
 * 保存二进制文件 (摩斯 WAV 导出等)
 * @param defaultName 默认文件名 (含扩展名, 如 'morse_sos_120ms.wav')
 * @param bytes 文件内容 (字节数组)
 * @returns true = 已触发下载
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function saveBytesFile(
  defaultName: string,
  bytes: Uint8Array,
  opts: { title?: string; filterName?: string; extensions?: string[] } = {},
): Promise<boolean> {
  // TS 5.7 起 Uint8Array 泛型化, BlobPart 只接受 ArrayBuffer 支撑的视图 (本项目字节均来自 ArrayBuffer)
  downloadBlob(defaultName, new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }));
  return true;
}

/**
 * 批量保存 PNG 图片 (二维码 / 条形码批量导出)
 * 浏览器版逐个触发下载 (Chrome 可能弹出「是否允许多个下载」的确认)
 * @param defaultNames 文件名数组 (含 .png 后缀, 与 dataUrls 一一对应)
 * @param dataUrls canvas.toDataURL('image/png') 得到的 data URL 数组
 * @returns 触发的下载数量
 */
export async function savePngBatch(defaultNames: string[], dataUrls: string[]): Promise<number> {
  const names = defaultNames.slice(0, dataUrls.length);
  if (names.length === 0) return 0;
  let ok = 0;
  for (let i = 0; i < names.length; i += 1) {
    downloadBlob(names[i], dataUrlToBlob(dataUrls[i]));
    ok += 1;
    // 给浏览器留出处理时间, 避免被当成垃圾行为
    await new Promise((resolve) => { window.setTimeout(resolve, 250); });
  }
  return ok;
}

/**
 * 批量保存任意文件 (Zip 解压等一次性导出多个文件)
 * 浏览器版逐个触发下载 (层级被拍平, 只保留文件名); 重名时加序号
 * @param files 待保存文件 (name 为含子目录的相对路径, 如 'docs/a.txt')
 * @returns 触发的下载数量
 */
export async function saveBytesBatch(
  files: readonly { name: string; bytes: Uint8Array }[],
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  opts: { title?: string; dirName?: string } = {},
): Promise<number> {
  if (files.length === 0) return 0;
  // 路径防御: 去掉 .. 与开头的 / (解压包可能是恶意的), 分隔符统一为 /
  const safeName = (name: string): string =>
    String(name ?? '').replace(/\\/g, '/').split('/').filter((p) => p !== '' && p !== '.' && p !== '..').join('/');

  let ok = 0;
  const used = new Set<string>();
  for (const file of files) {
    const base = safeName(file.name).split('/').pop() ?? '';
    if (base === '') continue;
    let name = base;
    for (let i = 2; used.has(name); i += 1) {
      const dot = base.lastIndexOf('.');
      name = dot > 0 ? `${base.slice(0, dot)} (${i})${base.slice(dot)}` : `${base} (${i})`;
    }
    used.add(name);
    downloadBlob(name, new Blob([file.bytes as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }));
    ok += 1;
    await new Promise((resolve) => { window.setTimeout(resolve, 250); });
  }
  return ok;
}

// ---------------- 多标签页同步 (主题 / 语言) ----------------
// 扩展版可能同时打开多个 Magic Tools 标签页, 用 BroadcastChannel 让主题与语言保持同步。
// 同一个 BroadcastChannel 实例不会收到自己发出的消息, 因此不会与本地 setState 形成回环。

type SyncMessage = { type: 'theme-mode' | 'locale' | 'open-page'; value: string };

const SYNC_CHANNEL = 'magic-tools-sync';

let channel: BroadcastChannel | null | undefined;

function syncChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(SYNC_CHANNEL);
  return channel;
}

function post(message: SyncMessage) {
  try {
    syncChannel()?.postMessage(message);
  } catch (err) {
    console.error('BroadcastChannel postMessage failed:', err);
  }
}

/** 订阅某一类同步消息, 返回取消订阅函数 */
function subscribe(type: SyncMessage['type'], handler: (value: string) => void): () => void {
  const ch = syncChannel();
  if (!ch) return () => {};
  const listener = (event: MessageEvent) => {
    const data = event.data as SyncMessage | undefined;
    if (data && data.type === type && typeof data.value === 'string') handler(data.value);
  };
  ch.addEventListener('message', listener);
  return () => ch.removeEventListener('message', listener);
}

/** 广播显示模式变化 (供其它已打开的标签页同步) */
export async function emitThemeMode(mode: string) {
  post({ type: 'theme-mode', value: mode });
}

/** 广播语言变化 (供其它已打开的标签页同步) */
export async function emitLocale(locale: string) {
  post({ type: 'locale', value: locale });
}

/** 监听其它标签页的显示模式变化 */
export async function listenThemeMode(handler: (mode: string) => void): Promise<() => void> {
  return subscribe('theme-mode', handler);
}

/** 监听其它标签页的语言变化 */
export async function listenLocale(handler: (locale: string) => void): Promise<() => void> {
  return subscribe('locale', handler);
}

/**
 * 监听「打开指定页面」事件
 * 桌面版由托盘菜单触发; 扩展版预留同一接口 (后台脚本可经 BroadcastChannel 广播),
 * 页面跳转逻辑无需改动。
 */
export async function listenOpenPage(handler: (page: string) => void): Promise<() => void> {
  return subscribe('open-page', handler);
}
