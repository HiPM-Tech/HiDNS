import { createLogger } from '../lib/logger';

const log = createLogger('Workflow').sub('MigrationReport');

/**
 * 迁移报告（设计 §904 兼容层）：dry-run 列出仍使用旧形态（domainId）的源站组动作。
 *
 * 为什么不自动迁移：DNSPod 复用场景下 `domainId → scopeId` **原理上无法推导**
 * （域名与 EdgeOne 站点无对应关系），自动迁移只能写空值或固化用户当年可能填错的 zoneId，
 * 属于静默数据破坏。这里只给出候选，让用户在真实站点列表里自己选。
 */
export interface LegacyOriginGroupNode {
  action: string;
  domainId: number;
  siteType?: string;
}

/** 从 DSL 里挑出仍带 domainId 的源站组动作（assign 包裹、条件树嵌套都要走到） */
export function collectLegacyOriginGroupNodes(actions: unknown[]): LegacyOriginGroupNode[] {
  const out: LegacyOriginGroupNode[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if (obj.kind === 'call' && typeof obj.action === 'string' && obj.action.startsWith('ext.tencenteo.originGroup.')) {
      const args = (obj.args ?? {}) as Record<string, unknown>;
      const domainId = Number((args.domainId as { value?: unknown })?.value ?? args.domainId);
      const hasAccount = args.accountId !== undefined;
      if (!hasAccount && Number.isFinite(domainId) && domainId > 0) {
        out.push({
          action: obj.action,
          domainId,
          siteType: String((args.siteType as { value?: unknown })?.value ?? args.siteType ?? '') || undefined,
        });
      }
    }
    for (const value of Object.values(obj)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  actions.forEach(visit);
  return out;
}

export interface MigrationReportDeps {
  resolveDomainAccount: (domainId: number) => Promise<{ accountId: number }>;
  accountLevel: (accountId: number) => Promise<'none' | 'read' | 'write'>;
  listZones: (accountId: number, options: { siteType?: string }) => Promise<Array<{ zoneId: string; zoneName: string }>>;
}

export interface MigrationReportEntry {
  workflowId: number;
  name: string;
  actions: Array<Record<string, unknown>>;
}

/**
 * 构造迁移报告。
 *
 * **顺序不可颠倒：先鉴权、再拉站点。**
 * 域名可能已经转给别人（或被撤销授权、被删后在他人账号下重建）；
 * 若先调 `listZones`，就会用**他人账号的凭据**执行 DescribeZones，
 * 把那个账号可见的全部站点（ZoneId + ZoneName）返回给调用者——
 * 正是候选源那一层刚堵掉的跨租户枚举面，不能从这个端点开后门。
 */
export async function buildMigrationReport(
  workflows: Array<{ id: number; name: string; actions?: unknown[] }>,
  deps: MigrationReportDeps,
): Promise<MigrationReportEntry[]> {
  const report: MigrationReportEntry[] = [];
  for (const workflow of workflows) {
    const legacy = collectLegacyOriginGroupNodes(workflow.actions ?? []);
    if (legacy.length === 0) continue;
    const entries: Array<Record<string, unknown>> = [];
    for (const node of legacy) {
      const entry: Record<string, unknown> = { action: node.action, domainId: node.domainId };
      try {
        const ref = await deps.resolveDomainAccount(node.domainId);
        entry.accountId = ref.accountId;
        const level = await deps.accountLevel(ref.accountId);
        entry.migratable = level !== 'none';
        if (level === 'none') {
          // 不可见就不打上游：候选站点留空，只提示去找账号所有者
          entry.candidateScopes = [];
          entry.hint = '该账号不属于你，无法生成候选站点；请联系账号所有者迁移';
        } else {
          entry.candidateScopes = await deps.listZones(ref.accountId, { siteType: node.siteType });
        }
      } catch (error) {
        entry.error = error instanceof Error ? error.message : String(error);
        entry.migratable = false;
        log.warn('migration report entry failed', { workflowId: workflow.id, error: entry.error });
      }
      entries.push(entry);
    }
    report.push({ workflowId: workflow.id, name: workflow.name, actions: entries });
  }
  return report;
}
