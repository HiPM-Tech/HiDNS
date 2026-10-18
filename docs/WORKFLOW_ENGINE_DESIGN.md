# HiDNS 自动化工作流引擎设计方案

> 状态：**设计稿（未实现）**
> 版本：v1
> 日期：2026-10-13
> 依据：`root.ai.md`（911 行）、`docs/api.md`（第一权威）
> 约束：本文档只描述设计与规划，**不包含任何实现代码**。示例中的域名为演示占位符。

---

## 一、设计目标与非目标

### 1.1 目标

用**表达式**描述"当什么发生 → 条件 → 做什么"，把 DNS 变更、监控事件、定时器变成可编排的自动化能力，且：

- 能力来自 **HiDNS 托管的宿主 API**，用户不写基础设施代码；
- 脚本运行在**受限沙箱**内，**无文件权限、无模块导入权限**；
- **鉴权与实际出站访问全部由 HiDNS 代理**，脚本拿不到任何凭据。

### 1.2 非目标（明确不做）

| 不做 | 原因 |
|---|---|
| 允许脚本 `require` / `import` 任意模块 | 直接突破沙箱，等于 RCE |
| 允许脚本读写文件、访问 `process`、原生网络 | 同上 |
| 让脚本持有 DNS 厂商密钥或 API Token 明文 | 凭据只存在于宿主进程内存，脚本只见"能力句柄" |
| 在脚本里直接拼 SQL | 违反 `root.ai.md` §数据库 2，一律走 BAL 操作函数 |
| 图灵完备的通用编程语言 | 表达式 + 受限脚本已覆盖自动化场景，避免维护完整语言 |

---

## 二、整体架构

```
┌──────────────────────────────────────────────────────────────┐
│                        事件源（宿主侧）                        │
│  记录变更 · 域名变更 · NS 监控 · WHOIS 到期 · 定时器 · 手动     │
└───────────────────────────┬──────────────────────────────────┘
                            │ 内部事件（强类型）
                            ▼
┌──────────────────────────────────────────────────────────────┐
│                  WorkflowEngine（单例服务）                    │
│  过滤订阅 → 求值条件 → 顺序执行动作 → 记录运行结果 → 审计       │
└───────┬──────────────────────────────────┬───────────────────┘
        │                                  │
        ▼                                  ▼
┌───────────────────┐            ┌──────────────────────────┐
│ ExpressionEvaluator│            │   ScriptSandbox（vm）     │
│ 字段/函数/变量求值  │            │  无文件·无导入·无网络     │
└───────────────────┘            └────────┬─────────────────┘
                                          │ 只能调用宿主注入的能力
                                          ▼
┌──────────────────────────────────────────────────────────────┐
│                     CapabilityBroker（能力代理）               │
│  dns.read · dns.write · http.fetch · notify.send · workflow.* │
│  ── 负责：鉴权裁决 · 凭据注入 · 出站代理 · 限流 · 审计          │
└───────────────────────────┬──────────────────────────────────┘
                            ▼
     DnsProviderService / fetchWithFallback / notification / BAL
```

### 2.1 分层与项目既有规范的对齐

| 本项目约束（`root.ai.md`） | 本设计如何遵守 |
|---|---|
| §数据库 2：所有 DB 操作经 BAL | 持久化全部经新增的 `WorkflowOperations`（BAL 层），路由与引擎**不触碰** `db/dal`、`db/dl` |
| §服务层 376：禁止路由直接操作数据库 | 路由只做参数校验与转发，逻辑在 `service/workflow/` |
| §日志相关：`createLogger` + 子模块 + 限流 | 引擎统一 `createLogger('Workflow')`，同源日志限流（见 §3.6） |
| §DNS提供商适配器 272：必须经 `fetchWithFallback` | `http.fetch` 能力内部固定走 `fetchWithFallback`，脚本无法绕过 |
| §安全规范：细粒度权限 | 复用 `AVAILABLE_SERVICES` 与 `TokenPayload`（见 §5） |
| §提交相关 3：根目录不放 MD | 本文档位于 `docs/` |
| §外部集成 768：`docs/api.md` 是第一权威 | 新增端点必须同步 `docs/api.md`（见 §9 交付清单） |

---

## 三、表达式模型

### 3.1 三种书写形式（对应需求中的三类标记）

需求约定：

| 标记 | 语义 | 前端控件 |
|---|---|---|
| `[...]` | 输入框 / 下拉列表，**提供下拉时可下拉也可自由输入** | `AutoComplete` |
| `{...}` | **仅下拉**，候选由宿主提供，不可自由输入 | `Select` |
| `(...)` | **实时渲染的预览**，只读，随上下文变化 | 只读文本 / `Tag` |

示例（项目规划示例，仅作参考）：

```
当 域名 [xxx.com] 发生变动
  设置 {腾讯Edgeone} 使用 {鉴权账号} 对 {源站组} ["下拉列表"] 更新值
  为 域名(xxx.com) 的新解析值
```

> 注意：上述示例中的 `{鉴权账号}` 在**脚本与表达式层不应出现**。见 §5.4——脚本永远拿不到凭据，该占位符在 UI 层是"以哪个身份执行"的选择器，运行时由宿主持有。

### 3.2 表达式语法（面向前端结构化编辑，非自由文本）

为避免解析歧义与注入，**存储为结构化 JSON**，UI 负责渲染成上面的自然语言。语法树：

```json
{
  "type": "call",
  "fn": "dns.updateRecord",
  "args": {
    "domain": { "type": "field", "expr": { "type": "ref", "path": "event.domain.name" } },
    "provider": { "type": "option", "source": "providers" },
    "target": { "type": "interpolate", "parts": ["", { "type": "ref", "path": "event.record.value" }] }
  }
}
```

#### 节点类型

| type | 说明 | 对应标记 |
|---|---|---|
| `literal` | 字面量（string/number/bool/null） | — |
| `ref` | 上下文引用，如 `event.record.value` | `(...)` 预览 |
| `option` | 宿主提供的候选值；`source` 指定数据源 | `{...}` 或 `[...]` |
| `interpolate` | 模板插值 `"prefix-{ref}"` | `[...]` 可输入 |
| `call` | 函数调用（仅白名单函数） | — |
| `binop` | `==` `!=` `>` `<` `&&` `\|\|` 等 | — |
| `func` | 纯函数（`len`、`lower`、`ip4`、`json.path` 等） | — |

#### 上下文命名空间（只读，由引擎注入）

| 命名空间 | 内容 |
|---|---|
| `event` | 触发事件（类型 + 载荷，见 §4.2） |
| `trigger` | 触发源元信息（`at`、`manual`、`test`） |
| `vars` | 工作流级变量（可在动作中赋值） |
| `run` | 本次运行信息（`id`、`attempt`、`startedAt`） |

### 3.3 候选值来源（`option.source`）

`{...}` 的候选必须由宿主实时提供，前端下拉不可硬编码。建议注册表：

| source | 返回 | 依赖 |
|---|---|---|
| `providers` | 已注册的 DNS 厂商类型 | `registry.ts` |
| `accounts` | 当前用户可见的 DNS 账号 | `DnsAccountOperations` |
| `domains` | 可见域名 | `DomainOperations` |
| `records` | 指定域名的记录（**依赖上游选择，形成级联**） | `DnsProviderService.getRecords` |
| `recordTypes` | 厂商支持的记录类型 | `registry` 的 `capabilities.recordTypes` |
| `lines` | 线路 | `DnsProviderService.getLines` |
| **`originGroups`** | **EdgeOne 源站组**（边缘加速回源配置，见 §3.7） | **EdgeOne 适配器新增能力** |
| **`originServers`** | 指定源站组下的回源地址与权重（级联依赖 `originGroupId`） | 同上 |
| `workflows` | ~~其他工作流（用于串联）~~ | **v1 不提供**（禁止工作流调用工作流，见 §7.5） |

> **级联候选**：`records`、`lines`、`originServers` 依赖前一字段。前端按依赖顺序串行获取，未就绪时显示禁用态。这直接支撑"联动"体验。

### 3.7 「源站组」能力（EdgeOne 边缘加速，附加组件）

> **重要界定（据此纠正前一版设计的错误）**：EdgeOne 的**源站组不是域名解析记录**，而是**边缘加速（TEO）侧的源站配置**——用于指定加速回源地址，并支持**回源地址的权重分配**。它与 DNS 记录是两个不同的资源域。

#### 3.7.1 现状（已核实）

- `server/src/lib/dns/providers/tencenteo/adapter.ts` **当前只有 DNS 记录 CRUD**（`getDomainList` / `getDomainRecords` / `addDomainRecord` / `updateDomainRecord` / `deleteDomainRecord` / `setDomainRecordStatus` / `getRecordLines` / `getMinTTL` / `addDomain`）。
- 已使用的 API action 仅三个：`DescribeZones` / `DescribeDnsRecords` / `CreateDnsRecord`。
- **源站组方法一个都没有**，`capabilities` 中也无对应字段。
- 因此「源站组」是**净新增能力**。

#### 3.7.2 鉴权可复用（已核实）

`TencenteoAdapter` 继承 `TencentCloudAdapter`（TC3-HMAC-SHA256 基类），DNSPod 同源同鉴权：

| 项 | 值 |
|---|---|
| 凭据 | `SecretId` / `SecretKey`（腾讯云） |
| 签名 | TC3-HMAC-SHA256，由 `TencentCloudAdapter.call()` 统一处理 |
| `service()` | `teo` |
| `endpoint()` | `teo.intl.tencentcloudapi.com`（`site_type=intl`）或 `teo.tencentcloudapi.com` |
| `version()` | `2022-09-01` |

**结论**：源站组**复用同一 `teo` 服务的同一套腾讯云鉴权**，无需新增凭据类型；`dns_accounts.config` 结构不变。

> 这印证了需求的表述：**本质上它是附加组件**——鉴权套用 DNSPod/EdgeOne，但资源域独立于 DNS 解析。

#### 3.7.3 真实 API 契约（已按腾讯云官方文档核对）

> 以下 action 名、参数、字段均来自官方文档，非推测。

| 能力 | Action | 入参要点 | 出参 |
|---|---|---|---|
| 列表 | `DescribeOriginGroup` | `ZoneId`（必填）、`Offset`、`Limit`（1–1000，默认 20）、`Filters`（`origin-group-id` 精确 / `origin-group-name` 模糊） | `TotalCount`、`OriginGroups[]` |
| 创建 | `CreateOriginGroup` | `ZoneId`、`Records.N`（必填）、`Name`、`Type`（必填）、`HostHeader`（仅 `Type=HTTP`） | `OriginGroupId` |
| **修改** | `ModifyOriginGroup` | `ZoneId`、`GroupId`（必填）、`Name`、`Type`、**`Records.N`**、`HostHeader` | `RequestId` |
| 删除 | `DeleteOriginGroup` | `ZoneId`、`GroupId` | `RequestId` |

公共参数：`Version=2022-09-01`，域名 `teo.tencentcloudapi.com`，**默认频率限制 20 次/秒**。

**`OriginGroup` 结构**

| 字段 | 说明 |
|---|---|
| `GroupId` | 源站组 ID，形如 `origin-xxxx` |
| `Name` | 名称（1–200 字符，`a-zA-Z0-9_-`） |
| `Type` | `GENERAL`（通用型，可被域名服务/规则引擎/四层代理/通用型 LB 引用）或 `HTTP`（HTTP 专用型，含对象存储源站，不可被四层代理引用） |
| `Records[]` | `OriginRecord` 列表 |
| `HostHeader` | 回源 Host（仅 `Type=HTTP`） |
| `References[]` | **被谁引用**（加速域名 / 四层代理 / 负载均衡） |
| `CreateTime` / `UpdateTime` | 时间戳 |

**`OriginRecord` 结构**

| 字段 | 说明 |
|---|---|
| `RecordId` | 记录 ID（形如 `record-xxxx`） |
| `Record` | 源站地址（IP 或域名） |
| `Type` | `IP_DOMAIN` 或 `AWS_S3`（对象存储） |
| `Weight` | **权重，取值 0–100**（官方错误码 `InvalidParameter.OriginRecordWeightValue` 明确） |
| `Private` / `PrivateParameters` | 第三方对象存储私有访问参数 |

> **重要**：官方描述明确「此处配置的源站组可于**添加加速域名**和**四层代理**等功能中引用」。这直接印证 §3.7 的界定——源站组服务于**边缘加速回源**，不是 DNS 解析记录。

#### 3.7.4 能力接口（按真实契约）

源站组**不挂在 `DnsAdapter` 上**，是独立的附加能力接口，由支持它的适配器额外实现：

```ts
// 独立能力接口，支持者实现，其余不做
interface OriginGroupCapability {
  listOriginGroups(zoneId: string, opts?: { offset?: number; limit?: number }): Promise<OriginGroup[]>;
  getOriginGroup(zoneId: string, groupId: string): Promise<OriginGroup | null>;
  // 整组覆盖写（对应 ModifyOriginGroup 语义，见 §3.7.5）
  replaceOriginRecords(zoneId: string, groupId: string, records: OriginRecord[]): Promise<void>;
}

// 与官方 OriginGroup / OriginRecord 一一对应
interface OriginGroup {
  groupId: string;
  name: string;
  type: 'GENERAL' | 'HTTP';
  hostHeader?: string;
  records: OriginRecord[];
  references: Array<{ type: string; id: string; name?: string }>;
  createTime?: string;
  updateTime?: string;
}

interface OriginRecord {
  recordId?: string;
  record: string;                 // 回源地址：IP 或域名
  type: 'IP_DOMAIN' | 'AWS_S3';
  weight?: number;                // 0–100
}
```

#### 3.7.5 **关键风险：`ModifyOriginGroup` 是全量覆盖**

官方原文：「修改源站组配置，**新提交的源站记录将会覆盖原有源站组中的源站记录**。」

这意味着**没有"只改某一条源站"的接口**。而工作流的典型意图恰恰是"把**某一个**源站的地址改为域名的新解析值"。因此必须做 **read-modify-write**，并承担三个后果：

| 风险 | 说明 | 缓解 |
|---|---|---|
| **丢失更新** | 两个工作流并发改同一源站组，后写者用旧快照覆盖前者 | 按 `groupId` 串行化（进程内锁 + 任务队列同 ID 去重）；写入前**重读**，仅当基线未变才提交，否则重试 |
| **误删源站** | 若调用方只提交"自己关心的那一条"，其余源站会被清空 | **强制**：提交前校验 `records.length` 与读取时一致，且未在本次意图内的记录原样保留 |
| **权重被清空** | 覆盖时不带 `Weight` 可能重置权重（官方示例 2 即未带 Weight） | 保留式回写：未修改的记录**原样回传**（含 `Weight`、`Private`、`PrivateParameters`） |

**动作语义必须在能力层体现，而不是交给脚本自己拼**：

```ts
// 推荐：提供"改单条"的动作，内部完成 read-modify-write
origin.updateRecord({
  accountId, zoneId, groupId,
  match: { recordId?: string; record?: string },  // 定位目标源站
  set: { record?: string; weight?: number }        // 只改这些
})
```

> 若脚本直接调用 `replaceOriginRecords`，属于**高危动作**，需额外权限或直接不暴露给脚本。

**其他必须处理的 API 行为**

| 情况 | 处理 |
|---|---|
| `OperationDenied.AccelerationDomainStatusNotInOnline` | 引用该组加速域名部署中 → **可重试**（退避），不可当永久失败 |
| `OperationDenied.L4StatusNotInOnline` / `LoadBalanceStatusNotInOnline` | 绑定资源非运行中 → 重试或明确报错 |
| `InvalidParameter.InvalidOriginIp` | 服务端拒绝内网 IP/回环地址 —— 与 §5.5 的内网拦截**方向一致**，前端应提前校验 |
| 频率限制 20 次/秒 | 能力层统一节流，避免工作流批量触发打满 |

#### 3.7.6 能力声明（registry 扩展）

`DnsCapabilities` 增加字段，声明式告知前端某厂商是否支持源站组：

```ts
interface DnsCapabilities {
  // ...既有字段
  originGroup: boolean;
}
```

| 厂商 | `originGroup` | 说明 |
|---|---|---|
| `tencenteo` | `true` | 本次新增 |
| `dnspod` | **`false`** | DNSPod 是纯解析，**没有**边缘加速源站组；仅鉴权体系相同 |
| 其余 | `false` | — |

> 用户所述"鉴权套用 dnspod 和 edgeone"指**凭据体系相同**（均为腾讯云 `SecretId/SecretKey` + TC3），而非 DNSPod 也具备源站组能力。

#### 3.7.7 动作、权限与触发约束

| 动作 | `ActionClass` | 所需服务权限 | 说明 |
|---|---|---|---|
| `origin.listGroups` | `origin.read` | `records.read` | 只读 |
| `origin.getGroup` | `origin.read` | `records.read` | 只读 |
| `origin.updateRecord` | **`origin.write`** | `records.write` | 改单条源站（内部 read-modify-write） |
| `origin.replaceRecords` | **`origin.write`** | `records.write` | 整组覆盖（**不暴露给脚本**，仅高级用户） |

**触发约束**：`origin.write` 与 `dns.record.write` 同属「回源/解析目标变更」，因此**同样禁止由 `domain.changed` 触发**（§4.0 理由完全适用）。

> `origin.read` 不受 §4.0 约束——按已确认的 D6，**只读动作不设触发源限制**。

#### 3.7.8 候选值级联

| 候选源 | 参数 | 依赖 |
|---|---|---|
| `originGroups` | `accountId`、`zoneId` | 需先选账号（且 `originGroup: true`）与站点 |
| `originServers` | `accountId`、`zoneId`、`originGroupId` | 级联依赖 |

前端在账号不支持源站组时**隐藏整条源站组动作**，而不是显示后报错。

> `zoneId` 的来源：EdgeOne 的源站组挂在**站点（Zone）**下，因此 UI 需先选站点。这与 DNS 记录"先选域名"的层级不同，属于 §3.7 附加组件的独立选择链。



### 3.4 求值与安全

- **纯函数无副作用**；所有副作用只能经 `call` 触发，而 `call` 走能力代理。
- 表达式求值**深度与节点数上限**（建议 64 层 / 2000 节点），防爆栈。
- `option` 提交时**必须校验值仍在候选集合内**（或该字段允许自由输入），防伪造——与 `root.ai.md` §外部集成 803"分页安全限制"同类思路。

### 3.5 校验时机

| 阶段 | 校验 |
|---|---|
| 编辑时 | 语法正确、引用路径存在、候选源可解析 |
| 保存时 | 需要的能力是否被当前用户/令牌拥有 |
| 加载时 | 能力是否存在（插件式能力可被禁用） |
| 运行时 | 实时鉴权 + 参数校验 + 配额 |

### 3.6 日志与可观测

- 引擎日志统一 `createLogger('Workflow').sub('Engine' | 'Sandbox' | 'Broker')`。
- **同一工作流的失败日志必须限流**（遵守 §日志相关 9），避免重试风暴刷屏。
- 每次运行产出 `WorkflowRun` 记录：状态、耗时、每个动作的输入摘要（脱敏）、错误。

---

## 四、触发器（Trigger）

### 4.0 硬性约束：域名变动不得触发记录写入（**禁止项**）

> **「域名变动」类触发器（`domain.changed`）禁止作为任何记录写动作（`dns.createRecord` / `dns.updateRecord` / `dns.deleteRecord` / `dns.setRecordStatus` / `dns.batchRecords`）的触发源。**

理由（三条，缺一不可）：

1. **语义不成立**：`root.ai.md` §外部集成 811-833 的 DDNS 语义是「客户端上报 IP → 更新解析记录」，触发源是**记录值变化**（`record.changed`），不是域名元信息变化。域名变动（`domain_updated`，见 `routes/domains.ts` 仅覆盖 `remark` / `is_hidden` / `enabled`）与解析值无关，拿它触发记录写入纯属滥用。
2. **必然自激**：记录写入会再次产生 `record.*` 事件；若经由域名变动回到记录写入，形成 `domain → record → domain` 闭环，只能靠深度限制兜底，属于设计缺陷而非保护。
3. **绕过更新链路**：检测记录同一性依赖 `domain.third_id`。`domain_sync_job` 会重写 `third_id`（上游域名 ID 可能变化），若域名变动触发记录写入，会在 `third_id` 已变、记录尚未重新枚举的窗口内，把修改写到**错误的记录**上，造成静默数据损坏。

### 4.0.1 运行时强制（不只是文档约定）

| 层 | 措施 |
|---|---|
| 保存校验 | 若 `trigger.type ∈ {domain.changed, domain.created, domain.deleted, domain.renewed}` 且动作含任何**写能力**（`dns.record.write` 或 `origin.write`）→ **拒绝保存**，返回 422 并说明原因 |
| 执行前裁决 | `CapabilityBroker` 在每次记录写动作前校验 `(triggerType, action)` 组合，命中即拒绝（防绕过校验直接改库） |
| 前端 | 选择「域名变动」触发器后，动作面板**隐藏**记录写动作；选择记录写动作时，触发器下拉中禁用域名变动类 |
| 审计 | 若被拒，记录 `workflow.violation` 审计事件并告警 |

**允许的替代路径**（这是用户真正想表达的意图）：

| 意图 | 正确做法 |
|---|---|
| IP 变了要更新解析 | 用 `record.changed` 触发 `dns.updateRecord`；或由外部 DDNS 客户端经 API 上报后触发
| 域名同步后要校验记录 | 用 `domain.changed` 触发**只读**能力（`dns.listRecords`），仅做检查/告警，**不改写** |
| 需要"跨厂商同步解析" | 用 `record.changed` 触发 `dns.updateRecord` 到另一个账号/域名 |

> 换言之：**只读能力完全不受此约束**（本轮已确认）。`domain.changed` 可以触发 `dns.listRecords`、`origin.listGroups`、`notify.send`、`http.fetch`、`workflow.vars` 等；被禁的只有**写动作**（`dns.record.write` 与 `origin.write`）。

### 4.1 触发器类型

> **本版本不设计定时器（`schedule`）。** 工作流只能由真实事件或手动触发，**不存在 cron / 周期调度**。

| 类型 | 说明 | 来源 | 可触发的记录写动作 |
|---|---|---|---|
| `record.changed` | 记录创建/更新/删除/启停 | 现有 `record_*` WS 事件 | ✅ 允许 |
| `domain.changed` | 域名新增/更新/删除/续费 | 现有 `domain_*` 事件 | ❌ **禁止**（见 §4.0） |
| `ns.changed` | NS 监控状态变化 | `ns_monitor_*` | ✅ 允许 |
| `whois.expiring` | WHOIS 到期临近 | WHOIS 调度器 | ✅ 允许 |
| `manual` | 手动/API 触发 | 新增端点 | ✅ 允许 |
| ~~`schedule`~~ | ~~定时（cron 子集）~~ | **不设计** | — |

> 注：`whois.expiring` 的检测本身由既有 WHOIS 调度器驱动，这属于**事件源的自然产生**，不是工作流侧的定时器；工作流不持有任何计时器。

### 4.2 事件载荷规范

```ts
interface WorkflowEvent {
  type: 'record.updated';
  domain: { id: number; name: string; accountId: number };
  record?: { id: string; name: string; type: string; value: string; oldValue?: string; ttl: number };
  actor?: { userId?: number; source: 'ui' | 'api' | 'token' | 'workflow' };
  at: string; // ISO8601
}
```

- **`oldValue` 必填**（更新类事件），否则无法表达"发生变动"的语义。
- `actor.source` 用于**防循环**（见 §7.2）。
- 记录事件必须携带 `domain.third_id` 的**快照值**，供幂等校验使用（避免 §4.0 理由 3 的错写）。

### 4.3 现状缺口（必须先补）

当前记录变更**只在路由内联广播 WS**（`routes/records.ts` 的 `record_created` / `record_updated` / `record_deleted`），没有统一事件出口。设计上需要：

1. 抽出 **`WorkflowEventBus`**（进程内发布/订阅）；
2. 路由在写入成功后 `publish(event)`，WS 广播改为总线的订阅者之一，**避免双写**；
3. 脚本产生的写入**同样发布事件**（但标记 `actor.source='workflow'`）；
4. 域名变动事件必须携带 `changedFields`（如 `['remark']`），以便引擎在保存/执行期判断是否涉及解析语义。


---

## 五、鉴权复用设计（重点）

### 5.1 复用现有三件套，不新造体系

| 既有组件 | 位置 | 复用方式 |
|---|---|---|
| `authMiddleware` | `middleware/auth.ts` | 管理端 HTTP 入口 |
| `requireServicePermission(service)` | 同上 | 动作执行前的服务级裁决 |
| `requireDomainPermission(getDomainId)` | 同上 | 动作执行前的域名级裁决 |
| `requireJwtAuth` / `noTokenAuth` | 同上 | 工作流管理端点禁止 API Token 访问 |
| `AVAILABLE_SERVICES` | `types/token.ts` | 新增 `workflow.read` / `workflow.write` / `workflow.run` |

### 5.2 执行身份（Principal）

工作流**不以"系统"身份运行**，而以**创建者身份**运行，且受创建者权限约束：

```ts
interface WorkflowPrincipal {
  userId: number;
  maxRole: number;              // 创建者当前角色上限
  allowedServices: string[];    // 触发者的服务权限（API Token 触发时为其权限）
  allowedDomains: number[];     // 触发者的域名权限，空=全部（沿用 token 语义）
  source: 'ui' | 'token' | 'manual';
}
```

**关键规则**：

1. 工作流保存时记录 `owner_user_id`；
2. 执行时构造 Principal，**取 `min(ownerRole, ownerRoleNow)`**——创建者被降权后，其工作流也随之降权；
3. 每个动作在执行前调用一次裁决：`hasServicePermission(principal, action.requiredService)` 与 `hasDomainPermission(principal, domainId)`；
4. API Token 触发的工作流，Principal 继承该 Token 的 `allowedDomains` / `allowedServices`，**不得提权**。

> 这与 `root.ai.md` §安全规范 2"API Token 支持细粒度权限控制"完全一致，且复用 `hasServicePermission` / `hasDomainPermission` 的既有实现，不引入第二套判定逻辑。

### 5.3 动作到服务权限的映射

| 动作 | requiredService |
|---|---|
| `dns.listRecords` / `dns.getRecord` | `records.read` |
| `dns.createRecord` / `updateRecord` / `deleteRecord` / `setStatus` | `records.write` |
| `dns.listDomains` | `domains.read` |
| `http.fetch` | `network.fetch`（新增） |
| `notify.send` | `notify.send`（新增） |
| `workflow.call` | `workflow.run` |

**触发源 × 动作 的组合裁决**（在服务权限之上再加一层，见 §4.0.1）：

| 触发源 | 只读（`*.read`） | **写（`dns.record.write` / `origin.write`）** |
|---|---|---|
| `record.changed` | ✅ | ✅ |
| `domain.changed` | ✅ | ❌ **拒绝（422）** |
| `ns.changed` / `whois.expiring` / `manual` | ✅ | ✅ |

### 5.4 凭据处理（脚本零接触）

脚本**不接收任何凭据**。`dns.*` 能力的签名只需要"域名 + 操作参数"，宿主内部：

1. 由 `domainId` 反查 `dns_accounts`（经 BAL `DnsAccountOperations`）；
2. 在**宿主进程内存**解密 `config`；
3. 调用 `DnsProviderService`；
4. 凭据只在调用栈存活，不进入沙箱、不进入日志、不进入运行记录。

示例（脚本内看到的形态）：

```js
// 脚本能做的：只描述意图
const value = await hd.http.fetch({ url: 'https://api.ipify.org' });
await hd.dns.updateRecord({
  domain: 'example.com',
  name: 'www',
  type: 'A',
  value: value.text,
  ttl: 600
});
// 脚本看不到：账号、密钥、代理配置、数据库连接
```

### 5.5 出站访问代理

`hd.http.fetch` 固定受以下约束（脚本无法覆盖）：

- 必须走 `fetchWithFallback`（复用现有代理配置与降级逻辑）；
- **出站域名白名单由管理员在系统设置中维护**（见 §5.5.1）；
- 仅允许 `https:`（可选放开 `http:`）；
- 无论白名单如何配置，**始终拒绝内网地址**（`127.0.0.0/8`、`10/8`、`172.16/12`、`192.168/16`、`169.254/16`、`::1`、`fc00::/7`），防 SSRF；
- 响应体大小上限（1 MiB）、超时上限（15s）、重定向上限，且**重定向目标同样逐跳校验**；
- 出站请求计入审计。

> 与 `root.ai.md` §代理模块 一致：脚本无需也**不应**感知代理配置。

#### 5.5.1 管理员维护的出站白名单

- 存储：`SettingsOperations` 的 `workflow_http_allowlist`（系统设置项，复用现有设置机制，不新建表）。
- 形如：`["api.ipify.org", "*.cloudflare.com", "ifconfig.me"]`，支持精确域名与 `*.` 前缀通配。
- 匹配规则：**主机名精确或后缀匹配**，不匹配 IP 字面量；匹配前先做 IDN→Punycode 归一化（与 `root.ai.md` §外部集成 806 一致）。
- 空白名单 = **禁止一切出站**（fail-closed），而非"允许一切"。
- 修改白名单属于系统设置，**仅管理员**，且必须经 `system.read` / 管理员权限校验；变更写入审计。
- 前端在脚本编辑器中**实时展示当前白名单**，避免用户写完后才发现被拦。

---

## 六、脚本沙箱（无文件、无导入）

### 6.1 隔离方案

采用 Node 内置 `vm`（`vm.createContext` + `vm.Script`），**前提是宿主注入的 API 面足够窄**：

```ts
const sandbox = {
  hd: Object.freeze({ dns, http, notify, vars, log }), // 唯一能力入口
  console: Object.freeze({ log: hostLog }),            // 仅日志，不暴露 process
};
const context = vm.createContext(sandbox, { name: 'workflow-script' });
```

**能力面**：仅 `hd` 与受限 `console`。不提供 `require`、`import`、`process`、`global`、`fetch`、`fs`、`Buffer`。

### 6.2 必须正视的风险（诚实说明）

> **`vm` 不是安全边界。** Node 官方文档明确声明 `vm` 只适用于运行可信代码；在 `vm` 上下文内，攻击者历史上多次通过 `this.constructor.constructor('return process')()` 一类原型链逃逸拿到真实 `process`。

因此本设计**不把 `vm` 当作唯一防线**，而是多层防御：

| 层 | 措施 |
|---|---|
| L1 语言层 | 禁用 `eval` / `Function`（上下文内不注入），脚本只允许调用 `hd.*` |
| L2 进程层 | **脚本在独立 Worker 线程运行**，主线程仅持有句柄；Worker 崩溃不影响服务 |
| L3 能力层 | Worker 内**不加载** `fs` / `child_process` / `net`；所有能力通过 `postMessage` 回调主线程执行 |
| L4 资源层 | 执行超时（默认 5s，上限 30s）、内存上限、调用次数配额、`hd.*` 调用间隔限制 |
| L5 审计层 | 每次能力调用落审计；异常逃逸尝试记录并告警 |

> **结论**：`vm` 只负责"语法沙箱 + 上下文隔离"；**真正的权限边界是 Worker 不加载危险模块 + 能力只在主线程执行**。若后续需要更高隔离等级，可在 `deploy` 层以独立进程/容器运行脚本，接口不变。

### 6.3 脚本契约

```ts
// 脚本导出一个 async 函数，通过 hd 能力完成动作
async function main(ctx) {
  // ctx: { event, trigger, vars, run } —— 只读
  // 返回：任意可 JSON 序列化的值，写入 run.output
}
```

- 脚本**不能** `return` 凭据或原始 `http` 响应对象；
- 脚本内抛错 → 运行标记 `failed`，按工作流策略重试或终止。

### 6.4 脚本启用策略（**仅管理员**）

脚本能力**默认全局关闭**，需管理员显式开启，且分级生效：

| 层 | 规则 |
|---|---|
| 全局开关 | 系统设置项 `workflow_script_enabled`（默认 `false`），**仅管理员**可改 |
| 创建/编辑 | 脚本类动作**仅管理员**可创建与修改；普通用户的工作流只能使用表达式 |
| 执行 | 即使工作流由普通用户创建，只要含脚本动作，运行身份仍受 §5.2 约束，且脚本自身受沙箱限制 |
| 审计 | 开启/关闭开关、创建含脚本的工作流，均写入审计 |

> 依据：脚本是攻击面最大的能力（见 §6.2）。**表达式是默认形态，脚本是管理员特权**。

### 6.5 与"表达式"的关系（重要）

本设计提供**两条互补路径**，而非二选一：

| | 表达式（结构化） | 脚本（受限 JS） |
|---|---|---|
| 面向 | 常见自动化（90% 场景） | 复杂逻辑、循环、数据处理 |
| 谁能用 | **所有有 `workflow.write` 的用户** | **仅管理员**（§6.4） |
| 可审计性 | **完全可枚举**（节点树可逐项校验权限） | 需运行时审计 |
| 权限预检 | **保存时即可精确判定**需要哪些能力 | 只能运行时判定 |
| 安全面 | 小（无代码执行） | 较大（沙箱） |


**设计主张**：**默认用表达式**；只有表达式无法表达时才降级到脚本，并在 UI 明确标注风险等级。这样既保住可审计性，又保留扩展性。

---

## 七、执行语义

### 7.1 执行模型

- 触发器 → 匹配订阅 → 创建 `WorkflowRun` → 顺序执行动作 → 写结果。
- **顺序、单步失败即停**（`continueOnError: false` 默认）。
- 动作间可传值：通过 `vars` 命名空间。

### 7.2 防循环（关键）

DDNS 类场景极易自激：工作流 A 改了记录 → 触发自身 → 无限循环。

**三重防护**：

1. **深度标记**：事件携带 `traceId` 与 `depth`；`depth > 最大深度（默认 3）` 直接丢弃；
2. **同源抑制**：工作流自身写入产生的事件标记 `actor.source='workflow'`，默认**不触发**任何工作流（可在高级设置中显式允许，仍需 depth 限制）；
3. **令牌/时间窗去抖**：同一 `(workflowId, domainId, recordId)` 在窗口内（默认 10s）只执行一次，重复事件合并。

### 7.3 幂等

- 动作层幂等：`dns.updateRecord` 先查后写；值相同则**跳过**并记录 `skipped`。
- 与 `root.ai.md` §外部集成 804"创建记录前先查询、存在则更新"一致。

### 7.4 重试与超时

| 项 | 默认 | 上限 |
|---|---|---|
| 动作重试 | 0 | 3 |
| 重试退避 | 1s 指数 | 30s 封顶 |
| 动作超时 | 10s | 60s |
| 整体运行超时 | 30s | 5min |

> 重试必须遵守 §日志相关 9 的限流要求。

### 7.5 禁止工作流调用工作流（**禁止项**）

> **本版本不提供 `workflow.call` 能力。** 工作流之间不得互相调用，也不得由工作流触发另一个工作流。

理由：

1. **闭环不可判定**：`A → B → A` 在保存期无法可靠检测，只能靠运行期深度限制兜底，与 §4.0 属同一类设计缺陷。
2. **权限放大**：被调用工作流的执行身份若取"调用者"，会造成权限在链上叠加；若取"创建者"，则等于让低权限用户借用高权限工作流，违反 §5.2。
3. **可观测性崩塌**：一次触发引发多跳执行，运行记录、耗时与失败归因都难以还原。

落地方式：

| 层 | 措施 |
|---|---|
| 能力注册表 | **不注册** `workflow.call` 动作 |
| 保存校验 | 表达式/脚本中出现任何工作流调用语法 → 拒绝保存（422） |
| 脚本沙箱 | `hd` 对象**不暴露** `workflow` 命名空间 |
| 候选源 | 不提供 `workflows` 候选（§3.3） |

> 若未来确需编排，应引入**显式的 DAG 定义**（拓扑序 + 环检测），而不是自由互调；本版本不做。


---

## 八、数据模型（经 BAL，DSM 声明式）

> 全部表结构在 `server/src/db/dsm/schemas/complete-schema.ts` 声明；操作封装为 `WorkflowOperations`（BAL）。禁止路由/服务直接触达驱动层。

| 表 | 用途 | 关键字段 |
|---|---|---|
| `workflows` | 工作流定义 | `id`、`owner_user_id`、`name`、`enabled`、`trigger_type`、`trigger_config`(json)、`actions`(json)、`sandbox_policy`(json)、`created_at` |
| `workflow_runs` | 运行记录 | `id`、`workflow_id`、`trigger_event`(json)、`status`、`started_at`、`finished_at`、`error`、`depth`、`trace_id` |
| `workflow_run_steps` | 步骤明细 | `run_id`、`seq`、`action`、`input_digest`、`status`、`duration_ms`、`error` |
| `workflow_secrets`? | — | **不设计**：凭据复用现有 `dns_accounts`，不新增凭据存储 |

> `input_digest` 只存摘要（哈希 + 脱敏字段），**不存明文参数**，避免二次泄露。

---

## 九、API 设计（需同步 docs/api.md）

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| `GET` | `/api/workflows` | `workflow.read` | 列出 |
| `POST` | `/api/workflows` | `workflow.write` | 创建 |
| `PUT` | `/api/workflows/:id` | `workflow.write` | 更新 |
| `DELETE` | `/api/workflows/:id` | `workflow.write` | 删除 |
| `POST` | `/api/workflows/:id/test` | `workflow.run` | **测试运行**（不产生副作用，dry-run） |
| `POST` | `/api/workflows/:id/run` | `workflow.run` | 手动触发 |
| `GET` | `/api/workflows/:id/runs` | `workflow.read` | 运行历史 |
| `GET` | `/api/workflows/meta/{source}` | `workflow.read` | **候选值**（供 `{...}` / `[...]` 下拉） |

**管理端点必须 `requireJwtAuth`**（禁止 API Token 管理工作流），与 `root.ai.md` 对管理员/敏感路由的既有做法一致。

`meta/{source}` 需实现 §3.3 的候选源，并对 `records`/`lines` 支持 `?domainId=` 级联参数。

---

## 十、前端交互（对应三类标记）

| 控件 | 数据来源 | 校验 |
|---|---|---|
| `{...}` 仅下拉 | `meta/{source}` | 必须命中候选 |
| `[...]` 可输入 | `meta/{source}`（可为空） | 自由文本需再过一遍格式校验 |
| `(...)` 预览 | 使用**最近一次真实事件**渲染 | 无事件时显示"等待触发" |

**预览渲染**：`(...)` 必须用"样例事件"或"上次运行的真实事件"渲染真实值，而不是显示变量名——这直接对应需求中"实时渲染的预览"。

---

## 十一、风险与开放问题

| 编号 | 风险 | 缓解 |
|---|---|---|
| R1 | `vm` 可被原型链逃逸 | 多层防御（§6.2），Worker 不加载危险模块；后续可升级为独立进程 |
| R2 | 工作流自激循环 | 三重防循环（§7.2） |
| R3 | 凭据经日志/运行记录泄露 | 凭据不入沙箱；`input_digest` 只存摘要（§5.4、§8） |
| R4 | SSRF（`http.fetch` 打内网） | 协议白名单 + 内网地址拒绝 + 重定向复检（§5.5） |
| R5 | 权限提升 | Principal 取创建者现行权限，Token 触发不得提权（§5.2） |
| R6 | 表达式伪造成交值 | 提交时复校验候选集合（§3.4） |
| R7 | 域名变动误触发记录写入（自激 / 错写记录） | **硬性禁止 + 三层强制**（§4.0、§4.0.1） |
| **R8** | **`ModifyOriginGroup` 全量覆盖导致丢失更新/误删源站/权重被清空** | read-modify-write + 按 `groupId` 串行化 + 写入前重读比对基线 + 未修改记录原样回传（§3.7.5） |
| **Q1** | 「源站组」在 HiDNS 中**没有对应概念** | 需你确认是映射到 Cloudflare Tunnel、还是新增抽象；本文暂按 `tunnels` 候选处理 |
| **Q2** | 表达式与脚本并存是否会失控 | 建议 UI 默认只开放表达式，脚本作为"高级模式"并需管理员开启 |
| Q3 | 定时器的时区语义 | 建议统一 UTC 存储、按用户偏好渲染 |
| Q4 | 工作流级联（工作流调用工作流） | 建议 v1 不做，仅允许 `dns.*` 等基础动作 |
| **Q5** | 「域名变动不得写记录」是否也约束**只读**动作 | 按 §4.0.1 **只约束写动作**；若需连只读也禁，请明确，我会改为全禁 |

---

## 十二、分期落地建议

| 阶段 | 内容 | 产出 |
|---|---|---|
| P0 | 事件总线 + `WorkflowOperations` + 表达式求值器 + `meta` 候选接口 + **§4.0 组合裁决** + **EdgeOne 源站组能力** | 能跑"记录变了 → 更新源站组/另一条记录" |
| P1 | 能力代理与鉴权裁决 + 管理员出站白名单 + dry-run 测试 | 安全边界成型 |
| P2 | 脚本沙箱（Worker + `hd` 能力），**仅管理员可控开关** | 复杂场景 |
| P3 | 防循环、重试、审计、前端编辑器 | 可生产 |

**每阶段必须同步**：`docs/api.md`（第一权威）、`root.ai.md` 新增「工作流与脚本沙箱」章节、CHANGELOG。

> **P0 必须包含 §4.0 的强制项与 §7.5 的禁用项**，不能留到 P3。理由：一旦允许非法组合落库，后续每一条运行路径都要重新兜底，成本远高于在保存期拦住。

### 12.1 需要同步修订 `root.ai.md` 的章节

| 章节 | 新增内容 |
|---|---|
| §服务层 | 增补 `WorkflowEngine` / `WorkflowEventBus` / `CapabilityBroker` 的职责边界 |
| §数据库 7 | `WorkflowOperations` 纳入操作模块清单 |
| §路由 | 新增 `/api/workflows`、`/api/workflows/meta/:source` |
| §安全规范 | 新增「工作流执行身份」「凭据零接触」「脚本沙箱」「管理员出站白名单」四条 |
| §DNS提供商适配器 | `DnsCapabilities` 增加 `originGroup` 字段；EdgeOne/DNSPod 复用腾讯云 TC3 鉴权 |
| 新增章节 | 「工作流与脚本沙箱」：两条禁止项（域名变动不写记录、工作流不调用工作流）、沙箱能力面、出站代理约束、脚本仅管理员 |

---

## 十三、已确认的决策（v1 定稿）

| 编号 | 决策 | 落点 |
|---|---|---|
| D1 | 「源站组」是 **EdgeOne 边缘加速（TEO）的源站/回源配置**，非 DNS 解析记录；复用 DNSPod/EdgeOne 的腾讯云鉴权，本质是**附加组件** | §3.7 |
| D2 | **仅管理员**可启用脚本与创建脚本动作 | §6.4 |
| D3 | **禁止**工作流调用工作流（不提供 `workflow.call`） | §7.5 |
| D4 | 出站域名白名单由**管理员在系统设置中维护列表**，空白名单=全禁 | §5.5.1 |
| D5 | **不设计定时器**，无 `schedule` 触发器 | §4.1 |
| D6 | **只读动作不设触发源限制**；仅写动作受 §4.0 约束 | §4.0.1 |
| D7 | **DNSPod 不声明 `originGroup`**（纯解析，无边缘加速源站组），仅鉴权体系相同 | §3.7.4 |

## 十四、仍待确认

1. **`ActionClass` 分类方式**（§十五）是否认可，以便 P0 落地组合裁决。
2. **`origin.replaceRecords`（整组覆盖）是否需要开放给高级用户**？默认设计为"不暴露给脚本"，但管理员是否可在表达式里使用，需确认。

> EdgeOne 源站组的 API action 与数据结构已按官方文档核对完毕（§3.7.3），不再待确认。核对来源：
> [创建源站组](https://cloud.tencent.com/document/api/1552/80598)、[获取源站组列表](https://cloud.tencent.com/document/api/1552/80594)、[修改源站组](https://cloud.tencent.com/document/api/1552/80592)、[负载均衡相关接口](https://cloud.tencent.com/document/api/1552/80591)、[数据结构](https://cloud.tencent.com/document/api/1552/80721)

---

## 十五、动作分类（P0 落地前置）

§4.0 / §7.5 的裁决需要一个**可判定的动作分类**。建议在能力注册表里给每个动作打标签：

```ts
type ActionClass =
  | 'dns.record.read'    // 记录只读
  | 'dns.record.write'   // 记录写（受 §4.0 约束）
  | 'origin.read'        // 源站组只读
  | 'origin.write'       // 源站组写（受 §4.0 约束）
  | 'http'
  | 'notify';
```

裁决只需比较 `(triggerType, actionClass)`，避免每新增一个动作都要改判断逻辑。

> 注意：`workflow` 类**不出现**在分类里——因为工作流调用已被完全禁用（§7.5）。



