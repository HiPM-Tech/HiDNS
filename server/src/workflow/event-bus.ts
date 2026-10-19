/**
 * 兼容转发：事件主线已下沉到主核心 `server/src/lib/domain-event-bus.ts`。
 * 保留本文件避免既有引用（引擎、测试）改动。
 */
export {
  DomainEventBus as WorkflowEventBus,
  domainEventBus as workflowEventBus,
  buildRecordEvent,
  publishRecordEvent,
  hasDomainEventSubscribers as hasWorkflowSubscribers,
  DEFAULT_BUS_OPTIONS,
} from '../lib/domain-event-bus';

export type {
  DomainEvent as WorkflowEvent,
  AnyDomainEvent,
  DomainChangedEvent,
  RecordChangedEvent,
  RecordType,
  ActorSource,
  EventListener,
  BusOptions,
  BuildRecordEventInput,
  PublishRecordInput,
} from '../lib/domain-event-bus';