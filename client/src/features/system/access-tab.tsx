import { useState } from 'react';
import { alertVariants } from '../../ui/alert';
import { AlertTriangle, Copy, Eye, EyeOff, KeyRound, Loader2, Lock, ShieldCheck, Wand2 } from 'lucide-react';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Skeleton, Switch } from '../../ui';
import { systemSecurityApi, type LogtoOAuthConfig, type OAuthConfig } from './security-api';
import { useDiscoverOidc, useLogtoConfig, useOAuthConfig, useSaveLogtoConfig, useSaveOAuthConfig } from './use-security-tab';

const OAUTH_DEFAULTS: OAuthConfig = {
  enabled: false, providerName: 'default', subjectKey: 'sub', emailKey: 'email',
  clientId: '', clientSecret: '', issuer: '', authorizationEndpoint: '', tokenEndpoint: '',
  userInfoEndpoint: '', jwksUri: '', scopes: 'openid profile email', redirectUri: '',
};
const LOGTO_DEFAULTS: LogtoOAuthConfig = {
  ...OAUTH_DEFAULTS, providerName: 'Logto', logtoDomain: '',
};

export function SystemAccessTab() {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const report = (err: unknown, fallback: string) => { setNotice(null); setError(err instanceof Error ? err.message : fallback); };
  const done = (message: string) => { setError(null); setNotice(message); };

  return (
    <div className="space-y-3">
      {error && (
        <div role="alert" className={alertVariants('error', 'flex items-center gap-2')}>
          <AlertTriangle className="h-4 w-4" /> {error}
        </div>
      )}
      {notice && (
        <div role="status" className={alertVariants('success')}>
          {notice}
        </div>
      )}

      <JwtSecretCard onError={report} onSaved={done} />
      <OAuthCard onError={report} onSaved={done} />
      <LogtoCard onError={report} onSaved={done} />
    </div>
  );
}

function JwtSecretCard({ onError, onSaved }: { onError: (e: unknown, f: string) => void; onSaved: (m: string) => void }) {
  const [password, setPassword] = useState('');
  const [secret, setSecret] = useState('');
  const [visible, setVisible] = useState(false);
  const [pending, setPending] = useState(false);

  const reveal = async () => {
    if (!password) { onError(new Error('请输入管理员密码'), '请输入管理员密码'); return; }
    setPending(true);
    try {
      const data = await systemSecurityApi.jwtSecret(password);
      setSecret(data.jwtSecret ?? '');
      setPassword('');
      onSaved('已获取 JWT 密钥（该操作已记录审计日志）');
    } catch (err) {
      onError(err, '获取失败');
    } finally {
      setPending(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Lock className="h-4 w-4" /> JWT 密钥</CardTitle>
        <CardDescription>仅初始超级管理员可查看；每次查看都会写入审计日志（可选邮件通知）。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2">
          <Input
            type="password"
            autoComplete="current-password"
            placeholder="管理员密码"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-label="管理员密码"
          />
          <Button variant="outline" size="sm" onClick={() => void reveal()} disabled={pending}>
            {pending && <Loader2 className="animate-spin" />}查看
          </Button>
        </div>
        {secret && (
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted/50 p-2">
            <code className="min-w-0 flex-1 break-all font-mono text-xs">
              {visible ? secret : secret.replace(/./g, '•')}
            </code>
            <Button variant="ghost" size="icon" aria-label={visible ? '隐藏密钥' : '显示密钥'} onClick={() => setVisible((v) => !v)}>
              {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="复制密钥"
              onClick={() => { void navigator.clipboard.writeText(secret); onSaved('已复制到剪贴板'); }}
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function OAuthCard({ onError, onSaved }: { onError: (e: unknown, f: string) => void; onSaved: (m: string) => void }) {
  const config = useOAuthConfig();
  const save = useSaveOAuthConfig();
  const discover = useDiscoverOidc();
  const [override, setOverride] = useState<OAuthConfig | null>(null);
  // 派生优先、本地编辑覆盖：服务端数据回来时自然生效，且不需要 effect 回填
  const draft: OAuthConfig = override ?? { ...OAUTH_DEFAULTS, ...(config.data ?? {}) };
  const setDraft = (next: OAuthConfig) => setOverride(next);

  const runDiscover = async () => {
    if (!draft.issuer?.trim()) { onError(new Error('请先填写 Issuer'), '请先填写 Issuer'); return; }
    try {
      const found = await discover.mutateAsync(draft.issuer.trim());
      setDraft({ ...draft, ...found });
      onSaved('已根据 OIDC 元数据填充端点');
    } catch (err) { onError(err, '自动发现失败'); }
  };

  const submit = async () => {
    try {
      await save.mutateAsync({ ...draft, providerName: draft.providerName?.trim() || 'default' });
      onSaved('OAuth 配置已保存');
    } catch (err) { onError(err, '保存失败'); }
  };

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2">
        <div>
          <CardTitle className="flex items-center gap-2"><ShieldCheck className="h-4 w-4" /> 单点登录（通用 OIDC）</CardTitle>
          <CardDescription>填写 Issuer 后可自动发现端点；保存后登录页会出现 SSO 入口。</CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={() => void runDiscover()} disabled={discover.isPending}>
          {discover.isPending ? <Loader2 className="animate-spin" /> : <Wand2 className="h-4 w-4" />}自动发现
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {config.isLoading ? <Skeleton className="h-24" /> : (
          <>
            <ToggleRow label="启用通用 OIDC" hint="与 Logto 配置互不影响，登录页会按启用的提供方展示" checked={Boolean(draft.enabled)} onChange={(checked) => setDraft({ ...draft, enabled: checked })} />
            <div className="grid gap-phi-6 sm:grid-cols-2">
              <Field label="提供方名称" id="oauth-provider" value={draft.providerName ?? ''} onChange={(value) => setDraft({ ...draft, providerName: value })} placeholder="例如：公司 SSO" />
              <Field label="Issuer" id="oauth-issuer" value={draft.issuer ?? ''} onChange={(value) => setDraft({ ...draft, issuer: value })} placeholder="https://sso.example.com" />
              <Field label="Client ID" id="oauth-client-id" value={draft.clientId ?? ''} onChange={(value) => setDraft({ ...draft, clientId: value })} />
              <Field label="Client Secret" id="oauth-client-secret" value={draft.clientSecret ?? ''} onChange={(value) => setDraft({ ...draft, clientSecret: value })} type="password" placeholder="留空表示不修改" />
              <Field label="Authorization Endpoint" id="oauth-authz" value={draft.authorizationEndpoint ?? ''} onChange={(value) => setDraft({ ...draft, authorizationEndpoint: value })} />
              <Field label="Token Endpoint" id="oauth-token" value={draft.tokenEndpoint ?? ''} onChange={(value) => setDraft({ ...draft, tokenEndpoint: value })} />
              <Field label="UserInfo Endpoint" id="oauth-userinfo" value={draft.userInfoEndpoint ?? ''} onChange={(value) => setDraft({ ...draft, userInfoEndpoint: value })} />
              <Field label="JWKS URI" id="oauth-jwks" value={draft.jwksUri ?? ''} onChange={(value) => setDraft({ ...draft, jwksUri: value })} />
              <Field label="Scopes" id="oauth-scopes" value={draft.scopes ?? ''} onChange={(value) => setDraft({ ...draft, scopes: value })} placeholder="openid profile email" />
              <Field label="回调地址（可选）" id="oauth-redirect" value={draft.redirectUri ?? ''} onChange={(value) => setDraft({ ...draft, redirectUri: value })} placeholder="默认使用当前站点 /oauth/callback" />
              <Field label="用户唯一标识字段" id="oauth-subject" value={draft.subjectKey ?? ''} onChange={(value) => setDraft({ ...draft, subjectKey: value })} placeholder="sub" />
              <Field label="邮箱字段" id="oauth-email" value={draft.emailKey ?? ''} onChange={(value) => setDraft({ ...draft, emailKey: value })} placeholder="email" />
            </div>
            <div className="flex justify-end">
              <Button size="sm" onClick={() => void submit()} disabled={save.isPending}>
                {save.isPending && <Loader2 className="animate-spin" />}保存 OAuth 配置
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function LogtoCard({ onError, onSaved }: { onError: (e: unknown, f: string) => void; onSaved: (m: string) => void }) {
  const config = useLogtoConfig();
  const save = useSaveLogtoConfig();
  const [override, setOverride] = useState<LogtoOAuthConfig | null>(null);
  const draft: LogtoOAuthConfig = override ?? { ...LOGTO_DEFAULTS, ...(config.data ?? {}) };
  const setDraft = (next: LogtoOAuthConfig) => setOverride(next);

  const submit = async () => {
    try {
      await save.mutateAsync({ ...draft, providerName: draft.providerName?.trim() || 'Logto' });
      onSaved('Logto 配置已保存');
    } catch (err) { onError(err, '保存失败'); }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><KeyRound className="h-4 w-4" /> Logto 登录</CardTitle>
        <CardDescription>Logto 专用配置；与通用 OIDC 可同时启用。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {config.isLoading ? <Skeleton className="h-20" /> : (
          <>
            <ToggleRow label="启用 Logto" hint="启用后登录页展示 Logto 入口" checked={Boolean(draft.enabled)} onChange={(checked) => setDraft({ ...draft, enabled: checked })} />
            <div className="grid gap-phi-6 sm:grid-cols-2">
              <Field label="Logto 域名" id="logto-domain" value={draft.logtoDomain ?? ''} onChange={(value) => setDraft({ ...draft, logtoDomain: value })} placeholder="https://xxx.logto.app" />
              <Field label="Client ID" id="logto-client-id" value={draft.clientId ?? ''} onChange={(value) => setDraft({ ...draft, clientId: value })} />
              <Field label="Client Secret" id="logto-client-secret" value={draft.clientSecret ?? ''} onChange={(value) => setDraft({ ...draft, clientSecret: value })} type="password" placeholder="留空表示不修改" />
              <Field label="Scopes" id="logto-scopes" value={draft.scopes ?? ''} onChange={(value) => setDraft({ ...draft, scopes: value })} placeholder="openid profile email" />
            </div>
            <div className="flex justify-end">
              <Button size="sm" onClick={() => void submit()} disabled={save.isPending}>
                {save.isPending && <Loader2 className="animate-spin" />}保存 Logto 配置
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Field({ label, id, value, onChange, placeholder, type = 'text' }: {
  label: string; id: string; value: string; onChange: (value: string) => void; placeholder?: string; type?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type={type} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}

function ToggleRow({ label, hint, checked, onChange }: {
  label: string; hint: string; checked: boolean; onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </div>
  );
}
