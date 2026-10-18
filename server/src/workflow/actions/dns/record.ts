import type { ActionDeclaration, BrandedActionHandler } from '../types';
import { defineAction } from '../types';
import type { ActionContext } from '../../auth';
import { AuthorizationError } from '../../auth';
import {
  MAX_BATCH_SIZE,
  emitRecordEvent,
  getAdapterFor,
  resolveTargetDomain,
  toRecordDto,
  type ResolvedDomain,
} from './record-deps';

/** 解析记录动作。设计依据：§5.3 动作到服务权限映射 */
export const dnsRecordActions: ActionDeclaration[] = [
  { name: 'dns.record.list', label: 'workflow.action.dns_record_list', actionClass: 'dns.record.read', risk: 'low', service: 'records.read', dslVisible: true, params: [
    { key: 'domain', label: 'workflow.param.domain', type: 'text', required: true },
    { key: 'type', label: 'workflow.param.type', type: 'select', required: false, options: ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS'] },
  ] },
  { name: 'dns.record.get', label: 'workflow.action.dns_record_get', actionClass: 'dns.record.read', risk: 'low', service: 'records.read', dslVisible: true, params: [
    { key: 'domain', label: 'workflow.param.domain', type: 'text', required: true },
    { key: 'recordId', label: 'workflow.param.record_id', type: 'text', required: true },
  ] },
  { name: 'dns.record.create', label: 'workflow.action.dns_record_create', actionClass: 'dns.record.write', risk: 'medium', service: 'records.write', dslVisible: true, params: [
    { key: 'domain', label: 'workflow.param.domain', type: 'text', required: true },
    { key: 'name', label: 'workflow.param.name', type: 'text', required: true },
    { key: 'type', label: 'workflow.param.type', type: 'text', required: true },
    { key: 'value', label: 'workflow.param.value', type: 'text', required: true },
    { key: 'ttl', label: 'workflow.param.ttl', type: 'number', required: false },
  ] },
  { name: 'dns.record.update', label: 'workflow.action.dns_record_update', actionClass: 'dns.record.write', risk: 'medium', service: 'records.write', dslVisible: true, params: [
    { key: 'domain', label: 'workflow.param.domain', type: 'text', required: true },
    { key: 'recordId', label: 'workflow.param.record_id', type: 'text', required: true },
    { key: 'value', label: 'workflow.param.value', type: 'text', required: true },
  ] },
  { name: 'dns.record.delete', label: 'workflow.action.dns_record_delete', actionClass: 'dns.record.write', risk: 'high', service: 'records.write', dslVisible: false, params: [
    { key: 'domain', label: 'workflow.param.domain', type: 'text', required: true },
    { key: 'recordId', label: 'workflow.param.record_id', type: 'text', required: true },
  ] },
  { name: 'dns.record.setStatus', label: 'workflow.action.dns_record_set_status', actionClass: 'dns.record.write', risk: 'medium', service: 'records.write', dslVisible: true, params: [
    { key: 'domain', label: 'workflow.param.domain', type: 'text', required: true },
    { key: 'recordId', label: 'workflow.param.record_id', type: 'text', required: true },
    { key: 'status', label: 'workflow.param.status', type: 'number', required: true },
  ] },
  { name: 'dns.record.batch', label: 'workflow.action.dns_record_batch', actionClass: 'dns.record.write', risk: 'high', service: 'records.write', dslVisible: false, params: [
    { key: 'domain', label: 'workflow.param.domain', type: 'text', required: true },
    { key: 'records', label: 'workflow.param.records', type: 'text', required: true },
  ] },
];

async function adapterFor(domain: ResolvedDomain) {
  return getAdapterFor(domain);
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value) throw new AuthorizationError(400, `缺少参数: ${key}`);
  return value;
}

function publish(ctx: ActionContext, domain: ResolvedDomain, action: 'created' | 'updated', record: { id: string; name: string; type: string; value?: string; oldValue?: string }): void {
  emitRecordEvent({
    action,
    domain: { id: domain.id, name: domain.name, accountId: domain.account_id },
    record,
    actor: { userId: Number(ctx.principal.id) || undefined, source: 'workflow' },
  });
}

export const dnsRecordHandlers: Record<string, BrandedActionHandler> = {
  'dns.record.list': defineAction(async (ctx, args) => {
    const domain = await resolveTargetDomain(ctx, args);
    const adapter = await adapterFor(domain);
    const page = Number(args.page ?? 1);
    const pageSize = Math.min(Number(args.pageSize ?? 100), 100);
    const result = await adapter.getDomainRecords(page, pageSize, undefined, undefined, undefined, typeof args.type === 'string' ? args.type : undefined);
    return { total: result.total, records: result.list.map(toRecordDto) };
  }),

  'dns.record.get': defineAction(async (ctx, args) => {
    const domain = await resolveTargetDomain(ctx, args);
    const adapter = await adapterFor(domain);
    const record = await adapter.getDomainRecordInfo(requireString(args, 'recordId'));
    return record ? toRecordDto(record) : null;
  }),

  'dns.record.create': defineAction(async (ctx, args) => {
    const domain = await resolveTargetDomain(ctx, args);
    const adapter = await adapterFor(domain);
    const name = requireString(args, 'name');
    const type = requireString(args, 'type');
    const value = requireString(args, 'value');
    const recordId = await adapter.addDomainRecord(name, type, value, '0', Number(args.ttl ?? 600));
    if (!recordId) throw new Error('创建记录失败');
    publish(ctx, domain, 'created', { id: recordId, name, type, value });
    return { recordId };
  }),

  'dns.record.update': defineAction(async (ctx, args) => {
    const domain = await resolveTargetDomain(ctx, args);
    const adapter = await adapterFor(domain);
    const recordId = requireString(args, 'recordId');
    const previous = await adapter.getDomainRecordInfo(recordId);
    if (!previous) throw new AuthorizationError(404, '记录不存在');
    const value = requireString(args, 'value');
    const ok = await adapter.updateDomainRecord(recordId, previous.Name, previous.Type, value);
    if (!ok) throw new Error('更新记录失败');
    publish(ctx, domain, 'updated', { id: recordId, name: previous.Name, type: previous.Type, value, oldValue: previous.Value });
    return { recordId, value };
  }),

  'dns.record.delete': defineAction(async (ctx, args) => {
    const domain = await resolveTargetDomain(ctx, args);
    const adapter = await adapterFor(domain);
    const ok = await adapter.deleteDomainRecord(requireString(args, 'recordId'));
    if (!ok) throw new Error('删除记录失败');
    return { deleted: true };
  }),

  'dns.record.setStatus': defineAction(async (ctx, args) => {
    const domain = await resolveTargetDomain(ctx, args);
    const adapter = await adapterFor(domain);
    const status = Number(args.status);
    if (status !== 0 && status !== 1) throw new AuthorizationError(400, 'status 只能是 0 或 1');
    const ok = await adapter.setDomainRecordStatus(requireString(args, 'recordId'), status);
    if (!ok) throw new Error('修改记录状态失败');
    return { recordId: args.recordId, status };
  }),

  'dns.record.batch': defineAction(async (ctx, args) => {
    const domain = await resolveTargetDomain(ctx, args);
    const adapter = await adapterFor(domain);
    const items = Array.isArray(args.records) ? args.records : [];
    if (items.length > MAX_BATCH_SIZE) {
      throw new AuthorizationError(422, `批量动作最多 ${MAX_BATCH_SIZE} 条`);
    }
    const results: Array<{ recordId?: string; ok: boolean; error?: string }> = [];
    for (const item of items as Array<Record<string, unknown>>) {
      try {
        const recordId = await adapter.addDomainRecord(
          String(item.name ?? ''),
          String(item.type ?? ''),
          String(item.value ?? ''),
          '0',
          Number(item.ttl ?? 600),
        );
        results.push({ recordId: recordId ?? undefined, ok: Boolean(recordId) });
      } catch (error) {
        results.push({ ok: false, error: (error as Error).message });
      }
    }
    return { total: items.length, results };
  }),
};