import { useMemo, useState } from 'react';
import { alertVariants } from '../../ui/alert';
import { Loader2 } from 'lucide-react';
import {
  Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../../ui';
import { cn } from '../../ui/cn';
import { useCreateToken, useTokenDomains } from './use-tokens';
import type { CreatedToken, TokenDomainOption } from './api';

const EMPTY_DOMAINS: TokenDomainOption[] = [];
const SERVICE_PRESETS = ['dns', 'mcp'];

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
  onCreated: (created: CreatedToken) => void;
}

export function TokenDialog({ open, onOpenChange, currentRoleLevel, onCreated }: TokenDialogProps) {
  const domains = useTokenDomains();
  const create = useCreateToken();

  const [name, setName] = useState('');
  const [keyword, setKeyword] = useState('');
  const [selected, setSelected] = useState<number[]>([]);
  const [services, setServices] = useState<string[]>(['dns']);
  const [customService, setCustomService] = useState('');
  const [maxRole, setMaxRole] = useState(String(Math.min(currentRoleLevel, 2)));
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
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

  const toggleService = (service: string) => {
    setServices((prev) => (prev.includes(service) ? prev.filter((item) => item !== service) : [...prev, service]));
  };

  const addCustomService = () => {
    const value = customService.trim();
    if (!value) return;
    if (!services.includes(value)) setServices((prev) => [...prev, value]);
    setCustomService('');
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
    try {
      const envelope = await create.mutateAsync({
        name: name.trim(),
        allowed_domains: selected,
        allowed_services: services.length > 0 ? services : undefined,
        max_role: Number(maxRole),
        start_time: startTime ? new Date(startTime).toISOString() : undefined,
        end_time: endTime ? new Date(endTime).toISOString() : undefined,
      });
      if (!envelope.data?.token) {
        setError('创建成功但未返回令牌，请刷新列表后重试');
        return;
      }
      onCreated(envelope.data);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(94vw,40rem)]">
        <DialogHeader>
          <DialogTitle>新增 API 令牌</DialogTitle>
          <DialogDescription>
            令牌只在创建后显示一次；服务权限与角色上限都不会超过你自身的权限。
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
            <Select value={maxRole} onValueChange={setMaxRole}>
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
            <div className="flex flex-wrap items-center gap-2">
              {SERVICE_PRESETS.map((service) => (
                <button
                  key={service}
                  type="button"
                  onClick={() => toggleService(service)}
                  className={cn(
                    'rounded-full border px-3 py-1 text-xs transition-colors',
                    services.includes(service)
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border text-muted-foreground hover:bg-accent',
                  )}
                >
                  {service}
                </button>
              ))}
              {services.filter((service) => !SERVICE_PRESETS.includes(service)).map((service) => (
                <button
                  key={service}
                  type="button"
                  onClick={() => toggleService(service)}
                  className="rounded-full border border-primary bg-primary/10 px-3 py-1 text-xs text-primary"
                  title="点击移除"
                >
                  {service} ×
                </button>
              ))}
              <div className="flex items-center gap-1">
                <Input
                  className="h-8 w-32"
                  placeholder="自定义服务"
                  value={customService}
                  onChange={(event) => setCustomService(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addCustomService(); } }}
                  aria-label="自定义服务"
                />
                <Button type="button" variant="outline" size="sm" onClick={addCustomService}>添加</Button>
              </div>
            </div>
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
          <Button size="sm" onClick={() => void submit()} disabled={create.isPending}>
            {create.isPending && <Loader2 className="animate-spin" />}
            创建令牌
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
