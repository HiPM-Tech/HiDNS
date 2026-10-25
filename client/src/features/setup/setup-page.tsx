import { useEffect, useState } from 'react';
import { alertVariants } from '../../ui/alert';
import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Database, Loader2, Server, ShieldCheck, UserCog } from 'lucide-react';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Skeleton, Switch } from '../../ui';
import { cn } from '../../ui/cn';
import { DEFAULT_DB_CONFIG, mergeDbConfig, setupApi, validateAdminForm, type DbConfig, type DbType } from './setup-api';

type Step = 'database' | 'admin' | 'complete';

const STEPS: Array<{ key: Step; title: string; hint: string; icon: typeof Database }> = [
  { key: 'database', title: '数据库', hint: '选择存储并测试连接', icon: Database },
  { key: 'admin', title: '管理员', hint: '创建第一个管理员账户', icon: UserCog },
  { key: 'complete', title: '完成', hint: '进入控制台', icon: CheckCircle2 },
];

const DB_TYPES: Array<{ value: DbType; label: string; desc: string }> = [
  { value: 'sqlite', label: 'SQLite', desc: '本地文件，零依赖，适合单机与试用' },
  { value: 'mysql', label: 'MySQL', desc: '兼容 MySQL 8 / MariaDB' },
  { value: 'postgresql', label: 'PostgreSQL', desc: '适合已有 PG 集群的部署' },
];

export function SetupPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('database');
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [db, setDb] = useState<DbConfig>(DEFAULT_DB_CONFIG);
  const [tested, setTested] = useState(false);
  const [hasExistingData, setHasExistingData] = useState(false);
  const [admin, setAdmin] = useState({ username: '', email: '', password: '', confirmPassword: '' });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [status, config] = await Promise.all([setupApi.status(), setupApi.dbConfig()]);
        if (!alive) return;
        setDb(mergeDbConfig(config));
        if (status.initialized && status.hasUsers) navigate('/login', { replace: true });
      } catch {
        // 状态接口失败不阻塞安装：用户仍可手动配置
      } finally {
        if (alive) setLoadingStatus(false);
      }
    })();
    return () => { alive = false; };
  }, [navigate]);

  const testConnection = async () => {
    setError(null); setNotice(null); setPending(true); setHasExistingData(false);
    try {
      const result = await setupApi.testDb(db);
      if (!result.success) throw new Error(result.message || '连接失败');
      setTested(true);
      setHasExistingData(Boolean(result.hasExistingData));
      setNotice('连接成功' + (result.hasExistingData ? '，检测到已有数据' : ''));
    } catch (err) {
      setTested(false);
      setError(err instanceof Error ? err.message : '连接失败');
    } finally {
      setPending(false);
    }
  };

  const initialize = async (reset = false) => {
    setError(null); setNotice(null); setPending(true);
    try {
      const result = await setupApi.initDb(db, reset);
      if (result.skipToComplete) setStep('complete');
      else setStep('admin');
      setNotice(result.message || '数据库初始化完成');
    } catch (err) {
      setError(err instanceof Error ? err.message : '初始化失败');
    } finally {
      setPending(false);
    }
  };

  const createAdmin = async () => {
    const problem = validateAdminForm(admin);
    if (problem) { setError(problem); return; }
    setError(null); setNotice(null); setPending(true);
    try {
      await setupApi.createAdmin({ username: admin.username.trim(), email: admin.email.trim(), password: admin.password });
      setStep('complete');
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建管理员失败');
    } finally {
      setPending(false);
    }
  };

  const setServer = (field: keyof DbConfig['mysql'], value: string | number | boolean) => {
    if (db.type === 'sqlite') return;
    setDb({ ...db, [db.type]: { ...db[db.type], [field]: value } });
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <div className="w-full max-w-3xl">
        <header className="mb-4 flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <ShieldCheck className="h-4 w-4" />
          </span>
          <div>
            <h1 className="text-base font-semibold tracking-tight">HiDNS 安装向导</h1>
            <p className="text-xs text-muted-foreground">三步完成初始化：数据库 → 管理员 → 开始使用</p>
          </div>
        </header>

        <nav className="mb-3 flex gap-1" aria-label="安装步骤">
          {STEPS.map((item, index) => {
            const activeIndex = STEPS.findIndex((s) => s.key === step);
            const Icon = item.icon;
            return (
              <div
                key={item.key}
                className={cn('flex flex-1 items-center gap-2 rounded-md border px-3 py-2 text-xs',
                  index === activeIndex ? 'border-primary/40 bg-primary/5 text-primary'
                    : index < activeIndex ? 'border-border bg-card text-muted-foreground' : 'border-border/60 text-muted-foreground/70')}
              >
                <Icon className="h-4 w-4" />
                <div>
                  <p className="font-medium">{item.title}</p>
                  <p className="text-[11px] text-muted-foreground">{item.hint}</p>
                </div>
              </div>
            );
          })}
        </nav>

        {error && (
          <div role="alert" className={alertVariants('error', 'mb-3 flex items-center gap-2')}>
            <AlertTriangle className="h-4 w-4" /> {error}
          </div>
        )}
        {notice && (
          <div role="status" className={alertVariants('success', 'mb-3')}>
            {notice}
          </div>
        )}

        {loadingStatus ? (
          <Card><CardContent className="space-y-2 p-6">{Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-8" />)}</CardContent></Card>
        ) : step === 'database' ? (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Database className="h-4 w-4" /> 数据库配置</CardTitle>
              <CardDescription>支持 SQLite / MySQL / PostgreSQL；连接信息会写入 data 目录的配置文件。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-2 sm:grid-cols-3">
                {DB_TYPES.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => { setDb({ ...db, type: item.value }); setTested(false); }}
                    className={cn('rounded-md border px-3 py-2 text-left text-sm transition-colors',
                      db.type === item.value ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent')}
                  >
                    <p className="font-medium">{item.label}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{item.desc}</p>
                  </button>
                ))}
              </div>

              {db.type === 'sqlite' ? (
                <div className="space-y-1.5">
                  <Label htmlFor="db-path">数据库文件路径</Label>
                  <Input id="db-path" value={db.sqlite.path} onChange={(event) => { setDb({ ...db, sqlite: { path: event.target.value } }); setTested(false); }} />
                </div>
              ) : (
                <div className="grid gap-phi-6 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="db-host">主机</Label>
                    <Input id="db-host" value={db[db.type].host} onChange={(event) => { setServer('host', event.target.value); setTested(false); }} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="db-port">端口</Label>
                    <Input id="db-port" inputMode="numeric" value={String(db[db.type].port)} onChange={(event) => { setServer('port', Number(event.target.value) || 0); setTested(false); }} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="db-name">数据库名</Label>
                    <Input id="db-name" value={db[db.type].database} onChange={(event) => { setServer('database', event.target.value); setTested(false); }} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="db-user">用户名</Label>
                    <Input id="db-user" value={db[db.type].user} onChange={(event) => { setServer('user', event.target.value); setTested(false); }} />
                  </div>
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="db-password">密码</Label>
                    <Input id="db-password" type="password" value={db[db.type].password} onChange={(event) => { setServer('password', event.target.value); setTested(false); }} />
                  </div>
                  <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 sm:col-span-2">
                    <span className="text-sm">使用 SSL 连接</span>
                    <Switch checked={Boolean(db[db.type].ssl)} onCheckedChange={(checked) => { setServer('ssl', checked); setTested(false); }} aria-label="使用 SSL 连接" />
                  </div>
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  {tested ? <Badge variant="success">连接可用</Badge> : <Badge variant="secondary">未测试</Badge>}
                  {hasExistingData && <Badge variant="warning">检测到已有数据</Badge>}
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => void testConnection()} disabled={pending}>
                    {pending && <Loader2 className="animate-spin" />}测试连接
                  </Button>
                  <Button size="sm" onClick={() => void initialize(false)} disabled={pending || !tested}>
                    下一步
                  </Button>
                </div>
              </div>

              {hasExistingData && (
                <div className="rounded-md border border-warning-200 bg-warning-50 px-3 py-2 text-xs text-warning-700 dark:border-warning-900 dark:bg-warning-900/30 dark:text-warning-300">
                  该数据库已有 HiDNS 数据。继续会沿用现有数据；如需清空重建，请使用「重置并初始化」——这会删除既有账号与域名记录。
                  <Button variant="outline" size="sm" className="ml-2" onClick={() => void initialize(true)} disabled={pending}>
                    重置并初始化
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        ) : step === 'admin' ? (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><UserCog className="h-4 w-4" /> 创建管理员</CardTitle>
              <CardDescription>该账号为初始超级管理员，拥有全部权限；密码以 bcrypt 存储。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-phi-6 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="admin-username">用户名</Label>
                  <Input id="admin-username" value={admin.username} onChange={(event) => setAdmin({ ...admin, username: event.target.value })} placeholder="3–20 位字母数字下划线" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="admin-email">邮箱</Label>
                  <Input id="admin-email" type="email" value={admin.email} onChange={(event) => setAdmin({ ...admin, email: event.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="admin-password">密码</Label>
                  <Input id="admin-password" type="password" autoComplete="new-password" value={admin.password} onChange={(event) => setAdmin({ ...admin, password: event.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="admin-confirm">确认密码</Label>
                  <Input id="admin-confirm" type="password" autoComplete="new-password" value={admin.confirmPassword} onChange={(event) => setAdmin({ ...admin, confirmPassword: event.target.value })} />
                </div>
              </div>
              <div className="flex justify-end">
                <Button size="sm" onClick={() => void createAdmin()} disabled={pending}>
                  {pending && <Loader2 className="animate-spin" />}创建并完成
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4" /> 安装完成</CardTitle>
              <CardDescription>初始化已结束，使用刚创建的管理员账号登录控制台。</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center gap-2">
              <Button asChild><Link to="/login">前往登录</Link></Button>
              <Button variant="outline" asChild><Link to="/">返回首页</Link></Button>
              <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
                <Server className="h-3.5 w-3.5" /> 数据库：{db.type}
              </span>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
