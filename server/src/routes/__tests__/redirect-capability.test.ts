import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { resolveRedirectTarget } from '../records';
import { providerDefinitions } from '../../lib/dns/providers/registry';

/**
 * redirect 能力位（2.3.1）：
 * - 提供商必须在 capabilities.redirect 显式声明；
 * - 未声明（false/缺省）时，API 传入的 redirect 一律忽略；
 * - 已声明时校验 URL，交给适配器 setRecordRedirect；适配器未实现则 501（不静默）。
 */
describe('resolveRedirectTarget', () => {
  it('未声明能力的提供商：传入 redirect 直接忽略', () => {
    expect(resolveRedirectTarget(false, 'https://example.com')).toEqual({ ignored: true });
  });

  it('未传 redirect 时不受能力位影响', () => {
    expect(resolveRedirectTarget(false, undefined)).toEqual({ ignored: false });
    expect(resolveRedirectTarget(true, '')).toEqual({ ignored: false });
  });

  it('已声明：合法 http/https 放行', () => {
    expect(resolveRedirectTarget(true, 'https://example.com/a')).toEqual({ ignored: false, target: 'https://example.com/a' });
    expect(resolveRedirectTarget(true, 'http://example.com')).toEqual({ ignored: false, target: 'http://example.com' });
  });

  it('已声明但非法：报错（协议/格式/长度）', () => {
    expect(resolveRedirectTarget(true, 'ftp://example.com').error).toMatch(/http/);
    expect(resolveRedirectTarget(true, 'not a url').error).toMatch(/合法 URL/);
    expect(resolveRedirectTarget(true, 'https://example.com/' + 'a'.repeat(1100)).error).toMatch(/1024/);
  });
});

describe('redirect 能力位声明（契约）', () => {
  const providers = providerDefinitions;

  it('每个提供商显式声明 capabilities.redirect 为布尔值', () => {
    const missing = providers.filter((item) => typeof item.capabilities.redirect !== 'boolean').map((item) => item.type);
    expect(missing).toEqual([]);
  });

  it('声明 redirect=true 的提供商必须在适配器实现 setRecordRedirect', () => {
    const dir = path.resolve(__dirname, '../../lib/dns/providers');
    const broken = providers
      .filter((item) => item.capabilities.redirect === true)
      .filter((item) => {
        const file = path.join(dir, item.type, 'adapter.ts');
        return !fs.existsSync(file) || !fs.readFileSync(file, 'utf8').includes('setRecordRedirect');
      })
      .map((item) => item.type);
    expect(broken).toEqual([]);
  });
});
