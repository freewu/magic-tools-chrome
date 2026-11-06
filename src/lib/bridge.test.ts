// 浏览器桥接层: 下载触发 / 链接打开 / 多标签页同步

import {
  emitLocale, emitThemeMode, isDesktopApp, isExtensionPage, listenLocale, listenThemeMode,
  openUrl, saveBytesBatch, saveBytesFile, savePngBatch, savePngFile, saveTextFile,
} from './bridge';

const mockCreateObjectURL = jest.fn(() => 'blob:mock');
const mockRevokeObjectURL = jest.fn();
let clickSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  (URL as unknown as Record<string, unknown>).createObjectURL = mockCreateObjectURL;
  (URL as unknown as Record<string, unknown>).revokeObjectURL = mockRevokeObjectURL;
  clickSpy = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  jest.useFakeTimers();
});

afterEach(() => {
  clickSpy.mockRestore();
  jest.useRealTimers();
});

describe('运行环境判断', () => {
  test('isDesktopApp 恒为 false (扩展版没有桌面外壳)', () => {
    expect(isDesktopApp()).toBe(false);
  });

  test('非扩展环境下 isExtensionPage 为 false', () => {
    expect(isExtensionPage()).toBe(false);
  });
});

describe('openUrl', () => {
  test('<a download> 回退: 打开新窗口链接', async () => {
    const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await openUrl('https://example.com');
    expect(click).toHaveBeenCalledTimes(1);
    click.mockRestore();
  });
});

describe('保存文件', () => {
  test('saveTextFile: 触发 <a download>', async () => {
    await expect(saveTextFile('data.jsonl', '1\n2')).resolves.toBe(true);
    expect(mockCreateObjectURL).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  test('saveBytesFile: 触发下载', async () => {
    await expect(saveBytesFile('a.bin', new Uint8Array([1, 2, 3]))).resolves.toBe(true);
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  test('savePngFile: data URL 转换为 Blob 后下载', async () => {
    await expect(savePngFile('q.png', 'data:image/png;base64,AAAA')).resolves.toBe(true);
    const blob = (mockCreateObjectURL.mock.calls as unknown as [Blob][])[0][0];
    expect(blob.type).toBe('image/png');
    expect(blob.size).toBe(3);
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  test('savePngBatch: 逐个下载并返回数量', async () => {
    // 逐个下载之间有 250ms 间隔 (避免被浏览器判定为批量弹窗), 用真实定时器
    jest.useRealTimers();
    await expect(savePngBatch(['a.png', 'b.png'], [ 'data:image/png;base64,AA', 'data:image/png;base64,AA' ]))
      .resolves.toBe(2);
    expect(clickSpy).toHaveBeenCalledTimes(2);
  });

  test('saveBytesBatch: 拍平目录 + 重名加序号', async () => {
    jest.useRealTimers();
    await expect(saveBytesBatch([
      { name: 'docs/a.txt', bytes: new Uint8Array([1]) },
      { name: 'other/a.txt', bytes: new Uint8Array([2]) },
    ])).resolves.toBe(2);
    const names = clickSpy.mock.instances.map((el) => (el as unknown as HTMLAnchorElement).download);
    expect(names).toEqual(['a.txt', 'a (2).txt']);
  });

  test('空列表不触发下载', async () => {
    await expect(savePngBatch([], [])).resolves.toBe(0);
    await expect(saveBytesBatch([])).resolves.toBe(0);
    expect(clickSpy).not.toHaveBeenCalled();
  });
});

describe('多标签页同步', () => {
  test('同一页面内的 emit 不会被自己的 listen 收到 (无回环)', async () => {
    const handler = jest.fn();
    const off = await listenThemeMode(handler);
    await emitThemeMode('dark');
    expect(handler).not.toHaveBeenCalled();
    off();
  });

  test('listenLocale / emitLocale 返回取消订阅函数', async () => {
    const handler = jest.fn();
    const off = await listenLocale(handler);
    expect(typeof off).toBe('function');
    off();
  });
});
