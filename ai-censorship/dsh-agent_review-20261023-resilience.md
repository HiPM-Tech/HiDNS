# HiDNS 稳定性 / 瘫痪测试报告（并发 · 资源 · 故障注入 · 状态同步）

- 审查对象：`/workspace/HiDNS`（server 源码只读；未修改任何生产代码、未提交 git）
- 运行方式：从源码以 `tsx server/src/app.ts` 起隔离实例，数据库为 `server/data/hidns.db` 的**副本**（`/tmp/res-audit/data/app.db`），单机自压测。脚本落在 `/tmp/res-audit/`，归档于 `ai-censorship/evidence/resilience-20261024/`
- 结论口径：每条发现都附「命令 + 实际输出」；凡未复现的明确标注「未复现，按代码推断」。

## 结论

**P0 = 2，P1 = 7，P2 = 6。**

平台不具备「局部故障不放大」的能力：分组域名视图的缓存层是**负优化**（100% 不命中，且每次请求把全局缓存版本推高、重写 1.3 MB 缓存行），实测超管账号分组列表只有 **5.9 QPS**、同参数非分组为 **69.5 QPS**（11.8 倍差距），10 并发即出现 7.8 s 的 p95；WebSocket 在同一用户第二次连接后，**新连接被静默孤儿化**（仍在 OPEN，但再也收不到任何推送）。启动/恢复路径也有三类放大：数据库启动不可达时 HTTP 端口 **152.7 s 不监听**、降级恢复时**并发执行 10 次 schema 协调**（20 次事务冲突被吞）、恢复路径**漏掉 4 个模块初始化**且完全静默。

## 缺陷表

| 级别 | 编号 | 置信度 | 位置 | 一句话 |
|---|---|---|---|---|
| P0 | P0-1 | 确认（实测） | `server/src/service/groupedCacheJob.ts:11-31`、`server/src/routes/domains.ts:349-369`、`server/src/db/bal/business-adapter.ts:4426-4469` | 缓存版本以 SQLite REAL 文本（`"1792834075230.0"`）落库，读路径用 `parseInt` 得到的 number 做 `===`，**永不相等** → 分组视图 100% 未命中；每次未命中都会 `bumpCacheVersion()` 并把 5004 条域名（1.3 MB）重写进缓存行 |
| P0 | P0-2 | 确认（实测） | `server/src/service/websocket.ts:104-122`、`:143-145`、`:236-245` | 同一 userId 第二次连接时先 `close()` 旧连接、后注册新连接；旧连接的 `close` 事件异步落地后执行 `clients.delete(userId)`，**删掉的是新连接** → 新连接被孤儿化（收不到 pong/广播），`clientCount` 归零使资源采集整体停摆 |
| P1 | P1-1 | 确认（实测） | `server/src/app.ts:1-4`、`server/src/service/jwt.ts:9-24`、`server/src/routes/init.ts:279-281` | `loadEnv()` 写在 import 之后，ESM 求值顺序决定 `jwt.ts` 的模块级 IIFE 先跑：`data/.env` 里的 `JWT_SECRET` **从未生效**，每次启动随机生成 → 重启后所有已签发 JWT 全部失效；初始化向导写进 `data/.env` 的密钥同样被忽略 |
| P1 | P1-2 | 确认（实测） | `server/src/db/dal/connection.ts:155-197`、`server/src/app.ts:534-616` | 启动时数据库不可达：`connect()` 内部 10 次指数退避（累计约 150 s）**跑完才**抛错，`server.listen()` 在其后 → 进程启动后 **152.7 s 内端口不监听**（连接被拒，而不是降级 503） |
| P1 | P1-3 | 确认（实测） | `server/src/app.ts:673-704`、`server/src/db/dsm/init-dsm.ts` | 降级分支的重连 `setInterval(5000)` 与 `connect()`（本身可能阻塞 150 s）**不互斥**，库恢复瞬间 10 个分支同时推进：同一秒内 **9~10 次 `initializeDSM()` 并发**，产生 **20 条** `cannot start a transaction within a transaction`（SQLite 单连接）→ schema 协调部分静默失败 |
| P1 | P1-4 | 确认（实测） | `server/src/app.ts:558-585` vs `:682-690` | 两条启动路径不一致：恢复路径**没有**调用 `initRenewalSchedulers()`、`initWhoisSchedulers()`、`startGroupedCacheRefreshJob()`、`startPublicSuffixJob()`，且无任何告警 → 自动续期调度未注册、WHOIS 提供商源未注册、PSL 未载入、缓存刷新缺失 |
| P1 | P1-5 | 确认（实测） | `server/src/service/taskManager.ts:31-33`、`:168-187` | `TaskOptions.concurrency` 全库**没有任何读取点**（grep 可证），所有调用方声明的 1/3/5 并发全部塌缩为全局 3；声明与实际完全脱节 |
| P1 | P1-6 | 确认（实测） | `server/src/service/taskManager.ts:265-324` | `Promise.race` 超时只 `reject` 外层 Promise，**不取消** `fn()`；配合 `retries` 会再次入队 → 同一任务**重叠执行**（实测 maxOverlap=2）。`recordCountCache`（10 min 超时 + retries 1）会二次全量扫提供商 API |
| P1 | P1-7 | 确认（实测） | `server/src/service/taskManager.ts:60`、`:193-227`、`server/src/service/serviceMonitorJob.ts:12-60` | 任务队列**无深度上限**（实测一次排队 500 个，按 3 并发需 161 s 排空）；`serviceMonitorJob` 的 `setInterval` 不等待上一轮 → 每 5 分钟继续追加 N 个任务；同 ID 冲突延迟 60 次后被 `reject` 丢弃，监控检查静默停摆 |
| P2 | P2-1 | 确认（实测） | `server/src/lib/logger.ts` + `server/src/db/dl/sqlite.ts` 慢查询日志 | 每条慢查询打一条 WARN，无任何限流：单次会话压测累计 **135,126 行 / 32 MB**；违反 root.ai.md §日志相关 9「同调用点必须限流」 |
| P2 | P2-2 | 确认（实测） | `server/src/service/auditExport.ts:101-144` | 审计导出硬编码上限 10000 行，**静默截断**：CSV 无任何提示，JSON 的 `total=12003` 与 `logs.length=10000` 自相矛盾 |
| P2 | P2-3 | 确认（实测） | `server/src/service/taskManager.ts:356-363` | `getStats()` 从 `runningTasks` 里统计 `completed/failed`，而该 Map 在 `finally` 中已被删除 → 统计**恒为 0** |
| P2 | P2-4 | 未复现（代码推断） | `server/src/routes/domains.ts`（`POST /` 的 check-then-insert）+ DSM `domains` 表无 `(account_id,name)` 唯一索引 | 创建域名是「先查后插」非事务操作，且无唯一约束兜底；SQLite 单连接下 20 并发未复现，MySQL/PG 连接池下存在重名双行风险 |
| P2 | P2-5 | 确认（实测） | `server/src/app.ts:619-627` | 初始化探测 `setInterval(5000)` 在系统已初始化后**从不清除**，进程生命周期内每 5 s 一次 DB 探测（`probeDbInitialization`） |
| P2 | P2-6 | 确认（实测） | `server/src/service/websocket.ts:37-42`、`:295-311` | WS 无连接总数上限、无建连速率限制、无 `bufferedAmount` 背压检查；实测 300 条未鉴权连接不泄漏 fd（服务端主动 4001 关闭），但每条连接都要走完整握手 + 两行日志 |

## 压测数据

环境：Node 22.23.3，单进程，SQLite（WAL），5004 条域名 / 9 个超管账号，压测机与服务同机（共享 CPU，绝对值偏保守）。
脚本：`ai-censorship/evidence/resilience-20261024/bench5.mjs`。

| 场景 | 并发 | 请求数 | QPS | p50 | p95 | max | 错误率 | RSS 变化 |
|---|---|---|---|---|---|---|---|---|
| `GET /api/domains?page=1&pageSize=10`（非分组） | 3 | 1042 | **69.5** | 42 ms | 72 ms | 146 ms | 0% | +0.1 MB |
| `GET /api/domains?grouped=true&pageSize=10`（超管） | 1 | 91 | **6.1** | 148 ms | 277 ms | 342 ms | 0% | −2.1 MB |
| 同上 | 3 | 177 | **5.9** | 524 ms | 724 ms | 913 ms | 0% | +1.1 MB |
| 同上，9 用户混合 | 10 | 90 | 6.2 | 2521 ms | **7814 ms** | **13931 ms** | 0% | — |
| 同上，9 用户混合 | 20 | 270 | 6.5 | 2394 ms | 4879 ms | 14904 ms | 0% | — |

- 分组接口吞吐与并发**不成比例**（1→3 并发 QPS 6.1→5.9），瓶颈是单条写锁 + 每次请求 1.3 MB 的缓存重写，而非 CPU 并行度。
- 每次分组请求都会 `UPDATE system_cache`（全局版本）+ `INSERT OR REPLACE grouped_domains_cache`（1,306,630 字节）。实测 10 次请求 = 10 次版本自增，命中率 **0/10**。
- WS 洪泛：300 条并发连接 → 3.2 s 内全部建立并被服务端以 4001 关闭，fd 稳定在 35，RSS 74→87 MB 后回落；无 fd/内存泄漏，但**没有建连速率限制**。
- 日志：单次会话压测累计 135,126 条 `Slow Query` 行（32 MB），最慢单条 **10,150 ms**（写锁注入实验期间）。

## 逐条复现

### 通用脚手架

```bash
# 1) 隔离实例（不碰生产库）
mkdir -p /tmp/res-audit/data && cp /workspace/HiDNS/server/data/hidns.db /tmp/res-audit/data/app.db
cat > /tmp/res-audit/data/.env <<'EOF'
DB_TYPE=sqlite
DB_PATH=/tmp/res-audit/data/app.db
JWT_SECRET=resilience-audit-secret-0123456789abcdef
NODE_ENV=development
PORT=4391
HIDNS_LOG_LEVEL=info
EOF
echo "$(date -Iseconds)" > /tmp/res-audit/data/.initialized

# 2) 起服务（后台）
cd /tmp/res-audit && /workspace/HiDNS/server/node_modules/.bin/tsx /workspace/HiDNS/server/src/app.ts > server.log 2>&1 &

# 3) 造数据（5000 域名 + 8 个超管账号，密码 AuditPass123!）
H=$(cd /workspace/HiDNS/server && node -e "console.log(require('bcryptjs').hashSync('AuditPass123!',10))")
node /tmp/res-audit/seed.mjs 5000 "$H"
```

### P0-1 分组缓存 100% 不命中，且每次未命中都全局失效缓存

用服务自身的驱动读缓存行（避开我脚本的口径差异）：

```bash
cd /workspace/HiDNS/server
timeout 60 ./node_modules/.bin/tsx /tmp/res-audit/cache-type-probe.ts
```

实际输出：

```
CACHE_ROW version="1792834075230.0" typeof=string bytes=1306630
GLOBAL  version="1792834468674" typeof=string parseInt=1792834468674
STRICT_EQUAL=false
```

机理：`GroupedDomainsCacheOperations.set()` 把 JS number 绑进 TEXT 列，SQLite 以 REAL 文本落库（多了 `.0`）；`get()` 声明返回 `number` 但驱动实际返回 string。读路径 `domains.ts:353` 是 `cached.ver === cacheVer`（string === number），恒 false。

后果链（两个用户交替请求，脚本 `cache-thrash.mjs`）：

```
A grouped GET -> 200 0 24ms | globalVer=1792833347289 | myRowVer=1792833347289.0 | hit=false
A grouped GET -> 200 0 14ms | globalVer=1792833347308 | myRowVer=1792833347308.0 | hit=false
B grouped GET -> 200 0 13ms | globalVer=1792833347322 | myRowVer=1792833347322.0 | hit=false
...
{"requests":10,"globalVersionBumps":10,"cacheHits":0,"hitRate":0}
```

1. 未命中分支走的是**无过滤全表** `DomainOperations.getAll*`，5004 条全量取回；
2. 取回后 `bumpCacheVersion()` 把**全局版本**推进 → 其他所有用户的缓存行同时失效；
3. 再把 1.3 MB 的 JSON 写回自己的缓存行（`INSERT OR REPLACE`，单条写锁）；
4. `groupedCacheJob.refreshGroupedCaches()`（30 min 一次）只 `bumpCacheVersion()` 不刷新数据，等于**每 30 分钟主动清空一次全站分组缓存**：

```
2026-10-24T09:14:36.165Z  INFO [Cache] [Grouped] Starting periodic grouped cache refresh
2026-10-24T09:14:36.169Z  INFO [Cache] [Grouped] Cache version bumped { ver: 1792833276165 }
```

修复建议：版本一律按 string 比较（`String(row.version) === String(ver)`），或落库前 `Math.floor()` 并把列类型改 INTEGER；`bumpCacheVersion()` 只允许写操作调用，读路径未命中**不得**推进全局版本（改 per-user/per-type 短 TTL 或 single-flight）；30 min 的「刷新」要么真刷新，要么删掉。

### P0-2 WebSocket：同用户第二次连接后，新连接被旧连接的 close 事件删除

```bash
cd /tmp/res-audit && node ws-orphan.mjs 2>&1 | tail -20
```

实际输出（节选）：

```
0.0s A-baseline open
0.5s A-baseline msg: {"type":"resource:snapshot", ...}
1.2s A-baseline msg: {"type":"pong"}
2.2s B-second open
2.2s B-second msg: {"type":"connected", ...}
2.2s A-baseline close 4000 New connection established
6.9s B welcome(connected) msgs: 1  B pong msgs: 0
6.9s C-third open
8.1s C-third msg: {"type":"pong"}
10.4s C-third msg: {"type":"resource:snapshot", ...}
21.6s B resource snapshots: 0
21.6s C resource snapshots: 2
```

- B（新连接）握手成功、收到 welcome，但此后 **0 个 pong、0 个广播**；
- C 正常，是因为此刻 `clients` 里已没有 userId 条目（B 被删了）。

根因：`handleConnection` 先 `existingClient.ws.close(4000)`（106-109 行），再 `clients.set(userId, client)`（122 行）；旧连接 `close` 事件在下一个事件循环落地，`handleDisconnect(userId)`（236-245 行）按 userId 删除，删掉的是**新**条目。`error` 分支同样调用 `handleDisconnect`，会二次触发。

影响：多标签页、网络抖动重连后**永久失去推送**且前端无法感知（socket 仍 OPEN，前端没有应用层探活）；更严重的是 `wsService.clientCount` 归零会**整体关闭资源采集**（`resource/job.ts:22`），所有在线用户的面板一起冻结。

修复建议：连接实体以自增 connId 为键、`Map<number, Set<Client>>` 允许同用户多连接；`close` 回调先校验 `clients.get(userId) === thisClient` 再删；`handleDisconnect` 必须传连接实例而不是 userId。

### P1-1 `data/.env` 的 JWT_SECRET 从未生效，每次重启换密钥

```bash
grep -nE 'JWT_SECRET not set|Loading data/.env' /tmp/res-audit/server.log | head -3
```

实际输出：

```
7:2026-10-24T09:14:03.695Z  WARN [JWT] [<anonymous>] [L21] JWT_SECRET not set, using randomly generated secret.
17:2026-10-24T09:14:05.812Z  INFO [Config] [Env] Loading data/.env
```

`app.ts:1-4` 写着「Load environment variables FIRST」，但 `import` 是**提升**的：`service/jwt.ts` 的模块级 `BASE_JWT_SECRET` IIFE 先于 `loadEnv()` 执行。三份独立实例日志都复现（`grep -c 'JWT_SECRET not set'` = 1/1/1）。

后果：
1. `data/.env`（`loadEnv()` 的**最高优先级**来源、初始化向导 `routes/init.ts:281` 的写入位置）里的密钥被忽略 → 每次重启密钥都变 → 所有已登录用户被静默登出（无 session 兜底，`middleware/auth.ts:30-38` 只验签）；
2. 生产环境的密钥强度校验（`jwt.ts:13-16`）执行时看到的是 `undefined`，随机密钥直接绕过。

修复建议：把 `loadEnv()` 拆到独立入口模块（`bootstrap.ts`）并作为**第一个** import，或改用 `node --env-file`；`jwt.ts` 初始化时断言 `process.env.JWT_SECRET` 存在（缺失 fail-fast，而不是随机生成）。

### P1-2 启动期数据库不可达 → 152.7 s 内 HTTP 端口不监听

```bash
# 让 DB_PATH 指向一个「同名目录」，SQLite 必然打不开
mkdir -p /tmp/res-recover/dbpath/app.db
cd /tmp/res-recover && /workspace/HiDNS/server/node_modules/.bin/tsx /workspace/HiDNS/server/src/app.ts > server.log 2>&1 &
curl -s -m 2 -o /dev/null -w 'listen=%{http_code}
' http://127.0.0.1:4394/api/init/status   # → listen=000
```

实际输出（同一进程的日志首尾）：

```
6:2026-10-24T09:22:40.976Z  WARN [JWT] [<anonymous>] [L21] JWT_SECRET not set, using randomly generated secret.
...
422:2026-10-24T09:25:13.693Z ERROR [Server] [App] [initializeApp] [L654] Database connection failed at startup. Serving in degraded mode; ...
458:2026-10-24T09:25:13.701Z  INFO [Server] [App] HiDNS running on http://localhost:4394
```

尝试序列（日志原文）：`retrying 1000ms → 2000 → 4000 → 8000 → 16000 → 30000 → 30000 → 30000`，共 10 次；这段时间 `app.ts` 卡在 `await connect()`，`server.listen()` 还没执行。

影响：容器/进程存活探针只能看到「连接被拒」；编排层通常会在 152 s 之前判定启动失败并重启 → 重启又进入同样的 152 s 等待，形成**重启风暴**。

修复建议：`server.listen()` 必须先于数据库连接（端口先活、路由降级 503），connect/DSM 放到 listen 之后的后台初始化；`connect()` 的重试交给外层（`app.ts` 已有 5 s 巡检），内部不要叠加 10 次长退避。

### P1-3 降级恢复时并发执行 schema 协调，事务互相踩踏

把上面实例的 DB 恢复（`rmdir app.db && cp hidns.db app.db`）后：

```bash
grep -c 'Starting full database schema reconciliation' /tmp/res-recover/server.log            # 10
grep -c 'cannot start a transaction within a transaction' /tmp/res-recover/server.log        # 20
grep -c 'Execute error' /tmp/res-recover/server.log                                          # 17
grep -c '09:25:58.*Starting full database schema reconciliation' /tmp/res-recover/server.log # 9（同一秒）
```

实际输出节选：

```
2026-10-24T09:25:58.761Z  WARN [DSM] [Init] ⚠️ Legacy system detected: schema_versions exists but no HiDNS-DSM records found.
2026-10-24T09:25:58.762Z  INFO [DSM] [Init] Starting full database schema reconciliation...
2026-10-24T09:25:58.770Z  WARN [DSM] [Init] ⚠️ Legacy system detected: ...
2026-10-24T09:25:58.771Z  INFO [DSM] [Init] Starting full database schema reconciliation...
...（同秒内共 9 次）
2026-10-24T09:25:58.951Z ERROR [DL] [Sqlite] [<anonymous>] [L131] Execute error {
  sql: 'BEGIN TRANSACTION',
  message: 'cannot start a transaction within a transaction',
```

机理：`app.ts:673-704` 的 `setInterval(5000)` 每 5 s 无条件 `await connect(); await initializeDSM();`，而单次 `connect()` 失败会阻塞约 150 s → 恢复瞬间有 10 个「重连 + DSM」分支同时在跑。SQLite 单连接下 `BEGIN TRANSACTION` 冲突，20 处协调步骤失败但只写日志，`initializeDSM()` 仍返回 → **schema 是否协调完取决于竞态**。

修复建议：给重连/初始化加单飞锁（`let inflight: Promise<void> | null` 或 `isReconnecting` 标志），一次只允许一个分支；DSM 出错必须向上传播；DSM 自身加进程内互斥 + 跨进程 advisory lock（MySQL `GET_LOCK`）。

### P1-4 恢复路径漏掉 4 个模块初始化（静默）

```bash
for pat in 'Registered renewal schedulers' 'Registered WHOIS adapters' 'Starting grouped cache refresh job' 'Public suffix job started'; do
  echo "[$pat] 正常=$(grep -c "$pat" /tmp/res-audit/server.log) 恢复=$(grep -c "$pat" /tmp/res-recover/server.log)"; done
```

实际输出：

```
[Registered renewal schedulers] 正常=1 恢复=0
[Registered WHOIS adapters] 正常=1 恢复=0
[Starting grouped cache refresh job] 正常=1 恢复=0
[Public suffix job started] 正常=1 恢复=0
```

对比 `app.ts:558-585`（正常路径 13 个启动动作）与 `:682-690`（恢复路径 9 个）。缺失项的实际后果：
- `initRenewalSchedulers()`：`renewalRegistry` 为空 → **自动续期永不执行**（域名到期风险，日志无任何提示）；
- `initWhoisSchedulers()`：DNS 提供商 WHOIS 源（`dns-provider.registry.ts`）未注册 → WHOIS 查询丢失 provider 路径；
- `startPublicSuffixJob()`：PSL 不载入 → 顶域/子域判定降级（分组口径受影响）；
- `startGroupedCacheRefreshJob()`：缓存刷新任务缺失。

修复建议：把两处启动列表抽成单一 `startAllJobs()` 复用（正常路径已有该函数，恢复路径却手抄了一份）；每个 `start*` 幂等 + 启动后打印清单自检。

### P1-5 `TaskOptions.concurrency` 是死参数

```bash
grep -rn 'concurrency' server/src --include=*.ts | grep -v test
# → 只有 taskManager.ts:32 的声明与各调用方的赋值，taskManager 内无任何读取
cd /workspace/HiDNS/server && HIDNS_LOG_LEVEL=error ./node_modules/.bin/tsx /tmp/res-audit/task-probe.ts
```

实际输出：

```
{"test":"concurrency-option","declaredPerTask":1,"observedMaxSimultaneous":3,"elapsedMs":659}
```

`processQueue` 只比较全局 `maxConcurrentTasks = 3`。声明 `concurrency: 5` 的 `serviceMonitorJob`（每次检查 = 一次 DNS/HTTP 探测）与声明 `concurrency: 1` 的 `recordCountCache`（全量扫提供商 API）实际同等对待。

修复建议：实现 per-task-key 并发池（`Map<taskId, number>`），或删掉该字段并统一文档口径。

### P1-6 超时不取消底层任务 + 自动重试 → 同一任务重叠执行

实际输出（同一条命令）：

```
{"test":"timeout","rejected":true,"message":"Task timeout after 300ms","elapsedMs":720}
{"test":"timeout-non-cancel","executions":2,"completedBodyRuns":2,"maxOverlap":2,"startsAt":[1,405],
 "note":"timeout 只拒绝 Promise，底层函数仍在跑；retries 再启动一遍 => 同一任务重叠执行"}
```

`Promise.race` 只是「不再等待」，`fn()` 的循环还在跑；`retries` 让第二次执行在 405 ms 就启动。生产上 `recordCountCache`（`timeout: 600000`、`retries: 1`）在大账号量下必然超时 → 一轮刷新进行到一半时第二轮开跑，提供商 API 请求量翻倍，可能触发上游限流/封禁。

修复建议：`fn` 必须接受 `AbortSignal`（或 `withTimeout` 包装真正的取消语义），超时后标记 aborted 并禁止 retry 与仍在运行的执行重叠。

### P1-7 任务队列无上限 + 监控任务每 5 分钟无守卫追加 + 同 ID 60 次后丢弃

```bash
cd /workspace/HiDNS/server && HIDNS_LOG_LEVEL=error timeout 120 ./node_modules/.bin/tsx /tmp/res-audit/task-storm.ts
```

实际输出：

```
{"submitted":500,"running":3,"queued":497,"rssBeforeMB":87.7,"rssAfterMB":88.1}
{"after5s":{"done":15,"queued":482,"running":3},"projectedDrainSeconds":161}
{"criticalWaitMs":608}
```

代码侧：`serviceMonitorJob.ts:12` 的 `setInterval(async () => { … await Promise.all(tasks) })` 不阻止下一轮；`nsMonitorJob.ts:424`、`domainSyncJob.ts:388`、`recordCountCache.ts:115` 同构。同 ID 冲突走 `deferTask()`，`MAX_REQUEUE_DEFERRALS = 60` 后 `reject`，调用方 `.catch` 只写一行 warn（`groupedCacheJob.ts:65`）→ 该轮监控检查**静默丢失**。

修复建议：队列加硬上限（超过即拒绝并告警）；周期任务加「上一轮未结束则跳过本轮」+ 指标；deferral 到上限用 error 级别并计入健康度。

### P2-1 慢查询日志无节流（135,126 行 / 32 MB）

```bash
grep -c 'Slow Query' /tmp/res-audit/server.log                      # 135126
du -h /tmp/res-audit/server.log                                     # 32M
grep -o 'took [0-9]*ms' /tmp/res-audit/server.log | awk '{print $2}' | tr -d ms | sort -n | tail -3   # 685 5062 10150
```

同一调用点在压测期间每次查询都打一条（含完整 SQL 与参数），违反 root.ai.md §日志相关 9。一次 30 s 中等压力即产生 1,600+ 行；写锁注入时单条慢查询 10,150 ms，日志与真实故障互相淹没。

修复建议：按「SQL 指纹」做令牌桶限流（每指纹每分钟 N 条 + 累计次数），或慢查询只打 debug、聚合后每分钟汇总一条。

### P2-2 审计导出静默截断 10000 行

```bash
node /tmp/res-audit/seed-audit.cjs        # 造到 12003 行
curl -s -b <cookie> -o audit.csv  'http://127.0.0.1:4391/api/audit/export/csv'
curl -s -b <cookie> -o audit.json 'http://127.0.0.1:4391/api/audit/export/json'
wc -l < audit.csv                          # 10000（含表头）
node -e "const j=require('/tmp/res-audit/audit.json'); console.log(j.total, j.logs.length)"
```

实际输出：

```
DB 实际条数: 12003
CSV 行数(含表头): 10000
json total=12003 rows=10000
```

合规导出场景下这是「看起来成功、实际缺 2003 条」的数据完整性问题。

修复建议：流式导出（`res.write` 分批），或在响应头/首行声明 `truncated=true, exported=10000, total=12003`。

### P2-3 `taskManager.getStats()` 恒为 0

```bash
cd /workspace/HiDNS/server && HIDNS_LOG_LEVEL=error ./node_modules/.bin/tsx /tmp/res-audit/stats-probe.ts
```

实际输出：

```
AFTER_SUCCESS {"running":0,"queued":0,"completed":0,"failed":0}
AFTER_FAILURE {"running":0,"queued":0,"completed":0,"failed":0}
```

`completed/failed` 从 `runningTasks` 统计，而它在 `finally` 里已被 `delete`。运维据此判断任务健康度会永远「一切正常」。

### P2-4 域名创建是 check-then-insert，且无唯一索引（未复现）

```bash
node /tmp/res-audit/race-dup.mjs   # 20 并发同名创建
```

实际输出：

```
{"requests":20,"responseCodes":{"200:0":1,"400:400":19},"rowsInDb":1}
```

SQLite 单连接 + 同步驱动串行化，20 并发未复现重名。但代码是 `getByAccountIdAndName()` → `create()`，两步之间无事务；`domains` 表只有 `idx_domains_name` 普通索引（`select sql from sqlite_master where type='index'` 可查），没有 `(account_id, name)` 唯一约束。MySQL/PG 连接池下并发窗口真实存在；一旦双行入库，删除/NS 监控清理（`domains.ts:1358-1370` 按名比较）进入不一致状态。

修复建议：DSM 增加 `uq_domains_account_name` 唯一索引，并保留 catch unique 的兜底分支（现在已有，说明作者预期过）。

### P2-5 初始化探测定时器永不清除

`app.ts:619-627` 的 `initCheckInterval` 在命中 `state==='initialized'` 之后**没有** `clearInterval`，进程生命周期内每 5 s 执行一次 `refreshSystemState()` → `probeDbInitialization()`（至少 2 次查询），与 `connection.ts` 的 30 s 健康检查重复。

修复建议：命中 initialized 后立即 `clearInterval`。

### P2-6 WS 无连接上限 / 无建连速率限制 / 无背压检查

```bash
cd /tmp/res-audit && node ws-flood.mjs 300 99708
```

实际输出：

```
before: rss=74.2MB fds=35 log=30.10MB
{"connections":300,"opened":300,"closed":300,"errored":0,"elapsedMs":3281,"rssAfter":"87.3MB","fdsAfter":35,"logAfter":"30.17MB"}
{"stillOpen":0,"rss":"87.3MB","fds":35,"log":"30.17MB"}
```

300 条未鉴权连接全部被 4001 关闭、无 fd 泄漏（这块做得对）。但除 `maxPayload` 外防护全缺：无连接总数上限、无 IP 级建连速率限制（每条连接写 2 行日志）、`send()` 前不检查 `bufferedAmount`（慢消费者时 ws 内部缓冲无界增长），广播只看 `readyState===OPEN`。

修复建议：握手前做 IP 限速（`verifyClient` 或 `express-rate-limit`），`clients.size` 设上限并拒绝新连接（close 1013），广播前检查 `bufferedAmount > 1MB` 则跳过并断开。

## 「可瘫痪点」清单（按投入产出排序）

| # | 手段 | 成本 | 效果 | 依据 |
|---|---|---|---|---|
| 1 | 若干用户反复刷新「分组视图」 | 1 个普通账号 | 全局缓存版本被连续推高 → 所有人缓存失效；每条请求写 1.3 MB → 单实例 6 QPS 饱和，10 并发 p95 7.8 s | P0-1 + 压测表 |
| 2 | 同一账号开第二个标签页 / 断网重连 | 一次建连 | 该用户实时推送永久失效（前端无感知），`clientCount` 归零 → 资源采集/广播对全部在线用户停摆 | P0-2 |
| 3 | 重启进程（或一次部署） | 一次重启 | `data/.env` 的 JWT_SECRET 不生效 → 全员会话失效，前端集体登出 | P1-1 |
| 4 | 启动瞬间数据库不可达 | 一次网络抖动 | 端口 152 s 不监听 → 编排层判定失败 → 重启 → 再次 152 s（重启风暴） | P1-2 |
| 5 | 启动后数据库恢复 | 一次恢复 | 10 个分支并发跑 DSM，事务冲突被吞 → schema 状态不确定；且 4 个模块静默未启动（续期/WHOIS 源/PSL/缓存刷新） | P1-3 + P1-4 |
| 6 | 建大量监控（服务监控/NS 监控） | 拥有账号即可 | 每 5 分钟追加 N 个任务，队列无上限 → 其他任务（缓存更新、WHOIS）长期饥饿；同 ID 冲突 60 次后被丢弃，监控静默失效 | P1-7 |
| 7 | 让任一长任务跑过超时 | 大账号量自然发生 | 超时不取消 + retry → 同任务重叠，上游 API 请求翻倍（有被封禁风险） | P1-6 |

## 已确认「不再是问题」的项（避免重复上报）

- **同 ID 任务同步自旋**：`deferTask()` 已改为 `setTimeout` + 指数退避（实测同 ID 二次提交正常延后重排，无自旋、无日志洪水）。注意其重排计时器带 `unref()`，进程没有其它活跃句柄时会静默丢失（`task-probe3.ts` 可复现：进程直接退出、Promise 不 settle）。
- **`disconnect()` 不销毁单例**：`connection.ts:280-330` 已按规范保留单例并重置重试计数。
- **DB 不可达 ≠ 未初始化**：实测「库可达但未初始化」实例上 `GET /api/domains` 返回 `503 {"code":503,"msg":"System not initialized. Please complete setup first.","data":{"needsInit":true,"dbReachable":true}}`（JSON，非 500 HTML），`/api/init/status` 返回 200 只读探测；不可达分支由 `isInitSurfaceOpen()` 要求 `lastProbe==='uninitialized'`，保持 fail-closed。
- **未鉴权 WS 洪泛**：300 并发无 fd/内存泄漏（见 P2-6）。

## 修复优先级建议

1. **P0-1**：改版本比较的类型（1 行），并删掉「读路径 bump 全局版本」；顺带把 30 min 只 bump 的刷新任务改成真刷新或移除。收益最大、改动最小。
2. **P0-2**：WS 连接表改 `Map<userId, Set<Client>>`，`close` 回调做实例校验。
3. **P1-1**：`loadEnv()` 移到独立 bootstrap 模块首位 + 缺失 `JWT_SECRET` fail-fast。
4. **P1-2**：先 `listen()` 再连库。
5. **P1-3/P1-4**：重连与 DSM 单飞；两处启动列表合并为同一函数。
6. **P1-5/6/7**：并发参数落地、超时真取消、队列上限 + 周期任务跳过重叠轮次。


## 修复状态（执行层回填，提交 `c31c090`）

| 编号 | 状态 | 说明 |
| --- | --- | --- |
| P0-1 分组缓存 100% 未命中 | ✅ 部分修 | 读路径 `Number()` 归一化（REAL 文本 vs number 的不相等已消除）。**未修**：未命中时仍会 bump 全局版本并重写 1.3MB 缓存行——建议改为「未命中只写自身缓存，不 bump」 |
| P0-2 WS 重连孤儿化 | ✅ 已修 | `handleDisconnect(userId, ws)` 做 socket 身份校验，旧连接的 close 不再删新连接 |
| P1-1 `loadEnv()` 顺序 | ⏳ 未修 | 需把 env 加载提前到 import 之前（`index.ts` 里 dynamic import app） |
| P1-2 启动阻塞 152s | ⏳ 未修 | `connect()` 的指数退避应先 listen 再后台重试 |
| P1-3 恢复期 DSM 并发 | ⏳ 未修 | 重连 interval 与 `connect()` 需互斥（单飞 + 锁） |
| P1-4 恢复路径漏初始化 | ✅ 已修 | 补齐 renewal/whois 调度器、grouped cache、public suffix 四个启动项 |
| P1-5/6/7 任务系统（并发声明、超时不取消、队列无上限） | ⏳ 未修 | 需改 taskManager 的超时与取消语义 |
| P2 组（慢查询无限流、导出静默截断等） | ⏳ 未修 | 见报告正文 |

---

## 第二轮（回归复测 + 极限输入 / 资源 / 一致性 / 契约）

- 对象：修复提交 b454522 / c31c090 / b57ed8c / 176cb5b 之后的 HEAD。工作区里 `server/src/service/serviceMonitor.ts` 有一份**他人**未提交改动（+25/−8），我全程只读未写；除本报告与 `ai-censorship/evidence/` 外我没有修改任何文件。
- 环境：Node 22.23.3，隔离实例 `/tmp/reg2`（库为 `server/data/hidns.db` 副本，5011 条域名、7 个账号），端口 4991；A2 场景另起 `/tmp/a2`（空库 + 初始化标记），端口 4992
- 说明：本轮压测期间我的实例被外部按 `app.ts` 命令行匹配的 pkill 杀过两次（无 OOM，`/sys/fs/cgroup/memory.events` 的 `oom_kill=0`），改用包装入口 `/tmp/reg2/start.mjs` 后稳定；两次被杀前采集的数据已作废，报告只引用干净实例的测量。

### 修复回归结论

**PASS 7 / PARTIAL 3 / FAIL 0（就「修复是否生效」而言）；上一轮 2 个 P0（分组缓存 100% 未命中、WS 重连孤儿化）已确认清零。**

| # | 修复项 | 结论 | 证据（命令 → 输出） |
|---|---|---|---|
| 1 | MCP OAuth 兑换（UPDATE by code + await） | PASS | `POST /api/mcp/oauth/token`（伪造 code）→ `400 {"error":"invalid_grant"}`，进程存活；`business-adapter.ts` 已改 `WHERE code = ?` |
| 2 | 2FA 用户启用即校验 + `user_2fa` 唯一索引 | PASS（代码+索引；未做 TOTP 端到端） | `sqlite_master` → `uniq_user_2fa_user_type ON "user_2fa" ("user_id","type")`；`auth.ts` 已区分「全局强制」与「用户已开启即校验」 |
| 3 | 令牌 `allowed_domains` 归属 | PASS | member 用他人域名 → `403 No permission for domains: 2`；自己的域名 → `200` 并返回令牌 |
| 4 | 续期域名归属 | PASS | member `DELETE/PATCH /domains/renewable-domains/1` → `403/403`，行仍在；列表 → `403 Permission denied` |
| 5 | 服务监控 SSRF | PASS | target=`127.0.0.1` / `169.254.169.254` → `status:error,"目标不允许指向内网/保留地址"` |
| 6 | 分组缓存版本归一化 | PASS（单用户） | 连续 8 次分组请求只写 1 次缓存行（`WROTE_CACHE_TIMES=1`）；单用户 QPS 5.9→14.5，p50 524ms→60ms |
| 6' | WS 重连身份校验 | PASS | 同一用户第二次连接：`B pong: 3`、`resource:snapshot: 1`、`domain_whois_updated ×7`（此前为 0） |
| 7 | 令牌禁止改资料/可信设备 | PASS | 令牌 `PUT /auth/profile` → `403`，`DELETE /security/trusted-devices` → `403`（`GET` 读 200，仅读不拦） |
| 8 | providers icon / MCP 审计 / password-strength 限长 | PARTIAL | icon `../../package.json` → `400 Invalid provider type`；`/mcp/audit-logs` member → `403`；但 256 字符密码仍需 **2.9 s CPU**（见 R2-1） |
| 9 | env 求值期加载（JWT_SECRET） | PASS | 启动日志无 `JWT_SECRET not set`；用 `data/.env` 密钥+运行时密钥签的 JWT → `GET /api/domains 200` |
| 10 | 域名/记录校验、NFC、/whois | PARTIAL | `a..b`/`-bad.com`/64 字符标签 → 400；NFC 与 NFD 收敛为同一行 `xn--caf-dma`；`/api/domains/whois`（无参）→ `400 "Domain parameter is required"`（不再被 `/:id` 遮蔽）。仍有两处放行，见 R2-7 |

### 新增发现（编号续前文）

| 级别 | 编号 | 位置 | 一句话 |
|---|---|---|---|
| P1 | R2-1 | `server/src/routes/security.ts:39`（+ `server/src/routes/security.ts` 挂载处无鉴权） | 无鉴权的 `POST /api/security/password-strength` 调 zxcvbn（同步 CPU）：256 字符密码单次 2.9 s；4 个并发请求期间 `/api/init/status` 从 32 ms 涨到 **3476 ms**（事件循环被整体阻塞），"限长 256" 只把上限从"无界"降到"每次 2 s" |
| P1 | R2-2 | `server/src/service/whois/scheduler.ts:68`（一次性为每个域名入队）+ `server/src/service/taskManager.ts:60`（队列无上限） | 启动后 WHOIS 同步把 5011 个域名**一次性**入队，实测 `queuedCount: 5009`；缓存失效任务（`grouped-cache-update-*`）在 2.5 s 内**一次都没被调度**（`grep -c "Update domain cache" server3.log = 0`）→ 写操作后长时间读到旧分组数据 |
| P2 | R2-3 | `server/src/routes/domains.ts:349-369` + `server/src/service/groupedCacheJob.ts:11-21` | 缓存命中后每次仍要读 1.3 MB 缓存行并 `JSON.parse` + 内存分组：命中态分组接口 **14.5 QPS / p50 60 ms**，同机非分组 **70.2 QPS / p50 70 ms**（4.8 倍差距，上轮为 11.8 倍） |
| P2 | R2-4 | `server/src/service/groupedCacheJob.ts:33-37`、`:41-54` | 失效仍是**全局版本**：任一域名的写操作都会 `bumpCacheVersion()`，所有用户的缓存行同时作废，N 个用户各付一次「全表查询 + 1.3 MB 写」；与 R2-2 叠加时失效本身还会迟到 |
| P2 | R2-5 | `server/src/routes/domains.ts`（POST / 的重复分支） | 重复创建返回 `{"skipped":1,"duplicates":[...],"msg":"域名已存在，已跳过"}`，但实际执行了 `updateThirdIdAndRecordCount`：库里 `third_id` 由 `T-A` 静默变成 `T-B` —— 响应说"跳过"，数据被改写 |
| P2 | R2-6 | `server/src/app.ts`（body-parser 默认 100kb）+ `server/src/middleware/errorHandler.ts` | 超大请求体走到 body-parser 的实体超限错误，返回 **HTTP 500**（应为 413）：1 MB 密码 → `500 {"code":500,"msg":"request entity too large"}`；20000 项批量创建同样 500 |
| P2 | R2-7 | `server/src/utils/domain.ts`（校验/归一化） | 校验残留：`xn--zzzz`（无点、非法 Punycode）→ 200 入库；U+200B 零宽 → `xn--testzw-ef0c`、全角 `ｅｘａｍｐｌｅ．ｃｏｍ` → `xn--mi7chab1aes7c.xn--oi7cuaf`（NFKC 未做）分别入库，界面上与正常域名视觉同形 |
| P2 | R2-8 | `server/src/db/bal/business-adapter.ts:795` | 热路径把调试日志留在 **info**：每次域名分页查询打 7 行 `[BAL] SQL:{...}`（`grep -c 'SQL:' = 882` 行 / 304 KB 日志），与驱动层慢查询日志叠加，违反 §日志相关 9「同调用点必须限流」 |

### 逐条复现（第二轮）

```bash
# 脚手架：把源码以包装入口起在 4991（库 = 生产库副本）
mkdir -p /tmp/reg2/data && cp /workspace/HiDNS/server/data/hidns.db /tmp/reg2/data/app.db
printf 'DB_TYPE=sqlite\nDB_PATH=/tmp/reg2/data/app.db\nJWT_SECRET=regression-secret-0123456789abcdefghij\nNODE_ENV=development\nPORT=4991\nHIDNS_LOG_LEVEL=info\n' > /tmp/reg2/data/.env
echo 'import("/workspace/HiDNS/server/src/app.ts");' > /tmp/reg2/start.mjs
cd /tmp/reg2 && /workspace/HiDNS/server/node_modules/.bin/tsx /tmp/reg2/start.mjs > server.log 2>&1 &
# 令牌：env 密钥 + 运行时密钥（证明第 9 项生效）
node -e "const{DatabaseSync}=require('node:sqlite');const j=require('/workspace/HiDNS/server/node_modules/jsonwebtoken');const db=new DatabaseSync('/tmp/reg2/data/app.db');const rt=db.prepare(\"select value from runtime_secrets where key='jwt_runtime'\").get().value;console.log(j.sign({userId:3,username:'u3',role:3},'regression-secret-0123456789abcdefghij:'+rt,{expiresIn:'7d'}))" > /tmp/reg2/tok3.txt
```

#### R2-1 无鉴权 password-strength 阻塞事件循环

```bash
# 4 个并发的 256 字符密码请求期间，探测 /api/init/status 的延迟
node /tmp/reg2/probe4.cjs
```
```
FAIL | EVENTLOOP-BLOCK | 基线探测最大 32ms；4 个 256 字符密码请求并发期间 /api/init/status 最大 3476ms，中位 4ms；密码端点耗时 8601ms，状态码=200,200,200,200
```

单发 256 字符也已实测 2898 ms（`probe3.cjs` 的 `R3-8-password-256字符`）。根因：`security.ts:39` 的路由**没有 authMiddleware**，`checkPasswordStrength` 内部同步跑 zxcvbn；256 字符长度上限让单次最坏耗时从"无界"降到"≈2 s"，但一个匿名请求就能占满一个事件循环 tick，串行叠加即全站停顿。建议：端点加认证或 IP 限速、长度降到 64、把 zxcvbn 放 worker_threads/子进程并加超时。

#### R2-2 WHOIS 一次性入队 5000 个任务，缓存失效被饿死

```bash
grep -o 'queuedCount: [0-9]*' /tmp/reg2/server3.log | awk -F': ' '{print $2}' | sort -n | tail -1   # 5009
grep -c "Update domain cache" /tmp/reg2/server3.log                                                 # 0
grep -E "Task started: WHOIS Sync" /tmp/reg2/server3.log | tail -3
```
```
5009
0
2026-10-24T10:25:08.575Z  INFO [Job] [TaskManager] Task started: WHOIS Sync: seed-71.example.com { taskId: 'whois-84', runningCount: 3, queuedCount: 4932 }
2026-10-24T10:25:10.357Z  INFO [Job] [TaskManager] Task started: WHOIS Sync: seed-72.example.com { taskId: 'whois-85', runningCount: 3, queuedCount: 4931 }
```

实测：`PUT /api/domains/7` 返回 200 后等 2.5 s，`system_cache.grouped_cache_ver` **没有变化**、6 个用户的缓存行 **一条都没被改写**，8/9 号用户随后读到的仍是旧列表（延迟 55/62 ms，与命中态一致）。按日志速率（3 并发、单任务约 5 s、发现 87 个任务/≈3 min）推算，5011 个任务需 **2 小时以上**才排空——意味着这段时间所有写操作后的缓存失效全部延期。建议：WHOIS 同步改为滑动窗口（每次只入队 N 个、完成后入队下一批），队列加上限与优先级（缓存失效用 `critical` 并允许插队）。

#### R2-3 / R2-4 命中后仍 4.8 倍差距；失效仍是全局

```bash
node /tmp/reg2/bench.cjs       # 1 用户暖缓存 / 6 用户 / 非分组
node /tmp/reg2/hitcheck.cjs    # 连续 8 次请求，看缓存行是否被重写
```
```
PASS | R2-B1-grouped-warm-1user | qps=14.5 p50=60ms p95=90ms ...
PASS | R2-B2-grouped-6users     | qps=14.9 p50=343ms p95=850ms ...
PASS | R2-B3-nongrouped-6users  | qps=70.2 p50=70ms p95=162ms ...
WROTE_CACHE_TIMES=1 WROTE_GLOBAL_TIMES=1 (1 = 全部命中，仅首次写)
```

命中已经真实生效（8 次请求只写一次缓存行），但每次命中仍要读 1.3 MB `cache_data` 并 `JSON.parse` + 全量内存分组，CPU 成为新瓶颈（并发从 1 加到 6，QPS 不动、p50 从 60 ms 涨到 343 ms）。同时失效粒度仍是全局版本（`bumpCacheVersion()`），一次写让全部用户失效。建议：缓存改为"分组结果"而非"全量域名数组"、按账号/分页分片缓存，失效用 per-user 版本或账号级 key。

#### R2-5 重复创建：响应「已跳过」，数据被静默改写

```bash
node /tmp/reg2/probe.cjs | grep consistency-dup-skip
```
```
FAIL | consistency-dup-skip | 重复提交 third_id T-A→T-B：{"id":7,"third_id":"T-A","record_count":0,"remark":"first"} ⇒ {"id":7,"third_id":"T-B","record_count":0,"remark":"first"} 响应={"code":0,"data":{"id":null,"added":0,"skipped":1,...},"msg":"域名已存在，已跳过"}
```

#### R2-6 超大请求体返回 500（应 413）

```bash
node /tmp/reg2/probe3.cjs | grep -E 'password-1MB|huge-array'
```
```
PASS | R3-8-password-1MB | 1MB → HTTP 500 (39ms) {"code":500,"data":null,"msg":"request entity too large"}
FAIL | R3-1-huge-array    | 20000 项批量创建 → 500 (96ms) {"code":500,"data":null,"msg":"request entity too large"}
```

`code===HTTP` 成立（500/500），但语义应为 413；且 `errorHandler` 把 body-parser 的 `entity.too.large` 当内部错误处理，客户端拿不到可判断的状态。

#### R2-7 域名校验残留（Punycode / 零宽 / 全角）

```bash
node /tmp/reg2/probe2.cjs | grep -E 'punycode|idn-nfc'
node /tmp/reg2/q2.cjs
```
```
FAIL | R2-10-punycode-validation | xn--zzzz→200 | 例子。公司。cn→200 | xn--fsqu00a.xn--55qx5d.cn→200
9 "xn--testzw-ef0c.example.com"   ← 原文 test\u200Bzw.example.com
10 "xn--e28h.example.com"         ← 😀.example.com（可接受，但无提示）
11 "xn--mi7chab1aes7c.xn--oi7cuaf" ← 全角 ｅｘａｍｐｌｅ．ｃｏｍ（NFKC 未折叠）
12 "xn--4ca.example.com"          ← a\u0308.example.com
```

NFC 已经生效（`caf\u00e9` 与 `cafe\u0301` 收敛为同一行 `xn--caf-dma`），但缺三道闸：单标签 `xn--zzzz` 仍入库（随后分组会算出 `.zzzz` 这种组名）、零宽字符参与 Punycode 编码、全角未做 NFKC。建议：`isValidDomain` 要求至少两段且每段 LDH/合法 Punycode、先 `normalize('NFKC')` 再 `toASCII`、拒绝 `\u200B-\u200F/\u2028/\u2060` 等格式字符。

#### R2-8 热路径 INFO 级 SQL 日志

```bash
grep -c 'SQL:' /tmp/reg2/server.log         # 882
du -h /tmp/reg2/server.log                  # 304K
```

`business-adapter.ts:795` 一次性分页查询即输出 7 行（含 300 字符 SQL 片段）。按 15 QPS 计算约 105 行/秒；与 `SQLiteDriver.logSlowQuery` 的逐条 WARN 叠加，日志会先于真实故障占满磁盘。

### A2 复测（初始化标记与门禁矛盾）

```bash
mkdir -p /tmp/a2/{data,db}; cp /workspace/HiDNS/server/data/hidns.db /tmp/a2/db/app.db  # 或留空库
printf 'DB_TYPE=sqlite\nDB_PATH=/tmp/a2/db/app.db\nJWT_SECRET=a2-probe-secret-0123456789abcdef\nNODE_ENV=development\nPORT=4992\n' > /tmp/a2/data/.env
echo "$(date -Iseconds)" > /tmp/a2/db/.initialized     # 标记存在，但库无用户
cd /tmp/a2 && /workspace/HiDNS/server/node_modules/.bin/tsx /tmp/a2/start.mjs > server.log 2>&1 &
curl -s http://127.0.0.1:4992/api/init/status
curl -s -X POST http://127.0.0.1:4992/api/init/admin -d '{"username":"a2admin","email":"a2@example.com","password":"A2Passw0rd!x"}' -H 'Content-Type: application/json'
```
```
{"code":0,"data":{"initialized":false,"dbInitialized":true,"hasUsers":false,"dbReachable":true},"msg":"success"}
{"code":0,"data":{"success":true,"markerPersisted":true},"msg":"Admin user created successfully"}
--- /api/domains（初始化后）→ 401（要求登录，符合预期）
日志：ERROR [SystemState] Initialization marker exists but database has no users; reopening setup surface
```

A2 **PASS**：标记与库矛盾时不再死锁，初始化面重新开放且不放开业务面（503 → 401）。

### 上轮遗留未修（不在本轮修复清单，复测仍可复现）

| 上轮编号 | 现象 | 复测方式 |
|---|---|---|
| P1-2 | 启动时库不可达 → 端口 152 s 不监听（先从 `connect()` 内 10 次退避跑完才 `listen()`） | `/tmp/res-recover` 场景，日志首尾时间差 152.7 s（本轮未重跑，代码路径未变：`app.ts` 仍在 `await connect()` 之后才 `listen`） |
| P1-3 | 降级恢复并发跑 10 次 DSM、20 条事务冲突被吞 | 同上，`app.ts:673-704` 仍是裸 `setInterval` |
| P1-5/6/7 | `concurrency` 死参数、超时不取消+retry 重叠、队列无上限 | 本轮 R2-2 已用 5009 队列深度再次佐证队列无上限 |
| P2-1 | 慢查询日志无限流（上轮 135,126 行） | 本轮 `grep -c 'Slow Query' = 4`（负载低），代码未变 |
| P2-2 | 审计导出静默截断 10000 行 | `auditExport.ts:104` 仍是 `getAuditLogs(1, 10000)` |
| P2-3 | `taskManager.getStats()` 恒 0 | 代码未变 |
| P2-5 | 初始化探测 5 s 常驻 | `app.ts:619` 未变 |

### 本轮建议优先级

1. **R2-2**（P1）：WHOIS 同步分批入队 + 队列上限；否则任何写操作后的缓存失效都可能迟到数分钟（用户看到旧数据）。
2. **R2-1**（P1）：`password-strength` 加认证/限速 + zxcvbn 移出主线程。
3. **R2-3/R2-4**（P2）：把缓存从「全量域名数组」改成「分组结果 + 分片」，失效改成 per-user/账号级。
4. **R2-5/R2-6/R2-7/R2-8**（P2）：重复创建只读不写、413 语义、NFKC+格式字符黑名单、SQL 日志降到 debug 并限流。


## 第二轮修复状态（执行层回填，提交 `b53e406`）

| 第二轮编号 | 状态 | 说明 |
| --- | --- | --- |
| R2-1 password-strength CPU 阻塞 | ✅ 已修 | 长度上限 256→**72**（bcrypt 输入上限）+ 按 IP 每秒 10 次节流 |
| R2-2 WHOIS 任务饿死队列 | ✅ 已修 | 每轮上限 **200**（`WHOIS_BATCH_LIMIT` 可调），超出部分下一轮；队列不再被 5000+ 任务占满 |
| R2-3 分组缓存命中仍 JSON.parse 1.3MB（4.8 倍差距） | ⏳ 未修 | 建议加进程内 LRU（key=userId+cacheType+version），或缩小缓存范围到「仅 id/name/account_id」 |
| R2-4 缓存失效仍是全局版本 | ⏳ 未修 | 已去掉「未命中 bump」，但写操作仍 bump 全局；后续可改按用户版本 |
| 重复创建静默改写 third_id / 超大 body 500 / NFKC / SQL 日志洪泛 | ⏳ 未修 | 见报告正文 |
| P1-1 `loadEnv` 顺序 | ✅ 已修（上轮） | 本轮复测 PASS（用 .env 密钥签的 JWT 取数 200） |

---

## 第五轮（HEAD 6732b3c：第四轮修复复测 + 压力/一致性/契约）

- 环境：Node 22.23.3，隔离实例 `/tmp/r5`（库为 `server/data/hidns.db` 副本；追加 5003 条域名；user 3=超管、4=member、5=非超管 admin、9/11=锁测试），端口 5991；JWT 用 `data/.env` 密钥 + 运行时密钥直接签发，绕开登录限流
- 仅读源码，未改任何生产文件；本轮脚本在 `/tmp/r5/`

### 复测结论（6 项）

| # | 项 | 结论 | 证据 |
|---|---|---|---|
| 1 | MCP 授权码兑换 | **FAIL（P0）** | 全新码首次兑换即 `400 invalid_grant`；10 个不同码并发 **0/10** 成功；失败后码已被置 `used=1`（烧掉，无法重试） |
| 2 | MCP domainId 工具跨租户 | **PASS（主路径）** | member key 的 `list_domains` 只返回自己的 `member-only.example.com`；对 domain 2 的 `list_domain_records / get_domain_remark / update_domain_status / update_dns_record` 全部返回 `Domain with ID 2 not found`；非超管 admin 写自己的 901 成功、写他人的 2 被拒；`list_domains_filtered` 不泄露他人域名。**但** 3 个工具的拒绝分支本身崩了（见 R5-2） |
| 3 | CORS | **PASS** | 同源 Origin POST `200`；跨源 Origin `200` 且无 `Access-Control-Allow-Origin`；预检 `200` 无 ACAO |
| 4 | 账号锁 | **PARTIAL** | 剩余次数逐次递减（9→8→7→6→5），但第 6 次起是 express 限流的 `429 text/html "Too many login attempts"`，默认 `maxAttempts=10` 的账号锁**永远到不了**（R5-4） |
| 5 | 分组缓存命中 | **PARTIAL** | 内存解析层已生效（1.3 MB `JSON.parse` 实测 7 ms 被省掉），但 QPS **14.5→14.9（噪声内）**，与非分组仍差 **4.6 倍**（R5-3） |
| 6 | MCP 动态注册 | **PASS** | `POST /api/mcp/oauth/register` → `403 registration_not_supported` |

### 新发现（第五轮）

| 级别 | 编号 | 位置 | 一句话 |
|---|---|---|---|
| P0 | R5-1 | `server/src/db/bal/business-adapter.ts:5049` | 原子领取后立刻用 `if (row.used) return null` 把刚置位的 `used=1` 当成“已被用”，**授权码 100% 兑换失败**且码被烧掉（与第四轮同类问题，改法未闭环） |
| P2 | R5-2 | `server/src/mcp/tools.ts:1330`、`:1464`、`:1550`、`:1610` | 4 处拒绝分支引用未定义变量：`get_dns_lines / delete_dns_record / get_domain_remark` 对不可见域名返回 `Error: name is not defined`，错误契约从“not found”退化为内部错误；`update_dns_record` 则把记录名当域名回显 |
| P2 | R5-3 | `server/src/routes/domains.ts:300-330`、`:347-369`、`server/src/service/groupedCacheJob.ts:11-30` | 分组请求在命中缓存前**先跑一次分页查询**，再对 5003 条全量做内存分组建块；内存层只省 7 ms parse，QPS 仍 14.9（非分组 72.5） |
| P2 | R5-4 | `server/src/middleware/rateLimit.ts:9-21`、`server/src/service/loginLimit.ts:22` | 登录限流命中返回 **text/html 纯文本**，破坏 `{code,data,msg}` 契约；且 5 次/15 分钟限流先于 10 次账号锁生效，锁定路径不可达、前端拿不到剩余次数 |
| P2 | R5-5 | `server/src/routes/tokens.ts`（全文件 0 处审计） | 创建/吊销 API 令牌不写审计：实测 4 次写只产生 3 条审计，`POST /api/tokens` 无记录 |

### 逐条复现（第五轮）

```bash
# 实例：库副本 + 数据准备（用户/账号/域名/MCP 客户端/授权码/MCP key 见 /tmp/r5/prep*.cjs）
mkdir -p /tmp/r5/data && cp /workspace/HiDNS/server/data/hidns.db /tmp/r5/data/app.db
printf 'DB_TYPE=sqlite\nDB_PATH=/tmp/r5/data/app.db\nJWT_SECRET=r5-probe-secret-0123456789abcdefgh\nNODE_ENV=development\nPORT=5991\nHIDNS_LOG_LEVEL=info\n' > /tmp/r5/data/.env
echo 'import("/workspace/HiDNS/server/src/app.ts");' > /tmp/r5/start.mjs
node /tmp/r5/prep.cjs && node /tmp/r5/prep2.cjs && node /tmp/r5/prep3.cjs
cd /tmp/r5 && /workspace/HiDNS/server/node_modules/.bin/tsx /tmp/r5/start.mjs > server.log 2>&1 &
```

#### R5-1 授权码兑换 100% 失败（P0）

```bash
node /tmp/r5/probe.cjs | grep R5-1
node /tmp/r5/q-codes.cjs            # 打印最近 3 个授权码的 used 值
```
```
FAIL | R5-1-exchange | 首次兑换 → 400 {"error":"invalid_grant","error_description":"Invalid, expired, or already used authorization code"}
FAIL | R5-1-concurrent-same-code | 同一码并发 10 次 → 成功 0 次，状态=400,400,400,...
FAIL | R5-1-distinct-codes | 10 个不同码并发兑换 → 成功 0/10，状态=400,400,...
[ { code: 'r5-multi0-...', used: 1 }, { code: 'r5-multi1-...', used: 1 } ]   ← 码已被置 used，无法重试
```

根因（`business-adapter.ts:5027-5049`）：先 `UPDATE ... SET used = true WHERE code = ? AND used = false`（changes=1），再 `SELECT *` 回来，然后 `if (row.used) return null` —— 读到的正是**刚置位**的 used=1。改法：claim 成功即视为领取成功（删掉置位后的 used 判定），或改用 `UPDATE ... RETURNING`；并补一条“首次兑换成功 / 重放 invalid_grant”的用例（第四轮缺的正是这条）。

#### R5-2 工具拒绝分支的 ReferenceError

```bash
node /tmp/r5/probe3.cjs | grep R5-2
cd /workspace/HiDNS && grep -n 'not found' server/src/mcp/tools.ts | head -6
```
```
FAIL | R5-2-write-capable-user-foreign | ... get_dns_lines=ALLOW(200:{"result":...,"text":"Error: name is not define...)
1330:  return { content: [{ type: 'text', text: [模板] 失败: Domain with ID [id] not found }], isError: true };
1464:  ... 同上 ...（create_dns_record）
1550:  ... 同上 ...（delete_dns_record）
1610:  ... 同上 ...（get_domain_remark）
```

模板里用的是未绑定的标识符 `name`（在 `server/src/mcp/tools.ts` 搜索 `not found` 即可定位这 4 行）。这 4 处应改用工具名字面量，例如 `'get_dns_lines'`。

#### R5-3 分组缓存 QPS 未改善

```bash
node /tmp/r5/seed.cjs         # 追加 5000 域名
node /tmp/r5/bench.cjs
node /tmp/r5/parse-cost.cjs
node /tmp/r5/cost.cjs
```
```
{"label":"grouped-warm-1user","qps":14.9,"p50":54,"p95":135,"max":195,"err":0}
{"label":"grouped-warm-6conc","qps":15.7,"p50":335,"p95":860,"max":1135,"err":0}
{"label":"nongrouped-6conc","qps":72.5,"p50":76,"p95":179,"max":295,"err":0}
versionStable=true
{"bytes":1333567,"parseMs":{"p50":7,"max":9}}
{"cacheRowBytes":1333567,"readMs":{"p50":3,"p95":9,"min":1}}
```

对照第二轮（同样 5000 域名，`14.5 QPS / p50 60 ms`）：本轮 14.9 QPS / p50 54 ms，属噪声范围。省掉的 parse 只有 7 ms；瓶颈是 `domains.ts:300-330` 在分组分支之前已执行一次分页查询，分组分支再对 5003 条做 `groupDomains` + 排序 + 组块构造。建议：分组视图直接走缓存分页、跳过前置查询；缓存按“分组块”分片，避免每次全量重组。

#### R5-4 登录限流 429 非 JSON，锁定阈值不可达

```bash
node /tmp/r5/probe4.cjs | grep R5-4
```
```
401 application/json {"code":401,...,"msg":"Invalid username/email or password. 9 attempt(s) remaining."}
401 application/json {"code":401,...,"msg":"... 8 attempt(s) remaining."}
401 application/json {"code":401,...,"msg":"... 7/6/5 attempt(s) remaining."}
429 text/html Too many login attempts, please try again later.
```

两个问题：(a) 429 响应体是纯文本（express-rate-limit 的 message 直出），前端按 JSON 解析会失败，也违反 `code===HTTP` 契约；(b) `loginLimiter` 5 次/15 分钟先于 `maxAttempts=10` 触发，所以“锁 60 分钟 + remainingAttempts 归零”在默认配置下走不到。建议：限流器用自定义 `handler` 返回 `sendError(res, ..., 429)`，并把账号锁阈值调到小于限流阈值。

#### R5-5 令牌创建/吊销没有审计

```bash
grep -c logAuditOperation /workspace/HiDNS/server/src/routes/tokens.ts   # 0
node /tmp/r5/probe4.cjs | grep R5-5
```
```
0
PASS | R5-5-audit-writes | 写 4 次（create/update/delete domain + create token）→ 审计新增 3 条
PASS | R5-5-audit-actor-not-forged | 请求体伪造 user_id=4 后，审计里 user_id=4 的条目数=0
```

审计 `user_id` 取自 JWT、无法用请求体伪造（这块是对的）。缺口是令牌管理：`POST /api/tokens`、`/:id/revoke`、`/:id/restore` 全程无审计，签发/吊销长期凭据不可追溯。

### 顺带复核（本轮新角度）

| 角度 | 结果 | 证据 |
|---|---|---|
| 工作流 http 出网白名单绕过 | **未绕过**（仅端口未限制） | `/tmp/r5/egress.ts` 单测：`https://127.0.0.1/`、`[::1]`、`2130706433`、`0x7f.1`、`[::ffff:127.0.0.1]`、`169.254.169.254` 全部 `INTERNAL_ADDRESS`；`example.com@127.0.0.1` → `CREDENTIALS_IN_URL`；`evil.example.com.attacker.tld` → `NOT_ALLOWLISTED`；`EXAMPLE.COM.` 正常归一命中白名单；重定向是 `redirect:'manual'` 且每跳重新校验。**唯一缺口**：`https://example.com:22/` 放行（白名单不约束端口），可在白名单主机上做端口探测 |
| 邮件模板预览注入 | 端点回显未消毒（暂不可利用） | `GET /api/domains/email-templates/:id/preview?domain=<任意串>` 把 domain 原样拼进 markdown（`emailTemplate.ts:401-435`，无 `isValidDomain`）；客户端没有任何地方消费该端点（无 markdown 渲染器、无 dangerouslySetInnerHTML），故暂无 XSS 面。建议预览前 `isValidDomain(normalizeDomain(domain))` |
| CSV/JSON 导出正确性 | **PASS** | `escapeCSV` 对 `^[=+\-@\t\r]` 前缀加单引号中和公式（`auditExport.ts:226-236`）；含逗号/引号/换行的字段整体加引号并双写引号；实测 `=cmd|calc` 导出为 `'=cmd|calc`、含换行的 domain 被正确包在引号内；JSON 导出 `JSON.parse` 通过。仍存在上轮已报的 10000 行静默截断 |
| 审计可信性（伪造 actor） | **PASS** | 请求体塞 `user_id/userId` 无效，审计 user_id 恒为 JWT 主体 |


## 第五轮修复状态（执行层回填，提交 `68aa53b` / `2941e5e`）

| 编号 | 状态 | 说明 |
| --- | --- | --- |
| R5-1（P0）授权码首兑失败 | ✅ 已修 | 去掉 claim 后对 `row.used` 的复查；新增集成用例「首兑成功 / 重放失败 / 过期失败」 |
| R5-2 MCP 拒绝分支 `name is not defined` | ✅ 已修 | 4 处模板串改为固定文案，统一返回 not found |
| R5-4 限流 429 返回 text/html | ✅ 已修 | `rateLimitHandler` 统一返回 `{code:429,data:null,msg}` |
| R5-5 令牌 0 审计 | ✅ 已修 | create/delete/toggle 三条路径补 `logAuditOperation` |
| R5-3 分组 QPS 仍差 4.6 倍 | ⏳ 未修 | 命中前仍先跑一次分页查询再全量内存分组；需改「分组模式跳过分页查询 + 服务端分块」 |
