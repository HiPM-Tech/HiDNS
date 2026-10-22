import { describe, it, expect } from 'vitest';
import { validatePayload } from '../validate-payload';

const base = {
  name: 'wf',
  triggerType: 'record.changed',
  triggerConfig: { recordTypes: ['A'] },
};

function replaceArgs(extra: Record<string, unknown> = {}) {
  return {
    accountId: { kind: 'literal', value: 1 },
    scopeId: { kind: 'literal', value: 'zone-1' },
    groupId: { kind: 'literal', value: 'og-1' },
    target: { kind: 'literal', value: '1.1.1.1' },
    diffDigest: { kind: 'literal', value: 'abc' },
    ...extra,
  };
}

describe('写入前的确认闸门（must-be-true）', () => {
  it('源站组整组替换未勾选 collapse → 保存期直接拒绝', () => {
    // 之前 collapse 根本没被声明，界面上设不了，动作在运行期**永远**抛
    // COLLAPSE_NOT_ACKNOWLEDGED。这条用例锁住「声明了但没勾」也要拦住。
    const problems = validatePayload({
      ...base,
      actions: [{ kind: 'call', action: 'ext.tencenteo.originGroup.replace', args: replaceArgs() }],
    } as never);
    expect(problems.join()).toContain('MUST_BE_TRUE');
    expect(problems.join()).toContain('collapse');
  });

  it('勾选 collapse 后不再报该问题', () => {
    const problems = validatePayload({
      ...base,
      actions: [
        {
          kind: 'call',
          action: 'ext.tencenteo.originGroup.replace',
          args: replaceArgs({ collapse: { kind: 'literal', value: true } }),
        },
      ],
    } as never);
    expect(problems.join()).not.toContain('MUST_BE_TRUE');
  });

  it('只读动作不受该闸门影响', () => {
    const problems = validatePayload({
      ...base,
      actions: [{ kind: 'call', action: 'ext.tencenteo.originGroup.list', args: { accountId: { kind: 'literal', value: 1 }, scopeId: { kind: 'literal', value: 'z' } } }],
    } as never);
    expect(problems.join()).not.toContain('MUST_BE_TRUE');
  });
});
