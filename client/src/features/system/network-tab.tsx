import { useState } from 'react';
import { alertVariants } from '../../ui/alert';
import { AlertTriangle, Globe, Loader2, Network, RefreshCw } from 'lucide-react';
import {
  Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Select, SelectContent,
  SelectItem, SelectTrigger, SelectValue, Skeleton, Switch,
} from '../../ui';
import { useConnectivity, useProxyConfig, useSaveProxy } from './use-network-tab';
import type { ConnectivityResult, ProxyConfig } from './network-api';

const PROXY_DEFAULTS: ProxyConfig = { enabled: false, type: 'socks5', host: '', port: 1080, username: '', password: '' };

export function SystemNetworkTab() {
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

      <ConnectivityCard onError={report} />
      <ProxyCard onError={report} onSaved={done} />
    </div>
  );
}

function ConnectivityCard({ onError }: { onError: (e: unknown, f: string) => void }) {
  const test = useConnectivity();
  const [results, setResults] = useState<ConnectivityResult[] | null>(null);
  const [proxyEnabled, setProxyEnabled] = useState<boolean | null>(null);

  const run = async () => {
    try {
      const data = await test.mutateAsync();
      setResults(data.results ?? []);
      setProxyEnabled(Boolean(data.proxyEnabled));
    } catch (err) {
      onError(err, '连通性测试失败');
    }
  };

  const variant = (status: ConnectivityResult['status']) =>
    status === 'ok' ? 'success' : status === 'timeout' ? 'warning' : 'destructive';

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2">
        <div>
          <CardTitle className="flex items-center gap-2"><Globe className="h-4 w-4" /> 网络连通性</CardTitle>
          <CardDescription>测试与公共 DNS / 各大云服务的可达性；代理生效时结果会标注。</CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={() => void run()} disabled={test.isPending}>
          {test.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw className="h-4 w-4" />}开始测试
        </Button>
      </CardHeader>
      <CardContent>
        {!results ? (
          <p className="py-6 text-center text-sm text-muted-foreground">尚未测试</p>
        ) : results.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">没有测试项</p>
        ) : (
          <>
            {proxyEnabled !== null && (
              <p className="mb-2 text-xs text-muted-foreground">本次测试{proxyEnabled ? '经代理' : '直连'}执行</p>
            )}
            <ul className="divide-y divide-border">
              {results.map((result) => (
                <li key={result.url} className="flex items-center gap-3 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">{result.name || result.url}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{result.latency ? result.latency + ' ms' : '—'}</span>
                  <Badge variant={variant(result.status)}>
                    {result.status === 'ok' ? '可达' : result.status === 'timeout' ? '超时' : '失败'}
                  </Badge>
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ProxyCard({ onError, onSaved }: { onError: (e: unknown, f: string) => void; onSaved: (m: string) => void }) {
  const proxy = useProxyConfig();
  const save = useSaveProxy();
  const [override, setOverride] = useState<ProxyConfig | null>(null);
  // 派生优先、本地编辑覆盖（避免 effect 回填引起的级联渲染）
  const draft: ProxyConfig = override ?? { ...PROXY_DEFAULTS, ...(proxy.data ?? {}) };
  const setDraft = (next: ProxyConfig) => setOverride(next);

  const submit = async () => {
    try {
      await save.mutateAsync(draft);
      onSaved('代理配置已保存');
    } catch (err) { onError(err, '保存失败'); }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Network className="h-4 w-4" /> 代理</CardTitle>
        <CardDescription>所有提供商请求经此代理发出；保存后立即对新请求生效。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {proxy.isLoading ? <Skeleton className="h-20" /> : (
          <>
            <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
              <div>
                <p className="text-sm font-medium">启用代理</p>
                <p className="text-xs text-muted-foreground">关闭后直连；失败时仍会按内置策略回退</p>
              </div>
              <Switch checked={Boolean(draft.enabled)} onCheckedChange={(checked) => setDraft({ ...draft, enabled: checked })} aria-label="启用代理" />
            </div>
            <div className="grid gap-phi-6 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="proxy-type">类型</Label>
                <Select value={draft.type} onValueChange={(value) => setDraft({ ...draft, type: value as ProxyConfig['type'] })}>
                  <SelectTrigger id="proxy-type"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="socks5">SOCKS5</SelectItem>
                    <SelectItem value="http">HTTP</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="proxy-port">端口</Label>
                <Input id="proxy-port" inputMode="numeric" value={String(draft.port ?? '')} onChange={(event) => setDraft({ ...draft, port: Number(event.target.value) || 0 })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="proxy-host">主机</Label>
                <Input id="proxy-host" value={draft.host ?? ''} onChange={(event) => setDraft({ ...draft, host: event.target.value })} placeholder="127.0.0.1" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="proxy-user">用户名（可选）</Label>
                <Input id="proxy-user" value={draft.username ?? ''} onChange={(event) => setDraft({ ...draft, username: event.target.value })} />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="proxy-pass">密码（可选）</Label>
                <Input id="proxy-pass" type="password" value={draft.password ?? ''} onChange={(event) => setDraft({ ...draft, password: event.target.value })} placeholder="留空表示不修改" />
              </div>
            </div>
            <div className="flex justify-end">
              <Button size="sm" onClick={() => void submit()} disabled={save.isPending}>
                {save.isPending && <Loader2 className="animate-spin" />}保存代理
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
