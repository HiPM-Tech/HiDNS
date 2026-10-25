import { describe, expect, it } from 'vitest';
import { resolveDomainListShape } from '../domains';

/**
 * 域名列表的两套响应契约。
 *
 * - 前端（浏览器会话）永远走 ui：分页对象 + Unicode 名称 + can_write；
 * - 外部适配器（ddns-go / certd）走 api：裸数组 + Punycode 名称 + display_name。
 *
 * 这两条不能混：混了要么前端拿到数组崩掉，要么外部工具解析不了分页对象。
 */
describe('域名列表响应形态', () => {
  it('会话默认 ui', () => {
    expect(resolveDomainListShape({ isTokenAuth: false })).toBe('ui');
  });

  it('Token 认证默认 api（兼容 ddns-go 等工具）', () => {
    expect(resolveDomainListShape({ isTokenAuth: true })).toBe('api');
  });

  it('显式 format=array 优先于认证方式', () => {
    expect(resolveDomainListShape({ format: 'array', isTokenAuth: false })).toBe('api');
    expect(resolveDomainListShape({ format: 'array', isTokenAuth: true })).toBe('api');
  });

  it('其它 format 值不改变会话形态', () => {
    expect(resolveDomainListShape({ format: 'json', isTokenAuth: false })).toBe('ui');
    expect(resolveDomainListShape({ format: 'array ', isTokenAuth: false })).toBe('ui');
  });
});
