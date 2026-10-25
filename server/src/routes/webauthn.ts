import { Router, Request, Response } from 'express';
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { authMiddleware } from '../middleware/auth';
import { getUserWebAuthnCredentials, addWebAuthnCredential, deleteWebAuthnCredential, updateWebAuthnCredentialCounter } from '../service/webauthn';
import { UserOperations } from '../db/bal/business-adapter';
import crypto from 'crypto';
import { sendError } from '../utils/http';

const router = Router();

// Store challenges temporarily
const userChallengeStore = new Map<number, string>();
const loginChallengeStore = new Map<number, string>(); // user_id -> challenge
(global as any).loginChallengeStore = loginChallengeStore;

// Ensure RP name and ID match your deployment
const rpName = 'HiDNS';
const rpID = process.env.WEBAUTHN_RP_ID || 'localhost';
const origin = process.env.WEBAUTHN_ORIGIN || `http://${rpID}:3000`; // Modify accordingly in prod

router.get('/registration-options', authMiddleware, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const user = await UserOperations.getById(userId) as { username: string } | undefined;
  if (!user) return sendError(res, 'User not found', 404);

  const userCredentials = await getUserWebAuthnCredentials(userId);

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
      residentKey: 'preferred',
      userVerification: 'preferred',
      authenticatorAttachment: 'platform',
    },
  });

  if (!options.challenge) {
    sendError(res, 'Failed to generate challenge', 500);
    return;
  }

  userChallengeStore.set(userId, options.challenge);
  res.json({ code: 0, data: options, msg: 'success' });
});

router.post('/registration-verify', authMiddleware, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const body = req.body;
  const expectedChallenge = userChallengeStore.get(userId);

  if (!expectedChallenge) return sendError(res, 'Challenge not found', 400);

  try {
    const verification = await verifyRegistrationResponse({
      response: body,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
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
  } catch (error: any) {
    res.status(400).json({ code: 400, msg: error.message });
  }
});

router.get('/credentials', authMiddleware, async (req: Request, res: Response) => {
  const creds = await getUserWebAuthnCredentials(req.user!.userId);
  res.json({ code: 0, data: creds.map(c => ({ id: c.id, name: c.name, created_at: c.created_at, last_used_at: c.last_used_at })), msg: 'success' });
});

router.delete('/credentials/:id', authMiddleware, async (req: Request, res: Response) => {
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
  
  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials: userCredentials.map(cred => ({
      id: cred.id,
      transports: cred.transports as any[],
    })),
    userVerification: 'preferred',
  });
  
  if (!options.challenge) {
    sendError(res, 'Failed to generate challenge', 500);
    return;
  }
  
  loginChallengeStore.set(user.id, options.challenge);
  res.json({ code: 0, data: options, msg: 'success' });
});

export default router;
