import { useState } from 'react';
import { alertVariants } from '../../ui/alert';
import { AlertTriangle, KeyRound, Link2, Loader2, Save, UserRound } from 'lucide-react';
import {
  Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Select,
  SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton, Switch,
} from '../../ui';
import { useSession } from '../session/use-session';
import { useThemeMode } from '../../lib/theme';
import { encryptPassword } from '../../utils/rsaEncrypt';
import { settingsApi } from './api';
import { useChangePassword, useOauthBindings, usePreferences, useUnbindOauth, useUpdatePreferences, useUpdateProfile } from './use-settings';

export function SettingsPage() {
  const { user, refetch } = useSession();
  const preferences = usePreferences();
  const bindings = useOauthBindings();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const report = (err: unknown, fallback: string) => setError(err instanceof Error ? err.message : fallback);

  return (
    <div className="space-y-phi-6">
      <div>
        <h2 className="text-heading font-semibold">设置</h2>
        <p className="text-xs text-muted-foreground">个人资料、密码、偏好与账号绑定</p>
      </div>

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

      <ProfileCard
        nickname={user?.nickname || user?.username || ''}
        email={user?.email || ''}
        onError={(message) => { setError(message); setNotice(null); }}
        onSaved={async (message) => { setNotice(message); setError(null); await refetch(); }}
      />

      <PasswordCard
        onError={(message) => { setError(message); setNotice(null); }}
        onSaved={(message) => { setNotice(message); setError(null); }}
      />

      <PreferencesCard
        loading={preferences.isLoading}
        data={preferences.data}
        onError={(message) => { setError(message); setNotice(null); }}
        onSaved={(message) => { setNotice(message); setError(null); }}
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Link2 className="h-4 w-4" /> 账号绑定</CardTitle>
          <CardDescription>绑定单点登录账号后可不使用密码登录。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {bindings.isLoading ? (
            <Skeleton className="h-10" />
          ) : (bindings.data ?? []).length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">还没有绑定任何外部账号</p>
          ) : (
            <ul className="divide-y divide-border">
              {(bindings.data ?? []).map((binding) => (
                <BindingRow
                  key={binding.provider}
                  provider={binding.provider}
                  providerName={binding.providerName}
                  email={binding.email}
                  onError={(message) => setError(message)}
                />
              ))}
            </ul>
          )}
          <div className="flex justify-end">
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                setError(null);
                try {
                  const envelope = await settingsApi.startOauthBind();
                  if (envelope.code !== 0 || !envelope.data?.authUrl) throw new Error(envelope.msg || '无法启动绑定');
                  window.location.assign(envelope.data.authUrl);
                } catch (err) {
                  report(err, '绑定失败');
                }
              }}
            >
              绑定外部账号
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ProfileCard({ nickname: initialNickname, email: initialEmail, onError, onSaved }: {
  nickname: string;
  email: string;
  onError: (message: string) => void;
  onSaved: (message: string) => Promise<void>;
}) {
  const update = useUpdateProfile();
  // 派生优先：会话数据刷新后自动同步，用户编辑后以本地为准（无需 effect 回填）
  const [nicknameEdit, setNicknameEdit] = useState<string | null>(null);
  const [emailEdit, setEmailEdit] = useState<string | null>(null);
  const nickname = nicknameEdit ?? initialNickname;
  const email = emailEdit ?? initialEmail;
  const [code, setCode] = useState('');
  const [sending, setSending] = useState(false);
  const setNickname = (value: string) => setNicknameEdit(value);
  const setEmail = (value: string) => setEmailEdit(value);

  const emailChanged = email.trim() !== '' && email.trim() !== initialEmail;
  // 只拦空昵称；缺验证码交由 save() 给出可读原因（按钮禁用不会告诉用户「为什么不能点」）
  const canSave = nickname.trim() !== '';

  const sendCode = async () => {
    setSending(true);
    try {
      const envelope = await settingsApi.sendEmailCode(email.trim());
      if (envelope.code !== 0) throw new Error(envelope.msg || '发送失败');
      await onSaved('验证码已发送到新邮箱');
    } catch (err) {
      onError(err instanceof Error ? err.message : '发送验证码失败');
    } finally {
      setSending(false);
    }
  };

  const save = async () => {
    const nextEmail = email.trim();
    // 本地先拦：改邮箱必须带验证码，邮箱不能清空；否则会拿到服务端的英文 400
    if (!nextEmail) { onError('邮箱不能为空'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextEmail)) { onError('邮箱格式不正确'); return; }
    if (emailChanged && !code.trim()) { onError('修改邮箱需要先获取并填写验证码'); return; }
    try {
      await update.mutateAsync({ nickname: nickname.trim(), email: nextEmail, emailCode: emailChanged ? code.trim() : undefined });
      setCode('');
      await onSaved('个人资料已保存');
    } catch (err) {
      onError(err instanceof Error ? err.message : '保存失败');
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><UserRound className="h-4 w-4" /> 个人资料</CardTitle>
        <CardDescription>修改昵称或邮箱；修改邮箱需要验证码。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-phi-6 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="settings-nickname">昵称</Label>
            <Input id="settings-nickname" value={nickname} onChange={(event) => setNickname(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="settings-email">邮箱</Label>
            <Input id="settings-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
          </div>
          {emailChanged && (
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="settings-email-code">新邮箱验证码</Label>
              <div className="flex gap-2">
                <Input id="settings-email-code" value={code} onChange={(event) => setCode(event.target.value)} placeholder="6 位验证码" />
                <Button variant="outline" size="sm" onClick={() => void sendCode()} disabled={sending}>
                  {sending && <Loader2 className="animate-spin" />}
                  发送验证码
                </Button>
              </div>
            </div>
          )}
        </div>
        <div className="flex justify-end">
          <Button size="sm" onClick={() => void save()} disabled={!canSave || update.isPending}>
            {update.isPending ? <Loader2 className="animate-spin" /> : <Save className="h-4 w-4" />}
            保存资料
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function PasswordCard({ onError, onSaved }: { onError: (message: string) => void; onSaved: (message: string) => void }) {
  const change = useChangePassword();
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  const save = async () => {
    if (!oldPassword || !newPassword) { onError('请填写当前密码与新密码'); return; }
    if (newPassword.length < 6) { onError('新密码至少 6 位'); return; }
    if (newPassword !== confirm) { onError('两次输入的新密码不一致'); return; }
    try {
      const [oldEncrypted, newEncrypted] = await Promise.all([encryptPassword(oldPassword), encryptPassword(newPassword)]);
      const envelope = await change.mutateAsync({ oldPassword: oldEncrypted, newPassword: newEncrypted });
      if (envelope.code !== 0) throw new Error(envelope.msg || '修改失败');
      setOldPassword(''); setNewPassword(''); setConfirm('');
      onSaved('密码已更新');
    } catch (err) {
      onError(err instanceof Error ? err.message : '修改密码失败');
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><KeyRound className="h-4 w-4" /> 修改密码</CardTitle>
        <CardDescription>密码通过 RSA 加密后提交，服务端按安全策略校验强度。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-phi-6 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="settings-old-password">当前密码</Label>
            <Input id="settings-old-password" type="password" autoComplete="current-password" value={oldPassword} onChange={(event) => setOldPassword(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="settings-new-password">新密码</Label>
            <Input id="settings-new-password" type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="settings-confirm-password">确认新密码</Label>
            <Input id="settings-confirm-password" type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} />
          </div>
        </div>
        <div className="flex justify-end">
          <Button size="sm" onClick={() => void save()} disabled={change.isPending}>
            {change.isPending && <Loader2 className="animate-spin" />}
            更新密码
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function PreferencesCard({ loading, data, onError, onSaved }: {
  loading: boolean;
  data?: { notificationsEnabled?: boolean; emailNotifications?: boolean; avatarImage?: string; backgroundImage?: string };
  onError: (message: string) => void;
  onSaved: (message: string) => void;
}) {
  const update = useUpdatePreferences();
  const theme = useThemeMode();
  // 派生优先：偏好数据回来后自动生效，本地编辑覆盖
  const [notificationsEdit, setNotificationsEdit] = useState<boolean | null>(null);
  const [emailNotificationsEdit, setEmailNotificationsEdit] = useState<boolean | null>(null);
  const [avatarEdit, setAvatarEdit] = useState<string | null>(null);
  const [backgroundEdit, setBackgroundEdit] = useState<string | null>(null);
  const notifications = notificationsEdit ?? data?.notificationsEnabled ?? true;
  const emailNotifications = emailNotificationsEdit ?? data?.emailNotifications ?? false;
  const avatarImage = avatarEdit ?? data?.avatarImage ?? '';
  const backgroundImage = backgroundEdit ?? data?.backgroundImage ?? '';

  const save = async () => {
    try {
      await update.mutateAsync({
        // 主题同时落到服务端偏好：换设备登录时仍是同一主题（本地 localStorage 只管首屏）
        theme: theme.mode === 'system' ? 'auto' : theme.mode,
        notificationsEnabled: notifications,
        emailNotifications,
        avatarImage,
        backgroundImage,
      });
      onSaved('偏好已保存');
    } catch (err) {
      onError(err instanceof Error ? err.message : '保存失败');
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>偏好</CardTitle>
        <CardDescription>主题、通知与个性化资源。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="space-y-2">{Array.from({ length: 3 }, (_, index) => <Skeleton key={index} className="h-9" />)}</div>
        ) : (
          <>
            <div className="grid gap-phi-6 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="settings-theme">主题</Label>
                <Select value={theme.mode} onValueChange={(value) => theme.setMode(value as 'light' | 'dark' | 'system')}>
                  <SelectTrigger id="settings-theme"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="system">跟随系统</SelectItem>
                    <SelectItem value="light">浅色</SelectItem>
                    <SelectItem value="dark">深色</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="settings-avatar">头像地址</Label>
                <Input id="settings-avatar" value={avatarImage} onChange={(event) => setAvatarEdit(event.target.value)} placeholder="https://…" />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="settings-background">背景图地址</Label>
                <div className="flex gap-2">
                  <Input
                    id="settings-background"
                    value={backgroundImage}
                    onChange={(event) => setBackgroundEdit(event.target.value)}
                    placeholder="留空使用默认图；填 none 关闭背景"
                  />
                  <Button variant="outline" size="sm" onClick={() => setBackgroundEdit('none')} disabled={backgroundImage === 'none'}>
                    关闭背景
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  仅接受 http(s) 地址；留空表示使用默认背景（t.alcy.cc/moez），保存后立即生效。
                </p>
                {backgroundImage && backgroundImage !== 'none' && /^https?:\/\//.test(backgroundImage) && (
                  <div className="mt-1.5 h-[54px] w-24 overflow-hidden rounded-md border border-border">
                    <img src={backgroundImage} alt="" className="h-full w-full object-cover" loading="lazy" />
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
              <div>
                <p className="text-sm font-medium">站内通知</p>
                <p className="text-xs text-muted-foreground">域名到期、记录变更等事件</p>
              </div>
              <Switch checked={notifications} onCheckedChange={setNotificationsEdit} aria-label="站内通知" />
            </div>
            <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
              <div>
                <p className="text-sm font-medium">邮件通知</p>
                <p className="text-xs text-muted-foreground">需要管理员配置 SMTP</p>
              </div>
              <Switch checked={emailNotifications} onCheckedChange={setEmailNotificationsEdit} aria-label="邮件通知" />
            </div>
          </>
        )}
        <div className="flex justify-end">
          <Button size="sm" onClick={() => void save()} disabled={update.isPending || loading}>保存偏好</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function BindingRow({ provider, providerName, email, onError }: {
  provider: string;
  providerName?: string;
  email?: string;
  onError: (message: string) => void;
}) {
  const unbind = useUnbindOauth();
  return (
    <li className="flex items-center gap-3 py-2.5 text-sm">
      <Badge variant="secondary">{providerName || provider}</Badge>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{email || '—'}</span>
      <Button
        variant="ghost"
        size="sm"
        className="text-destructive hover:bg-destructive/10"
        onClick={async () => {
          try { await unbind.mutateAsync(provider); } catch (err) { onError(err instanceof Error ? err.message : '解绑失败'); }
        }}
        disabled={unbind.isPending}
      >
        解绑
      </Button>
    </li>
  );
}
