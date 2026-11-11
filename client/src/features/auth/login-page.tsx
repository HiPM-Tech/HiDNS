import { useEffect, useRef, useState } from 'react';
import { alertVariants } from '../../ui/alert';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Fingerprint, KeyRound, Loader2, LogIn, Mail, Network, Smartphone } from 'lucide-react';
import { LogoBadge } from '../../ui/logo';
import { startAuthentication } from '@simplewebauthn/browser';
import { unwrapWebAuthnOptions } from '../../lib/webauthn-options';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from '../../ui';
import { copy } from '../../copy/zh-CN';
import { ApiError } from '../../lib/http';
import { encryptPassword, PasswordEncryptionUnavailableError } from '../../utils/rsaEncrypt';
import { authApi, type AuthUser, type OAuthStatus } from './api';
import { resolveReturnTo } from './return-to';

/** 兼容既有引用：实现已抽到 ./return-to.ts（路由守卫复用同一份落点规则） */
export { resolveReturnTo };

const credentialsSchema = z.object({
  username: z.string().trim().min(1, copy.auth.usernameRequired),
  password: z.string().min(1, copy.auth.passwordRequired),
});
type Credentials = z.infer<typeof credentialsSchema>;

const twoFactorSchema = z.object({
  code: z.string().trim().min(1, copy.auth.totpRequired),
});
type TwoFactorForm = z.infer<typeof twoFactorSchema>;

const resetRequestSchema = z.object({
  email: z.string().trim().min(1, copy.auth.emailRequired).email(copy.auth.emailInvalid),
});
type ResetRequestForm = z.infer<typeof resetRequestSchema>;

const resetConfirmSchema = z.object({
  code: z.string().trim().min(1, copy.auth.codeRequired),
  newPassword: z.string().min(6, copy.auth.newPasswordTooShort),
});
type ResetConfirmForm = z.infer<typeof resetConfirmSchema>;

export interface LoginPageProps {
  /** 登录成功后的动作；默认跳回 return_to（站内路径）或 /dash */
  onSuccess?: (user: AuthUser | undefined) => void;
}

export function LoginPage({ onSuccess }: LoginPageProps) {
  // 直接读 window.location：登录页可能在 Router 之外被渲染（测试、嵌入式），
  // 用 useSearchParams 会强制要求 Router 上下文。
  const handleSuccess = onSuccess ?? (() => window.location.assign(resolveReturnTo(window.location.search)));
  const [step, setStep] = useState<'credentials' | '2fa' | 'reset-request' | 'reset-confirm'>('credentials');
  const [pendingCredentials, setPendingCredentials] = useState<Credentials | null>(null);
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const credentialsForm = useForm<Credentials>({
    resolver: zodResolver(credentialsSchema),
    defaultValues: { username: '', password: '' },
  });
  const twoFactorForm = useForm<TwoFactorForm>({
    resolver: zodResolver(twoFactorSchema),
    defaultValues: { code: '' },
  });
  const resetRequestForm = useForm<ResetRequestForm>({
    resolver: zodResolver(resetRequestSchema),
    defaultValues: { email: '' },
  });
  const resetConfirmForm = useForm<ResetConfirmForm>({
    resolver: zodResolver(resetConfirmSchema),
    defaultValues: { code: '', newPassword: '' },
  });
  const [resetEmail, setResetEmail] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [oauth, setOauth] = useState<OAuthStatus | null>(null);
  const [passkeyPending, setPasskeyPending] = useState(false);
  /** 浏览器不提供 Web Crypto（HTTP 非安全上下文）时，是否已由用户确认降级为明文提交
   *  ref 供「确认后立即重试」使用：setState 是异步的，同步重试会读到旧闭包 */
  const [plaintext, setPlaintext] = useState(false);
  const plaintextRef = useRef(false);
  /** 加密失败过一次，展示「知悉风险，改用明文继续」入口 */
  const [needsPlaintext, setNeedsPlaintext] = useState(false);

  // 单点登录入口：只有服务端启用时才展示
  useEffect(() => {
    let cancelled = false;
    authApi.oauthStatus()
      .then((envelope) => { if (!cancelled && envelope.code === 0) setOauth(envelope.data); })
      .catch(() => { if (!cancelled) setOauth(null); });
    return () => { cancelled = true; };
  }, []);

  /**
   * 取用于提交的密码：能加密就加密；浏览器不给 Web Crypto（HTTP 非安全上下文）时
   * 不直接终止登录，而是把「是否接受明文传输」交给用户决定（服务端 encrypted=false 走明文校验）。
   */
  const preparePassword = async (raw: string): Promise<{ password: string; encrypted: boolean } | null> => {
    if (plaintextRef.current) return { password: raw, encrypted: false };
    try {
      return { password: await encryptPassword(raw), encrypted: true };
    } catch {
      setNeedsPlaintext(true);
      setError(copy.auth.encryptionUnavailable);
      return null;
    }
  };

  /** 通行密钥登录：服务端仍要求密码，因此复用当前表单里的凭据 */
  const handlePasskeyLogin = async () => {
    const values = credentialsForm.getValues();
    if (!values.username || !values.password) {
      setError(copy.auth.passkeyNeedsCredentials);
      return;
    }
    setError(null);
    setPasskeyPending(true);
    try {
      const optionsEnvelope = await authApi.webauthnLoginOptions(values.username);
      if (optionsEnvelope.code !== 0) {
        setError(optionsEnvelope.msg || copy.auth.loginFailed);
        return;
      }
      const assertion = await startAuthentication({ optionsJSON: unwrapWebAuthnOptions(optionsEnvelope.data) as never });
      const prepared = await preparePassword(values.password);
      if (!prepared) return;
      const envelope = await authApi.login({
        username: values.username,
        password: prepared.password,
        encrypted: prepared.encrypted,
        webauthnResponse: assertion,
      });
      if (envelope.code !== 0) {
        setError(envelope.msg || copy.auth.loginFailed);
        return;
      }
      handleSuccess(envelope.data?.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : copy.auth.passkeyFailed);
    } finally {
      setPasskeyPending(false);
    }
  };

  const handleOauthLogin = async (provider?: string) => {
    setError(null);
    try {
      const envelope = await authApi.oauthStart(provider);
      if (envelope.code !== 0 || !envelope.data?.authUrl) {
        setError(envelope.msg || copy.auth.oauthFailed);
        return;
      }
      window.location.assign(envelope.data.authUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : copy.auth.oauthFailed);
    }
  };

  const describeError = (err: unknown): string => {
    if (err instanceof ApiError) return err.message || copy.auth.loginFailed;
    if (err instanceof Error) return err.message;
    return copy.auth.loginFailed;
  };

  const submitCredentials = credentialsForm.handleSubmit(async (values) => {
    setError(null);
    const prepared = await preparePassword(values.password);
    if (!prepared) return;

    try {
      const envelope = await authApi.login({ username: values.username, password: prepared.password, encrypted: prepared.encrypted });
      if (envelope.code === -2) {
        setPendingCredentials(values);
        setStep('2fa');
        twoFactorForm.reset();
        return;
      }
      if (envelope.code !== 0) {
        setError(envelope.msg || copy.auth.loginFailed);
        return;
      }
      handleSuccess(envelope.data?.user);
    } catch (err) {
      setError(describeError(err));
    }
  });

  const submitTwoFactor = twoFactorForm.handleSubmit(async ({ code }) => {
    if (!pendingCredentials) {
      setStep('credentials');
      return;
    }
    setError(null);
    try {
      const prepared = await preparePassword(pendingCredentials.password);
      if (!prepared) return;
      const envelope = await authApi.login({
        username: pendingCredentials.username,
        password: prepared.password,
        encrypted: prepared.encrypted,
        totpCode: useBackupCode ? undefined : code,
        backupCode: useBackupCode ? code : undefined,
      });
      if (envelope.code !== 0) {
        setError(envelope.msg || copy.auth.loginFailed);
        return;
      }
      handleSuccess(envelope.data?.user);
    } catch (err) {
      setError(describeError(err));
    }
  });

  const submitResetRequest = resetRequestForm.handleSubmit(async ({ email }) => {
    setError(null);
    setNotice(null);
    try {
      const envelope = await authApi.requestPasswordReset(email);
      if (envelope.code !== 0) {
        setError(envelope.msg || copy.auth.loginFailed);
        return;
      }
      setResetEmail(email);
      resetConfirmForm.reset();
      setNotice(copy.auth.resetSent);
      setStep('reset-confirm');
    } catch (err) {
      setError(describeError(err));
    }
  });

  const submitResetConfirm = resetConfirmForm.handleSubmit(async ({ code, newPassword }) => {
    setError(null);
    try {
      const encrypted = await encryptPassword(newPassword);
      const envelope = await authApi.confirmPasswordReset(resetEmail, code, encrypted);
      if (envelope.code !== 0) {
        setError(envelope.msg || copy.auth.loginFailed);
        return;
      }
      setNotice(copy.auth.resetSuccess);
      setStep('credentials');
    } catch (err) {
      // 重置密码刻意不提供明文回退（密码替换必须走安全通道），但提示必须是人能看懂的
      setError(err instanceof PasswordEncryptionUnavailableError ? copy.auth.encryptionUnavailable : describeError(err));
    }
  });

  /** 用户明确接受风险：此后本页一律明文提交，并立刻重试当前步骤（凭据 / 两步验证） */
  const continueWithPlaintext = () => {
    plaintextRef.current = true;
    setPlaintext(true);
    setNeedsPlaintext(false);
    setError(null);
    if (step === '2fa') void submitTwoFactor();
    else void submitCredentials();
  };

  const submitting = credentialsForm.formState.isSubmitting
    || twoFactorForm.formState.isSubmitting
    || resetRequestForm.formState.isSubmitting
    || resetConfirmForm.formState.isSubmitting;

  return (
    // 黄金分割两栏：左 61.8% 展示背景图与品牌语（不放正文），右 38.2% 放登录卡；
    // 不用 fixed inset-0：小屏横屏 / 软键盘弹出时需要能滚动
    <main className="grid min-h-dvh lg:grid-cols-[61.8%_38.2%]">
      <section className="relative hidden overflow-hidden lg:block" aria-hidden>
        {/* 展示区自带一层白纱：背景图是彩色插画，直接压文字会掉对比度 */}
        <div className="absolute inset-0 bg-background/12 backdrop-saturate-90" />
        <div className="absolute inset-0 bg-gradient-to-tr from-primary/20 via-transparent to-transparent" />
        <div className="absolute bottom-phi-11 left-phi-11 right-phi-11 text-foreground">
          <p className="text-hero font-semibold leading-tight">把散落在各家的 DNS，收拢到一个控制台</p>
          <p className="mt-phi-5 max-w-[38ch] text-caption text-muted-foreground">
            多提供商聚合 · 记录与线路 · DDNS 与故障转移 · 证书与监控
          </p>
        </div>
      </section>
      {/* 表单区实色：登录输入框必须永远清晰，不能透出背景图 */}
      <section className="flex min-h-dvh items-center justify-center bg-background p-6">
      <div className="w-full max-w-auth animate-slide-up">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <LogoBadge size={44} className="shadow-sm" />
          <div>
            <p className="text-heading font-semibold">{copy.app.name}</p>
            <p className="text-xs text-muted-foreground">{copy.app.tagline}</p>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>
              {step === 'credentials' ? copy.auth.loginTitle
                : step === '2fa' ? copy.auth.twoFactorTitle
                  : copy.auth.resetTitle}
            </CardTitle>
            <CardDescription>
              {step === 'credentials' ? copy.auth.loginSubtitle
                : step === '2fa' ? copy.auth.twoFactorSubtitle
                  : copy.auth.resetSubtitle}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {plaintext && (
              <div role="status" className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                {copy.auth.plaintextInUse}
              </div>
            )}

            {notice && (
              <div role="status" className={alertVariants('success', 'mb-4')}>
                {notice}
              </div>
            )}

            {error && (
              <div role="alert" className={alertVariants('error', 'mb-4')}>
                {error}
              </div>
            )}

            {/* HTTP 非安全上下文：浏览器不提供 Web Crypto。是否接受明文，交给用户明确确认 */}
            {needsPlaintext && (
              <div className="mb-4 space-y-2 rounded-lg border border-border bg-muted/40 p-3">
                <p className="text-xs text-muted-foreground">{copy.auth.plaintextFallbackHint}</p>
                <Button type="button" variant="outline" size="sm" className="w-full" onClick={continueWithPlaintext} disabled={submitting}>
                  {copy.auth.plaintextFallback}
                </Button>
              </div>
            )}

            {step === 'credentials' ? (
              <form className="space-y-phi-6" onSubmit={submitCredentials} noValidate>
                <div className="space-y-2">
                  <Label htmlFor="username">{copy.auth.username}</Label>
                  <Input
                    id="username"
                    autoComplete="username"
                    placeholder={copy.auth.usernamePlaceholder}
                    aria-invalid={credentialsForm.formState.errors.username ? true : undefined}
                    {...credentialsForm.register('username')}
                  />
                  {credentialsForm.formState.errors.username && (
                    <p className="text-xs text-destructive">{credentialsForm.formState.errors.username.message}</p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="password">{copy.auth.password}</Label>
                  <Input
                    id="password"
                    type="password"
                    autoComplete="current-password"
                    placeholder={copy.auth.passwordPlaceholder}
                    aria-invalid={credentialsForm.formState.errors.password ? true : undefined}
                    {...credentialsForm.register('password')}
                  />
                  {credentialsForm.formState.errors.password && (
                    <p className="text-xs text-destructive">{credentialsForm.formState.errors.password.message}</p>
                  )}
                </div>

                <Button type="submit" className="w-full" disabled={submitting}>
                  {submitting ? <Loader2 className="animate-spin" aria-hidden /> : <KeyRound aria-hidden />}
                  {submitting ? copy.auth.submitting : copy.auth.submit}
                </Button>

                <div className="flex items-center gap-2 pt-1 text-xs text-muted-foreground">
                  <span className="h-px flex-1 bg-border" />
                  或
                  <span className="h-px flex-1 bg-border" />
                </div>

                <Button
                  type="button"
                  variant="outline"
                  className="w-full justify-start gap-phi-3"
                  onClick={() => void handlePasskeyLogin()}
                  disabled={passkeyPending || submitting}
                >
                  {passkeyPending ? <Loader2 className="animate-spin" aria-hidden /> : <Fingerprint strokeWidth={1.75} aria-hidden />}
                  {copy.auth.passkeyLogin}
                </Button>

                {/* 外部 IdP：Logto 用 LogIn、其它 OIDC 用 Network；各入口统一 outline + 前景色图标，
                    不做品牌色块，否则登录页会变成「应用商店」 */}
                {(oauth?.providers?.length
                  ? oauth.providers
                  : oauth?.enabled ? [{ providerName: oauth.providerName }] : []
                ).map((provider) => (
                  <Button
                    key={provider.key ?? provider.providerName ?? 'oidc'}
                    type="button"
                    variant="outline"
                    className="w-full justify-start gap-phi-3"
                    onClick={() => void handleOauthLogin(provider.key)}
                  >
                    {/logto/i.test(provider.providerName ?? '') ? <LogIn strokeWidth={1.75} aria-hidden /> : <Network strokeWidth={1.75} aria-hidden />}
                    <span className="truncate">
                      {copy.auth.oauthLogin}
                      {provider.providerName ? ` · ${provider.providerName}` : ''}
                    </span>
                  </Button>
                ))}

                <button
                  type="button"
                  className="w-full text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                  onClick={() => { setStep('reset-request'); setError(null); setNotice(null); resetRequestForm.reset(); }}
                >
                  {copy.auth.forgotPassword}
                </button>
              </form>
            ) : step === '2fa' ? (
              <form className="space-y-phi-6" onSubmit={submitTwoFactor} noValidate>
                <div className="space-y-2">
                  <Label htmlFor="code">{useBackupCode ? copy.auth.backupCode : copy.auth.totpCode}</Label>
                  <Input
                    id="code"
                    inputMode={useBackupCode ? 'text' : 'numeric'}
                    autoComplete="one-time-code"
                    autoFocus
                    placeholder={useBackupCode ? '' : copy.auth.totpPlaceholder}
                    aria-invalid={twoFactorForm.formState.errors.code ? true : undefined}
                    {...twoFactorForm.register('code')}
                  />
                  {twoFactorForm.formState.errors.code && (
                    <p className="text-xs text-destructive">{twoFactorForm.formState.errors.code.message}</p>
                  )}
                </div>

                <Button type="submit" className="w-full" disabled={submitting}>
                  {submitting ? <Loader2 className="animate-spin" aria-hidden /> : <Smartphone strokeWidth={1.75} aria-hidden />}
                  {submitting ? copy.auth.verifying : copy.auth.verify}
                </Button>

                <div className="flex items-center justify-between text-xs">
                  <button
                    type="button"
                    className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                    onClick={() => { setUseBackupCode((v) => !v); setError(null); twoFactorForm.reset(); }}
                  >
                    {useBackupCode ? copy.auth.useTotp : copy.auth.useBackupCode}
                  </button>
                  <button
                    type="button"
                    className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                    onClick={() => { setStep('credentials'); setError(null); setPendingCredentials(null); }}
                  >
                    {copy.common.back}
                  </button>
                </div>
              </form>
            ) : step === 'reset-request' ? (
              <form className="space-y-phi-6" onSubmit={submitResetRequest} noValidate>
                <div className="space-y-2">
                  <Label htmlFor="reset-email">{copy.auth.email}</Label>
                  <Input
                    id="reset-email"
                    type="email"
                    autoComplete="email"
                    placeholder={copy.auth.emailPlaceholder}
                    aria-invalid={resetRequestForm.formState.errors.email ? true : undefined}
                    {...resetRequestForm.register('email')}
                  />
                  {resetRequestForm.formState.errors.email && (
                    <p className="text-xs text-destructive">{resetRequestForm.formState.errors.email.message}</p>
                  )}
                </div>

                <Button type="submit" className="w-full" disabled={submitting}>
                  {submitting ? <Loader2 className="animate-spin" aria-hidden /> : <Mail strokeWidth={1.75} aria-hidden />}
                  {submitting ? copy.auth.sendingCode : copy.auth.sendCode}
                </Button>

                <button
                  type="button"
                  className="w-full text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                  onClick={() => { setStep('credentials'); setError(null); setNotice(null); }}
                >
                  {copy.auth.backToLogin}
                </button>
              </form>
            ) : (
              <form className="space-y-phi-6" onSubmit={submitResetConfirm} noValidate>
                <div className="space-y-2">
                  <Label htmlFor="reset-code">{copy.auth.code}</Label>
                  <Input
                    id="reset-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder={copy.auth.codePlaceholder}
                    aria-invalid={resetConfirmForm.formState.errors.code ? true : undefined}
                    {...resetConfirmForm.register('code')}
                  />
                  {resetConfirmForm.formState.errors.code && (
                    <p className="text-xs text-destructive">{resetConfirmForm.formState.errors.code.message}</p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="reset-password">{copy.auth.newPassword}</Label>
                  <Input
                    id="reset-password"
                    type="password"
                    autoComplete="new-password"
                    placeholder={copy.auth.newPasswordPlaceholder}
                    aria-invalid={resetConfirmForm.formState.errors.newPassword ? true : undefined}
                    {...resetConfirmForm.register('newPassword')}
                  />
                  {resetConfirmForm.formState.errors.newPassword && (
                    <p className="text-xs text-destructive">{resetConfirmForm.formState.errors.newPassword.message}</p>
                  )}
                </div>

                <Button type="submit" className="w-full" disabled={submitting}>
                  {submitting && <Loader2 className="animate-spin" aria-hidden />}
                  {submitting ? copy.auth.resetting : copy.auth.resetSubmit}
                </Button>

                <button
                  type="button"
                  className="w-full text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                  onClick={() => { setStep('reset-request'); setError(null); setNotice(null); }}
                >
                  {copy.common.back}
                </button>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
      </section>
    </main>
  );
}
