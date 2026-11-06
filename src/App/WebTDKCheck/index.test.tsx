import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { message } from 'antd';
import WebTDKCheck from './index';
import { fetchPageHtml } from './fetch';

jest.mock('./fetch', () => ({
  fetchPageHtml: jest.fn(),
}));
const mockFetch = fetchPageHtml as jest.Mock;

const HTML = `<html><head><title>MagicTools 工具箱</title>
<meta name="keywords" content="工具, 在线">
<meta name="description" content="一站式在线工具集合">
</head><body></body></html>`;

const messageText = () => document.querySelector('.ant-message')?.textContent ?? '';
const urlBox = () => screen.getByPlaceholderText('输入网址, 如 https://example.com');
const checkBtn = () => screen.getByRole('button', { name: /检\s*测/ });

beforeEach(() => {
  jest.clearAllMocks();
  mockFetch.mockResolvedValue({ html: HTML, finalUrl: 'https://example.com/' });
  message.destroy();
});

describe('WebTDKCheck 页面 - 桌面版', () => {
  test('检测后展示 TDK 字段', async () => {
    render(<WebTDKCheck />);
    fireEvent.change(urlBox(), { target: { value: 'https://example.com' } });
    fireEvent.click(checkBtn());
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith('https://example.com'));
    expect(await screen.findByText('MagicTools 工具箱')).toBeInTheDocument();
    expect(screen.getByText('检测完成: https://example.com/')).toBeInTheDocument();
    expect(screen.getByText('工具, 在线')).toBeInTheDocument();
    expect(screen.getByText('一站式在线工具集合')).toBeInTheDocument();
  });

  test('空网址时只提示不抓取', async () => {
    render(<WebTDKCheck />);
    fireEvent.click(checkBtn());
    await waitFor(() => expect(messageText()).toContain('请先输入要检测的网址'));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('抓取失败展示错误信息', async () => {
    mockFetch.mockRejectedValue(new Error('网址必须以 http:// 或 https:// 开头'));
    render(<WebTDKCheck />);
    fireEvent.change(urlBox(), { target: { value: 'example.com' } });
    fireEvent.click(checkBtn());
    await waitFor(() => expect(messageText()).toContain('检测失败: 网址必须以 http:// 或 https:// 开头'));
  });
});

describe('WebTDKCheck 页面 - Chrome 扩展版', () => {
  test('不再有桌面版限制: 检测按钮直接可用', () => {
    const { container } = render(<WebTDKCheck />);
    expect(container.textContent).not.toContain('该功能仅在桌面应用中可用');
    expect(screen.queryByRole('button', { name: /下载桌面版/ })).toBeNull();
    expect(checkBtn()).toBeEnabled();
  });
});
