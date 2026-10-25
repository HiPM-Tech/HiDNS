import { http } from '../../lib/http';

/** MCP 权限模块（与后端 scope 串 module:level 一致） */
export const SCOPE_MODULES = [
  { key: 'ns_monitor', label: 'NS 监控' },
  { key: 'domain_management', label: '域名管理' },
  { key: 'renewal_management', label: '续期管理' },
  { key: 'log_query', label: '日志查询' },
  { key: 'service_monitor', label: '服务监控' },
] as const;

/** 解析 scope 串；兼容被 JSON 包裹的历史格式 */
export function parseScope(scope?: string | null): Record<string, string> {
  if (!scope) return {};
  const text = scope.trim().startsWith('"')
    ? (() => { try { return JSON.parse(scope) as string; } catch { return scope; } })()
    : scope;
  const result: Record<string, string> = {};
  for (const item of String(text).split(',').map((part) => part.trim()).filter(Boolean)) {
    const [module, level] = item.split(':');
    if (module && level) result[module] = level;
  }
  return result;
}

export function consentApi() {
  return http;
}
