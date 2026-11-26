import { Router, Request, Response } from 'express';
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { authMiddleware, noTokenAuth } from '../middleware/auth';
import { getUserWebAuthnCredentials, addWebAuthnCredential, deleteWebAuthnCredential, updateWebAuthnCredentialCounter, pickCredentialResponse } from '../service/webauthn';
import { UserOperations } from '../db/bal/business-adapter';
import crypto from 'crypto';
import { sendError } from '../utils/http';
import { createLogger } from '../lib/logger';

const log = createLogger('Auth').sub('WebAuthn');

const router = Router();
// 通行密钥是认证因子：只允许 JWT 会话操作，API 令牌不得增删凭证。
// 否则一枚 DNS 用途的长期令牌就能删除受害者的全部通行密钥（若为唯一第二因子则 2FA 归零），
// 或添加攻击者自己的密钥。

// Store challenges temporarily
const userChallengeStore = new Map<number, string>();
const loginChallengeStore = new Map<number, string>(); // user_id -> challenge
(global as any).loginChallengeStore = loginChallengeStore;

// Ensure RP name and ID match your deployment
const rpName = 'HiDNS';

/**
 * 从请求推导 RP ID / Origin（部署端口、域名不必手配环境变量）。
 * 显式设置 WEBAUTHN_RP_ID / WEBAUTHN_ORIGIN 时仍以环境变量为准。
 */
export function resolveWebAuthnConfig(req: Request): { rpID: string; origin: string } {
  const forwardedHost = String(req.headers['x-forwarded-host'] ?? '').split(',')[0].trim();
  const host = forwardedHost || req.get('host') || 'localhost';
  const forwardedProto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
  const proto = forwardedProto || req.protocol || 'http';
  const hostname = host.replace(/:\d+$/, '');
  const rpID = process.env.WEBAUTHN_RP_ID || hostname || 'localhost';
  const origin = process.env.WEBAUTHN_ORIGIN || `${proto}://${host}`;
  return { rpID, origin };
}

router.get('/registration-options', authMiddleware, noTokenAuth('passkeys'), async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const user = await UserOperations.getById(userId) as { username: string } | undefined;
  if (!user) return sendError(res, 'User not found', 404);

  const userCredentials = await getUserWebAuthnCredentials(userId);

  const { rpID } = resolveWebAuthnConfig(req);
  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userID: new Uint8Array(Buffer.from(userId.toString())),
    userName: String(user.username),
    excludeCredentials: userCredentials.map(cred => ({
      id: cred.id,
      transports: cred.transports as any[],
    })),
    authenticatorSelection: {
      // 不限定 authenticatorAttachment：写成 'platform' 会让没有 Touch ID / Windows Hello
      // 的机器（Linux 桌面、外接 USB 安全密钥）直接抛「找不到硬件」（issue #57）。
      // residentKey 保持 preferred：既能当可发现凭据，也不强制要求驻留。
      residentKey: 'preferred',
      // 与校验侧的 requireUserVerification 共用同一开关：
    // 只改校验不改选项，开 WEBAUTHN_REQUIRE_UV=1 后浏览器不会强制 UV，
    // 用户只会看到「验证失败」而不是被要求按指纹/PIN。
    userVerification: process.env.WEBAUTHN_REQUIRE_UV !== '0' ? 'required' : 'preferred',
    },
  });

  if (!options.challenge) {
    sendError(res, 'Failed to generate challenge', 500);
    return;
  }

  userChallengeStore.set(userId, options.challenge);
  res.json({ code: 0, data: options, msg: 'success' });
});

router.post('/registration-verify', authMiddleware, noTokenAuth('passkeys'), async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const body = req.body;
  const expectedChallenge = userChallengeStore.get(userId);

  if (!expectedChallenge) return sendError(res, 'Challenge not found', 400);

  try {
    const { rpID, origin } = resolveWebAuthnConfig(req);
    const verification = await verifyRegistrationResponse({
      response: pickCredentialResponse(body) as never,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      // 与 options 的 userVerification: 'preferred' 对齐。
      // 库默认是 requireUserVerification: true —— 那样「无 PIN 的 USB 安全密钥」
      // 能注册进选项却必然校验失败（User verification required...），
      // 正是 #57 放开 authenticatorAttachment 之后暴露出来的一类设备。
      requireUserVerification: process.env.WEBAUTHN_REQUIRE_UV !== '0',
    });

    if (verification.verified && verification.registrationInfo) {
      const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
      
      await addWebAuthnCredential({
        id: credential.id,
        user_id: userId,
        public_key: Buffer.from(credential.publicKey).toString('base64'),
        counter: credential.counter,
        device_type: credentialDeviceType,
        backed_up: credentialBackedUp,
        transports: credential.transports || [],
        name: body.name || 'Passkey',
      });

      userChallengeStore.delete(userId);
      res.json({ code: 0, msg: 'success' });
    } else {
      res.status(400).json({ code: 400, msg: 'Verification failed' });
    }
  } catch (error) {
    // 与 /login、/oauth/2fa 同口径：库异常原文只进日志，响应给固定文案。
    log.error('WebAuthn registration verification failed', { error: error instanceof Error ? error.message : String(error) });
    res.status(400).json({ code: 400, msg: '通行密钥注册验证失败，请重试', data: { kind: 'webauthn' } });
  }
});

router.get('/credentials', authMiddleware, noTokenAuth('passkeys'), async (req: Request, res: Response) => {
  const creds = await getUserWebAuthnCredentials(req.user!.userId);
  res.json({ code: 0, data: creds.map(c => ({ id: c.id, name: c.name, created_at: c.created_at, last_used_at: c.last_used_at })), msg: 'success' });
});

router.delete('/credentials/:id', authMiddleware, noTokenAuth('passkeys'), async (req: Request, res: Response) => {
  await deleteWebAuthnCredential(req.user!.userId, req.params.id);
  res.json({ code: 0, msg: 'success' });
});

router.get('/login-options', async (req: Request, res: Response) => {
  const username = req.query.username as string;
  if (!username) return sendError(res, 'Username required', 400);
  
  const isEmail = username.includes('@');
  const user = isEmail 
    ? await UserOperations.getByEmail(username) as { id: number } | undefined
    : await UserOperations.getByUsername(username) as { id: number } | undefined;
  
  // 统一响应，避免用户名枚举：未知用户与「无通行密钥」必须不可区分
  if (!user) return sendError(res, 'No passkeys available', 400);

  const userCredentials = await getUserWebAuthnCredentials(user.id);
  if (userCredentials.length === 0) return sendError(res, 'No passkeys available', 400);
  
  const { rpID } = resolveWebAuthnConfig(req);
  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials: userCredentials.map(cred => ({
      id: cred.id,
      transports: cred.transports as any[],
    })),
    // 与校验侧的 requireUserVerification 共用同一开关：
    // 只改校验不改选项，开 WEBAUTHN_REQUIRE_UV=1 后浏览器不会强制 UV，
    // 用户只会看到「验证失败」而不是被要求按指纹/PIN。
    userVerification: process.env.WEBAUTHN_REQUIRE_UV !== '0' ? 'required' : 'preferred',
  });
  
  if (!options.challenge) {
    sendError(res, 'Failed to generate challenge', 500);
    return;
  }
  
  loginChallengeStore.set(user.id, options.challenge);
  res.json({ code: 0, data: options, msg: 'success' });
});

export default router;
