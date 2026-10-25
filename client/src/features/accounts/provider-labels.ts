/**
 * 提供商与配置字段的中文文案。
 *
 * 后端 registry.ts 里的 name / configFields[].label 是 i18n key（provider.aliyun、
 * provider.config.account_id）。重构去掉 i18n 框架后，这些 key 一度被直接渲染到界面上
 * （E2E 走查发现下拉/表格显示 provider.virtual）。这里做一层「key → 中文」映射，
 * 未知 key 回退到「去掉前缀的可读文本」，保证不会把原始 key 露给用户。
 */

const PROVIDER_NAMES: Record<string, string> = {
  aliyun: '阿里云',
  aliyunesa: '阿里云 ESA',
  baidu: '百度云',
  bt: '宝塔',
  caihongdns: '彩虹 DNS 聚合',
  cloudflare: 'Cloudflare',
  dnshe: 'DNSHE',
  dnsla: 'DNS.LA',
  dnspod: '腾讯云 DNSPod',
  gcore: 'Gcore',
  hidns: 'HiDNS',
  hidns_v2: 'HiDNS v2',
  huawei: '华为云',
  huoshan: '火山引擎',
  jdcloud: '京东云',
  namesilo: 'NameSilo',
  powerdns: 'PowerDNS',
  qingcloud: '青云',
  rainyun: '雨云',
  spaceship: 'Spaceship',
  tencenteo: '腾讯 EdgeOne',
  virtual: '虚拟（测试）',
  vps8: 'VPS8',
  west: '西部数码',
  dnsneko: 'DNS Neko',
  dpdns_reverse: 'DigitalPlat 反向',
};

const CONFIG_LABELS: Record<string, string> = {
  'provider.config.account_id': 'Account ID',
  'provider.config.account_id_tunnels': 'Account ID（隧道）',
  'provider.config.api_token': 'API Token',
  'provider.config.api_key': 'API Key',
  'provider.config.api_secret': 'API Secret',
  'provider.config.email': '邮箱',
  'provider.config.global_api_key': 'Global API Key',
  'provider.config.secret_id': 'SecretId',
  'provider.config.secret_key': 'SecretKey',
  'provider.config.access_key_id': 'AccessKey ID',
  'provider.config.access_key_secret': 'AccessKey Secret',
  'provider.config.region': '区域',
  'provider.config.endpoint': '接口地址',
  'provider.config.virtual_enabled_on': '启用虚拟站点',
  'provider.config.password': '密码',
  'provider.config.username': '用户名',
  'provider.config.remark': '备注',
  // 部分提供商（虚拟/测试）后端只给裸键，这里同时登记
  'virtual_enabled': '启用虚拟站点',
  'virtual_tenant': '租户标识',
  'virtual_state': '状态存储',
  'virtual_seed': '初始数据',
  'virtual_state_dir': '状态目录',
  'virtual_enabled_on': '启用',
  'virtual_enabled_off': '停用',
  'virtual_state_file': '文件',
  'virtual_state_memory': '内存',
};

/** provider.aliyun / aliyun → 中文名；未知返回去掉前缀的可读文本 */
export function providerLabel(typeOrName: string | undefined | null): string {
  const raw = String(typeOrName ?? '').trim();
  if (!raw) return '';
  const key = raw.replace(/^provider\./, '');
  return PROVIDER_NAMES[key] ?? PROVIDER_NAMES[raw] ?? key.split('.').pop() ?? raw;
}

/** provider.config.xxx → 中文；已经是可读文本时原样返回 */
export function configFieldLabel(keyOrLabel: string | undefined | null): string {
  const raw = String(keyOrLabel ?? '').trim();
  if (!raw) return '';
  const direct = CONFIG_LABELS[raw];
  if (direct) return direct;
  // 后端偶尔直接给裸键（virtual_enabled_on），按 provider.config.<key> 再查一次
  const bare = CONFIG_LABELS['provider.config.' + raw];
  if (bare) return bare;
  if (!raw.startsWith('provider.')) return raw;
  return raw.replace(/^provider\.config\./, '');
}
