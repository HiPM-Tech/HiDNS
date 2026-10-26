import { useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../ui/cn';
import { DNS_TOKEN_PERMISSIONS, type AllowedServices, type DnsTokenPermission, type TokenService } from './permissions';

const SERVICES: TokenService[] = ['dns', 'mcp'];

export function TokenServicePicker({ value, onChange }: { value: AllowedServices; onChange: (value: AllowedServices) => void }) {
  const id = useId();
  const [expanded, setExpanded] = useState<Partial<Record<TokenService, boolean>>>({});

  const toggleService = (service: TokenService) => {
    const next = { ...value };
    if (next[service]?.length) delete next[service];
    else if (service === 'dns') next.dns = ['*'];
    else next.mcp = ['*'];
    onChange(next);
  };

  const togglePermission = (permission: DnsTokenPermission) => {
    const selected = (value.dns ?? []).filter((item): item is DnsTokenPermission => item !== '*');
    const next = selected.includes(permission) ? selected.filter(item => item !== permission) : [...selected, permission];
    onChange({ ...value, dns: next.length ? next : ['*'] });
  };

  return (
    <div className="space-y-2">
      {SERVICES.map(service => {
        const enabled = Boolean(value[service]?.length);
        const permissions = value[service] ?? [];
        const all = permissions.includes('*');
        const summary = !enabled ? '未授权' : all ? '全部权限' : `已选 ${permissions.length} 项`;
        const isExpanded = Boolean(expanded[service]);
        return (
          <div key={service} className="space-y-2">
            <div className={cn(
              'flex w-full items-stretch overflow-hidden rounded-xl border text-sm transition-colors',
              enabled ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground',
            )}>
              <button
                type="button"
                aria-label={`${service} 服务`}
                aria-pressed={enabled}
                onClick={() => toggleService(service)}
                className="flex min-w-0 flex-1 items-center justify-between gap-2 px-4 py-2.5 text-left hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <span className="font-medium">{service}</span>
                <span className="text-xs">{summary}</span>
              </button>
              <button
                type="button"
                aria-label={`${isExpanded ? '收起' : '展开'} ${service} 权限`}
                aria-expanded={isExpanded}
                aria-controls={`${id}-${service}`}
                onClick={() => setExpanded(previous => ({ ...previous, [service]: !previous[service] }))}
                className="shrink-0 border-l border-current/10 px-3 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <ChevronDown aria-hidden className={cn('h-4 w-4 transition-transform', isExpanded && 'rotate-180')} />
              </button>
            </div>
            <div id={`${id}-${service}`} hidden={!isExpanded} className="space-y-2 px-1 pb-1">
              {service === 'dns' ? (
                <>
                  <p className="text-xs text-muted-foreground">
                    {enabled ? '未选具体权限时为全部权限（*）；写权限不包含读权限。' : '请先选中 dns 服务，再选择具体权限。'}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {DNS_TOKEN_PERMISSIONS.map(permission => (
                      <button
                        key={permission}
                        type="button"
                        disabled={!enabled}
                        aria-pressed={!all && value.dns?.includes(permission) === true}
                        onClick={() => togglePermission(permission)}
                        className={cn(
                          'rounded-full border px-3 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
                          !all && value.dns?.includes(permission)
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'border-border text-muted-foreground enabled:hover:bg-accent',
                        )}
                      >
                        {permission}
                      </button>
                    ))}
                  </div>
                </>
              ) : <p className="text-xs text-muted-foreground">全部权限（*），暂不支持细分；选中 mcp 服务后生效。</p>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
