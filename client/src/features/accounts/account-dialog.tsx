import { useMemo, useState } from 'react';
import { configFieldLabel, providerLabel } from './provider-labels';
import { alertVariants } from '../../ui/alert';
import { Info, Loader2 } from 'lucide-react';
import {
  Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../../ui';
import type { AccountRow, AccountPayload, ProviderInfo } from './api';
import { useSaveAccount } from './use-accounts';

const MASK = '***';

export interface AccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providers: ProviderInfo[];
  account?: AccountRow | null;
}

export function AccountDialog({ open, onOpenChange, providers, account }: AccountDialogProps) {
  const isEdit = Boolean(account);
  const save = useSaveAccount();

  const selectableProviders = useMemo(() => providers.filter((provider) => !provider.isStub), [providers]);
  // 初值在挂载时算一次：父级按「新建 / 编辑某条」给 key，切换时重挂载即可，无需 effect 回填
  const initial = useMemo(() => {
    if (account) {
      return { type: account.type, name: account.name, remark: account.remark ?? '', config: { ...(account.config ?? {}) } };
    }
    const preferred = selectableProviders.find((item) => item.capabilities.dns) ?? selectableProviders[0];
    return {
      type: preferred?.type ?? '',
      name: '',
      remark: '',
      config: Object.fromEntries((preferred?.configFields ?? []).map((field) => [field.key, ''])),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只取挂载时的快照
  }, []);

  const [type, setType] = useState(initial.type);
  const [name, setName] = useState(initial.name);
  const [remark, setRemark] = useState(initial.remark);
  const [config, setConfig] = useState<Record<string, string>>(initial.config);
  const [error, setError] = useState<string | null>(null);

  const provider = useMemo(() => selectableProviders.find((item) => item.type === type), [selectableProviders, type]);
  const fields = provider?.configFields ?? [];

  const handleTypeChange = (nextType: string) => {
    setType(nextType);
    const nextProvider = selectableProviders.find((item) => item.type === nextType);
    setConfig(Object.fromEntries((nextProvider?.configFields ?? []).map((field) => [field.key, ''])));
    setError(null);
  };

  const submit = async () => {
    setError(null);
    if (!type) {
      setError('请选择提供商');
      return;
    }
    if (!name.trim()) {
      setError('请输入账户名称');
      return;
    }
    for (const field of fields) {
      if (field.required && !(config[field.key] ?? '').trim()) {
        setError(`请填写${configFieldLabel(field.label)}`);
        return;
      }
    }
    const payload: AccountPayload = {
      name: name.trim(),
      remark: remark.trim(),
      config,
      ...(isEdit ? {} : { type }),
    };
    try {
      await save.mutateAsync({ id: account?.id, payload });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(94vw,36rem)]">
        <DialogHeader>
          <DialogTitle>{isEdit ? '编辑账户' : '新增 DNS 账户'}</DialogTitle>
          <DialogDescription>
            凭据保存在服务端；列表接口返回的「***」表示未修改，原样提交即可保留原凭据。
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div role="alert" className={alertVariants('error', 'mb-3')}>
            {error}
          </div>
        )}

        <div className="grid gap-phi-6 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="account-provider">提供商</Label>
            <Select value={type} onValueChange={handleTypeChange} disabled={isEdit}>
              <SelectTrigger id="account-provider"><SelectValue placeholder="选择提供商" /></SelectTrigger>
              <SelectContent>
                {selectableProviders.map((item) => (
                  <SelectItem key={item.type} value={item.type}>{providerLabel(item.type || item.name)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="account-name">账户名称</Label>
            <Input id="account-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：主账号" />
          </div>

          {fields.map((field) => (
            <div key={field.key} className={field.type === 'select' ? 'space-y-1.5' : 'space-y-1.5 sm:col-span-2'}>
              <Label htmlFor={`config-${field.key}`}>
                {configFieldLabel(field.label)}
                {field.required && <span className="ml-0.5 text-destructive">*</span>}
              </Label>
              {field.type === 'select' ? (
                <Select
                  value={config[field.key] ?? ''}
                  onValueChange={(value) => setConfig((prev) => ({ ...prev, [field.key]: value }))}
                >
                  <SelectTrigger id={`config-${field.key}`}><SelectValue placeholder="选择" /></SelectTrigger>
                  <SelectContent>
                    {(field.options ?? []).map((option) => (
                      <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  id={`config-${field.key}`}
                  type={field.type === 'password' ? 'password' : 'text'}
                  value={config[field.key] ?? ''}
                  onChange={(event) => setConfig((prev) => ({ ...prev, [field.key]: event.target.value }))}
                  placeholder={config[field.key] === MASK ? '保持原值' : undefined}
                />
              )}
            </div>
          ))}

          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="account-remark">备注</Label>
            <Input id="account-remark" value={remark} onChange={(event) => setRemark(event.target.value)} placeholder="可选" />
          </div>
        </div>

        {isEdit && (
          <p className="mt-3 flex items-start gap-1.5 rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            保存时会先校验凭据：留「***」的字段沿用原值，不会把占位符写库。
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>取消</Button>
          <Button size="sm" onClick={() => void submit()} disabled={save.isPending}>
            {save.isPending && <Loader2 className="animate-spin" />}
            {isEdit ? '保存' : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
