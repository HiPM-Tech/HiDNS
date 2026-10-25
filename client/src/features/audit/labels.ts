/**
 * 审计动作的中文标签与语义色（单一来源，不再依赖 i18n 键）。
 * 未登记的动作原样展示，便于新增动作时立即可见而不是显示成裸 key。
 */
export type AuditVariant = 'success' | 'warning' | 'destructive' | 'secondary';

const ACTION_LABELS: Record<string, { label: string; variant: AuditVariant }> = {
  login: { label: '登录', variant: 'secondary' },
  logout: { label: '登出', variant: 'secondary' },
  login_failed: { label: '登录失败', variant: 'destructive' },
  password_changed: { label: '修改密码', variant: 'warning' },
  add_record: { label: '新增记录', variant: 'success' },
  update_record: { label: '修改记录', variant: 'warning' },
  delete_record: { label: '删除记录', variant: 'destructive' },
  add_domain: { label: '添加域名', variant: 'success' },
  delete_domain: { label: '删除域名', variant: 'destructive' },
  sync_domains: { label: '同步域名', variant: 'secondary' },
  create_token: { label: '创建令牌', variant: 'success' },
  delete_token: { label: '删除令牌', variant: 'destructive' },
  '2fa_enabled': { label: '启用 2FA', variant: 'success' },
  '2fa_disabled': { label: '停用 2FA', variant: 'warning' },
  unbind_oauth_account: { label: '解绑外部账号', variant: 'warning' },
  update_security_policy: { label: '修改安全策略', variant: 'warning' },
  create_account: { label: '新增 DNS 账户', variant: 'success' },
  update_account: { label: '修改 DNS 账户', variant: 'warning' },
  delete_account: { label: '删除 DNS 账户', variant: 'destructive' },
};

export function auditActionLabel(action: string): string {
  return ACTION_LABELS[action]?.label ?? action;
}

export function auditActionVariant(action: string): AuditVariant {
  return ACTION_LABELS[action]?.variant ?? 'secondary';
}

/** 解析 data JSON，失败时返回原始字符串（不吞掉信息） */
export function auditDetail(data?: string | null): string {
  if (!data) return '';
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object') {
      return Object.entries(parsed)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
        .join(' · ');
    }
  } catch {
    // 非 JSON：原样返回
  }
  return data;
}
