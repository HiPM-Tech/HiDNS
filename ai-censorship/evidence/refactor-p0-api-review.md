# 重构评审 · API 子模块化（4cebbe0）与前端设计地基（2b4fed0）

评审日期：2026-10-23 · 评审员：代码审核团（独立线，只读）
权威依据：`root.ai.md`（第一权威）、`docs/refactor/00-PLAN.md`（本轮总纲）

## 范围

- **被评对象**：`4cebbe0` refactor(api) 与 `2b4fed0` feat(client)，及其新增/删除文件。
- **方法**：`git show 4cebbe0^:server/src/app.ts` 与新 `server/src/app.ts` 逐行比对；通读 `server/src/api/*`、`client/src/ui/*`、`client/tailwind.config.js`；Express 4.22.1 实机验证路由匹配语义；只读执行门禁命令。
- **实跑证据（只读，未改源码）**：
  - `cd server && npx tsc --noEmit` → 0 错。
  - `cd server && npx vitest run src/api` → `10 passed`（1 file）。
  - Express 匹配探针（`/tmp/express_probe.cjs`，用 `server/node_modules/express`）：`/API/users` → 命中 `/api/users` 挂载（大小写不敏感成立）；`/api/%75sers`、`//api/users`、`/api/users%2Fx` → 404（编码/重复斜杠不可穿越）；`/api/init/../users` → 只命中 `/api/init` 挂载，无法跨挂载穿越。
- **重要前提**：评审以两个提交的快照为准。当前工作区另有未提交改动（`git status`：`db/dal/config.ts`、`db/dsm/schema-reconciler.ts`、`routes/accounts.ts`、`routes/init.ts`、`service/systemState.ts` 已改，`service/record-line.ts` 未跟踪），其中 `systemState.ts` / `init.ts` 直接参与门禁语义，故「提交即验收」的假设在本轮不成立。
- **文件命名**：按本轮指令落在 `ai-censorship/evidence/`；与 `root.ai.md` §代码审核团 4 的 `[模型名]_review-YYYYMMDD.md` 命名不一致，如需归档到 `ai-censorship/` 根请另行改名。

## 结论

1. 行为等价性基本成立：24 个模块的相对挂载顺序、`/api/domains/email-templates` 先于 `/api/domains`、`/api/logs` 的 `authMiddleware + adminOnly`、MCP 子路由顺序、`/api/rdap` 限流顺序均与重构前一致；唯一顺序变更是 `/api/auth/webauthn` 提前到 `/api/auth` 之后紧邻位置（等效，无遮蔽）。
2. 三态门禁方向正确且**未发现现实可利用的绕过**（大小写已修，编码/重复斜杠/`..`/query 经实测均不能穿越），但 `closedStateProbes` 缺方法维度约束、registry 的 prefix 唯一性是大小写敏感比较，两处留了同类事故的复发口子。
3. 无 P0；P1 一条：删除 `routes/securityPolicy.ts` 时连带删掉两个**并未被遮蔽**的端点，且 `docs/api.md` 的删除说明与事实相反。

## 发现表

| # | 级别 | 归属 | 置信度 | 位置 | 摘要 |
|---|------|------|--------|------|------|
| 1 | P1 | 本次引入 | HIGH | `server/src/routes/securityPolicy.ts`（已删）、`docs/api.md:679` | 删除的 `GET /api/security/2fa/requirement`、`POST /api/security/check-device` 原本可达，非「被遮蔽」；文档论断与事实相反 |
| 2 | P2 | 本次引入 | HIGH | `server/src/api/init-gate.ts:33-34,48-60`、`registry.ts:42-46`、`types.ts:22-26` | `closedStateProbes` 只按路径放行、不看 HTTP 方法、不校验端点是否只读；`/api/init/db-config` 在不可达窗口对未鉴权方开放 sqlite 绝对路径 |
| 3 | P2 | 本次引入 | HIGH | `server/src/api/registry.ts:7,34-38` | prefix 唯一性是大小写敏感字符串比较，`/api/logs` 与 `/api/Logs` 可通过校验但被 Express 视为同前缀；参数名变体（`/:a` vs `/:b`）同样漏检 |
| 4 | P2 | 本次引入 | HIGH | `server/src/api/registry.ts:56-69`、`index.ts:70-71` | 遮蔽检查只告警不拦截，且对自身清单必然误报（`/api/auth` → `/api/auth/webauthn`），每次启动都打 WARN，噪音化后失去作用 |
| 5 | P2 | 本次引入 | HIGH | `server/src/api/__tests__/api-layer.test.ts:36,77-84` | 「静态子路径告警」用例无任何断言（spy `console.warn`，实现走 `log.warn`），恒真；门禁用例只用 GET，无法证明方法维度 |
| 6 | P2 | 本次引入 | HIGH | `docs/api.md:15,39-69,952` | 三态门禁的对外契约未同步：`/api/init/test-db`、`/database`、`/admin` 仍标「鉴权：无（公开）」，未说明不可达时统一 503；503 释义未更新；`/api/rdap` 在「未初始化+不可达」下变 503 与第 15 行表述冲突 |
| 7 | P2 | 本次引入 | HIGH | `server/src/api/init-gate.ts:48-60`、`service/systemState.ts:71-73` | 数据库不可达时 `test-db`/`database` 一并关闭，管理员失去「向导内改库配置自救」的唯一途径，且无任何文档登记替代恢复路径；门禁读 `lastProbe` 使 setup 面随探测结果抖动开合 |
| 8 | P2 | 本次引入 | MEDIUM | `server/src/app.ts:418` | Swagger 扫描新增 `./src/api/modules/*.ts` 但无对应 `./dist/api/modules/*.js`；`main` 为 `dist/app.js`，仅含 dist 的部署（SEA/镜像）会丢失 Logs 文档段 |
| 9 | P2 | 本次引入 | HIGH | `client/src/ui/tokens.css:25`、`client/tailwind.config.js:98-106`、`client/src/styles/globals.css:7` | 圆角双源：旧控件 `--app-control-radius: 6px`，新原语 `rounded-md = --radius = 8px`，迁移期同屏两套圆角 |
| 10 | P2 | 本次引入 | HIGH | `server/src/app.ts:211-212,224`、`server/src/api/modules/logs.ts:5`、`client/package.json:17-40` | 重构残留未清：`authMiddleware`/`adminOnly`/`asyncHandler`/`workflowsRouter`/`sendError` 均为死导入；8 个 Radix 包 + RHF + zod 未使用即进入 `dependencies` |

## 逐条详情

### 1 · P1 · 删除 `securityPolicy.ts` 连带删掉两个可达端点，且文档论断与事实相反

- **事实**：`4cebbe0^:server/src/routes/securityPolicy.ts` 有 7 条路由；`routes/security.ts` 只有 `GET/POST /password-strength`、`GET|PUT /policy`、`GET /trusted-devices`、`DELETE /trusted-devices/:deviceId` 与之重叠。**`GET /2fa/requirement` 与 `POST /check-device` 在 `security.ts` 中不存在**（`security.ts:68` 是 `/requires-2fa`、`:80` 是 `/2fa-status`、`:163/183/220` 是 `POST /2fa/{setup,enable,disable}`）。
- **因此**：旧代码里这两个端点是**可达的**（`app.use('/api/security', securityRouter)` 不匹配后落到 `securityPolicyRouter`），删除即真实功能删除，不是「清理死代码」。
- **文档反了**：`docs/api.md:679` 写「历史 … 的『备用路由』与上表完全重叠，被 Express 同前缀遮蔽而永久不可达 …（其独占的 `/2fa/requirement`、`/check-device` 无任何调用方）」——前半句对 5 条成立，对这两条不成立；后半句「无任何调用方」只能证明 `client/src` 未用（已核实 grep 为空），不能证明外部 API Token 消费者未用。
- **影响**：对外 API 面收缩未在 `docs/api.md` 的端点表层面申报（端点直接从表里消失，读者无法区分「下线」与「本来就不存在」）。
- **建议**：在 `docs/api.md` 增加「已下线端点」小节，明确这两个端点自 2.2.x 起移除；若要保留兼容，把二者按现有鉴权口径补进 `routes/security.ts`。

### 2 · P2 · `closedStateProbes` 缺方法维度与只读性约束

- **代码**：`init-gate.ts:33-34` 的 `matches()` 只看 `pathname`；`init-gate.ts:50` 放行时**不检查 `req.method`**；`registry.ts:42-46` 只校验 `probe.startsWith(module.prefix)`。而 `types.ts:22-26` 的设计意图明写「仅允许『不改变状态』的端点，写操作必须一并关闭」——该意图目前**没有可执行保证**。
- **现状是否可被打穿**：当前两条 probe 均为 GET-only（`routes/init.ts:63` GET `/db-config`、`:86` GET `/status`），实测 `POST /api/init/db-config` 无路由 → 404，故**当下不存在写穿透**。风险在于「后续给写端点加一条 probe」不会被任何校验拦住。
- **附带**：`/api/init/db-config` 在不可达窗口对未鉴权调用方开放，`service/systemSetup.ts:160-176` 的 `getPublicInitDbConfig()` 对 sqlite 返回 `resolveDefaultDbPath()` 绝对路径（host/账号/密码确已脱敏）。属低危路径泄露，且该端点本就在初始化前公开，故只作提示。
- **建议**：`ApiModule.closedStateProbes` 改为 `{ method: 'GET'; path: string }[]`，门禁同时比对 `req.method.toUpperCase()`；`registry` 拒绝非 GET probe；用例补「POST 命中 probe 路径 → 503」。

### 3 · P2 · registry 的 prefix 唯一性拦不住「同前缀」的变体写法

- **代码**：`registry.ts:7` 的 `PREFIX_PATTERN = /^\/api(\/[A-Za-z0-9_:.-]+)+$/` **允许大写字母与参数段**；`registry.ts:34` 用 `Map.get(module.prefix)` 做**大小写敏感**比较。
- **实机验证**：`/API/users` 确实命中 `app.use('/api/users')`（Express 4.22.1，`caseSensitive` 默认 false）。因此 `{prefix:'/api/logs'}` 与 `{prefix:'/api/Logs'}` 会**通过校验**却被 Express 视为同一挂载点，后者被永久遮蔽——正是本次要防的历史事故类型。
- **同类漏检**：`/api/domains/:domainId` 与 `/api/domains/:id` 是不同字符串、同一匹配集，唯一性校验同样放过。
- **建议**：唯一性键改为 `normalizePrefix(p) = p.toLowerCase()`，并把参数段归一化为占位符（`/:x` → `/:`）后再比较；命中即抛错。用例补「大小写变体前缀 → throw」。

### 4 · P2 · 遮蔽检查只告警，且对自身清单必然误报

- **代码**：`registry.ts:56-69` 的 `warnShadowedNesting` 对 `i<j` 的任意父子前缀对，只要子路径首段不含 `:` 就 `log.warn`（`registry.ts:64`），不判断父 router 是否真的定义了同名静态段。
- **确定性后果**：现行清单 `index.ts:70` `/api/auth` 在 `index.ts:71` `/api/auth/webauthn` 之前 → 每次启动都会输出一条「Static child API prefix is registered after its parent」WARN。而 `routes/auth.ts` 并无 `/webauthn` 路由（已核对全部 20 条 `router.*`），即**纯误报**。
- **反向缺口**：真正的遮蔽（父 router 内部定义了同名静态段，如 `domainsRouter.get('/:id')` 之于 `/api/domains/email-templates`，见 `routes/domains.ts:594`）无法从清单层面检出；而对 `/api/domains/email-templates` 这类**正确顺序**也不会产生任何正向确认。
- **建议**：把「父前缀之后注册静态子路径」改为**启动期抛错**（并提供显式 `allowShadowedNesting` 白名单给 webauthn 这类已核实无害的项）；或直接按「最长前缀优先」排序后再挂载，让顺序不再依赖人工维护。

### 5 · P2 · 单测存在恒真断言，覆盖声明大于实际

- **`api-layer.test.ts:77-84`**：`it('静态子路径晚于父前缀注册时只告警不抛错')` 只做了 `vi.spyOn(console, 'warn')` + `expect(...).not.toThrow()` + `mockRestore()`。实现走的是 `registry.ts:4` 的 `log.warn`（`lib/logger` 通道），且用例**没有任何 `toHaveBeenCalled` 断言**——无论告警是否发生、内容是否正确，该用例都通过。
- **`api-layer.test.ts:36`**：`runGate` 把 `method` 硬编码为 `'GET'`，故 10 条用例无法覆盖「probe 路径上的 POST/PUT/DELETE」这一维度（与发现 2 直接相关）。
- **建议**：断言 `warn` 被调用且参数含 `parent/child`；`runGate` 增加 `method` 参数并补写方法维度用例。

### 6 · P2 · `docs/api.md` 未同步三态门禁的对外契约

- `docs/api.md:44-69` 仍把 `POST /api/init/test-db`、`POST /api/init/database`、`POST /api/init/admin` 标为「鉴权：无（公开）」，**未说明数据库不可达时三者统一返回 503**（`init-gate.ts:55-59`，body `{code:503, data:{needsInit:false, dbReachable:false}}`）。前端若按 `needsInit` 分流，这里是语义反转点（不可达时 `needsInit` 为 **false**）。
- `docs/api.md:952` 的 503 释义仍是「系统未初始化，或工作流模块未启动（数据库不可达降级模式）」，未覆盖「未初始化 + 数据库不可达 → 仅 `/api/init/status`、`/api/init/db-config` 可用」这一新口径。
- `docs/api.md:15` 把 `/api/rdap/*` 归入「无需鉴权」的公共路由，但新门禁在「未初始化 + 不可达」下会把 `/api/rdap` 一并 503（`init-gate.ts:48` 先判 `isSurfaceOpen()`，再判豁免；`exemptFromInitGate` 只在 surface 开放时生效）。这是行为变化，不是鉴权变化，文档需分开表述。
- **依据**：`00-PLAN.md:79`「改动涉及 API 语义时同步 `docs/api.md`」。
- **建议**：`docs/api.md` 增一节「初始化门禁三态矩阵」（行=状态，列=路径组，格=200/503），并修正第 15 行。

### 7 · P2 · 数据库不可达时无自助恢复路径，且 setup 面随探测抖动

- **行为**：`init-gate.ts:48-60` 在 `isSurfaceOpen()===false` 时只放行 probe。`service/systemState.ts:71-73` 的 `isInitSurfaceOpen() = !initialized && lastProbe === 'uninitialized'`。于是「已配置但数据库连不上」的实例，`POST /api/init/test-db`（改配置前必测）与 `POST /api/init/database`（落新配置）**都返回 503**，安装向导无法自救，只能改配置文件/环境变量后重启。
- **抖动**：`lastProbe` 由 `refreshSystemState()` 每 5 秒刷新（`app.ts` 的 `initCheckInterval`）；首次安装过程中任何一次探测失败都会把 `lastProbe` 打成 `unreachable`，把仍在进行中的 setup 面关掉，直到下一次探测成功。旧实现只读粘性 `isSystemInitialized()`，没有这个开合窗口。
- **判断**：安全方向符合 `root.ai.md` §数据库可用性判定 9「严禁把数据库不可达判定为系统未初始化」，**不算违规**；但这是一条运维死路，必须显式登记。
- **建议**：①在 `docs/api.md`/README 写明「数据库不可达时的恢复方式：修改 `DB_*` 环境变量或 `data/` 配置后重启」；②考虑给 `POST /api/init/test-db` 单独开一个「不落库、不改状态」的 probe（它确实只测连接），把「测」与「写」拆开，恢复路径即可保留。

### 8 · P2 · Swagger 扫描路径在 dist 部署下缺口

- `app.ts:418`：`apis: ['./src/routes/*.ts', './src/api/modules/*.ts', './dist/routes/*.js']`。`routes` 有 `src`+`dist` 两条 glob，新增的 `api/modules` **只有 `src` 一条**。
- `server/package.json:6` `"main": "dist/app.js"`，SEA/镜像部署通常不带 `src/`，此时 `swagger-jsdoc` 扫不到 `api/modules/logs.ts`，`/api/docs` 的 `/api/logs` 段会消失（该 JSDoc 已从 `app.ts` 迁到 `modules/logs.ts:7-49`）。
- **置信度 MEDIUM**：是否复现取决于发布产物是否包含 `src/`（`scripts/build-sea.mjs` 的打包清单未在本轮核对，标「待核实」）。
- **建议**：补 `'./dist/api/modules/*.js'`，与 `routes` 保持一致。

### 9 · P2 · 圆角 token 双源，迁移期视觉分裂

- 旧体系：`client/src/styles/globals.css:7` `--app-control-radius: 6px`（TDesign 控件半径）。
- 新体系：`client/src/ui/tokens.css:25` `--radius: 0.5rem`；`client/tailwind.config.js:102` `md: 'var(--radius)'` → `rounded-md = 8px`，被 `ui/button.tsx:7`、`ui/input.tsx:11`、`ui/card.tsx:6` 使用。
- **结论**：`lg=12px`、`xl=16px` 的折算与旧配置完全一致（`2b4fed0^:client/tailwind.config.js` 的 `lg:0.75rem / xl:1rem`），提交信息所称「保持旧页面视觉不变」**对 lg/xl 成立**；但 `md` 由旧的 8px 变成 `var(--radius)=8px`（等价），真正的新旧不一致来自 `6px（旧控件）vs 8px（新原语）`。
- **附带（低危）**：`--radius` 只在 `@layer base` 的 `:root` 中定义；任何未加载 `tokens.css` 的消费方（单测渲染、文档沙箱）会让 `rounded-md` 解析为空值。
- **建议**：迁移期把 `--radius` 设为 `6px`（与 `--app-control-radius` 对齐）或把 `--app-control-radius` 改为引用 `var(--radius)`，二者只留一个真源。

### 10 · P2 · 重构残留与依赖冗余

- `server/src/app.ts:211` `authMiddleware, adminOnly`、`:212` `asyncHandler`、`:224` `workflowsRouter`：四个导入在文件内**零引用**（`/api/logs` 内联实现与 `/api/workflows` 挂载都已迁走）。`tsc` 未报错是因为 `noUnusedLocals` 未开启，属静默残留。
- `server/src/api/modules/logs.ts:5` 导入了 `sendError` 但未使用（旧的 try/catch + `sendError(500)` 被 `asyncHandler` 取代；错误通道改由 `errorHandler` 输出 `{code,message,details,timestamp}`，与旧 `{code,msg}` 形状不同，属**未申报的响应形状变化**，建议在 `docs/api.md` 的 `/api/logs` 段标注）。
- `client/package.json:17-24` 引入 8 个 Radix 包，当前原语只用到 `@radix-ui/react-slot`（`ui/button.tsx:2`）与 `@radix-ui/react-label`（`ui/label.tsx:2`）；`dialog/dropdown-menu/select/switch/tabs/tooltip` 与 `react-hook-form`、`@hookform/resolvers`、`zod` 在 `client/src` 中零引用（已 grep）。它们已进 `dependencies`（生产依赖），提前扩大安装体积与供应链面。
- **待核实**：`tailwind-merge@3.7.0` 面向 Tailwind CSS v4，项目为 `tailwindcss@3.4.19`；自定义刻度（`shadow-xs/base`、`rounded-base`、`duration-fast`、`spacing xs/sm/md`）能否被 `cn()` 正确判重，本轮未做行为验证。
- **建议**：删掉死导入；未使用的 Radix/RHF/zod 先留在 `devDependencies` 或随对应阶段引入；补一条 `cn()` 冲突合并的用例（`cn('rounded-md','rounded-lg')` → `rounded-lg`）。

## 经核实无问题

1. **24 个模块的相对顺序与重构前一致**。逐条对齐（旧 `app.ts` 行号 → 新 `api/index.ts` 条目）：`init` 495→62、`auth` 498→70、`users` 499→72、`teams` 500→73、`accounts` 501→74、`domains/email-templates` 502→76、`domains` 503→81、`providers` 504→82、`domains/:domainId/records` 505→84、`rdap` 506→90、`system` 507→97、`settings` 508→98、`security` 509→99、`audit` 511→100、`tunnels` 514→101、`tokens` 516→102、`ns-monitor` 517→103、`network` 518→104、`servicemonitor` 519→105、`resource-monitor` 520→106、`workflows` 523→107、`mcp` 534→108、`logs` 580→109。计数 24，与重构前 25 次挂载减 1 次同前缀重复（`securityPolicy`）相符。
2. **`/api/domains/email-templates` 仍先于 `/api/domains`**（`index.ts:76-80` 在 `81` 之前）。这一点很关键：`routes/domains.ts:594` 有 `router.get('/:id')`，若顺序反了 `email-templates` 会被当成 `id` 吃掉。
3. **`/api/logs` 鉴权保留**：`api/modules/logs.ts:52` `router.get('/', authMiddleware, adminOnly, asyncHandler(...))`，与旧 `app.ts:580` `app.get('/api/logs', authMiddleware, adminOnly, ...)` 的中间件链一致；`app.use('/api/logs', router)` 与 `app.get('/api/logs')` 的匹配面差异仅限尾部斜杠与 OPTIONS，无鉴权影响。
4. **MCP 子路由顺序一字未改**：`index.ts:42-51` 与旧 `app.ts:526-534` 完全同序（`/` → `/api-keys` → `/oauth` → `/audit-logs` → `/audit-stats` → `/` 协议路由最后），协议路由仍排最后。
5. **`/api/auth/webauthn` 提前是等效变更**：旧位置（`app.ts:515`）在 `/api/auth`（`:498`）之后，新位置（`index.ts:71`）同样在 `/api/auth`（`:70`）之后，且 `routes/auth.ts` 无 `/webauthn` 路由、无 router 级 `use` 中间件，故前置后无路由被截获、无中间件被跳过。
6. **门禁绕过面**：实测 `/API/*` 已由 `init-gate.ts:37` 的 `toLowerCase()` 封堵；`%75`/`%2F` 编码、`//`、`/api/users%2Fx` 在 Express 4.22.1 下均 404；`/api/init/../users` 只会命中 `/api/init` 挂载、无法跨挂载穿越到 `/api/users`；`req.path` 天然剥离 query。门禁自身对未知写法 fail-closed（未命中即 503），方向正确。
7. **`isSurfaceOpen()` 的判定顺序正确**：`init-gate.ts:44` 先判已初始化（粘性，DB 抖动不回退）→ `:48` 再判 surface → `:62` 最后判豁免，与 `service/systemState.ts:71-73` 的「仅未初始化且可达才开放」严格一致，未出现「不可达被当成未初始化」。
8. **无新增循环依赖、无 import 期副作用**：`api/index.ts` 只 import `routes/*` 与 `./modules/logs`；`routes/*` 不反向 import `api/`；`createApiLayer(deps)` 用函数注入 `isInitialized/isSurfaceOpen`（`app.ts:424-427`），未把 `service/systemState` 反向耦合进 api 层，符合 `00-PLAN.md:43` 的 `api → service` 方向。`app.ts` 的 env/SEA 前置段（`:1-186`）原封不动，import 顺序语义未变。
9. **门禁注册位置正确**：`app.ts:430` 门禁 → `:432` `/api/docs` → `:434` `apiLayer.mount(app)`，与旧 `app.ts:490`→`:492`→`:495+` 同序；`express.static` 与 SPA fallback 仍在业务路由之后（`:466-492`）。
10. **`root.ai.md` 硬条款合规**：`api/modules/logs.ts` 经 `service/auditExport`（服务层）取数，未直接 import `db/*`；日志器命名 `createLogger('HTTP').sub('ApiRegistry'|'ApiGate'|'ApiMount')` 符合 §日志 1/7；「默认拒绝 + 显式豁免」由 `exemptFromInitGate` 派生，不再有第二份手写清单（`init-gate.ts:28`）；`root.ai.md` §路由 已同步改写（含三态与大小写要求）。
11. **前端 tokens 与旧样式未发生实质冲突**：`client/src/index.css:2-4` 的 `@import` 顺序合法（两条 import 前无其它规则）；`darkMode:'class'`（`tailwind.config.js:4`）与 `ThemeContext.tsx:33` 的 `element.classList.toggle('dark')` 对齐，`tokens.css:28` 的 `.dark` 与 `:root` 同特异性且在后，暗色变量能覆盖；`tokens.css:48-50` 的 `* { border-color }` 把 preflight 默认边框色从 `#e5e7eb` 改为 `hsl(214 32% 91%)`，色差极小且 utilities 仍优先，不构成视觉回归；`Badge` 的 `success/warning/danger` 色阶已在 `tailwind.config.js:49-84` 定义，无悬空类。
12. **依赖确实落地**：`client/node_modules` 存在 `clsx`、`tailwind-merge`、`class-variance-authority`、`@radix-ui/*`，`pnpm-lock.yaml` 已同步（`tailwind-merge@3.7.0`），不存在「package.json 改了但装不上」的构建阻断。
13. **门禁命令通过**：`server: tsc --noEmit` 0 错；`server: vitest run src/api` 10/10 通过。`client` 的 `tsc`/`vite build` 本轮未跑（只读评审范围限于 `ui/*` 与配置，未做整包构建）。
