import type { ActionDeclaration, BrandedActionHandler } from '../types';
import { defineAction, ActionNotImplementedError } from '../types';

/** 解析记录动作。设计依据：§5.3 动作到服务权限映射 */
export const dnsRecordActions: ActionDeclaration[] = [
  { name: 'dns.record.list', label: 'workflow.action.dns_record_list', actionClass: 'dns.record.read', risk: 'low', service: 'records.read', dslVisible: true, params: [{ key: 'domain', label: 'workflow.param.domain', type: 'text', required: true }] },
  { name: 'dns.record.get', label: 'workflow.action.dns_record_get', actionClass: 'dns.record.read', risk: 'low', service: 'records.read', dslVisible: true, params: [{ key: 'domain', label: 'workflow.param.domain', type: 'text', required: true }, { key: 'recordId', label: 'workflow.param.record_id', type: 'text', required: true }] },
  { name: 'dns.record.create', label: 'workflow.action.dns_record_create', actionClass: 'dns.record.write', risk: 'medium', service: 'records.write', dslVisible: true, params: [{ key: 'domain', label: 'workflow.param.domain', type: 'text', required: true }] },
  { name: 'dns.record.update', label: 'workflow.action.dns_record_update', actionClass: 'dns.record.write', risk: 'medium', service: 'records.write', dslVisible: true, params: [{ key: 'domain', label: 'workflow.param.domain', type: 'text', required: true }, { key: 'recordId', label: 'workflow.param.record_id', type: 'text', required: true }] },
  { name: 'dns.record.delete', label: 'workflow.action.dns_record_delete', actionClass: 'dns.record.write', risk: 'high', service: 'records.write', dslVisible: false, params: [{ key: 'domain', label: 'workflow.param.domain', type: 'text', required: true }] },
  { name: 'dns.record.setStatus', label: 'workflow.action.dns_record_set_status', actionClass: 'dns.record.write', risk: 'medium', service: 'records.write', dslVisible: true, params: [{ key: 'domain', label: 'workflow.param.domain', type: 'text', required: true }] },
  { name: 'dns.record.batch', label: 'workflow.action.dns_record_batch', actionClass: 'dns.record.write', risk: 'high', service: 'records.write', dslVisible: false, params: [{ key: 'domain', label: 'workflow.param.domain', type: 'text', required: true }] },
];

function pending(name: string): BrandedActionHandler {
  return defineAction(async () => {
    throw new ActionNotImplementedError(name);
  });
}

export const dnsRecordHandlers: Record<string, BrandedActionHandler> = {
  'dns.record.list': pending('dns.record.list'),
  'dns.record.get': pending('dns.record.get'),
  'dns.record.create': pending('dns.record.create'),
  'dns.record.update': pending('dns.record.update'),
  'dns.record.delete': pending('dns.record.delete'),
  'dns.record.setStatus': pending('dns.record.setStatus'),
  'dns.record.batch': pending('dns.record.batch'),
};
