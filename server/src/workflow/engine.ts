import { randomUUID } from 'node:crypto';
import { createLogger } from '../lib/logger';
import { workflowEventBus, type WorkflowEvent } from './event-bus';
import type { ExpressionNode } from './expression/nodes';
import { evaluate } from './expression/evaluator';
import type { Dispatcher } from './dispatch';
import type { Principal } from './auth';

const log = createLogger('Workflow').sub('Engine');

export interface WorkflowTrigger {
  readonly type: 'record.changed';
  readonly recordTypes: ReadonlyArray<'A' | 'AAAA'>;
}

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
}

export interface EngineDeps {
  listWorkflows(): Promise<WorkflowDefinition[]>;
  resolvePrincipal(workflow: WorkflowDefinition, event: WorkflowEvent): Promise<Principal>;
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

  private matches(workflow: WorkflowDefinition, event: WorkflowEvent): boolean {
    if (!workflow.enabled) return false;
    if (workflow.trigger.type !== event.type) return false;
    return workflow.trigger.recordTypes.includes(event.record.type);
  }

  async handleEvent(event: WorkflowEvent): Promise<RunRecord[]> {
    const now = this.deps.now ?? Date.now;
    const workflows = await this.deps.listWorkflows();
    const records: RunRecord[] = [];

    for (const workflow of workflows) {
      if (!this.matches(workflow, event)) continue;

      const traceId = event.traceId;
      const startedAt = new Date(now()).toISOString();
      const vars: Record<string, unknown> = {};

      try {
        const principal = await this.deps.resolvePrincipal(workflow, event);
        const call = (action: string, args: Record<string, unknown>) =>
          this.deps.dispatch(action, principal, args, {
            trigger: 'event',
            triggerType: event.type,
            vars,
            resource: { domainId: event.domain.id, domainName: event.domain.name },
          });

        if (workflow.condition) {
          const passed = await evaluate(workflow.condition, { event: event as unknown as Record<string, unknown>, vars, call });
          if (!passed) {
            records.push({
              workflowId: workflow.id,
              traceId,
              status: 'skipped',
              startedAt,
              finishedAt: new Date(now()).toISOString(),
            });
            continue;
          }
        }

        for (const action of workflow.actions) {
          await evaluate(action, { event: event as unknown as Record<string, unknown>, vars, call });
        }

        records.push({
          workflowId: workflow.id,
          traceId,
          status: 'success',
          startedAt,
          finishedAt: new Date(now()).toISOString(),
        });
      } catch (error) {
        const message = (error as Error).message;
        log.warn('workflow run failed', { workflowId: workflow.id, error: message });
        records.push({
          workflowId: workflow.id,
          traceId,
          status: 'failed',
          startedAt,
          finishedAt: new Date(now()).toISOString(),
          error: message,
        });
      }
    }

    for (const record of records) {
      try {
        await this.deps.onRun?.(record);
      } catch (error) {
        log.error('onRun hook failed', { error: (error as Error).message });
      }
    }

    return records;
  }
}

export function newTraceId(): string {
  return randomUUID();
}