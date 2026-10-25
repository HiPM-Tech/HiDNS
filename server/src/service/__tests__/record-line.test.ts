import { describe, expect, it } from 'vitest';
import { normalizeLineId, resolveLineInput, PROXY_LINE_PROVIDERS } from '../record-line';

describe('normalizeLineId', () => {
  it("'0'、空串、纯空白都视为未指定", () => {
    expect(normalizeLineId('0')).toBeUndefined();
    expect(normalizeLineId('')).toBeUndefined();
    expect(normalizeLineId('   ')).toBeUndefined();
    expect(normalizeLineId(undefined)).toBeUndefined();
  });

  it('真实线路 ID 原样保留（含华为云 default_view）', () => {
    expect(normalizeLineId('default_view')).toBe('default_view');
    expect(normalizeLineId(' Dianxin ')).toBe('Dianxin');
  });
});

describe('resolveLineInput', () => {
  it('代理型提供商：proxied 决定 0/1', () => {
    expect(PROXY_LINE_PROVIDERS.has('cloudflare')).toBe(true);
    expect(resolveLineInput('cloudflare', { proxied: true })).toEqual({ line: '1', proxied: true });
    expect(resolveLineInput('aliyunesa', { proxied: false })).toEqual({ line: '0', proxied: false });
  });

  it('代理型提供商：兼容旧 cloudflare.proxied 与 line:0/1', () => {
    expect(resolveLineInput('cloudflare', { legacyProxied: true })).toEqual({ line: '1', proxied: true });
    expect(resolveLineInput('cloudflare', { line: '1' })).toEqual({ line: '1', proxied: true });
    expect(resolveLineInput('cloudflare', { line: '0' })).toEqual({ line: '0', proxied: false });
  });

  it('代理型提供商：什么都没传时 = 默认线路 + 不代理', () => {
    expect(resolveLineInput('cloudflare', {})).toEqual({ line: undefined, proxied: false });
    expect(resolveLineInput('aliyunesa', { line: '0' })).toEqual({ line: '0', proxied: false });
  });

  it('非代理型提供商：proxied 一律忽略，线路按 ID 归一', () => {
    expect(resolveLineInput('aliyun', { proxied: true, line: '0' })).toEqual({ line: undefined });
    expect(resolveLineInput('huawei', { line: 'default_view' })).toEqual({ line: 'default_view' });
    expect(resolveLineInput('aliyun', { line: 'Dianxin' })).toEqual({ line: 'Dianxin' });
  });
});
