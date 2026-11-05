import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginPage } from '../login-page';
import { authApi } from '../api';
import { encryptPassword } from '../../../utils/rsaEncrypt';
import { copy } from '../../../copy/zh-CN';

vi.mock('../api', () => ({
  authApi: {
    login: vi.fn(),
    me: vi.fn(),
    logout: vi.fn(),
    requestPasswordReset: vi.fn(),
    confirmPasswordReset: vi.fn(),
    webauthnLoginOptions: vi.fn(),
    oauthStatus: vi.fn(),
    oauthStart: vi.fn(),
  },
}));
vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(async () => ({ id: 'cred-1', response: { clientDataJSON: 'x' } })),
}));
vi.mock('../../../utils/rsaEncrypt', () => ({
  encryptPassword: vi.fn(async (password: string) => `enc:${password}`),
}));

const loginMock = vi.mocked(authApi.login);

describe('LoginPage', () => {
  // 用例内可能替换 encryptPassword 的实现，统一在结束后还原，避免污染后续用例
  afterEach(() => {
    vi.mocked(encryptPassword).mockImplementation(async (password: string) => `enc:${password}`);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authApi.oauthStatus).mockResolvedValue({ code: 0, msg: 'success', data: { enabled: false } });
  });

  it('通行密钥登录：拿到断言后随登录请求提交（P0 回归守卫）', async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    vi.mocked(authApi.webauthnLoginOptions).mockResolvedValue({ code: 0, msg: 'success', data: { options: { challenge: 'c' } } });
    loginMock.mockResolvedValue({ code: 0, msg: 'success', data: { user: { id: 3, username: 'admin' } } });

    render(<LoginPage onSuccess={onSuccess} />);
    await user.type(screen.getByLabelText(copy.auth.username), 'admin');
    await user.type(screen.getByLabelText(copy.auth.password), 'secret');
    await user.click(screen.getByRole('button', { name: copy.auth.passkeyLogin }));

    expect(authApi.webauthnLoginOptions).toHaveBeenCalledWith('admin');
    await waitFor(() => expect(loginMock).toHaveBeenCalledWith(expect.objectContaining({
      username: 'admin',
      password: 'enc:secret',
      encrypted: true,
      webauthnResponse: expect.objectContaining({ id: 'cred-1' }),
    })));
    expect(onSuccess).toHaveBeenCalled();
  });

  it('服务端启用 SSO 时展示入口', async () => {
    vi.mocked(authApi.oauthStatus).mockResolvedValue({
      code: 0, msg: 'success', data: { enabled: true, providerName: 'Logto' },
    });
    render(<LoginPage onSuccess={vi.fn()} />);
    expect(await screen.findByRole('button', { name: new RegExp(copy.auth.oauthLogin) })).toBeTruthy();
  });

  it('只启用 Logto 时点击入口会带上 provider=logto（不再误用 custom）', async () => {
    const user = userEvent.setup();
    vi.mocked(authApi.oauthStatus).mockResolvedValue({
      code: 0, msg: 'success',
      data: { enabled: true, providerName: 'Logto', providers: [{ key: 'logto', providerName: 'Logto' }] },
    });
    // authUrl 留空：只验证 provider 参数，避免 jsdom 的 location.assign 限制
    vi.mocked(authApi.oauthStart).mockResolvedValue({ code: 0, msg: 'success', data: { authUrl: '' } });

    render(<LoginPage onSuccess={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: new RegExp(copy.auth.oauthLogin) }));

    await waitFor(() => expect(authApi.oauthStart).toHaveBeenCalledWith('logto'));
  });

  it('空表单提交时给出校验提示，不发请求', async () => {
    const user = userEvent.setup();
    render(<LoginPage onSuccess={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: copy.auth.submit }));

    expect(await screen.findByText(copy.auth.usernameRequired)).toBeTruthy();
    expect(await screen.findByText(copy.auth.passwordRequired)).toBeTruthy();
    expect(loginMock).not.toHaveBeenCalled();
  });

  it('登录成功：密码加密后提交，并回调 onSuccess', async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    loginMock.mockResolvedValue({ code: 0, msg: 'success', data: { user: { id: 1, username: 'admin' } } });

    render(<LoginPage onSuccess={onSuccess} />);
    await user.type(screen.getByLabelText(copy.auth.username), 'admin');
    await user.type(screen.getByLabelText(copy.auth.password), 'secret');
    await user.click(screen.getByRole('button', { name: copy.auth.submit }));

    expect(loginMock).toHaveBeenCalledWith({ username: 'admin', password: 'enc:secret', encrypted: true });
    expect(onSuccess).toHaveBeenCalledWith({ id: 1, username: 'admin' });
    expect(vi.mocked(encryptPassword)).toHaveBeenCalledWith('secret');
  });

  it('HTTP 环境无法加密：先给风险提示，用户确认后才以明文提交', async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    // 显式替换实现而不是 once 队列：本用例内一律模拟「浏览器不提供 Web Crypto」
    const encryptMock = vi.mocked(encryptPassword);
    encryptMock.mockImplementation(async () => { throw new Error('Password encryption is unavailable (non-HTTPS context)'); });
    loginMock.mockResolvedValue({ code: 0, msg: 'success', data: { user: { id: 4, username: 'ops' } } });

    render(<LoginPage onSuccess={onSuccess} />);
    await user.type(screen.getByLabelText(copy.auth.username), 'ops');
    await user.type(screen.getByLabelText(copy.auth.password), 'plain-secret');
    await user.click(screen.getByRole('button', { name: copy.auth.submit }));

    // 第一次提交：只提示风险，不发登录请求
    expect(await screen.findByText(copy.auth.encryptionUnavailable)).toBeTruthy();
    expect(screen.getByText(copy.auth.plaintextFallbackHint)).toBeTruthy();
    expect(loginMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: copy.auth.plaintextFallback }));

    await waitFor(() => expect(loginMock).toHaveBeenCalledWith({
      username: 'ops', password: 'plain-secret', encrypted: false,
    }));
    expect(onSuccess).toHaveBeenCalledWith({ id: 4, username: 'ops' });
    expect(screen.queryByText(copy.auth.plaintextFallbackHint)).toBeNull();
  });

  it('两步验证阶段加密失败：确认后沿用明文继续验证', async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    // 第一次（凭据）加密成功，第二次（两步验证）模拟浏览器拿不到 Web Crypto
    let encryptCalls = 0;
    const encryptMock = vi.mocked(encryptPassword);
    encryptMock.mockImplementation(async (password: string) => {
      encryptCalls += 1;
      if (encryptCalls === 1) return `enc:${password}`;
      throw new Error('Password encryption is unavailable (non-HTTPS context)');
    });
    loginMock
      .mockResolvedValueOnce({ code: -2, msg: '2FA required', data: { types: ['totp'] } })
      .mockResolvedValueOnce({ code: 0, msg: 'success', data: { user: { id: 5, username: 'ops' } } });

    render(<LoginPage onSuccess={onSuccess} />);
    await user.type(screen.getByLabelText(copy.auth.username), 'ops');
    await user.type(screen.getByLabelText(copy.auth.password), 'plain-secret');
    await user.click(screen.getByRole('button', { name: copy.auth.submit }));
    await screen.findByText(copy.auth.twoFactorTitle);
    await user.type(screen.getByLabelText(copy.auth.totpCode), '123456');
    await user.click(screen.getByRole('button', { name: copy.auth.verify }));

    await user.click(await screen.findByRole('button', { name: copy.auth.plaintextFallback }));

    await waitFor(() => expect(loginMock).toHaveBeenLastCalledWith(expect.objectContaining({
      username: 'ops', password: 'plain-secret', encrypted: false, totpCode: '123456',
    })));
    expect(onSuccess).toHaveBeenCalledWith({ id: 5, username: 'ops' });
  });
  it('服务端返回 -2 时进入两步验证，验证码随登录请求提交', async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    loginMock
      .mockResolvedValueOnce({ code: -2, msg: '2FA required', data: { types: ['totp'] } })
      .mockResolvedValueOnce({ code: 0, msg: 'success', data: { user: { id: 2, username: 'admin' } } });

    render(<LoginPage onSuccess={onSuccess} />);
    await user.type(screen.getByLabelText(copy.auth.username), 'admin');
    await user.type(screen.getByLabelText(copy.auth.password), 'secret');
    await user.click(screen.getByRole('button', { name: copy.auth.submit }));

    expect(await screen.findByText(copy.auth.twoFactorTitle)).toBeTruthy();
    await user.type(screen.getByLabelText(copy.auth.totpCode), '123456');
    await user.click(screen.getByRole('button', { name: copy.auth.verify }));

    expect(loginMock).toHaveBeenLastCalledWith({
      username: 'admin',
      password: 'enc:secret',
      encrypted: true,
      totpCode: '123456',
      backupCode: undefined,
    });
    expect(onSuccess).toHaveBeenCalled();
  });

  it('忘记密码：发送验证码后进入确认步骤，提交加密后的新密码', async () => {
    const user = userEvent.setup();
    vi.mocked(authApi.requestPasswordReset).mockResolvedValue({ code: 0, msg: 'success', data: null });
    vi.mocked(authApi.confirmPasswordReset).mockResolvedValue({ code: 0, msg: 'success', data: null });

    render(<LoginPage onSuccess={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: copy.auth.forgotPassword }));
    await user.type(screen.getByLabelText(copy.auth.email), 'a@b.com');
    await user.click(screen.getByRole('button', { name: copy.auth.sendCode }));

    expect(authApi.requestPasswordReset).toHaveBeenCalledWith('a@b.com');
    expect(await screen.findByText(copy.auth.resetSent)).toBeTruthy();

    await user.type(screen.getByLabelText(copy.auth.code), '654321');
    await user.type(screen.getByLabelText(copy.auth.newPassword), 'newsecret');
    await user.click(screen.getByRole('button', { name: copy.auth.resetSubmit }));

    expect(authApi.confirmPasswordReset).toHaveBeenCalledWith('a@b.com', '654321', 'enc:newsecret');
    expect(await screen.findByText(copy.auth.resetSuccess)).toBeTruthy();
  });

  it('登录失败展示服务端消息', async () => {
    const user = userEvent.setup();
    loginMock.mockResolvedValue({ code: -1, msg: '用户名或密码错误', data: {} });

    render(<LoginPage onSuccess={vi.fn()} />);
    await user.type(screen.getByLabelText(copy.auth.username), 'admin');
    await user.type(screen.getByLabelText(copy.auth.password), 'bad');
    await user.click(screen.getByRole('button', { name: copy.auth.submit }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('用户名或密码错误');
  });
});
