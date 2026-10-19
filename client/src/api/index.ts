// ─── API Module Exports ──────────────────────────────────────────────────────
// This file provides backward-compatible exports while migration to modular structure is in progress.
// New code should import directly from individual module files (e.g., './auth', './accounts').

// Base client and types
export { api } from './client';
export type { ApiResponse } from './client';
export * from './types';

// Modular APIs (new structure - preferred)
export { authApi } from './auth';
export { accountsApi, tunnelsApi } from './accounts';
export { domainsApi, domainRenewalApi } from './domains';
export { recordsApi } from './records';
export type { EmailTemplate, EmailTemplateRecord } from './records';
export { usersApi } from './users';
export { teamsApi } from './teams';
export { logsApi } from './logs';
export { systemApi, settingsApi, securityApi } from './settings';
export { tokensApi } from './tokens';
export { nsMonitorApi } from './ns-monitor';
export { workflowsApi } from './workflows';
export type {
  WorkflowRecord,
  WorkflowRunRecord,
  WorkflowPayload,
  WorkflowActionMeta,
  WorkflowActionParam,
  WorkflowDslNode,
} from './workflows';
export { networkApi } from './network';
export { serviceMonitorApi } from './servicemonitor';
export { resourceMonitorApi } from './resource-monitor';
export type { ResourceSnapshot } from './resource-monitor';
export { initApi } from './init';
export type { InitDbConfig, InitDatabaseType } from './init';
export { mcpApi } from './mcp';
export type { McpApiKey, McpGlobalConfig, McpAuditLog, McpAuditStats } from './mcp';

// Legacy API exports (deprecated - will be removed after full migration)
// These are kept for backward compatibility with existing imports
