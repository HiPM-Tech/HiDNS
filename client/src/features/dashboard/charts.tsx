import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card';
import { http } from '../../lib/http';
import { daysUntil } from '../../lib/format';

/**
 * 仪表盘图表：**原生 SVG**，不引入图表库。
 *
 * 选择理由：本项目的构建环境里新依赖装不上（pnpm store 只读），
 * 而这三张图的数据量都在几十点量级，SVG 手绘足够，且不增加首屏体积。
 * 需要交互（缩放/钻取）时再考虑可视化库（issue #52 的 52-B）。
 */

const SERIES_COLORS = ['rgb(59 130 246)', 'rgb(16 185 129)', 'rgb(245 158 11)', 'rgb(168 85 247)', 'rgb(244 63 94)', 'rgb(14 165 233)'];

export interface ProviderShareItem { type: string; count: number; percent: number }

/** 提供商占比：横向条形，标签不会像饼图那样重叠 */
export function ProviderShareChart({ items }: { items: ProviderShareItem[] }) {
  const rows = items.slice(0, 6);
  const max = Math.max(1, ...rows.map((row) => row.percent));
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">提供商占比</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {rows.length === 0 && <p className="text-sm text-muted-foreground">暂无账号</p>}
        {rows.map((row, index) => (
          <div key={row.type} className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="truncate">{row.type}</span>
              <span className="tabular-nums text-muted-foreground">{row.count} 个 · {row.percent}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full"
                style={{ width: `${Math.max(2, (row.percent / max) * 100)}%`, backgroundColor: SERIES_COLORS[index % SERIES_COLORS.length] }}
              />
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

const EXPIRY_BUCKETS = [
  { label: '≤30 天', max: 30 },
  { label: '31-90 天', max: 90 },
  { label: '91-180 天', max: 180 },
  { label: '181-365 天', max: 365 },
  { label: '>365 天', max: Number.POSITIVE_INFINITY },
];

/** 到期分布：柱状，按剩余天数分桶 */
export function ExpiryBucketsChart({ expiresAt }: { expiresAt: Array<string | null | undefined> }) {
  const buckets = useMemo(() => {
    const counts = EXPIRY_BUCKETS.map(() => 0);
    for (const value of expiresAt) {
      const days = daysUntil(value ?? undefined);
      if (days === null) continue;
      const index = EXPIRY_BUCKETS.findIndex((bucket) => days <= bucket.max);
      if (index >= 0) counts[index] += 1;
    }
    return counts;
  }, [expiresAt]);

  const max = Math.max(1, ...buckets);
  const width = 320;
  const height = 140;
  const barWidth = width / EXPIRY_BUCKETS.length;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">到期分布</CardTitle>
      </CardHeader>
      <CardContent>
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="域名到期分布" className="h-36 w-full">
          {buckets.map((count, index) => {
            const barHeight = (count / max) * (height - 34);
            return (
              <g key={EXPIRY_BUCKETS[index].label}>
                <rect
                  x={index * barWidth + 10}
                  y={height - 22 - barHeight}
                  width={barWidth - 20}
                  height={Math.max(count > 0 ? 3 : 0, barHeight)}
                  rx={3}
                  fill={SERIES_COLORS[index % SERIES_COLORS.length]}
                />
                <text x={index * barWidth + barWidth / 2} y={height - 8} textAnchor="middle" className="fill-current text-[9px] text-muted-foreground">
                  {EXPIRY_BUCKETS[index].label}
                </text>
                {count > 0 && (
                  <text x={index * barWidth + barWidth / 2} y={height - 26 - barHeight} textAnchor="middle" className="fill-current text-[10px]">
                    {count}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </CardContent>
    </Card>
  );
}

interface ResourceHistoryRow { recorded_at?: string; cpu_percent?: number; memory_percent?: number }

/** 资源趋势：CPU / 内存折线（数据来自 /api/resource-monitor/history） */
export function ResourceTrendChart() {
  const query = useQuery({
    queryKey: ['dashboard', 'resource-history'],
    queryFn: async () => {
      const envelope = await http.get<{ total: number; list: ResourceHistoryRow[] }>('/resource-monitor/history', {
        query: { pageSize: 60, hours: 24 },
      });
      return (envelope.data?.list ?? []).slice().reverse();
    },
    staleTime: 60_000,
  });

  const rows = query.data ?? [];
  const series = [
    { key: 'cpu_percent' as const, label: 'CPU', color: SERIES_COLORS[0] },
    { key: 'memory_percent' as const, label: '内存', color: SERIES_COLORS[1] },
  ];
  const width = 320;
  const height = 120;

  const path = (key: 'cpu_percent' | 'memory_percent') => {
    const points = rows.map((row, index) => {
      const value = Math.min(100, Math.max(0, Number(row[key] ?? 0)));
      const x = rows.length <= 1 ? 0 : (index / (rows.length - 1)) * width;
      const y = height - 12 - (value / 100) * (height - 24);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return points.join(' ');
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          资源趋势（24 小时）
        </CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length < 2 ? (
          <p className="text-sm text-muted-foreground">采样数据不足（后端每 5 分钟记录一次）</p>
        ) : (
          <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="资源使用趋势" className="h-28 w-full">
            {series.map((item) => (
              <polyline
                key={item.key}
                points={path(item.key)}
                fill="none"
                stroke={item.color}
                strokeWidth={1.5}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}
          </svg>
        )}
        <div className="mt-1 flex gap-3 text-xs text-muted-foreground">
          {series.map((item) => (
            <span key={item.key} className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: item.color }} />
              {item.label}
            </span>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
