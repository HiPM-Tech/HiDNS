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

  it('拒绝未知触发器类型（domain.changed 已支持，schedule 不设计）', () => {
    expect(validatePayload(base({ triggerType: 'schedule' })).join()).toContain('record.changed / domain.changed');
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

  it('域名变动触发只读动作为合法', () => {
    expect(
      validatePayload(
        base({
          triggerType: 'domain.changed',
          triggerConfig: { fields: ['remark'] },
          actions: [{ kind: 'call', action: 'dns.record.list', args: { domain: { kind: 'literal', value: 'a.com' } } }],
        }),
      ),
    ).toEqual([]);
  });

  it('§4.0：域名变动触发写动作 → 保存期拒绝', () => {
    const problems = validatePayload(
      base({
        triggerType: 'domain.changed',
        triggerConfig: { fields: ['remark'] },
        actions: [{ kind: 'call', action: 'dns.record.update', args: { domain: { kind: 'literal', value: 'a.com' } } }],
      }),
    );
    expect(problems.join()).toContain('域名变动不得触发写动作');
  });

  it('§4.0：域名变动触发 ext.write 同样被拒', () => {
    const problems = validatePayload(
      base({
        triggerType: 'domain.changed',
        triggerConfig: { fields: ['remark'] },
        actions: [{ kind: 'call', action: 'ext.tencenteo.originGroup.replace', args: {} }],
      }),
    );
    expect(problems.join()).toContain('域名变动不得触发写动作');
  });

  it('域名变动的字段白名单受限', () => {
    expect(
      validatePayload(
        base({
          triggerType: 'domain.changed',
          triggerConfig: { fields: ['record_value'] },
          actions: [{ kind: 'call', action: 'dns.record.list', args: {} }],
        }),
      ).join(),
    ).toContain('remark / is_hidden / enabled');
  });

  it('条件节点同样受校验', () => {
    expect(
      validatePayload(base({ condition: { kind: 'eval', code: '1' } })).join(),
    ).toContain('UNKNOWN_NODE_KIND');
  });
});