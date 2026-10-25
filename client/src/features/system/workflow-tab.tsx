import { useState } from 'react';
import { alertVariants } from '../../ui/alert';
import { AlertTriangle, Loader2, Plus, Workflow, X } from 'lucide-react';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Skeleton } from '../../ui';
import { useAllowlist, useSaveAllowlist } from './use-network-tab';

/** 工作流出站白名单：条目必须是纯主机名，空列表 = 禁止一切出站 */
export function SystemWorkflowTab() {
  const allowlist = useAllowlist();
  const save = useSaveAllowlist();
  const [override, setOverride] = useState<string[] | null>(null);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 派生优先：服务端数据变化自然生效，用户编辑后以本地为准
  const draft = override ?? allowlist.data ?? [];
  const setDraft = (next: string[]) => setOverride(next);

  const add = () => {
    const value = input.trim().toLowerCase();
    if (!value) return;
    if (value.includes('/') || value.includes(':')) {
      setError('只能填写主机名，不要带 scheme、端口或路径');
      return;
    }
    if (draft.includes(value)) {
      setError('该主机名已在白名单中');
      return;
    }
    setDraft([...draft, value]);
    setInput('');
    setError(null);
  };

  const submit = async () => {
    setError(null);
    setNotice(null);
    try {
      await save.mutateAsync(draft);
      setNotice('白名单已保存并立即生效');
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Workflow className="h-4 w-4" /> 工作流出站白名单</CardTitle>
        <CardDescription>
          仅允许列表内的主机名发起 `http.outbound.fetch`；<strong>列表为空 = 禁止一切出站</strong>。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
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

        {allowlist.isLoading ? <Skeleton className="h-20" /> : (
          <>
            <div className="flex flex-wrap gap-1.5">
              {draft.length === 0 ? (
                <p className="text-sm text-muted-foreground">当前为空：工作流的出站请求会被全部拒绝</p>
              ) : draft.map((host) => (
                <Badge key={host} variant="secondary" className="gap-1">
                  {host}
                  <button
                    type="button"
                    className="ml-1 rounded-sm text-muted-foreground hover:text-destructive"
                    aria-label={'移除 ' + host}
                    onClick={() => setDraft(draft.filter((item) => item !== host))}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
            </div>

            <div className="flex gap-2">
              <Input
                placeholder="api.example.com"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add(); } }}
                aria-label="新增主机名"
              />
              <Button variant="outline" size="sm" onClick={add}>
                <Plus className="h-4 w-4" />添加
              </Button>
            </div>

            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">共 {draft.length} 个主机名</p>
              <Button size="sm" onClick={() => void submit()} disabled={save.isPending}>
                {save.isPending && <Loader2 className="animate-spin" />}保存白名单
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
