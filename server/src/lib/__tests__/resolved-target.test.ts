import { describe, it, expect } from 'vitest';
import { attachResolvedTarget, takeResolvedTarget } from '../resolved-target';

describe('解析结果侧通道（设计 §904 §4）', () => {
  it('旁挂后能取回', () => {
    const value = attachResolvedTarget({ ok: true }, { contract: 'v2', accountId: 3, scopeId: 'zone-1' });
    expect(takeResolvedTarget(value)).toMatchObject({ contract: 'v2', accountId: 3, scopeId: 'zone-1' });
  });

  it('不可枚举：不会被序列化进 DSL 可见返回值', () => {
    const value = attachResolvedTarget({ ok: true }, { contract: 'v2', accountId: 3 });
    // 返回值可被 var.* 引用，属对外契约，内部审计字段不得出现
    expect(JSON.stringify(value)).toBe('{"ok":true}');
    expect(Object.keys(value)).toEqual(['ok']);
  });

  it('取走后即删除，不会残留到下一次读取', () => {
    const value = attachResolvedTarget({ ok: true }, { contract: 'v2', accountId: 3 });
    takeResolvedTarget(value);
    expect(takeResolvedTarget(value)).toBeUndefined();
  });

  it('非对象返回值原样返回，不抛错', () => {
    expect(attachResolvedTarget('ok', { contract: 'v1-legacy' })).toBe('ok');
    expect(takeResolvedTarget(null)).toBeUndefined();
    expect(takeResolvedTarget('ok')).toBeUndefined();
  });
});
