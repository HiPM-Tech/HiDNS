import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Download, RefreshCw, Search } from 'lucide-react';
import {
  Badge, Button, Card, CardContent, Input, Label, Pagination, Skeleton, Table, TableBody, TableCell,
  TableEmpty, TableHead, TableHeader, TableRow,
} from '../../ui';
import { formatNumber, formatRelative } from '../../lib/format';
import { auditExportUrl, type AuditFilters, type AuditQuery } from './api';
import { auditActionLabel, auditActionVariant, auditDetail } from './labels';
import { useAuditLogs } from './use-audit';

const EMPTY_FILTERS: AuditFilters = {};

export function AuditPage() {
  const [keywordInput, setKeywordInput] = useState('');
  const [filters, setFilters] = useState<AuditFilters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  // 后端 /api/audit/logs 只接受 domain / action / userId / startDate / endDate，
  // 没有通用的关键字检索；搜索框按「域名」下发，避免出现「输入了却完全不生效」的假控件。
  useEffect(() => {
    const timer = setTimeout(() => {
      setFilters((prev) => ({ ...prev, domain: keywordInput.trim() || undefined }));
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [keywordInput]);

  const query: AuditQuery = { ...filters, page, pageSize };
  const logs = useAuditLogs(query);
  const rows = logs.data?.list ?? [];
  const total = logs.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const exportCsv = useMemo(() => auditExportUrl('csv', filters), [filters]);
  const exportJson = useMemo(() => auditExportUrl('json', filters), [filters]);

  const updateFilter = (patch: Partial<AuditFilters>) => {
    setFilters((prev) => ({ ...prev, ...patch }));
    setPage(1);
  };

  return (
    <div className="space-y-phi-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-heading font-semibold">审计日志</h2>
          <p className="text-xs text-muted-foreground">
            {logs.isLoading ? '加载中…' : '共 ' + formatNumber(total) + ' 条记录'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void logs.refetch()} disabled={logs.isFetching}>
            <RefreshCw className={logs.isFetching ? 'animate-spin' : undefined} /> 刷新
          </Button>
          <Button variant="outline" size="sm" asChild>
            <a href={exportCsv} download><Download className="h-4 w-4" /> 导出 CSV</a>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <a href={exportJson} download><Download className="h-4 w-4" /> 导出 JSON</a>
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-8"
                placeholder="按域名搜索"
                value={keywordInput}
                onChange={(event) => setKeywordInput(event.target.value)}
                aria-label="按域名搜索审计日志"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="audit-action" className="sr-only">操作</Label>
              <Input
                id="audit-action"
                placeholder="操作（如 add_record）"
                value={filters.action ?? ''}
                onChange={(event) => updateFilter({ action: event.target.value.trim() || undefined })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="audit-start" className="sr-only">开始日期</Label>
              <Input
                id="audit-start"
                type="date"
                value={filters.startDate ?? ''}
                onChange={(event) => updateFilter({ startDate: event.target.value || undefined })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="audit-end" className="sr-only">结束日期</Label>
              <Input
                id="audit-end"
                type="date"
                value={filters.endDate ?? ''}
                onChange={(event) => updateFilter({ endDate: event.target.value || undefined })}
              />
            </div>
          </div>

          {logs.isError ? (
            <div className="space-y-2 py-8 text-center">
              <p className="flex items-center justify-center gap-2 text-sm text-destructive">
                <AlertTriangle className="h-4 w-4" />
                {logs.error instanceof Error ? logs.error.message : '加载失败'}
              </p>
              <Button variant="outline" size="sm" onClick={() => void logs.refetch()}>重试</Button>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-40">时间</TableHead>
                  <TableHead className="w-32">用户</TableHead>
                  <TableHead className="w-40">操作</TableHead>
                  <TableHead className="w-48">域名</TableHead>
                  <TableHead>详情</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.isLoading ? (
                  Array.from({ length: 8 }, (_, index) => (
                    <TableRow key={index}><TableCell colSpan={5}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
                  ))
                ) : rows.length === 0 ? (
                  <TableEmpty colSpan={5}>没有符合条件的审计记录</TableEmpty>
                ) : (
                  rows.map((log) => (
                    <TableRow key={log.id}>
                      <TableCell className="text-xs text-muted-foreground" title={log.created_at}>
                        {log.created_at ? formatRelative(log.created_at) : '—'}
                      </TableCell>
                      <TableCell className="text-xs">{log.nickname || log.username || '—'}</TableCell>
                      <TableCell>
                        <Badge variant={auditActionVariant(log.action)}>{auditActionLabel(log.action)}</Badge>
                      </TableCell>
                      <TableCell className="text-xs">
                        {log.domain ? <span className="font-medium">{log.domain}</span> : <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell>
                        <span className="block max-w-xl truncate text-xs text-muted-foreground" title={auditDetail(log.data)}>
                          {auditDetail(log.data) || '—'}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}

          <Pagination
            page={page}
            pageSize={pageSize}
            total={total}
            totalPages={totalPages}
            isFetching={logs.isFetching}
            onPageChange={setPage}
            onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
