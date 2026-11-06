// DNS 查询网络层: Chrome 扩展 / 浏览器环境使用 DoH (DNS over HTTPS) 公共解析服务
//
// 上游桌面版把解析交给 Rust 命令 (可指定任意 UDP/TCP DNS 服务器); 浏览器沙箱内不能发
// UDP, 因此这里改用标准化的 DoH JSON API (Google / Cloudflare / 阿里 / DNSPod 均支持),
// 输出结构与桌面版完全一致 (DnsQueryResult), UI 层无需区分运行环境。

import { ALL_RECORD_TYPES, RECORD_TYPES, type DnsQueryResult, type DnsTypeResult, type DnsRecord } from './lib';

/** 「全部类型」查询时单个类型失败的统一前缀 */
export const QUERY_FAILED_ERROR = '查询失败';

type DohEndpoint = {
  /** DoH JSON 接口地址 (不带查询串) */
  url: string;
  /** 展示用的服务器名 (结果里显示实际使用的解析服务) */
  name: string;
};

/**
 * 下拉框里的「服务器」-> DoH 服务
 * 浏览器无法直连 UDP 53, 因此这里统一映射到各家等价的 DoH 端点;
 * 未知的服务器值 (含历史设置) 一律回退到 Google 公共 DNS。
 */
const DOH_ENDPOINTS: Record<string, DohEndpoint> = {
  system: { url: 'https://dns.google/resolve', name: 'dns.google (DoH)' },
  '223.5.5.5': { url: 'https://dns.alidns.com/resolve', name: 'dns.alidns.com (DoH)' },
  '119.29.29.29': { url: 'https://doh.pub/dns-query', name: 'doh.pub (DoH)' },
  '8.8.8.8': { url: 'https://dns.google/resolve', name: 'dns.google (DoH)' },
  '1.1.1.1': { url: 'https://cloudflare-dns.com/dns-query', name: 'cloudflare-dns.com (DoH)' },
};

/** 记录类型编号 -> 名称 (DoH JSON 返回数字类型) */
const TYPE_NAMES: Record<number, string> = {
  1: 'A', 2: 'NS', 5: 'CNAME', 6: 'SOA', 12: 'PTR', 13: 'HINFO', 15: 'MX', 16: 'TXT',
  28: 'AAAA', 33: 'SRV', 35: 'NAPTR', 39: 'DNAME', 43: 'DS', 44: 'SSHFP', 46: 'RRSIG',
  48: 'DNSKEY', 52: 'TLSA', 64: 'SVCB', 65: 'HTTPS', 257: 'CAA',
};

/** DoH JSON 响应 (RFC 8484 的 JSON 版本, Google/Cloudflare 通用) */
type DohAnswer = {
  name: string;
  type: number;
  TTL: number;
  data: string;
};

type DohResponse = {
  Status: number;
  Answer?: DohAnswer[];
  Comment?: string;
};

/** 当前时间 (毫秒); 兼容 jsdom / 旧运行环境 */
const now = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();

/** 判断是否「全部类型」查询 */
export function isAllTypes(recordType: string): boolean {
  return recordType === ALL_RECORD_TYPES;
}

/** 按所选服务器取 DoH 端点 (未知取值一律用 Google 公共 DNS) */
export function endpointFor(server: string): DohEndpoint {
  const key = (server ?? '').trim();
  if (key === '' || key === 'system') return DOH_ENDPOINTS.system;
  return DOH_ENDPOINTS[key] ?? DOH_ENDPOINTS.system;
}

/**
 * 清洗 DoH 返回的记录值:
 * - 去掉 DNS 文本格式里主机名的结尾点 (example.com. -> example.com)
 * - TXT 记录去掉包裹的引号并还原转义
 */
function cleanValue(recordType: string, data: string): string {
  const raw = String(data ?? '').trim();
  if (recordType === 'TXT') {
    return raw.replace(/^"((?:[^"\\]|\\.)*)"$/, (_m, inner: string) => inner.replace(/\\(["\\])/g, '$1'));
  }
  if (recordType === 'MX' || recordType === 'SRV' || recordType === 'CAA') {
    // 形如 "10 mail.example.com." / "0 issue \"ca.example\"" — 只去掉末尾的点
    return raw.replace(/\.$/, '');
  }
  return raw.replace(/\.$/, '');
}

/**
 * 查询单个记录类型
 * @param name 域名 (已归一化, 无需带结尾点)
 * @param recordType A / AAAA / CNAME / MX / TXT / SRV / NS
 * @param server DNS 服务器 (下拉框取值, 映射到对应 DoH 端点)
 */
export async function queryDns(
  name: string,
  recordType: string,
  server: string,
): Promise<DnsQueryResult> {
  const endpoint = endpointFor(server);
  const url = `${endpoint.url}?name=${encodeURIComponent(name)}&type=${encodeURIComponent(recordType)}`;
  const started = now();

  let resp: Response;
  try {
    resp = await fetch(url, { headers: { accept: 'application/dns-json' } });
  } catch (err) {
    throw new Error(`DoH 请求失败: ${(err as Error)?.message ?? String(err)}`);
  }
  const elapsedMs = Math.round(now() - started);
  if (!resp.ok) throw new Error(`DoH 服务返回 HTTP ${resp.status}`);

  const data = (await resp.json()) as DohResponse;
  const answers = Array.isArray(data.Answer) ? data.Answer : [];
  // 单类型查询只保留该类型与 CNAME (别名链, 便于看清解析路径)
  const want = recordType.toUpperCase();
  const records: DnsRecord[] = answers
    .map((item): DnsRecord | null => {
      const type = TYPE_NAMES[item.type] ?? String(item.type);
      if (type !== want && type !== 'CNAME') return null;
      return {
        name: String(item.name ?? '').replace(/\.$/, ''),
        recordType: type,
        ttl: Number(item.TTL ?? 0),
        value: cleanValue(type, item.data),
      };
    })
    .filter((item): item is DnsRecord => item !== null);

  // RFC 1035 RCODE: 0=NOERROR, 2=SERVFAIL, 3=NXDOMAIN
  let status = 'ok';
  if (data.Status === 3) status = 'nxdomain';
  else if (data.Status !== 0) status = 'error';
  else if (records.length === 0) status = 'nodata';

  return {
    status,
    records,
    elapsedMs,
    server: endpoint.name,
    message: data.Status === 0 || data.Status === 3 ? null : (data.Comment ?? `DoH 状态码 ${data.Status}`),
  };
}

/**
 * 查询全部记录类型 (并行)
 * 单个类型失败 (超时等) 不阻断其它类型, 该类型以 status='error' 的结果返回
 * @param name 域名 (已归一化)
 * @param server DNS 服务器 (映射到 DoH 端点)
 */
export async function queryAllDns(name: string, server: string): Promise<DnsTypeResult[]> {
  const settled = await Promise.allSettled(RECORD_TYPES.map((t) => queryDns(name, t, server)));
  return settled.map((item, i) => {
    const recordType = RECORD_TYPES[i] as string;
    if (item.status === 'fulfilled') return { recordType, result: item.value };
    const err = item.reason as Error;
    return {
      recordType,
      result: {
        status: 'error',
        records: [],
        elapsedMs: 0,
        server: endpointFor(server).name,
        message: err?.message ?? String(item.reason),
      },
    };
  });
}
