const WHOIS_STATUS_LABELS: Record<string, string> = {
  active: '正常',
  ok: '正常',
  expired: '已过期',
  inactive: '未激活',
  hold: '暂停解析',
  pendingdelete: '待删除',
  redemptionperiod: '赎回期',
  pendingtransfer: '转移中',
  pendingrenew: '续费中',
  pendingcreate: '注册中',
  addperiod: '新注册期',
  autorenewperiod: '自动续费期',
  renewperiod: '续费期',
  transferperiod: '转移期',
  clienttransferprohibited: '禁止转移',
  clientdeleteprohibited: '禁止删除',
  clientupdateprohibited: '禁止更新',
  clientrenewprohibited: '禁止续费',
  clienthold: '注册商暂停',
  servertransferprohibited: '注册局禁止转移',
  serverdeleteprohibited: '注册局禁止删除',
  serverupdateprohibited: '注册局禁止更新',
  serverhold: '注册局暂停',
  associated: '已关联',
};

/** WHOIS 状态可能由多行 EPP 状态拼接，逐项翻译后用「 / 」合并 */
export function formatWhoisStatus(status?: string | null): string {
  if (!status) return '';
  const labels = status
    .split(/[\n,;]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    // EPP 状态可能以 clientTransferProhibited / "client transfer prohibited" / client-transfer-prohibited 出现
    .map((item) => WHOIS_STATUS_LABELS[item.toLowerCase().replace(/[\s_-]+/g, '')] ?? item);
  return [...new Set(labels)].join(' / ');
}

/** 状态徽标语义色：过期/删除类 destructive，禁止/暂停类 warning，正常 success */
export function whoisStatusVariant(status?: string | null): 'success' | 'warning' | 'destructive' | 'secondary' {
  const raw = (status ?? '').toLowerCase();
  if (!raw) return 'secondary';
  if (/expired|pendingdelete|redemption/.test(raw)) return 'destructive';
  if (/prohibited|hold|inactive|pending/.test(raw)) return 'warning';
  return 'success';
}
