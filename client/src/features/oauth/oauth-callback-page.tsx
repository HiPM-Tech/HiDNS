import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui';
import { http } from '../../lib/http';

type Phase = 'exchanging' | 'success' | 'error';

const DONE_KEY_PREFIX = 'oauth_callback_done:';

/**
 * OAuth 登录 / 绑定的统一回调页。
 *
 * 两个关键点：
 * 1. code 只能兑换一次，重复兑换会被服务端拒绝——用 sessionStorage 记住本次 code+state 已处理，
 *    避免 StrictMode 双调用或用户刷新导致「第二次必然失败」的假错误。
 * 2. 绑定与登录的落点不同（绑定回设置页，登录进控制台），按服务端返回的 mode 决定。
 */
export function OAuthCallbackPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>('exchanging');
  const [message, setMessage] = useState('正在完成授权，请稍候…');
  const [mode, setMode] = useState<'login' | 'bind'>('login');
  const handledRef = useRef(false);

  useEffect(() => {
    if (handledRef.current) return;
    handledRef.current = true;

    const code = params.get('code');
    const state = params.get('state');
    const errorParam = params.get('error');

    if (errorParam) {
      setPhase('error');
      setMessage(params.get('error_description') || errorParam);
      return;
    }
    if (!code || !state) {
      setPhase('error');
      setMessage('回调缺少 code 或 state，无法完成授权。');
      return;
    }

    const doneKey = DONE_KEY_PREFIX + code + ':' + state;
    const previous = sessionStorage.getItem(doneKey);
    if (previous) {
      setPhase('success');
      setMode(previous === 'bind' ? 'bind' : 'login');
      setMessage('该授权已完成，无需重复提交。');
      return;
    }

    void (async () => {
      try {
        const envelope = await http.post<{ mode?: 'login' | 'bind' }>('/auth/oauth/callback', { code, state });
        if (envelope.code !== 0) throw new Error(envelope.msg || '授权失败');
        const resolved = envelope.data?.mode === 'bind' ? 'bind' : 'login';
        sessionStorage.setItem(doneKey, resolved);
        setMode(resolved);
        setPhase('success');
        setMessage(resolved === 'bind' ? '外部账号绑定成功' : '登录成功，正在进入控制台…');
        setTimeout(() => navigate(resolved === 'bind' ? '/dash/settings' : '/dash', { replace: true }), 800);
      } catch (err) {
        setPhase('error');
        setMessage(err instanceof Error ? err.message : '授权失败');
      }
    })();
  }, [params, navigate]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {phase === 'exchanging' && <Loader2 className="h-4 w-4 animate-spin" />}
            {phase === 'success' && <CheckCircle2 className="h-4 w-4 text-success-600 dark:text-success-400" />}
            {phase === 'error' && <AlertTriangle className="h-4 w-4 text-destructive" />}
            {phase === 'error' ? '授权未完成' : mode === 'bind' ? '绑定外部账号' : '单点登录'}
          </CardTitle>
          <CardDescription>本页面由 HiDNS 授权流程打开，请勿在完成后继续停留。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className={phase === 'error' ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}>{message}</p>
          <div className="flex flex-wrap gap-2">
            {phase === 'error' && (
              <>
                <Button size="sm" asChild><Link to="/login">返回登录</Link></Button>
                <Button variant="outline" size="sm" asChild><Link to="/">返回首页</Link></Button>
              </>
            )}
            {phase === 'success' && (
              <Button size="sm" asChild>
                <Link to={mode === 'bind' ? '/dash/settings' : '/dash'}>立即前往</Link>
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
