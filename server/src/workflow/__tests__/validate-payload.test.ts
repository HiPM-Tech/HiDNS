import { describe, it, expect } from 'vitest';
import { validatePayload } from '../validate-payload';

const base = {
  name: 'wf',
  triggerType: 'record.changed',
  triggerConfig: { recordTypes: ['A'] },
  actions: [{ kind: 'call', action: 'dns.record.list', args: { domain: { kind: 'literal', value: 'a.com' } } }],
};

describe('triggerConfig.recordTypes 校验（设计 §4.0.5）', () => {
  it('合法取值通过', () => {
    for (const types of [['A'], ['AAAA'], ['A', 'AAAA']]) {
      expect(validatePayload({ ...base, triggerConfig: { recordTypes: types } } as never)).toEqual([]);
    }
  });

  it('空数组被拒绝——引擎会判成「永不匹配」，属于静默失效', () => {
    const problems = validatePayload({ ...base, triggerConfig: { recordTypes: [] } } as never);
    expect(problems.join()).toContain('不能为空');
  });

  it('非 A/AAAA 类型被拒绝', () => {
    expect(validatePayload({ ...base, triggerConfig: { recordTypes: ['CNAME'] } } as never).join()).toContain(
      '仅允许 A / AAAA',
    );
  });

  it('非数组被拒绝', () => {
    expect(validatePayload({ ...base, triggerConfig: { recordTypes: 'A' } } as never).join()).toContain('必须是数组');
  });
});

describe('fields 与 recordTypes 的空数组语义不同', () => {
  it('domain.changed 的空 fields 表示「任意」，不报错', () => {
    const problems = validatePayload({
      ...base,
      triggerType: 'domain.changed',
      triggerConfig: { fields: [] },
    } as never);
    expect(problems.join()).not.toContain('不能为空');
  });
});
