// UserToken DNS permissions; workflow-internal AVAILABLE_SERVICES is a separate namespace.
export const DNS_TOKEN_PERMISSIONS = [
  'accounts.read', 'accounts.write',
  'domains.read', 'domains.write',
  'records.read', 'records.write',
  'providers.read', 'email-templates.read',
  'ns-monitor.read', 'ns-monitor.write',
  'servicemonitor.read', 'servicemonitor.write',
  'workflow.read', 'workflow.write', 'workflow.run',
] as const;

export type DnsTokenPermission = typeof DNS_TOKEN_PERMISSIONS[number];
export type TokenService = 'dns' | 'mcp';
export interface AllowedServices {
  dns?: Array<DnsTokenPermission | '*'>;
  mcp?: Array<'*'>;
}
