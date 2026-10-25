import { Router, type Request } from 'express';
import { getRequestIP } from '../middleware/clientIP';
import { sendError, sendSuccess } from '../utils/http';
import { authMiddleware, adminOnly, noTokenAuth } from '../middleware/auth';
import { SecurityPolicyOperations, TrustedDeviceOperations, getDbType, UserOperations } from '../db/bal/business-adapter';
import { getSecurityPolicy, updateSecurityPolicy, checkPasswordStrength, validatePassword, requires2FA, has2FAEnabled } from '../service/securityPolicy';
import { generateTOTPSecret, enableTOTP, disableTOTP, getTOTPStatus, verifyTOTPToken, verifyTOTPTokenForUser, verifyBackupCode } from '../service/totp';
import { verifyTrustedDevice, type DeviceInfo } from '../service/deviceTrust';
import { createLogger } from '../lib/logger';
import { wsService } from '../service/websocket';

const log = createLogger('HTTP').sub('Route').sub('Security');
const router = Router();

// 获取安全策略
router.get('/policy', authMiddleware, noTokenAuth('security settings'), adminOnly, async (req, res) => {
  try {
    const policy = await getSecurityPolicy();
    res.json({ code: 0, data: policy, msg: 'success' });
  } catch (error) {
    log.error('Failed to get security policy:', { error });
    sendError(res, 'Failed to get security policy', 500);
  }
});

// 更新安全策略
router.put('/policy', authMiddleware, noTokenAuth('security settings'), adminOnly, async (req, res) => {
  try {
    const policy = req.body;
    await updateSecurityPolicy(policy);
    sendSuccess(res, null, 'Security policy updated');
  } catch (error) {
    log.error('Failed to update security policy:', { error });
    sendError(res, 'Failed to update security policy', 500);
  }
});

// 检查密码强度
/**
 * 无鉴权端点的轻量节流：每秒 10 次。
 *
 * 键必须用 **真实 TCP 对端地址**（socket.remoteAddress），不能用 req.ip：
 * 生产模式 trust proxy 默认信任私有段反代，客户端伪造 X-Forwarded-For 就能绕过
 * （第三轮实测：并发 30 每条换 XFF → 200=30 / 429=0）。
 * 另外做一次惰性清理，避免 Map 无限增长。
 */
const strengthBuckets = new Map<string, { count: number; resetAt: number }>();
function allowPasswordStrengthCall(req: Request): boolean {
  const ip = req.socket?.remoteAddress ?? 'unknown';
  const now = Date.now();
  if (strengthBuckets.size > 5000) {
    for (const [key, bucket] of strengthBuckets) {
      if (bucket.resetAt <= now) strengthBuckets.delete(key);
    }
  }
  const bucket = strengthBuckets.get(ip);
  if (!bucket || bucket.resetAt <= now) {
    strengthBuckets.set(ip, { count: 1, resetAt: now + 1000 });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= 10;
}

router.post('/password-strength', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) {
      return sendError(res, 'Password is required', 400);
    }
    // 该端点无鉴权且会跑 zxcvbn：长度上限必须是「真实密码量级」。
    // 256 字符单次约 2.9s，4 并发即可把事件循环堵到 3.5s（第二轮实测）；
    // 72 是 bcrypt 的输入上限，超过部分本来也不参与校验。
    if (typeof password !== 'string' || password.length > 72) {
      return sendError(res, 'Password too long (max 72)', 400);
    }
    // 简单令牌桶：同一 IP 每秒最多 10 次，防止并发刷爆 CPU
    if (!allowPasswordStrengthCall(req)) {
      return sendError(res, 'Too many requests', 429);
    }

    const result = checkPasswordStrength(password);
    res.json({ code: 0, data: result, msg: 'success' });
  } catch (error) {
    log.error('Failed to check password strength:', { error });
    sendError(res, 'Failed to check password strength', 500);
  }
});

// 验证密码是否符合策略
router.post('/validate-password', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) {
      return sendError(res, 'Password is required', 400);
    }

    const result = await validatePassword(password);
    res.json({ code: 0, data: result, msg: 'success' });
  } catch (error) {
    log.error('Failed to validate password:', { error });
    sendError(res, 'Failed to validate password', 500);
  }
});

// 检查当前用户是否需要 2FA
router.get('/requires-2fa', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const required = await requires2FA(userId);
    res.json({ code: 0, data: { required }, msg: 'success' });
  } catch (error) {
    log.error('Failed to check 2FA requirement:', { error });
    sendError(res, 'Failed to check 2FA requirement', 500);
  }
});

// 检查当前用户是否已启用 2FA
router.get('/2fa-status', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const policy = await getSecurityPolicy();
    const status = await getTOTPStatus(userId);
    const validationEnabled = Boolean(policy.require2FAGlobal);
    res.json({
      code: 0,
      data: {
        ...status,
        configured: status.enabled,
        enabled: validationEnabled && status.enabled,
        validationEnabled,
      },
      msg: 'success',
    });
  } catch (error) {
    log.error('Failed to check 2FA status:', { error });
    sendError(res, 'Failed to check 2FA status', 500);
  }
});

// 获取指定用户的 2FA 生效状态（管理员功能）
router.get('/users/:userId/require-2fa', authMiddleware, noTokenAuth('security settings'), adminOnly, async (req, res) => {
  try {
    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      return sendError(res, 'Invalid userId', 400);
    }

    const policy = await getSecurityPolicy();
    const userSetting = await SecurityPolicyOperations.getUserSecuritySetting(userId);
    const configuredRequire2FA = userSetting?.require_2fa === 1 || userSetting?.require_2fa === true;
    const global2FAEnabled = Boolean(policy.require2FAGlobal);

    res.json({
      code: 0,
      data: {
        require2FA: global2FAEnabled,
        configuredRequire2FA,
        global2FAEnabled,
      },
      msg: 'success',
    });
  } catch (error) {
    log.error('Failed to get user 2FA requirement:', { error });
    sendError(res, 'Failed to get user 2FA requirement', 500);
  }
});

// 更新指定用户的 2FA 配置状态（管理员功能）
router.put('/users/:userId/require-2fa', authMiddleware, noTokenAuth('security settings'), adminOnly, async (req, res) => {
  try {
    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      return sendError(res, 'Invalid userId', 400);
    }

    const { require2FA } = req.body;
    if (require2FA === undefined) {
      return sendError(res, 'require2FA is required', 400);
    }

    await SecurityPolicyOperations.updateUser2FARequirement(userId, Boolean(require2FA));

    const policy = await getSecurityPolicy();
    const global2FAEnabled = Boolean(policy.require2FAGlobal);
    res.json({
      code: 0,
      data: {
        require2FA: global2FAEnabled,
        configuredRequire2FA: Boolean(require2FA),
        global2FAEnabled,
      },
      msg: 'User 2FA requirement updated',
    });
  } catch (error) {
    log.error('Failed to update user 2FA requirement:', { error });
    sendError(res, 'Failed to update user 2FA requirement', 500);
  }
});

// 设置 TOTP 2FA
router.post('/2fa/setup', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const user = await UserOperations.getById(userId);

    if (!user) {
      return sendError(res, 'User not found', 404);
    }

    const email = (user as { email?: string }).email;
    const username = (user as { username: string }).username;
    const setup = await generateTOTPSecret(userId, email || username);
    res.json({ code: 0, data: setup, msg: 'success' });
  } catch (error) {
    log.error('Failed to setup 2FA:', { error });
    sendError(res, 'Failed to setup 2FA', 500);
  }
});

// 启用 TOTP 2FA
router.post('/2fa/enable', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const { secret, token, backupCodes } = req.body;

    if (!secret || !token || !backupCodes) {
      return sendError(res, 'secret, token, and backupCodes are required', 400);
    }

    // 验证 TOTP 令牌
    if (!verifyTOTPToken(secret, token)) {
      return sendError(res, 'Invalid verification code', 400);
    }

    await enableTOTP(userId, secret, backupCodes);

    // 推送 WebSocket 消息给当前用户
    try {
      wsService.sendToClient(userId, {
        type: '2fa_enabled',
        data: {
          userId,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      log.error('Failed to send 2fa_enabled event', { error });
    }

    sendSuccess(res, null, '2FA enabled successfully');
  } catch (error) {
    log.error('Failed to enable 2FA:', { error });
    sendError(res, 'Failed to enable 2FA', 500);
  }
});

// 禁用 TOTP 2FA
router.post('/2fa/disable', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const { token } = req.body;

    const status = await getTOTPStatus(userId);
    if (!status.enabled) {
      return sendError(res, '2FA is not enabled', 400);
    }

    // 必须校验当前 TOTP 令牌或备用码，否则会话一旦被窃取即可直接关闭 2FA
    const totpOk = await verifyTOTPTokenForUser(userId, token);
    const backupOk = totpOk ? false : await verifyBackupCode(userId, String(token || ''));
    if (!totpOk && !backupOk) {
      return sendError(res, 'Invalid verification code', 400);
    }

    await disableTOTP(userId);

    // 推送 WebSocket 消息给当前用户
    try {
      wsService.sendToClient(userId, {
        type: '2fa_disabled',
        data: {
          userId,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      log.error('Failed to send 2fa_disabled event', { error });
    }

    sendSuccess(res, null, '2FA disabled successfully');
  } catch (error) {
    log.error('Failed to disable 2FA:', { error });
    sendError(res, 'Failed to disable 2FA', 500);
  }
});

// 获取用户的受信任设备列表
router.get('/trusted-devices', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const devices = await TrustedDeviceOperations.getByUser(userId);
    res.json({ code: 0, data: devices, msg: 'success' });
  } catch (error) {
    log.error('Failed to get trusted devices:', { error });
    sendError(res, 'Failed to get trusted devices', 500);
  }
});

// 删除受信任设备
router.delete('/trusted-devices/:deviceId', authMiddleware, noTokenAuth('trusted devices'), async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const { deviceId } = req.params;
    const changes = await TrustedDeviceOperations.deleteByUserAndId(userId, deviceId);

    if (changes > 0) {
      // 推送 WebSocket 消息给当前用户
      try {
        wsService.sendToClient(userId, {
          type: 'trusted_device_removed',
          data: {
            userId,
            deviceId,
            timestamp: new Date().toISOString(),
          },
        });
      } catch (error) {
        log.error('Failed to send trusted_device_removed event', { error });
      }

      sendSuccess(res, null, 'Device removed');
    } else {
      sendError(res, 'Device not found', 404);
    }
  } catch (error) {
    log.error('Failed to remove trusted device:', { error });
    sendError(res, 'Failed to remove trusted device', 500);
  }
});

// 删除所有受信任设备
// 可信设备是账号级安全设置：令牌不得操作
router.delete('/trusted-devices', authMiddleware, noTokenAuth('trusted devices'), async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    await TrustedDeviceOperations.deleteByUser(userId);
    sendSuccess(res, null, 'All devices removed');
  } catch (error) {
    log.error('Failed to remove all trusted devices:', { error });
    sendError(res, 'Failed to remove all trusted devices', 500);
  }
});

// 设置用户是否需要 2FA（管理员功能）
router.post('/user-require-2fa', authMiddleware, noTokenAuth('security settings'), adminOnly, async (req, res) => {
  try {
    const { userId, require2FA } = req.body;
    if (userId === undefined || require2FA === undefined) {
      return sendError(res, 'userId and require2FA are required', 400);
    }

    await SecurityPolicyOperations.updateUser2FARequirement(userId, require2FA);
    sendSuccess(res, null, 'User 2FA requirement updated');
  } catch (error) {
    log.error('Failed to update user 2FA requirement:', { error });
    sendError(res, 'Failed to update user 2FA requirement', 500);
  }
});

// 当前用户的 2FA 要求状态（原 routes/securityPolicy.ts 的独占端点，备用路由删除时迁移至此）
router.get('/2fa/requirement', authMiddleware, async (req, res) => {
  try {
    const userId = req.user!.userId;
    const policy = await getSecurityPolicy();
    const validationEnabled = Boolean(policy.require2FAGlobal);
    const forceRequired = validationEnabled && (await requires2FA(userId));
    const enabled = validationEnabled && (await has2FAEnabled(userId));

    res.json({
      code: 0,
      data: { enabled, forceRequired, validationEnabled, canSkip: !forceRequired },
      msg: 'success',
    });
  } catch (error) {
    log.error('Failed to get 2FA requirement', { error });
    res.status(500).json({ code: 500, msg: 'Failed to get 2FA requirement' });
  }
});

// 当前设备是否受信任（同上，迁移自 securityPolicy.ts）
router.post('/check-device', authMiddleware, async (req, res) => {
  try {
    const deviceInfo: DeviceInfo = {
      userAgent: req.headers['user-agent'] || '',
      ipAddress: getRequestIP(req),
    };
    const result = await verifyTrustedDevice(req.user!.userId, deviceInfo);
    res.json({ code: 0, data: result, msg: 'success' });
  } catch (error) {
    log.error('Failed to verify trusted device', { error });
    res.status(500).json({ code: 500, msg: 'Failed to verify trusted device' });
  }
});

export default router;
