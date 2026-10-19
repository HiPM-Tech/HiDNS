import { describe, it, expect, beforeEach } from 'vitest';
import { WorkflowEventBus, buildRecordEvent, workflowEventBus } from './event-bus';
import { buildDomainEvent } from '../lib/domain-event-bus';
import { domainEventBus } from '../lib/domain-event-bus';
import type { WorkflowEvent, AnyDomainEvent } from './event-bus';

const domain = { id: 1, name: 'example.com' };

function event(overrides: Partial<WorkflowEvent> = {}): WorkflowEvent {
  const base = buildRecordEvent({
    action: 'updated',
    domain,
    record: { id: 'r1', name: 'www', type: 'A', value: '1.2.3.4', oldValue: '5.6.7.8' },
  }) as WorkflowEvent;
  return { ...base, ...overrides };
}

describe('域名变更事件', () => {
  it('只保留 remark / is_hidden / enabled', () => {
    const built = buildDomainEvent({
      domain: { id: 1, name: 'a.com' },
      changedFields: ['remark', 'record_value', 'unknown'],
    });
    expect(built?.changedFields).toEqual(['remark']);
  });

  it('无有效字段时不产生事件', () => {
    expect(buildDomainEvent({ domain: { id: 1, name: 'a.com' }, changedFields: ['record_value'] })).toBeNull();
  });

  it('域名事件可通过总线', () => {
    const bus = new WorkflowEventBus();
    const built = buildDomainEvent({ domain: { id: 1, name: 'a.com' }, changedFields: ['enabled'] });
    expect(bus.publish(built as never)).toBe(true);
  });
});

describe('事件总线过滤', () => {
  let bus: WorkflowEventBus;
  beforeEach(() => {
    bus = new WorkflowEventBus();
  });

  it('只接受 A / AAAA 记录事件', () => {
    expect(bus.publish(event())).toBe(true);
    for (const type of ['CNAME', 'TXT', 'MX', 'NS', 'SRV', 'CAA']) {
      const built = buildRecordEvent({ action: 'updated', domain, record: { id: 'r2', name: 'x', type } });
      expect(built).toBeNull();
    }
  });

  it('AAAA 事件可通过', () => {
    const built = buildRecordEvent({ action: 'updated', domain, record: { id: 'r3', name: 'v6', type: 'AAAA', value: '2001:db8::1' } });
    expect(built?.record.type).toBe('AAAA');
    expect(bus.publish(built as WorkflowEvent)).toBe(true);
  });

  it('深度超限丢弃', () => {
    expect(bus.publish(event({ depth: 4 }))).toBe(false);
    expect(bus.publish(event({ depth: 3 }))).toBe(true);
  });

  it('工作流自身写入默认不触发', () => {
    expect(bus.publish(event({ actor: { source: 'workflow' } }))).toBe(false);
    bus.configure({ allowSelfTrigger: true });
    expect(bus.publish(event({ actor: { source: 'workflow' } }))).toBe(true);
  });

  it('订阅者异常不影响其它订阅者', async () => {
    const received: AnyDomainEvent[] = [];
    bus.subscribe(() => {
      throw new Error('boom');
    });
    bus.subscribe((e) => {
      received.push(e);
    });
    expect(bus.publish(event())).toBe(true);
    expect(received).toHaveLength(1);
  });

  it('异步订阅者 reject 不影响发布', async () => {
    const received: AnyDomainEvent[] = [];
    bus.subscribe(async () => {
      throw new Error('async boom');
    });
    bus.subscribe((e) => {
      received.push(e);
    });
    bus.publish(event());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(received).toHaveLength(1);
  });

  it('退订后不再收到事件', () => {
    const received: AnyDomainEvent[] = [];
    const off = bus.subscribe((e) => {
      received.push(e);
    });
    bus.publish(event());
    off();
    bus.publish(event());
    expect(received).toHaveLength(1);
    expect(bus.subscriberCount()).toBe(0);
  });

  it('buildRecordEvent 携带 oldValue 与 traceId', () => {
    const built = buildRecordEvent({
      action: 'updated',
      domain,
      record: { id: 'r1', name: 'www', type: 'A', value: '1.2.3.4', oldValue: '5.6.7.8' },
    });
    expect(built?.record.oldValue).toBe('5.6.7.8');
    expect(built?.traceId).toMatch(/[0-9a-f-]{36}/);
  });

  it('单例在模块加载时不持有订阅（无模块作用域副作用）', () => {
    expect(workflowEventBus.subscriberCount()).toBe(0);
  });

  it('工作流侧转发与主核心单例是同一实例（订阅互通）', () => {
    expect(workflowEventBus).toBe(domainEventBus);
    const off = domainEventBus.subscribe(() => undefined);
    expect(workflowEventBus.subscriberCount()).toBe(1);
    off();
  });
});