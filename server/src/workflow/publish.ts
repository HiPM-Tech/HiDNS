import { buildRecordEvent, workflowEventBus } from './event-bus';
import type { ActorSource, RecordChangedEvent } from './event-bus';

/**
 * 路由侧发布入口。
 * 设计依据：docs/WORKFLOW_ENGINE_DESIGN.md §4.3
 *
 * 三条约束：
 * 1. 无订阅者时**零成本**（不额外查询、不构造事件）；
 * 2. 非 A/AAAA 类型不产生事件（由 buildRecordEvent 统一判定）；
 * 3. 发布失败**绝不影响**业务请求结果。
 */

export interface PublishRecordInput {
  action: RecordChangedEvent['action'];
  domain: { id: number; name: string; accountId?: number };
  record: { id: string; name: string; type: string; value?: string; oldValue?: string };
  actor?: { userId?: number; source: ActorSource };
}

export function hasWorkflowSubscribers(): boolean {
  return workflowEventBus.subscriberCount() > 0;
}

export function publishRecordEvent(input: PublishRecordInput): void {
  try {
    if (!hasWorkflowSubscribers()) return;
    const event = buildRecordEvent(input);
    if (event) workflowEventBus.publish(event);
  } catch {
    // 事件发布属于旁路，失败不得影响主流程
  }
}