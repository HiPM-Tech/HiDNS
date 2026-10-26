import { useMemo, useState } from 'react';
import { alertVariants } from '../../ui/alert';
import { Loader2 } from 'lucide-react';
import {
  Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../../ui';
import { useCreateToken, useTokenDomains, useUpdateToken } from './use-tokens';
import type { CreatedToken, TokenDomainOption, TokenRow } from './api';
import type { AllowedServices } from './permissions';
import { TokenServicePicker } from './token-service-picker';

const EMPTY_DOMAINS: TokenDomainOption[] = [];

const ROLE_OPTIONS = [
  { value: '0', label: '普通用户（只读）' },
  { value: '1', label: '普通用户' },
  { value: '2', label: '管理员' },
  { value: '3', label: '超级管理员' },
];

export interface TokenDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 当前用户角色等级，令牌角色不得超过它 */
  currentRoleLevel: number;
  /** 传入则为编辑模式（名称/域名/服务/有效期；角色上限不可改） */
  token?: TokenRow | null;
  onCreated?: (created: CreatedToken) => void;
  onSaved?: () => void;
}

export function TokenDialog({ open, onOpenChange, currentRoleLevel, token, onCreated, onSaved }: TokenDialogProps) {
  const domains = useTokenDomains();
  const create = useCreateToken();
  const update = useUpdateToken();
  const editing = Boolean(token);

  const [name, setName] = useState(token?.name ?? '');
  const [keyword, setKeyword] = useState('');
  const [selected, setSelected] = useState<number[]>(token?.allowed_domains ?? []);
  const [services, setServices] = useState<AllowedServices>(token?.allowed_services ?? { dns: ['*'] });
  const [maxRole, setMaxRole] = useState(String(token?.max_role ?? Math.min(currentRoleLevel, 2)));
  const [startTime, setStartTime] = useState(token?.start_time ?? '');
  const [endTime, setEndTime] = useState(token?.end_time ?? '');
  const [error, setError] = useState<string | null>(null);


  const domainOptions = domains.data ?? EMPTY_DOMAINS;
  const filtered = useMemo(() => {
    const term = keyword.trim().toLowerCase();
    if (!term) return domainOptions;
    return domainOptions.filter((domain) =>
      domain.name.toLowerCase().includes(term) || (domain.account_name ?? '').toLowerCase().includes(term));
  }, [domainOptions, keyword]);

  const toggleDomain = (id: number) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  };

  const submit = async () => {
    setError(null);
    if (!name.trim()) {
      setError('请输入令牌名称');
      return;
    }
    if (selected.length === 0) {
      setError('至少选择一个域名');
      return;
    }
    const allowedServices: AllowedServices = {};
    if (services.dns?.length) allowedServices.dns = services.dns;
    if (services.mcp?.length) allowedServices.mcp = services.mcp;
    if (editing && token) {
      try {
        await update.mutateAsync({
          id: token.id,
          payload: {
            name: name.trim(),
            allowed_domains: selected,
            allowed_services: allowedServices,
            start_time: startTime || null,
            end_time: endTime || null,
          },
        });
        onSaved?.();
        onOpenChange(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : '保存失败');
      }
      return;
    }
    try {
      const envelope = await create.mutateAsync({
        name: name.trim(),
        allowed_domains: selected,
        allowed_services: allowedServices,
        max_role: Number(maxRole),
        start_time: startTime ? new Date(startTime).toISOString() : undefined,
        end_time: endTime ? new Date(endTime).toISOString() : undefined,
      });
      if (!envelope.data?.token) {
        setError('创建成功但未返回令牌，请刷新列表后重试');
        return;
      }
      onCreated?.(envelope.data);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] w-[min(94vw,40rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? '编辑 API 令牌' : '新增 API 令牌'}</DialogTitle>
          <DialogDescription>
            {editing
              ? '修改名称、域名范围、服务与有效期；角色上限创建后不可修改。'
              : '令牌只在创建后显示一次；服务权限与角色上限都不会超过你自身的权限。'}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div role="alert" className={alertVariants('error', 'mb-3')}>
            {error}
          </div>
        )}

        <div className="grid gap-phi-6 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="token-name">名称</Label>
            <Input id="token-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：DDNS-家庭宽带" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="token-role">角色上限</Label>
            <Select value={maxRole} onValueChange={setMaxRole} disabled={editing}>
              <SelectTrigger id="token-role"><SelectValue /></SelectTrigger>
              <SelectContent>
                {ROLE_OPTIONS.filter((option) => Number(option.value) <= currentRoleLevel).map((option) => (
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5 sm:col-span-2">
            <Label>服务权限</Label>
            <TokenServicePicker value={services} onChange={setServices} />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="token-start">生效时间（可选）</Label>
            <Input id="token-start" type="datetime-local" value={startTime} onChange={(event) => setStartTime(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="token-end">失效时间（可选）</Label>
            <Input id="token-end" type="datetime-local" value={endTime} onChange={(event) => setEndTime(event.target.value)} />
          </div>

          <div className="space-y-1.5 sm:col-span-2">
            <div className="flex items-center justify-between">
              <Label>可访问域名（{selected.length} / {domainOptions.length}）</Label>
              <div className="flex items-center gap-2 text-xs">
                <button type="button" className="text-primary hover:underline" onClick={() => setSelected(filtered.map((item) => item.id))}>
                  全选当前
                </button>
                <button type="button" className="text-muted-foreground hover:underline" onClick={() => setSelected([])}>
                  清空
                </button>
              </div>
            </div>
            <Input placeholder="搜索域名或账户" value={keyword} onChange={(event) => setKeyword(event.target.value)} aria-label="搜索域名" />
            <div className="max-h-40 overflow-y-auto rounded-md border border-border p-2">
              {filtered.length === 0 ? (
                <p className="py-4 text-center text-xs text-muted-foreground">没有可授权的域名</p>
              ) : filtered.map((domain) => (
                <label key={domain.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-accent">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
                    checked={selected.includes(domain.id)}
                    onChange={() => toggleDomain(domain.id)}
                  />
                  <span className="min-w-0 flex-1 truncate">{domain.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{domain.account_name ?? ''}</span>
                </label>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>取消</Button>
          <Button size="sm" onClick={() => void submit()} disabled={create.isPending || update.isPending}>
            {(create.isPending || update.isPending) && <Loader2 className="animate-spin" />}
            {editing ? '保存' : '创建令牌'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
