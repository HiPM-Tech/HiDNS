import { useState } from 'react';
import { alertVariants } from '../../ui/alert';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AlertTriangle, Loader2, Lock, ShieldCheck } from 'lucide-react';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui';
import { useSession } from '../session/use-session';
import { parseScope, SCOPE_MODULES } from './consent-api';
import { requestRaw } from '../../lib/http';

/**
 * MCP OAuth 授权同意页（公开路由，未登录先引导登录）。
 *
 * 关键：这里展示的是**客户端申请的真实 scope**，逐模块列出读写级别，
 * 用户看到的就是本次授权后该客户端能做什么；拒绝同样回调给客户端（decision=deny）。
 */
export function McpConsentPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { user, isLoading } = useSession();
  const [pending, setPending] = useState<null | 'approve' | 'deny'>(null);
  const [error, setError] = useState<string | null>(null);

  const clientId = params.get('client_id') ?? '';
  const redirectUri = params.get('redirect_uri') ?? '';
  const scope = params.get('scope') ?? '';
  const state = params.get('state') ?? '';
  const type = params.get('type') ?? 'mcp';
  const appName = params.get('app_name') || clientId || '未命名客户端';

  const perms = parseScope(scope);
  const granted = SCOPE_MODULES
    .map((module) => ({ ...module, level: perms[module.key] }))
    .filter((item) => item.level && item.level !== 'disabled');

  const decide = async (decision: 'approve' | 'deny') => {
    setError(null);
    setPending(decision);
    try {
      // 该端点按 OAuth 协议返回裸 JSON（成功 { redirect_url }，失败 { error, error_description }），
      // 不套 { code, data, msg } 信封，因此走 requestRaw 而不是 http.post
      const result = await requestRaw<{ redirect_url?: string; error?: string; error_description?: string }>(
        '/mcp/oauth/authorize',
        { client_id: clientId, redirect_uri: redirectUri, scope, state, decision },
      );
      if (!result.ok) {
        throw new Error(result.data?.error_description || result.data?.error || ('授权失败（HTTP ' + result.status + '）'));
      }
      const target = result.data?.redirect_url;
      if (!target) throw new Error('服务端未返回跳转地址');
      window.location.href = target;
    } catch (err) {
      setError(err instanceof Error ? err.message : '授权失败');
      setPending(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/30">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!user) {
    const returnTo = '/oauth/authorize?' + params.toString();
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
        <Card className="w-full max-w-md text-center">
          <CardContent className="space-y-3 p-6">
            <Lock className="mx-auto h-10 w-10 text-warning-600 dark:text-warning-400" />
            <h1 className="text-base font-semibold">需要登录后才能授权</h1>
            <p className="text-sm text-muted-foreground">授权会以你的身份访问数据，请先登录 HiDNS。</p>
            <Button onClick={() => navigate('/login?return_to=' + encodeURIComponent(returnTo))}>去登录</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><ShieldCheck className="h-4 w-4" /> 授权请求</CardTitle>
          <CardDescription>
            <span className="font-medium text-foreground">{appName}</span> 请求以你的身份访问 HiDNS（{type.toUpperCase()}）。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {error && (
            <div role="alert" className={alertVariants('error', 'flex items-center gap-2')}>
              <AlertTriangle className="h-4 w-4" /> {error}
            </div>
          )}

          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">申请的权限</p>
            {granted.length === 0 ? (
              <p className="text-sm text-muted-foreground">该客户端未申请任何模块权限</p>
            ) : (
              <ul className="space-y-1.5">
                {granted.map((item) => (
                  <li key={item.key} className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm">
                    <span>{item.label}</span>
                    <Badge variant={item.level === 'write' ? 'warning' : 'secondary'}>
                      {item.level === 'write' ? '读写' : '只读'}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <dl className="space-y-1 rounded-md bg-muted/40 p-2 text-xs text-muted-foreground">
            <div className="flex gap-2"><dt className="w-20 shrink-0">客户端</dt><dd className="truncate font-mono">{clientId || '—'}</dd></div>
            <div className="flex gap-2"><dt className="w-20 shrink-0">回调地址</dt><dd className="truncate font-mono">{redirectUri || '—'}</dd></div>
          </dl>

          <p className="text-xs text-muted-foreground">授权后可在「MCP」页面随时修改或删除该客户端的权限。</p>

          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" size="sm" disabled={pending !== null} onClick={() => void decide('deny')}>
              {pending === 'deny' && <Loader2 className="animate-spin" />}拒绝
            </Button>
            <Button size="sm" disabled={pending !== null} onClick={() => void decide('approve')}>
              {pending === 'approve' && <Loader2 className="animate-spin" />}同意授权
            </Button>
          </div>
          <p className="text-center text-xs text-muted-foreground">
            <Link to="/" className="hover:underline">返回首页</Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
