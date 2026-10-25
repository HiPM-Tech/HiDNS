import { useState } from 'react';
import { alertVariants } from '../../ui/alert';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Loader2, Plus } from 'lucide-react';
import {
  Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Label, Select,
  SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton,
} from '../../ui';
import { addDomains, listProviderDomains } from './api';
import { useDomainAccounts } from './use-domains';
import { useProviders } from '../accounts/use-accounts';
import { filterAccountsByProviderCapability } from '../accounts/provider-capabilities';
import { providerLabel } from '../accounts/provider-labels';

const EMPTY_ACCOUNTS: never[] = [];

export interface AddDomainDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: () => void;
}

/** 从提供商拉取域名列表并批量托管（旧 AddDomainForm 的替代入口） */
export function AddDomainDialog({ open, onOpenChange, onAdded }: AddDomainDialogProps) {
  const accounts = useDomainAccounts();
  const providers = useProviders();
  const [accountId, setAccountId] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  const providerDomains = useQuery({
    queryKey: ['provider-domains-for-add', accountId],
    queryFn: () => listProviderDomains(Number(accountId)),
    enabled: open && accountId !== '',
    staleTime: 60_000,
  });

  const mutation = useMutation({
    mutationFn: () => addDomains(Number(accountId), (providerDomains.data ?? [])
      .filter((item) => selected.includes(item.name))
      .map((item) => ({ name: item.name, third_id: item.third_id, expires_at: item.expires_at }))),
    onSuccess: (result) => {
      const added = result.added ?? selected.length;
      const skipped = result.skipped ?? 0;
      setSummary(`已添加 ${added} 个` + (skipped > 0 ? `，跳过 ${skipped} 个（已存在或无权）` : ''));
      onAdded();
    },
    onError: (err) => setError(err instanceof Error ? err.message : '添加失败'),
  });

  const options = providerDomains.data ?? [];
  const allAccounts = (accounts.data ?? EMPTY_ACCOUNTS) as Array<{ id: number; name: string; type: string }>;
  // 只展示「支持 DNS 解析」的提供商账户（edgeone 等纯 CDN 账户不能拉域名）
  const accountOptions = filterAccountsByProviderCapability(allAccounts, providers.data, 'dns');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(94vw,36rem)]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Plus className="h-4 w-4" />新增域名</DialogTitle>
          <DialogDescription>从 DNS 提供商拉取域名并托管到 HiDNS；已在列表中的域名会被跳过。</DialogDescription>
        </DialogHeader>

        {error && (
          <div role="alert" className={alertVariants('error', 'mb-3')}>{error}</div>
        )}
        {summary && (
          <div role="status" className={alertVariants('success', 'mb-3')}>{summary}</div>
        )}

        {accounts.isSuccess && accountOptions.length === 0 ? (
          // 没有任何 DNS 账户时，域名无从「从提供商拉取」：这里必须直接给出下一步，
          // 否则新用户只看到一个禁用的「添加」按钮和「请选择账户」，不知道要先去建账户。
          <div className="space-y-3 rounded-md border border-border bg-muted/40 p-4">
            <p className="text-sm font-medium">还没有 DNS 账户</p>
            <p className="text-xs text-muted-foreground">
              HiDNS 的域名需要从 DNS 提供商账号同步过来。请先添加一个账户（阿里云、Cloudflare、DNSPod 等），
              再回来把域名托管到这里。
            </p>
            <Button asChild size="sm">
              <Link to="/dash/accounts" onClick={() => onOpenChange(false)}>去创建 DNS 账户</Link>
            </Button>
          </div>
        ) : (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="add-domain-account">DNS 账户</Label>
            <Select value={accountId} onValueChange={(value) => { setAccountId(value); setSelected([]); setError(null); }}>
              <SelectTrigger id="add-domain-account"><SelectValue placeholder="选择账户" /></SelectTrigger>
              <SelectContent>
                {accountOptions.map((account) => (
                  <SelectItem key={account.id} value={String(account.id)}>
                    {account.name} · {providerLabel(account.type)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="max-h-56 overflow-y-auto rounded-md border border-border p-2">
            {!accountId ? (
              <p className="py-6 text-center text-xs text-muted-foreground">请先选择账户</p>
            ) : providerDomains.isLoading ? (
              <Skeleton className="h-20" />
            ) : providerDomains.isError ? (
              <p className="py-6 text-center text-xs text-destructive">{providerDomains.error instanceof Error ? providerDomains.error.message : '拉取失败'}</p>
            ) : options.length === 0 ? (
              <p className="py-6 text-center text-xs text-muted-foreground">该账户下没有可添加的域名</p>
            ) : options.map((domain) => (
              <label key={domain.name} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-accent">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
                  checked={selected.includes(domain.name)}
                  onChange={() => setSelected((prev) => prev.includes(domain.name) ? prev.filter((name) => name !== domain.name) : [...prev, domain.name])}
                />
                <span className="min-w-0 flex-1 truncate">{domain.name}</span>
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">已选 {selected.length} 个</p>
        </div>
        )}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>关闭</Button>
          <Button size="sm" onClick={() => mutation.mutate()} disabled={mutation.isPending || selected.length === 0 || accountOptions.length === 0}>
            {mutation.isPending && <Loader2 className="animate-spin" />}
            {selected.length > 0 ? `添加 ${selected.length} 个域名` : '添加域名'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
