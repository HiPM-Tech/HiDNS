import { randomUUID } from 'node:crypto';
import { createLogger } from '../lib/logger';
import { workflowEventBus, type WorkflowEvent } from './event-bus';
import type { AnyDomainEvent } from '../lib/domain-event-bus';
import type { ExpressionNode } from './expression/nodes';
import { evaluate, createEvalState } from './expression/evaluator';
import type { Dispatcher } from './dispatch';
import type { Principal } from './auth';

const log = createLogger('Workflow').sub('Engine');

/** 单次运行的硬上界（设计 §7.4：整体运行 30s） */
const RUN_TIMEOUT_MS = 30_000;

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
  /** 按 id 取工作流（含禁用）；缺省时退回 listWorkflows —— 后者在生产只含启用项 */
  getWorkflowById?(id: string): Promise<WorkflowDefinition | null>;
  /** 租户边界：工作流 owner 是否有权访问该事件域名 */
  canAccessDomain?(workflow: WorkflowDefinition, domain: { id: number; name: string }): Promise<boolean>;
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

  /**
   * 单次执行：handleEvent 与手动运行共用同一条路径。
   * 外层 30s 硬超时：挂起的动作若不设上界，会永久占用 inFlight，
   * 该工作流此后所有事件都会被记成 concurrent-run。
   */
  private async executeOne(
    workflow: WorkflowDefinition,
    event: AnyDomainEvent,
    trigger: 'event' | 'manual',
  ): Promise<RunRecord> {
    const now = this.deps.now ?? Date.now;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`运行超时（>${RUN_TIMEOUT_MS}ms）`));
      }, RUN_TIMEOUT_MS);
    });

    try {
      return await Promise.race([
        this.runWorkflow(workflow, event, trigger, controller.signal),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async runWorkflow(
    workflow: WorkflowDefinition,
    event: AnyDomainEvent,
    trigger: 'event' | 'manual',
    signal: AbortSignal,
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
          signal,
          resource: { domainId: event.domain.id, domainName: event.domain.name },
        });

      // 限额必须是**运行级**：condition 与全部 action 共享同一份 calls/deadline，
      // 否则每个根节点各拿一份预算，单次运行上限被放大为「根数 × 50」。
      const evalState = createEvalState(now);
      const evalCtx = { event: event as unknown as Record<string, unknown>, vars, call, now };

      if (workflow.condition) {
        const passed = await evaluate(workflow.condition, evalCtx, evalState);
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
        await evaluate(action, evalCtx, evalState);
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

      // 租户边界：owner 无权访问事件域名时不得执行（否则工作流会越权写他人域名）
      if (this.deps.canAccessDomain && !(await this.deps.canAccessDomain(workflow, event.domain))) {
        const nowIso = new Date((this.deps.now ?? Date.now)()).toISOString();
        records.push({
          workflowId: workflow.id,
          traceId: event.traceId,
          status: 'skipped',
          startedAt: nowIso,
          finishedAt: nowIso,
          error: 'no-domain-access',
          event,
        });
        continue;
      }

      // 并发保护：只对**同一目标**的重入跳过。
      // 键里带记录 id —— 否则批量导入 10 条不同记录时，后 9 条会被误丢弃。
      const flightKey = `${workflow.id}:${event.type === 'record.changed' ? event.record.id : '*'}`;
      if (this.inFlight.has(flightKey)) {
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

      this.inFlight.add(flightKey);
      try {
        records.push(await this.executeOne(workflow, event, 'event'));
      } finally {
        this.inFlight.delete(flightKey);
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
    // 手动运行不受 enabled 限制，因此不能只依赖 listEnabledDefinitions 的结果
    const workflow = this.deps.getWorkflowById
      ? await this.deps.getWorkflowById(workflowId)
      : (await this.deps.listWorkflows()).find((item) => item.id === workflowId) ?? null;
    if (!workflow) return null;

    const flightKey = `${workflow.id}:${event.type === 'record.changed' ? event.record.id : '*'}`;
    if (this.inFlight.has(flightKey)) return null;
    this.inFlight.add(flightKey);
    let record: RunRecord;
    try {
      record = await this.executeOne(workflow, event, 'manual');
    } finally {
      this.inFlight.delete(flightKey);
    }
    await this.report([record]);
    return record;
  }
}

export function newTraceId(): string {
  return randomUUID();
}