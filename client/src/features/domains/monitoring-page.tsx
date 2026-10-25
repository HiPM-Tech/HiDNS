import { Link } from 'react-router-dom';
import { Activity, CalendarClock, LayoutGrid, Radar } from 'lucide-react';
import { cn } from '../../ui/cn';
import { ServiceMonitorTab } from './service-monitor-tab';
import { NsMonitorTab } from './ns-monitor-tab';
import { DomainRenewalTab } from './renewal-tab';

export type DomainTab = 'list' | 'servicemonitor' | 'ns-monitor' | 'renewal';

const TABS: Array<{ key: DomainTab; label: string; to: string; icon: typeof LayoutGrid }> = [
  { key: 'list', label: '域名列表', to: '/dash/domains', icon: LayoutGrid },
  { key: 'servicemonitor', label: '服务监控', to: '/dash/domains/servicemonitor', icon: Activity },
  { key: 'ns-monitor', label: 'NS 监控', to: '/dash/domains/ns-monitor', icon: Radar },
  { key: 'renewal', label: '域名续期', to: '/dash/domains/renewal', icon: CalendarClock },
];

/** 域名域的子页外壳：列表页已原生重写，监控/续期暂挂载旧组件，逐页替换 */
export function DomainMonitoringPage({ activeTab }: { activeTab: Exclude<DomainTab, 'list'> }) {
  return (
    <div className="space-y-phi-6">
      <nav className="flex flex-wrap gap-1 border-b border-border pb-2" aria-label="域名子页">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const active = tab.key === activeTab;
          return (
            <Link
              key={tab.key}
              to={tab.to}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors',
                active ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-accent',
              )}
              aria-current={active ? 'page' : undefined}
            >
              <Icon className="h-4 w-4" aria-hidden />
              {tab.label}
            </Link>
          );
        })}
      </nav>

      {activeTab === 'servicemonitor' && <ServiceMonitorTab />}
      {activeTab === 'ns-monitor' && <NsMonitorTab />}
      {activeTab === 'renewal' && <DomainRenewalTab />}
    </div>
  );
}
