import { describe, expect, it, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DnsProviderService } from '../../../service/dns-provider-service';
import { proxyCapabilityError } from '../../../routes/records';

const PROVIDERS_DIR = path.resolve(__dirname, '..', 'providers');

/** 遍历适配器源码（排除 _example 与 internal 等非 provider 文件） */
function adapterSources(): Array<{ file: string; source: string }> {
  const out: Array<{ file: string; source: string }> = [];
  for (const entry of fs.readdirSync(PROVIDERS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
    const file = path.join(PROVIDERS_DIR, entry.name, 'adapter.ts');
    if (!fs.existsSync(file)) continue;
    out.push({ file, source: fs.readFileSync(file, 'utf8') });
  }
  return out;
}

describe('RecordId 契约（源码守卫）', () => {
  it('适配器不得用字面量 success 充当记录 ID', () => {
    const offenders = adapterSources()
      .filter(({ source }) => /return\s+['"]success['"]/.test(source))
      .map(({ file }) => path.relative(PROVIDERS_DIR, file));
    expect(offenders).toEqual([]);
  });

  it('getRecordLines 的 catch 分支不得编造线路列表', () => {
    const offenders: string[] = [];
    for (const { file, source } of adapterSources()) {
      const lineFn = source.match(/async getRecordLines\(\)[\s\S]*?\n {2}\}/);
      if (!lineFn) continue;
      // 只看 catch 块：失败时直接 throw / 设置 error，不允许返回固定数组
      const catchBlocks = lineFn[0].match(/catch[\s\S]*?\n {4}\}/g) ?? [];
      if (catchBlocks.some((block) => /return\s+\[/.test(block))) offenders.push(path.relative(PROVIDERS_DIR, file));
    }
    expect(offenders).toEqual([]);
  });
});

describe('能力位 proxiable 执行', () => {
  it('不支持代理的提供商拒绝 proxied=true', () => {
    expect(proxyCapabilityError('aliyun', true)).toMatch(/不支持代理/);
  });

  it('支持代理的提供商放行，未传 proxied 不受影响', () => {
    expect(proxyCapabilityError('cloudflare', true)).toBeNull();
    expect(proxyCapabilityError('cloudflare', undefined)).toBeNull();
    expect(proxyCapabilityError('aliyun', false)).toBeNull();
  });
});

describe('读失败 fail-closed', () => {
  const service = DnsProviderService as unknown as { getAdapter: (id: number) => Promise<unknown> };
  const original = service.getAdapter;
  afterEach(() => { service.getAdapter = original; });

  it('适配器返回空列表且带错误时抛错，而不是伪装成 0 条', async () => {
    service.getAdapter = vi.fn(async () => ({
      clearError: vi.fn(),
      getDomainRecords: vi.fn(async () => ({ list: [], total: 0 })),
      getError: vi.fn(() => 'upstream 500'),
    }));
    await expect(DnsProviderService.getRecords(1)).rejects.toThrow(/读取记录失败/);
  });

  it('真的 0 条（无错误）照常返回', async () => {
    service.getAdapter = vi.fn(async () => ({
      clearError: vi.fn(),
      getDomainRecords: vi.fn(async () => ({ list: [], total: 0 })),
      getError: vi.fn(() => ''),
    }));
    await expect(DnsProviderService.getRecords(1)).resolves.toEqual({ list: [], total: 0 });
  });
});
