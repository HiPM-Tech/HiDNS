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
| 脚本沙箱能力面 | `hd.<动作全名>` 由注册表自动生成 |
| 前端表达式编辑器 | 按 `params` 渲染 `{}` / `[]` / `()` |
| CI 校验 | 白名单、唯一性、落位 |

**边迭代边改**意味着每调整一次命名规则，都要把全部 22 家提供商 + 内置动作 + 前端 + 沙箱回归一遍；**一次改完**只回归一次。

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
    ├── registry.ts          汇总 MODULES → ALL_ACTIONS（唯一动作索引）
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
| 新增 | `workflow/actions/registry.ts` | `ALL_ACTIONS` 索引 |
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
| **P0** | 命名空间骨架 | `types/namespace.ts`（主核心白名单）、`namespace-registry.ts`（组合根）、`workflow/actions/namespaces.ts`（认领）、`validate-names.ts`、CI 门禁 | `tsc` 绿；`check:actions` 绿；未接引擎，**无运行时行为变化** | 删新增文件即可，零影响 |
| **P1** | 内置动作迁入注册表 | 5 个 L3 实现（声明 + 桩）；设计文档动作表改为从注册表生成 | 注册表动作集合与文档表格**逐条一致**（CI 双向断言） | 移除 `registry.ts` 导出，业务路径未接 |
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

> A2 / A3 是本次新增的关键：只校验声明，等于默许"声明一套、实现另一套"。**双向一致**才叫落地到子模块。

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
- [ ] P3 前动作全名已冻结并同步 `docs/api.md`

## 九、未决项

1. `ActionClass` 枚举的最终形态（`dns.record.read/write`、`ext.read/write`、`http`、`notify`）——P1 前置。
2. `modules/<m>` 的 `actions` 汇总方式：静态展开 vs 运行时聚合。建议静态展开（便于 tree-shaking 与编译期类型收窄）。