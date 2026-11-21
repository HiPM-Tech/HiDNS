/**
 * 把 WebAuthn 抛出的 DOMException 翻译成「用户能据此行动」的中文提示。
 *
 * 浏览器原始报错（如 `The operation either timed out or was not allowed.`）既看不出原因，
 * 也不知道下一步该做什么 —— issue #57 的截图正是这种情况。
 */
export function describeWebAuthnError(err: unknown): string {
  const name = (err as { name?: string } | null)?.name ?? '';
  switch (name) {
    case 'NotAllowedError':
      return '操作被取消或超时：请在系统弹窗里完成验证（Touch ID / Windows Hello / 安全密钥），也可以改用密码登录';
    case 'NotSupportedError':
      return '当前浏览器或设备不支持通行密钥：请改用 Chrome / Edge / Safari，或插入一个 USB 安全密钥后重试';
    case 'SecurityError':
      return '安全上下文校验失败：请用 HTTPS 或 localhost 访问，并确认反向代理转发的域名与面板地址一致';
    case 'InvalidStateError':
      return '这台设备上已经有该通行密钥：直接用它登录即可；要重新注册请先在系统里删除旧的';
    case 'AbortError':
      return '操作已取消';
    case 'ConstraintError':
      return '该认证器不满足要求（例如需要用户验证），请换一个设备或安全密钥重试';
    default: {
      const message = err instanceof Error ? err.message : '';
      return message || '通行密钥操作失败，请重试或改用密码登录';
    }
  }
}

/** 平台认证器（Touch ID / Windows Hello）是否可用；不可用时页面可以提前提示，而不是等报错 */
export async function hasPlatformAuthenticator(): Promise<boolean> {
  try {
    if (typeof window === 'undefined' || !window.PublicKeyCredential) return false;
    const fn = (window.PublicKeyCredential as unknown as {
      isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean>;
    }).isUserVerifyingPlatformAuthenticatorAvailable;
    if (typeof fn !== 'function') return false;
    return await fn.call(window.PublicKeyCredential);
  } catch {
    return false;
  }
}