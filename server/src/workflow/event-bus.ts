import { randomUUID } from 'node:crypto';
import { createLogger } from '../lib/logger';

const log = createLogger('Workflow').sub('Bus');

/**
 * 工作流事件总线。
 * 设计依据：docs/WORKFLOW_ENGINE_DESIGN.md §4.2 / §4.3 / §7.2
 *
 * 约束：
 * 1. 只发布 A / AAAA 记录事件（§4.0.5），其余类型一律丢弃（fail-closed）；
 * 2. 深度超限丢弃（§7.2 防循环）；
 * 3. 工作流自身产生的写入默认不触发（actor.source = 'workflow'）；
 * 4. **不得在模块作用域注册订阅**，订阅必须在显式 start() 中建立。
 */

export type RecordType = 'A' | 'AAAA';
export type ActorSource = 'ui' | 'api' | 'token' | 'workflow';

export interface RecordChangedEvent {
  readonly type: 'record.changed';
  readonly action: 'created' | 'updated' | 'deleted' | 'status_changed';
  readonly domain: { readonly id: number; readonly name: string; readonly accountId?: number };
  readonly record: {
    readonly id: string;
    readonly name: string;
    readonly type: RecordType;
    readonly value?: string;
    readonly oldValue?: string;
  };
  readonly actor: { readonly userId?: number; readonly source: ActorSource };
  readonly traceId: string;
  readonly depth: number;
  readonly at: string;
}

export type WorkflowEvent = RecordChangedEvent;

export type EventListener = (event: WorkflowEvent) => void | Promise<void>;

export interface BusOptions {
  /** 允许工作流自身写入再次触发（默认 false） */
  allowSelfTrigger: boolean;
  /** 最大传播深度 */
  maxDepth: number;
}

export const DEFAULT_BUS_OPTIONS: BusOptions = { allowSelfTrigger: false, maxDepth: 3 };

const ALLOWED_RECORD_TYPES = new Set<string>(['A', 'AAAA']);

export class WorkflowEventBus {
  private listeners = new Set<EventListener>();
  private options: BusOptions = { ...DEFAULT_BUS_OPTIONS };
  private dropped = 0;
  private droppedLogged = 0;

  configure(options: Partial<BusOptions>): void {
    this.options = { ...this.options, ...options };
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscriberCount(): number {
    return this.listeners.size;
  }

  /** 判断事件是否应当进入总线 */
  accepts(event: WorkflowEvent): boolean {
    if (!ALLOWED_RECORD_TYPES.has(event.record.type)) return false;
    if (event.depth > this.options.maxDepth) return false;
    if (!this.options.allowSelfTrigger && event.actor.source === 'workflow') return false;
    return true;
  }

  publish(event: WorkflowEvent): boolean {
    if (!this.accepts(event)) {
      this.dropped += 1;
      // 同源高频日志限流：仅首次与每 100 次记录（root.ai.md §日志相关 9）
      if (this.dropped === 1 || this.dropped - this.droppedLogged >= 100) {
        this.droppedLogged = this.dropped;
        log.debug('event dropped', { reason: event.record.type, dropped: this.dropped });
      }
      return false;
    }

    for (const listener of [...this.listeners]) {
      try {
        const result = listener(event);
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch((error) => {
            log.error('event listener rejected', { error: (error as Error).message });
          });
        }
      } catch (error) {
        // 单个订阅者异常不得影响其它订阅者
        log.error('event listener threw', { error: (error as Error).message });
      }
    }
    return true;
  }

  /** 仅用于测试与运维观测 */
  stats(): { listeners: number; dropped: number } {
    return { listeners: this.listeners.size, dropped: this.dropped };
  }

  reset(): void {
    this.listeners.clear();
    this.options = { ...DEFAULT_BUS_OPTIONS };
    this.dropped = 0;
    this.droppedLogged = 0;
  }
}

export const workflowEventBus = new WorkflowEventBus();

export interface BuildRecordEventInput {
  action: RecordChangedEvent['action'];
  domain: RecordChangedEvent['domain'];
  record: { id: string; name: string; type: string; value?: string; oldValue?: string };
  actor?: RecordChangedEvent['actor'];
  traceId?: string;
  depth?: number;
}

/**
 * 构造记录事件。类型非 A/AAAA 时返回 null —— 调用方无需自行判断。
 */
export function buildRecordEvent(input: BuildRecordEventInput): RecordChangedEvent | null {
  if (!ALLOWED_RECORD_TYPES.has(input.record.type)) return null;
  return {
    type: 'record.changed',
    action: input.action,
    domain: input.domain,
    record: {
      id: input.record.id,
      name: input.record.name,
      type: input.record.type as RecordType,
      value: input.record.value,
      oldValue: input.record.oldValue,
    },
    actor: input.actor ?? { source: 'ui' },
    traceId: input.traceId ?? randomUUID(),
    depth: input.depth ?? 0,
    at: new Date().toISOString(),
  };
}