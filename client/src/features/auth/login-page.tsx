import { useEffect, useState } from 'react';
import { alertVariants } from '../../ui/alert';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Fingerprint, KeyRound, Loader2, LogIn, Mail, Network, Smartphone } from 'lucide-react';
import { LogoBadge } from '../../ui/logo';
import { startAuthentication } from '@simplewebauthn/browser';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from '../../ui';
import { copy } from '../../copy/zh-CN';
import { ApiError } from '../../lib/http';
import { encryptPassword } from '../../utils/rsaEncrypt';
import { authApi, type AuthUser, type OAuthStatus } from './api';

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

/**
 * 登录后的落点：优先 return_to（MCP 授权页等会带），但只接受站内相对路径，
 * 防止被构造成 //evil.com 或 https://… 的外跳。
 */
export function resolveReturnTo(search: string): string {
  const raw = new URLSearchParams(search).get('return_to');
  if (!raw) return '/dash';
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/dash';
  return raw;
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

  // 单点登录入口：只有服务端启用时才展示
  useEffect(() => {
    let cancelled = false;
    authApi.oauthStatus()
      .then((envelope) => { if (!cancelled && envelope.code === 0) setOauth(envelope.data); })
      .catch(() => { if (!cancelled) setOauth(null); });
    return () => { cancelled = true; };
  }, []);

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
      const assertion = await startAuthentication({ optionsJSON: optionsEnvelope.data.options as never });
      const password = await encryptPassword(values.password);
      const envelope = await authApi.login({
        username: values.username,
        password,
        encrypted: true,
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

  const handleOauthLogin = async () => {
    setError(null);
    try {
      const envelope = await authApi.oauthStart();
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
    let password: string;
    try {
      password = await encryptPassword(values.password);
    } catch {
      setError(copy.auth.encryptionUnavailable);
      return;
    }

    try {
      const envelope = await authApi.login({ username: values.username, password, encrypted: true });
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
      const password = await encryptPassword(pendingCredentials.password);
      const envelope = await authApi.login({
        username: pendingCredentials.username,
        password,
        encrypted: true,
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
      setError(describeError(err));
    }
  });

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
                {oauth?.enabled && (
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full justify-start gap-phi-3"
                    onClick={() => void handleOauthLogin()}
                  >
                    {/logto/i.test(oauth.providerName ?? '') ? <LogIn strokeWidth={1.75} aria-hidden /> : <Network strokeWidth={1.75} aria-hidden />}
                    <span className="truncate">
                      {copy.auth.oauthLogin}
                      {oauth.providerName ? ` · ${oauth.providerName}` : ''}
                    </span>
                  </Button>
                )}

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
