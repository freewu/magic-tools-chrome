// DNS 查询网络层 (DoH): 断言请求构造与 DoH JSON 解析

import { endpointFor, isAllTypes, queryAllDns, queryDns } from './net';
import { ALL_RECORD_TYPES, RECORD_TYPES } from './lib';

const mockFetch = jest.fn();
const jsonResponse = (body: unknown, ok = true) => ({
  ok,
  status: ok ? 200 : 502,
  json: async () => body,
});

beforeEach(() => {
  jest.clearAllMocks();
  (global as unknown as { fetch: unknown }).fetch = (...args: unknown[]) => mockFetch(...args);
});

describe('DnsQuery net - isAllTypes', () => {
  test('只对 ALL 成立', () => {
    expect(isAllTypes(ALL_RECORD_TYPES)).toBe(true);
    expect(isAllTypes('A')).toBe(false);
    expect(isAllTypes('')).toBe(false);
  });
});

describe('DnsQuery net - endpointFor', () => {
  test('system / 空值走默认 DoH', () => {
    expect(endpointFor('system').url).toBe('https://dns.google/resolve');
    expect(endpointFor('   ').url).toBe('https://dns.google/resolve');
  });

  test('按所选服务器映射到对应 DoH 端点', () => {
    expect(endpointFor('1.1.1.1').url).toBe('https://cloudflare-dns.com/dns-query');
    expect(endpointFor('223.5.5.5').url).toBe('https://dns.alidns.com/resolve');
    expect(endpointFor('119.29.29.29').url).toBe('https://doh.pub/dns-query');
  });

  test('未知服务器回退 Google DoH', () => {
    expect(endpointFor('9.9.9.9').url).toBe('https://dns.google/resolve');
  });
});

describe('DnsQuery net - queryDns', () => {
  test('请求地址带 name / type 参数, 并声明 JSON 期望', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      Status: 0,
      Answer: [{ name: 'example.com.', type: 1, TTL: 300, data: '93.184.216.34' }],
    }));
    await queryDns('example.com', 'A', '1.1.1.1');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://cloudflare-dns.com/dns-query?name=example.com&type=A');
    expect(init.headers.accept).toBe('application/dns-json');
  });

  test('解析记录: 去掉结尾点, 保留 CNAME 别名链', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      Status: 0,
      Answer: [
        { name: 'www.example.com.', type: 5, TTL: 120, data: 'example.com.' },
        { name: 'example.com.', type: 1, TTL: 300, data: '93.184.216.34' },
        { name: 'example.com.', type: 28, TTL: 300, data: '2606:2800::1' },
      ],
    }));
    const out = await queryDns('www.example.com', 'A', 'system');
    expect(out.status).toBe('ok');
    expect(out.server).toContain('dns.google');
    expect(out.records).toEqual([
      { name: 'www.example.com', recordType: 'CNAME', ttl: 120, value: 'example.com' },
      { name: 'example.com', recordType: 'A', ttl: 300, value: '93.184.216.34' },
    ]);
  });

  test('TXT 记录去掉包裹引号', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      Status: 0,
      Answer: [{ name: 'example.com.', type: 16, TTL: 60, data: '"v=spf1 -all"' }],
    }));
    const out = await queryDns('example.com', 'TXT', 'system');
    expect(out.records[0].value).toBe('v=spf1 -all');
  });

  test('Status=3 视为域名不存在', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ Status: 3 }));
    const out = await queryDns('nope.invalid', 'A', 'system');
    expect(out.status).toBe('nxdomain');
    expect(out.records).toEqual([]);
  });

  test('NOERROR 但无记录 -> nodata', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ Status: 0 }));
    await expect(queryDns('example.com', 'SRV', 'system')).resolves.toMatchObject({ status: 'nodata' });
  });

  test('SERVFAIL 带上错误信息', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ Status: 2, Comment: 'upstream failure' }));
    const out = await queryDns('example.com', 'A', 'system');
    expect(out.status).toBe('error');
    expect(out.message).toBe('upstream failure');
  });

  test('HTTP 非 2xx 抛错', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, false));
    await expect(queryDns('example.com', 'A', 'system')).rejects.toThrow('DoH 服务返回 HTTP 502');
  });

  test('网络异常抛错', async () => {
    mockFetch.mockRejectedValue(new Error('network down'));
    await expect(queryDns('example.com', 'A', 'system')).rejects.toThrow('DoH 请求失败: network down');
  });
});

describe('DnsQuery net - queryAllDns', () => {
  test('并发查询全部 7 种记录类型', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      Status: 0,
      Answer: [{ name: 'example.com.', type: 1, TTL: 60, data: '1.2.3.4' }],
    }));
    const out = await queryAllDns('example.com', '1.1.1.1');
    expect(out).toHaveLength(RECORD_TYPES.length);
    expect(out.map((item) => item.recordType)).toEqual([ ...RECORD_TYPES ]);
    expect(mockFetch).toHaveBeenCalledTimes(RECORD_TYPES.length);
  });

  test('单个类型失败不影响其它类型', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (String(url).includes('type=MX')) return Promise.reject(new Error('timeout'));
      return Promise.resolve(jsonResponse({
        Status: 0,
        Answer: [{ name: 'example.com.', type: 1, TTL: 60, data: '1.2.3.4' }],
      }));
    });
    const out = await queryAllDns('example.com', 'system');
    const mx = out.find((item) => item.recordType === 'MX');
    expect(mx?.result.status).toBe('error');
    expect(mx?.result.message).toContain('timeout');
    expect(out.find((item) => item.recordType === 'A')?.result.status).toBe('ok');
  });
});
