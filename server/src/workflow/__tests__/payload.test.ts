import { describe, it, expect } from 'vitest';
import { validatePayload } from '../validate-payload';

function base(overrides: Record<string, unknown> = {}) {
  return {
    name: 'wf',
    triggerType: 'record.changed',
    triggerConfig: { recordTypes: ['A'] },
    actions: [{ kind: 'call', action: 'dns.record.update', args: { domain: { kind: 'literal', value: 'a.com' } } }],
    ...overrides,
  };
}

describe('保存期校验', () => {
  it('合法负载通过', () => {
    expect(validatePayload(base())).toEqual([]);
  });

  it('拒绝非 A/AAAA 触发类型', () => {
    expect(validatePayload(base({ triggerConfig: { recordTypes: ['CNAME'] } })).join()).toContain(
      '仅允许 A / AAAA',
    );
  });

  it('拒绝未知触发器类型', () => {
    expect(validatePayload(base({ triggerType: 'domain.changed' })).join()).toContain('record.changed');
  });

  it('拒绝空动作列表', () => {
    expect(validatePayload(base({ actions: [] })).join()).toContain('至少需要一个动作节点');
  });

  it('拒绝未注册动作', () => {
    expect(
      validatePayload(base({ actions: [{ kind: 'call', action: 'dns.record.drop', args: {} }] })).join(),
    ).toContain('UNKNOWN_ACTION');
  });

  it('拒绝动态动作名', () => {
    expect(
      validatePayload(
        base({ actions: [{ kind: 'call', action: { kind: 'ref', path: 'vars.x' }, args: {} }] }),
      ).join(),
    ).toContain('DYNAMIC_ACTION_NAME');
  });

  it('拒绝白名单外参数', () => {
    expect(
      validatePayload(
        base({ actions: [{ kind: 'call', action: 'dns.record.update', args: { shell: { kind: 'literal', value: 'x' } } }] }),
      ).join(),
    ).toContain('UNKNOWN_ARG');
  });

  it('条件节点同样受校验', () => {
    expect(
      validatePayload(base({ condition: { kind: 'eval', code: '1' } })).join(),
    ).toContain('UNKNOWN_NODE_KIND');
  });
});