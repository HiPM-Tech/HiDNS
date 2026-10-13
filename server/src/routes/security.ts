import { Router } from 'express';
import { authMiddleware, adminOnly, noTokenAuth } from '../middleware/auth';
import { SecurityPolicyOperations, TrustedDeviceOperations, getDbType, UserOperations } from '../db/bal/business-adapter';
import { getSecurityPolicy, updateSecurityPolicy, checkPasswordStrength, validatePassword, requires2FA, has2FAEnabled } from '../service/securityPolicy';
import { generateTOTPSecret, enableTOTP, disableTOTP, getTOTPStatus, verifyTOTPToken, verifyTOTPTokenForUser, verifyBackupCode } from '../service/totp';
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
    res.status(500).json({ code: 1, msg: 'Failed to get security policy' });
  }
});

// 更新安全策略
router.put('/policy', authMiddleware, noTokenAuth('security settings'), adminOnly, async (req, res) => {
  try {
    const policy = req.body;
    await updateSecurityPolicy(policy);
    res.json({ code: 0, msg: 'Security policy updated' });
  } catch (error) {
    log.error('Failed to update security policy:', { error });
    res.status(500).json({ code: 1, msg: 'Failed to update security policy' });
  }
});

// 检查密码强度
router.post('/password-strength', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) {
      return res.status(400).json({ code: 1, msg: 'Password is required' });
    }

    const result = checkPasswordStrength(password);
    res.json({ code: 0, data: result, msg: 'success' });
  } catch (error) {
    log.error('Failed to check password strength:', { error });
    res.status(500).json({ code: 1, msg: 'Failed to check password strength' });
  }
});

// 验证密码是否符合策略
router.post('/validate-password', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) {
      return res.status(400).json({ code: 1, msg: 'Password is required' });
    }

    const result = await validatePassword(password);
    res.json({ code: 0, data: result, msg: 'success' });
  } catch (error) {
    log.error('Failed to validate password:', { error });
    res.status(500).json({ code: 1, msg: 'Failed to validate password' });
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
    res.status(500).json({ code: 1, msg: 'Failed to check 2FA requirement' });
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
    res.status(500).json({ code: 1, msg: 'Failed to check 2FA status' });
  }
});

// 获取指定用户的 2FA 生效状态（管理员功能）
router.get('/users/:userId/require-2fa', authMiddleware, noTokenAuth('security settings'), adminOnly, async (req, res) => {
  try {
    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ code: 1, msg: 'Invalid userId' });
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
    res.status(500).json({ code: 1, msg: 'Failed to get user 2FA requirement' });
  }
});

// 更新指定用户的 2FA 配置状态（管理员功能）
router.put('/users/:userId/require-2fa', authMiddleware, noTokenAuth('security settings'), adminOnly, async (req, res) => {
  try {
    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ code: 1, msg: 'Invalid userId' });
    }

    const { require2FA } = req.body;
    if (require2FA === undefined) {
      return res.status(400).json({ code: 1, msg: 'require2FA is required' });
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
    res.status(500).json({ code: 1, msg: 'Failed to update user 2FA requirement' });
  }
});

// 设置 TOTP 2FA
router.post('/2fa/setup', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const user = await UserOperations.getById(userId);

    if (!user) {
      return res.status(404).json({ code: 1, msg: 'User not found' });
    }

    const email = (user as { email?: string }).email;
    const username = (user as { username: string }).username;
    const setup = await generateTOTPSecret(userId, email || username);
    res.json({ code: 0, data: setup, msg: 'success' });
  } catch (error) {
    log.error('Failed to setup 2FA:', { error });
    res.status(500).json({ code: 1, msg: 'Failed to setup 2FA' });
  }
});

// 启用 TOTP 2FA
router.post('/2fa/enable', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const { secret, token, backupCodes } = req.body;

    if (!secret || !token || !backupCodes) {
      return res.status(400).json({ code: 1, msg: 'secret, token, and backupCodes are required' });
    }

    // 验证 TOTP 令牌
    if (!verifyTOTPToken(secret, token)) {
      return res.status(400).json({ code: 1, msg: 'Invalid verification code' });
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

    res.json({ code: 0, msg: '2FA enabled successfully' });
  } catch (error) {
    log.error('Failed to enable 2FA:', { error });
    res.status(500).json({ code: 1, msg: 'Failed to enable 2FA' });
  }
});

// 禁用 TOTP 2FA
router.post('/2fa/disable', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const { token } = req.body;

    const status = await getTOTPStatus(userId);
    if (!status.enabled) {
      return res.status(400).json({ code: 1, msg: '2FA is not enabled' });
    }

    // 必须校验当前 TOTP 令牌或备用码，否则会话一旦被窃取即可直接关闭 2FA
    const totpOk = await verifyTOTPTokenForUser(userId, token);
    const backupOk = totpOk ? false : await verifyBackupCode(userId, String(token || ''));
    if (!totpOk && !backupOk) {
      return res.status(400).json({ code: 1, msg: 'Invalid verification code' });
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

    res.json({ code: 0, msg: '2FA disabled successfully' });
  } catch (error) {
    log.error('Failed to disable 2FA:', { error });
    res.status(500).json({ code: 1, msg: 'Failed to disable 2FA' });
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
    res.status(500).json({ code: 1, msg: 'Failed to get trusted devices' });
  }
});

// 删除受信任设备
router.delete('/trusted-devices/:deviceId', authMiddleware, async (req, res) => {
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

      res.json({ code: 0, msg: 'Device removed' });
    } else {
      res.status(404).json({ code: 1, msg: 'Device not found' });
    }
  } catch (error) {
    log.error('Failed to remove trusted device:', { error });
    res.status(500).json({ code: 1, msg: 'Failed to remove trusted device' });
  }
});

// 删除所有受信任设备
router.delete('/trusted-devices', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    await TrustedDeviceOperations.deleteByUser(userId);
    res.json({ code: 0, msg: 'All devices removed' });
  } catch (error) {
    log.error('Failed to remove all trusted devices:', { error });
    res.status(500).json({ code: 1, msg: 'Failed to remove all trusted devices' });
  }
});

// 设置用户是否需要 2FA（管理员功能）
router.post('/user-require-2fa', authMiddleware, noTokenAuth('security settings'), adminOnly, async (req, res) => {
  try {
    const { userId, require2FA } = req.body;
    if (userId === undefined || require2FA === undefined) {
      return res.status(400).json({ code: 1, msg: 'userId and require2FA are required' });
    }

    await SecurityPolicyOperations.updateUser2FARequirement(userId, require2FA);
    res.json({ code: 0, msg: 'User 2FA requirement updated' });
  } catch (error) {
    log.error('Failed to update user 2FA requirement:', { error });
    res.status(500).json({ code: 1, msg: 'Failed to update user 2FA requirement' });
  }
});

export default router;
