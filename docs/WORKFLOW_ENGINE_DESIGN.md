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
| **`originServers`** | 指定源站组下的回源地址与权重（级联依赖 `originGroupId`）。**v2 才启用**，随点对点一起 | 同上 |
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
  /**
   * scopeId：Provider 定义的**不透明作用域**，核心不解释其含义。
   * - tencenteo：站点 ID（形如 zone-xxx）
   * - 未来其他厂商：可为区域 / 项目 / 集群，或空字符串
   * 与既有 domains.third_id 的处理方式一致：Provider 把自己的概念映射进通用槽位。
   */
  listOriginGroups(scopeId: string, opts?: { offset?: number; limit?: number }): Promise<OriginGroup[]>;
  getOriginGroup(scopeId: string, groupId: string): Promise<OriginGroup | null>;

  /**
   * 整组覆盖写（对应 ModifyOriginGroup 的原始语义）。
   * ⚠️ 这是**裸原语**：不做定位、不做保留、不做校验，传入什么就写什么。
   * 只允许由 CapabilityBroker 的 origin.replaceGroup（v2 起含 origin.updateRecord）调用，
   * 不得被路由或脚本直接触达（见 §3.7.9 安全契约）。
   */
  replaceOriginRecords(scopeId: string, groupId: string, records: OriginRecord[]): Promise<void>;
}
```

> 适配器层是**裸的**（与腾讯云 API 一一对应），所有保护都在 `CapabilityBroker` 的动作层实现。这样"原始能力"与"受保护动作"边界清晰，代码审查时一眼能看出哪层该有守卫。


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

#### 3.7.5 点对点定位（**v2 设计底稿，v1 不实现**）

> **本章在 v1 中不落地。** 点对点在复杂场景下性能不佳（read-modify-write + O(N) 复核 + 按组串行），且匹配依赖 `oldValue` 与当前状态一致，地址快速漂移时失败方式不直观；实际使用场景也很少——**DDNS 走的是点对面**。v1 唯一写动作是 `origin.replaceGroup`（§3.7.9）。保留本章是为了让 v2 重启时有据可依，并让评审者看到"为什么不做"。

官方 `ModifyOriginGroup` 只接受整组 `Records`，**没有"改第 N 条"的入参**。因此"点对点更新"必须由宿主在 read-modify-write 中实现。定位分三步：**解析 → 唯一性裁决 → 保留式回写**。

> **适用范围**：本章描述**写入意图 I1（点对点）** 的实现。两种写入意图的定义见 §3.7.9；点对面（I2）**不做定位**——它没有"哪一条"的问题。

##### 3.7.5.1 可用的定位键

> **先说结论：EdgeOne 的 `OriginRecord` 没有备注字段，无法用备注定位。**
>
> 已核实：`OriginRecord` 的字段集为 `RecordId` / `Record` / `Type` / `Weight` / `Private` / `PrivateParameters`。
> 在腾讯云 Node.js SDK 的 TEO 类型定义中检索 `Remark`，仅命中 `CreateEdgeKVNamespaceRequest`、`ModifyEdgeKVNamespaceRequest`、`CreateFunctionRequest`、`CreateFunctionRuleRequest` 四个接口，**没有任何源站相关接口带备注字段**。
>
> **混淆来源**：HiDNS 自己的 `DnsRecord`（`server/src/lib/dns/DnsInterface.ts:17`）**有** `Remark`，且厂商能力位 `DnsCapabilities.remark` 也是解析记录的能力。但那是**解析记录**的字段，不是**源站记录**的。

| 定位键 | 来源 | 稳定性 | 适用 |
|---|---|---|---|
| `record`（源站地址） | `OriginRecord.Record` | 中：地址本身可能被改，但**恰好是 DDNS 场景的抓手** | **首选** |
| `recordId` | `OriginRecord.RecordId`（形如 `record-3492ee3b-…`） | **未知**：官方示例在覆盖时**未回传** `RecordId`，是否保留未在文档中说明 | 可选，见下方警告 |
| `index`（数组下标） | 读取顺序 | **低**：任何一次覆盖都可能改变顺序 | 不推荐 |
| ~~`remark`~~ | — | **不存在** | **不可用** |

> **关于 `recordId` 的诚实说明**：`CreateOriginGroup` 的示例 `Records` 不带 `RecordId`，`ModifyOriginGroup` 的示例也不带。这意味着覆盖后**可能重新生成 ID**。因此设计上：
> - `recordId` **不得持久化**在表达式里当作长期锚点；
> - 每次运行都**重新读取并解析**目标；
> - 若用户选了 `recordId` 定位，且本次运行读不到该 ID → 明确报错，**不降级猜测**。

##### 3.7.5.2 唯一性裁决（硬规则）

解析出候选集合后：

| 命中数 | 行为 |
|---|---|
| **恰好 1 条** | 执行更新 |
| **0 条** | 默认**跳过并标记 `skipped`**（幂等友好：值已是目标态时不报错）；若表达式显式声明 `onMissing: 'error'` 则失败 |
| **> 1 条** | **一律报错中止**（`AmbiguousOriginMatch`），**绝不猜测**用哪一条 |

> 为什么 >1 必须报错：地址重复在源站组里是合法配置（同一 IP 多条、不同权重/端口）。猜错就是改错源站，且 `ModifyOriginGroup` 只返回 `RequestId`，**从返回值看不出改错**。

##### 3.7.5.3 保留式回写

写入前把整组记录按"是否被本次意图命中"分为两类：

```
目标记录：只应用 set 中的字段；未被 set 的字段（weight/private/privateParameters）原样保留
其余记录：逐字段原样回传，包括 recordId、weight、private、privateParameters
```

**禁止只提交目标记录**——那会清空其余源站。能力层必须在构造 payload 时断言 `payload.length === baseline.length`，不等则拒绝提交。

> 为什么不省略未修改记录的 `Weight`：官方示例 2 覆盖时未带 `Weight`，而 `Weight` 是可选字段；省略后的行为（重置为默认还是保持）文档未明确。**回传原值可消除这个不确定性。**

##### 3.7.5.4 写后校验

`ModifyOriginGroup` 只返回 `RequestId`，**不返回变更结果**。因此每次写入后必须重读并断言：

| 断言 | 失败含义 |
|---|---|
| 目标记录的 `Record` 已等于新值 | 写入未生效 |
| 记录总数与写入前一致 | 有源站被误删/误增 |
| 其余记录（除目标外）逐字段与写入前相同 | 有旁路改动 |

任一断言失败 → 运行标记 `failed`，**不自动重试**（避免放大损坏），并落审计与告警。

##### 3.7.5.5 并发与丢失更新

| 措施 | 说明 |
|---|---|
| 按 `groupId` 串行化 | 进程内互斥（同一目标不允许并发 read-modify-write） |
| 基线比对 | 提交前重读，若与本次读取的基线不一致 → 放弃并重试（乐观并发控制） |
| 任务去重 | 复用 `taskManager` 的同 ID 延后重排机制（§P0-2 的修复） |

##### 3.7.5.6 表达式如何写（DDNS 场景实例）

```
当 记录 [www.example.com] 的 A 记录 值 发生变动
  设置 EdgeOne 源站组 (eo-origin-a) 中
    定位 源站地址 = (事件.旧值)        ← 点对点：用旧值定位，天然唯一
    更新 源站地址 为 (事件.新值)
    保留 权重 (当前值 30)              ← 未声明则原样保留
```

对应动作调用：

```ts
origin.updateRecord({
  accountId, scopeId, groupId,
  match: { field: 'record', value: expr('event.record.oldValue') },
  set:   { record: expr('event.record.value') },   // 只改地址
  onMissing: 'skip'
})
```

> 用 `oldValue` 定位是这个场景**最稳健的锚点**：它与触发事件同源，不需要任何持久 ID，且天然满足"唯一"约束（同一地址重复出现时按 §3.7.5.2 报错，提示用户改用 `recordId`）。

##### 3.7.5.7 其他必须处理的 API 行为

| 情况 | 处理 |
|---|---|
| `OperationDenied.AccelerationDomainStatusNotInOnline` | 引用该组加速域名部署中 → **可重试**（退避），不可当永久失败 |
| `OperationDenied.L4StatusNotInOnline` / `LoadBalanceStatusNotInOnline` | 绑定资源非运行中 → 重试或明确报错 |
| `InvalidParameter.InvalidOriginIp` | 服务端拒绝内网 IP/回环地址 —— 与 §5.5 的内网拦截**方向一致**，前端应提前校验 |
| `AAAA` 触发的 IPv6 目标 | 源站是否接受 IPv6 地址**未核实**。F5 预检须先判定：若不接受则报 `OriginIpVersionUnsupported` 并中止，**不得把非法地址写进去**（宁可失败，不要留下一个静默失效的源站） |
| `OperationDenied.ConfigLocked` / `InternalError.ConfigLocked` | 配置锁定 → 明确报错，提示解锁，不重试 |
| 频率限制 20 次/秒 | 能力层统一节流，避免工作流批量触发打满 |

##### 3.7.5.8 为什么**不能**在核心库存别名（已否决的方案）

> 本方案曾被提出并**已被否决**，记录在此以防复发。

**被否决的方案**：在 HiDNS 自己的库里建 `origin_aliases` 表（`account_id`、`zone_id`、`group_id`、`record_id`、`alias`、`anchor_record`），让用户用可读名定位源站。

**否决理由——它把 Provider 的资源层级写进了核心数据模型**：

| 问题 | 说明 |
|---|---|
| **核心学懂了 EdgeOne 的层级** | `zone → group → record` 是 TEO 的私有结构。一旦成为核心表结构，核心就"知道"了站点与源站组，违背 §DNS提供商适配器 1「提供商保持模块化、核心只依赖 `DnsAdapter` 契约」 |
| **出现第二个真相源** | 别名表声称"record_id X 叫主源站"，但权威在 EdgeOne。两边必然漂移，且漂移后无从判定谁对 |
| **新 Provider 无法复用** | 另一个厂商的源站模型若有/无站点层、有/无组概念，核心表要么冗余列要么塞空值——典型的核心与适配器强绑定 |
| **灾难形态不可控** | 核心 schema 一旦长入厂商概念，后续每次适配器演进都要反向改核心；这类绑定在 DSM 版本协调与多库（SQLite/MySQL/PostgreSQL）下扩散极难预判 |

**正确的分层（与既有实现一致）**：

项目已经有标准做法——`domains.third_id` 是**不透明字符串槽**（`complete-schema.ts:90`，length 500），`tencenteo` 把 `ZoneId` 放进 `ThirdId`（`adapter.ts:93`）。也就是说：

> **Provider 把自己的概念映射进核心的通用槽位；核心永远不认识"Zone"这三个字母。**

因此"可读定位"按此原则改为**两级下沉**，核心零改动：

| 层 | 做法 | 是否落库 |
|---|---|---|
| **表达式节点** | 可读名只是该节点的**显示标签**（`label: "主源站"`），存于工作流定义的 JSON 内。**它不参与定位**，仅用于 UI 与 diff 展示 | 存于工作流配置，**不是核心实体表** |
| **Provider 适配器** | 若某厂商原生有备注/名称，由适配器在自己的 DTO 里返回（如 `listOriginGroups` 的结果附带 `label?`），核心只当普通字段透传 | **不落核心库** |

**定位仍只用 `record` / `recordId`**（§3.7.5.1），可读名从不参与匹配。这样：

- 用户依然看到"主源站""备用源站"这种可读文本；
- 核心 schema 一行不用加；
- 换一个 Provider、换一套资源层级，核心不受影响。

> **判定准则（新增，写入 §12.1 规范同步项）**：任何"为了某个厂商的某个资源"而提议新增核心表或核心列的设计，都必须先问——**这是不是 Provider 的私有结构？** 若是，一律下沉到适配器或退化为不透明槽位，禁止建模进核心。


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

| 动作 | `ActionClass` | 风险级别 | 所需服务权限 | 写入意图 | 说明 |
|---|---|---|---|---|---|
| `origin.listGroups` | `origin.read` | 低 | `records.read` | — | 只读 |
| `origin.getGroup` | `origin.read` | 低 | `records.read` | — | 只读 |
| `origin.planReplaceGroup` | `origin.read` | 低 | `records.read` | — | 只读：生成 diff / 影响面 / digest（§3.7.9.2） |
| `origin.replaceGroup` | `origin.write` | **高** | `records.write` | **I2 点对面** | **v1 唯一写动作**：整组收敛为单一目标（§3.7.9） |
| ~~`origin.updateRecord`~~ | — | — | — | I1 点对点 | **v2 延期**，见 §3.7.5 与 §3.7.9.1 |

**v1 只有一个写动作：`origin.replaceGroup`。**

点对点（`origin.updateRecord`）**延期到 v2**，理由按权重排序：

| # | 理由 | 具体表现 |
|---|---|---|
| 1 | **性能** | 点对点是 read-modify-write：读整组 → 裁决 → 回写 → 再读整组逐字段复核，**单次事件 3 次 API 调用**，且读放大 O(N)、复核 O(N)；并发还要按 `groupId` 串行排队 → 事件密集时退化为队列堆积。点对面写入的是**与当前状态无关的收敛态**，O(1) 构造、无竞态、可重放 |
| 2 | **竞态** | 点对点的匹配依赖 `event.oldValue` 与"当前"状态一致。地址快速漂移（DDNS 抖动、多客户端同时上报）时匹配频繁落空，表现为**误 `skipped` 或误 `AmbiguousOriginMatch`**——失败方式既不直观也难以复现 |
| 3 | **使用频次** | 点对点的适用场景是"多源站组里只让一条跟随"，实际极少；**DDNS 根本不走它**（DDNS 要的是"整组回源到当前 IP"，正是点对面） |

> **延期不是删除**：契约与实现要点保留在 §3.7.5 与 §3.7.9.4 作为 v2 设计底稿。若将来重启点对点，必须先解决上表 1、2 两条，否则同样的性能与竞态问题会原样重现。

> 原草案的 `origin.replaceRecords({ records: [...] })`（调用方自备完整数组）**已移除**，理由见 §3.7.9.1。

**`origin.replaceGroup` 的能力边界**：

- 只会让条数**减少**（收敛到 1），绝不增加；
- 不能改组的 `Type`（`GENERAL`/`HTTP`）与 `HostHeader`；
- 不能跨组移动源站；
- **v1 没有任何"只改一条"的动作** → 工作流对源站组的每一次写入都是收敛。多源站组（多活 / 加权）**不应交给工作流维护**，见 §3.7.10。

**触发约束**：`origin.write`（v1 即 `replaceGroup`）与 `dns.record.write` 同属「回源/解析目标变更」，因此**同样禁止由 `domain.changed` 触发**（§4.0 理由完全适用）。

> `origin.read` 不受 §4.0 约束——按已确认的 D6，**只读动作不设触发源限制**。

#### 3.7.8 候选值级联

| 候选源 | 参数 | 依赖 |
|---|---|---|
| `originGroups` | `accountId`、`scopeId` | 需先选账号（且 `originGroup: true`）与作用域 |
| ~~`originServers`~~ | `accountId`、`scopeId`、`originGroupId` | **v2 启用**（v1 无按源站粒度的动作，该候选源无消费方） |

前端在账号不支持源站组时**隐藏整条源站组动作**，而不是显示后报错。

> **`scopeId` 是核心的中性词汇**，对应 §3.7.4 的不透明作用域。`tencenteo` 的作用域是**站点（Zone）**，故该厂商的 UI 表现为"先选站点"；其他厂商若作用域为区域/项目，仅换 UI 措辞，**核心与表达式结构不变**。这与 `domains.third_id` 的处理方式完全一致。

#### 3.7.9 两种写入意图：I2 点对面（v1）/ I1 点对点（v2 延期）

##### 3.7.9.1 两条路线的分工，以及为什么 v1 只做点对面

两条路线回答的是**两个不同的问题**。**v1 只实现 I2**；I1 延期的理由（性能、竞态、使用频次）见 §3.7.7。

| | **I1 点对点** `origin.updateRecord`（v2） | **I2 点对面** `origin.replaceGroup`（v1） |
|---|---|---|
| 要回答 | 改**哪一条** | 整组**应该是什么** |
| 使用者需知道 | 目标那一条的锚点（`record` / `recordId`） | **一个**目标值 |
| 结果形态 | 条数不变，其中一条被改 | 条数 → **1** |
| 权重 | 原样保留 | 无意义（单源站不做加权分配） |
| 典型失败 | 改错源站 | 所有引用方的回源被改 |
| DDNS 用法 | 某条源站跟随某条记录 | 加速域名回源跟随动态 IP |

**已移除的形态**：原草案的 `origin.replaceRecords({ records: [...] })`（调用方自备完整 `Records` 数组）不再提供。它既不是点对点也不是点对面——它要求调用方在**看不见当前整组**的前提下构造整组，而这恰恰是调用方最不该需要知道的信息。原 C1/C2/C3 那套"数组完整性"契约，本质是在给这个错误形态打补丁；形态去掉，补丁也就不需要了。

##### 3.7.9.2 两条路线共用三段式

```
① 解析 Resolve（只读） → ResolutionReport
② 计划 Plan（只读）    → diff + 影响面 + digest
③ 提交 Commit          → 携 digest 执行，写后校验
```

两种 `ResolutionReport` 形态不同，但阶段一致：

| | I1 | I2 |
|---|---|---|
| Resolve 产物 | `{ matched: 1, before, after, preserved[] }` | `{ collapsedFrom: N, removed[], target, references[] }` |
| Plan 产物 | 单条字段级 diff | 整组前后对照 + 被移除记录逐条 + 引用方清单 |
| digest | 由字段级 diff 计算 | 由整组 diff + 引用方清单计算 |

`digest` 的语义：**提交时重算，与预览不一致即拒绝执行**。这堵住"预览时看着没问题、提交时已经变了"的时间窗。

##### 3.7.9.3 通用契约（两条路线都强制）

| # | 契约 | 拒绝条件 | 理由 |
|---|---|---|---|
| U1 | **解析可读** | 未产出 `ResolutionReport` 就提交 | 使用者必须能看懂"将要改什么" |
| U2 | **差异可见** | 未携带 `digest`，或提交时重算的 diff 与 digest 不符 | 防止预览与提交不一致 |
| U3 | **写入前快照** | 未保存基线快照 | `ModifyOriginGroup` 只返回 `RequestId`，出错无迹可寻，快照是唯一回滚依据 |
| U4 | **写后校验** | 未按 §3.7.5.4 三项断言复核 | 确认真的写入且无旁路改动 |
| U5 | **审计留痕** | 未记录操作者、diff、快照引用 | 高危动作必须可追溯 |

##### 3.7.9.4 I1 专属契约（**v2 延期，随 I1 一起**）

| # | 契约 | 落点 |
|---|---|---|
| P1 | **唯一性裁决**：命中必须恰好 1 条，`>1` 一律报错 `AmbiguousOriginMatch` | §3.7.5.2 |
| P2 | **保留式回写**：未 `set` 的字段原样保留，其余记录逐字段原样回传，断言条数不变 | §3.7.5.3 |
| P3 | **未命中策略**：默认 `skipped`（幂等友好），显式 `onMissing: 'error'` 才失败 | §3.7.5.2 |

##### 3.7.9.5 I2 专属契约

点对面没有数组，因此**不适用**"数量红线""权重完整性"这类针对数组算错的契约。它的风险性质不同——**影响面扩散**与**不可重建数据丢失**：

> **也不需要按 `groupId` 串行**（与 §3.7.5.5 点对点的要求相反）：点对面写的是**完整目标态**，不存在 read-modify-write 意义上的丢失更新——两个并发的收敛都是"把整组变成某个单条"，后写者即更新的值，与 DDNS「最新 IP 生效」的语义一致。唯一要防的是 plan 与 commit 之间的状态漂移，已由 `digest` 承担（不一致即拒绝重规划）。这一条同时是 v1 性能优于点对点的主要原因之一。

| # | 契约 | 拒绝条件 | 理由 |
|---|---|---|---|
| F1 | **收敛必须显式** | 未声明 `collapse: true` | 这是不可逆的形态改变。v1 里它已是唯一写模式，故该标志的作用是**签名式自认**（`--yes-i-mean-it`）；真正拦人的是 F2 / F3 / F4 |
| F2 | **影响面必须可见** | `References` 非空但 report 未列出被引用资源 | 收敛后**所有**引用方的回源都变了（加速域名 / 四层代理 / 负载均衡），使用者必须知道影响谁 |
| F3 | **被销毁记录逐条列出** | diff 未逐条列出被移除记录的 `record` + `weight` + `type` | 只给"N→1"不够，必须看得见具体丢了哪几条 |
| F4 | **不可重建数据额外确认** | 被移除记录含 `type='AWS_S3'` 或非空 `Private` / `PrivateParameters`，且未声明 `acknowledgeDataLoss: true` | 对象存储私有访问参数（凭据）无法从目标值反推，收敛即销毁 |
| F5 | **目标值预检** | `record` 为内网/回环地址；或未显式给 `type` | 腾讯云返回 `InvalidParameter.InvalidOriginIp`；提前拦截给出可读错误 |
| F6 | **权重处理明确** | — | 收敛后单条不带 `Weight`（单源站无分配语义），写后回读确认；形态见 §3.7.9.6 |
| F7 | **幂等** | 组内已恰好 1 条且等于目标 → `skipped`，不发写请求 | 避免重复触发产生无意义写入与审计噪声 |

##### 3.7.9.6 收敛后的目标形态（前提已确认）

**前提已确认：EdgeOne 源站组允许只有 1 条源站**（项目方确认；官方文档未写明最小条数，故此前列为未核实项）。

由此**删除**此前设计的"整组广播"退化路径（整组每条都改写为同一目标）。理由：那条路径会让 diff 显示 `N→N` 却仍宣称"替换成单一目标"，**语义自相矛盾**；且它只是在为一条不存在的前提兜底，属无效复杂度。

收敛后的组内形态：

| 项 | 结果 |
|---|---|
| `Records` | **恰好 1 条**：`record` = 目标值，`type` = 显式声明的类型 |
| `Weight` | **不带**（单源站无加权分配语义），写后回读确认 |
| `GroupId` / `Name` / `Type` / `HostHeader` | 不变 |
| `References` | **不变**——引用关系绑定在组上，不随条数变化 |

**fail-closed 分支**：若服务端仍以参数类错误拒绝单条 `Records`，报错 `CollapseUnsupported` 并中止。**不得**擅自退化为"每条都改成同一目标"——那会静默改变使用者声明的意图，且 diff 与实际结果不符。

##### 3.7.9.7 两条路线都做不到的事（能力边界）

| 做不到 | 原因 | 正确做法 |
|---|---|---|
| **新增源站** | I1 只改既有条目；I2 只会收敛 | 走腾讯云控制台（避免工作流自动扩充回源池这类事后难审计的行为） |
| 改组的 `Type` / `HostHeader` | 属 `OriginGroup` 自身属性，不在 `Records` 里 | 控制台 |
| 跨组移动源站 | 无此 API | 控制台 |

##### 3.7.9.8 表达式写法

**I1 点对点**（v2 延期；示例保留作为形态参照——注意它**不是** DDNS 的推荐用法）

```
当 记录 [www.example.com] 的 A 记录 值 发生变动
  设置 EdgeOne 源站组 (eo-origin-a) 中
    定位 源站地址 = (事件.旧值)
    更新 源站地址 为 (事件.新值)
    保留 权重 (当前值 30)
```

```ts
origin.updateRecord({
  accountId, scopeId, groupId,
  match: { field: 'record', value: expr('event.record.oldValue') },
  set:   { record: expr('event.record.value') },
  onMissing: 'skip'
})
```

**I2 点对面**（加速域名回源跟随动态 IP）

```
当 记录 [home.example.com] 的 A 记录 值 发生变动
  设置 EdgeOne 源站组 (eo-origin-home) 的源站
    为 (事件.新值)
    确认影响 (2 个加速域名)
```

```ts
// 第一步：plan（只读，绝不写）
origin.planReplaceGroup({ accountId, scopeId, groupId,
  target: { record: expr('event.record.value'), type: 'IP_DOMAIN' } })
  // → { collapsedFrom: 3, removed: [...], target: {...},
  //     references: [...], digest: 'sha256:…' }

// 第二步：commit（digest 必填）
origin.replaceGroup({
  accountId, scopeId, groupId,
  target: { record: expr('event.record.value'), type: 'IP_DOMAIN' },
  collapse: true,
  acknowledgeDataLoss: false,
  diffDigest: 'sha256:…'
})
```

**与 `dry-run` 的关系**：§九 的 `/api/workflows/:id/test` 对两条路线**都只执行到 Plan 阶段**，不落写入，返回 report 供确认。

**脚本可用性**：脚本**可以**调用两个动作，但：

- 脚本本身已限管理员（D2）；
- U1–U5 / P1–P3 / F1–F7 同样强制，脚本无法绕过；
- 脚本必须自行携带 `diffDigest`（先调 `planReplaceGroup` 或 `planUpdateRecord` 取得），**不得跳过预览**。

> 一句话：开放的是**能力**，收紧的是**流程**——必须"看见再写"。



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

#### 3.7.10 部署形态：工作流只碰「专用单源站组」

v1 只有收敛写动作，这直接决定了一条部署约束：

> **工作流应当只操作「专为它准备的、只含 1 条源站」的源站组。** 不要把多源站组（多活 / 加权 / 灰度）交给工作流维护。

理由：任何一次工作流写入都会把目标组收敛成 1 条，多源站组的加权结构会被抹平；而 v1 没有"只改一条"的能力来避免这一点。

推荐结构：

```
多源站组（人工维护：多活 / 加权 / 灰度）   ← 工作流不碰
    └─ 加速域名 A

单源站组 eo-origin-home（工作流专用）       ← 工作流只碰这个
    └─ 加速域名 B（独立域名，或按规则分流）
```

这样"动态 IP 回源"与"多源站负载均衡"各在自己的组里，互不干扰，工作流也不需要知道任何组的全貌。

**前置提示（前端义务）**：动作面板选择源站组时，必须展示该组**当前源站条数**与**引用方数量**；条数 > 1 时用醒目样式标注"此工作流会把 N 条源站收敛为 1 条"。这不替代 F2 / F3 的运行期门槛，只是让选择阶段就能看见后果。
## 四、触发器（Trigger）

### 4.0 硬性约束：不得以「域名」为单位修改解析（**禁止项**）

> **「域名变动」类触发器（`domain.changed`）禁止作为任何解析写动作（`dns.createRecord` / `dns.updateRecord` / `dns.deleteRecord` / `dns.setRecordStatus` / `dns.batchRecords`）的触发源。**

理由：**1 条技术理由（决定性）+ 2 条工程理由（仍成立）**。

#### 4.0.1 首要理由是技术性的：A / AAAA 是多值记录

**一个域名可以同时存在多条 `A` 与多条 `AAAA`。** 因此「某域名的解析值」**不存在唯一解**——`www.example.com` 完全可以同时指向 `1.2.3.4`、`5.6.7.8` 与 `2001:db8::1`。

这直接否定了「按域名改解析」的可定义性：

| 假想的表达式 | 为什么写不出来 |
|---|---|
| 当域名变动 → 把解析改为 X | 改**哪一条**？域名下有多条 A/AAAA，事件里没有任何信息能唯一确定目标记录 |
| 当域名变动 → 把所有 A/AAAA 都改为 X | 等价于批量覆盖，会摧毁多线路 / 多活 / 灰度等合法配置，且不可逆 |
| 当域名变动 → 取「当前解析值」作为事件值 | **没有「当前解析值」这个对象**，只有一组值 |

也就是说：**「域名的解析值」不是一个可观测对象，「某条 A 记录的 value」才是。** 这就是为什么触发源必须是**记录级事件**——它携带 `recordId` + `oldValue`，目标唯一。

> 这条技术理由**优先于**下面两条工程理由：即使不考虑自激与错写，「按域名改解析」也无法被定义成确定的操作。

旁证：`root.ai.md` §外部集成 811-833 的 DDNS 语义是「客户端上报 IP → 更新解析记录」，其输入本就是**一条记录**（`subdomain` + `type` + IP），与上述结论一致。

#### 4.0.2 工程理由（仍然成立）

2. **必然自激**：记录写入会再次产生 `record.*` 事件；若经由域名变动回到记录写入，形成 `domain → record → domain` 闭环，只能靠深度限制兜底，属于设计缺陷而非保护。
3. **绕过更新链路**：检测记录同一性依赖 `domain.third_id`。`domain_sync_job` 会重写 `third_id`（上游域名 ID 可能变化），若域名变动触发记录写入，会在 `third_id` 已变、记录尚未重新枚举的窗口内，把修改写到**错误的记录**上，造成静默数据损坏。

#### 4.0.3 约束的精确边界

| 写入粒度 | 是否允许 | 依据 |
|---|---|---|
| **以域名**为单位（无 `recordId`，隐含「改这个域名的解析」） | ❌ 禁止 | 目标不唯一（§4.0.1） |
| **以记录**为单位（携 `recordId` 或唯一 `(name,type,value)`） | ✅ 允许 | 目标唯一 |

> 本约束禁止的是**按域名**的写入，不是禁止工作流写解析。若需彻底禁止工作流写 DNS 记录（`dns.*.write` 整体移出动作集），改动点只有三处：§3.7.7 动作表、§十五 `ActionClass`、§4.0.4 组合裁决表——结构与其余章节不受影响。

### 4.0.4 运行时强制（不只是文档约定）

| 层 | 措施 |
|---|---|
| 保存校验 | 若 `trigger.type ∈ {domain.changed, domain.created, domain.deleted, domain.renewed}` 且动作含任何**写能力**（`dns.record.write` 或 `origin.write`）→ **拒绝保存**，返回 422 并说明原因 |
| 执行前裁决 | `CapabilityBroker` 在每次记录写动作前校验 `(triggerType, action)` 组合，命中即拒绝（防绕过校验直接改库） |
| 前端 | 选择「域名变动」触发器后，动作面板**隐藏**记录写动作；选择记录写动作时，触发器下拉中禁用域名变动类 |
| 审计 | 若被拒，记录 `workflow.violation` 审计事件并告警 |

**允许的替代路径**（这是用户真正想表达的意图）：

| 意图 | 正确做法 |
|---|---|
| IP 变了要更新解析 | 用 `record.changed` 触发 `dns.updateRecord`；或由外部 DDNS 客户端经 API 上报后触发 |
| 域名同步后要校验记录 | 用 `domain.changed` 触发**只读**能力（`dns.listRecords`），仅做检查/告警，**不改写** |
| 需要"跨厂商同步解析" | 用 `record.changed` 触发 `dns.updateRecord` 到另一个账号/域名 |

> 换言之：**只读能力完全不受此约束**（本轮已确认）。`domain.changed` 可以触发 `dns.listRecords`、`origin.listGroups`、`notify.send`、`http.fetch`、`workflow.vars` 等；被禁的只有**写动作**（`dns.record.write` 与 `origin.write`）。

### 4.0.5 记录类型收窄：只监听 `A` / `AAAA`

> **`record.changed` 只对 `A` 与 `AAAA` 两种记录类型产生工作流事件。** 其余类型（`CNAME` / `MX` / `TXT` / `NS` / `SRV` / `CAA` / `URL` …）的变更**不产生事件、不可被订阅**。

理由：

1. **只有 A/AAAA 携带地址** —— 源站组回源、DDNS、IP 漂移联动的输入都是「地址」。CNAME 指向主机名，MX/TXT/NS 与回源无关；把它们放进事件面只会产生无法映射到任何动作的噪声。
2. **与 `event.record.oldValue` 的语义匹配** —— 只有 A/AAAA 的 value 是可直接比较的地址，能天然承担「旧值 → 新值」的锚点；§3.7.5.6 的点对点定位正是依赖它。
3. **收窄事件面 = 收窄鉴权面与审计面** —— 事件类型是组合裁决的输入之一（§4.0.4），枚举越少，可判定性越高。

强制：

| 层 | 措施 |
|---|---|
| 保存校验 | 触发器的 `recordTypes` 只能取 `['A']` / `['AAAA']` / `['A','AAAA']`（默认后者）；出现其他类型 → **422** |
| 执行前裁决 | `CapabilityBroker` 收到的事件若 `record.type ∉ {A, AAAA}` → 丢弃并记 `workflow.violation` |
| 事件总线 | 发布端即过滤，非 A/AAAA 的 `record_*` 事件**不进总线**（避免无谓唤醒与审计噪声） |
| 前端 | 记录类型多选只渲染 `A` / `AAAA` |

**能力影响（必须让使用者知道）**：

| 场景 | v1 |
|---|---|
| A/AAAA 变了 → 更新源站组回源 | ✅ |
| A/AAAA 变了 → 通知 / webhook / 只读核对 | ✅ |
| CNAME 变了 → 同步到另一厂商 | ❌ **不产生事件，不可用** |
| TXT 变了（如证书验证）→ 联动 | ❌ 不可用 |

> 扩展点：将来若要支持 CNAME 联动，只需放开 `recordTypes` 枚举 + 对应动作的地址类型校验，**现有结构不变**。
### 4.1 触发器类型

> **本版本不设计定时器（`schedule`）。** 工作流只能由真实事件或手动触发，**不存在 cron / 周期调度**。

| 类型 | 说明 | 来源 | 可触发的记录写动作 |
|---|---|---|---|
| `record.changed` | 记录创建/更新/删除/启停（**仅 `A` / `AAAA`**，见 §4.0.5） | 现有 `record_*` WS 事件 | ✅ 允许 |
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
  record?: { id: string; name: string; type: 'A' | 'AAAA'; value: string; oldValue?: string; ttl: number };
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
| ~~`workflow.call`~~ | **不提供**（§7.5 完全禁用工作流互调，此条仅为存证） |

**触发源 × 动作 的组合裁决**（在服务权限之上再加一层，见 §4.0.4）：

| 触发源 | 只读（`*.read`） | **写（`dns.record.write` / `origin.write`）** |
|---|---|---|
| `record.changed`（**仅 `A` / `AAAA`**，§4.0.5） | ✅ | ✅ |
| `domain.changed` | ✅ | ❌ **拒绝（422）**（§4.0：解析值不唯一） |
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
| R7 | 域名变动误触发记录写入（**目标不唯一** → 改错或批量覆盖；自激；`third_id` 窗口错写） | **硬性禁止 + 四层强制**（§4.0、§4.0.4）；技术上由「解析值不唯一」直接排除（§4.0.1） |
| **R8** | **`ModifyOriginGroup` 是整组覆盖语义，直接使用会丢失更新 / 误删源站 / 权重被清空** | 不再提供“自备完整数组”的形态；I1 走 read-modify-write（串行化 + 基线比对 + 原样回传），I2 走显式收敛（`collapse` 声明 + 影响面可见 + 被移除记录逐条 + 快照 + 写后校验），见 §3.7.9 |
| **Q1** | 「源站组」在 HiDNS 中**没有对应概念** | 需你确认是映射到 Cloudflare Tunnel、还是新增抽象；本文暂按 `tunnels` 候选处理 |
| **Q2** | 表达式与脚本并存是否会失控 | 建议 UI 默认只开放表达式，脚本作为"高级模式"并需管理员开启 |
| Q3 | 定时器的时区语义 | 建议统一 UTC 存储、按用户偏好渲染 |
| Q4 | 工作流级联（工作流调用工作流） | 建议 v1 不做，仅允许 `dns.*` 等基础动作 |
| **Q5** | 「域名变动不得写记录」是否也约束**只读**动作 | 按 §4.0.4 **只约束写动作**；若需连只读也禁，请明确，我会改为全禁 |

---

## 十二、分期落地建议

| 阶段 | 内容 | 产出 |
|---|---|---|
| P0 | 事件总线 + `WorkflowOperations` + 表达式求值器 + `meta` 候选接口 + **§4.0 组合裁决** + **EdgeOne 源站组能力（仅点对面收敛）** | 能跑"A/AAAA 变了 → 收敛源站组回源" |
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
| **§DNS提供商适配器（新增硬约束）** | **核心不得建模 Provider 私有资源层级**：能力接口一律使用不透明字符串（`scopeId` 等），由 Provider 把自己的概念映射进通用槽位（参照 `domains.third_id`）。任何为某厂商某资源新增核心表/核心列的提案，必须先判定"是否为 Provider 私有结构"，若是则一律下沉到适配器 |
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
| D6 | **只读动作不设触发源限制**；仅写动作受 §4.0 约束 | §4.0.4 |
| D7 | **DNSPod 不声明 `originGroup`**（纯解析，无边缘加速源站组），仅鉴权体系相同 | §3.7.4 |
| D8 | 源站组写入 **v1 只提供 I2 点对面** `origin.replaceGroup`（整组收敛为单一目标，须 `collapse: true`）；**I1 点对点延期 v2**（性能 / 竞态 / 使用频次）。**不提供“调用方自备完整数组”的形态** | §3.7.7、§3.7.9 |
| D9 | 点对点的定位键（**v2 启用时才适用**）：默认用 **`record` 地址**（DDNS 场景用事件 `oldValue`），`recordId` 不持久化，命中数必须恰好 1，`>1` 一律报错。**v1 不涉及定位** | §3.7.5.2 |
| D10 | **不能用备注定位**——EdgeOne `OriginRecord` 无备注字段。**也不得在核心库存别名**（`origin_aliases` 已否决：会把 Provider 资源层级写进核心）。可读名只作表达式节点的显示标签，不参与定位；定位只用 `record`/`recordId` | §3.7.5.1、§3.7.5.8 |
| D11 | **核心不得建模 Provider 私有结构**：能力接口一律用不透明字符串（如 `scopeId`），Provider 自行把概念映射进通用槽位，与 `domains.third_id` 同构 | §3.7.4、§3.7.5.8 |
| D12 | **EdgeOne 源站组允许只有 1 条源站**（项目方确认）。I2 收敛后组内恰为单条，**不设**"整组广播"退化路径；服务端若拒绝则 `CollapseUnsupported` fail-closed | §3.7.9.6 |
| D13 | **不得以「域名」为单位修改解析**——`A`/`AAAA` 是多值记录，「域名的解析值」不是可观测对象，按域名写入无法定义唯一目标。写入必须落到**具体记录**（`recordId` 唯一）。域名变动类触发器禁止作为任何解析写动作的触发源 | §4.0 |
| D14 | **`record.changed` 只监听 `A` / `AAAA`**；其余记录类型（CNAME/MX/TXT/NS/SRV/CAA…）不产生事件、不可订阅 | §4.0.5 |
| D15 | **v1 无「只改一条」动作**，工作流对源站组的任何写入都是收敛 → 工作流应只操作**专用单源站组**，多源站组由人工维护 | §3.7.10 |

## 十四、仍待确认

1. **`ActionClass` 分类方式**（§十五）是否认可，以便 P0 落地组合裁决。

~~EdgeOne 源站组是否允许只有 1 条源站~~ —— **已确认允许**（项目方确认），见 D12 与 §3.7.9.6。


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



