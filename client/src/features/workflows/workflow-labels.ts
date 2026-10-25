/**
 * 后端 meta 里的 label / description / hint 是 i18n 键（如 `workflow.param.domain`）。
 * 新栈已去掉多语言（见 docs/refactor/00-PLAN.md §3），所以这里把工作流用到的键收成中文表，
 * 而不是把 `workflow.action.dns_record_create` 这种机器键直接糊到界面上。
 *
 * 查不到就回落到机器名（动作名 / 参数键）：宁可显示 `dns.record.create`，
 * 也不能显示空的按钮——参数键恰恰是排查日志时要对上的东西。
 */

/** 文案表：键与后端声明一一对应，新增动作/参数时在这里补一条 */
const WORKFLOW_TEXT: Record<string, string> = {
  // ── 动作名称 ──
  'workflow.action.dns_record_list': '列出解析记录',
  'workflow.action.dns_record_get': '获取解析记录',
  'workflow.action.dns_record_create': '新增解析记录',
  'workflow.action.dns_record_update': '更新解析记录',
  'workflow.action.dns_record_delete': '删除解析记录',
  'workflow.action.dns_record_set_status': '启用或停用解析记录',
  'workflow.action.dns_record_batch': '批量解析记录操作',
  'workflow.action.dns_domain_list': '列出域名',
  'workflow.action.http_outbound_fetch': '发起 HTTP 请求',
  'workflow.action.notify_channel_send': '发送通知',
  'workflow.action.var_workflow_get': '读取工作流变量',
  'workflow.action.tencenteo_origin_group_list': '列出 EdgeOne 源站组',
  'workflow.action.tencenteo_origin_group_get': '获取 EdgeOne 源站组',
  'workflow.action.tencenteo_origin_group_plan': '预览源站组更新',
  'workflow.action.tencenteo_origin_group_replace': '更新源站组源站（整组替换）',
  'workflow.action.virtual_origin_group_list': '列出虚拟源站组',
  'workflow.action.virtual_origin_group_get': '获取虚拟源站组',
  'workflow.action.virtual_origin_group_plan_sync': '预览源站地址同步',
  'workflow.action.virtual_origin_group_sync': '同步源站组地址',

  // ── 动作说明（一句话） ──
  'workflow.actionDesc.dns_record_list': '列出指定域名下的解析记录',
  'workflow.actionDesc.dns_record_get': '按记录 ID 读取单条解析记录',
  'workflow.actionDesc.dns_record_create': '新建一条解析记录',
  'workflow.actionDesc.dns_record_update': '修改一条解析记录的值',
  'workflow.actionDesc.dns_record_delete': '删除一条解析记录（不可撤销）',
  'workflow.actionDesc.dns_record_set_status': '启用或暂停一条解析记录',
  'workflow.actionDesc.dns_record_batch': '批量写入多条解析记录（不可撤销）',
  'workflow.actionDesc.dns_domain_list': '列出当前账号可见的域名',
  'workflow.actionDesc.http_outbound_fetch': '发起一次受白名单约束的 HTTPS 请求',
  'workflow.actionDesc.notify_channel_send': '通过已配置的通知渠道发送消息',
  'workflow.actionDesc.var_workflow_get': '读取工作流变量',
  'workflow.actionDesc.tencenteo_origin_group_list': '列出 EdgeOne 站点下的源站组',
  'workflow.actionDesc.tencenteo_origin_group_get': '读取单个源站组的详情',
  'workflow.actionDesc.tencenteo_origin_group_plan': '只计算差异、不写上游（预演），会告诉你哪些源站会被移除',
  'workflow.actionDesc.tencenteo_origin_group_replace': '把源站组里的源站整组替换为该值（会写上游、不可撤销）',
  'workflow.actionDesc.virtual_origin_group_list': '列出虚拟源站组',
  'workflow.actionDesc.virtual_origin_group_get': '读取单个虚拟源站组',
  'workflow.actionDesc.virtual_origin_group_plan_sync': '计算源站地址同步差异（预演）',
  'workflow.actionDesc.virtual_origin_group_sync': '把源站地址同步到虚拟源站组（会写上游）',

  // ── 参数名称 ──
  // ── EdgeOne / 虚拟源站组相关参数（服务端 ext.* 动作在用）──
  'workflow.param.record_types': '记录类型',
  'workflow.param.statuses': 'NS 状态',
  'workflow.param.within_days': '剩余天数阈值',
  'workflow.hint.record_types': '只监听 A / AAAA（其余类型不产生事件）；不勾选等于两者都要',
  'workflow.hint.statuses': '不勾选等于「只报状态不是 ok 的变化」',
  'workflow.hint.within_days': '域名到期前多少天触发，按天比较，同一天只触发一次',
  'workflow.param.domain_id': '域名',
  'workflow.param.domain_name': '域名',
  'workflow.param.group_ids': '源站组 ID 列表',
  'workflow.param.ipv4': 'IPv4 源站地址',
  'workflow.param.ipv6': 'IPv6 源站地址',
  'workflow.param.ipv4_from': 'IPv4 来源',
  'workflow.param.ipv6_from': 'IPv6 来源',
  'workflow.param.add_if_missing': '缺失时自动添加',
  'workflow.param.allow_multiple': '允许存在多个源站组',
  'workflow.param.on_partial': '部分失败时的处理方式',
  'workflow.param.domain': '域名',
  'workflow.param.name': '主机记录',
  'workflow.param.type': '记录类型',
  'workflow.param.value': '记录值',
  'workflow.param.ttl': '生存时间（TTL）',
  'workflow.param.record_id': '记录 ID',
  'workflow.param.records': '记录数组',
  'workflow.param.status': '状态',
  'workflow.param.url': '请求地址',
  'workflow.param.method': '请求方法',
  'workflow.param.title': '标题',
  'workflow.param.message': '消息内容',
  'workflow.param.key': '变量名',
  'workflow.param.target': '目标源站',
  'workflow.param.account_id': '账号',
  'workflow.param.scope_id': '站点（作用域）',
  'workflow.param.group_id': '源站组 ID',
  'workflow.param.diff_digest': '差异摘要',
  'workflow.param.site_type': 'EdgeOne 站点类型',
  'workflow.param.collapse': '确认整组替换',
  'workflow.param.acknowledge_referenced': '允许覆盖仍被引用的源站组',
  'workflow.param.acknowledge_data_loss': '允许丢弃不可恢复的私有参数',

  // ── 参数补充说明 ──
  'workflow.paramHint.record_id': '选定域名后，这里会列出该域名下的解析记录，直接选即可。',
  'workflow.paramHint.diff_digest': '可选。做过「预览源站组更新」时填该步骤的结果变量，可防止预览与执行之间的配置漂移。',
  'workflow.paramHint.target': '目标源站的完整声明，按源站组要求的格式填写。',
  'workflow.paramHint.collapse': '必选。源站组的写入是整组覆盖（只会减少条数），不勾选时动作不会执行。',
  'workflow.paramHint.acknowledge_referenced': '源站组仍被域名引用时，整组覆盖会立刻改变这些域名的回源行为。',
  'workflow.paramHint.acknowledge_data_loss': '被移除的源站若带对象存储私有参数，删除后无法重建。',

  // ── 触发器与配置字段 ──
  'workflow.trigger.record_changed': '解析记录变更',
  'workflow.trigger.domain_changed': '域名信息变更',
  'workflow.trigger.ns_changed': 'NS 状态变更',
  'workflow.trigger.whois_expiring': '域名即将到期',
  'workflow.field.remark': '备注',
  'workflow.field.is_hidden': '隐藏',
  'workflow.field.enabled': '启用',
  'workflow.ns.ok': '正常',
  'workflow.ns.mismatch': '不匹配',
  'workflow.ns.missing': '缺失',
  'workflow.ns.poisoned': '被污染',
};

/** 形如 `workflow.param.domain` 的键：没有空格、只有标识符字符、带点 */
function looksLikeKey(text: string): boolean {
  return !text.includes(' ') && /^[A-Za-z][\w-]*(\.[\w-]+)+$/.test(text);
}

function display(raw: string | undefined, fallback: string): string {
  const key = raw?.trim();
  if (!key) return fallback;
  const hit = WORKFLOW_TEXT[key];
  if (hit) return hit;
  // 没登记的键：像键就退回机器名，像人话就原样显示
  return looksLikeKey(key) ? fallback : key;
}

export function resolveActionLabel(meta: { value: string; label?: string }): string {
  return display(meta.label, meta.value);
}

export function resolveActionDescription(meta: { description?: string }): string {
  return display(meta.description, '');
}

export function resolveParamLabel(param: { key: string; label?: string }): string {
  return display(param.label, param.key);
}

export function resolveParamHint(hint: string | undefined): string {
  return display(hint, '');
}

export function resolveTriggerLabel(item: { value: string; label?: string }): string {
  return display(item.label, item.value);
}
