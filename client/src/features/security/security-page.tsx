import { useState } from 'react';
import { alertVariants } from '../../ui/alert';
import { formatDate } from '../../lib/format';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Fingerprint, KeyRound, Laptop, Loader2, ShieldCheck, Trash2 } from 'lucide-react';
import { startRegistration } from '@simplewebauthn/browser';
import {
  Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ConfirmDialog, Dialog,
  DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label, Skeleton, Switch,
} from '../../ui';
import { securityApi, deviceKey, deviceLabel, deviceMeta, type SecurityPolicy, type TwoFactorSetup } from './api';
import {
  useDisableTwoFactor, useEnableTwoFactor, useRemoveAllTrustedDevices, useRemoveTrustedDevice,
  useDeletePasskey, usePasskeys, useSecurityPolicy, useTrustedDevices, useTwoFactorStatus, useUpdateSecurityPolicy,
} from './use-security';
import { useSession } from '../session/use-session';
import { isAdminUser } from '../session/use-session';

const POLICY_DEFAULTS: SecurityPolicy = {
  require2FAGlobal: false,
  minPasswordLength: 8,
  minPasswordStrength: 2,
  sessionTimeoutHours: 168,
  maxLoginAttempts: 5,
  lockoutDurationMinutes: 15,
  allowRememberDevice: true,
};

export function SecurityPage() {
  const { user } = useSession();
  const admin = isAdminUser(user);
  const status = useTwoFactorStatus();
  const devices = useTrustedDevices();
  const passkeys = usePasskeys();
  const policy = useSecurityPolicy(admin);

  const [setupOpen, setSetupOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [pendingRemoveAll, setPendingRemoveAll] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const removeAll = useRemoveAllTrustedDevices();

  const handleRemoveAll = async () => {
    setError(null);
    try {
      await removeAll.mutateAsync();
      setPendingRemoveAll(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败');
    }
  };

  return (
    <div className="space-y-phi-6">
      <div>
        <h2 className="text-heading font-semibold">安全</h2>
        <p className="text-xs text-muted-foreground">两步验证、可信设备与全局安全策略</p>
      </div>

      {error && (
        <div role="alert" className={alertVariants('error', 'flex items-center gap-2')}>
          <AlertTriangle className="h-4 w-4" /> {error}
        </div>
      )}

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2"><ShieldCheck className="h-4 w-4" /> 两步验证（TOTP）</CardTitle>
            <CardDescription>
              使用身份验证器 App 生成的一次性验证码，作为密码之外的第二重校验。
            </CardDescription>
          </div>
          {status.isLoading
            ? <Skeleton className="h-6 w-20" />
            : status.data?.configured
              ? <Badge variant="success">已启用</Badge>
              : <Badge variant="secondary">未启用</Badge>}
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {status.data?.validationEnabled
              ? '管理员已全局要求两步验证，登录时必须输入动态验证码。'
              : '系统未强制两步验证；建议为管理员账号开启。'}
          </p>
          {status.data?.configured ? (
            <Button variant="outline" size="sm" onClick={() => setDisableOpen(true)}>停用两步验证</Button>
          ) : (
            <Button size="sm" onClick={() => setSetupOpen(true)} disabled={status.isLoading}>启用两步验证</Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2"><Laptop className="h-4 w-4" /> 可信设备</CardTitle>
            <CardDescription>勾选「记住设备」后登录过的终端；移除后下次登录需要重新验证。</CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPendingRemoveAll(true)}
            disabled={(devices.data ?? []).length === 0}
          >
            全部移除
          </Button>
        </CardHeader>
        <CardContent>
          {devices.isLoading ? (
            <div className="space-y-2">{Array.from({ length: 3 }, (_, index) => <Skeleton key={index} className="h-10" />)}</div>
          ) : (devices.data ?? []).length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">还没有受信任的设备</p>
          ) : (
            <ul className="divide-y divide-border">
              {(devices.data ?? []).map((device) => (
                <DeviceRow key={deviceKey(device)} device={device} onError={setError} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2"><Fingerprint className="h-4 w-4" /> 通行密钥（Passkey）</CardTitle>
            <CardDescription>使用系统指纹 / Windows Hello / 安全密钥免密码登录。</CardDescription>
          </div>
          <RegisterPasskeyButton onError={setError} />
        </CardHeader>
        <CardContent>
          {passkeys.isLoading ? (
            <div className="space-y-2">{Array.from({ length: 2 }, (_, index) => <Skeleton key={index} className="h-10" />)}</div>
          ) : (passkeys.data ?? []).length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">还没有注册通行密钥</p>
          ) : (
            <ul className="divide-y divide-border">
              {(passkeys.data ?? []).map((passkey) => (
                <PasskeyRow key={passkey.id} passkey={passkey} onError={setError} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {admin && (
        <PolicyCard
          policy={policy.data}
          loading={policy.isLoading}
          error={policy.error}
          onRetry={() => void policy.refetch()}
        />
      )}

      <TwoFactorSetupDialog
        open={setupOpen}
        onOpenChange={setSetupOpen}
        onError={setError}
      />

      <DisableTwoFactorDialog open={disableOpen} onOpenChange={setDisableOpen} onError={setError} />

      <ConfirmDialog
        open={pendingRemoveAll}
        title="移除全部可信设备"
        description="所有终端下次登录都需要重新完成两步验证。"
        confirmLabel="全部移除"
        pending={removeAll.isPending}
        onConfirm={() => void handleRemoveAll()}
        onCancel={() => setPendingRemoveAll(false)}
      />
    </div>
  );
}

function DeviceRow({ device, onError }: { device: Parameters<typeof deviceLabel>[0]; onError: (message: string) => void }) {
  const remove = useRemoveTrustedDevice();
  const [pending, setPending] = useState(false);

  const handleRemove = async () => {
    try {
      await remove.mutateAsync(deviceKey(device));
      setPending(false);
    } catch (err) {
      onError(err instanceof Error ? err.message : '移除失败');
      setPending(false);
    }
  };

  return (
    <li className="flex items-center gap-3 py-2.5 text-sm">
      <Laptop className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="truncate">{deviceLabel(device)}</p>
        <p className="truncate text-xs text-muted-foreground">{deviceMeta(device) || '—'}</p>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="text-destructive hover:bg-destructive/10"
        aria-label="移除设备"
        onClick={() => setPending(true)}
      >
        <Trash2 className="h-4 w-4" />
      </Button>
      <ConfirmDialog
        open={pending}
        title="移除可信设备"
        description="移除后该设备下次登录需要重新完成两步验证。"
        confirmLabel="移除"
        pending={remove.isPending}
        onConfirm={() => void handleRemove()}
        onCancel={() => setPending(false)}
      />
    </li>
  );
}

function TwoFactorSetupDialog({ open, onOpenChange, onError }: { open: boolean; onOpenChange: (open: boolean) => void; onError: (message: string) => void }) {
  const enable = useEnableTwoFactor();
  const [setup, setSetup] = useState<TwoFactorSetup | null>(null);
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 打开时拉一次密钥：父级只在打开时挂载本组件（见 TwoFactorSetupDialog 的调用处），
  // 因此这里只需在挂载期请求一次，无需 effect、也无需 ref 去重。
  if (open && !loading && !setup && !error) {
    setLoading(true);
    void securityApi.setupTwoFactor()
      .then((envelope) => {
        if (envelope.code !== 0) throw new Error(envelope.msg || '初始化失败');
        setSetup(envelope.data);
      })
      .catch((err) => setError(err instanceof Error ? err.message : '初始化失败'))
      .finally(() => setLoading(false));
  }

  const submit = async () => {
    if (!setup) return;
    setError(null);
    try {
      await enable.mutateAsync({ secret: setup.secret, token: token.trim(), backupCodes: setup.backupCodes });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '启用失败');
      onError(err instanceof Error ? err.message : '启用失败');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(94vw,32rem)]">
        <DialogHeader>
          <DialogTitle>启用两步验证</DialogTitle>
          <DialogDescription>用身份验证器扫描二维码，然后输入当前的 6 位验证码完成绑定。</DialogDescription>
        </DialogHeader>

        {(error || loading) && (
          <div className="mb-3 text-sm">
            {loading ? <span className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> 正在生成密钥…</span>
              : <span role="alert" className="text-destructive">{error}</span>}
          </div>
        )}

        {setup && (
          <div className="space-y-3">
            <div className="flex justify-center rounded-md border border-border bg-white p-3">
              <img src={setup.qrCode} alt="两步验证二维码" className="h-40 w-40" />
            </div>
            <div className="space-y-1 text-xs">
              <p className="text-muted-foreground">无法扫码时手动输入密钥：</p>
              <code className="block break-all rounded bg-muted px-2 py-1 font-mono">{setup.secret}</code>
            </div>
            <div className="space-y-1 text-xs">
              <p className="text-muted-foreground">备用恢复码（请妥善保存，每个只能使用一次）：</p>
              <div className="grid grid-cols-2 gap-1 rounded bg-muted p-2 font-mono text-xs">
                {setup.backupCodes.map((code) => <span key={code}>{code}</span>)}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="twofa-token">验证码</Label>
              <Input
                id="twofa-token"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder="6 位数字"
              />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>取消</Button>
          <Button size="sm" onClick={() => void submit()} disabled={!setup || enable.isPending || token.trim().length === 0}>
            {enable.isPending && <Loader2 className="animate-spin" />}
            验证并启用
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DisableTwoFactorDialog({ open, onOpenChange, onError }: { open: boolean; onOpenChange: (open: boolean) => void; onError: (message: string) => void }) {
  const disable = useDisableTwoFactor();
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    try {
      await disable.mutateAsync({ token: token.trim() });
      onOpenChange(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : '停用失败';
      setError(message);
      onError(message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>停用两步验证</DialogTitle>
          <DialogDescription>请输入当前验证器中的 6 位验证码以确认操作。</DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="mb-3 text-sm text-destructive">{error}</p>}
        <div className="space-y-1.5">
          <Label htmlFor="disable-2fa">验证码</Label>
          <Input
            id="disable-2fa"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="6 位数字"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>取消</Button>
          <Button variant="destructive" size="sm" onClick={() => void submit()} disabled={disable.isPending || token.trim().length === 0}>
            {disable.isPending && <Loader2 className="animate-spin" />}
            确认停用
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PasskeyRow({ passkey, onError }: {
  passkey: { id: string; name?: string; deviceType?: string; created_at?: string };
  onError: (message: string) => void;
}) {
  const remove = useDeletePasskey();
  const [pending, setPending] = useState(false);

  const handleRemove = async () => {
    try {
      await remove.mutateAsync(passkey.id);
      setPending(false);
    } catch (err) {
      onError(err instanceof Error ? err.message : '删除失败');
      setPending(false);
    }
  };

  return (
    <li className="flex items-center gap-3 py-2.5 text-sm">
      <Fingerprint className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="truncate">{passkey.name || passkey.deviceType || '通行密钥'}</p>
        <p className="truncate text-xs text-muted-foreground">
          {passkey.created_at ? formatDate(passkey.created_at) : '—'}
        </p>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="text-destructive hover:bg-destructive/10"
        aria-label="删除通行密钥"
        onClick={() => setPending(true)}
      >
        <Trash2 className="h-4 w-4" />
      </Button>
      <ConfirmDialog
        open={pending}
        title="删除通行密钥"
        description="删除后该设备将无法再用通行密钥登录。"
        confirmLabel="删除"
        pending={remove.isPending}
        onConfirm={() => void handleRemove()}
        onCancel={() => setPending(false)}
      />
    </li>
  );
}

function RegisterPasskeyButton({ onError }: { onError: (message: string) => void }) {
  const [pending, setPending] = useState(false);
  const queryClient = useQueryClient();

  const register = async () => {
    setPending(true);
    try {
      const optionsEnvelope = await securityApi.passkeyRegistrationOptions();
      if (optionsEnvelope.code !== 0) throw new Error(optionsEnvelope.msg || '获取注册参数失败');
      const credential = await startRegistration({ optionsJSON: optionsEnvelope.data.options as never });
      const verify = await securityApi.passkeyRegistrationVerify(credential);
      if (verify.code !== 0) throw new Error(verify.msg || '注册失败');
      await queryClient.invalidateQueries({ queryKey: ['security', 'passkeys'] });
    } catch (err) {
      onError(err instanceof Error ? err.message : '注册通行密钥失败');
    } finally {
      setPending(false);
    }
  };

  return (
    <Button size="sm" onClick={() => void register()} disabled={pending}>
      {pending ? <Loader2 className="animate-spin" /> : <Fingerprint className="h-4 w-4" />}
      注册通行密钥
    </Button>
  );
}

function PolicyCard({ policy, loading, error, onRetry }: {
  policy?: SecurityPolicy;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  const update = useUpdateSecurityPolicy();
  const [override, setOverride] = useState<SecurityPolicy | null>(null);
  // 派生优先、本地编辑覆盖（避免回填 effect 覆盖正在修改的项）
  const draft: SecurityPolicy = override ?? { ...POLICY_DEFAULTS, ...(policy ?? {}) };
  const setDraft = (next: SecurityPolicy) => setOverride(next);
  const [message, setMessage] = useState<string | null>(null);

  const save = async () => {
    setMessage(null);
    try {
      await update.mutateAsync(draft);
      setMessage('安全策略已保存');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '保存失败');
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><KeyRound className="h-4 w-4" /> 安全策略（管理员）</CardTitle>
        <CardDescription>全局生效：密码强度、会话时长、登录限制与两步验证要求。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="space-y-2">{Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-9" />)}</div>
        ) : error ? (
          <div className="space-y-2 py-4 text-center">
            <p className="text-sm text-destructive">{error instanceof Error ? error.message : '加载失败'}</p>
            <Button variant="outline" size="sm" onClick={onRetry}>重试</Button>
          </div>
        ) : (
          <>
            <div className="grid gap-phi-6 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="policy-min-length">密码最小长度</Label>
                <Input
                  id="policy-min-length"
                  inputMode="numeric"
                  value={String(draft.minPasswordLength)}
                  onChange={(event) => setDraft({ ...draft, minPasswordLength: Number(event.target.value) || 0 })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="policy-min-strength">密码最小强度（0-4）</Label>
                <Input
                  id="policy-min-strength"
                  inputMode="numeric"
                  value={String(draft.minPasswordStrength)}
                  onChange={(event) => setDraft({ ...draft, minPasswordStrength: Number(event.target.value) || 0 })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="policy-session">会话超时（小时）</Label>
                <Input
                  id="policy-session"
                  inputMode="numeric"
                  value={String(draft.sessionTimeoutHours)}
                  onChange={(event) => setDraft({ ...draft, sessionTimeoutHours: Number(event.target.value) || 0 })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="policy-attempts">最大登录失败次数</Label>
                <Input
                  id="policy-attempts"
                  inputMode="numeric"
                  value={String(draft.maxLoginAttempts)}
                  onChange={(event) => setDraft({ ...draft, maxLoginAttempts: Number(event.target.value) || 0 })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="policy-lockout">锁定时长（分钟）</Label>
                <Input
                  id="policy-lockout"
                  inputMode="numeric"
                  value={String(draft.lockoutDurationMinutes)}
                  onChange={(event) => setDraft({ ...draft, lockoutDurationMinutes: Number(event.target.value) || 0 })}
                />
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
              <div>
                <p className="text-sm font-medium">全局强制两步验证</p>
                <p className="text-xs text-muted-foreground">开启后所有用户登录都必须完成两步验证</p>
              </div>
              <Switch
                checked={draft.require2FAGlobal}
                onCheckedChange={(checked) => setDraft({ ...draft, require2FAGlobal: checked })}
                aria-label="全局强制两步验证"
              />
            </div>

            <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
              <div>
                <p className="text-sm font-medium">允许记住设备</p>
                <p className="text-xs text-muted-foreground">关闭后每次登录都需要完整验证</p>
              </div>
              <Switch
                checked={draft.allowRememberDevice}
                onCheckedChange={(checked) => setDraft({ ...draft, allowRememberDevice: checked })}
                aria-label="允许记住设备"
              />
            </div>
          </>
        )}

        {message && <p className="text-xs text-muted-foreground">{message}</p>}

        <div className="flex justify-end">
          <Button size="sm" onClick={() => void save()} disabled={update.isPending || loading}>
            {update.isPending && <Loader2 className="animate-spin" />}
            保存策略
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
