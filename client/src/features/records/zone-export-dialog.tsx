import { useState } from 'react';
import { alertVariants } from '../../ui/alert';
import { Download, Loader2 } from 'lucide-react';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui';
import { exportZone } from './api';

export interface ZoneExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  domainId: number;
  domainName?: string;
}

/**
 * 导出 BIND Zone。
 * 先选「相对名称 / 完整名称」再下载——历史实现是直接 <a href> 指向 JSON 接口，
 * 浏览器会把 {content,filename} 当文件下载，且没有名称格式选择。
 */
export function ZoneExportDialog({ open, onOpenChange, domainId, domainName }: ZoneExportDialogProps) {
  const [nameFormat, setNameFormat] = useState<'relative' | 'full'>('relative');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const download = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { content, filename } = await exportZone(domainId, nameFormat);
      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename || `${domainName ?? 'zone'}.zone`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setNotice(`已导出 ${filename}`);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '导出失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { onOpenChange(next); if (!next) { setError(null); setNotice(null); } }}>
      <DialogContent className="w-[min(94vw,28rem)]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Download className="h-4 w-4" />导出 Zone</DialogTitle>
          <DialogDescription>
            将当前域名的全部解析记录导出为 BIND Zone 文件（`{domainName ?? 'example.com'}.zone`）。
          </DialogDescription>
        </DialogHeader>

        {error && <div role="alert" className={alertVariants('error', 'mb-3')}>{error}</div>}
        {notice && <div role="status" className={alertVariants('success', 'mb-3')}>{notice}</div>}

        <div className="space-y-2">
          {([
            ['relative', '相对名称（推荐）', '主机记录保持 www / @ 形式，适用于再导入到 HiDNS 或其它面板'],
            ['full', '完整名称', '主机记录写成 FQDN（www.example.com.），便于直接作为权威 zone 使用'],
          ] as const).map(([value, label, hint]) => (
            <button
              key={value}
              type="button"
              className={`w-full rounded-md border p-3 text-left transition-colors ${nameFormat === value ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40'}`}
              onClick={() => setNameFormat(value)}
              aria-pressed={nameFormat === value}
            >
              <span className="block text-sm font-medium">{label}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span>
            </button>
          ))}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>取消</Button>
          <Button size="sm" onClick={() => void download()} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Download className="h-4 w-4" />}
            导出
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
