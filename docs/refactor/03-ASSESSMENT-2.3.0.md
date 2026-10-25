# 2.3.0 重构达成度分析（对照 root.ai.md）

> 评审对象：2.3.0 发布提交（本地 `1935263d`，等价于原始 128 个提交）。
> 依据：`root.ai.md` → `docs/refactor/00-PLAN.md` → `ai-censorship/dsh-agent_review-20261023-panel.md`（86 条隐性问题）→ 当前代码与测试。
> **结论先行：五个重构目标中 4 项达成、1 项部分达成；DNS 适配器只完成了「对外字段语义」，能力模型 / 记录标识契约 / 失败语义仍未闭合。**

## 一、与原定目标的对照

| 原定目标（00-PLAN §1） | 判定 | 依据 |
| --- | --- | --- |
| 1. 前端整体重写 | ✅ 达成 | TDesign/i18next/axios 清零；`client/src/pages` 已删除；29 个页面在 `features/`；主包 619→218 kB |
| 2. API 语义收敛 | ✅ 基本达成 | 信封 `{code,data,msg}` 与 `code===HTTP` 全量收敛；`line` 收敛到 `record-line.ts`；分页口径表入 `docs/api.md` |
| 3. API 注册独立子模块 | ✅ 达成 | `server/src/api/{registry,init-gate,mount,index}`，24 模块唯一注册点，三态门禁 |
| 4. 清理遗留隐性问题 | ⚠️ 部分 | panel 7 条 P0：5 条已修；P0-4 部分（计数不再被写成 0，但读失败仍折叠为空集）；P0-5（RecordId）未修 |
| 5. 前后端解耦 | ✅ 达成 | 前端 `features/*/api.ts` 统一走 `lib/http.ts`；后端 routes→service→BAL→DAL，`lib/lifecycle.ts` 隔离 |

## 二、DNS 适配器语义（root.ai.md 行 277–318）

### 2.1 已解决

| root 条款 | 证据 | 判定 |
| --- | --- | --- |
| 类驱动 + registry 为唯一配置源 | `registry.ts` `PROVIDERS` 26 项；`adapterFactory` 在 registry 定义 | ✅ |
| `DnsAdapter` 接口与基类 | `DnsInterface.ts` 12 方法齐全；`common.ts` 有 Base/Stub/AliyunRpc/TencentCloud/TokenAuth | ✅ |
| `line` 语义解构 | `service/record-line.ts:37` 唯一归一化点；`routes/records.ts:514/716/799` 三处调用；工作流不再硬编码 `'0'` | ✅ |
| 批量新增归一化 | 批量逐条走 `resolveLineInput`（records.ts:716） | ✅ |
| 隧道能力剔除 | 云适配器 4 个 tunnel 方法、`/api/tunnels`、令牌作用域已删 | ✅ |
| 虚拟提供商不参与可用列表 | `registry.ts:403` + `availability.ts` 生产硬关闭 | ✅ |
| provider 日志工厂 | 74 处 `createProvider*Logger`；aliyun 错误日志结构化并补失败日志 | ✅ 基本 |
| 禁止原生 fetch | providers 下无裸 `fetch(`，统一 `fetchWithFallback` | ✅ 功能等价 |

### 2.2 未解决 / 部分解决（核心结论）

| 编号 | 条款 | 现状证据 | 判定 |
| --- | --- | --- | --- |
| A1 | 能力位必须可执行（行 303–313） | 全仓仅 `recordTypes` 被校验（`routes/records.ts:61-66`）；`proxiable/weight/status/remark/redirect/cnameFlattening` 零校验；前端 `proxyCapable` 硬编码 cloudflare/aliyunesa（`records-page.tsx:285`） | ❌ 未解决（panel T2） |
| A2 | `RecordId: string`（行 284–294） | 4 个适配器仍返回字面量 `'success'`：`powerdns:244`、`vps8:206`、`namesilo:137`、`bt:206`；`dnspod:184/224` 用 `toNumber(recordId,0)`，非法 ID 变 0 | ❌ 未解决（panel P0-5） |
| A3 | 失败必须可判定（panel T1） | 真正的「失败折叠」：`aliyun` catch 返回默认线路（`aliyun/adapter.ts:216-217`）、`bt` catch 返回 5 条编造线路（`bt/adapter.ts:294-297`）；另有若干提供商把「无线路概念」实现为恒返回单条默认（`aliyunesa:332`、`dnshe:384`、`cloudflare:302`），以及静态线路表（`baidu:386`、`caihong:419`）——前者属实现取舍，但调用方同样无法区分「失败」与「本来就没有线路」 | ❌ 未解决（panel B-09） |
| A4 | 错误折叠（panel P0-4） | 计数侧已修：仅在 `result.total > 0` 时回写（`service/recordCountCache.ts:22-25`、`routes/records.ts:206-209`），不会再把抖动写成 0；但适配器读失败仍折叠成 `{total:0,list:[]}`（`routes/records.ts:204` 注释自认），调用方无法区分「失败」与「真的 0 条」 | ⚠️ 部分 |
| A5 | 必须用 requestJson/requestXml（行 281） | 仅 2/27 适配器使用；44 个文件直接 `fetchWithFallback` | ⚠️ 规范偏离 |
| A6 | 别名归一化（行 314–318） | 工厂 `createAdapter` 直接 `providerDefinitionMap.get(type)`（`DnsHelper.ts:81`），不归一化；历史库别名会抛 Unknown provider type | ⚠️ 部分 |
| A7 | index.ts「键名=类型、值=类」（行 279） | 实际是具名导出类，装配靠 registry 的 `adapterFactory` | ⚠️ 文档/实现漂移 |
| A8 | 别名表位置（行 314–318） | 实际在 `lib/dns/providerAlias.ts:33`，`DnsHelper` 已无 `PROVIDER_ALIASES` | ⚠️ 文档漂移 |
| A9 | provider 不得自建 DNS logger | `providers/common.ts:11` 仍 `createLogger('DNS')`（共享基类，灰区） | ⚠️ 灰区 |

## 三、判定

- **原定重构**：4 项达成、1 项（遗留隐性问题）部分达成。
- **DNS 适配器语义**：只解决了「对外字段语义」的一半——`line/proxied`、批量归一化、隧道剔除、虚拟提供商隔离、日志工厂、别名（查询侧）已收敛；**能力位执行、RecordId 契约、失败语义、HTTP 通道统一、工厂归一化未解决**。
- 准确表述：**「适配器对外语义已收敛，适配器契约与能力模型尚未闭合」**，不能写成「DNS 适配器语义已解决」。

## 四、建议收尾清单（2.3.x）

| 优先级 | 项 | 验收 |
| --- | --- | --- |
| P0 | RecordId 统一 string 非空、禁 `'success'`/`0` 兜底 | 26 provider 形状契约测试 |
| P0 | `getRecordLines` 失败必须抛错/标记（至少 aliyun / bt 等真正查询上游者） | 上游 500 时调用方拿到错误，而不是 `[{id:'0'}]` 或 5 条假线路 |
| P1 | 能力位执行（proxiable/status/remark/redirect/weight） | 非代理商传 proxied 返回 400；前端读能力位 |
| P1 | 错误折叠 fail-closed | 故障注入测试 |
| P2 | 统一 requestJson/requestXml 或更新 root 条款 | grep 门禁 |
| P2 | 工厂入口归一化 | `createAdapter('aliyun-esa')` 可用 |
| P2 | 更新 root.ai.md（别名位置、index 导出形态） | 文档自检 |

## 五、复现命令

```bash
grep -rn 'capabilities.dns' server/src --include=*.ts | grep -v test
grep -rn "'success'" server/src/lib/dns/providers/*/adapter.ts
grep -rn "id: '0', name: '默认'" server/src/lib/dns/providers/*/adapter.ts
grep -rln 'requestJson\|requestXml' server/src/lib/dns/providers/*/adapter.ts | wc -l
grep -rln 'fetchWithFallback' server/src/lib/dns/providers --include=*.ts | wc -l
sed -n '78,95p' server/src/lib/dns/DnsHelper.ts
```

关联：`ai-censorship/dsh-agent_review-20261023-panel.md`（P0-4/P0-5/T1/T2）、`docs/refactor/00-PLAN.md`（§1 目标 / §4 台账）。
## 六、修复状态（2.3.1 未发布，本地工作区）

| 编号 | 原判定 | 现状 | 证据 |
| --- | --- | --- | --- |
| A1 能力位 | ❌ | ✅ 基本修复：`recordTypes`、`proxiable`、`status`（禁用记录）、`remark`（不支持时丢弃）、`weight`（不支持时不传）均有执行点；前端代理开关改读 `capabilities.dns.proxiable`。`redirect` 无对应记录字段，暂不适用 | `routes/records.ts` `providerCapability/proxyCapabilityError`；`records-page.tsx` `useProviders()` |
| A2 RecordId | ❌ | ✅ 已修：`powerdns/bt/namesilo/vps8` 改用 `resolveCreatedRecordId()` 回查真实 ID，拿不到返回 `null`；`hidns` 改为 `String(r.id)`；新增源码守卫测试禁止 `return 'success'` | `providers/common.ts`；`__tests__/adapter-contract.test.ts` |
| A3 线路失败 | ❌ | ✅ 已修：`aliyun/bt/dnsneko/hidns_v2` 的 `getRecordLines` 失败改为抛错并写 `this.error`；源码守卫测试禁止 catch 分支返回固定列表 | 同上 |
| A4 错误折叠 | ⚠️ | ✅ 已修：`DnsProviderService.getRecords` 先 `clearError`，空结果 + 有错误 → 抛错（fail-closed）；计数仍只在 `total>0` 时回写 | `service/dns-provider-service.ts`；测试覆盖「空+错误抛错」「真空返回」 |
| A5 HTTP 通道 | ⚠️ | ✅ 已对齐文档：`root.ai.md` 明确允许 `requestJson/requestXml` 或 `fetchWithFallback`（同一代理通道），仍禁止原生 `fetch` | `root.ai.md` §DNS提供商适配器 |
| A6 工厂别名 | ⚠️ | ✅ 已修：`createAdapter` 入口 `normalizeProviderType`；新增 3 条用例（别名/大小写空白/未知类型） | `DnsHelper.ts`；`__tests__/adapter-alias.test.ts` |
| A7 index 导出形态 | ⚠️ | ✅ 已对齐文档：明确 index 为具名导出、装配由 registry `adapterFactory` 承担 | `root.ai.md:279` |
| A8 别名位置 | ⚠️ | ✅ 已对齐文档：改为 `providerAlias.ts` | `root.ai.md:322` |
| A9 common 自建 logger | ⚠️ | ⏳ 保留：`common.ts` 是共享基类，属规范灰区（非具体 provider 文件），已在报告中标注 | — |

修复后门禁：`server` 77 文件 / 617 条、`client` 41 文件 / 161 条，双侧 eslint 0、`vite build` 通过。
