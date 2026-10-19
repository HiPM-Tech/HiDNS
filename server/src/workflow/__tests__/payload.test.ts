import { describe, it, expect } from 'vitest';
import { validatePayload } from '../validate-payload';

const UPDATE_ARGS = {
  domain: { kind: 'literal', value: 'a.com' },
  recordId: { kind: 'literal', value: 'r1' },
  value: { kind: 'literal', value: '1.2.3.4' },
};

const LIST_ARGS = { domain: { kind: 'literal', value: 'a.com' } };

function updateCall(args: Record<string, unknown> = UPDATE_ARGS) {
  return { kind: 'call', action: 'dns.record.update', args };
}

function base(overrides: Record<string, unknown> = {}) {
  return {
    name: 'wf',
    triggerType: 'record.changed',
    triggerConfig: { recordTypes: ['A'] },
    actions: [updateCall()],
    ...overrides,
  };
}

describe('保存期校验', () => {
  it('合法负载通过', () => {
    expect(validatePayload(base())).toEqual([]);
  });

  it('拒绝非 A/AAAA 触发类型', () => {
    expect(validatePayload(base({ triggerConfig: { recordTypes: ['CNAME'] } })).join()).toContain('仅允许 A / AAAA');
  });

  it('拒绝未知触发器类型（domain.changed 已支持，schedule 不设计）', () => {
    expect(validatePayload(base({ triggerType: 'schedule' })).join()).toContain('record.changed / domain.changed');
  });

  it('拒绝空动作列表', () => {
    expect(validatePayload(base({ actions: [] })).join()).toContain('至少需要一个动作节点');
  });

  it('拒绝未注册动作', () => {
    expect(validatePayload(base({ actions: [{ kind: 'call', action: 'dns.record.drop', args: {} }] })).join()).toContain('UNKNOWN_ACTION');
  });

  it('拒绝动态动作名', () => {
    expect(
      validatePayload(base({ actions: [{ kind: 'call', action: { kind: 'ref', path: 'vars.x' }, args: {} }] })).join(),
    ).toContain('DYNAMIC_ACTION_NAME');
  });

  it('拒绝白名单外参数', () => {
    expect(
      validatePayload(base({ actions: [updateCall({ ...UPDATE_ARGS, shell: { kind: 'literal', value: 'x' } })] })).join(),
    ).toContain('UNKNOWN_ARG');
  });

  it('拒绝缺失的必填参数', () => {
    expect(validatePayload(base({ actions: [updateCall({ domain: { kind: 'literal', value: 'a.com' } })] })).join()).toContain(
      'MISSING_ARG',
    );
  });

  it('域名变动触发只读动作为合法', () => {
    expect(
      validatePayload(
        base({
          triggerType: 'domain.changed',
          triggerConfig: { fields: ['remark'] },
          actions: [{ kind: 'call', action: 'dns.record.list', args: LIST_ARGS }],
        }),
      ),
    ).toEqual([]);
  });

  it('§4.0：域名变动触发写动作 → 保存期拒绝', () => {
    const problems = validatePayload(
      base({
        triggerType: 'domain.changed',
        triggerConfig: { fields: ['remark'] },
        actions: [updateCall()],
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
          actions: [{ kind: 'call', action: 'dns.record.list', args: LIST_ARGS }],
        }),
      ).join(),
    ).toContain('remark / is_hidden / enabled');
  });

  it('ns.changed / whois.expiring 触发器合法（只读动作）', () => {
    for (const triggerType of ['ns.changed', 'whois.expiring']) {
      expect(
        validatePayload(
          base({
            triggerType,
            triggerConfig: {},
            actions: [{ kind: 'call', action: 'notify.channel.send', args: { message: { kind: 'literal', value: 'hi' } } }],
          }),
        ),
      ).toEqual([]);
    }
  });

  it('ns.changed 允许写动作（不受 §4.0 约束）', () => {
    expect(
      validatePayload(
        base({
          triggerType: 'ns.changed',
          triggerConfig: { statuses: ['poisoned'] },
          actions: [updateCall()],
        }),
      ),
    ).toEqual([]);
  });

  it('ns.changed 状态白名单校验', () => {
    expect(validatePayload(base({ triggerType: 'ns.changed', triggerConfig: { statuses: ['poisoned'] } })).join()).not.toContain(
      'statuses',
    );
    expect(validatePayload(base({ triggerType: 'ns.changed', triggerConfig: { statuses: ['weird'] } })).join()).toContain(
      '仅允许',
    );
  });

  it('whois.expiring 的 withinDays 必须是非负数字', () => {
    expect(validatePayload(base({ triggerType: 'whois.expiring', triggerConfig: { withinDays: 7 } })).join()).not.toContain(
      'withinDays',
    );
    expect(validatePayload(base({ triggerType: 'whois.expiring', triggerConfig: { withinDays: -1 } })).join()).toContain(
      '非负数字',
    );
  });

  it('拒绝引用 dslVisible:false 的动作', () => {
    expect(
      validatePayload(
        base({ actions: [{ kind: 'call', action: 'dns.record.delete', args: { domain: { kind: 'literal', value: 'a.com' }, recordId: { kind: 'literal', value: 'r1' } } }] }),
      ).join(),
    ).toContain('不对声明式定义开放');
  });

  it('enabled 必须是布尔值', () => {
    expect(validatePayload(base({ enabled: 'false' })).join()).toContain('enabled 必须是布尔值');
    expect(validatePayload(base({ enabled: true })).join()).not.toContain('enabled');
  });

  it('triggerConfig 必须是对象', () => {
    expect(validatePayload(base({ triggerType: 'ns.changed', triggerConfig: 'abc' })).join()).toContain(
      'triggerConfig 必须是对象',
    );
  });

  it('条件节点同样受校验', () => {
    expect(validatePayload(base({ condition: { kind: 'eval', code: '1' } })).join()).toContain('UNKNOWN_NODE_KIND');
  });
});