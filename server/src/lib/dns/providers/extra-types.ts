import type { ActionClass } from '../../../types/namespace';
import type { AvailableService } from '../../../types/token';

/**
 * 提供商特有能力的声明结构。
 * 设计依据：docs/WORKFLOW_ENGINE_DESIGN.md §3.7.4
 *
 * 命名规则（强制）：能力全名 = ext.<providerType>.<suffix>
 * 唯一性由注册期校验（构建期 / CI）保证，见 workflow/actions/validate-names.ts
 */

export interface ProviderActionParam {
  key: string;
  /** i18n key */
  label: string;
  type: 'text' | 'number' | 'boolean' | 'select';
  required: boolean;
  options?: string[];
}

export interface ProviderExtraAction {
  /** 动作全名：<capability.name>.<verb> */
  name: string;
  /** 语义分类，供组合裁决使用；不得从动作名反推 */
  actionClass: ActionClass;
  risk: 'low' | 'medium' | 'high';
  /** 所需服务权限，取自 AVAILABLE_SERVICES */
  service: AvailableService;
  /** i18n key */
  label: string;
  /** 是否对声明式 DSL 可见；false = 仅内部/API 可达 */
  dslVisible: boolean;
  params: ProviderActionParam[];
}

export interface ProviderExtraCapability {
  /** 全名：ext.<providerType>.<suffix> */
  name: string;
  /** i18n key */
  label: string;
  actions: ProviderExtraAction[];
}
