/**
 * EdgeOne 站点可见性缓存（60s）。
 *
 * 为什么需要它：账号优先后，每次 list/get/plan/replace 都要确认 `scopeId` 属于该账号，
 * 而确认方式是一次 `DescribeZones`（100 条/页，1000 个站点就是 10 次调用）。
 * 改造前 tencenteo 账号是零次（zone 由 third_id 锚定）；不加缓存会让事件触发的工作流
 * 直接撞上游限流，且 DescribeZones 失败会把**所有**源站组动作（含只读）一起拖挂。
 *
 * 键含 `accountId`：不同账号的同名站点不会互相冒充。
 */
const TTL_MS = 60_000;

const visibleZones = new Map<string, number>();

function keyOf(accountId: number, siteType: string, zoneId: string): string {
  return `${accountId}:${siteType}:${zoneId}`;
}

/** 命中缓存直接返回；未命中时调用 loader 并记录 */
export async function isZoneVisibleCached(
  params: { accountId: number; siteType: string; zoneId: string },
  loader: () => Promise<Array<{ zoneId: string; zoneName: string }>>,
): Promise<{ visible: boolean; zoneName?: string }> {
  const key = keyOf(params.accountId, params.siteType, params.zoneId);
  const hit = visibleZones.get(key);
  if (hit !== undefined && Date.now() - hit < TTL_MS) {
    // 缓存只记「可见」，站点名回落到 scopeId（仅用于日志与结果回显）
    return { visible: true, zoneName: params.zoneId };
  }

  const zones = await loader();
  const found = zones.find((zone) => zone.zoneId === params.zoneId);
  if (!found) return { visible: false };
  visibleZones.set(key, Date.now());
  return { visible: true, zoneName: found.zoneName || params.zoneId };
}

/** 仅供测试清理 */
export function resetZoneVisibilityCache(): void {
  visibleZones.clear();
}
