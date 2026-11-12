import { WebAuthnOperations, getDbType } from '../db/bal/business-adapter';

export interface WebAuthnCredential {
  id: string;
  user_id: number;
  public_key: string;
  counter: number;
  device_type: string;
  backed_up: boolean;
  transports: string[];
  name: string;
  created_at: Date;
  last_used_at: Date;
}

export async function getUserWebAuthnCredentials(userId: number): Promise<WebAuthnCredential[]> {
  const rows = await WebAuthnOperations.getByUser(userId) as any[];
  return rows.map(r => ({
    id: r.id,
    user_id: r.user_id,
    public_key: r.public_key,
    counter: r.counter,
    device_type: r.device_type,
    backed_up: Boolean(r.backed_up),
    transports: typeof r.transports === 'string' ? JSON.parse(r.transports) : r.transports,
    name: r.name,
    created_at: new Date(r.created_at),
    last_used_at: new Date(r.last_used_at),
  }));
}

export async function addWebAuthnCredential(cred: Omit<WebAuthnCredential, 'created_at' | 'last_used_at'>) {
  await WebAuthnOperations.add({
    id: cred.id,
    user_id: cred.user_id,
    public_key: cred.public_key,
    counter: cred.counter,
    device_type: cred.device_type,
    backed_up: cred.backed_up ? 1 : 0,
    transports: JSON.stringify(cred.transports),
    name: cred.name
  });
  // Ensure user has webauthn enabled in user_2fa
  const existing = await WebAuthnOperations.exists(cred.user_id);
  if (!existing) {
    await WebAuthnOperations.createConfig(cred.user_id);
  } else {
    await WebAuthnOperations.enable(cred.user_id);
  }
}

export async function updateWebAuthnCredentialCounter(id: string, counter: number) {
  await WebAuthnOperations.updateCounter(id, counter);
}

/**
 * 前端提交注册凭证时包了一层 { credential: RegistrationResponseJSON }，
 * 而 simplewebauthn 的 verifyRegistrationResponse 需要的是「凭证本身」（含 id / rawId）。
 * 直接传 body 会让它读不到 id，抛 Missing credential ID。
 * 这里两种形态都接受，避免前后端任何一侧改动就炸。
 */
export function pickCredentialResponse(body: unknown): unknown {
  if (body && typeof body === 'object' && !Array.isArray(body) && 'credential' in (body as Record<string, unknown>)) {
    return (body as Record<string, unknown>).credential;
  }
  return body;
}

export async function deleteWebAuthnCredential(userId: number, id: string) {
  await WebAuthnOperations.delete(userId, id);

  // Disable webauthn if no credentials left
  const remaining = await getUserWebAuthnCredentials(userId);
  if (remaining.length === 0) {
    await WebAuthnOperations.disable(userId);
  }
}
