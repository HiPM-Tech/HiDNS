import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { authorize } from '../../auth';
import type { AuthorizeDeps, Principal } from '../../auth';
import { dnsRecordHandlers } from '../dns/record';
import { setRecordDeps, resetRecordDeps, MAX_BATCH_SIZE } from '../dns/record-deps';

const principal: Principal = {
  kind: 'user',
  id: 'u1',
  role: 'user',
  services: ['records.read', 'records.write'],
  allowedDomains: ['ok.com'],
};

const authDeps: AuthorizeDeps = {
  lookupAction: (name) => ({ name, actionClass: 'dns.record.write', service: 'records.write', dslVisible: true }),
  audit: async () => undefined,
  rateLimit: () => true,
  now: () => 1_700_000_000_000,
  newTraceId: () => 'trace-dns',
};

function makeAdapter() {
  return {
    getDomainRecords: vi.fn(async () => ({ total: 1, list: [{ RecordId: 'r1', Name: 'www', Type: 'A', Value: '1.2.3.4', TTL: 600, Line: '0', Status: 1 }] })),
    getDomainRecordInfo: vi.fn(async () => ({ RecordId: 'r1', Name: 'www', Type: 'A', Value: '1.1.1.1', TTL: 600, Line: '0', Status: 1 })),
    addDomainRecord: vi.fn(async () => 'new-1'),
    updateDomainRecord: vi.fn(async () => true),
    deleteDomainRecord: vi.fn(async () => true),
    setDomainRecordStatus: vi.fn(async () => true),
  };
}

let adapter: ReturnType<typeof makeAdapter>;
let publish: ReturnType<typeof vi.fn>;

beforeEach(() => {
  adapter = makeAdapter();
  publish = vi.fn();
  setRecordDeps({
    resolveDomain: async (ref) => (ref.domainName === 'missing.com' ? null : { id: 7, name: ref.domainName ?? 'ok.com', account_id: 3 }),
    getAdapter: async () => adapter as never,
    publish: publish as never,
  });
});

async function ctxFor(action: string) {
  return authorize(action, principal, undefined, authDeps);
}

describe('dns.record.* 动作', () => {
  it('list 返回记录 DTO', async () => {
    const ctx = await ctxFor('dns.record.list');
    const result = (await dnsRecordHandlers['dns.record.list'](ctx, { domain: 'ok.com' })) as { total: number; records: unknown[] };
    expect(result.total).toBe(1);
    expect(result.records).toHaveLength(1);
  });

  it('域名不在允许列表 → 403（handler 二次校验）', async () => {
    const ctx = await ctxFor('dns.record.list');
    await expect(dnsRecordHandlers['dns.record.list'](ctx, { domain: 'other.com' })).rejects.toMatchObject({
      status: 403,
    });
  });

  it('域名不存在 → 404', async () => {
    const ctx = await ctxFor('dns.record.list');
    await expect(dnsRecordHandlers['dns.record.list'](ctx, { domain: 'missing.com' })).rejects.toMatchObject({
      status: 404,
    });
  });

  it('create 成功后发布 created 事件', async () => {
    const ctx = await ctxFor('dns.record.create');
    await dnsRecordHandlers['dns.record.create'](ctx, { domain: 'ok.com', name: 'www', type: 'A', value: '2.2.2.2' });
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'created', record: expect.objectContaining({ id: 'new-1', type: 'A' }) }),
    );
  });

  it('update 携带旧值发布事件', async () => {
    const ctx = await ctxFor('dns.record.update');
    await dnsRecordHandlers['dns.record.update'](ctx, { domain: 'ok.com', recordId: 'r1', value: '9.9.9.9' });
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'updated', record: expect.objectContaining({ oldValue: '1.1.1.1', value: '9.9.9.9' }) }),
    );
  });

  it('setStatus 非法值 → 400', async () => {
    const ctx = await ctxFor('dns.record.setStatus');
    await expect(
      dnsRecordHandlers['dns.record.setStatus'](ctx, { domain: 'ok.com', recordId: 'r1', status: 5 }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('batch 超过上限 → 422', async () => {
    const ctx = await ctxFor('dns.record.batch');
    const records = Array.from({ length: MAX_BATCH_SIZE + 1 }, (_, i) => ({ name: `r${i}`, type: 'A', value: '1.1.1.1' }));
    await expect(dnsRecordHandlers['dns.record.batch'](ctx, { domain: 'ok.com', records })).rejects.toMatchObject({
      status: 422,
    });
  });

  it('delete 不发布事件（类型未知，fail-closed）', async () => {
    const ctx = await ctxFor('dns.record.delete');
    await dnsRecordHandlers['dns.record.delete'](ctx, { domain: 'ok.com', recordId: 'r1' });
    expect(publish).not.toHaveBeenCalled();
  });
});

afterEach(() => resetRecordDeps());