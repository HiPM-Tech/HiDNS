import { randomUUID } from 'node:crypto';
import { createLogger } from './logger';

const log = createLogger('Domain').sub('EventBus');

/**
 * HiDNS 主核心 · 领域事件主线。
 *
 * 定位：**核心基础设施**，不属于工作流。任何会改变解析记录的路径（路由、服务、MCP）
 * 都经由这里发布；工作流只是订阅者之一。
 *
 * 约束（设计文档 §4.0.5 / §4.3 / §7.2）：
 * 1. 只发布 A / AAAA 记录事件，其余类型丢弃（fail-closed）；
 * 2. 深度超限丢弃；
 * 3. 工作流自身写入默认不触发；
 * 4. **不得在模块作用域注册订阅**。
 */

export type RecordType = 'A' | 'AAAA';
export type ActorSource = 'ui' | 'api' | 'token' | 'workflow' | 'system';

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

/** 域名生命周期与元信息变更。**不含解析值**。 */
export type DomainEventAction = 'created' | 'updated' | 'deleted' | 'renewed';

export interface DomainChangedEvent {
  readonly type: 'domain.changed';
  readonly action: DomainEventAction;
  readonly domain: { readonly id: number; readonly name: string; readonly accountId?: number };
  /** 发生变化的字段名；仅 action='updated' 时有意义 */
  readonly changedFields: readonly string[];
  readonly actor: { readonly userId?: number; readonly source: ActorSource };
  readonly traceId: string;
  readonly at: string;
}

export type NsStatus = 'ok' | 'mismatch' | 'missing' | 'poisoned';

/** NS 监控状态变化（由既有 NS 调度器产生） */
export interface NsChangedEvent {
  readonly type: 'ns.changed';
  readonly domain: { readonly id: number; readonly name: string };
  readonly status: NsStatus;
  readonly previousStatus: NsStatus;
  readonly actor: { readonly userId?: number; readonly source: ActorSource };
  readonly traceId: string;
  readonly at: string;
}

/** WHOIS 到期临近（由既有 WHOIS 调度器产生） */
export interface WhoisExpiringEvent {
  readonly type: 'whois.expiring';
  readonly domain: { readonly id: number; readonly name: string };
  readonly expiresAt: string;
  readonly daysLeft: number;
  readonly actor: { readonly userId?: number; readonly source: ActorSource };
  readonly traceId: string;
  readonly at: string;
}

export type DomainEvent = RecordChangedEvent;
export type AnyDomainEvent =
  | RecordChangedEvent
  | DomainChangedEvent
  | NsChangedEvent
  | WhoisExpiringEvent;
export type EventListener = (event: AnyDomainEvent) => void | Promise<void>;

export interface BusOptions {
  allowSelfTrigger: boolean;
  maxDepth: number;
}

export const DEFAULT_BUS_OPTIONS: BusOptions = { allowSelfTrigger: false, maxDepth: 3 };

const ALLOWED_RECORD_TYPES = new Set<string>(['A', 'AAAA']);

export class DomainEventBus {
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

  accepts(event: AnyDomainEvent): boolean {
    if (!this.options.allowSelfTrigger && event.actor.source === 'workflow') return false;
    if (event.type === 'domain.changed') {
      // 生命周期事件（创建/删除/续费）无需字段；更新必须有明确字段
      return event.action !== 'updated' || event.changedFields.length > 0;
    }
    if (event.type === 'ns.changed') {
      // 只有状态真的变化才有意义；重复告警不应反复触发工作流
      return event.status !== event.previousStatus;
    }
    if (event.type === 'whois.expiring') {
      return Number.isFinite(event.daysLeft);
    }
    if (!ALLOWED_RECORD_TYPES.has(event.record.type)) return false;
    if (event.depth > this.options.maxDepth) return false;
    return true;
  }

  publish(event: AnyDomainEvent): boolean {
    if (!this.accepts(event)) {
      this.dropped += 1;
      if (this.dropped === 1 || this.dropped - this.droppedLogged >= 100) {
        this.droppedLogged = this.dropped;
        log.debug('event dropped', { type: event.type, dropped: this.dropped });
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
        log.error('event listener threw', { error: (error as Error).message });
      }
    }
    return true;
  }

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

export const domainEventBus = new DomainEventBus();

export interface BuildRecordEventInput {
  action: RecordChangedEvent['action'];
  domain: RecordChangedEvent['domain'];
  record: { id: string; name: string; type: string; value?: string; oldValue?: string };
  actor?: RecordChangedEvent['actor'];
  traceId?: string;
  depth?: number;
}

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
    actor: input.actor ?? { source: 'api' },
    traceId: input.traceId ?? randomUUID(),
    depth: input.depth ?? 0,
    at: new Date().toISOString(),
  };
}

export interface PublishRecordInput extends BuildRecordEventInput {}

export function hasDomainEventSubscribers(): boolean {
  return domainEventBus.subscriberCount() > 0;
}

/** 域名事件允许携带的字段（其余字段变更与解析语义无关，不产生事件） */
export const DOMAIN_CHANGED_FIELDS = ['remark', 'is_hidden', 'enabled'] as const;

export interface BuildDomainEventInput {
  domain: { id: number; name: string; accountId?: number };
  action?: DomainEventAction;
  changedFields?: readonly string[];
  actor?: { userId?: number; source: ActorSource };
  traceId?: string;
}

export function buildDomainEvent(input: BuildDomainEventInput): DomainChangedEvent | null {
  const action = input.action ?? 'updated';
  const fields = (input.changedFields ?? []).filter((field) =>
    (DOMAIN_CHANGED_FIELDS as readonly string[]).includes(field),
  );
  // 更新事件必须指出具体字段；生命周期事件不需要
  if (action === 'updated' && !fields.length) return null;
  return {
    type: 'domain.changed',
    action,
    domain: input.domain,
    changedFields: fields,
    actor: input.actor ?? { source: 'api' },
    traceId: input.traceId ?? randomUUID(),
    at: new Date().toISOString(),
  };
}

/**
 * 发布入口：无订阅者时**零成本**（不构造事件、不额外查询）；失败绝不影响业务。
 */
export function publishRecordEvent(input: PublishRecordInput): void {
  try {
    if (!hasDomainEventSubscribers()) return;
    const event = buildRecordEvent(input);
    if (event) domainEventBus.publish(event);
  } catch {
    // 事件发布属于旁路，失败不得影响主流程
  }
}

export interface BuildNsEventInput {
  domain: { id: number; name: string };
  status: NsStatus;
  previousStatus: NsStatus;
  actor?: { userId?: number; source: ActorSource };
  traceId?: string;
}

export function publishNsEvent(input: BuildNsEventInput): void {
  try {
    if (!hasDomainEventSubscribers()) return;
    const event: NsChangedEvent = {
      type: 'ns.changed',
      domain: input.domain,
      status: input.status,
      previousStatus: input.previousStatus,
      actor: input.actor ?? { source: 'system' },
      traceId: input.traceId ?? randomUUID(),
      at: new Date().toISOString(),
    };
    domainEventBus.publish(event);
  } catch {
    // 旁路
  }
}

export interface BuildWhoisEventInput {
  domain: { id: number; name: string };
  expiresAt: string;
  daysLeft: number;
  actor?: { userId?: number; source: ActorSource };
  traceId?: string;
}

export function publishWhoisEvent(input: BuildWhoisEventInput): void {
  try {
    if (!hasDomainEventSubscribers()) return;
    const event: WhoisExpiringEvent = {
      type: 'whois.expiring',
      domain: input.domain,
      expiresAt: input.expiresAt,
      daysLeft: input.daysLeft,
      actor: input.actor ?? { source: 'system' },
      traceId: input.traceId ?? randomUUID(),
      at: new Date().toISOString(),
    };
    domainEventBus.publish(event);
  } catch {
    // 旁路
  }
}

export function publishDomainEvent(input: BuildDomainEventInput): void {
  try {
    if (!hasDomainEventSubscribers()) return;
    const event = buildDomainEvent(input);
    if (event) domainEventBus.publish(event);
  } catch {
    // 同上
  }
}