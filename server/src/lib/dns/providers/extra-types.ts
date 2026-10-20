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
  /** 候选来源（`/api/workflows/meta/:source`）；声明后前端渲染为下拉 */
  source?: string;
  /** 拉取候选时一并带上的其它参数；缺任意一个就禁用下拉 */
  sourceParams?: string[];
  /**
   * 可选的候选依赖参数：有值才带上，缺了不影响下拉可用性。
   * 用于"只有部分账号类型才需要"的前置条件，例如腾讯云源站组的站点类型。
   */
  sourceOptionalParams?: string[];
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

export type ProviderActionHandler = (args: Record<string, unknown>) => Promise<unknown>;

export interface ProviderExtraCapability {
  /** 全名：ext.<providerType>.<suffix> */
  name: string;
  /** i18n key */
  label: string;
  actions: ProviderExtraAction[];
  /**
   * 动作实现，键为动作全名。
   * 提供商层不感知工作流的 ActionContext，由 ext 模块用 defineAction 包装。
   */
  handlers?: Record<string, ProviderActionHandler>;
}
