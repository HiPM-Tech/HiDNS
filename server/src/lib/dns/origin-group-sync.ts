import {
  OriginGroupError,
  assertPublicTarget,
  ipFamily,
  recordFingerprint,
  stableStringify,
  type OriginGroup,
  type OriginRecord,
} from './origin-group-core';

/**
 * 源站组按地址族同步（提供商中立）。
 *
 * 解决的问题：DDNS 把域名的 A/AAAA 记录改了之后，引用该域名的源站组里
 * 那些 IP 源站必须跟着改。与"整组收敛"不同，本模块**只替换对应地址族的记录**，
 * 其余记录（另一地址族、域名源站、对象存储源站）逐条原样保留，包括顺序、权重、
 * RecordId 与私有参数。
 *
 * 设计约束：
 * 1. 一个域名可能被**多个**源站组引用 → 支持多组批量计划与批量应用
 * 2. A 与 AAAA 可能**同时**变化 → 同一次计划、同一次写入，避免出现
 *    "v4 已新、v6 仍旧"的中间态
 * 3. 失败关闭：地址族缺失或同族多条时默认**不猜**，整组拒绝写入，
 *    调用方必须显式选择 addIfMissing / allowMultiple / onPartial
 * 4. 提交时按实时状态重算摘要，与预览不一致即拒绝（防 TOCTOU）
 */

export type AddressFamily = 'v4' | 'v6';

export interface AddressUpdate {
  v4?: string;
  v6?: string;
  /**
   * 旧值：给了就按值**精确匹配**，只替换这一条。
   *
   * 这是"族内有多条源站"时的正解 —— DDNS 事件本身带 `oldValue`，
   * 用它就能在不猜的前提下定位到该改的那一条，源站池里的其它记录原样保留。
   * 不给旧值时，族内多条一律视为歧义并拒绝。
   */
  from?: { v4?: string; v6?: string };
}

export interface GroupSyncOptions {
  /** 组内没有该地址族记录时是否新增一条源站；默认 false（不擅自新增） */
  addIfMissing?: boolean;
  /** 同族记录多于一条时是否全部替换为同一目标；默认 false（视为歧义） */
  allowMultiple?: boolean;
  /** 替换时保留原 RecordId；默认 true。同族多条被替换时自动放弃保留 */
  preserveRecordId?: boolean;
  /** 某个地址族无法处理时的策略：reject=整组拒绝（默认），apply=只应用可确定的族 */
  onPartial?: 'reject' | 'apply';
}

export interface FamilyChange {
  family: AddressFamily;
  /** 被替换的原值（新增时为空数组） */
  from: string[];
  to: string;
}

export interface SkippedFamily {
  family: AddressFamily;
  code: 'FAMILY_ABSENT' | 'FAMILY_AMBIGUOUS' | 'FROM_NOT_FOUND';
  message: string;
  /**
   * 是否应阻断整组写入。
   * - 歧义 / 族缺失：无法判断意图，阻断
   * - 旧值未命中：能确定"这个组没在跟踪该地址"，属于无事可做，不阻断
   */
  blocking: boolean;
}

export interface GroupSyncPlan {
  groupId: string;
  name: string;
  before: OriginRecord[];
  after: OriginRecord[];
  changes: FamilyChange[];
  skipped: SkippedFamily[];
  /** 有实际改动 */
  changed: boolean;
  /** 已是目标状态，无需写入 */
  noop: boolean;
  /** 存在无法处理的地址族且策略为 reject */
  blocked: boolean;
  references: OriginGroup['references'];
  /**
   * 提交闸门摘要：**只覆盖本次要改的地址族**。
   * 无关族的漂移（例如并发的 AAAA 事件刚改完 IPv6）不应让本次 v4 同步失效，
   * 因为写入时按实时状态重新规划，无关记录会被原样保留。
   */
  digest: string;
  /** 整组摘要：供人工复核与审计，记录"预览时这组长什么样" */
  fullDigest: string;
}

const FAMILY_NUMBER: Record<AddressFamily, 4 | 6> = { v4: 4, v6: 6 };
const FAMILY_ORDER: AddressFamily[] = ['v4', 'v6'];

/** 校验并规范化地址：族必须与槽位一致，且必须是公网可路由目标 */
export function normalizeAddressUpdate(update: AddressUpdate): AddressUpdate {
  const normalized: AddressUpdate = {};
  for (const family of FAMILY_ORDER) {
    const raw = update[family];
    if (raw === undefined || raw === null) continue;
    const value = String(raw).trim().replace(/^\[(.*)\]$/, '$1');
    if (!value) throw new OriginGroupError('INVALID_ADDRESS', `${family} 目标为空`);
    const actual = ipFamily(value);
    if (actual === 0) {
      throw new OriginGroupError('INVALID_ADDRESS', `${family} 目标不是 IP 字面量: ${value}`);
    }
    if (actual !== FAMILY_NUMBER[family]) {
      throw new OriginGroupError(
        'ADDRESS_FAMILY_MISMATCH',
        `${family} 槽位收到 IPv${actual} 地址: ${value}`,
      );
    }
    assertPublicTarget({ record: value, type: 'IP_DOMAIN' });
    normalized[family] = value;

    // 旧值：族必须匹配；不校验公网性 —— 旧值可能是历史遗留的内网地址，
    // 拒绝它会让"清理这条内网源站"变得无法执行
    const rawFrom = update.from?.[family];
    if (rawFrom !== undefined && rawFrom !== null) {
      const fromValue = String(rawFrom).trim().replace(/^\[(.*)\]$/, '$1');
      if (fromValue) {
        const fromFamily = ipFamily(fromValue);
        if (fromFamily !== FAMILY_NUMBER[family]) {
          throw new OriginGroupError(
            'ADDRESS_FAMILY_MISMATCH',
            `${family} 旧值不是 IPv${FAMILY_NUMBER[family]} 地址: ${fromValue}`,
          );
        }
        normalized.from = { ...normalized.from, [family]: fromValue };
      }
    }
  }
  if (!normalized.v4 && !normalized.v6) {
    throw new OriginGroupError('INVALID_UPDATE', '至少需要一个地址族的更新值');
  }
  return normalized;
}

/**
 * 写后回读比对口径。
 * - 值与顺序必须一致
 * - 类型必须一致
 * - 计划里**明确给了**权重才比对权重：服务端会给未指定权重的记录补默认值（EdgeOne 补 100），
 *   把"服务端补默认值"当成写入失败会掩盖真正的失败
 * - 不比对 RecordId：新增记录的服务端 ID 在计划阶段还不存在
 */
function sameShape(actual: OriginRecord[], expected: OriginRecord[]): boolean {
  if (actual.length !== expected.length) return false;
  for (let i = 0; i < expected.length; i += 1) {
    if (actual[i].record !== expected[i].record) return false;
    if (actual[i].type !== expected[i].type) return false;
    if (expected[i].weight !== undefined && actual[i].weight !== expected[i].weight) return false;
  }
  return true;
}

function computeFullDigest(groupId: string, before: OriginRecord[], after: OriginRecord[]): string {
  return stableStringify({
    g: groupId,
    b: before.map(recordFingerprint),
    a: after.map(recordFingerprint),
  });
}

function recordFamily(record: OriginRecord): AddressFamily | null {
  const family = ipFamily(record.record);
  return family === 4 ? 'v4' : family === 6 ? 'v6' : null;
}

/**
 * 作用域摘要：只取本次涉及的地址族的记录。
 * 这些记录若在预览与提交之间被别人改动，必须拒绝；其它族的改动不影响本次写入，
 * 因为写入时是按实时状态重新规划的，无关记录原样保留。
 */
function computeScopeDigest(
  groupId: string,
  before: OriginRecord[],
  after: OriginRecord[],
  families: AddressFamily[],
): string {
  const pick = (records: OriginRecord[]) =>
    records
      .filter((record) => {
        const family = recordFamily(record);
        return family !== null && families.includes(family);
      })
      .map(recordFingerprint);
  return stableStringify({
    g: groupId,
    f: [...families].sort(),
    b: pick(before),
    a: pick(after),
  });
}

/**
 * 计算单个源站组的同步计划（纯函数，不发起请求）。
 *
 * 只触碰 `type === 'IP_DOMAIN'` 且值为 IP 字面量、且族别匹配的记录。
 * 域名型源站（例如 `xc.server.example.com`）虽然同为 IP_DOMAIN，
 * 但不是 IP 字面量，一律不动 —— 这是"只同步地址，不改拓扑"的边界。
 */
export function planGroupSync(
  group: OriginGroup,
  update: AddressUpdate,
  options: GroupSyncOptions = {},
): GroupSyncPlan {
  const normalized = normalizeAddressUpdate(update);
  const addIfMissing = options.addIfMissing === true;
  const allowMultiple = options.allowMultiple === true;
  const preserveRecordId = options.preserveRecordId !== false;
  const onPartial = options.onPartial ?? 'reject';

  const before = group.records.map((r) => ({ ...r }));
  const after = group.records.map((r) => ({ ...r }));
  const changes: FamilyChange[] = [];
  const skipped: SkippedFamily[] = [];

  for (const family of FAMILY_ORDER) {
    const value = normalized[family];
    if (!value) continue;

    const indices: number[] = [];
    for (let i = 0; i < after.length; i += 1) {
      const record = after[i];
      if (record.type !== 'IP_DOMAIN') continue;
      if (ipFamily(record.record) !== FAMILY_NUMBER[family]) continue;
      indices.push(i);
    }

    // ① 给了旧值：按值精确定位，族内多条也不歧义，源站池其余记录不动
    const fromValue = normalized.from?.[family];
    if (fromValue) {
      const matched = indices.filter((i) => after[i].record.trim() === fromValue);
      if (matched.length === 0) {
        skipped.push({
          family,
          code: 'FROM_NOT_FOUND',
          message: `源站组内没有 ${fromValue} 这条 IPv${FAMILY_NUMBER[family]} 源站，视为未跟踪该地址`,
          blocking: false,
        });
        continue;
      }
      const alreadyTarget = matched.every((i) => after[i].record === value);
      if (alreadyTarget) continue; // 已是目标值
      const replaceFrom = matched.map((i) => after[i].record);
      const keepId = preserveRecordId && matched.length === 1;
      for (const i of matched) {
        after[i] = {
          ...after[i],
          record: value,
          ...(keepId ? {} : { recordId: undefined }),
        };
      }
      changes.push({ family, from: replaceFrom, to: value });
      continue;
    }

    // ② 未给旧值：族内必须唯一，否则不猜
    if (indices.length === 0) {
      if (addIfMissing) {
        after.push({ record: value, type: 'IP_DOMAIN' });
        changes.push({ family, from: [], to: value });
      } else {
        skipped.push({
          family,
          code: 'FAMILY_ABSENT',
          message: `源站组内没有 IPv${FAMILY_NUMBER[family]} 源站，未新增（需 addIfMissing: true）`,
          blocking: true,
        });
      }
      continue;
    }

    if (indices.length > 1 && !allowMultiple) {
      skipped.push({
        family,
        code: 'FAMILY_AMBIGUOUS',
        message:
          `源站组内有 ${indices.length} 条 IPv${FAMILY_NUMBER[family]} 源站，无法确定替换哪一条` +
          `（请传 ${family} 旧值做精确匹配，或用 allowMultiple: true 全部替换）`,
        blocking: true,
      });
      continue;
    }

    const from = indices.map((i) => after[i].record);
    if (from.every((v) => v === value)) continue; // 已是目标值

    // 同族多条被替换时无法保持各自的 RecordId 身份，一律放弃保留
    const keepId = preserveRecordId && indices.length === 1;
    for (const i of indices) {
      after[i] = {
        ...after[i],
        record: value,
        ...(keepId ? {} : { recordId: undefined }),
      };
    }
    changes.push({ family, from, to: value });
  }

  const changed = changes.length > 0;
  const blockingSkips = skipped.filter((item) => item.blocking);
  const blocked = blockingSkips.length > 0 && onPartial === 'reject';
  const requestedFamilies = FAMILY_ORDER.filter((family) => normalized[family] !== undefined);

  return {
    groupId: group.groupId,
    name: group.name,
    before,
    after,
    changes,
    skipped,
    changed,
    noop: !changed && blockingSkips.length === 0,
    blocked,
    references: group.references,
    digest: computeScopeDigest(group.groupId, before, after, requestedFamilies),
    fullDigest: computeFullDigest(group.groupId, before, after),
  };
}

/** 引用某个域名的源站组：用于"一个域名变动多个源站组"的自动扇出 */
export function selectGroupsForDomain(groups: OriginGroup[], fqdn: string): OriginGroup[] {
  const target = String(fqdn ?? '').trim().toLowerCase();
  if (!target) return [];
  return groups.filter((group) =>
    group.references.some((ref) => String(ref.name ?? '').trim().toLowerCase() === target),
  );
}

/** 批量摘要：按组 ID 排序后聚合，保证组顺序不影响结果 */
export function computeSyncSetDigest(plans: GroupSyncPlan[]): string {
  const parts = [...plans]
    .sort((a, b) => (a.groupId < b.groupId ? -1 : a.groupId > b.groupId ? 1 : 0))
    .map((plan) => ({ g: plan.groupId, d: plan.digest, b: plan.blocked ? 1 : 0 }));
  return stableStringify(parts);
}

export interface OriginGroupOps {
  get(groupId: string): Promise<OriginGroup | null>;
  replace(groupId: string, records: OriginRecord[]): Promise<{ requestId?: string }>;
}

export interface SyncRequest {
  groupIds: string[];
  update: AddressUpdate;
  options?: GroupSyncOptions;
}

export interface SyncPlanSet {
  plans: GroupSyncPlan[];
  /** 有改动且未被阻塞的组 */
  applicable: GroupSyncPlan[];
  /** 存在被阻塞的组 */
  hasBlocked: boolean;
  digest: string;
}

function dedupeGroupIds(groupIds: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of groupIds) {
    const id = String(raw ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** 先规划、后确认：把所有组的计划一次性算出来给操作者看 */
export async function planSyncSet(ops: OriginGroupOps, request: SyncRequest): Promise<SyncPlanSet> {
  const ids = dedupeGroupIds(request.groupIds);
  if (ids.length === 0) throw new OriginGroupError('NO_TARGET_GROUP', '未指定任何源站组');

  const plans: GroupSyncPlan[] = [];
  for (const groupId of ids) {
    const group = await ops.get(groupId);
    if (!group) throw new OriginGroupError('GROUP_NOT_FOUND', `源站组不存在: ${groupId}`);
    plans.push(planGroupSync(group, request.update, request.options));
  }

  const applicable = plans.filter((plan) => plan.changed && !plan.blocked);
  return {
    plans,
    applicable,
    hasBlocked: plans.some((plan) => plan.blocked),
    digest: computeSyncSetDigest(plans),
  };
}

export interface GroupSyncResult {
  groupId: string;
  status: 'applied' | 'noop' | 'blocked' | 'failed';
  requestId?: string;
  error?: string;
  plan: GroupSyncPlan;
}

export interface ApplySyncOptions {
  /** 首个失败后是否停止后续写入；默认 true（避免半途状态扩散） */
  stopOnError?: boolean;
  /** 写入后是否回读校验；默认 true */
  verify?: boolean;
}

/**
 * 应用同步：按实时状态重新规划，摘要不一致即拒绝。
 * 返回每个组的结果；部分失败不会回滚已写入的组（源站组接口无事务），
 * 因此结果里逐组给出 requestId，便于人工按快照回退。
 */
export async function applySyncSet(
  ops: OriginGroupOps,
  request: SyncRequest,
  expectedDigest: string,
  applyOptions: ApplySyncOptions = {},
): Promise<{ results: GroupSyncResult[]; digest: string }> {
  const stopOnError = applyOptions.stopOnError !== false;
  const verify = applyOptions.verify !== false;

  const fresh = await planSyncSet(ops, request);
  if (fresh.digest !== expectedDigest) {
    throw new OriginGroupError('DIGEST_MISMATCH', '源站组状态已变化，与预览不一致，请重新 plan');
  }
  if (fresh.hasBlocked) {
    const blocked = fresh.plans.filter((plan) => plan.blocked).map((plan) => plan.groupId);
    throw new OriginGroupError('SYNC_BLOCKED', `以下源站组存在无法处理的地址族: ${blocked.join(', ')}`);
  }

  const results: GroupSyncResult[] = [];
  for (const plan of fresh.plans) {
    if (!plan.changed) {
      results.push({ groupId: plan.groupId, status: 'noop', plan });
      continue;
    }
    try {
      const { requestId } = await ops.replace(plan.groupId, plan.after);
      if (verify) {
        const after = await ops.get(plan.groupId);
        if (!sameShape(after?.records ?? [], plan.after)) {
          results.push({
            groupId: plan.groupId,
            status: 'failed',
            requestId,
            error: '写入后回读与计划不一致',
            plan,
          });
          if (stopOnError) break;
          continue;
        }
      }
      results.push({ groupId: plan.groupId, status: 'applied', requestId, plan });
    } catch (error) {
      results.push({
        groupId: plan.groupId,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        plan,
      });
      if (stopOnError) break;
    }
  }

  return { results, digest: fresh.digest };
}
