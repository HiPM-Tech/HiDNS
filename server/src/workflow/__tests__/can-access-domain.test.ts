import { describe, it, expect, vi, beforeEach } from 'vitest';

const access = vi.hoisted(() => ({
  getAccessibleDomains: vi.fn(),
  getWritableDomainIds: vi.fn(),
}));

vi.mock('../access', () => ({
  getAccessibleDomains: access.getAccessibleDomains,
  getWritableDomainIds: access.getWritableDomainIds,
}));

import { canAccessEventDomain, toStoredTriggerEvent } from '../index';

beforeEach(() => {
  access.getAccessibleDomains.mockReset();
  access.getWritableDomainIds.mockReset();
  access.getWritableDomainIds.mockResolvedValue([]);
  access.getAccessibleDomains.mockResolvedValue({ ids: [7], names: ['a.com'] });
});

describe('工作流租户边界（canAccessEventDomain）', () => {
  it('事件域名主键命中即可访问（名称大小写/IDN 差异不影响）', async () => {
    await expect(canAccessEventDomain({ ownerId: 5 }, { id: 7, name: 'A.COM' })).resolves.toBe(true);
  });

  it('主键未命中时不得回落到名称判定（同名域名不得互相放行）', async () => {
    // 同一个 zone 挂到两个账号：owner 只有 #7，事件来自 #9 但名字相同
    await expect(canAccessEventDomain({ ownerId: 5 }, { id: 9, name: 'a.com' })).resolves.toBe(false);
  });

  it('主键缺失（ns.changed）时按名称判定', async () => {
    await expect(canAccessEventDomain({ ownerId: 5 }, { id: 0, name: 'a.com' })).resolves.toBe(true);
    await expect(canAccessEventDomain({ ownerId: 5 }, { id: 0, name: 'b.com' })).resolves.toBe(false);
  });

  it('工作流缺少 owner 时一律拒绝且不查库', async () => {
    await expect(canAccessEventDomain({}, { id: 7, name: 'a.com' })).resolves.toBe(false);
    expect(access.getAccessibleDomains).not.toHaveBeenCalled();
  });

  it('可访问集合为空（查库失败 fail-closed）时全部拒绝', async () => {
    access.getAccessibleDomains.mockResolvedValue({ ids: [], names: [] });
    await expect(canAccessEventDomain({ ownerId: 5 }, { id: 7, name: 'a.com' })).resolves.toBe(false);
    await expect(canAccessEventDomain({ ownerId: 5 }, { id: 0, name: 'a.com' })).resolves.toBe(false);
  });
});
describe('运行记录里的事件快照', () => {
  const foreignEvent = {
    type: 'record.changed',
    action: 'updated',
    domain: { id: 99, name: 'other.com', accountId: 3 },
    record: { id: 'r1', name: 'www', type: 'A', value: '9.9.9.9', oldValue: '1.1.1.1' },
    actor: { userId: 8, source: 'ui' },
    traceId: 'trace-1',
    depth: 0,
    at: '2026-01-01T00:00:00.000Z',
  } as const;

  it('越权跳过的事件脱敏后才落库：域名与解析值不得进运行记录', () => {
    const stored = toStoredTriggerEvent({
      status: 'skipped',
      error: 'no-domain-access',
      traceId: 'trace-1',
      event: foreignEvent as never,
    }) as Record<string, unknown>;

    expect(stored).toEqual({
      type: 'record.changed',
      traceId: 'trace-1',
      at: '2026-01-01T00:00:00.000Z',
      redacted: 'no-domain-access',
    });
    expect(JSON.stringify(stored)).not.toContain('other.com');
    expect(JSON.stringify(stored)).not.toContain('9.9.9.9');
  });

  it('本人域名的事件原样落库（追溯需要完整快照）', () => {
    expect(
      toStoredTriggerEvent({ status: 'success', traceId: 'trace-1', event: foreignEvent as never }),
    ).toBe(foreignEvent);
  });

  it('其它原因的跳过不脱敏（例如 concurrent-run 仍属本人域名）', () => {
    expect(
      toStoredTriggerEvent({
        status: 'skipped',
        error: 'concurrent-run',
        traceId: 'trace-1',
        event: foreignEvent as never,
      }),
    ).toBe(foreignEvent);
  });

  it('没有事件时不写快照', () => {
    expect(toStoredTriggerEvent({ status: 'failed', traceId: 'trace-1' })).toBeUndefined();
  });
});
