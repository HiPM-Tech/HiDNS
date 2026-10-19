# HiDNS 自动化工作流引擎设计方案

> 状态：**设计稿（未实现）**
> 版本：v1
> 日期：2026-10-13
> 依据：`root.ai.md`（911 行）、`docs/api.md`（第一权威）
> 约束：本文档只描述设计与规划，**不包含任何实现代码**。示例中的域名为演示占位符。

---

## 一、设计目标与非目标

### 1.1 目标

用**声明式语言**描述"当什么发生 → 条件 → 做什么"，把 DNS 变更、监控事件变成可编排的自动化能力，且：

- 用户写的是**解释性语言**（结构化声明），**不是可执行代码**——无 JS、无 `vm`、无 Worker 执行用户代码；
- 能力来自 **HiDNS 托管的动作注册表**，用户不写基础设施代码；
- **鉴权与实际出站访问全部由 HiDNS 代理**，声明里拿不到任何凭据；
- **主核心不对外暴露**：只暴露"调用"，不暴露数据。用户与工作流**读不到鉴权、读不了用户、够不到数据库**（§5.6）。

### 1.2 非目标（明确不做）

| 不做 | 原因 |
|---|---|
| 执行任何用户提交的代码（含 `eval` / `Function` / `vm` / Worker） | 可执行代码 = 图灵完备攻击面，权限无法在保存期枚举 |
| 允许声明读写文件、访问 `process`、原生网络 | 同上；一切副作用只能经注册表动作 |
| 让声明持有 DNS 厂商密钥或 API Token 明文 | 凭据只存在于宿主进程内存，声明里只见"动作全名" |
| 在声明里直接拼 SQL 或引用表名/列名 | 违反 `root.ai.md` §数据库 2，一律走 BAL；DSL 无任何 DB 节点 |
| 图灵完备的通用编程语言（含循环、递归） | 能力面必须**封闭且可静态枚举**，否则保存期无法判定权限 |
| 暴露用户实体、鉴权数据、系统设置给 DSL | 主核心仅在内部可达（§5.6） |

---

## 二、整体架构

```
┌──────────────────────────────────────────────────────────────┐
│                        事件源（宿主侧）                        │
│  记录变更 · 域名变更 · NS 监控 · WHOIS 到期 · 手动             │
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
│ ExpressionEvaluator│            │   Interpreter（声明式）    │
│ 字段/函数/变量求值  │            │  无文件·无导入·无网络     │
└───────────────────┘            └────────┬─────────────────┘
                                          │ 只能调用宿主注入的能力
                                          ▼
┌──────────────────────────────────────────────────────────────┐
│                     CapabilityBroker（能力代理）               │
│  dns.* · ext.*（提供商扩展）· http.outbound.fetch · notify.channel.send      │
│  ── 负责：鉴权裁决 · 凭据注入 · 出站代理 · 限流 · 审计          │
└───────────────────────────┬──────────────────────────────────┘
                            ▼
     DnsProviderService / fetchWithFallback / notification / BAL
```

### 2.1 分层与项目既有规范的对齐

| 本项目约束（`root.ai.md`） | 本设计如何遵守 |
|---|---|
| §数据库 2：所有 DB 操作经 BAL | 持久化全部经新增的 `WorkflowOperations`（BAL 层），路由与引擎**不触碰** `db/dal`、`db/dl` |
| §服务层 376/387：禁止路由直接操作数据库 | 路由只做参数校验与转发，逻辑在独立模块 `server/src/workflow/`（§2.2） |
| §日志相关：`createLogger` + 子模块 + 限流 | 引擎统一 `createLogger('Workflow')`，同源日志限流（见 §3.6） |
| §DNS提供商适配器 272：必须经 `fetchWithFallback` | `http.outbound.fetch` 内部固定走 `fetchWithFallback`，DSL 无法绕过 |
| §安全规范：细粒度权限 | 复用 `AVAILABLE_SERVICES` 与 `TokenPayload`（见 §5） |
| §提交相关 3：根目录不放 MD | 本文档位于 `docs/` |
| §外部集成 768：`docs/api.md` 是第一权威 | 新增端点必须同步 `docs/api.md`（见 §9 交付清单） |
| §应用初始化 470：系统状态统一由 `systemState` 维护 | 引擎与 Broker 一律经 `isSystemInitialized()` 判定，**禁止**自行探测数据库或初始化态；事件总线订阅必须在 `start()` 内注册，**禁止模块作用域副作用**（`groupedCacheJob` 的教训） |
| §路由 354-355：`initCheckMiddleware` 默认拒绝 + 显式豁免 | `/api/workflows` 天然落入默认拒绝；**严禁**把它加入豁免清单（豁免清单仅 `/api/init` 与明确公开路由，如 `/api/rdap`） |
| §服务层 401-405：任务管理器强制语义 | 若复用 `taskManager` 执行工作流：异步延后重排 + 重排次数上限 + 兜底超时 + 同源日志限流，四条缺一不可 |
| §数据库 5：DSM 声明式 | 新表在 `complete-schema.ts` 声明，由 `schema-reconciler` 同步；**禁止手写 DDL** |
| §客户端 506+：前端模块化强制约束 | 落位见 §十；禁止重复实现既有组件、禁止页面内直接 `fetch`、文案走 i18n |
| §代码审核团 4：审查留档 | 设计/代码审查文件落 `ai-censorship/[模型名]_review-YYYYMMDD.md` |

---

### 2.2 模块归属：`server/src/workflow/`（独立一级模块，不并入 `service/`）

工作流引擎是**抽象功能**，不属于任何单一业务域——它同时消费 DNS 事件、调用 DNS 能力、发出网络请求、写审计。因此**不放进 `service/`**，而是作为 `server/` 下的独立模块单独列出：

```
server/src/
├── workflow/                  ← 新增：独立模块
│   ├── index.ts               统一出口 startWorkflowModule() / stopWorkflowModule()
│   ├── engine.ts              触发器匹配、执行编排
│   ├── event-bus.ts           进程内发布/订阅（订阅在 start() 内注册）
│   ├── broker.ts              能力代理：鉴权裁决 · 凭据注入 · 出站代理 · 限流 · 审计
│   ├── expression/
│   │   ├── parser.ts          表达式 AST
│   │   ├── evaluator.ts       纯函数求值
│   │   └── validate.ts        保存期校验（含 §4.0 组合裁决）
│   ├── interpreter/
│   │   ├── nodes.ts           节点白名单（封闭枚举）
│   │   ├── eval.ts            逐节点求值，无 eval / Function
│   │   └── limits.ts          深度 / 节点数 / 超时 / 调用配额
│   ├── actions/
│   │   ├── namespaces.ts      本子系统认领的命名空间（NamespaceClaim[]）
│   │   ├── validate-names.ts  命名空间与唯一性校验（单一定义源）
│   │   ├── modules/           各模块认领与二次下派
│   │   ├── {dns,http,notify,var}/  L3 动作实现
│   │   └── registry.ts        ALL_ACTIONS 唯一动作索引
│   └── types.ts
├── types/namespace.ts         ★ 全局主核心：TOP_NAMESPACES 白名单 + NamespaceClaim 契约
├── namespace-registry.ts      ★ 组合根：汇总各子系统认领（ALL_NAMESPACE_CLAIMS）
├── service/                   既有业务服务（不含工作流）
├── routes/workflows.ts        ← 新增：只做参数校验与转发
├── lib/dns/providers/         既有：提供商目录（含各自的 extra.ts）
└── db/                        既有：四层数据库架构
```

**三条边界**：

| 边界 | 规则 |
|---|---|
| 与路由 | `routes/workflows.ts` 只做参数校验与转发；**不得**直接触达 `workflow/` 内部实现或数据库（§服务层 387） |
| 与数据库 | `workflow/` 经 **BAL**（`WorkflowOperations`）持久化，禁止 `db/dal`、`db/dl`、`db/dsm`（§数据库 2） |
| 与初始化 | 启停由 `app.ts` 调用 `startWorkflowModule()` / `stopWorkflowModule()`；状态判定一律经 `systemState.isSystemInitialized()`（§应用初始化 470） |
| 与命名空间 | **顶级前缀白名单归全局主核心**（`types/namespace.ts`），工作流只是认领方；依赖方向为 `workflow → types/namespace`，**主核心不反向 import 任何子系统** |
| 与调用方式 | 内部模块互相调用走**文件引用**，不经注册表；对外（DSL/API）**只能**经注册表按前缀派发，禁止动态 `import()`（§2.3） |

> **为什么独立成模块而不是 `service/workflow/`**：`service/` 的语义是"某个业务域的服务"。工作流是**跨域编排层**——它会调用 `service/` 里的服务（如 `dns-provider-service`），但反过来 `service/` 不应依赖它。独立一级模块让这条依赖方向在目录结构上就成立，而不是靠口头约定。
### 2.3 双通道调用：文件引用（内部）与前缀声明（对外）

两种调用方式并存，**用途不重叠**：

| 通道 | 使用者 | 形式 | 目的 |
|---|---|---|---|
| **文件引用** | 项目内部代码 | `import { updateRecord } from './dns/record'` | 模块调用链路清晰，依赖在编译期可见 |
| **前缀声明** | 工作流 DSL / 外部 API | `dns.record.update({...})` | 方便人类书写；只暴露**已注册**的能力，核心不泄露 |

**规则一 · 内部只用文件引用。** 服务层、路由、任务之间的互相调用走 `import`，不进注册表——注册表不是内部 IOC 容器。

**规则二 · 对外只用前缀。** 任何"由用户数据决定调用什么"的路径（声明式 DSL、外部 API）**只能**经注册表派发，**禁止**拼接模块路径或动态 `import()`。这正是"避免核心泄露"的执行点：用户能触达的只有注册过的动作全名。

**双向注册**：声明与实现一一绑定，两个方向都有用途。

```
声明（人类可读：参数 / 权限 / 风险）  ──▶  分派表（运行时按全名调用 handler）
      ▲                                        │
      └───  反向收集（生成文档 / 控件 / 沙箱面）  ◀── 实现（文件里的 handler）
```

| 方向 | 作用 |
|---|---|
| **正向** | `dns.record.update` → 解析到对应 handler 执行 |
| **反向** | 从实现汇集出动作清单 → 生成 `docs/api.md`、前端控件、DSL 动作候选、权限枚举 |

由此得到一条默认安全态：

| 状态 | 含义 |
|---|---|
| **只实现、未注册** | 内部函数，用户**不可达**——核心的默认形态 |
| **只注册、未实现** | CI 直接报错（A2 / A5），不允许存在 |
| **已注册且已实现** | 对外可用 |

**人类友好入口（facade）**

前缀是给**人**用的写法，文件是给**项目**用的结构。对外暴露静态 facade：

```ts
// 用户侧（DSL / API）
dns.record.update({ domain, name, type, value, ttl });
ext.tencenteo.originGroup.replace({ scopeId, groupId, target, collapse: true });
```

facade 必须是**静态文件**（类型可见、可审计、可 IDE 补全），**不得**用运行时 `Proxy` 动态生成——Proxy 会让类型与实现脱钩，审计时看不出到底暴露了哪些能力。facade 与注册表的一致性由 CI 保证（见计划 A7），不靠人工同步。

**唯一签名**：facade 与注册表共用同一个 `ActionHandler(ctx, args)`；核心对象（BAL、provider adapter、凭据）**不出现在任何参数里**，只在 handler 内部经宿主获取。

> **两条通道的差别只在"怎么找到能力"，不在"要不要鉴权"。** `ctx` 只能由 `authorize()` 签发（私有 brand），所以无论是内部 `import` 还是对外前缀调用，**没有授权就拿不到 ctx，handler 根本调不动**。完整裁决链见 §5.0。
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

> 注意：上述示例中的 `{鉴权账号}` 在**声明层不应出现**。见 §5.4——声明永远拿不到凭据，该占位符在 UI 层是"以哪个身份执行"的选择器，运行时由宿主持有。

### 3.2 表达式语法（面向前端结构化编辑，非自由文本）

为避免解析歧义与注入，**存储为结构化 JSON**，UI 负责渲染成上面的自然语言。语法树：

```json
{
  "type": "call",
  "fn": "dns.record.update",
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

- 引擎日志统一 `createLogger('Workflow').sub('Engine' | 'Interpreter' | 'Broker')`。
- **同一工作流的失败日志必须限流**（遵守 §日志相关 9），避免重试风暴刷屏。
- 每次运行产出 `WorkflowRun` 记录：状态、耗时、每个动作的输入摘要（脱敏）、错误。

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

> **定位方式**：源站组统一用**源站组 ID**（`GroupId`）定位，由 API 拉取——`DescribeOriginGroup` 配 `Filters: [{ Name: 'origin-group-id', Values: [groupId] }]`。**禁止**用"全量列出再本地查找"：源站组数量无上限，全量拉取既慢又可能被分页截断。拿到结果后仍按 `GroupId` 精确比对一次，防服务端忽略 filter 时误取。

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
| `Record` | 源站地址，**接受 IPv4 / IPv6 / 域名**三种形态（项目方确认） |
| `Type` | `IP_DOMAIN` 或 `AWS_S3`（对象存储） |
| `Weight` | **权重，取值 0–100**（官方错误码 `InvalidParameter.OriginRecordWeightValue` 明确） |
| `Private` / `PrivateParameters` | 第三方对象存储私有访问参数 |

> **重要**：官方描述明确「此处配置的源站组可于**添加加速域名**和**四层代理**等功能中引用」。这直接印证 §3.7 的界定——源站组服务于**边缘加速回源**，不是 DNS 解析记录。

#### 3.7.4 提供商特有能力的通用扩展机制（两级前缀命名）

> **这不是给 EdgeOne 开的特例，而是一套通用机制。** 任何提供商都可以在自己的目录里声明**独有的特有能力**；核心不认识它们的语义，只校验**命名**与**唯一性**。

**命名规则（强制）：两级前缀 + 自定后缀**

```
<顶级前缀>.<二级前缀>.<后缀>
```

| 段 | 定义者 | 下派方式 | 归属 |
|---|---|---|---|
| **顶级前缀** | **核心** | **白名单，统一下派** | 核心独占；模块**不得**自行新增 |
| **二级前缀** | **各模块** | 模块认领顶级前缀后**二次下派** | 模块独占；提供商**不得**自行新增 |
| **后缀** | 归属方 | — | 模块 / 提供商自定，全名**全局唯一** |

**授权链：核心 → 模块 → 提供商，每一级只发下一级**

```
HiDNS 全局主核心（server/src/types/namespace.ts）
 └─ TOP_NAMESPACES 白名单（唯一定义源，封闭）
      └─ 统一下派：任一子系统认领一个顶级前缀（一对一，不得抢占）
           └─ 子系统二次下派：自己定义二级前缀白名单
                └─ 归属方只能在 (顶级, 二级) 之后自由命名
```

三级都不可越权：**子系统不能造顶级前缀，提供商不能造二级前缀。**

> **白名单属于 HiDNS 全局主核心，不属于工作流模块。** 工作流只是**认领方之一**。若把 `TOP_NAMESPACES` 放进 `workflow/`，等于让工作流自己给自己发牌照——`dns` 这类顶级前缀是 HiDNS 的能力域，不是工作流的私产；将来 MCP、插件系统或其他子系统同样要认领命名空间时，会与工作流的私有白名单冲突且无从仲裁。

**全局主核心**（唯一来源；其它任何文件不得出现第二份）

```ts
// server/src/types/namespace.ts —— 全局主核心，不依赖任何子系统
export const TOP_NAMESPACES = ['dns', 'ext', 'http', 'notify', 'var'] as const;
export type TopNamespace = typeof TOP_NAMESPACES[number];

/** 已登记但未认领：不得出现在任何动作名里 */
export const RESERVED_TOP_NAMESPACES = ['cache', 'queue', 'storage', 'platform'] as const;

/** 主核心下派的契约：任何子系统都必须按此声明 */
export interface NamespaceClaim {
  /** 认领方标识，用于冲突报错，如 'workflow'、'mcp' */
  owner: string;
  /** 只能取自白名单 */
  top: TopNamespace;
  /** 该子系统二次下派的二级前缀 */
  second: readonly string[];
}

/** 由 (top, second) 推导的合法动作名形状 —— 编译期校验用 */
export type ActionNameOf<C extends NamespaceClaim> =
  `${C['top']}.${C['second'][number]}.${string}`;
```

**认领与汇总**：各子系统在自己的目录里声明 `NamespaceClaim`，由**组合根**汇总成唯一认领表。主核心不 import 任何子系统，依赖方向保持单向。

```ts
// workflow/actions/namespaces.ts —— 工作流只是认领方
export const workflowNamespaceClaims = [
  { owner: 'workflow', top: 'dns',  second: ['record', 'domain'] },
  { owner: 'workflow', top: 'ext',  second: PROVIDER_TYPES },
  { owner: 'workflow', top: 'http', second: ['outbound'] },
  { owner: 'workflow', top: 'notify', second: ['channel'] },
  { owner: 'workflow', top: 'var',  second: ['workflow'] },
] as const satisfies readonly NamespaceClaim[];
```

```ts
// server/src/namespace-registry.ts —— 组合根，允许依赖各子系统
import { workflowNamespaceClaims } from './workflow/actions/namespaces';

export const ALL_NAMESPACE_CLAIMS = [
  ...workflowNamespaceClaims,
  // 将来：...mcpNamespaceClaims, ...pluginNamespaceClaims
] as const;
```

**二级前缀由各子系统自己下派**：`workflow` 把五个顶级前缀的二级清单集中在一个文件里（见上），`ext` 的二级前缀**动态取 `PROVIDER_TYPES`**，不硬编码——新增提供商时 `ext` 的认领自动扩展。

> 若某个子系统规模变大，可把它自己的认领拆成 `modules/<m>.ts` 再聚合；**主核心不关心拆分粒度**，它只校验 `ALL_NAMESPACE_CLAIMS` 的合法性。

**已分配的命名空间**

| 顶级前缀 | 认领模块 | 二次下派的二级前缀 | 示例 |
|---|---|---|---|
| `dns` | 解析记录 | `record` / `domain` | `dns.record.update`、`dns.domain.list` |
| `ext` | 提供商扩展 | **providerType**（动态取自 registry） | `ext.tencenteo.originGroup.replace` |
| `http` | 出站 | `outbound` | `http.outbound.fetch` |
| `notify` | 通知 | `channel` | `notify.channel.send` |
| `var` | 变量 | `workflow` | `var.workflow.get` |
| *预留* | — | **未认领** | `cache` / `queue` / `storage` / `platform` 已登记，**当前禁止使用** |

**提供商侧只有后缀是自定的**：

```
ext.tencenteo.originGroup            ← 能力名
ext.tencenteo.originGroup.list       ← 动作
ext.tencenteo.originGroup.get
ext.tencenteo.originGroup.plan
ext.tencenteo.originGroup.replace
```

- `ext` —— 顶级前缀，由**核心白名单**下派给扩展模块（提供商无权定义）
- `tencenteo` —— 二级前缀，由 **`ext` 模块二次下派**（等于 `ProviderDefinition.type`，必须完全一致）
- `originGroup` + 动词 —— 后缀，**提供商唯一能自定的部分**，语义自明（`originGroup`、`wafPolicy`、`edgeRule` …）

> **为什么前两级都不给提供商**：给一级，两家厂商可能都想叫 `originGroup`，甚至一家类型名为 `dns` 的厂商直接撞掉解析模块的命名空间；给二级，则 `ext` 之下同样可能撞名。把提供商压到**第三段起**，唯一性由**结构**保证；而顶级前缀的分配权始终留在核心，将来新增 `cache` / `queue` / `platform` 等模块，永远不必回头看厂商命名。

**能力声明结构**（提供商在 `providers/<provider>/extra.ts` 导出）

```ts
export interface ProviderExtraCapability {
  /** 全名：ext.<providerType>.<suffix>，全局唯一 */
  name: string;
  /** 面向用户的能力名（i18n key），核心不解释语义 */
  label: string;
  /** 该能力对外暴露的动作 */
  actions: ProviderExtraAction[];
}

export interface ProviderExtraAction {
  /** 动作全名：<capability.name>.<verb>，全局唯一 */
  name: string;
  /** 语义分类，供 §4.0 组合裁决使用 */
  actionClass: ActionClass;
  risk: 'low' | 'medium' | 'high';
  /** 所需服务权限，取自 AVAILABLE_SERVICES */
  service: AvailableService;
  /** 是否对声明式 DSL 可见（false = 仅 API 可达） */
  /** 是否对声明式 DSL 可见（false = 仅内部/API 可达） */
  dslVisible: boolean;
  /** 参数 schema，供表达式层渲染 {...} / [...] / (...) 三类控件 */
  params: ProviderActionParam[];
}
```

#### 3.7.4.1 重名防线：编译期 + CI，不以运行期为主界

重名必须在**构建阶段就失败**，不能留到运行时——能力名冲突一旦上线，表现为"某家厂商的动作被另一家覆盖"，是最难排查的一类故障。三层防线，越靠前越便宜：

| 层 | 时机 | 拦得住 | 拦不住 |
|---|---|---|---|
| **L1** | 编译期 `tsc` | 顶级前缀不在白名单、二级前缀不在模块白名单、前缀与提供商不匹配、格式错误 | 跨提供商的**重复**（类型系统无法表达"全局唯一集合"） |
| **L2** | 构建 / **CI** | 重复、**顶级前缀被两个模块同时认领**、**使用未认领的预留前缀**、`actionClass` / `service` 非法 | 绕过 CI 直接部署 `dist` |
| **L3** | 运行时启动 | 绕过构建的部署 | —（**不是主防线**，只是兜底） |

**L1 · 编译期绑定**（模板字面量类型）

```ts
// registry.ts
export type ProviderType =
  | 'aliyun' | 'aliyunesa' | 'baidu' | 'bt' | 'caihongdns'
  | 'cloudflare' | 'dnshe' | 'dnsla' | 'dnspod' | 'gcore'
  | 'hidns' | 'huawei' | 'huoshan' | 'jdcloud' | 'namesilo'
  | 'powerdns' | 'qingcloud' | 'rainyun' | 'spaceship' | 'tencenteo'
  | 'vps8' | 'west';

export type ExtCapabilityName<P extends ProviderType> = `ext.${P}.${string}`;
export type ExtActionName<P extends ProviderType> = `${ExtCapabilityName<P>}.${string}`;

export interface ProviderExtraCapability<P extends ProviderType> {
  name: ExtCapabilityName<P>;
  label: string;
  actions: ProviderExtraAction<P>[];
}
```

```ts
// tencenteo 的定义必须标注具体 ProviderType，否则模板类型退化为 string
const tencenteo: ProviderDefinition<'tencenteo'> = {
  type: 'tencenteo',
  // ...
  extraCapabilities: [{
    name: 'ext.tencenteo.originGroup',   // ✅
    // name: 'ext.dnspod.originGroup',   // ❌ tsc: 不能赋给 `ext.tencenteo.${string}`
    label: 'provider.tencenteo.origin_group',
    actions: [/* ... */],
  }],
};
```

**L2 · CI 门禁**（唯一性只能在这一层拦）

校验逻辑写成**单一定义源**，测试与 CLI 共用，避免两处漂移：

```ts
// workflow/actions/validate-names.ts
export interface NameConflict { name: string; owners: string[] }

export function validateActionNames(
  defs: readonly ProviderDefinition<ProviderType>[],
  builtins: readonly { name: string }[],
): NameConflict[] {
  const conflicts: NameConflict[] = [];
  const seen = new Map<string, string>();
  const claim = (name: string, owner: string) => {
    const prev = seen.get(name);
    if (prev && prev !== owner) conflicts.push({ name, owners: [prev, owner] });
    else seen.set(name, owner);
  };
  for (const p of defs) {
    for (const cap of p.extraCapabilities ?? []) {
      claim(cap.name, p.type);
      for (const a of cap.actions) claim(a.name, p.type);
    }
  }
  for (const b of builtins) claim(b.name, 'builtin');
  return conflicts;
}

// 命名空间授权链的校验（核心 → 模块）
export type NamespaceViolation =
  | { kind: 'not-whitelisted'; detail: string }   // 顶级前缀不在核心白名单
  | { kind: 'reserved'; detail: string }          // 占用了未认领的预留前缀
  | { kind: 'double-claim'; detail: string }      // 顶级前缀被两个模块同时认领
  | { kind: 'dup-second'; detail: string }        // 同一模块二级前缀重复
  | { kind: 'outside'; detail: string };          // 动作名不在任何模块下派的命名空间内

export function validateNamespaceClaims(
  claims: readonly NamespaceClaim[],
): NamespaceViolation[] {
  const out: NamespaceViolation[] = [];
  const owner = new Map<string, string>();
  for (const c of claims) {
    if (!(TOP_NAMESPACES as readonly string[]).includes(c.top))
      out.push({ kind: 'not-whitelisted', detail: `${c.owner}: ${c.top} 不在全局白名单` });
    if ((RESERVED_TOP_NAMESPACES as readonly string[]).includes(c.top))
      out.push({ kind: 'reserved', detail: `${c.owner} 占用了预留前缀 ${c.top}` });
    const prev = owner.get(c.top);
    if (prev) out.push({ kind: 'double-claim', detail: `${c.top} 被 ${prev} 与 ${c.owner} 同时认领` });
    else owner.set(c.top, c.owner);
    const dup = c.second.filter((s, i) => c.second.indexOf(s) !== i);
    if (dup.length) out.push({ kind: 'dup-second', detail: `${c.owner} 二级前缀重复: ${dup.join(',')}` });
  }
  // 每个非预留顶级前缀都必须被认领
  for (const top of TOP_NAMESPACES) {
    if (!owner.has(top)) out.push({ kind: 'not-whitelisted', detail: `${top} 未被任何子系统认领` });
  }
  return out;
}

export function validateActionPlacement(
  names: readonly string[],
  claims: readonly NamespaceClaim[],
): NamespaceViolation[] {
  const allowed = new Map(claims.map((c) => [c.top, new Set(c.second)]));
  return names
    .filter((n) => { const [top, second] = n.split('.'); return !allowed.get(top)?.has(second); })
    .map((n) => ({ kind: 'outside' as const, detail: `${n} 不在任何子系统下派的命名空间内` }));
}
```

```ts
// src/lib/dns/providers/registry.test.ts —— CI 直接跑
describe('动作命名空间', () => {
  it('不存在重名（含内置动作）', () => {
    expect(validateActionNames(providerDefinitions, BUILTIN_ACTIONS)).toEqual([]);
  });
  it('命名空间授权链合法：白名单内、一对一认领、未占预留', () => {
    expect(validateNamespaceClaims(ALL_NAMESPACE_CLAIMS)).toEqual([]);
  });
  it('所有动作名都落在其模块下派的命名空间内', () => {
    const names = [
      ...BUILTIN_ACTIONS.map((a) => a.name),
      ...providerDefinitions.flatMap((p) =>
        (p.extraCapabilities ?? []).flatMap((c) => [c.name, ...c.actions.map((a) => a.name)])),
    ];
    expect(validateActionPlacement(names, ALL_NAMESPACE_CLAIMS)).toEqual([]);
  });
  it('扩展能力全名格式与提供商前缀一致', () => {
    for (const p of providerDefinitions) {
      for (const cap of p.extraCapabilities ?? []) {
        expect(cap.name).toMatch(/^ext\.[a-z][a-z0-9]*\.[a-z][a-zA-Z0-9]*$/);
        expect(cap.name.startsWith(`ext.${p.type}.`)).toBe(true);
      }
    }
  });
});
```

接线：

```json
// server/package.json
"check:actions": "vitest run src/workflow/actions/__tests__/namespaces.test.ts"
```

```yaml
# .github/workflows/test-suite.yml（独立步骤，失败即红）
- name: Check action namespaces & uniqueness
  run: pnpm --filter dnsmgr-server run check:actions
```

> ⚠️ **现状缺陷（必须在落地前修）**：`.github/workflows/test-suite.yml:149` 现为 `pnpm --filter dnsmgr-server run test || echo "Server unit tests completed"`。`|| echo` 把退出码吞掉了，**测试失败不会让 CI 变红**——任何校验挂在这里都是装饰品。因此本校验必须走**独立步骤**且**不得**再挂 `|| echo`。

**L3 · 运行时兜底**（保留，但明确不是主防线）

`startWorkflowModule()` 启动时调用同一个 `validateActionNames()`，结果非空即抛错拒绝启动。22 家提供商的全量扫描是 O(n)、微秒级，代价可忽略；它的唯一价值是拦住"绕过 CI 直接跑 dist"的部署。

| 校验项 | 归属层 |
|---|---|
| 顶级前缀 ∈ `TOP_NAMESPACES`、二级前缀 ∈ 该模块 `second`、全名格式 | L1（编译期） |
| 顶级前缀**一对一认领**（无模块抢占）、**预留前缀未被使用**、每个非预留前缀都被认领 | **L2（CI · 声明级）** |
| 能力全名跨提供商唯一、动作全名唯一（含内置） | **L2（CI · 声明级）** |
| `actionClass` ∈ 枚举、`service` ∈ `AVAILABLE_SERVICES` | L1 + L2 |
| 每个 L3 实现导出的动作名前两段命中 `(top, second)`；实现的二级前缀**不得多于**声明；`second` 每项**至少一个**实现；与 `ALL_ACTIONS` 索引**双向一致** | **L2（CI · 实现级）** |

> **实现级校验**（上表最后一行）是必须的：只校验声明，等于默许"声明一套、实现另一套"。落到每个 `modules/<m>/index.ts` 的 `{ namespace, actions }` 做双向比对，才算真正落到子模块。完整规则见 `docs/WORKFLOW_ENGINE_NAMESPACE_PLAN.md` §5.2。

**适配器侧**：具体实现仍写在 `providers/<provider>/` 内（如 `origin-group.ts`），对外只暴露**裸原语**，所有保护在 `CapabilityBroker` 的动作层。

> 适配器层是**裸的**（与腾讯云 API 一一对应）：不做定位、不做保留、不做校验，传入什么就写什么。所有保护都在 `CapabilityBroker` 的动作层实现——这样"原始能力"与"受保护动作"的边界清晰，代码审查时一眼能看出哪层该有守卫。

**tencenteo 的私有 DTO**（核心只透传，从不解释）：

```ts
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

> **本章在 v1 中不落地。** 点对点在复杂场景下性能不佳（read-modify-write + O(N) 复核 + 按组串行），且匹配依赖 `oldValue` 与当前状态一致，地址快速漂移时失败方式不直观；实际使用场景也很少——**DDNS 走的是点对面**。v1 唯一写动作是 `tencenteo.originGroup.replace`（§3.7.9）。保留本章是为了让 v2 重启时有据可依，并让评审者看到"为什么不做"。

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
tencenteo.originGroup.updateRecord({
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
| `AAAA` 触发的 IPv6 目标 | **已确认支持**（源站接受 IPv6 / IPv4 / 域名）。但**内网 IPv6**（`::1` / `fe80::/10` / `fc00::/7`）仍会被服务端以 `InvalidParameter.InvalidOriginIp` 拒绝，预检必须覆盖，见 §3.7.9.5.1 |
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


#### 3.7.6 能力声明（`ProviderDefinition` 扩展）

**不往 `DnsCapabilities` 加布尔位。** 布尔位只能表达"有 / 无"，承载不了动作、参数、权限与风险级别——而提供商特有能力恰恰每样都需要。改为在 `ProviderDefinition` 上挂扩展能力列表：

```ts
interface ProviderDefinition {
  // ...既有字段（type / name / capabilities / configFields / adapterFactory）
  /** 提供商独有能力，可为空；核心只校验命名与唯一性（§3.7.4） */
  extraCapabilities?: ProviderExtraCapability[];
}
```

| 厂商 | 声明 | 说明 |
|---|---|---|
| `tencenteo` | `tencenteo.originGroup`（4 个动作） | 本次新增 |
| `dnspod` | **不声明** | DNSPod 是纯解析，**没有**边缘加速源站组；仅鉴权体系相同 |
| 其余 20 家 | 不声明 | — |

> 用户所述"鉴权套用 dnspod 和 edgeone"指**凭据体系相同**（均为腾讯云 `SecretId/SecretKey` + TC3），而非 DNSPod 也具备源站组能力。

**前端据此渲染**：某厂商未声明 `extraCapabilities` 时，表达式编辑器中**不出现**对应动作；声明了则按 `params` 自动生成控件（`{...}` 下拉 / `[...]` 可输入 / `(...)` 预览），核心与前端都不硬编码任何厂商名。

> **与 `root.ai.md` §适配器 302 的关系**：该条把 `DnsCapabilities` 与 `ProviderCapabilities` 混写、且写了不存在的 `line` 字段。本设计**不往 `DnsCapabilities` 加字段**，而是扩展 `ProviderDefinition`，因此该勘误**不阻塞本设计**；规范仍建议修正（见 §12.1）。

#### 3.7.7 动作、权限与触发约束

| 动作 | `ActionClass` | 风险级别 | 所需服务权限 | 写入意图 | 说明 |
|---|---|---|---|---|---|
| `tencenteo.originGroup.list` | `ext.read` | 低 | `records.read` | — | 只读 |
| `tencenteo.originGroup.get` | `ext.read` | 低 | `records.read` | — | 只读 |
| `tencenteo.originGroup.plan` | `ext.read` | 低 | `records.read` | — | 只读：生成 diff / 影响面 / digest（§3.7.9.2） |
| `tencenteo.originGroup.replace` | `ext.write` | **高** | `records.write` | **I2 点对面** | **v1 唯一写动作**：整组收敛为单一目标（§3.7.9） |
| ~~`tencenteo.originGroup.updateRecord`~~ | — | — | — | I1 点对点 | **v2 延期**，见 §3.7.5 与 §3.7.9.1 |

**v1 只有一个写动作：`tencenteo.originGroup.replace`。**

点对点（`tencenteo.originGroup.updateRecord`）**延期到 v2**，理由按权重排序：

| # | 理由 | 具体表现 |
|---|---|---|
| 1 | **性能** | 点对点是 read-modify-write：读整组 → 裁决 → 回写 → 再读整组逐字段复核，**单次事件 3 次 API 调用**，且读放大 O(N)、复核 O(N)；并发还要按 `groupId` 串行排队 → 事件密集时退化为队列堆积。点对面写入的是**与当前状态无关的收敛态**，O(1) 构造、无竞态、可重放 |
| 2 | **竞态** | 点对点的匹配依赖 `event.oldValue` 与"当前"状态一致。地址快速漂移（DDNS 抖动、多客户端同时上报）时匹配频繁落空，表现为**误 `skipped` 或误 `AmbiguousOriginMatch`**——失败方式既不直观也难以复现 |
| 3 | **使用频次** | 点对点的适用场景是"多源站组里只让一条跟随"，实际极少；**DDNS 根本不走它**（DDNS 要的是"整组回源到当前 IP"，正是点对面） |

> **延期不是删除**：契约与实现要点保留在 §3.7.5 与 §3.7.9.4 作为 v2 设计底稿。若将来重启点对点，必须先解决上表 1、2 两条，否则同样的性能与竞态问题会原样重现。

> 原草案的 `origin.replaceRecords({ records: [...] })`（调用方自备完整数组）**已移除**，理由见 §3.7.9.1。

**`tencenteo.originGroup.replace` 的能力边界**：

- 只会让条数**减少**（收敛到 1），绝不增加；
- 不能改组的 `Type`（`GENERAL`/`HTTP`）与 `HostHeader`；
- 不能跨组移动源站；
- **v1 没有任何"只改一条"的动作** → 工作流对源站组的每一次写入都是收敛。多源站组（多活 / 加权）**不应交给工作流维护**，见 §3.7.10。

**触发约束**：`ext.write`（v1 即 `tencenteo.originGroup.replace` 这一个动作）与 `dns.record.write` 同属「回源/解析目标变更」，因此**同样禁止由 `domain.changed` 触发**（§4.0 理由完全适用）。

> `ext.read` 不受 §4.0 约束——按已确认的 D6，**只读动作不设触发源限制**。

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

| | **I1 点对点** `tencenteo.originGroup.updateRecord`（v2） | **I2 点对面** `tencenteo.originGroup.replace`（v1） |
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
| F5 | **目标值预检** | 命中 §3.7.9.5.1 的任一拒绝规则（内网 IPv4 / 内网 IPv6 / 非法域名） | 服务端以 `InvalidParameter.InvalidOriginIp` 拒绝内网与回环地址；提前拦截给出可读错误，而不是等 API 报错 |
| F6 | **权重处理明确** | — | 收敛后单条不带 `Weight`（单源站无分配语义），写后回读确认；形态见 §3.7.9.6 |
| F7 | **幂等** | 组内已恰好 1 条且等于目标 → `skipped`，不发写请求 | 避免重复触发产生无意义写入与审计噪声 |

##### 3.7.9.5.1 目标值预检：三类地址各自的规则

源站 `Record` 接受 **IPv4 / IPv6 / 域名** 三种形态，`Type` 统一为 `IP_DOMAIN`（只有对象存储源站才是 `AWS_S3`）。因此 `tencenteo.originGroup.replace` 的 `target` 只需两个字段：

```ts
interface OriginTarget {
  record: string;              // IPv4 / IPv6 / 域名，由形态判定，不靠调用方声明
  type?: 'IP_DOMAIN';          // v1 固定且可省略；不接受 AWS_S3（见下）
}
```

预检按形态分流，**全部在进程内完成，不发任何 DNS 查询**：

| 形态 | 必须通过 | 拒绝 |
|---|---|---|
| **IPv4**（`net.isIPv4`） | 公网单播地址 | `10/8`、`172.16/12`、`192.168/16`、`127/8`、`169.254/16`、`100.64/10`（CGNAT）、`0.0.0.0`、`224/4`（组播）、`240/4` |
| **IPv6**（`net.isIPv6`） | 公网单播地址 | `::1`、`::`、`fe80::/10`（link-local）、`fc00::/7`（ULA）、`::ffff:0:0/96`（IPv4-mapped）、`ff00::/8`（组播）、`2001:db8::/32`（文档保留） |
| **域名**（非 IP 字面） | RFC 1035 hostname：总长 ≤ 253、单标签 ≤ 63、`[a-z0-9-]` 且不以 `-` 起止、**至少两个标签**、含 `_` 等非法字符即拒 | 单标签主机名（如 `intranet`）——按内网主机名处理；含空格 / 中文未 IDNA 归一化 / 尾部点之外的异常形态 |
| **其他** | — | 既不是合法 IP 也不是合法 hostname → `InvalidOriginTarget` |

> **不做 DNS 解析校验**：预检**不**查询域名解析结果，理由是那会把一次性校验变成一次出站请求（与 §5.5 的出站白名单、SSRF 防护冲突），且解析结果随时可变，校了也不作数。若域名解析到内网，由 EdgeOne 侧策略约束——这是**已记录的残余风险**，不是本设计的承诺。

**为什么 `type` 固定为 `IP_DOMAIN`**：工作流的目标永远是"回源到一个地址"。`AWS_S3` 源站需要 `Private` / `PrivateParameters`（对象存储私有访问凭据），让工作流构造这些参数意味着**凭据进入工作流配置**，与 §5.4「凭据零接触」直接冲突。因此 v1 不开放 `AWS_S3` 作为**写入目标**；它只可能出现在**被移除记录**里，由 F4 拦截。
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
tencenteo.originGroup.updateRecord({
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
tencenteo.originGroup.plan({ accountId, scopeId, groupId,
  target: { record: expr('event.record.value'), type: 'IP_DOMAIN' } })
  // → { collapsedFrom: 3, removed: [...], target: {...},
  //     references: [...], digest: 'sha256:…' }

// 第二步：commit（digest 必填）
tencenteo.originGroup.replace({
  accountId, scopeId, groupId,
  target: { record: expr('event.record.value'), type: 'IP_DOMAIN' },
  collapse: true,
  acknowledgeDataLoss: false,
  diffDigest: 'sha256:…'
})
```

**与 `dry-run` 的关系**：§九 的 `/api/workflows/:id/test` 对两条路线**都只执行到 Plan 阶段**，不落写入，返回 report 供确认。

**DSL 可用性**：声明**可以**调用这两个动作，但：

- `dslVisible` 必须为 `true`；
- U1–U5 / P1–P3 / F1–F7 同样强制，DSL 无法绕过；
- `diffDigest` 必须是**静态可判定**的字面量或 `ref`，**不得**由算子动态拼出（§6.3）；保存期无法静态确定的，拒绝保存。

> 一句话：开放的是**能力**，收紧的是**流程**——必须"看见再写"。



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

> **「域名变动」类触发器（`domain.changed`）禁止作为任何解析写动作（`dns.record.create` / `dns.record.update` / `dns.record.delete` / `dns.record.setStatus` / `dns.record.batch`）的触发源。**

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

> 本约束禁止的是**按域名**的写入，不是禁止工作流写解析。若需彻底禁止工作流写 DNS 记录（`dns.record.*` 整体移出动作集），改动点只有三处：§3.7.7 动作表、§十五 `ActionClass`、§4.0.4 组合裁决表——结构与其余章节不受影响。

### 4.0.4 运行时强制（不只是文档约定）

| 层 | 措施 |
|---|---|
| 保存校验（**已实现**） | `workflow/validate-payload.ts`：若 `trigger.type ∈ {domain.changed, …}` 且引用动作含任何**写能力**（`dns.record.write` / `ext.write`）→ **拒绝保存**，返回 422 并列出具体动作名 |
| 执行前裁决 | `CapabilityBroker` 在每次记录写动作前校验 `(triggerType, action)` 组合，命中即拒绝（防绕过校验直接改库） |
| 前端 | 选择「域名变动」触发器后，动作面板**隐藏**记录写动作；选择记录写动作时，触发器下拉中禁用域名变动类 |
| 审计 | 若被拒，记录 `workflow.violation` 审计事件并告警 |

**允许的替代路径**（这是用户真正想表达的意图）：

| 意图 | 正确做法 |
|---|---|
| IP 变了要更新解析 | 用 `record.changed` 触发 `dns.record.update`；或由外部 DDNS 客户端经 API 上报后触发 |
| 域名同步后要校验记录 | 用 `domain.changed` 触发**只读**能力（`dns.record.list`），仅做检查/告警，**不改写** |
| 需要"跨厂商同步解析" | 用 `record.changed` 触发 `dns.record.update` 到另一个账号/域名 |

> 换言之：**只读能力完全不受此约束**（本轮已确认）。`domain.changed` 可以触发 `dns.record.list`、`tencenteo.originGroup.list`、`notify.channel.send`、`http.outbound.fetch`、`var.workflow.get` 等；被禁的只有**写动作**（`dns.record.write` 与 `ext.write`）。

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

### 4.3 事件主线（已实现）

事件总线**归主核心**，不属于工作流：实现位于 `server/src/lib/domain-event-bus.ts`，工作流只是订阅者之一（`workflow/event-bus.ts` 为其兼容转发）。

**发布点覆盖全部记录写入路径**，而非只有路由：

| 路径 | 覆盖 | 说明 |
|---|---|---|
| `routes/records.ts` | 创建 / 更新 / 删除 / 状态变更 / 批量创建 | 删除与状态变更需先回查记录类型（A/AAAA 判定所需） |
| `service/dns-provider-service.ts` | 创建 / 更新 / 删除 / 状态变更 | 服务层统一出口，覆盖故障转移与 MCP 等非路由调用方 |
| `workflow/actions/dns/record.ts` | 创建 / 更新 | 标记 `actor.source='workflow'`，由总线抑制以防自激 |
| `routes/domains.ts` | 域名生命周期 | PUT → `updated`（仅 `remark` / `is_hidden` / `enabled` 产生事件）；POST（手工新增与提供商同步）→ `created`；DELETE → `deleted`。**均不含解析值**（§4.0.1） |
| `service/domainRenewalJob.ts` | `renewed` | 续期成功后按域名反查 `domains` 主键再发布（`renewable_domains.id` 与 `domains.id` 不是同一实体） |
| `service/nsMonitorJob.ts` | `ns.changed` | 去重：`status !== previousStatus` 才放行，重复告警不重复触发 |
| `service/whois/notifier.ts` | `whois.expiring` | 剩余天数 ≤ 阈值即发布，**独立于通知开关**——工作流自行决定处置 |

**两条硬约束**：

1. **无订阅者时零成本**——发布入口先查 `hasDomainEventSubscribers()`，跳过构造与额外回查；否则等于给所有写入加一次无谓查询。
2. **发布失败不影响业务**——事件是旁路，异常一律吞掉并限流记录。

**仍未合并的一处**：WS 广播目前仍在路由内联（`record_created` / `record_updated` / …），尚未改成总线订阅者。原因是 WS 载荷形状（创建带 `record` 对象、更新只带 `recordId`）与总线事件不同构，直接改会破坏前端契约；合并需要同步调整客户端，留待独立任务。**在合并之前，两处并存不会产生重复事件**——总线目前没有 WS 订阅者。


---

## 五、鉴权复用设计（重点）

### 5.0 统一鉴权闸门：任何调用都必须先过 `authorize()`

> 内部文件引用与对外前缀声明，**只是"怎么找到能力"的差别，不是"要不要鉴权"的差别**。无论走哪条通道，执行前都必须拿到一个由 `authorize()` 签发的 `ActionContext`。

**做法：把授权变成类型约束，而不是流程约定。**

```ts
declare const AUTHORIZED: unique symbol;

/** 只有 authorize() 能造出这个对象（私有 brand） */
export interface ActionContext {
  readonly [AUTHORIZED]: true;
  readonly principal: Principal;
  readonly action: string;          // 已精确命中注册表的动作全名
  readonly resource?: ResourceRef;  // domainId / accountId / scopeId
  readonly traceId: string;
  readonly trigger: 'event' | 'manual' | 'api' | 'internal';
  readonly signal: AbortSignal;
}

/** 所有动作的唯一签名 —— 第一个参数必须是已授权上下文 */
export type ActionHandler = (ctx: ActionContext, args: JsonObject) => Promise<JsonValue>;
```

```ts
export async function authorize(
  action: string,
  principal: Principal,
  resource?: ResourceRef,
): Promise<ActionContext>;
```

`ActionContext` 带私有 brand，**手写一个对象冒充它在编译期就过不去**。因此 handler 无法在未授权状态下被调用——**内部调用同样如此**。

**`authorize()` 的裁决顺序**（任一失败即拒绝，不降级为匿名执行）：

| # | 校验 | 失败响应 |
|---|---|---|
| 1 | 动作名在注册表中**精确命中**（禁止前缀 / 通配 / 大小写变体） | 404 |
| 2 | `principal` 非空且未过期 | 401 |
| 3 | 服务权限：`principal.services ⊇ decl.service` | 403 |
| 4 | 资源权限：目标 domain / account 在 `principal.allowedDomains` 内 | 403 |
| 5 | 组合裁决：`(trigger, decl.actionClass)` 合法（§4.0） | 422 |
| 6 | DSL 通道：`decl.dslVisible === true`（否则仅 API 可达，DSL 调不到） | 403 |
| 7 | 速率与配额：`principal × action` 未超限 | 429 |
| 8 | **write-ahead 审计**：审计落库成功才放行 | 503 |

> 第 8 条是刻意的：**审计写不进去就不执行**。前缀面直接暴露核心能力，宁可拒绝服务，也不能留下无法追溯的执行痕迹。

**Principal 的三种来源**（全部显式，无隐式身份）：

| 来源 | 构造方式 | 约束 |
|---|---|---|
| 用户会话 | JWT → `userId` → 实时查角色与权限 | 权限**每次实时解析**，降权立即生效；缓存 TTL ≤ 60s 且带版本号失效 |
| API Token | `TokenPayload` → `allowed_services` / `allowed_domains` | 不得超出 Token 自身权限；**不得**因工作流创建者是管理员而提权 |
| 系统任务 | `SYSTEM_PRINCIPAL` | 权限集合是**枚举白名单**，**不等于管理员**；每次使用记审计 |

**禁止的三件事**：

1. **禁止隐式身份**——任何调用点都必须显式传 `principal`，不存在"内部调用所以免检"。
2. **禁止绕过 facade 直调注册表**——`dispatch()` 与 facade 共用同一条 `authorize()`，facade 只是语法糖。
3. **禁止通配匹配**——动作名必须精确等于注册表键；`ext.*`、`dns.record.*` 一律拒绝。

**为什么内部也要鉴权**：内部调用同样是"核心能力被使用"。若内部免检，任何能构造内部调用路径的代码（含将来的插件系统）就是一条提权通道。类型 brand 让"忘记鉴权"变成**编译错误**，而不是指望 code review 每次都能抓到。
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
| `dns.record.list` / `dns.record.get` | `records.read` |
| `dns.record.create` / `dns.record.update` / `dns.record.delete` / `dns.record.setStatus` / `dns.record.batch` | `records.write` |
| `dns.domain.list` | `domains.read` |
| `http.outbound.fetch` | `network.fetch`（新增服务权限） |
| `ext.*`（提供商扩展动作） | 由该动作声明的 `service` 决定，见 §3.7.4 |
| `notify.channel.send` | `notify.send`（新增服务权限） |
| ~~`workflow.call`~~ | **不提供**（§7.5 完全禁用工作流互调，此条仅为存证） |

> **服务权限命名沿用既有枚举**（`server/src/types/token.ts:50` 的 `AVAILABLE_SERVICES`，形如 `<资源>.<读|写>`：`domains.read/write`、`records.read/write`、`accounts.read/write`、`tunnels.read/write`、`system.read`）。本次新增 `network.fetch`、`notify.send`、`workflow.read`、`workflow.write`、`workflow.run`，与既有条目同形。

**触发源 × 动作 的组合裁决**（在服务权限之上再加一层，见 §4.0.4）：

| 触发源 | 只读（`*.read`） | **写（`dns.record.write` / `ext.write`）** |
|---|---|---|
| `record.changed`（**仅 `A` / `AAAA`**，§4.0.5） | ✅ | ✅ |
| `domain.changed` | ✅ | ❌ **拒绝（422）**（§4.0：解析值不唯一） |
| `ns.changed` / `whois.expiring` / `manual` | ✅ | ✅ |

### 5.4 凭据处理（声明零接触）

声明**不接收任何凭据**。`dns.record.*` 的签名只需要"域名 + 操作参数"，宿主内部：

1. 由 `domainId` 反查 `dns_accounts`（经 BAL `DnsAccountOperations`）；
2. 在**宿主进程内存**解密 `config`；
3. 调用 `DnsProviderService`；
4. 凭据只在调用栈存活，不进入求值上下文、不进入日志、不进入运行记录。

示例（声明里能表达的形态）：

```json
{ "call": "dns.record.update",
  "args": { "domain": "example.com", "name": "www",
            "type": "A", "value": { "ref": "event.record.value" },
            "ttl": 600 } }
```

> 声明里**没有**"账号"这一维：账号由宿主按域名反查。也**没有**密钥、代理、数据库连接——它们根本不在 DSL 的词汇表里。

> **DSL 动作候选与动作全名 1:1**：候选列表由注册表**自动生成**，不手工维护。这样不会出现"表达式里叫 A、文档里叫 B"的两套命名；未声明 `dslVisible: true` 的动作不会出现在候选里。

### 5.5 出站访问代理

`http.outbound.fetch` 固定受以下约束（DSL 无法覆盖）：

- 必须走 `fetchWithFallback`（复用现有代理配置与降级逻辑）；
- **出站域名白名单由管理员在系统设置中维护**（见 §5.5.1）；
- 仅允许 `https:`（可选放开 `http:`）；
- 无论白名单如何配置，**始终拒绝内网地址**（`127.0.0.0/8`、`10/8`、`172.16/12`、`192.168/16`、`169.254/16`、`::1`、`fc00::/7`），防 SSRF；
- 响应体大小上限（1 MiB）、超时上限（15s）、重定向上限，且**重定向目标同样逐跳校验**；
- 出站请求计入审计。

> 与 `root.ai.md` §代理模块 一致：声明无需也**不应**感知代理配置。

#### 5.5.1 管理员维护的出站白名单

- 存储：`SettingsOperations` 的 `workflow_http_allowlist`（系统设置项，复用现有设置机制，不新建表）。
- 形如：`["api.ipify.org", "*.cloudflare.com", "ifconfig.me"]`，支持精确域名与 `*.` 前缀通配。
- 匹配规则：**主机名精确或后缀匹配**，不匹配 IP 字面量；匹配前先做 IDN→Punycode 归一化（与 `root.ai.md` §外部集成 806 一致）。
- 空白名单 = **禁止一切出站**（fail-closed），而非"允许一切"。
- 修改白名单属于系统设置，**仅管理员**，且必须经 `system.read` / 管理员权限校验；变更写入审计。
- 前端在编辑器中**实时展示当前白名单**，避免用户写完后才发现被拦。

---

### 5.6 数据暴露面：DSL 够不到用户、鉴权与数据库

> **主核心不对外暴露，只在内部可达。对外只暴露「调用」，不暴露「数据」。**

| 面 | DSL 是否可达 | 说明 |
|---|---|---|
| 数据库（表 / 列 / SQL） | ❌ | DSL 无任何 DB 节点；动作参数里**不接受**表名、列名、SQL 片段 |
| 用户实体（`users`） | ❌ | 不提供 `users.*` 动作；`principal` 仅作 `authorize()` 输入，DSL **不可读其内容** |
| 鉴权数据（角色 / 权限表 / Token） | ❌ | 无 `auth.*` / `tokens.*` 动作，DSL 也无法枚举 principal 字段 |
| 系统设置 / 安全策略 | ❌ | 无 `settings.*` / `security.*` 动作 |
| 审计日志 | **只写不读** | 动作执行自动写审计；**不提供**查询动作给 DSL |
| DNS 记录 / 厂商账号 | ✅ 受限 | 只经 `dns.record.*` 等；账号由宿主反查，DSL 只见域名 |

**`principal` 是不透明句柄**：DSL 能做的只有"把它交给 `call`"，不能读字段、不能序列化、不能 `toJSON`。实现上在求值器上下文里它被冻结且不可枚举。

**「动不了所属用户的用户信息」**——当前动作集**不含任何用户管理能力**。若将来确需新增，必须同时满足：

1. 放在**独立顶级前缀**下（如 `user.*`），不得塞进 `dns` / `ext`；
2. 声明 `actionClass: 'user.write'`，纳入组合裁决；
3. 资源级校验**只能指向操作者本人**，禁止跨用户；
4. 保存期直接拒绝"触发器 → `user.write`"的组合。

**为什么这一节必须单独存在**：前缀面直接暴露核心能力，一旦某个动作的参数里漏进 `accountId` 之外的标识、或者某个 handler 顺手 `SELECT` 了 `users`，泄露就发生了，而 DSL 侧完全看不出异常。因此把它写成一张**逐面清单**，供审计逐条核对。
## 六、语言层：声明式解释器（**无可执行代码**）

### 6.1 定性：不是脚本，是可解释的声明

工作流权限敏感，因此**不引入任何形式的可执行代码**：没有 JS、没有 `vm`、没有 Worker 执行用户代码。用户提交的是**结构化声明（DSL 抽象语法树 JSON）**，由宿主用**白名单节点类型的解释器**逐节点求值。

| 项 | 结论 |
|---|---|
| 用户提交物 | DSL 语法树（JSON），**不是文本代码** |
| 求值方式 | 宿主内置解释器，逐节点求值 |
| 能否调用任意模块 | **不能**——节点只能引用注册表里的动作全名 |
| 能否自造运算符 | **不能**——运算符是封闭枚举 |
| 是否存在 `eval` / `Function` | **不存在**，全仓不出现 |

> 这不是实现偏好，而是安全边界：**可执行代码意味着图灵完备的攻击面**；声明式语言的能力面**在保存期就能完全枚举**，因此权限可以在落库前精确判定，而不是运行期靠沙箱兜底。

### 6.2 节点白名单（封闭枚举）

| 节点 | 说明 | 副作用 |
|---|---|---|
| `literal` | 常量（string / number / bool / null） | 否 |
| `ref` | 引用事件字段 / 局部变量 / 上次运行结果 | 否 |
| `compare` | `==` `!=` `>` `>=` `<` `<=` `in` | 否 |
| `logic` | `and` `or` `not` | 否 |
| `arith` | `+ - * / %` | 否 |
| `concat` | 字符串拼接 | 否 |
| `cond` | `if / then / else` | 否 |
| `call` | 调用**注册表内**的动作全名 | **是**（唯一有副作用的节点） |
| `assign` | 写工作流局部变量 | 否（仅本工作流作用域） |

**新增节点类型属于规范变更**：必须同时更新求值器、保存期校验、前端渲染与 CI 白名单，缺一不可。

### 6.3 求值器的硬边界

| 约束 | 值 |
|---|---|
| 最大深度 | 64 层 |
| 最大节点数 | 2000 |
| 单次求值超时 | 5s（动作内部另有超时） |
| 单次运行动作调用数 | 50 |
| 递归 / 循环 | **不支持**（无 `loop` 节点；重复由触发器多次触发表达） |
| 动态动作名 | **禁止**：`call.action` 必须是字面量，由保存期校验静态确定 |

> **`call.action` 必须静态可判定**是这一层最重要的约束。动作名一旦可动态拼接，权限就无法在保存期枚举，必须退化为运行期判定——而那正是"用户直接暴露核心面"最危险的形态。

### 6.4 没有脚本之后，表达能力怎么办（如实说代价）

去掉可执行代码是有代价的，必须写清楚，而不是假装没有：

| 场景 | 能否覆盖 | 替代做法 |
|---|---|---|
| 单值条件 + 动作 | ✅ | 原生支持 |
| 多步动作编排 | ✅ | 顺序节点 |
| 条件分支 | ✅ | `cond` 节点 |
| 遍历一组记录 | ⚠️ 部分 | 触发器**按记录逐条触发**（每条一次运行）；批量语义由宿主内部循环实现，DSL 只表达"对一个集合应用某动作" |
| 任意数据变换 / 递归算法 | ❌ | **不提供**。需要时走外部系统 + 回调 API |

> 若将来确需更强表达力，正确方向是**新增受限节点类型**（仍封闭、仍可静态枚举），而**不是**放开代码执行。一旦允许代码，保存期就再也无法枚举权限。

### 6.5 可审计性收益

把"代码"换成"声明"换来的不是便利，而是可判定性：

| 能力 | 有代码执行时 | 纯声明式 |
|---|---|---|
| 保存期枚举所需权限 | 不可能 | **可精确枚举** |
| 静态拦截非法组合（§4.0） | 只能运行期兜底 | **保存期即拒（422）** |
| 审计完整性 | 依赖运行期埋点，可能遗漏分支 | **节点树即执行路径**,无隐藏分支 |
| 前端预览 | 无法预测 | **可逐步模拟求值** |

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
2. **同源抑制 + 深度递增**：工作流自身写入产生的事件标记 `actor.source='workflow'`，默认**不触发**任何工作流；即使显式允许自触发，动作派发时 `depth = 事件深度 + 1`，链路 `traceId` 透传，超过 `maxDepth`（默认 3）由总线丢弃——**没有深度递增的 depth 限制是死代码**；
3. **令牌/时间窗去抖**：同一 `(workflowId, domainId, recordId)` 在窗口内（默认 10s）只执行一次，重复事件合并。

### 7.3 幂等

- 动作层幂等：`dns.record.update` 先查后写；值相同则**跳过**并记录 `skipped`。
- 与 `root.ai.md` §外部集成 804"创建记录前先查询、存在则更新"一致。

### 7.4 重试与超时

| 项 | 默认 | 上限 |
|---|---|---|
| 动作重试 | 0 | 3 |
| 重试退避 | 1s 指数 | 30s 封顶 |
| 动作超时 | 10s | 60s |
| 整体运行超时 | 30s | 5min |

> 重试必须遵守 §日志相关 9 的限流要求。

**若复用 `taskManager` 承载工作流执行**，必须同时满足 `root.ai.md` §服务层 401-405 的四条强制语义：同 ID 冲突任务**异步延后重排**（禁止在 `processQueue` 循环内同步塞回队首）、重排次数上限、兜底超时（不允许无界运行）、同源高频日志限流。少任一条都会重现那次活锁事故。

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
| 保存校验 | DSL 中出现任何工作流调用节点 → 拒绝保存（422） |
| 声明式语言 | 无代码执行；节点白名单封闭，`call.action` 静态可判定（§6.2、§6.3） |
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
| `GET` | `/api/workflows/meta/{source}` | `workflow.read` | **候选值**（供 `{...}` / `[...]` 下拉）。已实现源：`actions` / `triggerTypes` / `recordTypes` / `domainFields` / `nsStatuses` / `domains` |

**管理端点必须 `requireJwtAuth`**（禁止 API Token 管理工作流），与 `root.ai.md` 对管理员/敏感路由的既有做法一致。

**路由归属与门禁**：

| 项 | 要求 | 依据 |
|---|---|---|
| 认证 | 全部端点注册 `authMiddleware` | §中间件 332 |
| 管理动作 | 创建 / 更新 / 删除 / 测试 / 手动运行追加 `adminOnly` + `requireJwtAuth` | §中间件 333-334 |
| 初始化门禁 | `/api/workflows` **不加入** `initCheckMiddleware` 豁免清单，天然受 503 保护 | §路由 354-355 |
| 状态判定 | 路由内**不得**自行判断初始化状态，一律由中间件与 `systemState` 承担 | §应用初始化 470 |
| 频率限制 | `POST /:id/test` 与 `POST /:id/run` 必须挂 `rateLimit` | §安全规范 3 |

`meta/{source}` 需实现 §3.3 的候选源，并对 `records`/`lines` 支持 `?domainId=` 级联参数。

---

## 十、前端交互（对应三类标记）

| 控件 | 数据来源 | 校验 |
|---|---|---|
| `{...}` 仅下拉 | `meta/{source}` | 必须命中候选 |
| `[...]` 可输入 | `meta/{source}`（可为空） | 自由文本需再过一遍格式校验 |
| `(...)` 预览 | 使用**最近一次真实事件**渲染 | 无事件时显示"等待触发" |

**预览渲染**：`(...)` 必须用"样例事件"或"上次运行的真实事件"渲染真实值，而不是显示变量名——这直接对应需求中"实时渲染的预览"。

### 10.1 前端落位（遵守 `root.ai.md` §客户端架构 2 的强制模块化约束）

| 内容 | 位置 | 约束 |
|---|---|---|
| API 封装 | `client/src/api/workflows.ts` | 按模块分组，统一从 `api/index.ts` 导出 |
| 页面 | `client/src/pages/` | 工作流列表 / 编辑器各一个页面 |
| 可复用组件 | `client/src/components/` | 如 `WorkflowActionPicker.tsx`、`ExpressionInput.tsx` |
| 业务 Hook | `client/src/hooks/` | 如 `useWorkflows.ts`，复用既有 `useQueryConfig` / `useToast` |
| 纯函数 | `client/src/utils/` | 表达式序列化与校验，**无副作用** |
| 文案 | `client/src/i18n/` | 新增 key，**禁止硬编码中文** |

> 另外三条硬禁止：**页面内不得直接 `fetch`**（一律经 `api/` 封装）；**不得重复实现**既有的 `Table` / `PaginatedSelect` / `ConfirmDialog`（§客户端 507「禁止重复代码和自由发挥」）；**不得新造表单同步逻辑**，优先复用 `useFormSync`（§客户端 549 标注 P0+ 强制使用）。

---

## 十一、风险与开放问题

| 编号 | 风险 | 缓解 |
|---|---|---|
| R1 | 声明式语言被扩展出代码执行能力（如新增 `eval` 节点） | **规范硬禁止**：节点白名单封闭（§6.2），新增节点须同时改求值器/校验/前端/CI；审计项逐条核对 |
| R2 | 工作流自激循环 | 三重防循环（§7.2） |
| R3 | 凭据经日志/运行记录泄露 | 凭据不入求值上下文；`input_digest` 只存摘要（§5.4、§8） |
| R4 | SSRF（`http.outbound.fetch` 打内网） | 协议白名单 + 内网地址拒绝 + 重定向复检（§5.5） |
| R5 | 权限提升 | Principal 取创建者现行权限，Token 触发不得提权（§5.2） |
| R6 | 表达式伪造成交值 | 提交时复校验候选集合（§3.4） |
| R7 | 域名变动误触发记录写入（**目标不唯一** → 改错或批量覆盖；自激；`third_id` 窗口错写） | **硬性禁止 + 四层强制**（§4.0、§4.0.4）；技术上由「解析值不唯一」直接排除（§4.0.1） |
| **R8** | **`ModifyOriginGroup` 是整组覆盖语义，直接使用会误删源站 / 权重被清空** | v1 不提供“自备完整数组”形态，只提供 I2 显式收敛（`collapse` 自认 + 影响面可见 + 被移除记录逐条 + 不可重建数据确认 + 快照 + 写后校验），见 §3.7.9；点对点（v2）届时须自带 read-modify-write 与基线比对 |
| **R9** | **域名形态的源站可能解析到内网** | 预检**不做** DNS 查询（避免把校验变成出站请求、扩大 SSRF 面），只校验 hostname 语法；解析结果由 EdgeOne 侧策略约束。属**已知残余风险**，不承诺消除，见 §3.7.9.5.1 |
| ~~Q1~~ | ~~「源站组」在 HiDNS 中没有对应概念~~ | **已解决（D1）**：它是 EdgeOne 边缘加速的源站/回源配置，非 `tunnels`，见 §3.7 |
| ~~Q2~~ | ~~表达式与脚本并存~~ | **已否决**：不提供任何可执行代码，只有声明式 DSL（§六） |
| ~~Q3~~ | ~~定时器的时区语义~~ | **已消失（D5）**：不设计定时器，无 `schedule` 触发器 |
| ~~Q4~~ | ~~工作流级联~~ | **已解决（D3）**：禁止工作流调用工作流 |
| ~~Q5~~ | ~~域名变动是否也约束只读动作~~ | **已解决（D6）**：只读动作不设触发源限制 |

---

## 十二、分期落地建议

> **命名空间的实施计划单独成文**：`docs/WORKFLOW_ENGINE_NAMESPACE_PLAN.md`（含 P0–P3 分期、变更清单、CI 三级校验落地、审计检查表）。该计划是一次性全局架构变更，需先审计再动手。

| 阶段 | 内容 | 产出 |
|---|---|---|
| P0 | 事件总线 + `WorkflowOperations` + 表达式求值器 + `meta` 候选接口 + **§4.0 组合裁决** + **EdgeOne 源站组能力（仅点对面收敛）** | 能跑"A/AAAA 变了 → 收敛源站组回源" |
| P1 | 能力代理与鉴权裁决 + 管理员出站白名单 + dry-run 测试 | 安全边界成型 |
| P2 | 声明式解释器（节点白名单 + 求值器 + 限额），**无代码执行** | 可编排 |
| P3 | 防循环、重试、审计、前端编辑器 | 可生产 |

**每阶段必须同步**：`docs/api.md`（第一权威）、`root.ai.md` 新增「工作流与声明式语言」章节、CHANGELOG。

> **P0 必须包含 §4.0 的强制项与 §7.5 的禁用项**，不能留到 P3。理由：一旦允许非法组合落库，后续每一条运行路径都要重新兜底，成本远高于在保存期拦住。

### 12.1 需要同步修订 `root.ai.md` 的章节

| 章节 | 新增内容 |
|---|---|
| §服务层 | 增补 `WorkflowEngine` / `WorkflowEventBus` / `CapabilityBroker` 的职责边界 |
| §数据库 7 | `WorkflowOperations` 纳入操作模块清单 |
| §路由 | 新增 `/api/workflows`、`/api/workflows/meta/:source`；并写明二者**不进入** `initCheckMiddleware` 豁免清单 |
| §应用初始化 | 补一条：工作流引擎与事件总线**必须**经 `systemState.isSystemInitialized()` 判定，总线订阅在 `start()` 内注册，禁止模块作用域副作用 |
| §客户端架构 | 新增 `client/src/api/workflows.ts`、页面/组件/Hook 落位，与既有目录约束一致 |
| **§DNS提供商适配器 302（勘误）** | 该条现写作「`ProviderCapabilities` 包含 remark、status、redirect、log、weight、line、cnameFlattening」，与代码不符：`registry.ts:12` 的 `DnsCapabilities` 才是 `{ remark, status, redirect, weight, proxiable, cnameFlattening, recordTypes }`，`registry.ts:22` 的 `ProviderCapabilities` 是 `{ dns, log, renewal }`；且**不存在 `line` 字段**。本设计的 `originGroup` 应加在 `DnsCapabilities` 上，故需同步修正该条描述 |
| §安全规范 | 新增「工作流执行身份」「凭据零接触」「无可执行代码」「数据暴露面」「管理员出站白名单」五条 |
| §DNS提供商适配器 | `DnsCapabilities` 增加 `originGroup` 字段；EdgeOne/DNSPod 复用腾讯云 TC3 鉴权 |
| **§DNS提供商适配器（新增硬约束）** | **核心不得建模 Provider 私有资源层级**：能力接口一律使用不透明字符串（`scopeId` 等），由 Provider 把自己的概念映射进通用槽位（参照 `domains.third_id`）。任何为某厂商某资源新增核心表/核心列的提案，必须先判定"是否为 Provider 私有结构"，若是则一律下沉到适配器 |
| 新增章节 | 「工作流与声明式语言」：**独立模块目录 `server/src/workflow/`**、两条禁止项（域名变动不写记录、工作流不调用工作流）、**无可执行代码**、**数据暴露面清单**、出站代理约束 |
| **§DNS提供商适配器（新增机制）** | **提供商特有能力扩展**：`ProviderDefinition.extraCapabilities` + 两级前缀命名 + **核心白名单统一下派、模块二次下派** + 编译期类型绑定与 CI 唯一性门禁。核心只校验命名与唯一性，不解释语义 |
| **§全局主核心（新增）** | 新增 `server/src/types/namespace.ts`：`TOP_NAMESPACES` 白名单与 `NamespaceClaim` 契约，为**唯一定义源**。任何子系统不得自行新增顶级前缀，只能认领；预留前缀在认领前**禁止出现在任何动作名中**。组合根 `server/src/namespace-registry.ts` 汇总认领，主核心不 import 子系统 |
| **§DNS提供商适配器（强制约束）** | 新增动作前必须让 `check:actions` 通过；**CI 中该校验不得附加 `|| echo` 之类的容错**，否则门禁形同虚设 |
| **§服务层 / §路由** | 声明 `server/src/workflow/` 为独立一级模块；`routes/workflows.ts` 只做转发；`WorkflowOperations` 纳入 BAL |

---

## 十三、已确认的决策（v1 定稿）

| 编号 | 决策 | 落点 |
|---|---|---|
| D1 | 「源站组」是 **EdgeOne 边缘加速（TEO）的源站/回源配置**，非 DNS 解析记录；复用 DNSPod/EdgeOne 的腾讯云鉴权，本质是**附加组件** | §3.7 |
| D2 | **不提供脚本**：无 JS / `vm` / Worker，只有声明式 DSL。原「仅管理员可启用脚本」随之作废 | §六 |
| D3 | **禁止**工作流调用工作流（不提供 `workflow.call`） | §7.5 |
| D4 | 出站域名白名单由**管理员在系统设置中维护列表**，空白名单=全禁 | §5.5.1 |
| D5 | **不设计定时器**，无 `schedule` 触发器 | §4.1 |
| D6 | **只读动作不设触发源限制**；仅写动作受 §4.0 约束 | §4.0.4 |
| D7 | **DNSPod 不声明任何扩展能力**（纯解析，无边缘加速源站组），仅鉴权体系相同 | §3.7.6 |
| D8 | 源站组写入 **v1 只提供 I2 点对面** `tencenteo.originGroup.replace`（整组收敛为单一目标，须 `collapse: true`）；**I1 点对点延期 v2**（性能 / 竞态 / 使用频次）。**不提供“调用方自备完整数组”的形态** | §3.7.7、§3.7.9 |
| D9 | 点对点的定位键（**v2 启用时才适用**）：默认用 **`record` 地址**（DDNS 场景用事件 `oldValue`），`recordId` 不持久化，命中数必须恰好 1，`>1` 一律报错。**v1 不涉及定位** | §3.7.5.2 |
| D10 | **不能用备注定位**——EdgeOne `OriginRecord` 无备注字段。**也不得在核心库存别名**（`origin_aliases` 已否决：会把 Provider 资源层级写进核心）。可读名只作表达式节点的显示标签，不参与定位；定位只用 `record`/`recordId` | §3.7.5.1、§3.7.5.8 |
| D11 | **核心不得建模 Provider 私有结构**：能力接口一律用不透明字符串（如 `scopeId`），Provider 自行把概念映射进通用槽位，与 `domains.third_id` 同构 | §3.7.4、§3.7.5.8 |
| D12 | **EdgeOne 源站组允许只有 1 条源站**（项目方确认）。I2 收敛后组内恰为单条，**不设**"整组广播"退化路径；服务端若拒绝则 `CollapseUnsupported` fail-closed | §3.7.9.6 |
| D13 | **不得以「域名」为单位修改解析**——`A`/`AAAA` 是多值记录，「域名的解析值」不是可观测对象，按域名写入无法定义唯一目标。写入必须落到**具体记录**（`recordId` 唯一）。域名变动类触发器禁止作为任何解析写动作的触发源 | §4.0 |
| D14 | **`record.changed` 只监听 `A` / `AAAA`**；其余记录类型（CNAME/MX/TXT/NS/SRV/CAA…）不产生事件、不可订阅 | §4.0.5 |
| D15 | **v1 无「只改一条」动作**，工作流对源站组的任何写入都是收敛 → 工作流应只操作**专用单源站组**，多源站组由人工维护 | §3.7.10 |
| D16 | 源站 `Record` **接受 IPv4 / IPv6 / 域名**（项目方确认）。预检按形态分流、**不做 DNS 解析**；`type` 固定 `IP_DOMAIN`，**不开放 `AWS_S3` 作为写入目标**（凭据零接触） | §3.7.9.5.1 |
| D17 | **动作命名 `<顶级前缀>.<二级前缀>.<后缀>`，三级授权链**：**顶级前缀白名单归 HiDNS 全局主核心**（`server/src/types/namespace.ts`，`dns` / `ext` / `http` / `notify` / `var`；`cache` / `queue` / `storage` / `platform` 登记为**未认领预留，当前禁用**）→ 各子系统认领并**二次下派**二级前缀（`ext` 动态取自 registry 的 `providerType`）→ 提供商**只能**自定后缀。全名全局唯一 | §3.7.4 |
| D18 | 工作流引擎是**独立一级模块** `server/src/workflow/`，不并入 `service/`；动作分类用 `ext.read` / `ext.write` 而非厂商语义的 `origin.*` | §2.2、§十五 |
| D19 | **重名在编译期与 CI 拦死**，不以运行期为主界：L1 模板字面量类型绑定前缀与提供商；L2 CI 独立步骤跑 `check:actions`（校验逻辑为单一定义源）；L3 启动期仅兜底 | §3.7.4.1 |
| D20 | **白名单不得放在子系统内**：工作流只是认领方之一。由组合根 `server/src/namespace-registry.ts` 汇总各子系统认领，主核心不 import 任何子系统 | §3.7.4、§2.2 |
| D21 | **双通道调用**：内部走**文件引用**（链路清晰），对外走**前缀声明**（只暴露已注册能力，核心不泄露）。注册**双向**：声明→分派、实现→反向收集；**只实现未注册 = 用户不可达**，**只注册未实现 = CI 报错**。facade 必须静态，禁止运行时 Proxy | §2.3 |
| D22 | **所有调用一律先过 `authorize()`**：`ActionContext` 带私有 brand，只能由 `authorize()` 签发，**内部调用也不例外**。裁决 8 步（精确命中 / principal / 服务权限 / 资源权限 / 组合裁决 / DSL 通道 / 速率配额 / write-ahead 审计），任一失败即拒绝，不降级匿名执行 | §5.0 |
| D23 | **`ActionClass` 采用六个值的封闭枚举**：`dns.record.read` / `dns.record.write` / `ext.read` / `ext.write` / `http` / `notify`。分类只表达"这类动作为什么要受限"，与动作全名正交（动作名回答"谁的什么能力"）。**不得**从动作名反推分类，**不得**把厂商名写进分类 | §十五 |

## 十四、仍待确认

**当前无阻塞项。**

原列在此的两项已关闭：

| 原待确认项 | 处置 |
|---|---|
| `ActionClass` 分类方式 | 已定为七值封闭枚举，见 **D23**（§十五）。**由执行方代为决定，待负责人复核**——若不认可，改动面仅 §十五 与 §4.0.4 的组合裁决表，不影响其它章节 |
| ~~EdgeOne 源站组是否允许只有 1 条源站~~ | **已确认允许**（项目方确认），见 D12 与 §3.7.9.6 |


> EdgeOne 源站组的 API action 与数据结构已按官方文档核对完毕（§3.7.3），不再待确认。核对来源：
> [创建源站组](https://cloud.tencent.com/document/api/1552/80598)、[获取源站组列表](https://cloud.tencent.com/document/api/1552/80594)、[修改源站组](https://cloud.tencent.com/document/api/1552/80592)、[负载均衡相关接口](https://cloud.tencent.com/document/api/1552/80591)、[数据结构](https://cloud.tencent.com/document/api/1552/80721)

---

## 十五、动作分类（P0 落地前置）

§4.0 / §7.5 的裁决需要一个**可判定的动作分类**。分类挂在**动作声明**上（§3.7.4 的 `ProviderExtraAction.actionClass`），内置动作同样声明：

```ts
type ActionClass =
  | 'dns.record.read'    // 解析记录只读
  | 'dns.record.write'   // 解析记录写（受 §4.0 约束）
  | 'ext.read'           // 提供商扩展能力 · 只读
  | 'ext.write'          // 提供商扩展能力 · 写（受 §4.0 约束）
  | 'http'
  | 'notify';
```

裁决只需比较 `(triggerType, actionClass)`，避免每新增一个动作都要改判断逻辑。新增一家厂商的特有能力时，**只要它声明的 `actionClass` 落在上述枚举内，裁决逻辑一行不用改**。

**动作名与 `ActionClass` 是两个正交维度**：动作名（`ext.tencenteo.originGroup.replace`）回答"这是谁的什么能力"，`ActionClass`（`ext.write`）回答"这类动作为什么要受限"。前者按 §3.7.4 的两级前缀命名，后者是封闭枚举。**不得**从动作名反推 `ActionClass`，也不得把厂商名写进 `ActionClass`。

> **`ext.*` 取代了原草案的 `origin.read` / `origin.write`。** 理由与 D11 同源：`origin`（源站组）是 EdgeOne 的概念，写进**核心的动作分类枚举**就是把厂商结构建模进核心——正是上一轮被否掉的那类错误。核心只知道"这是某家厂商扩展能力的读 / 写"，不知道"源站组"这四个字。具体动作 `tencenteo.originGroup.replace` 通过 `actionClass: 'ext.write'` 参与裁决。

> 注意：`workflow` 类**不出现**在分类里——因为工作流调用已被完全禁用（§7.5）。



