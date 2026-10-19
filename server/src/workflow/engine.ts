import { randomUUID } from 'node:crypto';
import { createLogger } from '../lib/logger';
import { workflowEventBus, type WorkflowEvent } from './event-bus';
import type { AnyDomainEvent } from '../lib/domain-event-bus';
import type { ExpressionNode } from './expression/nodes';
import { evaluate } from './expression/evaluator';
import type { Dispatcher } from './dispatch';
import type { Principal } from './auth';

const log = createLogger('Workflow').sub('Engine');

export interface RecordChangedTrigger {
  readonly type: 'record.changed';
  readonly recordTypes: ReadonlyArray<'A' | 'AAAA'>;
}

export interface DomainChangedTrigger {
  readonly type: 'domain.changed';
  /** 关心的字段；缺省表示任意字段变更都触发 */
  readonly fields?: readonly string[];
}

export interface NsChangedTrigger {
  readonly type: 'ns.changed';
  /** 关心的状态；缺省表示任意非 ok 状态变化 */
  readonly statuses?: readonly string[];
}

export interface WhoisExpiringTrigger {
  readonly type: 'whois.expiring';
  /** 仅在剩余天数 ≤ 该值时触发；缺省表示不限制 */
  readonly withinDays?: number;
}

export type WorkflowTrigger =
  | RecordChangedTrigger
  | DomainChangedTrigger
  | NsChangedTrigger
  | WhoisExpiringTrigger;

export interface WorkflowDefinition {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  /** 创建者（执行身份来源）；缺省表示不可执行 */
  readonly ownerId?: number;
  readonly trigger: WorkflowTrigger;
  readonly condition?: ExpressionNode;
  readonly actions: ExpressionNode[];
}

export type RunStatus = 'success' | 'failed' | 'skipped';

export interface RunRecord {
  readonly workflowId: string;
  readonly traceId: string;
  readonly status: RunStatus;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly error?: string;
  /** 触发本次运行的事件快照；供 `(...)` 预览与事后追溯使用 */
  readonly event?: AnyDomainEvent;
}

export interface EngineDeps {
  listWorkflows(): Promise<WorkflowDefinition[]>;
  resolvePrincipal(workflow: WorkflowDefinition, event: AnyDomainEvent): Promise<Principal>;
  dispatch: Dispatcher;
  onRun?(record: RunRecord): Promise<void> | void;
  now?(): number;
}

/**
 * 工作流引擎：触发器匹配 → 条件求值 → 顺序执行动作。
 * 设计依据：§7.1 执行模型
 *
 * 约束：
 * 1. 订阅必须在 start() 内建立，**禁止模块作用域副作用**；
 * 2. 单个工作流失败不得影响其它工作流；
 * 3. 每个动作都必须经 dispatch()（内含 authorize()）。
 */
export class WorkflowEngine {
  private unsubscribe: (() => void) | null = null;
  /** 同一工作流不允许并发执行：快速连续事件会重复写记录 */
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly deps: EngineDeps,
    private readonly bus = workflowEventBus,
  ) {}

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.bus.subscribe((event) => {
      void this.handleEvent(event).catch((error) => {
        log.error('engine handleEvent failed', { error: (error as Error).message });
      });
    });
    log.info('workflow engine started');
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private matches(workflow: WorkflowDefinition, event: AnyDomainEvent): boolean {
    if (!workflow.enabled) return false;
    if (workflow.trigger.type !== event.type) return false;

    if (event.type === 'record.changed') {
      return workflow.trigger.type === 'record.changed'
        ? workflow.trigger.recordTypes.includes(event.record.type)
        : false;
    }

    if (event.type === 'domain.changed') {
      if (workflow.trigger.type !== 'domain.changed') return false;
      const wanted = workflow.trigger.fields;
      if (!wanted || wanted.length === 0) return true;
      return event.changedFields.some((field) => wanted.includes(field));
    }

    if (event.type === 'ns.changed') {
      if (workflow.trigger.type !== 'ns.changed') return false;
      const statuses = workflow.trigger.statuses;
      if (!statuses || statuses.length === 0) return true;
      return statuses.includes(event.status);
    }

    if (workflow.trigger.type !== 'whois.expiring') return false;
    const within = workflow.trigger.withinDays;
    return within === undefined ? true : event.daysLeft <= within;
  }

  /** 单次执行：handleEvent 与手动运行共用同一条路径 */
  private async executeOne(
    workflow: WorkflowDefinition,
    event: AnyDomainEvent,
    trigger: 'event' | 'manual',
  ): Promise<RunRecord> {
    const now = this.deps.now ?? Date.now;
    const traceId = event.traceId;
    const startedAt = new Date(now()).toISOString();
    const vars: Record<string, unknown> = {};

    try {
      const principal = await this.deps.resolvePrincipal(workflow, event);
      // 防循环第二层：动作产生的写入事件深度 +1，并由总线按 maxDepth 丢弃
      const eventDepth = event.type === 'record.changed' ? event.depth : 0;
      const call = (action: string, args: Record<string, unknown>) =>
        this.deps.dispatch(action, principal, args, {
          trigger,
          triggerType: trigger === 'manual' ? 'manual' : event.type,
          vars,
          traceId: event.traceId,
          depth: eventDepth + 1,
          resource: { domainId: event.domain.id, domainName: event.domain.name },
        });

      const evalCtx = { event: event as unknown as Record<string, unknown>, vars, call };

      if (workflow.condition) {
        const passed = await evaluate(workflow.condition, evalCtx);
        if (!passed) {
          return {
            workflowId: workflow.id,
            traceId,
            status: 'skipped',
            startedAt,
            finishedAt: new Date(now()).toISOString(),
            event,
          };
        }
      }

      for (const action of workflow.actions) {
        await evaluate(action, evalCtx);
      }

      return {
        workflowId: workflow.id,
        traceId,
        status: 'success',
        startedAt,
        finishedAt: new Date(now()).toISOString(),
        event,
      };
    } catch (error) {
      const message = (error as Error).message;
      log.warn('workflow run failed', { workflowId: workflow.id, error: message });
      return {
        workflowId: workflow.id,
        traceId,
        status: 'failed',
        startedAt,
        finishedAt: new Date(now()).toISOString(),
        error: message,
        event,
      };
    }
  }

  private async report(records: RunRecord[]): Promise<void> {
    for (const record of records) {
      try {
        await this.deps.onRun?.(record);
      } catch (error) {
        log.error('onRun hook failed', { error: (error as Error).message });
      }
    }
  }

  async handleEvent(event: AnyDomainEvent): Promise<RunRecord[]> {
    const workflows = await this.deps.listWorkflows();
    const records: RunRecord[] = [];

    for (const workflow of workflows) {
      if (!this.matches(workflow, event)) continue;

      // 并发保护：同一工作流上一次还没跑完时跳过，避免重复写记录
      if (this.inFlight.has(workflow.id)) {
        const nowIso = new Date((this.deps.now ?? Date.now)()).toISOString();
        records.push({
          workflowId: workflow.id,
          traceId: event.traceId,
          status: 'skipped',
          startedAt: nowIso,
          finishedAt: nowIso,
          error: 'concurrent-run',
          event,
        });
        continue;
      }

      this.inFlight.add(workflow.id);
      try {
        records.push(await this.executeOne(workflow, event, 'event'));
      } finally {
        this.inFlight.delete(workflow.id);
      }
    }

    await this.report(records);
    return records;
  }

  /**
   * 手动运行：用户显式触发，**不受 enabled 与触发类型限制**，
   * 但仍走同一条 executeOne（鉴权、限额、审计完全一致）。
   * 设计依据：§4.1 `manual` 触发器。
   */
  async runSingle(workflowId: string, event: AnyDomainEvent): Promise<RunRecord | null> {
    const workflows = await this.deps.listWorkflows();
    const workflow = workflows.find((item) => item.id === workflowId);
    if (!workflow) return null;

    if (this.inFlight.has(workflow.id)) return null;
    this.inFlight.add(workflow.id);
    let record: RunRecord;
    try {
      record = await this.executeOne(workflow, event, 'manual');
    } finally {
      this.inFlight.delete(workflow.id);
    }
    await this.report([record]);
    return record;
  }
}

export function newTraceId(): string {
  return randomUUID();
}