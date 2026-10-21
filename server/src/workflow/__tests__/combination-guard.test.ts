import { describe, it, expect, vi } from 'vitest';
import { authorize, isCombinationAllowed, type AuthorizeDeps, type Principal } from '../auth';
import type { ActionClass } from '../../types/namespace';

/**
 * 设计 §4.0.4 的第二层：执行前裁决。
 *
 * 保存期校验只能挡住「经 API 保存」这条路径；直接改库、或历史遗留数据仍会带着
 * domain.changed + 写动作 的组合跑起来。这一层是真正的兜底，此前没有测试。
 */
const principal: Principal = {
  kind: 'user',
  id: 'u1',
  role: 'admin',
  services: ['records.write', 'records.read', 'network.fetch'],
  allowedDomains: '*',
};

function deps(actionClass: ActionClass, audit = vi.fn(async (_record: unknown) => undefined)): AuthorizeDeps {
  return {
    lookupAction: (name) => ({ name, actionClass, service: 'records.write', dslVisible: true }) as never,
    audit,
    rateLimit: () => true,
    now: () => 1_700_000_000_000,
    newTraceId: () => 'trace-x',
  };
}

describe('组合裁决 isCombinationAllowed', () => {
  it('域名变动触发器不得触发记录写动作', () => {
    expect(isCombinationAllowed('domain.changed', 'dns.record.write')).toBe(false);
    expect(isCombinationAllowed('domain.changed', 'ext.write')).toBe(false);
  });

  it('域名变动触发器可以触发只读动作', () => {
    expect(isCombinationAllowed('domain.changed', 'dns.record.read')).toBe(true);
    expect(isCombinationAllowed('domain.changed', 'http')).toBe(true);
  });

  it('记录变更触发器可以触发写动作', () => {
    expect(isCombinationAllowed('record.changed', 'dns.record.write')).toBe(true);
  });
});

describe('authorize 执行前裁决', () => {
  it('绕过保存校验的写组合在运行期被拒，并记 denied 审计', async () => {
    const audit = vi.fn(async (_record: unknown) => undefined);
    await expect(
      authorize('dns.record.update', principal, { domainId: 1 }, deps('dns.record.write', audit), {
        // trigger 是运行来源（event/manual/api/internal），triggerType 才是工作流触发器类型
        trigger: 'event',
        triggerType: 'domain.changed',
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect(audit).toHaveBeenCalled();
    const audited = audit.mock.calls as unknown as Array<[{ outcome: string }]>;
    expect(audited[0][0].outcome).toBe('denied');
  });

  it('同样的动作换成记录变更触发器则放行', async () => {
    await expect(
      authorize('dns.record.update', principal, { domainId: 1 }, deps('dns.record.write'), {
        trigger: 'event',
        triggerType: 'record.changed',
      }),
    ).resolves.toBeTruthy();
  });
});
