# 前端评审线 · C 端落地批次（fd855871..HEAD）

- 角色：前端架构审核（fe-arch-review）
- 范围：client/**（对照 server/src/routes/servicemonitor.ts、server/src/db/bal/business-adapter.ts、server/src/service/serviceMonitor.ts 的契约）
- 方式：只读代码；逐提交 git show + 全量 git diff fd855871..HEAD；未改源码、未提交
- 基线说明：评审时工作区另有 3 个未提交的服务端改动（server/src/routes/domains.ts、server/src/routes/servicemonitor.ts、server/src/service/websocket.ts 的校验收紧），不属于本批次；本报告结论已对照该工作区状态复核，client/** 无未提交改动

## 代码审核团评审

### 结论

改动方向正确（表单校验前移、错误就地展示、文案与空态统一、监控搜索与字段补齐），门禁与单测通过；但「编辑服务监控」这条路径引入了 1 个可复现的状态翻转回归，且同一个 payload 构造函数（service-monitor-tab.tsx:328-350）仍在丢 config 字段。合计 **P0 0 条 / P1 2 条 / P2 8 条**，建议修完 P1-1 再合入（P2 可进后续批次）。

### 发现（按严重度排序）

| # | 严重度 | file:line | 一句话 |
| --- | --- | --- | --- |
| 1 | **P1** | client/src/features/domains/service-monitor-tab.tsx:261,325 | 编辑任何监控都会把它强制改回启用：enabled 不在列表接口响应里，回填恒为 true |
| 2 | **P1** | client/src/features/domains/service-monitor-tab.tsx:328-350 | 保存时整份重建 config，丢掉 allowPrivate / line / check_chain / method / headers / body |
| 3 | P2 | client/src/ui/table.tsx:36 | TableCell 全局 whitespace-nowrap，全仓无一处 whitespace-normal 回退 |
| 4 | P2 | client/src/features/domains/service-monitor-tab.tsx:83-85 | 搜索无防抖：每敲一个字符换一次 queryKey，表格闪一次骨架屏 |
| 5 | P2 | client/src/features/workflows/workflows-page.tsx:133-139 | 列表把 assign（非 call）等合法表达式步骤显示成「未选择动作」 |
| 6 | P2 | client/src/lib/error-message.ts:24-29 | 先跑英文模式再判中文，含英文片段的中文错误被替换成通用文案 |
| 7 | P2 | client/src/features/domains/service-monitor-tab.tsx:310 | 校验口径与提交口径不一致：path 清空即报错，而 payload 本来会回落 '/' |
| 8 | P2 | client/src/features/domains/service-monitor-tab.tsx:277-280 | dns_failover 的 target 由 options 反查，查不到则目标为空且无法保存 |
| 9 | P2 | client/src/features/mcp/mcp-page.tsx:73,75,325,376 | 「新增/新建」统一漏了 MCP 页 4 处 |
| 10 | P2 | client/src/types/record-types.ts:230-231 | 同一校验器内 IPv6 改中文、IPv4/hostname 仍英文，弹窗混语言 |

### 逐条详情

#### 1 · P1 · 编辑监控会强制重新启用（本批次引入）

位置：client/src/features/domains/service-monitor-tab.tsx:261、:325

    261: const [enabled, setEnabled] = useState(row ? Boolean((row as { enabled?: boolean }).enabled ?? true) : true);
    325:   enabled,        // 创建与更新都会带上

证据链

1. MonitorRow（service-monitor-api.ts:5-19）根本没有 enabled 字段，所以第 261 行要靠 as 强转 —— 这是「字段不存在」的自证。
2. 服务端列表响应 toApiMonitor（server/src/routes/servicemonitor.ts:76-100）逐字段列举，没有 enabled；getMonitorsWithPagination 走的也是它。
3. 但 enabled 真实生效：检测任务只取 WHERE enabled = 1（server/src/db/bal/business-adapter.ts:3024），updateMonitor 也按它写库（server/src/service/serviceMonitor.ts:237）。
4. 本批次之前 payload 不含 enabled，服务端 if (data.enabled !== undefined) 不覆盖 → 编辑不动启用状态；本批次变成「永远送 true」。

影响：完全可在界面复现 —— 用编辑器把某个监控的「启用监控」关掉并保存（DB 里 enabled=0，任务停止探测）→ 下次为了改名字/端口再打开编辑器，开关显示为开（回填恒 true），保存后该监控被静默恢复探测。列表也没有启用/停用列，用户无法察觉。对被停用过的对外探测/内网目标而言，这是「关掉的探测自己又跑起来」。

建议修复（两侧一起改，任一侧单独改都不算修）

    // server/src/routes/servicemonitor.ts · toApiMonitor 里补一行
    enabled: monitor.enabled === 1 || monitor.enabled === true,

    // client · service-monitor-api.ts：MonitorRow 增加
    enabled?: boolean;

    // client · service-monitor-tab.tsx:261：去掉强转，未知时不猜测
    const [enabled, setEnabled] = useState(row ? (row.enabled ?? true) : true);
    // 并且只在「新建」或「确定知道原值」时提交，避免把 undefined 当 true/false 写库
    const payload: MonitorPayload = {
      /* ... */
      ...(mode === 'create' || row?.enabled !== undefined ? { enabled } : {}),
    };

列表补一个「状态」列（启用/停用 Badge），否则开关改了也看不出来。

#### 2 · P1 · 保存时整份重建 config，未暴露字段被抹掉

位置：client/src/features/domains/service-monitor-tab.tsx:328-350

证据链

1. 三种类型各自 payload.config = { ... } 从零构造：
   - ssl_certificate：{ port, warn_days_before } → 丢 allowPrivate、check_chain（server/src/service/serviceMonitor.ts:52-58 有这两个字段）
   - endpoint：{ protocol, port, path, followRedirects, expectedStatus, expectedBody } → 丢 allowPrivate、method、headers、body（serviceMonitor.ts:74-88）
   - dns_failover：丢 allowPrivate、line、proxyEnabled（serviceMonitor.ts:100-113）
2. 服务端是整体替换而不是合并：updates.config = JSON.stringify(data.config)（serviceMonitor.ts:234）。
3. 丢 allowPrivate 的后果是硬的：guardTarget(target, allowPrivate) 在 allowPrivate 缺失时对私网目标直接返回「目标不允许指向内网/保留地址」（serviceMonitor.ts:678-687）→ 管理员为内网目标开的监控，被任何人编辑一次名字后从「正常」变成「检测失败」。
4. 丢 line 的后果也是硬的：故障转移写记录时 line: config.line || 'default'（serviceMonitor.ts:657,662）→ 原本写在联通/电信等线路上的记录，编辑后改写到默认线路。

说明：这个「整体重建」的形状上一版本就存在；本批次在同一处 object literal 上新增了 5 个字段（checkMethod/checkPort/checkPath/expectedStatus/expectedBody）却仍未收口，属可一次修完的同一处缺口，不是历史已修项。

建议修复：以「原 config 打底 + 覆盖已知字段」代替重建。

    const baseConfig = (row?.config ?? {}) as Record<string, unknown>;
    // ssl
    payload.config = { ...baseConfig, port: Number(port) || 443, warn_days_before: Number(warnDays) || 30 };
    // endpoint
    payload.config = { ...baseConfig, protocol, port: Number(port) || 443, path: path || '/', followRedirects,
      expectedStatus: Number(expectedStatus) || 200, expectedBody: expectedBody.trim() || undefined };
    // dns_failover（backupValues 按换行符拆分，不在此展开）
    payload.config = { ...baseConfig, recordType, recordName, ttl: Number(recordTtl) || 600, primaryValue,
      backupValues: backupList, autoSwitchBack, checkMethod, checkPort: Number(checkPort) || 80,
      checkPath: checkMethod === 'http' ? (checkPath || '/') : undefined };

并在 __tests__/service-monitor-tab.test.tsx 加一条：mock 一个带 allowPrivate: true、line: 'unicom' 的 row，编辑保存后断言 update 收到的 config 仍含这两个键（把「不丢字段」钉成回归用例）。

#### 3 · P2 · TableCell 全局 nowrap

位置：client/src/ui/table.tsx:36

    <td className={cn('whitespace-nowrap px-3 py-2.5 align-middle', className)} {...props} />

影响：改前单元格默认 white-space: normal（折行），改后全站表格都按单行排；Table 外层是 overflow-x-auto（table.tsx:7），所以长内容从「折行变高」变成「表格横向滚动」。全仓在 features/ 下 grep whitespace-normal / break-words 为 0 命中，即没有任何回退；目前只有部分单元格自带 truncate（records-page.tsx:224、audit-page.tsx:148）与 max-w-*，其余（NS 监控的 expected_ns 逗号串 ns-monitor-tab.tsx:143、成员邮箱、监控错误文本）现在会被拉成一条长行。

建议修复：nowrap 只给表头，正文默认折行；需要单行的单元格自己加。

    export function TableCell({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
      return <td className={cn('px-3 py-2.5 align-middle', className)} {...props} />;
    }
    // 需要 nowrap 的列：<TableCell className="whitespace-nowrap">

若坚持全局 nowrap，请在 ns-monitor-tab.tsx:143 等长文本列显式加 whitespace-normal（或 truncate + title），否则窄屏下这些表必然横向滚动。

#### 4 · P2 · 搜索无防抖

位置：client/src/features/domains/service-monitor-tab.tsx:83-85（onChange 里直接 setKeyword，而 keyword 在 queryKey 里：service-monitor-tab.tsx:30）

影响：输入 example 会发 7 次请求；每个新 key 无缓存 → monitors.isLoading 为真 → 表格被骨架屏整块替换（service-monitor-tab.tsx:149-152），快速输入时列表持续闪烁；配合后端 LIKE %kw%（business-adapter.ts:3049）就是无索引扫描 × N。

建议修复：

    const [keywordInput, setKeywordInput] = useState('');
    const keyword = useDeferredValue(keywordInput.trim());   // 或 300ms debounce
    // Input.onChange: (e) => { setKeywordInput(e.target.value); setPage(1); }
    // 渲染时用 monitors.isFetching 做轻提示，不要用 isLoading 换骨架屏

#### 5 · P2 · 工作流列表把合法表达式步骤显示成「未选择动作」

位置：client/src/features/workflows/workflows-page.tsx:133-139

    const name = action.kind === 'call' ? String(action.action ?? '')
      : action.kind === 'assign' ? String((action.value as { action?: unknown } | undefined)?.action ?? '')
      : String(action.kind ?? '');
    const label = resolveActionLabel({ value: name, label: actionMetas.items.find((i) => i.value === name)?.label });
    return <Badge>{label || '未选择动作'}</Badge>;

证据：DSL 的 assign.value 允许任意表达式（server/src/workflow/expression/evaluator.ts:147-231：literal/ref/compare/arith/logic/concat/cond/assign/call），而 readActionRows 也写明「assign 里只认 call：其它表达式（arith/cond/concat）没法在表单里表达」（workflow-dsl.ts:60-68）。因此 assign x = concat(...) 这类完全合法的步骤，value.action 为 undefined → name 为空 → label 为空 → 渲染成「未选择动作」，与编辑器里「该步已配置但无法可视化」的状态相互矛盾。

建议修复：区分「未选动作」与「表达式步骤」。

    const isAssignExpr = action.kind === 'assign' && !(action.value as { action?: unknown })?.action;
    if (isAssignExpr) return <Badge key={index} variant="outline">表达式赋值</Badge>;

另：useTriggerMetas/useActionMetas（workflows-page.tsx:32-33）在列表页新增两次 meta 请求 —— 与编辑器同 key 会被 React Query 去重，属可接受开销；但建议给这两条 query 加 retry: false（use-workflow-meta.ts:108-116、124-132 现为默认 retry: 1），避免 meta 接口故障时列表页多打两次空请求。

#### 6 · P2 · humanizeError 会把中文错误里的细节吞掉

位置：client/src/lib/error-message.ts:24-29

    for (const [re, message] of PATTERNS) { if (re.test(text)) return message; }
    if (/中文字符区间正则/.test(text)) return text;   // 中文判断在映射之后

影响：模式匹配先于「已是中文」的分支，因此后端已经写好中文、但夹带英文片段的消息会被降级为通用文案并丢定位信息。实际会遇到的两类：

- 「无法连接上游：ECONNREFUSED 127.0.0.1:8443」→「连接被拒绝，目标端口可能未开放」（端口和目标消失）
- 「SSL 证书链不完整：unable to verify the first certificate」→「证书或 TLS 握手失败」（原因消失）

反之纯中文消息（目标不能包含空格、检测周期需在 30–86400 秒之间等本批次新增的后端校验文案）能正常透传，这点是好的。

建议修复：先判中文，再走映射；对「中文+英文混排」只做后缀补全而非整体替换。

    const hasCjk = /中文字符区间正则/.test(text);
    if (hasCjk) return text;                 // 后端已经给了人话，别再覆盖
    for (const [re, message] of PATTERNS) if (re.test(text)) return message;
    return '操作失败：' + text.slice(0, 120);

若担心英文错误太多，可保留映射但改为「中文 + 英文原文括注」，如：证书或 TLS 握手失败（SSL: unable to verify…）。

#### 7 · P2 · 校验口径严于提交口径

位置：client/src/features/domains/service-monitor-tab.tsx:310（校验）对照 :332（提交）

    310: if (!path.startsWith('/')) { setFormError('路径必须以 / 开头'); return; }
    332: path: path || '/',

影响：用户把「路径」清空（想用默认 /）→ 直接报错拦下，而同样的空值在 payload 里是被允许并预期回落成 '/' 的；checkPath 同理（312-313 行 vs 348 行 checkPath || '/'）。

同类「前端比服务端松」还有三处（保存时由服务端 400 兜底，用户在点击保存后才看到错误，而不是即时提示）：

- 检测周期：前端只校验 Number.isFinite（292 行），服务端现要求整数秒（工作区 server/src/routes/servicemonitor.ts:43）→ 填 300.5 前端放行、保存 400；
- checkPath：前端只校验 startsWith('/')，服务端还拒绝含空格与 @ 的路径（工作区 servicemonitor.ts:69 正则 [\s@]）；
- expectedBody：前端无长度上限，服务端限制 200 字符（工作区 servicemonitor.ts:76）→ 建议 Input 加 maxLength=200。

建议修复：空值放行、非空才校验。

    if (path && !path.startsWith('/')) { setFormError('路径必须以 / 开头'); return; }
    if (type === 'dns_failover' && checkMethod === 'http' && checkPath && !checkPath.startsWith('/')) { ... }

#### 8 · P2 · dns_failover 编辑态 target 依赖 options 反查

位置：client/src/features/domains/service-monitor-tab.tsx:277-280（只读「目标」框 :380-388 用同一结果）

    const effectiveTarget = type === 'dns_failover'
      ? (options.find((item) => String(item.id) === domainId)?.name ?? '')
      : target.trim();
    if (!effectiveTarget) { setFormError('请选择域名'); return; }

影响：options 来自 /servicemonitor/available-domains，服务端固定 pageSize: 1000 并对停用账号/域名做过滤（server/src/routes/servicemonitor.ts:204-219）。因此域名数 > 1000、或所属账号被停用、或该域名被停用且非 active 时，编辑一个已存在的故障转移监控会：目标框显示空 → 保存被「请选择域名」拦住 → 用户既改不了任何字段，也看不出为什么。首次打开弹窗时 options 尚在加载，同样会短暂显空。

建议修复：以行数据兜底，只在用户主动改选时用 options。

    const selectedName = options.find((i) => String(i.id) === domainId)?.name;
    const fallbackName = String(row?.domain_id ?? '') === domainId ? row?.target ?? '' : '';
    const effectiveTarget = type === 'dns_failover' ? (selectedName ?? fallbackName) : target.trim();

#### 9 · P2 · 「新增/新建」统一漏了 MCP 页

位置：client/src/features/mcp/mcp-page.tsx:73、75、325、376

本批次已把账户/记录/令牌/用户/团队/工作流/DNS 账户的「新建」统一成「新增」（accounts-page、records-page、tokens-page、users-page、teams-page、workflows-page、account-dialog、record-dialog、token-dialog 均在 diff 中），但 MCP 页仍是「新建 API 密钥」「新建 OAuth 客户端」×2（按钮 + 弹窗标题）。全仓 grep 新建 剩余 11 处，其中 4 处是这类 UI 文案（其余为代码注释与「新建一条解析记录」这类描述句，可保留）。

建议修复：4 处改「新增」，同步改 __tests__/mcp-page.test.tsx:69 的 /新建 API 密钥/ 匹配；改完 grep -rn 新建 client/src --include=*.tsx 应只剩注释与描述句。

#### 10 · P2 · 记录值校验器内混语言

位置：client/src/types/record-types.ts:230-231（本批次改中文）对照 :225、:227、:234、:237

    case 'ipv6': if (!v.includes(':')) return 'AAAA 记录必须是 IPv6 地址';
                 return isIpv6Literal(v) ? null : 'IPv6 地址格式不正确';
    case 'ipv4': ... return 'Invalid A record value: must be a valid IPv4 address';   // 仍英文
    case 'hostname': return isHostnameCheck(v) ? null : 'Invalid hostname value';      // 仍英文

影响：同一个「新增记录」弹窗里，填错 AAAA 出中文、填错 A 记录出英文。

建议修复：把 ipv4 / hostname / text / 'Value is required' 一并中文，或在无 i18n 框架前提下统一走 lib/error-message.ts 的口径（顺带处理发现 6）。注意 server/src/lib/dns/record-types.ts 同批次也改了（服务端文案），两边保持一致。

### 本批次复核后未发现问题的点（避免复审重复劳动）

1. workflow-dsl.ts 本批未改动：git log fd855871..HEAD -- client/src/features/workflows/workflow-dsl.ts 为空。复核现有实现：readArgs（workflow-dsl.ts:35-52）优先 asNode，ref/call 节点原样保留，只有字符串/数字/布尔走 literal 简写，不会破坏 ref 或表达式；writeActionNodes（:73-87）按行回写，未编辑的 ref 节点逐字保留，往返稳定。仅两点既有观察（非本批引入、不单列条目）：null 简写会被静默丢弃；字符串形态的数字不会按参数类型转 number。
2. 服务监控新增字段名与后端逐字对齐：checkMethod/checkPort/checkPath/expectedStatus/expectedBody 均被后端读取（serviceMonitor.ts:469、486、565、594），不是「发了个没人读的键」。
3. 搜索链路已真的接线：keyword 从 serviceMonitorApi.list → GET /servicemonitor?keyword= → getByUserWithPagination 的 name LIKE ? OR target LIKE ?（business-adapter.ts:3046-3053），count 与 list 两侧都加了条件，分页总数正确。
4. provider_type 不需要前端透传：服务端 /renewable-domains POST 在缺省时从账号推导（server/src/routes/domains.ts:1764-1773），前端不传不是缺陷。
5. monitorStatus 补 ok/warning 映射正确：后端 performCheck 返回 ok/warning/error，与 service-monitor-api.ts:71-79 新增分支一致。
6. ns-monitor-tab 用 last_check_at 判「未检测」正确：NsMonitorRow 确实暴露 enabled 与 last_check_at（ns-monitor-tab.tsx:151-158 的内联开关也证明该行有 enabled），与发现 1 的服务监控行不同。
7. realtime.tsx 重连补刷新：wasReconnect = retryRef.current > 0 只对「断线后重连」生效，首连不触发；invalidateQueries() 默认只刷活跃 query，不会把已卸载页面的缓存全部打一遍。
8. error-message.ts 的纯中文透传：后端本批次新增的中文校验文案（目标不能包含空格、检测周期需在 30–86400 秒之间等）不含英文模式，能原样透传（该文件唯一问题是发现 6 的匹配顺序）。
9. 表单错误移入弹窗：service-monitor-tab.tsx:377-381、ns-monitor-tab.tsx:277-281 用 role=alert 渲染在 DialogContent 内，修复了「错误被遮罩挡住」的原问题；onError prop 已从两个对话框签名中移除，无悬空调用。
10. TableEmpty 新图标：Inbox 带 aria-hidden（table.tsx:44），文案仍在 span 里，屏幕阅读器可读；icon 为可选 prop，旧调用点不受影响。


### 修复状态（执行层回填，提交 `436443f9`）

| 编号 | 状态 | 说明 |
| --- | --- | --- |
| P1 编辑监控强制 enabled=true | ✅ 已修 | 后端 toApiMonitor 返回 enabled；前端回填并随 payload 提交；实测关闭后保存仍为 false |
| P1 config 整份重建丢字段 | ✅ 已修 | 三类监控均改为 `{...row.config, ...已知字段}` |
| P2 TableCell 全局 nowrap | ⚠️ 部分修 | 保留 nowrap（防止 1024 逐字竖排），对 NS 期望 NS 列给 `whitespace-normal break-all`；其余长文本列仍可能横向滚动，后续按列处理 |
| P2 监控搜索无防抖 | ✅ 已修 | 300ms 防抖；实测输入 9 字符不再逐键发请求 |
| P2 MCP 页「新建」未统一 | ✅ 已修 | 改为「新增 API 密钥 / 新增 OAuth 客户端」 |

### 第二轮验收（修复后复核）

| 评审 | 判定 | 说明 |
| --- | --- | --- |
| be-constraint-review | ✅ 通过（P0=0/P1=0） | P0 越权链闭合；WS 上限/索引对称；续期归属 PASS；非 failover domain_id 记 P2 |
| fe-arch-review | ✅ 通过（P0=0/P1=0） | 4005 停止重连、enabled/config 回填、审计列宽、pt-phi-8、防抖、MCP 用词均 PASS |
| adversarial-auditor | ✅ 通过（P0=0/P1=0） | 两道式改类型/置空/字符串 id 均无法绕过；续期归属 PASS |
| design-critic | ✅ 通过（阻塞项 274f3780 后复核） | 实测 POST/PUT type=endpoint + domain_id=999 → 200 且回读 domain_id=null |

最终：**四位评审一致通过，可合入**。
