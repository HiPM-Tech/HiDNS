/**
 * DigitalPlat 通行密钥（FIDO2）断言构造。
 *
 * 凭据来自密码管理器（Bitwarden 导出），形如：
 *   { credentialId, keyValue, rpId, userHandle, ... }
 * 其中 keyValue 是 **PKCS#8 DER 的 base64url** 私钥（ECDSA P-256）。
 *
 * 上游（dashboard.digitalplat.org）的登录流程：
 *   POST /_panel_api/api/auth/passkey/begin  { purpose: 'login' }
 *        → { options: { challenge, rpId, userVerification }, request_id }
 *   POST /_panel_api/api/auth/passkey/finish { purpose, request_id, credential }
 *        → { ok, user } + Set-Cookie（remember_token / panel_session / panel_device）
 *
 * 实测要点（2026-11）：
 *   - allowCredentials 为空 → discoverable credential，必须回传 userHandle；
 *   - rawId 是 credentialId(UUID) 去掉连字符后的 16 字节，再 base64url；
 *   - authenticatorData = SHA256(rpId) ‖ flags(UP|UV) ‖ counter(4B)；
 *   - signature = ECDSA-SHA256(authData ‖ SHA256(clientDataJSON))，DER 编码。
 */
import crypto from 'node:crypto';

export interface PasskeyCredential {
  credentialId: string;
  keyValue: string;
  rpId: string;
  userHandle: string;
  counter?: string;
  userName?: string;
}

export const DEFAULT_DPDNS_ORIGIN = 'https://dashboard.digitalplat.org';

const base64url = (buf: Buffer): string => Buffer.from(buf).toString('base64url');

/** 从 Bitwarden 导出的对象 / fido2Credentials 数组 / JSON 字符串里取出第一条可用凭据 */
export function parsePasskeyCredential(raw: unknown): PasskeyCredential | null {
  let value: unknown = raw;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;

  const holder = value as Record<string, unknown>;
  const list = Array.isArray(holder.fido2Credentials) ? holder.fido2Credentials : null;
  const candidate = (list && list[0]) ?? holder;
  if (!candidate || typeof candidate !== 'object') return null;

  const c = candidate as Record<string, unknown>;
  const credentialId = typeof c.credentialId === 'string' ? c.credentialId.trim() : '';
  const keyValue = typeof c.keyValue === 'string' ? c.keyValue.trim() : '';
  const rpId = typeof c.rpId === 'string' ? c.rpId.trim() : DEFAULT_DPDNS_ORIGIN.replace(/^https:\/\//, '');
  const userHandle = typeof c.userHandle === 'string' ? c.userHandle.trim() : '';

  if (!credentialId || !keyValue || !rpId || !userHandle) return null;

  return {
    credentialId,
    keyValue,
    rpId,
    userHandle,
    counter: typeof c.counter === 'string' ? c.counter : undefined,
    userName: typeof c.userName === 'string' ? c.userName : undefined,
  };
}

/** credentialId(UUID) → rawId 字节；非 UUID 形态时退回 UTF-8 字节 */
export function credentialIdToRawId(credentialId: string): Buffer {
  const hex = credentialId.replace(/-/g, '');
  if (/^[0-9a-fA-F]{32}$/.test(hex)) return Buffer.from(hex, 'hex');
  return Buffer.from(credentialId, 'utf8');
}

export interface PasskeyAssertion {
  id: string;
  rawId: string;
  type: 'public-key';
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle: string;
  };
  clientExtensionResults: Record<string, never>;
  authenticatorAttachment: 'cross-platform';
}

/**
 * 构造 WebAuthn 断言。纯函数（除私钥解析），便于单测。
 * @param challenge base64url（上游返回的原样值）
 */
export function buildAssertion(
  credential: PasskeyCredential,
  challenge: string,
  origin: string = DEFAULT_DPDNS_ORIGIN,
): PasskeyAssertion {
  const clientData = JSON.stringify({
    type: 'webauthn.get',
    challenge,
    origin,
    crossOrigin: false,
  });

  const rpIdHash = crypto.createHash('sha256').update(credential.rpId).digest();
  // UP(0x01) | UV(0x04)：上游 userVerification=required
  const flags = Buffer.from([0x05]);
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(Number.parseInt(credential.counter ?? '0', 10) || 0, 0);
  const authenticatorData = Buffer.concat([rpIdHash, flags, counter]);

  const clientHash = crypto.createHash('sha256').update(clientData).digest();
  const privateKey = crypto.createPrivateKey({
    key: Buffer.from(credential.keyValue, 'base64url'),
    format: 'der',
    type: 'pkcs8',
  });
  const signature = crypto.sign('sha256', Buffer.concat([authenticatorData, clientHash]), {
    key: privateKey,
    dsaEncoding: 'der',
  });

  const rawId = credentialIdToRawId(credential.credentialId);
  return {
    id: base64url(rawId),
    rawId: base64url(rawId),
    type: 'public-key',
    response: {
      clientDataJSON: base64url(Buffer.from(clientData, 'utf8')),
      authenticatorData: base64url(authenticatorData),
      signature: base64url(signature),
      userHandle: credential.userHandle,
    },
    clientExtensionResults: {},
    authenticatorAttachment: 'cross-platform',
  };
}
