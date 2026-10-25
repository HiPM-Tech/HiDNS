import { describe, expect, it, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DnsProviderService } from '../../../service/dns-provider-service';
import { proxyCapabilityError } from '../../../routes/records';
import { resolveProviderLine, requireNumericRecordId } from '../providers/common';
import { providerDefinitions } from '../providers/registry';

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

describe('线路来源声明（2.3.1 线路模型）', () => {
  it('每个提供商都必须声明 lineSource 与 defaultLine', () => {
    const missing = providerDefinitions
      .filter((definition) => !definition.lineSource || definition.defaultLine === undefined)
      .map((definition) => definition.type);
    expect(missing).toEqual([]);
    expect(providerDefinitions.every((definition) => ['builtin', 'dynamic'].includes(definition.lineSource))).toBe(true);
  });

  it('内置线路不得请求上游；动态线路不得内置兜底', () => {
    const violations: string[] = [];
    for (const definition of providerDefinitions) {
      const file = path.join(PROVIDERS_DIR, definition.type, 'adapter.ts');
      if (!fs.existsSync(file)) continue;
      const source = fs.readFileSync(file, 'utf8');
      const start = source.indexOf('async getRecordLines');
      const end = source.indexOf('\n  async ', start + 20);
      const rawBody = source.slice(start, end < 0 ? source.length : end);
      // 注释里的示例代码不算实现（gcore 的注释掉的分支）
      const body = rawBody.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
      const hitsNetwork = /\.(rpcCall|request|call)\b|fetchWithFallback/.test(body);
      const hasFallback = /getDefaultLines/.test(body) || /catch[\s\S]*?return\s+\[/.test(body);
      if (definition.lineSource === 'builtin' && hitsNetwork) violations.push(definition.type + ':builtin-but-network');
      if (definition.lineSource === 'dynamic' && !hitsNetwork) violations.push(definition.type + ':dynamic-but-static');
      if (definition.lineSource === 'dynamic' && hasFallback) violations.push(definition.type + ':dynamic-fallback');
    }
    expect(violations).toEqual([]);
  });

  it('每个适配器内部声明 DEFAULT_LINE（归一中间层使用）', () => {
    const missing = providerDefinitions
      .filter((definition) => {
        const file = path.join(PROVIDERS_DIR, definition.type, 'adapter.ts');
        if (!fs.existsSync(file)) return false;
        const source = fs.readFileSync(file, 'utf8');
        return !source.includes(`'${definition.defaultLine}'`);
      })
      .map((definition) => definition.type);
    expect(missing).toEqual([]);
  });
});

describe('normalizeLine（线路归一中间层）', () => {
  it('未指定或空串落到 defaultLine', () => {
    expect(resolveProviderLine(undefined, 'default_view')).toBe('default_view');
    expect(resolveProviderLine('', 'DEFAULT')).toBe('DEFAULT');
  });

  it('哨兵 0：默认是 0 的提供商保留，否则回落 defaultLine', () => {
    expect(resolveProviderLine('0', '0')).toBe('0');
    expect(resolveProviderLine('0', 'default_view')).toBe('default_view');
  });

  it('真实线路原样保留', () => {
    expect(resolveProviderLine('Dianxin', 'default_view')).toBe('Dianxin');
  });
});

describe('错误通道与记录 ID（复审整改）', () => {
  it('getDomainRecords 的空结果折叠必须写入 this.error（caihong 合法空 zone 除外）', () => {
    const offenders: string[] = [];
    for (const { file, source } of adapterSources()) {
      const start = source.indexOf('getDomainRecords');
      if (start < 0) continue;
      const end = source.indexOf('\n  async ', start + 10);
      const body = source.slice(start, end < 0 ? source.length : end);
      const re = /return \{ total: 0, list: \[\] \};/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(body))) {
        const around = body.slice(Math.max(0, match.index - 260), match.index);
        if (!around.includes('this.error') && !around.includes('合法的空 zone')) {
          offenders.push(path.relative(PROVIDERS_DIR, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('requireNumericRecordId 拒绝 0/空/非数字，避免落到 0 号记录', () => {
    expect(requireNumericRecordId('123')).toBe(123);
    expect(() => requireNumericRecordId('0')).toThrow(/非法记录 ID/);
    expect(() => requireNumericRecordId('')).toThrow(/非法记录 ID/);
    expect(() => requireNumericRecordId('abc')).toThrow(/非法记录 ID/);
  });
});
