import { Router, Request, Response } from 'express';
import { authMiddleware, adminOnly } from '../middleware/auth';
import { McpOperations } from '../db/bal/business-adapter';
import { sendSuccess } from '../utils/http';
import { createLogger } from '../lib/logger';

const log = createLogger('MCP').sub('Route').sub('Audit');
const router = Router();

/**
 * @swagger
 * /api/mcp/audit-logs:
 *   get:
 *     summary: Get MCP audit logs (Authenticated)
 *     tags: [MCP]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: userId
 *         schema:
 *           type: number
 *       - in: query
 *         name: action
 *         schema:
 *           type: string
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *       - in: query
 *         name: page
 *         schema:
 *           type: number
 *       - in: query
 *         name: pageSize
 *         schema:
 *           type: number
 *     responses:
 *       200:
 *         description: Audit logs with pagination
 */
// 审计是全租户数据（含域名与来源 IP）：必须管理员，且 userId 不允许由 query 指定
router.get('/', authMiddleware, adminOnly, async (req: Request, res: Response) => {
  try {
    const userId = req.query.userId ? parseInt(req.query.userId as string) : undefined;
    const action = req.query.action as string | undefined;
    const startDate = req.query.startDate as string | undefined;
    const endDate = req.query.endDate as string | undefined;
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = Math.min(parseInt(req.query.pageSize as string) || 20, 100);

    const logs = await McpOperations.getAuditLogs({
      userId,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });

    // Quick client-side filtering for action/date range
    let filtered = logs;
    if (action) {
      filtered = filtered.filter(l => l.action.includes(action));
    }
    if (startDate) {
      const start = new Date(startDate);
      filtered = filtered.filter(l => new Date(l.created_at) >= start);
    }
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      filtered = filtered.filter(l => new Date(l.created_at) <= end);
    }

    sendSuccess(res, {
      logs: filtered,
      page,
      pageSize,
      totalPages: Math.ceil(filtered.length / pageSize),
      total: filtered.length,
    });
  } catch (error) {
    log.error('Failed to get audit logs', { error });
    res.status(500).json({ code: 500, msg: error instanceof Error ? error.message : 'Failed to get audit logs' });
  }
});

/**
 * @swagger
 * /api/mcp/audit-logs/export:
 *   get:
 *     summary: Export MCP audit logs
 *     tags: [MCP]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: format
 *         schema:
 *           type: string
 *           enum: [csv, json]
 *     responses:
 *       200:
 *         description: Exported audit logs
 */
router.get('/export', authMiddleware, adminOnly, async (req: Request, res: Response) => {
  try {
    const format = (req.query.format as string) || 'json';
    const userId = req.query.userId ? parseInt(req.query.userId as string) : undefined;
    const startDate = req.query.startDate as string | undefined;
    const endDate = req.query.endDate as string | undefined;

    let logs = await McpOperations.getAuditLogs({ userId, limit: 5000 });

    if (startDate) {
      const start = new Date(startDate);
      logs = logs.filter(l => new Date(l.created_at) >= start);
    }
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      logs = logs.filter(l => new Date(l.created_at) <= end);
    }

    if (format === 'csv') {
      const headers = 'id,user_id,auth_type,module,action,resource_type,resource_id,response_status,ip_address,created_at\n';
      // 与 service/auditExport.ts 同一套转义：字段可能来自用户输入（module/action/resource_id），
      // 不转义既是 CSV 结构破坏，也是公式注入入口。
      const cell = (value: unknown) => {
        let str = String(value ?? '');
        if (/^[=+\-@\t\r]/.test(str)) str = "'" + str;
        return /[",\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
      };
      const rows = logs.map(l => [
        l.id, l.user_id, l.auth_type, l.module, l.action,
        l.resource_type ?? '', l.resource_id ?? '', l.response_status ?? '', l.ip_address ?? '', l.created_at,
      ].map(cell).join(',')).join('\n');
      sendSuccess(res, {
        format: 'csv',
        content_type: 'text/csv',
        record_count: logs.length,
        data: headers + rows,
      });
    } else {
      sendSuccess(res, {
        format: 'json',
        content_type: 'application/json',
        record_count: logs.length,
        data: JSON.stringify(logs),
      });
    }
  } catch (error) {
    log.error('Failed to export audit logs', { error });
    res.status(500).json({ code: 500, msg: error instanceof Error ? error.message : 'Failed to export audit logs' });
  }
});

export default router;