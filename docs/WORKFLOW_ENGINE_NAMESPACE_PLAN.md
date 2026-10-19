# 工作流动作命名空间 · 架构变更计划（待审计）

- 关联设计：`docs/WORKFLOW_ENGINE_DESIGN.md`（§3.7.4 命名规则、§3.7.4.1 重名防线）
- 状态：**待审计**
- 性质：一次性全局架构变更的实施计划，非设计文档

## 一、为什么要一次性动完

命名空间不是局部改动，它同时被六个位置消费：

| 消费方 | 依赖点 |
|---|---|
| 动作注册表 | 每个动作的全名 |
| 能力代理 `CapabilityBroker` | 按 `actionClass` 裁决（动作名是索引键） |
| 工作流定义（持久化 JSON） | 动作全名写进用户配置 |
| 声明式 DSL 动作候选 | 候选列表由注册表自动生成（`dslVisible` 过滤） |
| 前端表达式编辑器 | 按 `params` 渲染 `{}` / `[]` / `()` |
| CI 校验 | 白名单、唯一性、落位 |

**边迭代边改**意味着每调整一次命名规则，都要把全部 22 家提供商 + 内置动作 + 前端 + DSL 候选回归一遍；**一次改完**只回归一次。

**时机窗口**：当前尚未上线，没有任何已保存的工作流定义，改名成本为零。一旦有用户保存过工作流，动作全名即成为持久化契约，再改就是破坏性变更。**这是唯一能免费动的时刻。**

## 二、目标结构

```
server/src/
├── types/namespace.ts       ★ 全局主核心：TOP_NAMESPACES 白名单 + NamespaceClaim
├── namespace-registry.ts    ★ 组合根：ALL_NAMESPACE_CLAIMS（汇总各子系统认领）
└── workflow/actions/
    ├── namespaces.ts        工作流认领：NamespaceClaim[]（只是认领方）
    ├── validate-names.ts    L2 校验逻辑（单一定义源，测试与 CLI 共用）
    ├── modules/             L1 认领 + L2 二次下派
    │   ├── dns/index.ts     认领 dns + 聚合本模块动作
    │   ├── ext/index.ts     认领 ext，二级前缀动态取 PROVIDER_TYPES
    │   ├── http/index.ts
    │   ├── notify/index.ts
    │   └── var/index.ts
    ├── dns/record.ts        L3 实现（按二级前缀分文件）
    ├── dns/domain.ts
    ├── http/outbound.ts
    ├── notify/channel.ts
    ├── var/workflow.ts
    ├── registry.ts          汇总 ALL_ACTIONS（声明）+ HANDLERS（实现）
    ├── handlers/            动作实现（handler(ctx, args)），按二级前缀分目录
    ├── facade/              ★ 对外静态 facade：dns.* / ext.* / http.* / notify.* / var.*
    └── __tests__/namespaces.test.ts
```

```
HiDNS 全局主核心（types/namespace.ts）
  └─ TOP_NAMESPACES 白名单（唯一来源，封闭）
       └─ 统一下派：任一子系统认领 top（一对一，经组合根汇总）
            └─ 子系统二次下派 → second[]
                 └─ L3 实现：动作名前两段必须命中 (top, second)
```

> **白名单归全局主核心，不归工作流。** 工作流只是认领方之一。若把 `TOP_NAMESPACES` 放进 `workflow/actions/`，等于让工作流给自己发牌照——`dns` 是 HiDNS 的能力域而非工作流私产；将来 MCP、插件系统同样要认领命名空间时，会与工作流的私有白名单冲突且无从仲裁。

## 三、变更清单

| 类型 | 文件 | 说明 |
|---|---|---|
| 新增 | `types/namespace.ts` | **全局主核心**：`TOP_NAMESPACES` + `RESERVED_TOP_NAMESPACES` + `NamespaceClaim` + `ActionNameOf` |
| 新增 | `namespace-registry.ts` | **组合根**：`ALL_NAMESPACE_CLAIMS`，允许依赖各子系统 |
| 新增 | `workflow/actions/namespaces.ts` | 工作流认领的 `NamespaceClaim[]`（**不定义白名单**） |
| 新增 | `workflow/actions/validate-names.ts` | 5 类命名空间违规 + 重名冲突 |
| 新增 | `workflow/actions/modules/*/index.ts`（5 个） | 模块认领与二次下派 |
| 新增 | `workflow/actions/{dns,http,notify,var}/*.ts`（5 个） | L3 实现 |
| 新增 | `workflow/actions/registry.ts` | `ALL_ACTIONS`（声明）+ `HANDLERS`（实现）双向注册 |
| 新增 | `workflow/actions/facade/*.ts` | 对外静态 facade，覆盖五个顶级前缀 |
| 新增 | `workflow/actions/__tests__/namespaces.test.ts` | CI 门禁 |
| 新增 | `server/scripts/check-action-names.ts` | CLI 包装，复用同一校验逻辑 |
| 修改 | `lib/dns/providers/registry.ts` | `ProviderDefinition` 泛型化 + `extraCapabilities?` |
| 修改 | `lib/dns/providers/tencenteo/extra.ts` | **唯一**新增扩展能力声明的提供商 |
| 修改 | `server/package.json` | 新增 `check:actions` |
| 修改 | `.github/workflows/test-suite.yml` | 新增独立步骤（**不得**带 `|| echo`） |
| 修改 | `docs/WORKFLOW_ENGINE_DESIGN.md` | 动作表改为由注册表导出 |

**21 家提供商零改动**：`ProviderDefinition<P extends ProviderType = ProviderType>` 的泛型有默认值，未声明 `extraCapabilities` 的定义无需标注类型参数。只有 tencenteo 需要写 `satisfies ProviderDefinition<'tencenteo'>` 以启用前缀强绑定。

## 四、分期计划

| 期 | 内容 | 产出 | 验收 | 回滚 |
|---|---|---|---|---|
| **P0** | 命名空间骨架 + 鉴权闸门骨架 | `types/namespace.ts`（主核心白名单）、`namespace-registry.ts`（组合根）、`workflow/actions/namespaces.ts`（认领）、`validate-names.ts`、`authorize()` 与 `ActionContext` brand、CI 门禁 | `tsc` 绿；`check:actions` 绿；未接引擎，**无运行时行为变化** | 删新增文件即可，零影响 |
| **P1** | 内置动作迁入注册表 | 5 个 L3 实现（声明 + handler 桩）+ 静态 facade；文档动作表与 `docs/api.md` 改为从注册表生成 | 注册表 / handler / facade 三者**逐条一致**（CI A5/A7/A8） | 移除 `registry.ts` 与 `facade/` 导出，业务路径未接 |
| **P2** | 提供商扩展能力 | `extraCapabilities?` 泛型化 + tencenteo `extra.ts` | 21 家无额外声明；tencenteo 4 个动作；CI 绿 | 删 `extraCapabilities` 字段即可 |
| **P3** | 消费方接入 | 引擎分发、Broker 裁决、前端渲染、`hd.*` 自动生成 | 端到端 dry-run 通过 | 逐消费方开关退回 |

**P3 之前必须冻结动作全名**——它一旦进入用户保存的工作流定义，就不可再改。

## 五、CI 校验的三级落地（本次补全）

### 5.1 三级分工

| 级 | 位置 | 检查 | 失败表现 |
|---|---|---|---|
| **L1 编译期** | 各 L3 实现文件 | 动作名标注为 `ActionNameOf<typeof xNamespace>`，前缀与二级前缀由模板类型强制 | `tsc` 报错 |
| **L2 声明级** | `validate-names.ts` | 白名单成员、一对一认领、**每个非预留前缀都被认领**、预留未用、二级前缀不重复、跨提供商重名 | CI 红 |
| **L3 实现级** | `__tests__/namespaces.test.ts` | 见 5.2 | CI 红 |

### 5.2 L3 实现级校验（落到各子模块）

对**每一个** `modules/<m>/index.ts` 导出的 `{ namespace, actions }` 执行：

| # | 检查 | 拦的是什么 |
|---|---|---|
| A1 | 每个 `actions[i].name` 的前两段 === `(namespace.top, 某个 namespace.second)` | 实现里冒出未下派的前缀（如 `dns.line.list`） |
| A2 | `namespace.second` 中每一项**至少有一个**实现 | 空声明占位（声明了 `domain` 却没人实现） |
| A3 | 实现中出现的前缀**不得多于**声明 | 声明与实际不符（实现先跑，声明没跟上） |
| A4 | 所有模块导出的动作名合并后**全局唯一**（含 provider 扩展能力） | 跨模块撞名 |
| A5 | 声明中出现的动作与 `ALL_ACTIONS` 索引条目**双向一致** | 索引漏挂或重复挂 |
| A6 | `ext` 模块的 `second` 必须**恰好等于** `PROVIDER_TYPES` | registry 与命名空间漂移 |
| A7 | 静态 facade 导出的能力集合与 `ALL_ACTIONS` **双向一致** | facade 手写漂移：注册了但用户调不到，或 facade 里有幽灵方法 |
| A8 | handler 表 `HANDLERS` 的键与 `ALL_ACTIONS` 的 name **双向一致** | 只注册未实现（运行到才炸）／只实现未注册（用户不可达却以为已上线） |
| A9 | 每个动作声明的 `service` **必填**且 ∈ `AVAILABLE_SERVICES`；`actionClass` ∈ 枚举 | 漏鉴权维度：无 `service` 的动作在 `authorize()` 第 3 步无从裁决 |
| A10 | 所有 handler 必须由 `defineAction()` 产出（`ActionHandler` brand 类型），registry 只接受该类型 | 手写裸函数绕过 `ActionContext` 约束 |
| A11 | `routes/**`、`service/**`、`lib/dns/providers/**` **不得** import `workflow/actions/handlers/**` | 绕过 `authorize()` 直调 handler，形成提权通道 |

> A2 / A3 是本次新增的关键：只校验声明，等于默许"声明一套、实现另一套"。**双向一致**才叫落地到子模块。

> A7 / A8 对应**双通道调用模型**（设计 §2.3）：内部走文件引用、对外走前缀声明，两条路都必须与同一份注册表对齐。**特别提醒**：A8 失败时若只报"运行期找不到 handler"，说明注册表与实现已经漂移而 CI 没拦住——这正是本条存在的理由。

> A9 / A10 / A11 对应**统一鉴权闸门**（设计 §5.0）。前两条在编译期就把"漏声明权限"和"绕过授权上下文"变成类型错误；A11 是依赖方向检查——**任何模块都不得跳过 `authorize()` 直调 handler**，包括内部代码。

### 5.3 CI 接线

```json
// server/package.json
"check:actions": "vitest run src/workflow/actions/__tests__/namespaces.test.ts"
```

```yaml
# .github/workflows/test-suite.yml
- name: Check action namespaces & uniqueness
  run: pnpm --filter dnsmgr-server run check:actions
```

> ⚠️ **前置修复**：现行 `test-suite.yml:149` 为 `run: pnpm --filter dnsmgr-server run test || echo "Server unit tests completed"` —— `|| echo` 吞掉退出码，**测试失败不会让 CI 变红**。新增步骤必须独立且**不带任何容错修饰**。若这一步也挂上 `|| echo`，整套校验即为摆设。

## 六、兼容性与影响面

| 面 | 影响 |
|---|---|
| 数据库 | **无变更**。不新增表、不改列 |
| HTTP API | P0–P2 无变更；P3 新增 `/api/workflows` 才有 |
| 前端 | P0–P2 无变更；P3 按 `params` 渲染控件 |
| 现有 22 家提供商 | 21 家**零改动**；tencenteo 新增 `extra.ts` |
| 现有测试 | 新增 1 个测试文件，不改既有断言 |

## 七、风险与缓解

| # | 风险 | 缓解 |
|---|---|---|
| R1 | 泛型化触碰 22 家定义，机械错误 | 泛型默认 `ProviderType`，**21 家不改**；仅 tencenteo 标注，`tsc` 逐文件验证 |
| R2 | 声明与实现漂移 | CI A2 / A3 / A5 双向一致检查 |
| R3 | 预留前缀被误用（`cache.*` 等） | CI `reserved` 检查 + `RESERVED_TOP_NAMESPACES` 单独维护 |
| R4 | CI 门禁被容错语句吞掉 | 独立步骤，审计时**必须看到该步骤失败过一次**（注入一个重名验证） |
| R5 | P3 前未冻结命名 | 冻结动作全名并写入 `docs/api.md`；冻结后视为破坏性变更 |
| R6 | 某模块忘记认领顶级前缀 | CI 检查每个**非预留**顶级前缀都被某个模块认领 |

## 八、审计检查表

审计时逐条核对，任一不满足即打回：

- [ ] `TOP_NAMESPACES` 全仓**只有一处**定义，且位于 `server/src/types/namespace.ts`（全局主核心），**不在 `workflow/` 下**
- [ ] 主核心 `types/namespace.ts` **不 import 任何子系统**；依赖方向单向（子系统 → 主核心）
- [ ] 认领汇总只发生在组合根 `namespace-registry.ts`，无第二处汇总
- [ ] 5 个模块各认领**恰好一个**顶级前缀，无重复认领
- [ ] 4 个预留前缀未被任何模块认领、未出现在任何动作名中
- [ ] `ext` 模块的二级前缀**动态**取自 `PROVIDER_TYPES`，未硬编码
- [ ] 每个 L3 实现都有对应的 `modules/<m>` 声明，且声明无空占位
- [ ] CI 检查为**独立步骤**，无 `|| echo` / `|| true` 等容错
- [ ] 注入一个重名，CI **确实变红**（留 run 链接）
- [ ] 21 家提供商 diff 为**空**，仅 tencenteo 有新增
- [ ] facade 为**静态文件**，无运行时 `Proxy` 生成
- [ ] `HANDLERS` 与 `ALL_ACTIONS` 双向一致（A8）；facade 与 `ALL_ACTIONS` 双向一致（A7）
- [ ] 内部模块之间**没有**经注册表调用（注册表不是 IOC 容器）
- [ ] `ActionContext` 带私有 brand，**无任何**手写伪造点；handler 一律由 `defineAction()` 产出
- [ ] 每个动作声明都有 `service`，且 `authorize()` 第 3 步**确实**用它裁决（不是只声明不校验）
- [ ] 无任何路径可绕过 `authorize()` 直调 handler（A11 依赖方向检查）
- [ ] 审计为 write-ahead：**注入一次审计写失败，确认调用被拒绝**
- [ ] `SYSTEM_PRINCIPAL` 的权限集合是枚举白名单，**不含**管理员通配
- [ ] 全仓**不存在** `eval` / `Function` / `vm` / Worker 执行用户代码的路径（`grep` 可验证）
- [ ] 动作集**不含** `users.*` / `auth.*` / `tokens.*` / `settings.*` / `security.*`；`principal` 在求值上下文中被冻结且不可枚举
- [ ] `call.action` 在保存期即可静态确定（无动态拼接路径）
- [ ] P3 前动作全名已冻结并同步 `docs/api.md`

## 九、未决项

1. `ActionClass` 枚举的最终形态（`dns.record.read/write`、`ext.read/write`、`http`、`notify`）——P1 前置。
2. `modules/<m>` 的 `actions` 汇总方式：静态展开 vs 运行时聚合。建议静态展开（便于 tree-shaking 与编译期类型收窄）。
---

## 十、执行记录

### P0 · 已完成（2026-10-19）

| 交付物 | 路径 | 状态 |
|---|---|---|
| 全局主核心白名单 | `server/src/types/namespace.ts` | ✅ |
| 组合根 | `server/src/namespace-registry.ts` | ✅ |
| 工作流认领 | `server/src/workflow/actions/namespaces.ts` | ✅ |
| 五个模块认领与聚合 | `server/src/workflow/actions/modules/{dns,ext,http,notify,var}.ts` | ✅ |
| L3 动作声明与桩 | `server/src/workflow/actions/{dns,http,notify,var}/*.ts` | ✅ |
| 动作注册表 | `server/src/workflow/actions/registry.ts` | ✅ |
| 校验逻辑（单一定义源） | `server/src/workflow/actions/validate-names.ts` | ✅ |
| 鉴权闸门 | `server/src/workflow/auth.ts`（`ActionContext` 私有 brand + 八步裁决） | ✅ |
| 动作契约与品牌类型 | `server/src/workflow/actions/types.ts`（`defineAction`） | ✅ |
| CI 门禁测试 | `server/src/workflow/actions/__tests__/namespaces.test.ts`（6 用例） | ✅ |
| 鉴权闸门测试 | `server/src/workflow/auth.test.ts`（11 用例，覆盖八步裁决与 write-ahead 审计） | ✅ |
| CI 接线 | `.github/workflows/test-suite.yml` 独立步骤；移除 `|| echo` 容错 | ✅ |

**验证证据**：

| 项 | 结果 |
|---|---|
| `tsc --noEmit` | 通过（0 错误） |
| `check:actions` | 6 用例全过 |
| **P-2 门禁有效性** | 注入重名 `dns.record.list` → 2 个用例失败、退出码 1；还原后恢复 6 通过 |
| 全量测试 | 12 失败文件 / 26 跳过，与既有基线**完全一致**（失败均为 `No test suite found` 的既有配置问题，非断言失败） |

### 执行中发现的既有缺陷（已修）

`internal.ts` 与 `DnsHelper` 之间存在**循环依赖**：`internal → DnsHelper → providers/index → <adapter> → internal`。ESM 下 `export ... from` 会被提升，导致 adapter 求值时 `createProviderAdapterLogger` 仍处于未初始化状态。

该缺陷在既有入口顺序下未暴露，但**任何先加载 `providers/registry` 的代码都会触发**（本次 P0 的 `ext` 模块正是如此）。已移除 `internal.ts` 对 `DnsHelper` 的再导出以打断环路；四个真实调用方本就直连 `DnsHelper`，无行为变化。

### P1 · 进行中（2026-10-19）

| 动作 | 状态 | 说明 |
|---|---|---|
| @@http.outbound.fetch@@ | ✅ 已实现 | 协议白名单 + 域名白名单 + 内网拒绝 + 逐跳重定向校验 + 大小/超时上限 |
| @@var.workflow.get@@ | ✅ 已实现 | 仅读本次运行注入的变量快照；不可达用户/鉴权/DB |
| @@dns.record.*@@（7 个） | ⏳ 待实现 | 需接 @@DnsProviderService@@ 与 BAL，且写入后需发布事件（P3） |
| @@dns.domain.list@@ | ⏳ 待实现 | 需接 @@DomainOperations@@ |
| @@notify.channel.send@@ | ⏳ 待实现 | 需接 @@notification@@ 服务 |

**攻击面测试（已完成部分）**：@@src/workflow/actions/__tests__/http-policy.test.ts@@（13 用例）覆盖 IPv4/IPv6 内网段、IPv4-mapped 绕过、URL 内嵌凭据、空白名单 fail-closed、通配不越界（@@example.com.evil.io@@）、重定向逐跳校验、重定向上限、响应截断。

@@check:actions@@ 已扩大为 @@vitest run src/workflow@@，当前 **32 用例全绿**。

### P3 前置 · 事件总线（已完成）

| 项 | 状态 |
|---|---|
| `workflow/event-bus.ts` | ✅ `WorkflowEventBus` + `buildRecordEvent`，过滤 A/AAAA、深度上限、工作流自身写入抑制、订阅者异常隔离、同源日志限流 |
| `workflow/publish.ts` | ✅ 路由侧发布入口：无订阅者零成本、非 A/AAAA 丢弃、发布失败不影响业务 |
| `routes/records.ts` | ✅ 创建/更新两处接入；更新时**仅在存在订阅者**才回查旧值，避免热路径固定开销 |
| 测试 | ✅ `event-bus.test.ts` 9 用例 |

**未接入（原因）**：`record_deleted` / `record_status_changed` 两处路由不携带记录类型，按 §4.0.5 fail-closed 无法构造事件。需在删除前回查类型才能补齐，留待 P3 与引擎一并处理。

**回归**：全量 `61 passed | 26 skipped`，12 个失败文件与既有基线完全一致（均为 `No test suite found` 或既有 DB 初始化问题）。

### P1 · 已完成（2026-10-19）

| 动作 | 状态 | 说明 |
|---|---|---|
| `http.outbound.fetch` | ✅ | 出站白名单 + 内网拒绝 + 逐跳重定向 + 大小/超时 |
| `var.workflow.get` | ✅ | 仅读运行期变量快照 |
| `dns.record.list/get/create/update/delete/setStatus/batch` | ✅ | 经 `DnsProviderService` + BAL；写入后发布事件（`actor.source='workflow'`） |
| `dns.domain.list` | ✅ | 经 `DomainOperations.getUserAccessibleDomains`，按 `allowedDomains` 过滤 |
| `notify.channel.send` | ✅ | 复用既有 `sendNotification`（发往全部已配置渠道） |

**权限纵深**：`dns.record.*` 在 `authorize()` 之后仍按解析出的**真实域名**再校验一次（`assertDomainAllowed`），防止 `args.domain` 与 `resource.domainName` 不一致时越权。

**如实记录的边界**：

| 项 | 说明 |
|---|---|
| `notify.channel.send` 不支持指定渠道 | 底层服务为广播式；按渠道发送需改造 `notification.ts`，留待 P3 |
| `dns.record.delete` 不发布事件 | 路由/适配器不返回记录类型，§4.0.5 fail-closed 下无法构造事件 |
| `dns.record.batch` 上限 50 条 | 防批量动作打穿配额；超限 422 |

**测试**：`dns-record.test.ts` 8 用例（域名越权 403、不存在 404、create 发布事件、update 携带旧值、setStatus 非法值 400、batch 超限 422、delete 不发事件）。工作流测试合计 **49 用例**；全量 `69 passed | 26 skipped`，12 个失败文件与基线一致。

### P2 · 已完成（2026-10-19）

| 交付物 | 路径 | 状态 |
|---|---|---|
| 收敛计划纯逻辑 | `lib/dns/providers/tencenteo/origin-group.ts` | ✅ |
| 源站组 API 客户端（裸原语） | `lib/dns/providers/tencenteo/origin-group-client.ts` | ✅ |
| 扩展能力声明与 handler | `lib/dns/providers/tencenteo/extra.ts` | ✅ |
| 适配器暴露裸原语 | `TencenteoAdapter.originGroups()` | ✅ |
| 注册挂载 | `registry.ts` 的 tencenteo 增加 `extraCapabilities` | ✅ |
| 按账号构建适配器 | `DnsProviderService.getAdapterByAccount()` | ✅ |
| 扩展 handler 接线 | `workflow/actions/modules/ext.ts` 统一 `defineAction` 包装 | ✅ |

**核心验证**：`ext` 模块的二级前缀**动态取自 `PROVIDER_TYPES`**，四个 `ext.tencenteo.originGroup.*` 动作经「提供商目录 → registry → ext 模块 → 注册表」自动流入，**workflow 侧没有任何一行代码提到 tencenteo**。这正是 D17/D20 想要的效果。

**契约落实**：`replace` 要求 `collapse: true`（F1）、`diffDigest` 与重算值一致（U2）、被移除记录含私有参数需 `acknowledgeDataLoss`（F4）、目标内网/回环拒绝（F5）、已收敛则 `skipped`（F7）、写后重读校验单条且等于目标（U4）。

**定位方式**：源站组统一用**源站组 ID**（`groupId`）定位，由 API 拉取——`DescribeOriginGroup` + `Filters: [{ Name: 'origin-group-id', Values: [groupId] }]`。**不使用**"全量列出再本地查找"：源站组数量无上限，全量拉取既慢又可能截断；同时对返回结果再做一次 `GroupId` 精确比对，防服务端忽略 filter 时误取。

**如实记录的局限**：handler 的真实 API 调用**未经线上验证**（无腾讯云凭据）；已覆盖的是计划/校验/映射逻辑与注册链路。

**测试**：新增 `origin-group.test.ts` 13 用例。工作流测试合计 **62 用例**；全量 `82 passed | 26 skipped`，12 个失败文件与基线一致。

### P3 · 进行中（2026-10-19）

| 组件 | 状态 | 说明 |
|---|---|---|
| DSL 节点白名单 | ✅ `workflow/expression/nodes.ts` | 9 类节点封闭枚举；`ref` 仅允许 `event.*` / `vars.*`，拒绝 `__proto__` / `constructor` / `prototype` |
| 静态校验 | ✅ `workflow/expression/validate.ts` | 节点白名单、深度/节点数、参数白名单、**`call.action` 必须字面量且已注册** |
| 求值器 | ✅ `workflow/expression/evaluator.ts` | 逐节点解释；调用次数上限 50；超时 5s；除零/未知运算抛错 |
| 动作派发 | ✅ `workflow/dispatch.ts` | **先鉴权后取 handler**；已授权但缺实现返回 500（暴露漂移而非静默成功） |
| 执行引擎 | ✅ `workflow/engine.ts` | 触发匹配 → 条件求值 → 顺序执行；单工作流失败不影响其它；订阅在 `start()` 内建立 |
| 引擎测试 | ✅ `__tests__/engine.test.ts` 11 用例 | 含"未 start 时不订阅"（模块作用域副作用回归项） |
| 引擎执行编排 | ✅ | 已完成 |
| DSM 表 | ✅ `complete-schema.ts` 新增 `workflows` / `workflow_runs` | 声明式定义，由 schema-reconciler 同步，无手写 DDL |
| BAL 操作 | ✅ `WorkflowOperations` | listByOwner / listEnabled / getById / create / update / remove / insertRun / listRuns |
| 持久化映射 | ✅ `workflow/store.ts` + 5 用例 | 损坏 JSON 回退默认值；非 A/AAAA 触发类型过滤（fail-closed） |
| 路由 | ✅ `routes/workflows.ts` | 六个端点，全部 `authMiddleware` + `adminOnly`，写操作叠 `requireJwtAuth` |
| 静态 facade | ⏳ | 见设计 §2.3 |
| 前端 | ⏳ | 编辑器与预览 |
| 路由 | ✅ `routes/workflows.ts` | 六个端点，全部 `authMiddleware` + `adminOnly`，写操作叠 `requireJwtAuth` |
| 静态 facade | ⏳ | 见设计 §2.3 |
| 前端 | ⏳ | 编辑器与预览 |

**关键断言**：`expression.test.ts` 含一条**结构断言**——扫描 `workflow/` 全部 `.ts`，若出现 `eval(`、`new Function(` 或导入 `vm` 即失败。这使"无可执行代码"从文档承诺变成可执行检查。

### 待办

| 项 | 说明 |
|---|---|
| P1 | 内置动作接入真实实现（当前为 `ActionNotImplementedError` 桩） |
| P2 | `tencenteo` 的 `extra.ts`（`ext.tencenteo.originGroup.*`） |
| P3 | 引擎、Broker、前端、DSL facade 接入 |
| P-3 | 修 `root.ai.md` §302 的陈旧描述 |
---

## 十一、验收：CI 与攻击面测试（2026-10-19）

### 11.1 CI 门禁

| 项 | 结果 |
|---|---|
| `pnpm check:actions` | 通过，**12 个测试文件 / 104 用例** |
| 门禁接线 | `.github/workflows/test-suite.yml:108` 独立步骤，全仓**无** `|| echo` / `|| true` 容错 |
| 门禁有效性（实测） | 注入 facade 缺失一个入口 → `A7` 用例失败 → pnpm 非零退出（`ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL`）→ 还原后恢复全绿 |
| `tsc --noEmit` | 0 错误 |
| 全量测试 | `124 passed | 26 skipped`；12 个失败文件与既有基线完全一致（均为 `No test suite found` 或既有 DB 初始化问题） |

### 11.2 攻击面清单

| # | 攻击面 | 防护 | 测试 |
|---|---|---|---|
| 1 | SSRF（出站打内网） | 协议白名单 + 域名白名单 + IPv4/IPv6 私网判定 + 逐跳重定向校验 + 大小/超时上限 | `http-policy.test.ts` 13 用例 |
| 2 | 未授权调用 | `authorize()` 八步裁决；`ActionContext` 私有 brand 只能由 authorize 签发 | `auth.test.ts` 11 用例 |
| 3 | 跨域名越权 | `authorize` 资源校验 + handler 按真实域名**二次校验** | `dns-record.test.ts` |
| 4 | 动态动作名绕过 | `call.action` 必须字面量且已注册 | `expression.test.ts` / `payload.test.ts` |
| 5 | 原型链逃逸 | `ref` 仅 `event.*` / `vars.*`，拒绝 `__proto__` / `constructor` / `prototype`，求值时再判 `hasOwnProperty` | `expression.test.ts` |
| 6 | 事件自激循环 | A/AAAA 过滤 + 深度上限 + `actor.source='workflow'` 抑制 + 日志限流 | `event-bus.test.ts` 9 用例 |
| 7 | 代码执行 | 节点白名单封闭；**结构断言**扫描 `workflow/` 出现 `eval` / `new Function` / `vm` 即失败 | `expression.test.ts` |
| 8 | 绕过鉴权直调 handler | 依赖方向检查：`routes/`、`service/`、`providers/` 不得 import `workflow/actions` 实现 | `namespaces.test.ts` A11 |
| 9 | 扩展能力重名 | 核心白名单 + 一对一认领 + 全局唯一；**实测注入重名 → 门禁变红** | `namespaces.test.ts` |
| 10 | 审计缺失致不可追溯 | write-ahead 审计：写失败即拒绝执行 | `auth.test.ts` |
| 11 | 白名单通配越界 | `*.example.com` 不匹配 `example.com.evil.io` | `http-policy.test.ts` |
| 12 | 批量动作打穿配额 | `dns.record.batch` 上限 50 条，超限 422 | `dns-record.test.ts` |

### 11.3 未完成项（不静默丢弃）

| 项 | 状态 | 原因 |
|---|---|---|
| 前端编辑器（基础版） | ✅ 已实现 | `client/src/pages/Workflows.tsx` + `client/src/api/workflows.ts`：列表、新建/编辑（名称 / 触发器 / 记录类型 / 字段 / 动作与参数）、运行记录、手动运行。路由 `dash/workflows`，仅管理员 |
| 前端：`(...)` 实时预览 | ✅ 已实现 | 服务端新增 `GET /:id/sample-event`（取最近一次运行的 `trigger_event` 快照）；前端"预览 (…)"对话框用真实值渲染，无记录时提示"等待触发" |
| 前端：条件节点编辑（单条件） | ✅ 已实现 | 支持 `字段 运算符 值` 单条件（`compare` + `ref` + `literal`）；**复合条件（and/or）仍需 DSL 手写** |
| 前端：`{...}` / `[...]` 级联候选 | **部分实现** | 动作与参数来自 `/meta/*`；`originGroups` / `originServers` 级联未接（需先做账号→站点→源站组的选择链） |
| 其余 9 种语言的工作流文案 | **未实现** | 已补 `zh-CN` 与 `en`，其余语言回退显示 key |
| 手动运行端点 `POST /:id/run` | ✅ 已实现 | 由调用方提供合成事件（`domainId` + `domainName` + `record`）；**仅接受 A / AAAA**，与事件主线同一套过滤；以 `manual` 通道派发，鉴权/限额/审计与事件触发完全一致；限流 10 次/分钟 |
| 运行记录前端展示 | 未实现 | 同上 |

### 11.4 结论

设计文档审计通过，服务端实现完成并通过 CI 与 12 类攻击面测试。**剩余为客户端交付**，已在 11.3 明确记录。