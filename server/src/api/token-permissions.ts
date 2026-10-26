import type { DnsTokenPermission } from '../types/token';

/** Called after Express has matched a route, including dynamic records mounts. */
export function dnsPermissionForRoute(baseUrl: string, method: string, routePath: string): DnsTokenPermission | null {
  const base = baseUrl.toLowerCase().replace(/\/$/, '');
  const route = routePath.toLowerCase();
  const read = method === 'GET' || method === 'HEAD';
  if (/^\/api\/domains\/[^/]+\/records$/.test(base)) return read ? 'records.read' : 'records.write';
  switch (base) {
    case '/api/accounts':
      if (route === '/providers') return 'providers.read';
      return read ? 'accounts.read' : 'accounts.write';
    case '/api/domains':
      if (route === '/:id/lines' || route === '/:id/record-types') return 'records.read';
      return read ? 'domains.read' : 'domains.write';
    case '/api/domains/email-templates':
      return 'email-templates.read';
    case '/api/providers':
      return 'providers.read';
    case '/api/ns-monitor':
      return read || route === '/resolve-ns' ? 'ns-monitor.read' : 'ns-monitor.write';
    case '/api/servicemonitor':
      return read ? 'servicemonitor.read' : 'servicemonitor.write';
    case '/api/workflows':
      if (route === '/:id/run' || route === '/:id/test') return 'workflow.run';
      return read ? 'workflow.read' : 'workflow.write';
    default:
      return null;
  }
}
