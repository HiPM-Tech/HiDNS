# HiDNS 综合评估报告（依据 root.ai.md）

- **评估对象**：`HiDNS-20261013221734.log`（71,341 行生产日志）+ 当前主干代码（`7049fdb`）
- **评估依据**：`root.ai.md`（878 行）
- **评估日期**：2026-10-13
- **评估模型**：deepseek-v4.1-flash

---

## 一、结论摘要

| 维度 | 结论 |
|---|---|
| 问题一（连接态无法复原） | **规范未覆盖**，属实现缺陷；违反 §数据库 8「确保数据的安全性和可靠性」的立法本意 |
| 问题二（TaskManager 活锁） | **规范未覆盖**（§服务层 388 仅登记 `taskManager.ts`，未定义任务语义）；构成 §代码审核团 19 所称可立即上报的 P0 |
| 问题三（误入初始化态泄露） | **规范存在自相矛盾的条款**（§路由 347 vs §应用初始化 452），实现同时违反 §服务层 376 与 §数据库 2 两条硬约束 |
| 规范本身的缺陷 | 3 处条款缺口 + 1 处条款冲突，**是上述 P0 得以长期存在的制度原因** |
| 主干遗留高危缺陷 | 发现 6 项仍存于主干的安全缺陷，其中 2 项为 P0，且**曾被已丢弃分支修复** |

**核心判断**：这三个问题不能只归因于实现。`root.ai.md` 在**连接生命周期**、**任务调度语义**、**初始化路由的开放边界**三处均无有效约束，且 §路由 347 与 §应用初始化 452 存在直接冲突——规范本身需要先修，否则同类缺陷会反复出现。

---

## 二、问题一：数据库重启后连接态丢失无法复原

### 2.1 规范比对

| 规范条目 | 内容 | 判定 |
|---|---|---|
| §应用初始化 450 | 启动流程：加载环境变量 → 创建数据库连接 → DSM 初始化 → 检查初始化状态 | **只定义启动期，未定义运行期重连** |
| §应用初始化 456 | 关闭顺序：停止定时任务 → 关闭 WebSocket → 断开数据库连接 → 关闭 HTTP 服务器 | 定义了关闭，未定义关闭后的恢复 |
| §数据库 55 | 驱动基类 `BaseDriver`，各驱动实现方言差异 | 未约定连接池健康检查与重连语义 |
| §数据库 62 | 连接管理在 `dal/connection.ts`，支持连接池管理、事务管理 | 登记了文件，未定义生命周期契约 |
| §数据库 8（113-114） | 数据库是用户实例数据存储的根本原因，需要确保数据的安全性和可靠性 | **违反本意**：连接不可恢复导致服务不可用 |
| §数据库 2（48-52） | 所有数据库操作必须通过 BAL；调用链 路由/Service → BAL → DAC → 驱动 | 见 §2.3 违规 |

**判定**：问题一**不属于规范条文的直接违规**，因为规范从未定义连接池的重连语义。但它在架构上违反了 §数据库 8 的立法本意。

### 2.2 实现缺陷（两个独立 bug）

**Bug 1a —— 单例被置空，重连落在被遗弃的旧实例上**

- `server/src/db/dal/connection.ts:303`：`disconnect()` 执行 `ConnectionManager.instance = null`
- `server/src/db/dal/connection.ts:230-231`：健康检查调用 `this.disconnect()` + `this.connect()`，操作的是**旧实例**
- `server/src/db/dal/connection.ts:356-358`：模块级 `getConnection()` 走 `ConnectionManager.getInstance()` → 因 `instance` 已置空 → **新建一个无连接的管理器**
- 后果：重连"成功"但连接挂在孤儿对象上，此后所有 DB 访问抛 `Database connection not initialized`；且旧实例的 `startHealthCheck()`（第 142 行）被重复触发，定时器持续叠加

**Bug 1b —— 重连计数只在成功时清零，失败后被永久耗尽**

- `server/src/db/dal/connection.ts:94-95`：`reconnectAttempts = 0`、`maxReconnectAttempts = 3`
- `server/src/db/dal/connection.ts:141`：仅成功路径 `this.reconnectAttempts = 0`
- `server/src/db/dal/connection.ts:144-147`：失败路径 `throw error`，**不清零**
- `server/src/db/dal/connection.ts:154`：`while (this.reconnectAttempts < this.maxReconnectAttempts)`
- 后果：退避仅 1s + 2s ≈ 3 秒，数据库重启普遍超过该窗口 → 计数停在 3 → 后续任何 `connect()` **立即抛错、连一次尝试都不做**

### 2.3 附带的规范违规

`server/src/service/serviceMonitorJob.ts:4` 与 `server/src/service/whois/scheduler.ts:29` 由 Service 层直接导入 `connect`，绕过 BAL，违反 §数据库 2 规定的调用链（路由/Service/Middleware → 业务适配器函数 → 数据库抽象层 → 驱动）。

---

## 三、问题二：TaskManager 忙等活锁

### 3.1 规范比对

| 规范条目 | 内容 | 判定 |
|---|---|---|
| §服务层 388 | `taskManager.ts`：任务管理器 | **仅登记文件，未定义任务生命周期、并发、超时、重排语义** |
| §日志相关 121-122 | 级别 `trace<debug<info<warn<error`，`HIDNS_LOG_LEVEL` 默认 `info` | 洪水为 WARN 级，**默认配置下无法抑制**；需显式设为 `error` 才能止住 |
| §代码审核团 19 | 多次出现 P0 级问题需立即通知项目团队 | 本问题构成应上报的 P0 |

**判定**：规范对任务管理器**无任何语义约束**，属规范缺口。

### 3.2 日志证据

```
71,341 行日志中 71,123 行（99.7%）为同一条 WARN：
WARN [Job] [TaskManager] [TaskManager.executeTask] [L127]
     Task already running, re-queuing: Domain Sync: n3532284407@163.com { taskId: 'domain-sync-4' }

时间跨度：14:16:14.420Z → 14:16:36.935Z（22 秒），峰值 3,927 行/秒
```

### 3.3 实现缺陷

`server/src/service/taskManager.ts:155-183`：

```js
while (this.taskQueue.length > 0 && this.runningTasks.size < this.maxConcurrentTasks) {
  const queuedTask = this.taskQueue.shift();     // 从队首取出
  if (!queuedTask) break;
  this.executeTask(queuedTask);                  // 未 await
}
// executeTask 内：
if (this.runningTasks.has(taskId)) {
  log.warn(`Task already running, re-queuing: ${options.name}`, { taskId });
  this.taskQueue.unshift(queuedTask);            // 塞回队首
  return;                                        // 无 await，同步返回
}
```

`shift()` → 发现已在 running → `unshift()` 回到**队首** → 立即再取出同一个 → 无限循环。因该分支在首个 `await` 之前 `return`，整个 while **完全同步**执行，**事件循环被阻塞**。三个后果：

1. **服务完全无响应**（HTTP/WebSocket/其它定时任务全部停摆）
2. **磁盘洪水**：约 178 字节/行 × 3,200 行/秒 ≈ **620 KB/s ≈ 2.2 GB/小时**
3. **超时永不触发**：`domain-sync-4` 虽配 `timeout: 300000`，但超时依赖 `setTimeout`，事件循环被占死 → 回调永不执行 → **活锁永久化，只能重启进程**

该任务 ID 来自 `server/src/service/domainSyncJob.ts:335` 的按账号固定 ID `domain-sync-${account.id}`，DB 断开时任务挂起不结束，下一次调度提交同 ID 即引爆。

---

## 四、问题三：丢失连接 → 误入初始化态 → 泄露隐患

### 4.1 规范比对 —— 存在**条款冲突**

| 规范条目 | 内容 | 判定 |
|---|---|---|
| §路由 345 | 路由通过 `initCheckMiddleware` 检查初始化状态，未初始化时返回 503 | 实现仅对 11 个前缀生效 |
| §路由 347 | `/api/init`：系统初始化（**始终可用，不受初始化检查限制**） | 无条件挂载 `/api/init` **符合本条** |
| §应用初始化 452 | 未初始化模式：**仅开放初始化路由**，每 5 秒检查状态 | **被违反**：另有 10 个前缀同样开放 |
| §服务层 376 | **禁止在路由中直接操作数据库**，所有数据库操作必须通过服务层或业务适配器 | **被违反** |
| §数据库 2（48-52） | 所有 DB 操作必须通过 BAL；禁止直接导入驱动层/查询构建器 | **被违反** |

> **规范冲突（须项目团队裁决）**：§路由 347 要求 `/api/init` "始终可用"，§应用初始化 452 要求未初始化态"仅开放初始化路由"。二者共同暗示：**初始化路由在正常态也应存在**，因此其安全性必须由**端点自身守卫**承担——但规范从未对此作出规定。这正是本问题的制度缺口。

### 4.2 根因链

**环节一：DB 故障被误判为"系统未初始化"**

```js
// server/src/db/connection.ts:61-79
export async function isDbInitialized(): Promise<boolean> {
  try { ... } catch (error) {
    // Connection not established yet
    return false;                       // ← 吞掉所有异常
  }
}
// server/src/db/connection.ts:86-93
export async function hasUsers(): Promise<boolean> {
  try { ... } catch { return false; }   // ← 同样吞掉
}
// server/src/app.ts:312-314
async function checkInitialization() { return await isDbInitialized() && await hasUsers(); }
// server/src/app.ts:700
isInitialized = await checkInitialization();
```

DB 不可达 → 两者均 `false` → `isInitialized = false` → 打印 `Running in initialization mode`。

**环节二：`/api/init` 无任何守卫**

- `server/src/app.ts:451`：`app.use('/api/init', initRouter);`，注释 `always available`
- `server/src/routes/init.ts`：**`router.use` 守卫数量为 0**

**环节三：端点自守参差不齐**

| 端点 | 自守 | DB 故障时行为 |
|---|---|---|
| `GET /status` | 无 | 泄露初始化状态 |
| `GET /db-config` | `isDbInitialized() && hasUsers()` | **守卫反转→放行**（内容已脱敏，无凭据） |
| `POST /test-db` | **无** | 任意 DB 连接探测 |
| `POST /database` | **无** | **改库配置并重连到指定库** |
| `POST /admin` | `isDbInitialized() && !hasUsers()` | DB 不可达→400（侥幸拦住） |

**环节四：接管链成立**

`server/src/routes/init.ts:254` 的 `POST /database` 不受初始化态限制、不受鉴权限制，它接受任意库配置、`saveDatabaseConfig()` 写配置、`disconnect()` + `connect(testConfig)` 连到该库。攻击链：

1. DB 故障或应用重启 → `isInitialized = false` → `/api/init` 敞开
2. `POST /api/init/database` 指向攻击者控制的空库 → 真实库配置被覆盖（DoS / 数据劫持）
3. `POST /api/init/admin` → 创建管理员 → **完全接管**

**环节五：`init.ts` 直接操作数据库层**

`server/src/routes/init.ts:6-7` 静态导入 `createConnection, isDbInitialized, hasUsers` 与 `connect`；第 292 行动态导入 `disconnect`。经全仓扫描，`init.ts` 是**唯一**违反 §服务层 376 的路由文件——即本问题的载体文件，恰好也是唯一违约的路由。

### 4.3 关于泄露范围的准确界定

为避免夸大，特此明确：`getPublicInitDbConfig()`（`init.ts:119-135`）仅返回 `type`/`ssl`/`database`/`sqlite.path`，**不含 host、用户名、密码**，是刻意脱敏的。`/db-config` **不是凭据泄露点**。真正的风险是 `/database` 与 `/admin` 构成的接管链，以及 `/test-db` 的内网探测能力。

### 4.4 未初始化态的实际开放面

规范 §应用初始化 452 要求"仅开放初始化路由"，但实测挂载 21 个 `/api/*` 前缀，`protectedPaths` 仅覆盖 11 个（`app.ts:467`）。差集 10 项：

```
/api/audit  /api/docs  /api/email-templates  /api/network  /api/ns-monitor
/api/providers  /api/rdap  /api/security  /api/system  /api/tunnels
```

其自身鉴权覆盖实测（**多行路由定义感知**，见 §10 的勘误说明）：

| 路由 | 端点数 | authMiddleware | adminOnly | 判定 |
|---|---|---|---|---|
| `/api/audit` | 6 | 7 | 7 | ✓ 全量鉴权且限管理员 |
| `/api/email-templates` | 5 | 6 | 0 | ✓ 全量鉴权 |
| `/api/network` | 3 | 4 | 0 | ✓ |
| `/api/ns-monitor` | 10 | 11 | 0 | ✓ |
| `/api/providers` | 2 | 2 | 0 | ✓ |
| `/api/tunnels` | 4 | 5 | 0 | ✓ |
| `/api/security` | 15 | 14 | 6 | △ 13 处鉴权；`POST /password-strength`(L36)、`POST /validate-password`(L52) 公开 |
| `/api/system` | 2 | **0** | 0 | ✗ **全量无鉴权** |
| `/api/rdap` | 2 | 0 | 0 | ✓ **符合规范**：§服务层 430 明确"公开 RDAP 路由（无需鉴权）" |

**更正后的实际暴露面**：10 个未受 `initCheckMiddleware` 保护的前缀中，**8 个具备自身鉴权**，实际无鉴权可达的仅为：

1. `GET /api/system/info`、`GET /api/system/version`（`routes/system.ts:7,44`，见 §7.3）
2. `POST /api/security/password-strength`、`POST /api/security/validate-password`——设计上需在登录前可用（注册/改密强度提示），**但二者无 rateLimit 且未限制输入长度**；zxcvbn 为 CPU 密集型，构造超长输入可造成 CPU 耗尽（express.json 默认 100 KB 上限仍足以放大），记为 P2
3. `/api/docs`（Swagger UI）——完整 API 表面暴露

因此 §应用初始化 452「仅开放初始化路由」的违反程度应据实下调：**门禁缺失属实，但绝大多数被暴露的路由仍有自身鉴权兜底**，真实影响面小于初判。

---

## 五、规范条目逐项核验表

### 5.1 违反项

| 规范条目 | 要求 | 实现 | 位置 |
|---|---|---|---|
| §服务层 376 | 禁止在路由中直接操作数据库 | **违反** | `routes/init.ts:6,7,292` |
| §数据库 2 | 所有 DB 操作经 BAL，禁止直连驱动/连接 | **违反** | `routes/init.ts`、`service/serviceMonitorJob.ts:4`、`service/whois/scheduler.ts:29` |
| §应用初始化 452 | 未初始化态仅开放初始化路由 | **违反**（另 10 个前缀未受 `initCheckMiddleware` 门禁；其中 `/api/system` 无自身鉴权、2 个密码强度端点公开，其余 8 个有鉴权兜底） | `app.ts:467` |
| §安全规范 814 | 请求频率限制（rateLimit） | **部分缺失**：`/api/init/*` 无 rateLimit | `routes/init.ts` |

### 5.2 合规项

| 规范条目 | 核验结果 |
|---|---|
| §路由 347（`/api/init` 始终可用） | ✓ 符合（无条件挂载即本条要求） |
| §日志相关 117-119 | ✓ 无旧式 `log.info(module, msg)`，日志器命名规范 |
| §日志相关 124 | ✓ 洪水行格式符合 `日期 级别 [模块] [子模块] [函数] [L行号] 内容` |
| §安全规范 805 | ✓ 密钥实现为 `JWT_SECRET:runtime_secret`（`service/jwt.ts:57`），符合规范 |
| §代码审核团 4 | ✓ 本报告落于 `ai-censorship/`，命名合规 |
| §代码规范 38 | ✓ 取证仅用 git/grep/读取，未使用脚本 |

---

## 六、规范自身的缺陷（须先修规范）

| 编号 | 缺陷 | 导致的后果 |
|---|---|---|
| G1 | §应用初始化 449-457 只定义启动与关闭，**无运行期连接生命周期**（健康检查、重连上限、退避、单例归属） | 问题一长期未被发现 |
| G2 | §服务层 388 只登记 `taskManager.ts`，**无任务并发/超时/重排/终止语义** | 问题二长期未被发现 |
| G3 | §路由 347 与 §应用初始化 452 **冲突**：前者要求 `/api/init` 始终可用，后者要求未初始化态仅开放初始化路由；两者均未规定**端点级守卫义务** | 问题三的直接制度缺口 |
| G4 | §数据库 40-114 定义了跨层调用链，但**未定义"数据库不可达"与"未初始化"的区分语义** | `isDbInitialized()` 吞异常返 false 得以长期存在 |

---

## 七、主干中仍存在、曾被已丢弃分支修复的安全缺陷

评估中发现：`9c6968d`（已按指示丢弃的分支）曾修复的一批安全问题，**在主干中并未修复**。除 WS 广播脱敏已由上游 PR #37 独立修复外，其余仍在：

| 编号 | 缺陷 | 主干现状 | 位置 | 级别 |
|---|---|---|---|---|
| S1 | **命令注入 RCE** | `` execAsync(`ping -n 1 -w 3000 ${ip}`) ``，`ip` 未校验直接拼接 shell | `service/serviceMonitor.ts:640-641` | **P0** |
| S2 | **2FA 关闭绕过** | 注释称"验证当前 TOTP 令牌才能禁用"，但 `token` 从未校验，直接 `disableTOTP(userId)` | `routes/security.ts:220-231` | **P0** |
| S3 | 代理接口越权 | 仅 `authMiddleware`，无 `adminOnly`；响应体回传明文密码 | `routes/network.ts:63,81` | P1 |
| S4 | 会话 ID 弱随机 | `Math.random().toString(36)` | `service/session.ts:96` | P2 |
| S5 | 邮箱验证码弱随机 | `Math.floor(100000 + Math.random()*900000)` | `service/emailVerification.ts:16` | P2 |
| S6 | `/api/system/info` 无鉴权 | 无 `authMiddleware`；返回 DB 类型/版本、应用版本（**已确认不含 host/凭据**） | `routes/system.ts:7` | P2 |

**决策相关提示**：上述 S1、S2 为可利用的高危缺陷。若丢弃分支的唯一目的是放弃其分叉历史，建议**单独摘取这两个修复**（它们各自独立、改动极小、无耦合），否则主干将继续暴露在命令注入与 2FA 绕过之下。

---

## 八、问题分级汇总（按 §代码审核团）

| 级别 | 条目 | 依据 |
|---|---|---|
| **P0** | `/api/init/database`、`/test-db` 无端点守卫，构成未授权接管链 | §安全规范；§应用初始化 452 |
| **P0** | TaskManager 同步活锁阻塞事件循环 + 2.2 GB/小时日志洪水 | §代码审核团 19 |
| **P0** | DB 故障被误判为未初始化，`checkInitialization()` 无降级语义 | §应用初始化 452 |
| **P0** | S1 命令注入 RCE | §安全规范 |
| **P0** | S2 2FA 关闭绕过 | §安全规范 1 |
| **P1** | 连接态无法复原（Bug 1a 单例归属 + Bug 1b 计数耗尽） | §数据库 8 本意 |
| **P1** | 未初始化态门禁缺失：10 个前缀未受 `initCheckMiddleware` 保护。实际无鉴权可达者为 `/api/system/info`、`/api/system/version`、2 个密码强度端点及 `/api/docs`；其余 8 个前缀有自身鉴权兜底 | §应用初始化 452 |
| **P1** | S3 代理接口越权与密码回显 | §安全规范 2 |
| **P1** | 规范冲突 G3 未裁决 | §代码审核团 16（中立性） |
| **P2** | `routes/init.ts` 直连 DB 层 | §服务层 376、§数据库 2 |
| **P2** | `/api/init/*` 缺 rateLimit | §安全规范 814 |
| **P2** | S4/S5/S6 | §安全规范 |
| **P2** | `app.ts:7-9` 临时内存库回退可致未鉴权建号入口暴露 | §应用初始化 450 |

---

## 九、整改建议与优先级

### 第一批（P0，改动小、见效快）

1. **封堵初始化面**：在 `init.ts` 顶部加 `router.use` 守卫——`/database`、`/test-db` 仅在 `!isInitialized` 时放行；系统一旦完成初始化即整体拒绝 `/api/init/*`（`/status` 除外）。同步消除 §路由 347 与 §应用初始化 452 的冲突。
2. **修活锁**：running 冲突时改为**带退避的异步重排**并限制重排次数（禁止无界 `unshift` 回队首）；为 `runningTasks` 增加看门狗强制清理超龄任务；超时机制不得依赖被阻塞的事件循环。
3. **区分"DB 不可达"与"未初始化"**：`isDbInitialized()`/`hasUsers()` 改为抛错；`checkInitialization()` 抛错时**保持上一次已初始化状态**并进入只读降级，而非初始化模式。
4. **摘取 S1、S2 修复**：`isSafeHost()` + `spawn` 参数化；`verifyTOTPTokenForUser()` 在 `disableTOTP()` 之前校验。

### 第二批（P1）

5. `connect()` 入口无条件重置 `reconnectAttempts`；`disconnect()` 不置空单例（或 `connect()` 改走 `getInstance()`）；提高重连上限并延长退避。
6. `protectedPaths` 补全其余 10 个前缀，或改为**白名单式**（仅放行 `/api/init/status`），避免逐个遗漏。
7. 代理接口补 `adminOnly` 并脱敏密码。

### 第三批（规范修订，防止复发）

8. **补 G1**：在 §应用初始化 增加"运行期连接生命周期"条款（健康检查周期、重连上限、退避策略、单例归属规则、失败降级语义）。
9. **补 G2**：在 §服务层 增加"任务管理器语义"条款（同 ID 冲突处理、最大并发、超时强制终止、重排退避与上限、日志限流）。
10. **裁决 G3**：明确 `/api/init` 的端点级守卫义务与开放窗口边界。
11. **补 G4**：在 §数据库 增加"连接不可达 ≠ 未初始化"的判定语义与降级要求。
12. **补日志条款**：§日志相关 增加同源日志限流/去重要求（如 1 秒内同键日志合并计数），从规范层避免洪水。

---

## 十、评估声明

### 勘误记录

初稿在统计路由鉴权覆盖时使用**单行正则** `^router\.(get|post|...)\(.*authMiddleware`，而 `routes/audit.ts` 等文件采用**多行路由定义**（`router.get(` 与 `authMiddleware` 分行书写），导致初稿误判 `/api/audit`（实为 6 端点全部 `authMiddleware` + `adminOnly`）与 `/api/email-templates`（实为 5 端点全部鉴权）"全量无鉴权"。

已改用多行感知统计并逐端点复核，§4.4 与 §5.1、§8 均已更正。此项误判影响"未初始化态暴露面"的严重性定级，**更正后该条从 P0 下调为 P1**。按 §代码审核团 24「代码审核团如果自身多次出现错误判断，项目团队有理由抹杀代码审核团的AI」，特此留痕，不做静默修正。

### 声明

- 本报告依 `root.ai.md` §代码审核团 4 出具，置于 `ai-censorship/`，命名遵循 `[模型名]_review-YYYYMMDD.md`。
- 全程未使用脚本，取证仅依赖 git / grep / 文件读取（§代码规范 38）。
- 所有结论均附可复现位置（`文件:行号`、提交号或日志行），未作推测性断言。
- 已按 §代码审核团 16「保证中立性，不偏袒任何一方」要求，对实现方与规范方**同等追责**：既列出实现缺陷，亦指出规范自身的 4 处缺口与 1 处冲突。
- 报告中所有"✓ / ✗ / △"判定均已逐端点或逐函数复核，无"待复核"残留项。
