import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { formatNumber } from '../lib/format';
import { Button } from './button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';

export interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  pageSizes?: number[];
  isFetching?: boolean;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}

/**
 * 列表分页条（唯一实现）。
 * 统一「每页条数 + 总数 + 页码 + 上下页 + 加载态」，避免每个列表页各写一份。
 */
export function Pagination({
  page,
  pageSize,
  total,
  totalPages,
  pageSizes = [20, 50, 100],
  isFetching = false,
  onPageChange,
  onPageSizeChange,
}: PaginationProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs text-muted-foreground">
      <div className="flex items-center gap-2">
        <span>每页</span>
        <Select value={String(pageSize)} onValueChange={(value) => onPageSizeChange(Number(value))}>
          <SelectTrigger className="h-8 w-20" aria-label="每页数量"><SelectValue /></SelectTrigger>
          <SelectContent>
            {pageSizes.map((size) => <SelectItem key={size} value={String(size)}>{size}</SelectItem>)}
          </SelectContent>
        </Select>
        <span>条 · 共 {formatNumber(total)} 条</span>
      </div>
      <div className="flex items-center gap-2">
        <span>第 {page} / {Math.max(1, totalPages)} 页</span>
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          disabled={page <= 1}
          onClick={() => onPageChange(Math.max(1, page - 1))}
          aria-label="上一页"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          aria-label="下一页"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
        {isFetching && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
      </div>
    </div>
  );
}
