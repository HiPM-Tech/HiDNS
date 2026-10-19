import { ALL_ACTIONS } from './actions/registry';

/**
 * 候选值（meta）——供前端渲染 {...} 下拉 / [...] 可输入。
 * 设计依据：§3.3 候选值来源
 *
 * 本文件只处理**无 DB 依赖**的候选源；`domains` 需要 BAL，留在路由层。
 */

export interface MetaItem {
  value?: string;
  label?: string;
  [key: string]: unknown;
}

export const STATIC_META_SOURCES = ['actions', 'triggerTypes', 'recordTypes', 'domainFields', 'nsStatuses'] as const;
export type StaticMetaSource = typeof STATIC_META_SOURCES[number];

export function isStaticMetaSource(source: string): source is StaticMetaSource {
  return (STATIC_META_SOURCES as readonly string[]).includes(source);
}

export function buildStaticMeta(source: StaticMetaSource): MetaItem[] {
  switch (source) {
    case 'actions':
      return ALL_ACTIONS.map((action) => ({
        value: action.name,
        label: action.label,
        name: action.name,
        actionClass: action.actionClass,
        risk: action.risk,
        dslVisible: action.dslVisible,
        params: action.params,
      }));

    case 'triggerTypes':
      return [
        { value: 'record.changed', label: 'workflow.trigger.record_changed' },
        { value: 'domain.changed', label: 'workflow.trigger.domain_changed' },
        { value: 'ns.changed', label: 'workflow.trigger.ns_changed' },
        { value: 'whois.expiring', label: 'workflow.trigger.whois_expiring' },
      ];

    case 'recordTypes':
      // §4.0.5：仅 A / AAAA
      return [
        { value: 'A', label: 'A' },
        { value: 'AAAA', label: 'AAAA' },
      ];

    case 'domainFields':
      return [
        { value: 'remark', label: 'workflow.field.remark' },
        { value: 'is_hidden', label: 'workflow.field.is_hidden' },
        { value: 'enabled', label: 'workflow.field.enabled' },
      ];

    case 'nsStatuses':
      return ['ok', 'mismatch', 'missing', 'poisoned'].map((value) => ({
        value,
        label: `workflow.ns.${value}`,
      }));

    default:
      return [];
  }
}