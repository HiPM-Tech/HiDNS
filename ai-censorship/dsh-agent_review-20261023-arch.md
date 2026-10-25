# HiDNS 架构极端测试报告（结构性裂缝视角）

- 角色：架构极端测试员（arch-auditor）
- 日期：2026-10-23（报告文件名沿用评审批次日期）
- 范围：`server/src`（405 个 .ts，80,584 行）；只读源码，改动仅落在 `/tmp/archtest` 隔离实例与 `/tmp/*.mjs|*.mts` 脚本
- 基线规范：`root.ai.md`（§数据库 40-119、§路由 360-395、§服务层 396-435、§应用初始化与生命周期 476-502、§外部应用集成 API 605-673）
- 结论一句话：**分层「禁止性」条款基本守住了（routes 无一处直连 DAL/DL/DSM），但「唯一出口」在四个轴上同时漏水——响应信封、初始化状态、事务、模块依赖图。5 条 P1 都属于"每个调用点各自守规矩、但公共边界不设防"的同一病根。**

## 0. 分级与计数

| 级别 | 数量 | 编号 |
| --- | --- | --- |
| P0 | 0 | 无（未发现可远程利用的跨租户数据泄露或未授权接管；见 §3 排除项） |
| P1 | 5 | A1 A2 A3 A4 A5 |
| P2 | 10 | A6 A7 A8 A9 A10 A11 A12 A13 A14 A15 |

复现环境（全部发现均在下列隔离实例上实测，未触碰生产库 `server/data/hidns.db`）：

```bash
mkdir -p /tmp/archtest && cd /tmp/archtest
PORT=3901 DB_PATH=/tmp/archtest/hidns.db HIDNS_INIT_MARKER=/tmp/archtest/.initialized \
HIDNS_LOG_LEVEL=warn NODE_ENV=development \
/workspace/HiDNS/server/node_modules/.bin/tsx /workspace/HiDNS/server/src/app.ts
```

证据脚本（可直接重跑）已随报告落在 `ai-censorship/evidence/arch-20261023/`：
`scan_resp.mjs` `scan_env3.mjs` `scan_tx.mjs` `cycles2.mjs` `tx_partial.mts` `cap_probe.mts`。

## 1. 结构性风险图（文字）

```
                       ┌─────────────────────────── 唯一注册点 api/index.ts ───────────────────────────┐
  浏览器 ──HTTP──▶ app.ts:429 initGate ──▶ modules ──▶ routes/*.ts ──▶ BAL(business-adapter) ──▶ DAL ──▶ DL
      │                │  三态门禁(initialized/uninit/unreachable)        │
      │                │  只用 req.path 字符串，不认识 upgrade 事件       │
      │                └──▶ /api/docs(swagger)  /api/* 业务  ────────────┘
      │
      └──WS upgrade──▶ service/websocket.ts:38 (直挂 http server)  ✗ 不受门禁约束（A8）
                                  │
                                  └── broadcastToUsers(audience)  ← 只有 routes 层会算 audience（A10）

  写路径扇出（同一"记录变更"三个入口，出口能力不对等）：
     routes/records.ts ──▶ adapter + 审计 + domain-event-bus + WS(audience 精确)   ← 全
     workflow/actions ──▶ adapter + domain-event-bus                                ← 缺 WS
     mcp/tools.ts      ──▶ DnsProviderService + domain-event-bus                     ← 缺 WS

  依赖图循环（cycles2.mjs，405 文件 / 1163 边 / 4 个 SCC）：
     [15] lib/dns/providers/* ──▶ service/whois/* ──▶ lib/dns/providers/*   （lib ↔ service 双向）
          lib/dns/providers/registry.ts ──▶ providers/index.ts ──▶ registry.ts
          registry.ts ──▶ tencenteo/extra.ts ──▶ origin-group-context.ts ──▶ registry.ts
     [2]  db/dal/types.ts ↔ db/dl/types.ts            （抽象层 ↔ 驱动层，分层倒置）
     [2]  lib/dns/ns-lookup.ts ↔ lib/dns/resolver/index.ts
     [2]  providers/dpdns_reverse/index.ts ↔ scheduler.ts

  状态/生命周期双源：
     systemState.ts: initialized(内存+磁盘标记)   ← 门禁/守卫用
     connection.ts : lastProbe(DB 探测三态)        ← 启动日志/状态接口用
     两者可长期不一致 → A2（"已初始化但零用户"砖化态）
```

## 2. 发现明细

### A1（P1）非 GET 的未匹配请求返回 Express 默认 HTML 404，`{code,data,msg}` 信封整体失效

**现象**：方法不匹配（POST/PUT/DELETE 落到没有该方法的路径）时，响应是 `text/html` 的 Express 默认页，不是 API 信封；客户端按 JSON 解析直接炸。

**证据**（初始化完成的 3901 实例）：

```
$ curl -s -o /dev/null -w '%{http_code} %{content_type}\n' -X POST http://127.0.0.1:3901/api/nonexistent
404 text/html; charset=utf-8
$ curl -s -X POST http://127.0.0.1:3901/api/init/status
<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Error</title></head>
<body><pre>Cannot POST /api/init/status</pre></body>
</html>
$ curl -s -o /dev/null -w '%{http_code} %{content_type}\n' -X PUT http://127.0.0.1:3901/api/init/status
404 text/html; charset=utf-8
```

**根因**（三处叠加，缺任何一处都不会漏）：
1. `server/src/app.ts:491` `app.get('*', createSpaFallback(...))` —— 只挂 GET，非 GET 直接掉进 Express 的 finalhandler。
2. `server/src/middleware/spaFallback.ts:9-11` 只处理 `/api/` 的 GET，且返回体本身也缺 `data`（`{code:404,msg}`）。
3. `server/src/app.ts:494` `app.use(errorHandler)` 是**异常**中间件（4 参），不承担 404 兜底。

**最小复现**：上面三条 curl 即可。**修法**：在 `app.use(errorHandler)` 之前追加 `app.use('*', (req,res)=>sendError(res,'API endpoint not found',404))`（JSON 兜底），并让 spaFallback 的 API 分支同样走 `sendError`。

### A2（P1）初始化标记与数据库状态矛盾 → 实例"砖化"，且状态接口自相矛盾、日志与门禁互相打脸

**现象**：磁盘标记存在 + 数据库是全新空库（迁移/误删库文件/换库）时，系统判定"已初始化"→ 安装入口永久 403，而库里没有任何用户 → 无法登录、无法重装。

**证据**（保留 `/tmp/archtest/.initialized`、删除 `hidns.db` 后重启，PORT=3902）：

```
$ curl -s http://127.0.0.1:3902/api/init/status
{"code":0,"data":{"initialized":true,"dbInitialized":true,"hasUsers":false,"dbReachable":true},"msg":"success"}
$ curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3902/api/init/admin
403          # {"code":403,"msg":"System already initialized"}
$ curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3902/api/init/database
403
$ curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3902/api/domains
401          # 无用户 → 无凭据可登录
```

同一时刻的启动日志（`/tmp/archtest/server2.log`）自相矛盾：

```
[Server] [SystemState] Database initialization state changed { from: 'unreachable', to: 'uninitialized' }
[Server] [SystemState] [L140] Database looks uninitialized but the initialization marker exists. Delete the marker file to re-run setup.
[Server] [App] System not initialized. Running in initialization mode.      ← app.ts:597
[HTTP] [Route.Init] [requireInitSurface] [L54] Setup endpoint blocked: system already initialized { path: '/admin' }
```

**根因**：两个状态源各自演进 ——
- `service/systemState.ts:89` `initialized = markerExists()`（启动即置位、粘性），`isInitSurfaceOpen()`（:112-114）只看 `!initialized && lastProbe==='uninitialized'`；
- `app.ts:590-599` 的启动分支却用 `initialState`（DB 探测值）决定打印哪句日志、是否启动任务；
- `routes/init.ts:53-57` 的守卫又只认 `isSystemInitialized()`。
三者对"未初始化"的定义不同，于是出现"日志说在初始化模式、门禁说已初始化、状态接口说 initialized=true 且 hasUsers=false"的三重矛盾。恢复手段只有运维手工 `rm data/.initialized`（`systemState.ts:140` 的日志也是这么提示的），即**服务自身无自愈路径**。

**修法建议**：把"已初始化"定义为 `marker ∧ 最近一次 probe 不是 uninitialized`，probe 为 `uninitialized` 且标记存在时进入独立的 `inconsistent` 第四态：只读探测开放 + 明确提示"标记与库不一致，需运维确认"，并禁止打印 "Running in initialization mode"。

### A3（P1）providers 与 service 互为依赖，形成 15 模块强连通分量；DAL↔DL 类型层双向依赖

**证据**（`ai-censorship/evidence/arch-20261023/cycles2.mjs`，解析 `from`/`import()` 相对导入后跑 Tarjan）：

```
$ node cycles2.mjs
files: 405 edges: 1163
cycles(SCC>1): 4
=== SCC size 15
    lib/dns/providers/registry.ts -> lib/dns/providers/index.ts
    lib/dns/providers/index.ts -> lib/dns/providers/dnshe/index.ts
    lib/dns/providers/dnshe/whoisScheduler.ts -> service/whois/index.ts
    service/whois/index.ts -> service/whois/scheduler.ts
    service/whois/scheduler.ts -> lib/dns/providers/index.ts
    lib/dns/providers/registry.ts -> lib/dns/providers/tencenteo/extra.ts
    lib/dns/providers/tencenteo/origin-group-context.ts -> lib/dns/providers/registry.ts
    lib/dns/providers/virtual/index.ts -> lib/dns/providers/virtual/extra.ts
    lib/dns/DnsHelper.ts -> lib/dns/providers/registry.ts
    service/dns-provider-service.ts -> lib/dns/DnsHelper.ts
    lib/dns/account-context.ts -> service/dns-provider-service.ts
    ... （共 24 条边，完整输出见证据脚本）
=== SCC size 2
    db/dal/types.ts -> db/dl/types.ts
    db/dl/types.ts -> db/dal/types.ts
=== SCC size 2
    lib/dns/ns-lookup.ts -> lib/dns/resolver/index.ts
    lib/dns/resolver/index.ts -> lib/dns/ns-lookup.ts
=== SCC size 2
    lib/dns/providers/dpdns_reverse/index.ts -> lib/dns/providers/dpdns_reverse/scheduler.ts
    lib/dns/providers/dpdns_reverse/scheduler.ts -> lib/dns/providers/dpdns_reverse/index.ts
```

关键边定位：`providers/registry.ts:10` `import * as Adapters from './index'`（注册表 ↔ 桶文件互指）；`db/dl/types.ts:16` `from '../dal/types'`（驱动层反向依赖抽象层）。

**为什么是结构裂缝而不是洁癖**：
- `registry.ts:352-393` 在**模块求值期**执行 `validateDefinitions` / `validateCredentialSharing`，而 `registry` 自身处在一个 15 节点环里 —— 环内任一模块把 `providerDefinitions` 的求值顺序提前/延后，校验就会在 `allProviderDefinitions` 尚未完成初始化时跑；目前只是恰好没有触发 TDZ（本次实测 25 个 provider 全部可解析，见 A12 证据）。
- `lib/`（被 service 引用的基础设施）反向 import `service/whois`、`service/dns-provider-service`，等于 lib 层无法单测/无法复用：任何只想要 provider 定义的消费方都会被拖进 WHOIS 调度器与 DAL。
- `db/dal/types.ts ↔ db/dl/types.ts` 直接违反 `root.ai.md:52` 规定的单向调用链（BAL→DAL→DL）。

**修法**：把 `registry` 的 adapter 装配拆成 `providers/factory.ts`（只被 `createAdapter` 使用），`registry` 只持有纯声明；把 `whoisScheduler` 数组上移到 `service/whois/` 侧注册（组合根注入），切断 lib→service；`dl/types` 不得 import `dal/types`（需要的契约下沉为 `dl/` 自有类型）。

### A4（P1）多表写没有事务：`withTransaction` 在生产代码里只被用过 1 次，13 处多写端点全部裸奔

**证据 1**（唯一的公共事务原语几乎没人用）：

```
$ grep -rn 'withTransaction' server/src --include=*.ts
.../business-adapter.ts:1993: export async function withTransaction<T>(...)
.../business-adapter.ts:5308:   transaction: withTransaction,
.../business-adapter.ts:5320:   withTransaction,
.../business-adapter.ts:5447:     await withTransaction(async (trx) => {      ← 生产代码唯一调用点
.../db/index.ts:29:   withTransaction,
```

**证据 2**（多写端点清单，脚本 `scan_tx.mjs` 口径：同一 handler 内 ≥2 个 BAL 写操作）：

```
teams.ts:155   POST /            :: TeamOperations.create, TeamOperations.addMember
domains.ts:821 POST /            :: DomainOperations.updateThirdIdAndRecordCount, DomainOperations.create
domains.ts:993 POST /sync        :: DomainOperations.create, updateThirdIdAndRecordCount
ns-monitor.ts:297 POST /         :: NSMonitorOperations.delete, create
settings.ts:329 PUT /security    :: SettingsOperations.set, DomainExpiryOperations.saveNotification, saveDays
... 共 13 处
```

**证据 3**（复刻 `routes/teams.ts:155-176` 的写序列，第二步故意失败）：

```
$ DB_PATH=/tmp/archtest/tx.db tsx tx_partial.mts
seed user id = 1
step1 TeamOperations.create -> id = 1
step2 addMember FAILED: FOREIGN KEY constraint failed
after-failure: 团队行仍在 = true 成员数 = 0
```

**后果**：孤儿团队（无 owner）、域名批量导入半成功、NS 监控"删了没建回来"、安全策略三键只落一半 —— 全部需要人工修数据，且审计日志只记了半截。**修法**：把 `withTransaction` 提升为路由层的唯一写入口（`teams.ts`/`domains.ts`/`ns-monitor.ts`/`settings.ts` 的写序列包一层），或把序列下沉为 BAL 的复合操作函数。

### A5（P1）降级启动路径与正常启动路径的定时任务集合不一致；重连 60 次后永久放弃

**证据 1**（两条启动路径的任务清单对比，`app.ts`）：

| 任务/调度器 | 正常路径 `startAllJobs` (558-585) | 降级重连路径 (679-691) |
| --- | --- | --- |
| `initRenewalSchedulers()` | ✔ 570 | ✘ **缺失** |
| `initWhoisSchedulers()` | ✔ 571 | ✘ **缺失** |
| `startGroupedCacheRefreshJob()` | ✔ 579 | ✘ **缺失** |
| `startPublicSuffixJob()` | ✔ 583 | ✘ **缺失** |
| `startMcpOAuthCleanupJob()` | ✔ 642（try 分支外） | ✘ **缺失** |
| 其余 9 个 | ✔ | ✔ |

即：数据库启动时不可达 → 恢复后进入"半功能"状态，续期/WHOIS/分组缓存/公共后缀/MCP OAuth 清理全部静默不启动，且没有任何日志提示缺失（日志只说 "System initialized detected. Normal routes are now enabled."）。

**证据 2**（永久放弃，与 `root.ai.md:492`"健康检查须能持续重试，不得因一次失败而永久放弃"直接冲突）：

```
server/src/app.ts:670:  const MAX_RETRIES = 60; // Maximum 60 retries (5 minutes at 5s intervals)
server/src/app.ts:698-701:
  if (retryCount >= MAX_RETRIES) {
    log.error(`Failed to initialize after ${MAX_RETRIES} attempts. Stopping retry.`);
    clearInterval(initCheckInterval);      // 之后进程永远停在降级态，只能人工重启
  }
```

同时该分支每次重试都调用 `initializeDSM()`（app.ts:676），即每 5 秒对同一个坏库跑一次完整 schema 协调（含备份管理器），故障期间放大数据库压力。

**修法**：抽 `startAllJobs()` 为唯一启动函数供两条路径共用（含 mcpOAuthCleanup）；重连改为指数退避+封顶且不设总次数上限；DSM 协调只在连接状态由坏转好时执行一次。

## 3. P2 明细

### A6（P2）同一端点两种响应形状：`GET /api/accounts` 分页元数据默认丢失
`server/src/routes/accounts.ts:145-158`：

```ts
const page = parseInt(req.query.page as string) || 0;          // 0 基！
if (page > 0) sendSuccess(res, { list, total, page, pageSize, totalPages });
else sendSuccess(res, safe);                                   // 裸数组
```

```
$ curl -s -b cookies http://127.0.0.1:3901/api/accounts            → data: [ {...}, {...}, {...} ]
$ curl -s -b cookies 'http://127.0.0.1:3901/api/accounts?page=1'   → data: { list:[...], total:3, page:1, pageSize:20, totalPages:1 }
```

同一端点 `data` 的类型随 query 变化（数组 ↔ 对象），且 `page` 基准与其他端点不一致（其余端点 1 基）、`pageSize` 上限四套：accounts/domains/ns-monitor/servicemonitor/mcp-audit=100、`utils/http.ts:63` parsePagination=200、resource-monitor=1440、workflows=500。`docs/api.md:305` 对此完全没有记载（违反 `root.ai.md:607` 的文档同步强制项）。

### A7（P2）信封 `data` 系统性缺失：138 个站点，根因在公共 helper
`node scan_env3.mjs server/src` → `带 code 但缺 data 的信封站点: 138`（分布：auth.ts=45、settings.ts=21、init.ts=18、tokens.ts=15、mcp-apikeys.ts=11…）；另有 54 个完全非信封站点（OAuth RFC6749 / RDAP 协议形状）。

根因：`utils/http.ts:84-91` `sendError(res,msg,status,data?)` 直接 `data` 透传 `undefined`，`JSON.stringify` 会丢弃该键 —— 于是 `authMiddleware` 的 `sendError(res,'Unauthorized',401)`（`middleware/auth.ts:25`）实测返回 `{"code":401,"msg":"Unauthorized"}`。**修法**：`data: data ?? null` 一行即可让 138 处自动合规。

### A8（P2）WebSocket 升级路径完全不参与初始化门禁三态
`service/websocket.ts:38-42` 把 `WebSocketServer` 直挂 `http.Server` 的 upgrade 事件，环内没有 `isSystemInitialized()` / `isInitSurfaceOpen()` / `lastProbe`。

```
$ curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3903/api/socket/ws   → 503（门禁拦）
$ node -e 'new (require("ws"))("ws://127.0.0.1:3903/api/socket/ws")...'
upgrade ACCEPTED (open)                       ← TCP 101 已建立
closed code= 4001 reason= Authentication required
```

即门禁只作用于 express 层；WS 只靠 token 拦。降级/未初始化态下若存在未过期 JWT（例如标记与库矛盾态、或 DB 抖动前的会话），WS 仍可建连，而 HTTP 一律 503 —— 两套会话生命周期不同源（`service/jwt.ts:8-27` 签名密钥含 runtime_secret，DB 不可读时会退化为进程内随机密钥，是唯一的事实防线）。

### A9（P2）特权收件人判定两份实现，且 60s 缓存没有任何失效点
`routes/audience.ts:32`（`getAdminAudienceUserIds`，每次现查 `UserOperations.getAll()`）与 `service/realtime-audience.ts:93-95`（`getSuperAdminUserIds`，走 `loadPrivilegedUsers` 的 60s 缓存）并存；`routes/audience.ts:69-80` 的 `getAccountAudienceUserIds` **混用两者**（超管取缓存、其余现查）。`realtime-audience.ts:28-31` 自注释承认"同一口径的两份实现"。

```
$ grep -rn 'resetRealtimeAudienceCache' server/src --include=*.ts
（仅 8 处，全部在 *.test.ts / 定义处；生产代码无调用）
```

后果：用户被降级或停用后，accounts/teams/servicemonitor 的推送收件人最长 60 秒仍含该用户，而 users/settings 的收件人立即生效 —— 同一"权限变更"在两个端点上口径不同。**修法**：权限变更时调用 `resetRealtimeAudienceCache()`，并把 routes/audience.ts 收口到 service 层。

### A10（P2）同一种"记录变更"三个写入口，只有 routes 一层做 WS 扇出
```
$ grep -rn 'wsService' server/src/workflow server/src/mcp --include=*.ts    → 无输出
routes/records.ts:107  async function pushRecordEvent(...) { wsService.broadcastToUsers(audience, ...) }
workflow/actions/dns/record.ts:115,129,151   仅 adapter 写 + publish()
mcp/tools.ts:1335,1418                       仅 DnsProviderService 写 + publishDomainEvent
```
工作流/MCP 改动的记录不会推送，UI 必须手动刷新；而 `publish()` 的语义是"给工作流自己订阅"，不能替代 WS 扇出。这不是安全漏洞（方向是少推），但两条路径对同一个事实的可见性不同源。

### A11（P2）能力位 `capabilities.dns` 不在工厂层校验，守卫散落在调用点
`providers/registry.ts:342-349`：`dpdns_reverse` 声明 `capabilities: { dns: null, log:false, renewal:true }`，但 `adapterFactory` 照常提供，且适配器实现了全部 DNS 方法：

```
$ tsx cap_probe.mts
capabilities: {"dns":null,"log":false,"renewal":true}
adapter built: DpdnsReverseAdapter | getDomainList is function: true
```

`DnsHelper.ts:80-105` 的 `createAdapter` 只查 `providerDefinitionMap`，不查能力位；实际防护点只有 3 处（`records.ts:64`、`domains.ts:1543-1546`、`accounts.ts:88`）。任何新增调用点（`domainSyncJob.ts:142`、`recordCountCache.ts:18`、`domains.ts:1007/1123/1482/1529`）都会绕过能力位。

### A12（P2）响应/错误处理三套并存，编译器无法兜底
- `utils/http.ts:69-95`：`sendSuccess/sendError`（23 个文件在用，事实标准）
- `utils/response.ts:9-141`：`ResponseHelper`（带 `timestamp` 字段、默认 msg 为 'Success'），**只被自己的测试文件引用**；且 `ApiResponse.data?: T`（:12 可选）让编译器无法强制 `data`
- `middleware/errorHandler.ts:15-74`：`AppError`+`errorHandler`，另有 `utils/response.ts:147-177` 的第二份 `asyncHandler`/`globalErrorHandler`（死代码）

### A13（P2）`db/` 有四个门面，唯一出口不唯一
`db/connection.ts`（dal 的兼容门面）、`db/database.ts`（deprecated，又转一层）、`db/index.ts`（"主入口"，同时导出 BAL+DSM）、`db/bal/business-adapter.ts`（规范认定的唯一业务入口）。实测引用分裂：`app.ts:200` 用 `./db/connection`、`app.ts:204` 用 `./db/dal/connection`、`service/systemState.ts:15` 用 `../db/connection`、23 个 routes 用 `../db/bal/business-adapter`。规范只禁止了 routes 直连 dal/dl/dsm（这一点守住了），但没有收敛"应该从哪进"。

### A14（P2）初始化向导的三场景逻辑在"被本进程碰过的库"上恒为 Scenario B
`routes/init.ts:196-268` 用 `SystemOperations.testConnection().hasExistingData` 分流，而该值的定义是"存在任意非 sqlite_ 前缀的表"（`business-adapter.ts:2131-2142`）；`app.ts:541` 在初始化向导之前就已跑完整 DSM 建表 —— 于是任何本进程曾连接过的库都是 `hasExistingData=true`。

```
$ curl -s -X POST http://127.0.0.1:3901/api/init/database -d '{"type":"sqlite","sqlite":{"path":"/tmp/archtest/hidns.db"}}'
{"code":0,"data":{"success":true,"skipToUserCreation":true,...},"msg":"Database already initialized. Please create admin user."}
```

Scenario C（`init.ts:270-305`：生成 JWT_SECRET、`delete process.env._TEMP_DB`、`initializeSchema()`）在正常路径上不可达，只有显式 `reset=true` 才进得去。连带后果：`_TEMP_DB` 不会被清（`/api/init/admin` 走 B 分支同样不清），`db/dal/config.ts:126,138` 会继续忽略 `DB_PATH`；JWT_SECRET 的生成也不会在向导里发生。

### A15（P2）DSM 在 SQLite 上永不给已存在的表补外键（迁移兼容天花板的显式化）
`db/dsm/schema-reconciler.ts:649`：`if (!tableDef.foreignKeys || dbType === 'sqlite') return;` —— 新建表会带 `FOREIGN KEY`（`:985-990`、`:1079-1084`），但**已存在**的表在 SQLite 上永远不会补外键。实测新库（DSM 建）`PRAGMA foreign_key_list(dns_records)` 正常返回 CASCADE；而旧版 `initSchema`（`db/init.ts`）建的库则会长期缺约束、依赖 FK 级联的删除（`routes/domains.ts:1347` 只 `DELETE FROM domains`，靠级联清 `dns_records`/`domain_permissions`）在该库里会留下孤儿行。**这不是现网 bug，是迁移面的结构性天花板**：任何"补约束"的 schema 变更在 SQLite 上都无法通过协调器生效，必须走"重建表"路径，而当前没有该路径。

## 4. 已检查但不成立的候选（避免误报，一并说明）

| 候选 | 检查方式 | 结论 |
| --- | --- | --- |
| routes 直连 DAL/DL/DSM | `grep 'from \.\./db/(dal|dl|dsm|connection)'` 覆盖 `server/src/routes` | **0 命中**，规范 §2/§9 守住了；service→routes 反向依赖也是 0 |
| 外键级联缺失 | `PRAGMA foreign_key_list` 逐表核对 | 新库 FK 齐全且 CASCADE 生效（我最初把 `dns_records` 误读成 `records`，已纠正） |
| 资源监控 WS 全局广播越权 | 对比 `routes/resource-monitor.ts:16,21`（仅 authMiddleware）与 `service/resource/job.ts:25` | 口径一致（都只要求登录），非越权 |
| 工作流动作重名静默覆盖 | `registry.ts:34-40` Object.assign + `validate-names.ts:59-80` | CI 已强制 duplicate-name 检测 |
| 并发重复建域名（无唯一索引 TOCTOU） | 8 并发 `POST /api/domains` 同名 | 实测仅落 1 行（Node 单线程串行化），未复现；仍建议加 `(account_id,name)` 唯一索引作为跨进程护栏 |
| 队列/任务管理器自旋 | `taskManager.ts` 审阅 | 已有退避+重排上限，符合 `root.ai.md:414-418` |

## 5. 建议修复顺序

1. A1（JSON 404 兜底，1 行）+ A7（`data: data ?? null`，1 行）——同一次提交，信封漏水一次性收口。
2. A2（第四态 `inconsistent` + 状态接口单一来源）+ A5（`startAllJobs` 共用 + 退避不封顶）——生命周期两个高发故障态。
3. A3（拆 `registry` 工厂、切断 lib→service）+ A13（收敛 db 门面）——先解环再谈分层重构。
4. A4（写序列事务化）——按"最疼"顺序：teams → ns-monitor → settings → domains。
5. A6/A8/A9/A10/A11/A12/A14/A15——批量收口，可挂到"信封与扇出统一"专项。

Current:HiDNS 后端架构极端测试 / Result:ai-censorship/dsh-agent_review-20261023-arch.md（15 条：P1×5、P2×10，含 5 个可重跑证据脚本）/ Next:待 Lead 决定是否把 A1+A7 作为首批一行修复项合入


## 修复状态（执行层回填，提交 `176cb5b` / `c31c090`）

| 编号 | 状态 | 说明 |
| --- | --- | --- |
| A1 非 GET 未匹配 → HTML 404 | ✅ 已修 | `app.all('/api/*')` → `sendError 404` |
| A2 标记/DB 矛盾导致初始化死锁 | ✅ 已修 | 库可达且无用户时重新开放初始化面并记 critical |
| A7 信封缺 `data` | ✅ 已修 | `sendSuccess/sendError` 统一 `data: data ?? null`（并加断言用例） |
| A3 providers↔service 循环依赖 | ⏳ 未修 | 需要拆 registry/index 的依赖方向（结构性，排期） |
| A4 多表写无事务 | ⏳ 未修 | 13 处多写端点需要 `withTransaction` 包裹 |
| A5 降级路径少起 5 个任务 | ✅ 部分修 | 补齐 4 个（renewal/whois/grouped/PSL）；MCP OAuth 清理任务仍在恢复路径缺失 |
| P2 组（两套响应形状、capabilities 校验、db 四门面等） | ⏳ 未修 | 见报告正文 |

## 第三轮（2026-10-23 · 回归 + 新角度）

> 复测对象：`b53e406`（SSRF/密码强度/WHOIS 队列）、`c8b5031`（分组缓存）、其余第五组修复。
> 环境：隔离实例 `/tmp/archtest3`（PORT=3910 dev / 3911 production），未触碰生产库与生产代码。
> 本轮脚本：`/tmp/r3_guard.mts` `/tmp/r3_reach.mts` `/tmp/r3_whois.mts` `/tmp/r3_pw2.mts` `/tmp/r3_throttle.mjs` `/tmp/r3_oauth.mjs` `/tmp/r3_norm.mts`（已复制到 `ai-censorship/evidence/arch-20261023/`）。

### 2.1 回归结论（逐条 PASS/FAIL）

| # | 第二轮反馈项 | 结论 | 决定性证据 |
| --- | --- | --- | --- |
| 1 | SSRF 守卫（IP 判定/不走 DNS/checkSSL/每跳重定向） | **FAIL**（2 处） | `isPrivateAddress('::ffff:7f00:1')=false`、`resolvePublicTarget→{ok:true}`，而 `net.connect(39461,'::ffff:7f00:1')` 直达 127.0.0.1 的监听端口；重定向复核把**整条 URL** 传给只收 hostname 的函数 → 100% 判"目标无法解析"（见 2.2 N1） |
| 2 | password-strength 限长 72 + 按 IP 每秒 10 次 | **FAIL**（部分：限长 ✔ / 节流可绕过） | 73 字符 → `400 {"code":400,"data":null,"msg":"Password too long (max 72)"}` ✔；并发 30 无伪造头：`200=10 429=20` ✔；**并发 30 每条换 X-Forwarded-For：`200=30 429=0`**（生产模式 trust proxy 默认开启）；72 字符实测成本 42–155ms → 单 IP 可达 1.55 core |
| 3 | WHOIS 队列每轮上限 200 | **FAIL**（把队列饿死换成了覆盖饿死） | `SELECT id,name,account_id FROM domains` 无 ORDER BY/OFFSET/时间过滤 + `slice(0,200)`：250 域名实测两次查询顺序完全一致，batch 恒为 id 1..200，**id 201+ 永不进入任何一轮** |
| 4 | 分组缓存未命中不再 bump；定时刷新清空+重建 | **PASS（有保留）** | `domains.ts:348-369` 未命中不再 bump ✔；但 `refreshGroupedCaches` 只做 `clearAll()+bump`，**没有重建**（与"清空+重建"描述不符）；`groupedCacheJob.ts:63-66` 的增量写仍在 bump 全局版本 → 一次写操作仍让全部用户缓存失效（惊群未消） |
| 5 | 删域名清所有用户 NS / 续期审计 / CSV 转义 / NFKC / 413 | **PASS**（CSV 仅主路径） | `DELETE FROM ns_monitor_domains WHERE domain_name=?`（跨用户）+`domains.ts:1381` ✔；`add_renewable_domain`/`delete_renewable_domain`/`renew_domain` 审计齐 ✔；`escapeCSV` 单测+`^[=+\-@\t\r]` 前缀 ✔；`ｅｘａｍｐｌｅ．com→example.com`、`例え.テスト→xn--…` ✔；200KB body → `413 {"code":413,"data":null,...}` ✔ |

**FAIL 计 3 条（1/2/3），PASS 2 条（4 有保留、5 通过）。**

### 2.2 新发现

#### N1（P1）SSRF 守卫两处真漏洞：映射型 IPv6 直通内网 + 重定向复核参数用错（顺带把 followRedirects 功能打坏）

**a) `::ffff:7f00:1` / `::ffff:a9fe:a9fe` 被当作公网**（`serviceMonitor.ts:666-688` 的 v6 分支只认点分形式的 `::ffff:1.2.3.4`，遇到十六进制映射形式递归进 `isPrivateAddress('7f00:1')` → `net.isIP=0` → 返回 false）：

```
$ tsx r3_guard.mts
::ffff:127.0.0.1     isIP=6 private=true      ← 点分形式被拦
::ffff:7f00:1        isIP=6 private=false     ← 十六进制映射漏判
::ffff:a9fe:a9fe     isIP=6 private=false     ← 169.254.169.254 的映射形式
$ tsx r3_reach.mts
listening on 127.0.0.1:39461
isPrivateAddress(target) = false | resolvePublicTarget = {"ok":true}
net.connect(39461, ::ffff:7f00:1) => CONNECTED (equivalent to 127.0.0.1)
```

`checkSSL` 用 `tls.connect(port, target)` 直连（`serviceMonitor.ts:299`），target 就是未加工的配置值，因此"内网端口扫描 oracle"（第二轮 A-6 的原始形态）仍可用这一族写法复现。`isSafeMonitorHost` 对 IPv6 字面量一律放行（`net.isIP` 为真即过），不构成第二道防线。

**b) 每跳重定向复核把 URL 当 hostname 传**（`serviceMonitor.ts:439`：`resolvePublicTarget(redirectUrl)`，而该函数只接受 hostname）：

```
$ tsx r3_guard.mts
http://example.com/            {"ok":false,"reason":"目标无法解析: getaddrinfo ENOTFOUND http://example.com/"}
https://example.com:8443/a?b=1 {"ok":false,"reason":"目标无法解析: getaddrinfo ENOTFOUND https://example.com:8443/a?b=1"}
```

后果：**任何 3xx 跳转的 endpoint 监控都会 100% 报 error**（`重定向目标被拒绝: 目标无法解析`）。这项"加固"实际把 followRedirects 变成死功能，而它想堵的洞是因为参数错误才被堵上的。

**结构性根因**：同一个"目标放行"判定被三种输入约定共用（hostname 字面量 / 完整 URL / 解析后地址），函数签名不区分、调用点各自猜；且仍是 resolve→connect 的两段式（未钉 IP），DNS rebinding 窗口未闭合。**修法**：`resolvePublicTarget(input)` 内部统一 `new URL()` 兼容 host 与 URL；私有地址判定改为"先把 v4/v6 统一解析为字节再比对网段"（或直接 `dns.lookup` 后按地址族`net.BlockList` 判定）；请求用已校验的 IP 直连并设置 `servername`（防 rebinding）。

#### N2（P1）节流以 `req.ip` 为键，而该值在生产部署下由 X-Forwarded-For 决定 → 节流可完全绕过，CPU 放大仍在

`routes/security.ts:39-50` 的手写桶取 `req.ip`；`app.ts:294-302` 在 `NODE_ENV=production` 下默认 `trust proxy =` loopback/私有段 —— 标准 nginx 反代部署里 `req.ip` 就是 XFF 最左值（客户端自填）。实测（生产模式，3911）：

```
并发 30（无 XFF）        200=10 429=20
并发 30（每条换 XFF）    200=30 429=0     ← 全部放行
```

配合 72 字符单次 42–155ms 的实测成本（`r3_pw2.mts`），单个攻击者即可占满 1–1.5 核；`strengthBuckets` 还只增不删（每 IP 一条，Map 无淘汰/无上限），伪造 IP 可再叠加内存增长。同类问题扩散面：`middleware/clientIP.ts:45-73` 的 `getClientIP` 同样取 XFF 最左值，`loginLimit`/`deviceTrust`/审计 `ip_address` 全部沿用该口径。**修法**：反代场景改用"信任跳数"（取 XFF 倒数第 N 个）或只在最后一跳可信时用 `X-Real-IP`；节流交给统一的 `express-rate-limit` store（带过期），不要再手写无淘汰 Map。

#### N3（P2）MCP 审计导出的 CSV 完全未转义（孪生导出路径未统一）

`routes/mcp-audit.ts:131-140` 用模板字符串直拼 CSV，不经 `escapeCSV`；`/api/audit/export/csv` 已加固。实测（人工写入一行 `ip_address='=cmd|calc!A1'` 的审计）：

```
$ curl -b cookie ".../api/mcp/audit-logs/export?format=csv"
{"code":0,"data":{"format":"csv","record_count":1,
 "data":"id,user_id,...,ip_address,created_at\n1,1,api_key,...,200.0,=cmd|calc!A1,2026-10-23 10:00:00"},"msg":"success"}
```

口径修正（避免夸大）：`mcp/tools.ts` 的 5 处 `logMcpAction` **都不传 `ipAddress`**，故 `ip_address` 目前恒为 NULL，公式注入尚无"武装"的可控列；本条按 P2 记（列错位 + 与主路径安全等级不一致 + 一旦有人补传 IP 即成注入点）。另 `response_status` 输出成 `200.0`（SQLite REAL 存储），同一处数据保真问题。

#### N4（P2）DSM 字段改名必然丢数据：协调先于迁移，且迁移只在 legacy 模式运行

`schema-reconciler.ts:251-254` 对"schema 中已消失的列"直接 `ALTER TABLE … DROP COLUMN`（SQLite 走重建表），只打 `log.warn('Using table rebuild for SQLite DROP COLUMN')`；而 `init-dsm.ts:28` 的 reconcile 在 `init-dsm.ts:34-37` 的 data migration **之前**执行，且 migration 只在 `isLegacy` 为真时才跑。结论：非 legacy 库上做一次字段改名（删旧列+加新列）＝旧列数据被 DROP 且没有任何机制读回，只能靠备份。缺一条 CI 门禁："schema 中消失的列必须显式声明 rename/drop 意图"。同轮复查：第一轮 A4 的 13 处多写端点**仍未事务化**，`DELETE /api/domains/:id` 现在写 domains + ns_monitor_domains + operation_logs 三张表，依旧无事务包裹（回归确认，不是新问题）。

#### N5（P2，未复现但结构性缺口）OAuth 授权码兑换缺 CAS

`business-adapter.ts:5010-5033`：先 `SELECT * WHERE code=?`、判 `used`，再 `UPDATE … SET used=true WHERE code=?` —— UPDATE 没有 `AND used=false`，不具备原子性。单进程实测并发两次兑换只成功 1 次（第二次 `invalid_grant`），因为 SQLite 同步驱动让两次 SELECT 落在不同 tick；**多实例/多进程部署下该窗口真实存在**（同一 code 可换两枚 token）。按 P2 记（未证伪，非未验证）。

### 2.3 本轮排除的候选（避免误报）

| 候选 | 检查 | 结论 |
| --- | --- | --- |
| 邮件模板变量替换注入 | `lib/dns/emailTemplate.ts`/`service/smtp.ts` 全搜 `{{ }}`/`replace(` | 模板是静态 HTML，无运行时变量插值，不成立 |
| MCP 工具 member 越权（scope 提升） | `service/mcp-permission.ts:231-292` 工具→模块映射 + `validateToolPermission` | 工具名与模块白名单一一对应，未发现绕过 |
| 授权码并发重放（单进程） | 见 N5 | 未复现，已按结构性缺口记录 |
| 官方 CSV 导出注入 | `escapeCSV` + `data` 列由 `JSON.stringify` 生成（以 `{` 开头） | 主路径成立（公式/引号/逗号均处理），仅 MCP 孪生路径漏（N3） |


---

Current:HiDNS 后端架构第三轮回归与新角度 / Result:ai-censorship/dsh-agent_review-20261023-arch.md「## 第三轮」（回归 5 项：3 FAIL / 2 PASS，新发现 5 条：P1×2、P2×3，脚本 7 个在 ai-censorship/evidence/arch-20261023/）/ Next:优先修 N1（重定向守卫传 hostname + 映射型 IPv6 网段判定）与 N2（IP 口径改信任跳数），N3/N4 可并入下一批



## 第三轮修复状态（执行层回填，提交 `e2308b1` / `64b62bb`）

| 编号 | 状态 | 说明 |
| --- | --- | --- |
| N1 映射型 IPv6 / 重定向 URL | ✅ 已修 | 见 pentest 报告同表 |
| N2 节流 XFF | ✅ 已修 | `socket.remoteAddress` + Map 惰性清理 |
| R3 WHOIS 覆盖 | ✅ 已修 | 游标轮转 + 单测（两轮覆盖 250 个域名） |
| R2-3 缓存命中仍 JSON.parse 1.3MB | ⏳ 未修 | 建议进程内 LRU（key=userId+cacheType+version），或把缓存内容缩到 id/name/account_id |
| R2-4 写操作仍 bump 全局版本 | ⏳ 未修 | 建议改为按用户版本或直接增量写 |
| DSM 改名丢数据 / 13 处多表写无事务 | ⏳ 未修 | 结构性，需单独排期 |

## 第六轮（HEAD 63b34c4 · 结构收尾 + 性能实测）

> 环境：隔离实例 `/tmp/arch6`（PORT=3920，SQLite，300 个域名），未触碰生产库与生产代码；同机还有其他评审实例在跑，绝对 QPS 有噪声，故以**比值**为准。
> 脚本：`/tmp/arch6_bench.mjs` `/tmp/arch6_oauth.mjs` `/tmp/arch6_b2.mts` `/tmp/arch6_dsm2.mts` `/tmp/arch6_st.mjs` `/tmp/arch6_rl.mts`（已复制到 `ai-censorship/evidence/arch-20261023/`）。

### 3.1 A) 复测

**A1 分组 QPS：PASS（4.6x → 1.15x）**

```
$ node arch6_bench.mjs            # 300 域名 / 并发 20 / 8s
非分组 /api/domains    qps=  29.4 ok=235 err=0 p50=557ms p95=1448ms
分组 ?grouped=true     qps=  25.6 ok=205 err=0 p50=766ms p95=1096ms
差距倍数 = 1.15x
$ 单请求耗时（无并发）             plain 12.6~13.7ms  |  grouped 14.1~15.5ms   → 1.12x
```

多次查询已消除，分组只多出"全量取 + 内存分块"这一份成本。**保留意见**：分组路径每次仍读 + `JSON.parse` 整份 `grouped_domains_cache` 行（第五轮记录为 1.3MB 量级），成本随域名数线性增长；300 域名下 1.15x 的比值不能外推到 5000 域名。

**A2 授权码闭环：PASS**

```
1 create client  : {"code":0,"data":{"client_id":"hidns_mcp_261228b4...","client_secret":"c8e447..."}}
2 authorize      : code=hda_a51585...            （POST /authorize, decision=allow）
3 token(首兑)    : OK status=200
4 introspect     : {"active":true,"scope":"dns:read","client_id":"hidns_mcp_...","user_id":1,...}
5 code 重放      : invalid_grant                  （单次可用 ✔）
6 revoke         : {}
7 撤销后 introspect: {"active":false}
8 /api/mcp tools/list: 503 {"code":503,"msg":"MCP is disabled","data":null}   （MCP 默认关闭，非流程问题）
1' 动态注册：{"error":"registration_not_supported"}  —— 注册改为管理员建（POST /oauth/clients），符合收敛预期
```

### 3.2 B) 一致性：3 处关键多表写

| 路径 | 结论 | 证据 |
| --- | --- | --- |
| 域名创建（`domains.ts:884-929` 循环） | **FAIL（留半成品）** | 复刻同一写序列，第 2 项注入 FK 失败：`循环第 2 项抛出: FOREIGN KEY constraint failed` → `added=1`、`ok-1.test 已在库`、domains 表 1 行；路由走 asyncHandler → 500，且 `firstId` 之后的缓存更新整段不执行（缓存与库不一致） |
| 团队创建（`teams.ts:170-183`） | PASS（有保留） | `d27eff0` 已加补偿删除：addMember 失败 → `TeamOperations.delete(id)` → 500。**保留**：补偿不是原子，进程在 create 与补偿之间崩溃仍留孤儿团队；且这是本项目唯一一处手写补偿，其余 12 处多写没有 |
| 记录批量导入（`records.ts:643-760`） | PASS（设计语义） | 逐条 try/catch + 200 信封返回 `results` 逐行结果，注释与 `docs/api.md` 都写明"部分成功不撤销"；审计只在成功>0 时记一条。**衍生问题**：`record_count` 仅在记录列表接口回写（`records.ts:206-208`），批量写后计数滞后到下一次 30 分钟缓存刷新；本地 `dns_records` 表在 BAL 层**零读写**（只被提供商 URL 字面量命中），属死表 |

### 3.3 C) DSM 字段改名：**FAIL（真丢数据，已最小复现）**

```
$ DB_PATH=/tmp/arch6/rename2.db tsx arch6_dsm2.mts
BEFORE : [{"name":"keep.test","remark":"KEEP-ME-42"}]
AFTER columns: id,account_id,name,third_id,remark_note,is_hidden,enabled,record_count,...
AFTER  : [{"name":"keep.test","remark_note":""}]
OLD column still present = false | 数据是否保住 = false
```

复现步骤：跑一次 `initializeDSM()` → 写一行 `domains.remark='KEEP-ME-42'` → 把 `COMPLETE_SCHEMA` 里该列改名为 `remark_note` → `new SchemaReconciler().reconcile(cloned)`。结果：`reconcile` 直接 `ALTER TABLE … DROP COLUMN remark`（SQLite 走重建表，`schema-reconciler.ts:251-254`，只打 warn），新列按默认值 `''` 补齐，旧值不可恢复。
**结构性原因**：`init-dsm.ts:28` 的 reconcile 在 `init-dsm.ts:34-37` 的 data migration 之前，且 migration 只在 `isLegacy` 为真时运行 → 非 legacy 升级路径上"改名"永远没有补救机会。**修法**：CI 增加"schema 中消失的列必须显式声明 `renamedFrom`/`dropped`"门禁；reconciler 遇到未声明的消失列应 `fail-fast` 而不是自动 DROP。

### 3.4 D) 契约：非 JSON 响应 / 会话 vs Token

**D1 非 JSON 响应：FAIL（4 类里 2 类）**

```
GET  /api/nonexistent      -> 404 application/json {"code":404,"data":null,"msg":"API endpoint not found"}   ✔
POST /api/nonexistent      -> 404 application/json {"code":404,"data":null,...}                             ✔（第一轮 A1 已修）
PUT  /api/init/status      -> 404 application/json {"code":404,"data":null,...}                             ✔
POST /api/auth/login (200KB)-> 413 application/json {"code":413,"data":null,"msg":"Request body too large"} ✔
POST /api/init/test-db ×32 -> 前 29 个 403，第 30 起 429 {"code":429,"msg":"Too many setup requests..."}   ✘ 缺 data
rdapLimiter 触发            -> 429 text/html  Too many RDAP queries, please try again later.                ✘ 非 JSON
```

最后一行用隔离最小复现（`arch6_rl.mts`，同一 `rdapLimiter` 挂到裸 express）：

```
200 [application/json] {"ok":1} || 200 [application/json] {"ok":1} || 429 [text/html] Too many RDAP queries... ×4
```

根因：`middleware/rateLimit.ts:6-10` 有正确的 `rateLimitHandler`（信封 + data:null），但只有 login/email/api/strict 四个限流器用了它；`rdapLimiter`(`:96`)、`createLimiter`(`:80`)、`createUserLimiter`(`:115`) 仍用 `message: string`，express-rate-limit 对字符串走 `res.send()` → `text/html`；`routes/init.ts:32` 用 `{code,msg}` 对象 → JSON 但无 `data`。**修法**：全部改用 `rateLimitHandler(...)`，删掉 `message` 字段。

**D2 会话 vs Token：形状差异是**已文档化**的，但参数被静默忽略（P2）**

```
GET /api/domains?grouped=true  session=object{list,total,page,pageSize,totalPages} | token=array | 同形=false
GET /api/domains               session=object{list,total,page,pageSize,totalPages} | token=array | 同形=false
GET /api/domains?format=array  session=array                                        | token=array | 同形=true
GET /api/accounts?page=1       session=object{...}                                  | token=object{...} | 同形=true
```

`docs/api.md:337` 已明确"Token 认证时直接返回数组而非 `{list,total}`"，所以**形状差异不算违约**；但 `grouped=true` 对 Token 调用方是**静默 no-op**（`domains.ts:176-179 resolveDomainListShape`：`format` > Token > 会话，且 `domains.ts:251 wantsGrouped = grouped==='true' && !tokenPayload`）—— 参数被接受了却不生效，既无报错也无提示，外部集成方按文档传 `grouped=true` 会拿到完全不同的结构。建议：Token 调用 `grouped=true` 时返回 400/或文档显式标注"Token 下忽略"。

### 3.5 上线判断

**可以上线（建议灰度一个版本）**。本轮 8 项里 3 项 FAIL 均不在网络入口的安全路径上：C 是"升级期才会触发"的数据丢失（需要有人改 schema 字段名）、B1 需要循环中途出现数据库错误、D1 是限流 429 的响应形状。前五轮的 P0/P1（SSRF/节流/WHOIS 覆盖/信封/门禁）已逐项闭合，A1/A2 两个本轮主干目标都达标。
**上线前必须做的一件小事**：把 `rdapLimiter`/`createLimiter`/`createUserLimiter` 换成 `rateLimitHandler`（1 处配置改动，消除唯一的非 JSON 出口）；**下个迭代必修**：C（DSM 改名 fail-fast 门禁）与 B1（域名创建事务化）。


---

Current:第六轮结构收尾+性能实测 / Result:ai-censorship/dsh-agent_review-20261023-arch.md「## 第六轮」（A1 分组 4.6x→1.15x PASS、A2 OAuth 闭环 PASS、B/C/D 共 3 FAIL、契约仅剩 429 形状）/ Next:上线前把三个 message:string 限流器换成 rateLimitHandler


## 第六轮修复状态（执行层回填，提交 `213ef88`）

| 编号 | 状态 | 说明 |
| --- | --- | --- |
| D1 限流 429 非 JSON | ✅ 已修 | `rdapLimiter`/`createLimiter`/`createUserLimiter`/`initLimiter` 全部换 `rateLimitHandler` |
| B1 域名创建留半成品 | ✅ 已修（补偿） | 记录已插入 id，异常时逆序删除后 rethrow；仍非真事务，进程崩溃窗口存在 |
| C DSM 字段改名丢数据 | ⏳ 未修 | 需要「rename 迁移先于 reconcile」的机制；当前 schema 无 rename 条目，但改名字段仍是隐患 |
| A1 分组 QPS | ✅ 1.15x（原 4.6x） | 跳过分组模式下的首次分页查询 |

## 2.3.0 重构目标核对（HEAD 9fd03ac6 · 角色：arch-auditor，范围=目标 4 + 架构结构）

> 方法：只读代码 + 2 条门禁实测（`server: tsc --noEmit`、`vitest run`）+ 1 个降级实例（DB_PATH 指向目录，无标记）+ panel 86 条清单逐层抽样。
> 目标 1（前端重写）不在本角色范围，未核；目标 2/3/5 只写我实测到的旁证。

### A. 门禁实测（00-PLAN §5）

```
$ cd server && npx tsc --noEmit -p tsconfig.json   → exit 0（无输出）
$ cd server && npx vitest run                       → Test Files 80 passed (80) / Tests 638 passed (638), exit 0
```

与提交信息「80 文件 638 条全绿」一致。**注意**：`00-PLAN §5` 与 `01-SUMMARY §5` 对 client 仍写 `tsc --noEmit`（:76-78 已注明该命令在 solution 式工程下空转），复现门禁时容易再次踩空。

### B. 目标 4 计数（86 条）

| 层级 | 总数 | 抽样 | 达成 | 部分 | 未达成 |
| --- | --- | --- | --- | --- | --- |
| P0 | 7 | 7（100%） | **5** | **2** | 0 |
| P1 | 58（12 主题） | 24（41%，每主题 1–3 条） | **11** | **3** | **10** |
| P2 | 21 | 2（10%） | 1 | 0 | 1 |

抽样方法：P0 全量逐条；P1 按 T1–T12 每主题抽取"最易证伪的 1–3 条"（优先安全与门禁类），条目号见下表；P2 抽 A-11 与"文档类"两条。**不外推**：58 条里只对 24 条给了判定，其余 34 条未核。

### C. P0 七条逐条

| P0 | 判定 | 证据 |
| --- | --- | --- |
| P0-1 初始化守卫 | **达成（单层）** | 门禁层已闭环：降级实例实测 `POST /api/init/database → 503`、`/api/init/admin → 503`、`/api/domains → 503`、`/api/init/status → 200`（`init-gate.ts:51-63`）。**残留**：`routes/init.ts:53` 的 `requireInitSurface` 仍只判 `isSystemInitialized()`，未用 `isInitSurfaceOpen()`——双层防护只剩门禁一层 |
| P0-2 DSM 删表 | **达成** | `schema-reconciler.ts:17-23` 默认 `'never'`，需显式 `HIDNS_DSM_DROP_TABLES` 才删 |
| P0-3 标记持久化 | **达成** | `systemState.ts:56` 用 `resolveDataDir()`；`:163` `markInitialized(): boolean` |
| P0-4 错误折叠 | **部分（规避式）** | 见 F2 |
| P0-5 RecordId | **部分** | 创建路径已回查（`bt/adapter.ts:206 → resolveCreatedRecordId`）；见 F3 的 9 处残留 |
| P0-6 line 多义 | **达成** | `service/record-line.ts:37 resolveLineInput` 被 records.ts:573/792/879 使用；`registry.ts:56 defaultLine`+`providerLines.ts`；workflow 传 `undefined`（`dns/record.ts:115`）；redirect 独立能力位（见 F9） |
| P0-7 凭据掩码 | **达成** | `service/account-config.ts:33 mergeMaskedConfig` + `routes/accounts.ts:370` + `__tests__/account-config.test.ts` |

### D. 发现（12 条，按目标分组）

#### F1（目标4 · P0-4 未真正闭合）"不写 0"是规避，不是失败通道；真 0 条从此永不刷新
`service/recordCountCache.ts:18-24` 用 `if (result.total > 0 && ...)` 保护写库，但适配器仍把读失败折叠成 `{total:0,list:[]}`（`grep -c 'total: 0, list: \[\]' providers/**` = **92**），`DnsInterface.ts:29` 的 `PageResult` 至今没有失败通道。后果对调：一次上游失败不再把计数写成 0（旧问题），但现在**一个域名真的被删到 0 条**时，`record_count` 永远停在旧值，直到有人手动触发别的写路径。

#### F2（目标4 · P0-5 残余）9 处 `toNumber(recordId, 0)` 仍在 update/delete 上：非法 ID 变成"0 号记录"
```
$ grep -rn 'toNumber(recordId, 0)' server/src/lib/dns/providers | wc -l → 9
dnshe/adapter.ts:341,365  powerdns/adapter.ts:271,320,364  rainyun/adapter.ts:301,337  dnspod/adapter.ts:184,224,249
```
路由把 URL 里的 `recordId` 原样透传（`records.ts:846 DELETE /:recordId`），非数字 ID 在上游被当作 `0`。P0-5 只修了创建路径的返回 ID，删除/更新路径的"非法即失败"没有落地。

#### F3（目标4 · T1 未闭合）92 处错误折叠 = 同一语义仍无唯一执行点
`cloudflare/adapter.ts:160,194,203`、`aliyun`、`gcore` 等全部 `catch → { total: 0, list: [] }`；`recordCountCache` 是"消费端打补丁"，不是"上游区分失败"。panel 明确要求"以 dnspod 为模板向内收敛"，HEAD 上 dnspod 之外仍是折叠。

#### F4（目标4 · T2 未闭合）`TaskOptions.concurrency` 仍是死字段；`DSM_BACKUP_REQUIRED` 两处默认仍相反
```
service/taskManager.ts:32   concurrency?: number;      ← 全文件仅此一处
service/taskManager.ts:173  while (... this.runningTasks.size < this.maxConcurrentTasks)   ← 全局并发
db/dsm/backup-manager.ts:16        this.isBackupRequired = process.env.DSM_BACKUP_REQUIRED !== 'false';   // 默认 true
db/dsm/schema-reconciler.ts:470    const continueOnFail   = process.env.DSM_BACKUP_REQUIRED !== 'true';     // 默认 false
```
同一个环境变量，备份器"默认必须备份"，协调器"默认备份失败也继续"——正是 panel B-05 描述的相反默认，未修。18 处调用方仍在传 `concurrency`，仍无人读。

#### F5（目标4 · T6 未闭合）超时只 reject，不阻止任务本体：同 ID 并发双跑窗口仍在
`taskManager.ts:260-271` 用 `Promise.race([fn(), timeout])`，超时后走 catch → `finally { this.runningTasks.delete(taskId); this.processQueue(); }`（`:326-330`）。`fn()` 并没有被取消，仍在跑，而 ID 已被释放 → 下一个同 ID 任务立即可以并发执行（panel E-02 的原始形态）。

#### F6（目标4 · T5 安全边界，3 项未闭合）
```
middleware/rateLimit.ts:102-107  skip: req.headers.authorization?.startsWith('Bearer ') → true（不校验 token 有效性，随便填个 Bearer 就免 RDAP 限流）
routes/settings.ts:385           router.post('/smtp/test', authMiddleware, adminOnly, ...)   ← 缺 noTokenAuth，管理员 API Token 可触发发信
routes/providers.ts:20           router.get('/:type/icon', asyncHandler(...))                ← 全局唯一未鉴权的业务 GET
```
同主题里 `/API/...` 大小写、`sendError` 默认 200、登录限流 XFF、`allowed_services` 硬编码 4 项已闭合（见 F7 的统计）。

#### F7（目标4 · T9/T10/T11 门禁类，部分闭合）
- 已闭合：腐化 4 用例已删除（`vitest.config.ts:26-31` 注释与 exclude 同步）；`validateEnv()` 已接线（`config/env.ts:169`）；`canSelectProxy` 已消失；两个 router 同挂 `/api/security` 已被 registry 的前缀唯一性从结构上禁止。
- **未闭合**：`test-database.yml:86,112,127,135,159` 仍有 **5 处 `continue-on-error: true`**，`:140` 仍有 `pnpm run test:init-detect || true`；`release.yml` 仍有 **10 处 `--no-frozen-lockfile`**；`check_i18n_simple.js` 在 `scripts/`、`package.json`、`.github/` 仍**零引用**（H-11）。

#### F8（目标4 · T12 未闭合）INFO/DEBUG 仍不输出 `[函数名] [L行号]`，与 root.ai.md:129-131 的格式契约冲突
```
$ HIDNS_LOG_LEVEL=debug tsx /tmp/logfmt.mts
2026-10-25T10:07:24.007Z  INFO [TEST] info line                        ← 无 [func][L]
2026-10-25T10:07:24.017Z  WARN [TEST] [<anonymous>] [L4] warn line       ← 只有 warn 有
```
`logger.ts:289` 的 `emit()` 确实把 `callerInfo` 传下去了，但 `log()` 只在 warn/error 分支渲染它（`logger.ts:215-240` 的 level switch）。

#### F9（DNS 适配器语义）线路/能力位：**达成**，但 `proxiable` 能力位仍无消费者
`registry.ts:56 defaultLine` + 26 家全部显式声明；`service/providerLines.ts` 支持内置/动态与降级（TTL 3600s）；`records.ts:61-97` 的 `resolveRedirectTarget` 按 `capabilities.redirect` 强制（未声明→忽略、声明→校验 URL、适配器未实现→501）。**缺口**：`proxiable` 仍只被前端"展示"，服务端代理判定仍按 `providerType` 硬编码（panel 结论表最后一行未变）。

#### F10（目标2 未达成）分页口径**没有**收敛成一套（00-PLAN §3:59 明文要求，§4 P1 却标"已完成"）
```
routes/accounts.ts:146   const page = parseInt(req.query.page) || 0;        ← 0 基，且 page<=0 时返回裸数组
routes/accounts.ts:147   pageSize 上限 100
routes/audit.ts:91       parsePagination(..., maxPageSize: 200)             ← 上限 200
routes/domains.ts:448    Math.min(1000, ...)                                ← 上限 1000（分组）
routes/workflows.ts:308  Math.min(500, ...)                                 ← 上限 500
```
同一套 API 里 0 基/1 基并存、4 种上限（100/200/500/1000）、`/api/accounts` 的 `data` 随 `page` 在"数组 ↔ {list,total}"之间切换。

#### F11（目标2 部分达成）信封：`code === HTTP` 已 0 违例，但 **138 处** `{code,msg}` 仍缺 `data`
```
$ node scan_env3.mjs server/src
带 code 但缺 data 的信封站点: 138   完全非信封（无 code）: 56
分布: auth.ts=45 settings.ts=21 init.ts=18 tokens.ts=15 mcp-apikeys.ts=11 mcp-oauth.ts=11 mcp-config.ts=6 …
$ node scan_env.mjs server/src  → CODE/HTTP MISMATCH: 0
```
`sendError` 已改为 `data ?? null`（`utils/http.ts:84-91`），但这 138 处是手写对象，绕过了 helper。

#### F12（目标3 达成 / 目标5 部分）`api/` 唯一注册点成立；模块解耦与迁移回滚仍有硬缺口
- 目标 3：`server/src/api/{index,registry,init-gate,mount}.ts` + `modules/`，`buildApiModules()` 声明 **23** 个模块（`grep -c "id: '" api/index.ts` = 23；文档 `01-SUMMARY.md:13` 写 24，轻微漂移）；`app.ts` 里除 `:483` 的一行静态 CORS 头外**没有任何业务 `app.use`**；registry 强制 id/prefix 唯一（大小写与参数名归一化）、probe 必须属于自身前缀。**达成**。
- 目标 5：`routes/` 对 `db/dal|dl|dsm` 的直连为 **0**（只有 service 层 `systemSetup.ts`/`systemState.ts` 触碰），`client/src` 无直连 `fetch`、features 无硬编码 `/api/`。**但**模块依赖仍是环状（`cycles2.mjs`：15 模块 SCC `lib/dns/providers ↔ service/whois`、`db/dal/types ↔ db/dl/types`、`ns-lookup ↔ resolver/index`、`dpdns_reverse/index ↔ scheduler`），与第一轮 A3 同源、HEAD 未变；`db/dsm` 无任何 rollback 实现（`grep -rn rollback db/dsm` 为空），迁移只靠备份，字段改名必丢数据（第六轮 `remark→remark_note` 已复现）。

### E. 结论

- **目标 4：部分达成**。P0 5/7 闭合，P1 抽样 11 达成 / 3 部分 / 10 未达成；未闭合集中在 4 个"同一形状"：错误折叠（T1）、声明未接线（T2 concurrency/DSM_BACKUP_REQUIRED）、安全边界的漏点（T5 三项）、门禁的静默容错（T9/T10/T11）。
- **文档 vs 代码**：`00-PLAN §4` 把 P1「API 语义（分页统一）」、P2「panel P0 全部 + P1 安全类」标为"已完成"，与 F1/F2/F6/F10 冲突；`01-SUMMARY §1` "修复遗留隐性问题 已完成" 同理。
- 五项目标逐项：1 未核（非本角色）；2 部分（F10/F11）；3 达成（F12）；4 部分（F1–F8）；5 部分（F12）。

---

Current:2.3.0 目标核对（目标4+架构）/ Result:本节（P0 5/7、P1 抽样 11/3/10、12 条发现）/ Next:优先 F1/F2/F5/F6 四条（错误通道、recordId 校验、任务超时取消、T5 三漏点）

