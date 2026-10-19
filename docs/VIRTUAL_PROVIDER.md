# 虚拟 DNS 提供商与源站组联动

> 目的：在不交出任何真实域名解析凭证的前提下，完整演练 HiDNS 的工作流能力 ——
> 包括「域名 DDNS 更新 → 源站组跟着变」这条真实链路，以及「一个域名被多个源站组引用」
> 与「A / AAAA 同时更新」两种容易出错的场景。

## 1. 它解决什么问题

真实环境里，DDNS 把域名的 A/AAAA 改了之后，引用该域名的加速站点源站组必须同步，
否则回源仍指向旧 IP。验证这条链路通常需要：

- 一个真实的 EdgeOne 站点与源站组
- 一对可写的云厂商密钥
- 改坏了会影响线上域名

虚拟提供商把这三件事都去掉：它提供完整的 DNS 提供商契约（站点、解析记录、源站组），
状态保存在本地，不需要任何凭证，也不会碰到任何真实资源。

## 2. 启用方式（开发专用，生产永久关闭）

虚拟提供商是**开发工具，不是产品能力**。它有两级开关，必须同时满足：

### 第一级：进程开关（决定它是否存在于这个进程里）

| 环境 | 结果 |
| --- | --- |
| `NODE_ENV=production` | **永久关闭**，即使设置了下面的变量也不打开 |
| `HIDNS_ENABLE_VIRTUAL_PROVIDER=1` | 打开（`1` / `true` / `yes` / `on`） |
| 未设置 | 关闭 |

未打开时它**根本不注册**，因此：

- `/api/accounts/providers` 不返回它 —— 界面上看不到
- `createAdapter('virtual')` 抛 `Unknown provider type` —— 建不了账号
- `ext.virtual.*` 不在动作注册表里 —— 工作流引用不了
- `virtualOriginGroups` 候选源不注册 —— 参数下拉里没有它

换句话说，生产环境里它和不存在没有区别。

### 第二级：账号参数（进程打开了也要显式启用）

| 配置项 | 必填 | 说明 |
| --- | --- | --- |
| `virtual_enabled` | 是 | 必须为 `true`，否则 `check()` 失败、所有操作抛错 |
| `virtual_tenant` | 否 | 租户标识，用于隔离状态文件，默认 `default` |
| `virtual_state` | 否 | `file`（默认，持久化）或 `memory`（仅进程内） |
| `virtual_seed` | 否 | `demo`（默认，含演示数据）或 `empty`（空库） |

另有 `HIDNS_DISABLE_VIRTUAL_PROVIDER=1` 可在开发环境临时一键停用。

### 本地开发怎么开

```bash
HIDNS_ENABLE_VIRTUAL_PROVIDER=1 pnpm --filter dnsmgr-server dev
```

测试环境在 `server/tests/setup.ts` 里统一打开，因此 CI 会完整校验虚拟提供商的注册与动作；
演示脚本 `demo:virtual` 自己设置该变量，无需手动传。

状态文件默认落在 `<server>/data/virtual/<tenant>.json`，
可用 `HIDNS_VIRTUAL_STATE_DIR` 改目录。

## 3. 动作清单

| 动作 | 分类 | 说明 |
| --- | --- | --- |
| `ext.virtual.originGroup.list` | `ext.read` | 列出站点下全部源站组 |
| `ext.virtual.originGroup.get` | `ext.read` | 按 ID 取单个源站组 |
| `ext.virtual.originGroup.planSync` | `ext.read` | 计算同步计划与摘要，不写入 |
| `ext.virtual.originGroup.sync` | `ext.write` | 按摘要提交同步 |

`planSync` / `sync` 的目标源站组有两种指定方式：

- `groupIds`：逗号分隔的组 ID，显式指定
- `domainName`：按「引用该域名的源站组」自动扇出（一个域名可命中多个组）

两者同时给时以 `groupIds` 为准。

## 4. 按地址族同步的语义

核心规则只有一条：**只替换对应地址族的 IP 源站，其余记录逐条原样保留。**

保留的内容包括：记录顺序、权重、`RecordId`、私有参数，以及域名型源站
（如 `origin.example.com`，虽然类型同为 `IP_DOMAIN`，但不是 IP 字面量，一律不动）。

| 情形 | 默认行为 | 打开选项后 |
| --- | --- | --- |
| 组内没有该地址族的记录 | 整组拒绝（`FAMILY_ABSENT`） | `addIfMissing: true` 时新增一条 |
| 组内同族记录多于一条 | 整组拒绝（`FAMILY_AMBIGUOUS`），不猜替换哪条 | 传旧值精确匹配（推荐）；或 `allowMultiple: true` 全部替换 |
| 某族无法处理 | `onPartial: 'reject'`，整批不写 | `onPartial: 'apply'` 时只应用可确定的族，并如实报告被跳过的族 |
| 目标已是该值 | 幂等 noop，不产生写入 | — |

失败关闭是刻意的：源站组直接影响线上回源，宁可报错让人确认，也不要替人猜。

### 族内有多条源站（源站池）

一个源站组里同时有两条 IPv4（或两条 IPv6）是常见的负载均衡池。
这时"把 v4 换成新地址"是有歧义的：改哪一条？全部改成同一个值会直接毁掉这个池。

处理办法是**传旧值**（`v4From` / `v6From`）。DDNS 的 `record.changed` 事件本身带
`oldValue`，用它就能精确定位到该改的那一条：

| 情形 | 行为 |
| --- | --- |
| 给了旧值，且命中一条 | 只替换这一条，池里其它记录（含顺序、权重、RecordId）原样保留 |
| 给了旧值，但组内没有这条 | `FROM_NOT_FOUND`，视为"该组没在跟踪这个地址"，不阻断 |
| 给了旧值，且命中多条 | 全部替换为同一目标（同值多条，无法区分） |
| 没给旧值，族内一条 | 直接替换 |
| 没给旧值，族内多条 | `FAMILY_AMBIGUOUS`，整批阻断 |

演示工作流默认传旧值，所以即使源站组是个池，也只会改动域名真正对应的那一条。

### A / AAAA 同时更新

同一次请求里同时给 `v4` 与 `v6` 时，两族在**同一次计划、同一次写入**内完成，
不会出现「v4 已新、v6 仍旧」的中间态。

若两个地址族来自两个独立事件（A 一条、AAAA 一条），两条流程可能并发执行
（引擎的互斥键含记录 ID，A 与 AAAA 是两个不同的键）。此时：

- 提交闸门用的是**作用域摘要** —— 只覆盖本次要改的地址族。
  A 的同步写完 IPv4 后，AAAA 那条流程的作用域摘要（只含 IPv6 记录）不变，
  因此它仍能提交，最终两族都是新值，谁也不会被丢弃。
- 若**同族**记录在预览之后被别人改动，作用域摘要随之变化，提交被拒绝。
- 整组摘要 `fullDigest` 仍会随任何改动变化，供人工复核与审计。

### 防误写

- 提交时按**实时状态**重新规划并比对摘要：本次要改的地址族一旦漂移就拒绝（防 TOCTOU），
  无关族的漂移不影响提交，因为写入总是基于实时状态重新规划、无关记录原样保留
- 写入后回读校验：值、顺序、类型必须一致；计划里明确给了权重才比对权重
  （服务端会给未指定权重的记录补默认值，不能因此误判为失败）
- 内网 / 回环 / `localhost` / `.local` 目标一律拒绝

## 5. 完整模拟工作流

预设：`server/src/workflow/presets/virtual-ddns-origin-sync.ts`

| 项 | 内容 |
| --- | --- |
| 触发器 | `record.changed`，`recordTypes: ['A', 'AAAA']` |
| 条件 | 仅 `created` / `updated` 才执行；删除与状态变更跳过 |
| 动作 1 | `ext.virtual.originGroup.planSync`，结果存入 `vars.plan` |
| 动作 2 | `ext.virtual.originGroup.sync`，`diffDigest` 取自 `vars.plan.digest` |

关键细节：动作里 `v4` / `v6` 用 `cond` 节点按 `event.record.type` 取值，
不匹配的那一族传空串；同步层把空串视为「未提供」，
因此 A 变更不会覆盖 AAAA 源站，反之亦然。

该预设走的是真实分发器、真实鉴权与真实 DSL 求值器，
端到端测试见 `server/src/workflow/__tests__/virtual-simulation.test.ts`。

## 6. 亲手跑一遍

```bash
pnpm --filter dnsmgr-server demo:virtual
```

不需要数据库、不需要任何凭证。演示会打印初始状态、同步计划、每组回执
与最终状态，并显示未被引用的组与域名型源站没有发生任何变化。

## 7. 演示数据集

`virtual_seed=demo` 会构造出目标场景：

| 源站组 | 源站 | 引用方 |
| --- | --- | --- |
| `DEMO-DUAL` | IPv4 + IPv6 | `example.test`、`www.example.test` |
| `DEMO-V4ONLY` | 仅 IPv4 | `example.test` |
| `DEMO-MIXED` | IPv4 + 域名型源站 | 无 |

`example.test` 同时被两个组引用 —— 这就是「一个域名变动多个源站组」。

## 8. 已知限制

- 源站组写入没有事务：多组同步中途失败不会回滚已写入的组，
  结果里逐组给出 `requestId`，可据快照人工回退
- 候选源注册表只按 `source` 名索引，`ProviderMetaSource.providerType`
  目前未参与索引，因此虚拟提供商使用独立的候选源名 `virtualOriginGroups`
- 虚拟提供商不模拟厂商的限流、配额与鉴权失败，只模拟正常响应与参数校验错误
- 静态 facade 里仍保留 `ext.virtual.*` 的绑定项：facade 按设计必须是静态的，
  不能在运行时条件生成。提供商未注册时这些入口调用会被 dispatch 拒绝（动作不存在），
  不会产生任何副作用，但 `flattenFacadeActions` 的结果在生产环境下会比注册表多出四项
