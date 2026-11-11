/**
 * 通行密钥 options 的取值兼容层。
 *
 * 服务端（/auth/webauthn/registration-options 与 /login-options）把
 * PublicKeyCredential*OptionsJSON **直接放在 data 里**，没有再包一层 options。
 * 之前前端写成 data.options，取到 undefined，simplewebauthn 内部读 challenge 时直接抛错。
 *
 * 这里做一次兼容：既接受裸对象，也接受 { options } 包装，避免以后结构再变时又炸一次。
 */
export function unwrapWebAuthnOptions<T>(data: unknown): T {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const holder = data as Record<string, unknown>;
    if (holder.options && typeof holder.options === 'object') {
      return holder.options as T;
    }
  }
  return data as T;
}