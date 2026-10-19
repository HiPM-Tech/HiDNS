import type { WorkflowDefinition } from '../engine';
import type { ExpressionNode } from '../expression/nodes';

/**
 * 虚拟 DDNS → 源站组同步：完整的模拟工作流。
 *
 * 场景：
 *   域名 example.test 的 A / AAAA 记录被 DDNS 更新
 *   → 引用该域名的**多个**源站组需要同步新地址
 *   → A 与 AAAA 可能先后或同时变化
 *
 * 处理方式：
 *   1. 触发器同时订阅 A 与 AAAA，任一变化都会进入本流程
 *   2. 只对"本次变化的那一族"传值，另一族传空串 —— 同步层会把空值视为"未提供"，
 *      因此 A 变更不会覆盖 AAAA 源站，反之亦然
 *   3. planSync 先算出全部受影响源站组的计划与摘要；sync 用该摘要提交，
 *      期间状态变化会被拒绝（防 TOCTOU）
 *   4. 只处理 created / updated，删除与状态变更不触发同步
 *
 * 该预设同时是"虚拟提供商能完整演练真实代码路径"的证明：
 * 它走的是真实的分发器、真实的鉴权、真实的 DSL 求值器。
 */

const ref = (path: string): ExpressionNode => ({ kind: 'ref', path });
const lit = (value: string | number | boolean | null): ExpressionNode => ({ kind: 'literal', value });

/** 仅当事件里的记录类型匹配时才取值，否则给空串表示"本族无更新" */
function familyValue(type: 'A' | 'AAAA'): ExpressionNode {
  return {
    kind: 'cond',
    test: { kind: 'compare', op: '==', left: ref('event.record.type'), right: lit(type) },
    then: ref('event.record.value'),
    else: lit(''),
  };
}

const planArgs = (): Record<string, ExpressionNode> => ({
  domainId: ref('event.domain.id'),
  domainName: ref('event.domain.name'),
  v4: familyValue('A'),
  v6: familyValue('AAAA'),
  addIfMissing: lit(true),
});

export const VIRTUAL_DDNS_ORIGIN_SYNC: WorkflowDefinition = {
  id: 'preset-virtual-ddns-origin-sync',
  name: 'DDNS 变更后同步源站组（虚拟模拟）',
  enabled: true,
  ownerId: 1,
  trigger: { type: 'record.changed', recordTypes: ['A', 'AAAA'] },
  condition: {
    kind: 'logic',
    op: 'or',
    args: [
      { kind: 'compare', op: '==', left: ref('event.action'), right: lit('created') },
      { kind: 'compare', op: '==', left: ref('event.action'), right: lit('updated') },
    ],
  },
  actions: [
    {
      kind: 'assign',
      key: 'plan',
      value: { kind: 'call', action: 'ext.virtual.originGroup.planSync', args: planArgs() },
    },
    {
      kind: 'call',
      action: 'ext.virtual.originGroup.sync',
      args: { ...planArgs(), diffDigest: ref('vars.plan.digest') },
    },
  ],
};

export const PRESET_WORKFLOWS: readonly WorkflowDefinition[] = [VIRTUAL_DDNS_ORIGIN_SYNC];
