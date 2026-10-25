import { useMemo, useState } from 'react';
import { composeRecordValue } from './record-value';
import { alertVariants } from '../../ui/alert';
import { Loader2 } from 'lucide-react';
import {
  Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch,
} from '../../ui';
import { getRecordTypeDef, validateRecordValue, PROXIABLE_RECORD_TYPES } from '../../types/record-types';
import { useSaveRecord } from './use-records';
import type { DnsRecordRow, RecordLine } from './api';

const EXTRA_LABELS: Record<string, string> = {
  mx: '优先级',
  priority: '优先级',
  weight: '权重',
  port: '端口',
  certType: '证书类型',
  keyTag: 'KeyTag',
  algorithm: '算法',
  flags: 'Flags',
  tag: 'Tag',
};

/**
 * 记录值拼装。
 *
 * `mx` 有独立提交字段（服务端也按独立字段收），不能拼进 value：
 * 之前 MX 会被拼成 "10 mail.example.test"，随后按 hostname 校验整串直接失败，
 * 表现为「选 MX 必然报 Invalid hostname value、弹窗不关」。
 * 其余附加字段（SRV 的 priority/port 等）没有独立字段，仍需拼在 value 前。
 */

export interface RecordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  domainId: number;
  recordTypes: string[];
  lines: RecordLine[];
  /** 编辑态下线路是否可改（华为云等提供商创建后不可改） */
  lineEditable?: boolean;
  /** 该提供商是否支持代理（Cloudflare / AliyunESA） */
  proxyCapable?: boolean;
  /** 提供商声明的默认线路（来自 registry）；缺省时退化为列表首项 */
  defaultLine?: string;
  record?: DnsRecordRow | null;
}

export function RecordDialog({ open, onOpenChange, domainId, recordTypes, lines, lineEditable = true, proxyCapable = false, defaultLine, record }: RecordDialogProps) {
  const isEdit = Boolean(record);
  const save = useSaveRecord(domainId);

  // 初值在挂载时算一次：父级按「新建 / 编辑某条记录」给 key，切换即重挂载
  const effectiveDefaultId = defaultLine ?? lines[0]?.id ?? '';

  const initial = useMemo(() => {
    if (record) {
      const def = getRecordTypeDef(record.type);
      const fields = def?.extraFields ?? [];
      const tokens = record.value.trim().split(/\s+/);
      const nextExtras: Record<string, string> = {};
      fields.forEach((field, index) => {
        nextExtras[field.key] = tokens[index] ?? String(field.defaultValue ?? '');
      });
      return {
        name: record.name, type: record.type, value: tokens.slice(fields.length).join(' '),
        ttl: String(record.ttl ?? 600),
        // 记录线路等于提供商默认线路时按「未指定」展示，避免与「默认线路」选项重复
        line: record.line || effectiveDefaultId,
        remark: record.remark ?? '',
        proxied: Boolean(record.cloudflare?.proxied), extras: nextExtras,
      };
    }
    const defaultType = recordTypes.includes('A') ? 'A' : (recordTypes[0] ?? 'A');
    const def = getRecordTypeDef(defaultType);
    return {
      name: '@', type: defaultType, value: '', ttl: '600', line: effectiveDefaultId, remark: '', proxied: false,
      extras: Object.fromEntries((def?.extraFields ?? []).map((field) => [field.key, String(field.defaultValue ?? '')])),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只取挂载时的快照
  }, []);

  const [name, setName] = useState(initial.name);
  const [type, setType] = useState(initial.type);
  const [value, setValue] = useState(initial.value);
  const [ttl, setTtl] = useState(initial.ttl);
  const [line, setLine] = useState<string>(initial.line);
  const [remark, setRemark] = useState(initial.remark);
  const [extras, setExtras] = useState<Record<string, string>>(initial.extras);
  const [proxied, setProxied] = useState(initial.proxied);
  const [error, setError] = useState<string | null>(null);

  const typeDef = useMemo(() => getRecordTypeDef(type), [type]);
  const extraFields = typeDef?.extraFields ?? [];

  const handleTypeChange = (nextType: string) => {
    setType(nextType);
    const def = getRecordTypeDef(nextType);
    setExtras(Object.fromEntries((def?.extraFields ?? []).map((field) => [field.key, String(field.defaultValue ?? '')])));
    setValue('');
    setError(null);
  };

  const composeValue = (): string => composeRecordValue(extraFields, extras, value);

  const submit = async () => {
    setError(null);
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('请输入主机记录');
      return;
    }
    if (!value.trim()) {
      setError('请输入记录值');
      return;
    }
    for (const field of extraFields) {
      if (field.required && !(extras[field.key] ?? '').trim()) {
        setError(`请填写${EXTRA_LABELS[field.key] ?? field.label}`);
        return;
      }
    }
    const ttlValue = Number(ttl);
    if (!Number.isFinite(ttlValue) || ttlValue < 1) {
      setError('TTL 必须大于 0');
      return;
    }

    const composed = composeValue();
    const valueError = validateRecordValue(type, composed);
    if (valueError) {
      setError(valueError);
      return;
    }

    try {
      await save.mutateAsync({
        recordId: record?.id,
        payload: {
          name: trimmedName,
          type,
          value: composed,
          ttl: ttlValue,
          line: line || undefined,
          mx: extras.mx !== undefined ? Number(extras.mx) : undefined,
          weight: extras.weight !== undefined ? Number(extras.weight) : undefined,
          remark: remark.trim() || undefined,
          // 代理语义独立于线路：只有支持代理的提供商与可代理记录类型才提交
          proxied: proxyCapable && PROXIABLE_RECORD_TYPES.has(type as never) ? proxied : undefined,
        },
      });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(94vw,34rem)]">
        <DialogHeader>
          <DialogTitle>{isEdit ? '编辑记录' : '新增记录'}</DialogTitle>
          <DialogDescription>
            {isEdit ? '修改后立即生效；线路由提供商能力决定是否可改。' : '记录创建后会同步到 DNS 提供商。'}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div role="alert" className={alertVariants('error', 'mb-3')}>
            {error}
          </div>
        )}

        <div className="grid gap-phi-6 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="record-name">主机记录</Label>
            <Input
              id="record-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onFocus={(event) => event.target.select()}
              placeholder="@ 或 www"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="record-type">类型</Label>
            <Select value={type} onValueChange={handleTypeChange}>
              <SelectTrigger id="record-type"><SelectValue /></SelectTrigger>
              <SelectContent>
                {recordTypes.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          {extraFields.map((field) => (
            <div key={field.key} className="space-y-1.5">
              <Label htmlFor={`extra-${field.key}`}>{EXTRA_LABELS[field.key] ?? field.label}</Label>
              <Input
                id={`extra-${field.key}`}
                inputMode={field.dataType === 'number' ? 'numeric' : 'text'}
                value={extras[field.key] ?? ''}
                onChange={(event) => setExtras((prev) => ({ ...prev, [field.key]: event.target.value }))}
              />
            </div>
          ))}

          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="record-value">记录值</Label>
            <Input id="record-value" value={value} onChange={(event) => setValue(event.target.value)} placeholder="1.2.3.4 或 example.com" />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="record-ttl">TTL（秒）</Label>
            <Input id="record-ttl" inputMode="numeric" value={ttl} onChange={(event) => setTtl(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="record-line">线路</Label>
            <Select value={line || effectiveDefaultId} onValueChange={setLine} disabled={isEdit && !lineEditable}>
              <SelectTrigger id="record-line"><SelectValue placeholder="默认" /></SelectTrigger>
              <SelectContent>
                {lines.map((item) => <SelectItem key={item.id} value={item.id}>{item.name || item.id}</SelectItem>)}
              </SelectContent>
            </Select>
            {isEdit && !lineEditable && <p className="text-xs text-muted-foreground">该提供商的线路创建后不可修改</p>}
          </div>

          {proxyCapable && PROXIABLE_RECORD_TYPES.has(type as never) && (
            <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 sm:col-span-2">
              <div>
                <p className="text-sm font-medium">代理（CDN）</p>
                <p className="text-xs text-muted-foreground">开启后该记录经提供商 CDN 回源</p>
              </div>
              <Switch checked={proxied} onCheckedChange={setProxied} aria-label="开启代理" />
            </div>
          )}

          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="record-remark">备注</Label>
            <Input id="record-remark" value={remark} onChange={(event) => setRemark(event.target.value)} placeholder="可选" />
          </div>
        </div>

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
