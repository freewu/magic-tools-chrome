// Magic Tools — 扩展后台服务 (MV3 service worker)
//
// 点击工具栏图标时打开完整工具箱页面:
//   - 若已有工具箱标签页, 直接激活并聚焦 (避免重复点开一堆标签页)
//   - 否则新建标签页加载 index.html (HashRouter 首页)
// 说明: MV3 的 service worker 空闲会被回收, 因此不保存任何内存状态;
//       chrome.action.onClicked 每次触发都会重新执行下面的逻辑。

const PAGE = 'index.html';

/** 找到已打开的工具箱标签页 (含带 hash 路由的) */
async function findExistingTab(pageUrl) {
  try {
    const tabs = await chrome.tabs.query({});
    return tabs.find((tab) => typeof tab.url === 'string'
      && (tab.url === pageUrl || tab.url.startsWith(pageUrl + '#')));
  } catch (err) {
    console.warn('[MagicTools] tabs.query failed:', err);
    return undefined;
  }
}

async function openMagicTools() {
  const pageUrl = chrome.runtime.getURL(PAGE);
  const existing = await findExistingTab(pageUrl);
  if (existing && existing.id !== undefined) {
    try {
      await chrome.tabs.update(existing.id, { active: true });
      if (existing.windowId !== undefined) {
        await chrome.windows.update(existing.windowId, { focused: true });
      }
      return;
    } catch (err) {
      // 标签页可能刚被关闭, 退化为新建
      console.warn('[MagicTools] activate existing tab failed:', err);
    }
  }
  await chrome.tabs.create({ url: pageUrl });
}

// 点击工具栏图标 (manifest 里没有 default_popup, 所以点击会触发 onClicked)
chrome.action.onClicked.addListener(() => {
  openMagicTools();
});

// 安装 / 升级后自动打开一次, 让用户马上看到工具箱 (首次安装体验)
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    openMagicTools();
  }
});
