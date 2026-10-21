import { useRealtimeData } from '../hooks/useRealtimeData';

import { OverviewTab } from './system/OverviewTab';
import { DatabaseTab } from './system/DatabaseTab';
import { SecurityTab } from './system/SecurityTab';
import { AccessTab } from './system/AccessTab';
import { NetworkTab } from './system/NetworkTab';
import { WorkflowTab } from './system/WorkflowTab';
import { NotificationChannels } from '../components/NotificationChannels';

type SystemTab = 'overview' | 'database' | 'security' | 'access' | 'network' | 'notifications' | 'workflow';

interface SystemProps {
  activeTab: SystemTab;
}

export function System({ activeTab }: SystemProps) {
  useRealtimeData({
    queryKey: ['system-config'],
    websocketEventTypes: ['config_updated', 'smtp_updated', 'oauth_updated', 'security_config_updated'],
    pollingInterval: 300000,
  });

  return (
    <div className="page-shell">
      {activeTab === 'overview' && <OverviewTab />}
      {activeTab === 'database' && <DatabaseTab />}
      {activeTab === 'security' && <SecurityTab />}
      {activeTab === 'access' && <AccessTab />}
      {activeTab === 'network' && <NetworkTab />}
      {activeTab === 'notifications' && <NotificationChannels />}
      {activeTab === 'workflow' && <WorkflowTab />}
    </div>
  );
}
