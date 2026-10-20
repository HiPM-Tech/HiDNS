/**
 * 路由层共用的实时推送收件人判定。
 *
 * 为什么单独一个文件：域名续期（domains.ts）、用户管理（users.ts）、系统设置
 * （settings.ts）三处事件的 HTTP 读权限都是「管理员及以上」，如果各写一份，
 * 口径就会漂移——收件人算多就是把管理面信息推给普通用户，算少就是管理员收不到
 * 变更。特权判定只保留一份实现。
 *
 * 口径来源：
 *   - GET /renewable-domains（domains.ts）→ role >= ROLE_ADMIN
 *   - GET /users（users.ts）              → adminOnly（= isAdmin，role >= admin）
 *   - GET /settings/*（settings.ts）      → adminOnly
 * 三处都只看角色、不按归属过滤，因此收件人 = 全部「admin 及以上且账号未停用」的用户。
 *
 * 注意：停用账号不参与推送（登录态可能残留）；查询失败返回空集（fail-closed），
 * 调用方据此跳过投递，不得回退成全局广播。
 */

import { UserOperations } from '../db/bal/business-adapter';
import { ROLE_ADMIN } from '../utils/roles';
import { createLogger } from '../lib/logger';

const log = createLogger('HTTP').sub('Route').sub('Audience');

/**
 * admin 及以上、且账号未停用的用户 ID。
 *
 * 后续若 realtime-audience（service 层）补出同口径的 getAdminUserIds，
 * 这里应改为直接复用，避免两套特权判定并存。
 */
export async function getAdminAudienceUserIds(): Promise<number[]> {
  const audience = new Set<number>();
  try {
    const users = (await UserOperations.getAll()) as unknown as Array<{
      id?: number;
      role_level?: number;
      role?: number;
      status?: number;
    }>;
    for (const user of users) {
      const id = Number(user.id);
      if (!Number.isFinite(id) || id <= 0) continue;
      // 停用账号不参与推送，与登录态口径一致
      if (Number(user.status) !== 1) continue;
      // 用户表的查询把 role_level 同时投影成 role，两者缺失才算无名角色
      const level = Number(user.role_level ?? user.role ?? 0);
      if (level >= ROLE_ADMIN) audience.add(id);
    }
  } catch (error) {
    // fail-closed 且不缓存：算不出收件人就不推，管理端有列表刷新兜底
    log.error('Failed to resolve admin audience', { error });
    return [];
  }
  return [...audience];
}
