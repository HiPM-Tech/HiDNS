/**
 * 兼容转发：发布入口已下沉到主核心 `server/src/lib/domain-event-bus.ts`。
 */
export {
  publishRecordEvent,
  hasDomainEventSubscribers as hasWorkflowSubscribers,
} from '../lib/domain-event-bus';

export type { PublishRecordInput } from '../lib/domain-event-bus';