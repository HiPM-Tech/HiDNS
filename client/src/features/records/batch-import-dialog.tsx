import { useMemo, useRef, useState } from 'react';
import { alertVariants } from '../../ui/alert';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui';
import { batchCreateRecords, type BatchResult, type RecordPayload } from './api';
import { parseZoneText } from './zone-import';

const SAMPLE = `www A 1.2.3.4 600
@ MX mail.example.com 3600
_dmarc TXT "v=DMARC1; p=none" 600`;

export interface ParsedRow {
  line: number;
  raw: string;
  payload?: RecordPayload;
  error?: string;
}

/** 解析 "主机记录 类型 记录值 [TTL] [备注]"；引号内的空格不切分 */
export function parseBatchLine(raw: string, index: number): ParsedRow {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('#')) return { line: index + 1, raw };

  const tokens = trimmed.match(/(?:"[^"]*"|\S)+/g)?.map((token) => token.replace(/^"|"$/g, '')) ?? [];
  if (tokens.length < 3) {
    return { line: index + 1, raw, error: '至少需要「主机记录 类型 记录值」三列' };
  }
  const [name, type, value, ttlRaw, ...remarkParts] = tokens;
  const ttl = ttlRaw && /^\d+$/.test(ttlRaw) ? Number(ttlRaw) : undefined;
  return {
    line: index + 1,
    raw,
    payload: {
      name,
      type: type.toUpperCase(),
      value,
      ttl,
      remark: remarkParts.join(' ') || undefined,
    },
  };
}

export interface BatchImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  domainId: number;
  /** 域名（用于解析 .zone 的相对名称与 $ORIGIN） */
  domainName?: string;
  onImported?: () => void;
}

export function BatchImportDialog({ open, onOpenChange, domainId, domainName, onImported }: BatchImportDialogProps) {
  const [text, setText] = useState('');
  const [zoneRows, setZoneRows] = useState<ParsedRow[]>([]);
  const [zoneNotice, setZoneNotice] = useState<string | null>(null);
  const zoneInputRef = useRef<HTMLInputElement>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<BatchResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const parsed = useMemo(() => text.split('\n').map(parseBatchLine), [text]);
  const allRows = useMemo(() => [...parsed, ...zoneRows], [parsed, zoneRows]);
  const valid = allRows.filter((row) => row.payload);
  const invalid = allRows.filter((row) => row.error);

  const handleZoneFile = async (file: File | undefined) => {
    if (!file) return;
    setZoneNotice(null);
    try {
      const content = await file.text();
      const { rows, skipped } = parseZoneText(content, domainName ?? '');
      setZoneRows(rows);
      const ok = rows.filter((row) => row.payload).length;
      setZoneNotice(`从 ${file.name} 解析 ${ok} 条${skipped > 0 ? `，跳过 ${skipped} 条（SOA/NS 等）` : ''}`);
    } catch (err) {
      setZoneNotice(err instanceof Error ? err.message : '读取 zone 文件失败');
    } finally {
      if (zoneInputRef.current) zoneInputRef.current.value = '';
    }
  };

  const submit = async () => {
    if (valid.length === 0) {
      setError('没有可导入的有效行');
      return;
    }
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const batch = await batchCreateRecords(domainId, valid.map((row) => row.payload as RecordPayload));
      setResult(batch);
      // 部分成功也要刷新列表，否则用户看不到已导入的记录
      if (batch.results.some((item) => item.ok)) onImported?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : '导入失败');
    } finally {
      setSubmitting(false);
    }
  };

  const failedItems = result ? result.results.filter((item) => !item.ok) : [];
  // 失败行要指回用户输入的原始行号（服务端只知道自己收到的数组下标）
  const sourceLineOf = (index: number) => valid[index]?.line ?? index + 1;

  return (
    <Dialog open={open} onOpenChange={(next) => { onOpenChange(next); if (!next) { setResult(null); setError(null); setZoneRows([]); setZoneNotice(null); } }}>
      <DialogContent className="w-[min(94vw,40rem)]">
        <DialogHeader>
          <DialogTitle>批量导入记录</DialogTitle>
          <DialogDescription>
            每行一条：<code className="rounded bg-muted px-1">主机记录 类型 记录值 [TTL] [备注]</code>；以 <code className="rounded bg-muted px-1">#</code> 开头的行会被忽略。
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div role="alert" className={alertVariants('error', 'mb-3 flex items-center gap-2')}>
            <AlertTriangle className="h-4 w-4" /> {error}
          </div>
        )}

        <div className="mb-2 flex flex-wrap items-center gap-2">
          <input
            ref={zoneInputRef}
            type="file"
            accept=".zone,.txt,text/plain"
            className="hidden"
            onChange={(event) => void handleZoneFile(event.target.files?.[0])}
            aria-label="选择 zone 文件"
          />
          <Button variant="outline" size="sm" onClick={() => zoneInputRef.current?.click()}>从 .zone 文件导入</Button>
          {zoneNotice && <span className="text-xs text-muted-foreground">{zoneNotice}</span>}
        </div>

        <textarea
          className="h-44 w-full resize-y rounded-md border border-input bg-background p-3 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          placeholder={SAMPLE}
          value={text}
          onChange={(event) => setText(event.target.value)}
          aria-label="批量导入内容"
        />

        <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
          <span>
            有效 {valid.length} 行{invalid.length > 0 ? '，' + invalid.length + ' 行有问题' : ''}
          </span>
          {invalid.length > 0 && (
            <span className="text-warning-600 dark:text-warning-400">
              第 {invalid.slice(0, 3).map((row) => row.line).join('、')} 行格式不完整
            </span>
          )}
        </div>

        {result && (
          <div className="mt-3 rounded-md border border-border bg-muted/40 p-3 text-xs">
            <p className="flex items-center gap-1 font-medium">
              {failedItems.length === 0
                ? <><CheckCircle2 className="h-4 w-4 text-success-600" /> 全部导入成功（{result.results.length} 条）</>
                : <><AlertTriangle className="h-4 w-4 text-warning-600" /> 成功 {result.results.length - failedItems.length} 条，失败 {failedItems.length} 条</>}
            </p>
            {failedItems.length > 0 && (
              <ul className="mt-2 max-h-24 space-y-1 overflow-y-auto text-destructive">
                {failedItems.map((item) => (
                  <li key={item.line}>原第 {sourceLineOf(item.line - 1)} 行：{item.error ?? '导入失败'}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>关闭</Button>
          <Button size="sm" onClick={() => void submit()} disabled={submitting || valid.length === 0}>
            {submitting && <Loader2 className="animate-spin" />}
            导入{valid.length > 0 ? ' ' + valid.length : ''} 条
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
