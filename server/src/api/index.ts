import type { Application } from 'express';
import express from 'express';

import { createInitGate, type InitGateDeps } from './init-gate';
import { defineApiModules, toManifest } from './registry';
import { mountApiModules } from './mount';
import type { ApiManifestEntry, ApiModule } from './types';

import authRouter from '../routes/auth';
import usersRouter from '../routes/users';
import teamsRouter from '../routes/teams';
import accountsRouter from '../routes/accounts';
import domainsRouter from '../routes/domains';
import providersRouter from '../routes/providers';
import recordsRouter, { emailTemplatesRouter } from '../routes/records';
import initRouter from '../routes/init';
import systemRouter from '../routes/system';
import settingsRouter from '../routes/settings';
import securityRouter from '../routes/security';
import auditRouter from '../routes/audit';
import webauthnRouter from '../routes/webauthn';
import tokensRouter from '../routes/tokens';
import nsMonitorRouter from '../routes/ns-monitor';
import networkRouter from '../routes/network';
import rdapRouter from '../routes/rdap';
import servicemonitorRouter from '../routes/servicemonitor';
import resourceMonitorRouter from '../routes/resource-monitor';
import workflowsRouter from '../routes/workflows';
import mcpConfigRouter from '../routes/mcp-config';
import mcpApiKeysRouter from '../routes/mcp-apikeys';
import mcpOAuthRouter from '../routes/mcp-oauth';
import mcpAuditRouter from '../routes/mcp-audit';
import mcpProtocolRouter from '../routes/mcp-protocol';
import logsRouter from './modules/logs';
import { rdapLimiter } from '../middleware/rateLimit';

/**
 * MCP 组合路由：子路径顺序敏感（更具体的管理路由必须排在协议路由之前），
 * 组合关系集中在此处声明，路由文件本身互不感知。
 */
function composeMcpRouter() {
  const router = express.Router();
  router.use('/', mcpConfigRouter);          // /config, /status, /.well-known/*
  router.use('/api-keys', mcpApiKeysRouter); // 需鉴权
  router.use('/oauth', mcpOAuthRouter);      // 混合（部分公开、部分需认证）
  router.use('/audit-logs', mcpAuditRouter);
  router.use('/audit-stats', mcpAuditRouter);
  router.use('/', mcpProtocolRouter);        // Streamable HTTP / SSE，放最后
  return router;
}

/**
 * API 模块清单（唯一注册点）。
 *
 * 顺序即匹配顺序：
 * - 静态子路径必须排在父前缀之前（/api/domains/email-templates → /api/domains）；
 * - 豁免项通过 exemptFromInitGate 显式声明，门禁不再维护第二份前缀清单。
 */
export function buildApiModules(): readonly ApiModule[] {
  return defineApiModules([
    {
      id: 'init',
      prefix: '/api/init',
      router: initRouter,
      exemptFromInitGate: true,
      closedStateProbes: ['/api/init/status', '/api/init/db-config'],
      description: '系统初始化：仅在未初始化且数据库可达时开放；数据库不可达时只保留只读探测',
    },
    { id: 'auth', prefix: '/api/auth', router: authRouter, description: '用户认证：登录、注册、密码重置' },
    { id: 'webauthn', prefix: '/api/auth/webauthn', router: webauthnRouter, description: 'WebAuthn 无密码认证' },
    { id: 'users', prefix: '/api/users', router: usersRouter, description: '用户管理' },
    { id: 'teams', prefix: '/api/teams', router: teamsRouter, description: '团队与成员管理' },
    { id: 'accounts', prefix: '/api/accounts', router: accountsRouter, description: 'DNS 账户管理' },
    {
      id: 'domain-email-templates',
      prefix: '/api/domains/email-templates',
      router: emailTemplatesRouter,
      description: '邮件模板（必须先于 /api/domains 挂载，否则被父路由遮蔽）',
    },
    { id: 'domains', prefix: '/api/domains', router: domainsRouter, description: '域名管理与线路/记录类型查询' },
    { id: 'providers', prefix: '/api/providers', router: providersRouter, description: 'DNS 提供商元数据与图标' },
    {
      id: 'records',
      prefix: '/api/domains/:domainId/records',
      router: recordsRouter,
      description: 'DNS 记录增删改查与批量导入',
    },
    {
      id: 'rdap',
      prefix: '/api/rdap',
      router: rdapRouter,
      middlewares: [rdapLimiter],
      exemptFromInitGate: true,
      description: '公开 RDAP 查询（无需鉴权，单独限流）',
    },
    { id: 'system', prefix: '/api/system', router: systemRouter, description: '系统信息与运行状态' },
    { id: 'settings', prefix: '/api/settings', router: settingsRouter, description: '系统设置（SMTP、代理、白名单）' },
    { id: 'security', prefix: '/api/security', router: securityRouter, description: '安全策略、2FA、可信设备、会话' },
    { id: 'audit', prefix: '/api/audit', router: auditRouter, description: '审计日志查询与导出' },
    { id: 'tokens', prefix: '/api/tokens', router: tokensRouter, description: 'API 令牌管理' },
    { id: 'ns-monitor', prefix: '/api/ns-monitor', router: nsMonitorRouter, description: 'NS 监控' },
    { id: 'network', prefix: '/api/network', router: networkRouter, description: '网络工具（WHOIS/RDAP/DNS 查询）' },
    { id: 'servicemonitor', prefix: '/api/servicemonitor', router: servicemonitorRouter, description: '服务监控与故障转移' },
    { id: 'resource-monitor', prefix: '/api/resource-monitor', router: resourceMonitorRouter, description: '资源监控面板' },
    { id: 'workflows', prefix: '/api/workflows', router: workflowsRouter, description: '自动化工作流（受初始化门禁保护）' },
    { id: 'mcp', prefix: '/api/mcp', router: composeMcpRouter(), description: 'MCP 协议：配置、密钥、OAuth、审计、Streamable HTTP/SSE' },
    { id: 'logs', prefix: '/api/logs', router: logsRouter, description: '操作日志（管理员）' },
  ]);
}

export interface ApiLayer {
  readonly modules: readonly ApiModule[];
  readonly manifest: ApiManifestEntry[];
  /** 初始化门禁中间件，必须在 /api/docs 与全部模块之前注册 */
  readonly gate: ReturnType<typeof createInitGate>;
  /** 按清单顺序挂载全部模块 */
  mount: (app: Application) => void;
}

export function createApiLayer(deps: InitGateDeps): ApiLayer {
  const modules = buildApiModules();
  return {
    modules,
    manifest: toManifest(modules),
    gate: createInitGate(modules, deps),
    mount: (app: Application) => mountApiModules(app, modules),
  };
}

export type { ApiModule, ApiManifestEntry } from './types';
export { defineApiModules, toManifest, getExemptPrefixes } from './registry';
export { createInitGate } from './init-gate';
export { mountApiModules } from './mount';
