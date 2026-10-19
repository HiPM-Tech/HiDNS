import { describe, it, expect } from 'vitest';
import { buildStaticMeta, isStaticMetaSource } from '../meta';

describe('候选值（meta）', () => {
  it('actions 覆盖全部已注册动作', () => {
    const items = buildStaticMeta('actions');
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((item) => item.value === 'dns.record.update')).toBe(true);
    expect(items.some((item) => String(item.value).startsWith('ext.tencenteo.originGroup.'))).toBe(true);
  });

  it('触发类型只有设计允许的四种', () => {
    const values = buildStaticMeta('triggerTypes').map((item) => item.value);
    expect(values).toEqual(['record.changed', 'domain.changed', 'ns.changed', 'whois.expiring']);
  });

  it('记录类型只给 A / AAAA（§4.0.5）', () => {
    expect(buildStaticMeta('recordTypes').map((item) => item.value)).toEqual(['A', 'AAAA']);
  });

  it('域名字段与 NS 状态白名单固定', () => {
    expect(buildStaticMeta('domainFields').map((item) => item.value)).toEqual(['remark', 'is_hidden', 'enabled']);
    expect(buildStaticMeta('nsStatuses').map((item) => item.value)).toEqual(['ok', 'mismatch', 'missing', 'poisoned']);
  });

  it('静态源判定与 domains 区分', () => {
    expect(isStaticMetaSource('actions')).toBe(true);
    expect(isStaticMetaSource('domains')).toBe(false);
    expect(isStaticMetaSource('unknown')).toBe(false);
  });
});