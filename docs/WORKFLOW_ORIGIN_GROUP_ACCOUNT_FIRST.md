# §904 账号优先：源站组动作的 DSL 契约变更（设计提案 v4）

> 状态：第 4 稿，已吸收第 1、2 轮三份评审的全部 P0/P1 与第 3 轮复核的 P2（鉴权 / 边界 / 可维护性）的 5 个 P0、9 个 P1
> 目标：把源站组动作的定位方式从「域名 → 账号 → 站点」改为设计 §3.7.8 要求的「账号 → 作用域（站点）」

## 0. 前置条件（不满足则本方案不成立）

### 0.1 候选源上下文与路由分流（**这才是双读的真正阻塞点**）

第 1 轮曾把「注册表复合键」列为前置条件，第 2 轮复核推翻了这个判断：
v3 已决定 `originGroups` 只服务 tencenteo（virtual 保留 `virtualOriginGroups`），
**跨提供商抢同一个源名的情况在本设计里并不存在**，复合键解决的是另一个问题。

真正的阻塞点有两处，不改则 `originGroups?accountId=3&scopeId=x` 在进 resolver 之前就被拒：

1. `ProviderMetaContext` 把 `domainId` 声明为必填，且只承载域名语义
   → 需改为 `domainId?` 可选，并增加 `accountId?` / `scopeId?`
2. 路由的 provider meta 分支在三条路径上都假设域名：
   - 缺 `domainId` → 直接 422
   - 归属校验用 `getUserAccessibleDomains`（域名集合）
   - 取适配器用 `DnsProviderService.getAdapter(domainId)`
   → 需**按源类型分流**：域名源走原校验，账号源走 §2.4 的 `assertAccountVisible`

> 「注册表复合键」降级为**将来准备项**（若日后多提供商共享 `originGroups` 再改），不再是本次前置条件。

### 0.2 候选源名构建期校验（改为静态扫描，不看 env）

`source` 是自由字符串，写错只会在运行期变成 404、下拉静默变空。需要 CI 断言，
但**不能**按「从 `listProviderMetaSources()` 取全集」的方式实现，原因有三：

- 注册是**条件副作用**：`virtualOriginGroups` 仅在 `HIDNS_ENABLE_VIRTUAL_PROVIDER=1` 且非生产时注册。
  CI 默认不设该变量 → 集合里没有它 → 断言必然失败；把它加进静态白名单，又恰好放过它本该拦住的漂移。
- 依赖模块副作用：只 import `src/workflow/**` 的测试看到的注册表是空的。
- 内建源（`actions`/`accounts`/`domains`/`domainNames`/`records`/`outboundAllowlist`）是路由里 5 段硬编码 `if`，
  没有可 import 的清单，断言只能再抄一份。

**改为**：

1. 把内建源抽成 `BUILTIN_META_SOURCES` 常量，从 `workflow/meta.ts` 导出，路由改为遍历该常量分流
2. 注册源改为**声明式数组**（而非注册时的副作用），使「声明了哪些源」与「环境是否启用」解耦
3. 门禁用**静态文件扫描**（参照仓库已有的 `layer-dependency.test.ts` 的
   `readdirSync + readFileSync` 做法），**不进模块、不看 env**。
   裸正则 `source:\s*'...'` 在 `src/**` 会命中 48 处、约 1/3 是无关对象（`actor: { source: 'workflow' }`、
   `source: 'system'`、解析器内部字段），必须锚成 `required:\s*(?:true|false)[^}]*source:\s*'([^']+)'`
   ——`ProviderActionParam` 都在同一对象字面量里先写 `required:`，`actor.source` 无 `required:` 自然排除。
4. 声明式数组**保留运行时 `enabled` 谓词**（`isVirtualProviderEnabled`），只把「声明」与「启用」拆开；
   照字面解耦会把生产环境的开关一起去掉。

## 1. 为什么改

设计 §3.7.8 要求 `originGroups` 依赖 `accountId` + `scopeId`，并要求账号不支持源站组时**隐藏整条动作**。
现状用 `domainId` 定位；DNSPod 复用腾讯云凭据时域名与 EdgeOne 站点**根本无对应关系**，只能让用户再手填 `zoneId`。

## 2. 新契约

### 2.1 参数：`zoneId` 改名 `scopeId`，**不做并存**

| 参数 | 类型 | 必填 | 候选源 |
|---|---|---|---|
| `accountId` | number | 是 | `accounts?originGroup=true`（复用既有源 + 过滤参数） |
| `scopeId` | text | 是 | `edgeoneZones?accountId=`（既有源改为支持账号入参） |
| `siteType` | select | 否 | — |
| `groupId` | text | 是 | `originGroups`（依赖 `accountId`+`scopeId`） |
| `target` / `diffDigest` | text | 是 | — |

移除 `domainId`；`zoneId` **改名**为 `scopeId`，不保留两个字段。

> **若**出于兼容必须并存，则两者同时存在且不相等 → 硬错误 `AMBIGUOUS_LOCATION`，**不得按优先级静默选一个**。
> 理由：幽灵字段会让「同一串定义字节、两次运行打到不同站点」，且任何地方都不会报错。

### 2.2 能力位：账号实例级，由 `extraCapabilities` 派生

> 注：不要用 `getProvider`（在 `DnsHelper.ts`，它已从 registry 导入，反向引用会成环）。
> registry 内现成有 `providerDefinitionMap`，直接用；派生函数就放 `providers/registry.ts`。

给 `DnsCapabilities` 加必填字段要改 25 处字面量 + 客户端手抄结构（漏改不报错）。改用派生：

```ts
export function getOriginGroupCapability(providerType: string): boolean {
  return (providerDefinitionMap.get(providerType)?.extraCapabilities ?? []).some((c) => c.name.endsWith('.originGroup'));
}
```

**账号是否可操作源站组 = `getOriginGroupCapability(providerType) || mayReuseCredentials('tencenteo', providerType)`**。

> 注意：这个布尔只表示「该账号能操作**某一家**的源站组」。`ext.tencenteo.*` 与 `ext.virtual.*` 是两族能力、
> 参数模型也不同（前者本次改为 accountId/scopeId，后者仍是 domainId）。前端隐藏动作时必须按**动作所属的 capability** 反查
> （按 `action.name` 前缀），不能只看这个布尔——否则 virtual 账号会被判「支持」却在跑 tencenteo 动作时 `PROVIDER_MISMATCH`。
> **本次契约变更仅适用于 `ext.tencenteo.originGroup.*`。**

> 必须包含凭据复用一支：否则 DNSPod 账号（providerType = `dnspod`）会被判定为「不支持」而在 UI 上隐藏源站组动作，
> 而那正是当前唯一能用源站组的用户群——改造后反而丢失入口。
> **virtual 也提供 `ext.virtual.originGroup.*`** 且有内置预设在用，不能被判为 false。

### 2.3 候选源：复用既有，只换 `originGroups` 的契约

| source | 入参 | 说明 |
|---|---|---|
| `accounts` | `?originGroup=true` | 复用既有源，加一个过滤参数 |
| `edgeoneZones` | `?accountId=` | 复用既有源，入参从 domainId 换成 accountId |
| `originGroups` | `accountId`、`scopeId` | 唯一真正换契约的源（依赖 §0.1） |

**不新增 `originGroupAccounts` / `originGroupScopes`**——它们的输出形态与既有源逐字段相同，新增等于把「账号可见性」规则复制第三份。

### 2.4 候选源路径必须做账号级校验（本次新发现的高危面）

`routes/workflows.ts` 的 provider meta 分支**唯一的边界是「你能不能看到这个域名」**，然后拿该域名的账号凭据去上游拉数据。
改成 `accountId` 入参后，若直通而无账号校验，任何 admin 遍历 `accountId=1..N` 即可拉到**全部他人的 EdgeOne 站点列表**。

**要求**：抽出 `assertAccountVisible(principal, accountId)`，**候选源与执行路径共用**——但注意两侧角色词表不同：
执行路径传 `'user'|'admin'|'super_admin'`，路由层拿到的是数值 `1|2|3`。
`accountAccessLevel` 内部按 `role === 'super_admin'` 判定，传数值 `3` 会**恒为 false**，超管在候选源下拉里看不到任何账号。
因此 `assertAccountVisible` **只接受 workflow 词表**，路由侧先过 `normalizeRole → isSuper/isAdmin → 词表` 桥接，并补「role=3」与「创建者+超管」两条用例。

谓词是 `accountAccessLevel(accountId) !== 'none'`（含 enabled 过滤与超管通配），
**禁止**复用 `getUserAccessibleDomains`（域名集合与账号集合是两套；两张表主键都是小整数，必然误命中）。

账号源与执行路径还须共用同一段 `resolveAccountScope(accountId, scopeId)`：
`originGroups` 的 `scopeId` **必须经 `listZones(account)` 校验**，否则它仍能拿到该账号凭据可见、
但不在 `edgeoneZones` 列表里的站点——账号边界在，资源边界不在。

### 2.5 鉴权接线程：走 handler 层 hook，**不动 `Principal` / `authorize()` / `engine.ts`**

事实核对：`authorize()` 的签名里没有 `args`；`engine.ts` 构造 `ResourceRef` 时只填 `domainId`/`domainName`。
所以「`resource.accountId` 存在时判账号」在生产链路上**恒不触发**，是死代码。
而 `ext` 动作的钩子 `authorizeTencenteoOriginGroup` 在 handler 层执行，`args` 就在手里。

#### 钩子内必须做**定位分支**（不能单改成 `Number(args.accountId)`）

单分支替换会让存量只读定义（只有 `domainId`）拿到 `NaN` → `accountAccessLevel` 不命中 → `NOT_FOUND`，
与 §3.2「观测能力不中断」直接冲突。钩子按下列顺序判定：

| 入参形态 | 处理 |
|---|---|
| 有 `accountId`（+`scopeId`），无 `domainId` | 账号模式：`accountId` 必过数值校验 |
| 有 `domainId`，无 `accountId`/`scopeId` | 旧模式：按 `resolveDomainAccount(domainId)` 取 accountId（只读动作继续可用） |
| 两者并存 | `AMBIGUOUS_LOCATION` |
| 都没有 | `INVALID_ARGS` |

`accountId` 必须做 `Number.isFinite && > 0`（现状对 `domainId` 就是这么做的）；`"abc"` → `NaN` 应返回 `INVALID_ARGS`，
而不是落到账号查不到再报 `NOT_FOUND`（错误码会误导）。

#### 写维度必须原样保留（上一轮 P0 的修复成果，不能丢）

钩子现在有两处判据，重写时必须保留：

```ts
const mode = actionClass === 'ext.read' ? 'read' : 'write';   // 只有显式 ext.read 算读
if (mode === 'write' && level !== 'write') throw new OriginGroupError('WRITE_FORBIDDEN', ...);
```

只写「`none` → `NOT_FOUND`」是不够的：那样 `ext.write` 会退回「账号可读即可写」，
等于把上一轮已修掉的 P0 重新引入。§7 增加验收「团队成员调 replace → `WRITE_FORBIDDEN`」。

> 措辞更正：`accountId` 对 tencenteo **并非**「完全未校验」——钩子已经在判。
> 真实缺口只有两处：(a) 候选源路径（§2.4）；(b) 将来给「无 authorize 钩子」的能力加 accountId 时。

### 2.5b 解析层入口：新增 `teoOpsForAccount`

§2.5 的钩子、§2.6 的归属校验、§2.7 的摘要都要通过它定位资源，而它目前**不存在**。
不写清就会在 `teoOpsForDomain` 旁边长出第二份 `buildReusedAdapter` 调用序列
（`origin-group-context.ts` 有约 50 行是两条路径的公共逻辑，必须共用）。

新增 `teoOpsForAccount(accountId, { scopeId, siteType })`，与 `teoOpsForDomain(domainId, ...)`
共用 `buildReusedAdapter` / `requireSiteType`，差异只在 **ZoneId 从哪来**：

| 入口 | ZoneId 来源 | 用途 |
|---|---|---|
| `teoOpsForDomain` | `domains.third_id`（单值锚定） | §3.2 的存量只读路径 |
| `teoOpsForAccount` | `args.scopeId`（须经 §2.6 校验） | 新契约的全部动作 |

三处配套：

1. **`TeoOps.domainName` 改名 `scopeName`**（`origin-group-context.ts:53`）——账号优先后没有域名可传，
   该字段只用于日志与结果回显。这就是 §6 R7 的实施落点。
2. **`listTeoZones` 改为收 `accountId`**（现状收 `domainId`）。§3.4 的 `migration-report` 需要按 `domainId` 出候选站点，
   写明：**先用 `resolveDomainAccount(domainId)` 取 accountId，再调新签名**，不要保留一个 domainId 版本。
3. **错误码新旧对照**：`ZONE_ID_REQUIRED` → `SCOPE_ID_REQUIRED`（新路径）；`ZONE_ID_IGNORED` 按 §2.6 废弃。
   两个码都要在 §2.8 的表里出现，否则文档与实现会对不上。

### 2.6 `scopeId` 归属必须校验；删掉 tencenteo 早退

`origin-group-authorize.ts` 有一句 `if (credentialSource === 'tencenteo') return true`，
它今天安全**只因为 zoneId 不是用户入参**（由 `domain.third_id` 锚定）。账号优先后该前提消失。

**要求**：删除该早退，两条凭据路径统一走 `scopeId ∈ listZones(account)`（缓存键已含 accountId）。
随之废弃 `ZONE_ID_IGNORED`；`listTeoZones` 的「只返回本域名站点」限制同步放开为「该账号凭据可见的全部站点」。

**siteType 一致性**：`siteType` 决定端点（`teo.tencentcloudapi.com` vs `teo.intl.tencentcloudapi.com`）。
若候选源用 `intl` 拉到 `scopeId`、而动作参数里 `siteType` 缺失或被改成 `mainland`，
同一 zoneId 字符串在两个端点都存在时会**打到另一个物理站点**。
要求：`siteType` 与站点的一致性**由 §2.7 的摘要绑位置承担**——digest 已纳入 `siteType`，
`plan` 与 `replace` 的 `siteType` 不一致会在 `DIGEST_MISMATCH` 处炸掉。
因此**不设** `SITE_TYPE_MISMATCH` 错误码（它不可达），`siteType` 缺失时仍报既有的 `SITE_TYPE_REQUIRED`。

### 2.7 `diffDigest` 必须绑定位置

`computePlanDigest` 现在只哈希 `{groupId, target, removed}`，**不含位置**。

失败场景：同账号下站点 A、B 存在**相同 groupId** 且内容相同的源站组（克隆站点常见）。`plan` 解析到 A → digest；
`replace` 解析到 B → 重算 digest **完全相同** → 校验通过 → **写入了一个从未预览过的物理站点**（流量被切走）。

> 论据修正（评审指正）：`groupId` 与 `removedKey`（含 `recordId|record|type|weight`）本就在摘要里，
> 所以「同名但不同 id」的组会 `DIGEST_MISMATCH`；`removed` 内容相同意味着那些记录在预览里已列出，
> 「不可恢复的私有参数」这条论据不成立。真正的危害是**写到了没预览过的站点**，这已足够要求绑位置。
> 定级：P1（本次真正的头号风险是 §2.4 的候选源直通，会暴露全部他人站点列表）。

今天之所以无害：位置由 `domainId → third_id` 单值钉死，且传别的 zoneId 会 `ZONE_ID_IGNORED`。
改造后这道结构性保证消失，digest 成为唯一防线，而它与位置无关。

**要求**：`location` 作为 `planCollapse` 的**必填参数**传入（`planCollapse(group, target, location)`），由它内部调 `computePlanDigest`——
**只有一处 digest 算法**。禁止在能力层二次哈希：那样会出现两套算法，plan 与 replace 一旦不同步就是静默放过。
摘要内容为 `(accountId, scopeId, siteType, groupId, target, removed)`；
补一条「同内容跨站点 plan/replace 必须 `DIGEST_MISMATCH`」的单测。

### 2.8 顺序与错误码

顺序：① 只读 `dns_accounts` 判权（不碰凭据）→ ② 解析凭据与站点 → ③ 校验 `scopeId` 归属 → ④ 执行。
理由：解析会抛可区分他人资源的错误串（`PROVIDER_MISMATCH` 带提供商类型、`CREDENTIAL_REUSE_NOT_DECLARED` 带账号类型），
未授权者可把账号 ID 变成枚举器。

| 情形 | 返回 |
|---|---|
| 账号不存在 / 不可见 | `NOT_FOUND` |
| 账号可见但不支持源站组 | `ACCOUNT_UNSUPPORTED`（**只可能在鉴权通过后出现**） |
| `scopeId` 不属于该账号 | `NOT_FOUND`（不回显他人站点标识） |
| `domainId` 与 `accountId`/`scopeId` 并存 | `AMBIGUOUS_LOCATION` |
| `siteType` 与 plan 不一致 | 由 `DIGEST_MISMATCH` 覆盖（不单设错误码） |
| `accountId` 非正整数 / 非数值 | `INVALID_ARGS`（现状对 `domainId` 就是这么做的） |
| 新契约缺 `scopeId` | `SCOPE_ID_REQUIRED`（取代 `ZONE_ID_REQUIRED`） |
| 团队成员调 `ext.write` | `WRITE_FORBIDDEN`（保持现状语义） |

## 3. 存量兼容：**按动作风险分级**（不按版本一刀切）

评审指出：方案 B（一次性迁移）在 DNSPod 复用场景下**原理上无法生成正确的 scopeId**
（域名与站点无对应关系），只能写空值或固化用户当年可能手滑填的 zoneId → 静默数据破坏。
方案 C（整体拒绝）会把只读能力也一起打断。

采用分级：

1. **二义性一律硬错**：`domainId` 与 `accountId`/`scopeId` 同时存在 → `AMBIGUOUS_LOCATION`。
2. **只读动作（list / get / plan）继续走旧路径**：存量工作流的观测能力不中断；步骤记录标 `contract: 'v1-legacy'`。
3. **写类动作（`ext.write`，即 replace）在旧形态下拒绝执行**：固定错误码 + 迁移指引。
   拒绝点固定在 `authorizeTencenteoOriginGroup` 内、**早于任何 `resolveDomainAccount` / 凭据解析**
   （理由同 §2.8：解析会抛可区分他人资源的错误串）；handler 侧再加一道纵深防御。
   理由：写不可逆（整组覆盖 + `privateParameters` 丢失），而「迁移期误打站点」只在写动作上不可挽回；读错了可以重跑。
4. **迁移助手只读且按 owner 收敛**：`GET /api/workflows/migration-report` 输出
   `workflowId → {旧参数, 推导出的 accountId, 候选 scopeId 列表, 是否可自动映射}` 的 dry-run 表，
   用户确认后逐条手动改。候选 scopeId 由 `listTeoZones` 给出，让用户在真实站点列表里选，不机器猜。
   **范围限定**：只返回 `listByOwner(requesterId)`（与 `loadOwnedWorkflow` 同口径），超管需显式声明才全量；
   候选 scopeId 必须经 `assertScopeVisible`（= 账号可见 ∧ 站点属于该账号）后才生成——否则这个端点本身就是「遍历他人账号 + 站点列表」的现成工具，
   把 §2.4 刚堵掉的面从后门重新打开。
5. **契约版本入审计**：步骤记录带 `contract` 与 `resolvedTarget`（见 §4）。

> 说明：`domainId` 与 `accountId` 在参数声明里**同时存在**会撞 `UNKNOWN_ARG` / `MISSING_ARG`，
> 不是天然得到「422 + 迁移指引」。该提示需**额外实现**，不能假设白送。

## 4. 数据层影响

- 不改表结构：能力位由 `extraCapabilities` 派生，不落库。
- 存量 `workflows.definition` 不自动改写。
- **步骤记录增加 `resolvedTarget: { accountId, scopeId, siteType, groupId }`**（沿用 `run-steps` 的 JSON 列）。
  落点机制**明确为侧通道**：`resolvedTarget` 旁挂在 handler 返回值上并由引擎剥离写入步骤记录，
  **不进入动作的 DSL 可见返回值**（返回值可被 `var.*` 引用，属对外契约，不得污染）。
剥离必须发生在引擎落步骤记录**之前**且对 DSL 求值不可见，否则「旁挂」会漏进 `var.*`。
  理由：`input` 只存实参、`inputDigest` 只哈希实参，事后无法把 `domainId: 7` 还原成当时的站点；
  且 `plan` 与 `replace` 是两次独立解析，两步的 `resolvedTarget` 不一致时在审计上一眼可见。

## 5. 前端影响

- 动作面板：所选账号不支持源站组时隐藏该组动作。判据来自**后端**（§2.2 的能力派生 + 账号的 provider type），
  前端不自行推导。需要 `ProviderExtraAction` 增加 `providerType` 并透传到 `buildStaticMeta('actions')`。
- 三级级联：**级联机制本身已具备**（`CascadingSelect` 已把 `param.sourceParams` 从 `args` 取值作为 query，路由再透传进 `ctx.params`），
  真正缺的是 `ProviderMetaContext` 的 domainId 中心化——它把 `domainId`/`domainName`/`zoneId` 声明为必填，
  需改为可选并增加 `accountId`/`scopeId`。**不要重写级联组件。**

## 6. 风险

| 编号 | 风险 | 缓解 |
|---|---|---|
| R1 | 存量写类动作被拒，用户不知如何迁移 | `migration-report` dry-run + 固定错误码与指引 |
| R2 | 账号级判定挂不上（死代码） | 走 handler 层 hook（§2.5） |
| R3 | 账号内选错站点 | `scopeId` 归属校验（§2.6）+ digest 绑位置（§2.7） |
| R4 | 候选源与能力层谓词不一致 | 共用 `assertAccountVisible` / `getOriginGroupCapability` |
| R5 | 源名写错静默失败 | §0.2 构建期校验 |
| R6 | DNSPod 用户丢失入口 | 能力位含凭据复用一支（§2.2） |
| R8 | 站点可见性 60s 缓存成为两条路径的唯一权威：键不含凭据指纹，账号改 SecretId 后旧站点仍被判可见 ≤60s；`resetZoneAuthorizationCache` 目前仅供测试 | **显式接受**：方向是「陈旧放行」而非越权；后续可把凭据指纹并入缓存键，或在账号更新时清缓存 |
| R7 | `TeoOps.domainName` 失去来源 | 改名 `scopeName`（纯日志用途），并把 `zoneName` 带进结果回显 |

## 7. 验收

- **摘要绑位置**：同内容跨站点 plan/replace → `DIGEST_MISMATCH`（单测）
- **候选源账号校验**：他人 accountId → `NOT_FOUND`；遍历不得泄露他人站点（单测）
- **二义性**：`domainId`+`accountId` 并存 → `AMBIGUOUS_LOCATION`；`zoneId`/`scopeId` 不做并存
- **存量只读不中断**：带 `domainId` 的 `list` / `get` / `plan` 仍成功，步骤记录 `contract = 'v1-legacy'`（这个回归必须有验收拦住）
- **写类旧形态拒绝**：带 `domainId` 的 replace → 固定错误码 + 指引，拒绝点早于任何凭据解析
- **写维度未退化**：团队成员调 `replace` → `WRITE_FORBIDDEN`（上一轮 P0 的修复成果，重写钩子时不得丢）
- **角色词表**：超管（route 侧 `role=3`）在 `accounts?originGroup=true` 里能看到账号；「创建者+超管」判为 write
- **`accountId` 数值校验**：`"abc"` → `INVALID_ARGS`（不是 `NOT_FOUND`）
- **迁移报告范围**：非超管只能看到自己的 workflow；候选 scopeId 经 `assertAccountVisible` 后才生成
- **鉴权顺序**：鉴权前不得出现可区分他人资源的错误串（枚举面回归）
- **能力位一致性**：`getOriginGroupCapability` 与 `extraCapabilities` 实际注册一致（不变量单测）
- **源名校验**：所有 `source` 都在注册表内（§0.2）
- **审计**：步骤记录含 `contract` 与 `resolvedTarget`
- e2e：账号 → 站点 → 源站组三级联动；账号不支持时动作列表不含源站组
## 8. 需同步修改的文档

| 位置 | 内容 |
|---|---|
| 设计 §12.1（API 表） | 新增 `GET /api/workflows/migration-report`，并写明**不进入** `initCheckMiddleware` 豁免清单 |
| 设计 §3.7.8（候选源表） | `accounts?originGroup=true`、`edgeoneZones?accountId=` 两个入参语义；并说明 `originGroups` 的参数列实为「候选源依赖」 |
| 设计 §3.6 / §4（运行记录） | 步骤记录新增 `contract`（`'v2'` 或 `'v1-legacy'`）与 `resolvedTarget` |
| 设计 §1701（勘误） | `registry.ts` 行号 `:12` / `:22` 实际是 `:17` / `:27` |
| docs/api.md | `migration-report` 端点；`accounts` / `edgeoneZones` 的新入参；步骤字段 |

## 9. 实现阶段的偏离记录（评审后回写）

实现与本文提案不完全一致的地方，逐条记录理由，避免后来者以为是疏忽。

| 编号 | 提案怎么写的 | 实际怎么做的 | 理由 |
|---|---|---|---|
| D1 | §0.2 抽 `BUILTIN_META_SOURCES` 常量 | 门禁改为扫描路由里的 `source === '...'` 分支 | 目标达成且少一处漂移源；常量本身也要与路由同步 |
| D2 | §0.2 注册源改声明式数组 | 仍是 `registerProviderMetaSource` 副作用 | 门禁已不依赖注册表，env 问题从另一侧解决 |
| D3 | §2.6 `listTeoZones` 改签名 | 新增 `listTeoZonesByAccount`，旧签名保留 | §3.2 的旧只读路径仍需要域名版 |
| D4 | R7 `domainName` 改名 `scopeName` | **已改名** | 账号路径下该字段存的是站点名，原名语义错位 |
| D5 | §2.1 只用 URL 查询串 | 参数声明新增 `sourceQuery: Record<string,string>` | 类型化比拼 URL 安全，且能随候选请求一起发 |
| D6 | §2.6 归属校验在钩子里统一走 `listZones` | **下沉进 `teoOpsForAccount`** | 一处实现同时服务候选源与执行路径；**不变量：该函数的 scope 归属校验不得删除**，加缓存或改签名要保留 |
| D7 | —（提案未提） | 路由不再 import 提供商私有模块：谓词移到 `providers/registry.ts`，站点列表走候选源注册表 | 与本文件上方「核心路由只按 source 名转发」的纪律一致 |

另外两处实现选择（非偏离，值得记录）：

- **账号路径与旧路径各校验一次，不重复**：`teoOpsForAccount` 内部已做 `scopeId ∈ listZones`，钩子只对 legacy 分支再查。
- **站点可见性缓存抽到 `tencenteo/zone-visibility-cache.ts`**：两条路径共用 60s 缓存。改造前 tencenteo 账号零次 `DescribeZones`，改造后每次动作都要打（1000 站点即 10 次），不加缓存会撞上游限流，且失败会拖挂全部源站组动作。

