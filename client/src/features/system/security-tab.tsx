import { useState } from 'react';
import { alertVariants } from '../../ui/alert';
import { AlertTriangle, KeyRound, Loader2, Mail, ShieldAlert, Unlock } from 'lucide-react';
import {
  Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Skeleton, Switch,
} from '../../ui';
import {
  useAuditRules, useLoginLimit, useLoginStats, useMcpConfig, useSaveAuditRules, useSaveLoginLimit,
  useSaveMcpConfig, useSaveSecurityConfig, useSaveSmtp, useSecurityConfig, useSmtpConfig, useTestSmtp, useUnlockAccount,
} from './use-security-tab';
import type { AuditRules, LoginLimitConfig, SecurityConfig, SmtpConfig } from './security-api';

const LOGIN_DEFAULTS: LoginLimitConfig = { enabled: true, maxAttempts: 5, lockoutDuration: 15 };
const SMTP_DEFAULTS: SmtpConfig = { enabled: false, host: '', port: 587, secure: false, username: '', password: '', fromEmail: '', fromName: 'HiDNS' };
const SECURITY_DEFAULTS: SecurityConfig = { jwtViewEmailNotify: false, domainExpiryNotify: false, domainExpiryDays: 30, showDnsProviderSecrets: false };
const RULES_DEFAULTS: AuditRules = { enabled: true, maxDeletionsPerHour: 10, maxFailedLogins: 5, offHoursStart: '22:00', offHoursEnd: '06:00' };

export function SystemSecurityTab() {
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

      <LoginLimitCard onError={report} onSaved={done} />
      <SmtpCard onError={report} onSaved={done} />
      <SecurityConfigCard onError={report} onSaved={done} />
      <AuditRulesCard onError={report} onSaved={done} />
      <McpCard onError={report} onSaved={done} />

      <p className="text-xs text-muted-foreground">
        单点登录（OAuth / OIDC）配置已迁移至「访问」标签页。
      </p>
    </div>
  );
}

function LoginLimitCard({ onError, onSaved }: { onError: (e: unknown, f: string) => void; onSaved: (m: string) => void }) {
  const limit = useLoginLimit();
  const stats = useLoginStats();
  const save = useSaveLoginLimit();
  const unlock = useUnlockAccount();
  const [override, setOverride] = useState<LoginLimitConfig | null>(null);
  const [identifier, setIdentifier] = useState('');
  // 派生优先、本地编辑覆盖：服务端数据回来自然生效，无需 effect 回填
  const draft: LoginLimitConfig = override ?? { ...LOGIN_DEFAULTS, ...(limit.data ?? {}) };
  const setDraft = (next: LoginLimitConfig) => setOverride(next);

  const submit = async () => {
    try {
      await save.mutateAsync(draft);
      onSaved('登录限制已保存');
    } catch (err) { onError(err, '保存失败'); }
  };

  const unlockAccount = async () => {
    if (!identifier.trim()) { onError(new Error('请输入用户名或 IP'), '请输入用户名或 IP'); return; }
    try {
      await unlock.mutateAsync(identifier.trim());
      setIdentifier('');
      onSaved('已解锁');
    } catch (err) { onError(err, '解锁失败'); }
  };

  const statRows = toRows(stats.data);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><ShieldAlert className="h-4 w-4" /> 登录限制</CardTitle>
        <CardDescription>连续失败达阈值后锁定账号 / IP，可用于应急解锁。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {limit.isLoading ? <Skeleton className="h-20" /> : (
          <>
            <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
              <div>
                <p className="text-sm font-medium">启用登录失败锁定</p>
                <p className="text-xs text-muted-foreground">关闭后不再统计失败次数</p>
              </div>
              <Switch checked={Boolean(draft.enabled)} onCheckedChange={(checked) => setDraft({ ...draft, enabled: checked })} aria-label="启用登录失败锁定" />
            </div>
            <div className="grid gap-phi-6 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="login-max-attempts">最大失败次数</Label>
                <Input id="login-max-attempts" inputMode="numeric" value={String(draft.maxAttempts ?? '')} onChange={(event) => setDraft({ ...draft, maxAttempts: Number(event.target.value) || 0 })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="login-lockout">锁定时长（分钟）</Label>
                <Input id="login-lockout" inputMode="numeric" value={String(draft.lockoutDuration ?? '')} onChange={(event) => setDraft({ ...draft, lockoutDuration: Number(event.target.value) || 0 })} />
              </div>
            </div>
            <div className="flex justify-end">
              <Button size="sm" onClick={() => void submit()} disabled={save.isPending}>
                {save.isPending && <Loader2 className="animate-spin" />}保存登录限制
              </Button>
            </div>

            <div className="space-y-2 rounded-md border border-border p-3">
              <p className="text-xs font-medium text-muted-foreground">当前失败统计</p>
              {stats.isLoading ? <Skeleton className="h-12" /> : statRows.length === 0 ? (
                <p className="text-xs text-muted-foreground">暂无失败记录</p>
              ) : (
                <ul className="divide-y divide-border text-xs">
                  {statRows.slice(0, 6).map((row) => (
                    <li key={row.key} className="flex items-center justify-between gap-2 py-1">
                      <span className="truncate">{row.key}</span>
                      <span className="text-muted-foreground">{row.value}</span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex gap-2">
                <Input placeholder="用户名或 IP" value={identifier} onChange={(event) => setIdentifier(event.target.value)} aria-label="解锁目标" />
                <Button variant="outline" size="sm" onClick={() => void unlockAccount()} disabled={unlock.isPending}>
                  {unlock.isPending ? <Loader2 className="animate-spin" /> : <Unlock className="h-4 w-4" />}解锁
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function SmtpCard({ onError, onSaved }: { onError: (e: unknown, f: string) => void; onSaved: (m: string) => void }) {
  const smtp = useSmtpConfig();
  const save = useSaveSmtp();
  const test = useTestSmtp();
  const [override, setOverride] = useState<SmtpConfig | null>(null);
  const [testTo, setTestTo] = useState('');
  const draft: SmtpConfig = override ?? { ...SMTP_DEFAULTS, ...(smtp.data ?? {}) };
  const setDraft = (next: SmtpConfig) => setOverride(next);

  const submit = async () => {
    try {
      await save.mutateAsync(draft);
      onSaved('SMTP 配置已保存');
    } catch (err) { onError(err, '保存失败'); }
  };

  const sendTest = async () => {
    try {
      await test.mutateAsync(testTo.trim());
      onSaved('测试邮件已发送');
    } catch (err) { onError(err, '发送测试邮件失败'); }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Mail className="h-4 w-4" /> SMTP</CardTitle>
        <CardDescription>域名到期提醒、验证码等邮件依赖此配置。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {smtp.isLoading ? <Skeleton className="h-24" /> : (
          <>
            <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
              <div>
                <p className="text-sm font-medium">启用 SMTP</p>
                <p className="text-xs text-muted-foreground">关闭时所有邮件通知不会发送</p>
              </div>
              <Switch checked={Boolean(draft.enabled)} onCheckedChange={(checked) => setDraft({ ...draft, enabled: checked })} aria-label="启用 SMTP" />
            </div>
            <div className="grid gap-phi-6 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="smtp-host">服务器</Label>
                <Input id="smtp-host" value={draft.host ?? ''} onChange={(event) => setDraft({ ...draft, host: event.target.value })} placeholder="smtp.example.com" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="smtp-port">端口</Label>
                <Input id="smtp-port" inputMode="numeric" value={String(draft.port ?? '')} onChange={(event) => setDraft({ ...draft, port: Number(event.target.value) || 0 })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="smtp-user">用户名</Label>
                <Input id="smtp-user" value={draft.username ?? ''} onChange={(event) => setDraft({ ...draft, username: event.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="smtp-pass">密码</Label>
                <Input id="smtp-pass" type="password" value={draft.password ?? ''} onChange={(event) => setDraft({ ...draft, password: event.target.value })} placeholder="留空表示不修改" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="smtp-from-email">发件邮箱</Label>
                <Input id="smtp-from-email" type="email" value={draft.fromEmail ?? ''} onChange={(event) => setDraft({ ...draft, fromEmail: event.target.value })} placeholder="no-reply@example.com" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="smtp-from-name">发件人显示名</Label>
                <Input id="smtp-from-name" value={draft.fromName ?? ''} onChange={(event) => setDraft({ ...draft, fromName: event.target.value })} placeholder="HiDNS" />
              </div>
              <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 sm:col-span-2">
                <div>
                  <p className="text-sm font-medium">使用 SSL/TLS</p>
                  <p className="text-xs text-muted-foreground">465 端口通常需要开启</p>
                </div>
                <Switch checked={Boolean(draft.secure)} onCheckedChange={(checked) => setDraft({ ...draft, secure: checked })} aria-label="使用 SSL/TLS" />
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <div className="flex flex-1 items-center gap-2">
                <Input placeholder="测试收件地址（留空发给当前用户）" value={testTo} onChange={(event) => setTestTo(event.target.value)} aria-label="测试收件地址" />
                <Button variant="outline" size="sm" onClick={() => void sendTest()} disabled={test.isPending}>
                  {test.isPending && <Loader2 className="animate-spin" />}发送测试
                </Button>
              </div>
              <Button size="sm" onClick={() => void submit()} disabled={save.isPending}>
                {save.isPending && <Loader2 className="animate-spin" />}保存 SMTP
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function SecurityConfigCard({ onError, onSaved }: { onError: (e: unknown, f: string) => void; onSaved: (m: string) => void }) {
  const config = useSecurityConfig();
  const save = useSaveSecurityConfig();
  const [override, setOverride] = useState<SecurityConfig | null>(null);
  // 派生优先、本地编辑覆盖（避免 effect 回填引发的级联渲染）
  const draft: SecurityConfig = override ?? { ...SECURITY_DEFAULTS, ...(config.data ?? {}) };
  const setDraft = (next: SecurityConfig) => setOverride(next);

  const submit = async () => {
    try {
      await save.mutateAsync(draft);
      onSaved('安全配置已保存');
    } catch (err) { onError(err, '保存失败'); }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><KeyRound className="h-4 w-4" /> 安全与敏感信息</CardTitle>
        <CardDescription>控制管理员可见范围与域名到期提醒。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {config.isLoading ? <Skeleton className="h-20" /> : (
          <>
            <ToggleRow label="向管理员明文展示 DNS 凭据" hint="关闭时列表仅返回 ***，凭据不会出现在浏览器" checked={Boolean(draft.showDnsProviderSecrets)} onChange={(checked) => setDraft({ ...draft, showDnsProviderSecrets: checked })} />
            <ToggleRow label="JWT 视图发送邮件通知" hint="记录变更时通知相关用户" checked={Boolean(draft.jwtViewEmailNotify)} onChange={(checked) => setDraft({ ...draft, jwtViewEmailNotify: checked })} />
            <ToggleRow label="域名到期提醒" hint="到期前若干天发送邮件" checked={Boolean(draft.domainExpiryNotify)} onChange={(checked) => setDraft({ ...draft, domainExpiryNotify: checked })} />
            <div className="space-y-1.5">
              <Label htmlFor="expiry-days">到期提醒提前天数</Label>
              <Input id="expiry-days" inputMode="numeric" value={String(draft.domainExpiryDays ?? '')} onChange={(event) => setDraft({ ...draft, domainExpiryDays: Number(event.target.value) || 0 })} />
            </div>
            <div className="flex justify-end">
              <Button size="sm" onClick={() => void submit()} disabled={save.isPending}>
                {save.isPending && <Loader2 className="animate-spin" />}保存安全配置
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function AuditRulesCard({ onError, onSaved }: { onError: (e: unknown, f: string) => void; onSaved: (m: string) => void }) {
  const rules = useAuditRules();
  const save = useSaveAuditRules();
  const [override, setOverride] = useState<AuditRules | null>(null);
  // 派生优先、本地编辑覆盖（避免 effect 回填引发的级联渲染）
  const draft: AuditRules = override ?? { ...RULES_DEFAULTS, ...(rules.data ?? {}) };
  const setDraft = (next: AuditRules) => setOverride(next);

  const submit = async () => {
    try {
      await save.mutateAsync(draft);
      onSaved('审计规则已保存');
    } catch (err) { onError(err, '保存失败'); }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>审计规则</CardTitle>
        <CardDescription>异常操作识别阈值（删除频率、失败登录、非工作时段）。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {rules.isLoading ? <Skeleton className="h-20" /> : (
          <>
            <ToggleRow label="启用审计规则" hint="关闭后不再产生异常标记" checked={Boolean(draft.enabled)} onChange={(checked) => setDraft({ ...draft, enabled: checked })} />
            <div className="grid gap-phi-6 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="rule-deletions">每小时最大删除次数</Label>
                <Input id="rule-deletions" inputMode="numeric" value={String(draft.maxDeletionsPerHour ?? '')} onChange={(event) => setDraft({ ...draft, maxDeletionsPerHour: Number(event.target.value) || 0 })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rule-failed">最大失败登录次数</Label>
                <Input id="rule-failed" inputMode="numeric" value={String(draft.maxFailedLogins ?? '')} onChange={(event) => setDraft({ ...draft, maxFailedLogins: Number(event.target.value) || 0 })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rule-off-start">非工作时段开始</Label>
                <Input id="rule-off-start" type="time" value={draft.offHoursStart ?? ''} onChange={(event) => setDraft({ ...draft, offHoursStart: event.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rule-off-end">非工作时段结束</Label>
                <Input id="rule-off-end" type="time" value={draft.offHoursEnd ?? ''} onChange={(event) => setDraft({ ...draft, offHoursEnd: event.target.value })} />
              </div>
            </div>
            <div className="flex justify-end">
              <Button size="sm" onClick={() => void submit()} disabled={save.isPending}>
                {save.isPending && <Loader2 className="animate-spin" />}保存审计规则
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function McpCard({ onError, onSaved }: { onError: (e: unknown, f: string) => void; onSaved: (m: string) => void }) {
  const config = useMcpConfig();
  const save = useSaveMcpConfig();

  return (
    <Card>
      <CardHeader>
        <CardTitle>MCP 全局开关</CardTitle>
        <CardDescription>关闭后所有 MCP 客户端无法连接（仅超级管理员可改）。</CardDescription>
      </CardHeader>
      <CardContent>
        {config.isLoading ? <Skeleton className="h-10" /> : (
          <ToggleRow
            label="启用 MCP 服务"
            hint={config.data?.enabled ? '当前：已启用' : '当前：已停用'}
            checked={Boolean(config.data?.enabled)}
            onChange={async (checked) => {
              try { await save.mutateAsync(checked); onSaved(checked ? 'MCP 已启用' : 'MCP 已停用'); }
              catch (err) { onError(err, '切换失败'); }
            }}
          />
        )}
      </CardContent>
    </Card>
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

function toRows(stats: unknown): Array<{ key: string; value: string }> {
  if (!stats) return [];
  if (Array.isArray(stats)) {
    return stats.slice(0, 20).map((item, index) => {
      if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>;
        const key = String(record.identifier ?? record.username ?? record.ip ?? record.key ?? ('#' + (index + 1)));
        const value = String(record.attempts ?? record.count ?? record.failures ?? '');
        return { key, value };
      }
      return { key: String(item), value: '' };
    });
  }
  if (typeof stats === 'object') {
    return Object.entries(stats as Record<string, unknown>).map(([key, value]) => ({
      key,
      value: typeof value === 'object' ? JSON.stringify(value) : String(value),
    }));
  }
  return [];
}
