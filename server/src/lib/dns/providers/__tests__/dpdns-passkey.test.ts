import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildAssertion,
  credentialIdToRawId,
  parsePasskeyCredential,
} from '../dpdns_reverse/passkey';

/** 用临时生成的 P-256 密钥当测试凭据：绝不能把真实账号的私钥写进仓库 */
function makeCredential() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const keyValue = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url');
  return {
    credential: {
      credentialId: '36d61772-b56f-47b4-9944-65c47be7f611',
      keyValue,
      rpId: 'dashboard.digitalplat.org',
      userHandle: 'mEqCHdbXrHsyXlUjSh5Cvg-sd0U9qyzISZ1K_a3_2u0',
      counter: '0',
    },
    publicKey,
  };
}

describe('parsePasskeyCredential', () => {
  const { credential } = makeCredential();

  it('接受 Bitwarden 导出的 fido2Credentials 数组', () => {
    expect(parsePasskeyCredential({ fido2Credentials: [credential] })).toMatchObject({
      credentialId: credential.credentialId,
      rpId: credential.rpId,
      userHandle: credential.userHandle,
    });
  });

  it('接受单条凭据对象与 JSON 字符串', () => {
    expect(parsePasskeyCredential(credential)?.credentialId).toBe(credential.credentialId);
    expect(parsePasskeyCredential(JSON.stringify({ fido2Credentials: [credential] }))?.credentialId)
      .toBe(credential.credentialId);
  });

  it('缺关键字段或坏 JSON 返回 null', () => {
    expect(parsePasskeyCredential({ ...credential, keyValue: '' })).toBeNull();
    expect(parsePasskeyCredential({ ...credential, userHandle: '' })).toBeNull();
    expect(parsePasskeyCredential('{bad-json')).toBeNull();
    expect(parsePasskeyCredential(null)).toBeNull();
  });
});

describe('credentialIdToRawId', () => {
  it('UUID 形态转成 16 字节', () => {
    expect(credentialIdToRawId('36d61772-b56f-47b4-9944-65c47be7f611')).toHaveLength(16);
  });

  it('非 UUID 形态退回 UTF-8 字节', () => {
    expect(credentialIdToRawId('abc')).toEqual(Buffer.from('abc', 'utf8'));
  });
});

describe('buildAssertion', () => {
  it('产出可被对应公钥验证的 WebAuthn 断言', () => {
    const { credential, publicKey } = makeCredential();
    const challenge = 'fAWOhdMHkbJiXLcjhfiZR1ZnuG-iJ8IEiQFGdQt52IhgztknknKOp2PzjoT4bNI8uEsVcGlqgKJ1r-9zJSc39A';
    const assertion = buildAssertion(credential, challenge);

    const clientData = JSON.parse(Buffer.from(assertion.response.clientDataJSON, 'base64url').toString('utf8'));
    expect(clientData).toMatchObject({
      type: 'webauthn.get',
      challenge,
      origin: 'https://dashboard.digitalplat.org',
      crossOrigin: false,
    });

    const authData = Buffer.from(assertion.response.authenticatorData, 'base64url');
    expect(authData).toHaveLength(37);
    expect(authData.subarray(0, 32)).toEqual(
      crypto.createHash('sha256').update(credential.rpId).digest(),
    );
    expect(authData[32]).toBe(0x05); // UP | UV

    const signature = Buffer.from(assertion.response.signature, 'base64url');
    const clientHash = crypto.createHash('sha256').update(JSON.stringify(clientData)).digest();
    const valid = crypto.verify(
      'sha256',
      Buffer.concat([authData, clientHash]),
      { key: publicKey, dsaEncoding: 'der' },
      signature,
    );
    expect(valid).toBe(true);

    expect(assertion.id).toBe(assertion.rawId);
    expect(assertion.response.userHandle).toBe(credential.userHandle);
  });

  it('challenge 变了签名就不再成立', () => {
    const { credential, publicKey } = makeCredential();
    const a = buildAssertion(credential, 'challenge-a');
    const authData = Buffer.from(a.response.authenticatorData, 'base64url');
    const clientData = JSON.parse(Buffer.from(a.response.clientDataJSON, 'base64url').toString('utf8'));
    clientData.challenge = 'challenge-b';
    const clientHash = crypto.createHash('sha256').update(JSON.stringify(clientData)).digest();
    expect(crypto.verify(
      'sha256',
      Buffer.concat([authData, clientHash]),
      { key: publicKey, dsaEncoding: 'der' },
      Buffer.from(a.response.signature, 'base64url'),
    )).toBe(false);
  });
});
