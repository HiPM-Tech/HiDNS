import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { DnsAccountOperations, TeamOperations } from '../db/bal/business-adapter';
import { CloudflareAdapter } from '../lib/dns/providers';
import { DnsAccount } from '../types';
import { isSuper, normalizeRole } from '../utils/roles';
import { wsService } from '../service/websocket';
import { getAccountAudienceUserIds } from './audience';
import { createLogger } from '../lib/logger';

const log = createLogger('HTTP').sub('Route').sub('Tunnels');
const router = Router();

/**
 * 隧道事件的定向推送：收件人 = 能读到该隧道所属 DNS 账号的用户。
 *
 * 为什么需要它：tunnel_* 事件原本走 wsService.broadcast，payload 带 Cloudflare
 * 账号 ID 与隧道 ID，全局广播等于把「谁有哪条隧道」推给所有在线客户端。
 *
 * 口径直接复刻本文件的读路径：GET /tunnels 与 GET /:accountId/:tunnelId 都先用
 * getAccessibleCloudflareAccounts() 过滤（super 取全部；否则 created_by 或所属团队），
 * 与 routes/accounts.ts 的 canReadAccount() 等价，因此统一用
 * routes/audience.ts 的 getAccountAudienceUserIds()。
 * 收件人为空时跳过并记 warn，不回退全局广播（fail-closed）。
 */
async function pushTunnelEvent(account: DnsAccount, message: { type: string; data: unknown }): Promise<void> {
  try {
    const audience = await getAccountAudienceUserIds(account);
    if (audience.length === 0) {
      log.warn('No audience for tunnel event, skipped', { accountId: account.id, type: message.type });
      return;
    }
    wsService.broadcastToUsers(audience, message);
  } catch (error) {
    log.error('Failed to send tunnel event', { accountId: account.id, type: message.type, error });
  }
}

async function getAccessibleCloudflareAccounts(userId: number, role: number): Promise<DnsAccount[]> {
  if (isSuper(role)) {
    return await DnsAccountOperations.getByType('cloudflare') as unknown as DnsAccount[];
  }

  const teamIds = await TeamOperations.getTeamIdsByUserId(userId);

  if (teamIds.length > 0) {
    return await DnsAccountOperations.getByTypeAndUserOrTeams('cloudflare', userId, teamIds) as unknown as DnsAccount[];
  }

  return await DnsAccountOperations.getByTypeAndUser('cloudflare', userId) as unknown as DnsAccount[];
}

async function getCloudflareAccountByTunnelId(accountId: string, userId: number, role: number): Promise<DnsAccount | null> {
  const accounts = await getAccessibleCloudflareAccounts(userId, role);
  for (const acc of accounts) {
    try {
      // MySQL JSON type returns object directly, SQLite/PostgreSQL returns string
      const cfg = typeof acc.config === 'string' ? JSON.parse(acc.config) : acc.config;
      if (cfg.accountId === accountId) return acc;
    } catch {}
  }
  return null;
}

router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const accounts = await getAccessibleCloudflareAccounts(req.user!.userId, normalizeRole(req.user?.role));

    const allTunnels: any[] = [];
    for (const acc of accounts) {
      // MySQL JSON type returns object directly, SQLite/PostgreSQL returns string
      const cfg = typeof acc.config === 'string' ? JSON.parse(acc.config) : acc.config;
      if (!cfg.accountId) continue;
      const cf = new CloudflareAdapter(cfg);
      const tunnels = await cf.getTunnels(cfg.accountId);
      if (tunnels) {
        allTunnels.push(...tunnels.map((t: any) => ({ ...t, account_name: acc.name, account_id: cfg.accountId })));
      }
    }
    res.json({ code: 0, data: allTunnels, msg: 'success' });
  } catch (e) {
    res.json({ code: -1, msg: e instanceof Error ? e.message : String(e) });
  }
});

router.get('/:accountId/:tunnelId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const acc = await getCloudflareAccountByTunnelId(
      req.params.accountId,
      req.user!.userId,
      normalizeRole(req.user?.role)
    );
    if (!acc) return res.status(404).json({ code: 404, msg: 'Account not found' });

    // MySQL JSON type returns object directly, SQLite/PostgreSQL returns string
    const cfg = typeof acc.config === 'string' ? JSON.parse(acc.config) : acc.config;
    const cf = new CloudflareAdapter(cfg);
    const config = await cf.getTunnelConfig(req.params.accountId, req.params.tunnelId);
    res.json({ code: 0, data: config, msg: 'success' });
  } catch (e) {
    res.json({ code: -1, msg: e instanceof Error ? e.message : String(e) });
  }
});

router.put('/:accountId/:tunnelId/config', authMiddleware, async (req: Request, res: Response) => {
  try {
    const acc = await getCloudflareAccountByTunnelId(
      req.params.accountId,
      req.user!.userId,
      normalizeRole(req.user?.role)
    );
    if (!acc) return res.status(404).json({ code: 404, msg: 'Account not found' });

    // MySQL JSON type returns object directly, SQLite/PostgreSQL returns string
    const cfg = typeof acc.config === 'string' ? JSON.parse(acc.config) : acc.config;
    const cf = new CloudflareAdapter(cfg);
    const success = await cf.updateTunnelConfig(req.params.accountId, req.params.tunnelId, req.body.config);
    if (success) {
      // 推送 WebSocket 消息：只推给能读到该隧道所属账号的用户
      await pushTunnelEvent(acc, {
        type: 'tunnel_config_updated',
        data: {
          accountId: req.params.accountId,
          tunnelId: req.params.tunnelId,
        },
      });

      res.json({ code: 0, msg: 'success' });
    } else {
      res.json({ code: -1, msg: 'Failed to update tunnel config' });
    }
  } catch (e) {
    res.json({ code: -1, msg: e instanceof Error ? e.message : String(e) });
  }
});

router.delete('/:accountId/:tunnelId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const acc = await getCloudflareAccountByTunnelId(
      req.params.accountId,
      req.user!.userId,
      normalizeRole(req.user?.role)
    );
    if (!acc) return res.status(404).json({ code: 404, msg: 'Account not found' });

    // MySQL JSON type returns object directly, SQLite/PostgreSQL returns string
    const cfg = typeof acc.config === 'string' ? JSON.parse(acc.config) : acc.config;
    const cf = new CloudflareAdapter(cfg);
    const success = await cf.deleteTunnel(req.params.accountId, req.params.tunnelId);
    if (success) {
      // 推送 WebSocket 消息：只推给能读到该隧道所属账号的用户
      await pushTunnelEvent(acc, {
        type: 'tunnel_deleted',
        data: {
          accountId: req.params.accountId,
          tunnelId: req.params.tunnelId,
        },
      });

      res.json({ code: 0, msg: 'success' });
    } else {
      res.json({ code: -1, msg: 'Failed to delete tunnel' });
    }
  } catch (e) {
    res.json({ code: -1, msg: e instanceof Error ? e.message : String(e) });
  }
});

export default router;
