import { describe, expect, it } from 'vitest';
import { sanitizeCheckPath } from '../serviceMonitor';

/** failover 的 http 探测路径（第六轮 6-1：userinfo 注入可改写 host） */
describe('sanitizeCheckPath', () => {
  it('正常路径原样保留', () => {
    expect(sanitizeCheckPath('/')).toBe('/');
    expect(sanitizeCheckPath('/health')).toBe('/health');
    expect(sanitizeCheckPath('/a/b?c=1')).toBe('/a/b?c=1');
  });

  it('userinfo 注入与非法字符回落为 /', () => {
    expect(sanitizeCheckPath('@127.0.0.1:3999/x')).toBe('/');
    expect(sanitizeCheckPath('/ok@127.0.0.1:3999')).toBe('/');
    expect(sanitizeCheckPath('/a\\b')).toBe('/');
    expect(sanitizeCheckPath('/a b')).toBe('/');
    expect(sanitizeCheckPath('http://evil/x')).toBe('/');
    expect(sanitizeCheckPath(undefined)).toBe('/');
  });
});
