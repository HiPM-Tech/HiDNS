import { Router, type Request, type Response } from 'express';
import { authMiddleware, adminOnly } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/errorHandler';
import { getAuditLogs } from '../../service/auditExport';
import { getString, parseInteger, parsePagination, sendSuccess } from '../../utils/http';

/**
 * @swagger
 * /api/logs:
 *   get:
 *     summary: Get operation logs (admin only)
 *     tags: [Logs]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: pageSize
 *         schema:
 *           type: integer
 *       - in: query
 *         name: domain
 *         schema:
 *           type: string
 *       - in: query
 *         name: userId
 *         schema:
 *           type: integer
 *       - in: query
 *         name: action
 *         schema:
 *           type: string
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           example: 2026-04-01
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           example: 2026-04-04
 *     responses:
 *       200:
 *         description: Operation logs
 */
const router = Router();

router.get('/', authMiddleware, adminOnly, asyncHandler(async (req: Request, res: Response) => {
  const { page, pageSize } = parsePagination(req.query, { defaultPageSize: 50, maxPageSize: 200 });
  const { total, logs: records } = await getAuditLogs(page, pageSize, {
    domain: getString(req.query.domain),
    userId: parseInteger(req.query.userId),
    action: getString(req.query.action),
    startDate: getString(req.query.startDate),
    endDate: getString(req.query.endDate),
  });

  sendSuccess(res, {
    total,
    list: records.map((row) => ({
      id: row.id,
      user_id: row.userId,
      username: row.username,
      nickname: row.nickname,
      action: row.action,
      domain: row.domain,
      data: JSON.stringify(row.data),
      created_at: row.createdAt,
    })),
  });
}));

export default router;
