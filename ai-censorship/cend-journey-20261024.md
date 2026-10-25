# C 端全流程落地走查报告（2026-10-24）

- 目标：以**普通用户**身份，从零安装开始，一步步点击到各功能，验证「落地端」是否可用。
- 环境：隔离目录 `/tmp/cend`（自带 `data/.env` 与全新 SQLite），服务端 3001、前端 Vite 5173，Playwright Chromium（`e2e/node_modules`）。
- 证据：`ai-censorship/evidence/cend-*.png`（初始化/各页面截图）与 `cendB-*.png`（业务操作截图）。

## 一、走查结果

### 1. 安装向导（零到可登录）

| 步骤 | 结果 | 说明 |
| --- | --- | --- |
| 打开 `/setup` | PASS | 三步向导：数据库 → 管理员 → 完成 |
| 测试连接（SQLite 默认路径） | PASS（修复后） | 修复前**全新库误报「检测到已有数据」**，还给出「重置并初始化」危险入口 |
| 下一步（建库） | PASS | DSM 建表，进入管理员步骤 |
| 创建管理员 | PASS | 用户名规则：3–20 位字母/数字/下划线（`cend-admin` 会被拒，提示清晰） |
| 登录 → 仪表盘 | PASS | 会话正常，`/dash` 权限壳生效 |

**F1（已修）**：全新数据库在安装向导里被判定为「已有数据」。
根因：`testSqliteConnection/testMysqlConnection/testPostgresqlConnection` 用「表存在」当「有数据」，而服务启动时 DSM 会先建表。
修复：只有 `users` 有行、或 `domains` 有行才算已有数据；三套数据库一致。

**F2（已修）**：向导成功提示混入英文 `Database already initialized. Proceed to create admin user.`
修复：后两处提示改为中文；初始化端点限流 429 也改为 `{code,data,msg}` 中文 JSON。

**F3（已修，部署相关）**：显式环境变量会被 `data/.env` 覆盖。
复现：`DB_PATH=/tmp/cend/data/app.db ... npx tsx src/app.ts` 启动后实际打开的是 `data/.env` 里写的另一个库。
修复：`data/.env` 不再覆盖进程启动时已存在的环境变量（Docker `-e` / systemd `Environment=` 优先），并记录被忽略的键。

### 2. 控制台全页面（15 个路由）

仪表盘、域名、DNS 账户、服务监控、NS 监控、域名续期、团队、用户、API 令牌、审计日志、自动化工作流、设置、安全、系统管理、MCP、关于：**全部可打开，无白屏、无 5xx、无横向溢出**（脚本逐个断言 `scrollWidth <= clientWidth`）。
证据：`cend-page-*.png`；步骤统计 pass=21 / fail=0，console error=0，5xx=0。

### 3. 业务操作（真实点击）

| 操作 | 结果 | 证据 |
| --- | --- | --- |
| 新建 DNS 账户（虚拟/测试提供商） | PASS | `cendB-dbg-acc-created.png` |
| 从提供商站点列表托管域名 `example.test` | PASS | `cendB-01/02` |
| 新建 A 记录 | PASS | `cendB-04-record-A` |
| 新建 TXT 记录 | PASS | `cendB-04-record-TXT` |
| 新建 MX 记录（优先级 10） | PASS | 表单组合值 + 独立优先级字段 |
| 新建 SRV 记录（优先级/权重/端口） | PASS | 需要中文标签「端口」，值走四段校验 |
| 新建服务监控（HTTPS example.com） | PASS | `cendB-07` |
| 新建 API 令牌 | PASS | `cendB-09` |
| 新建团队 | PASS | `cendB-10` |
| 主题切换 | PASS | `cendB-12` |
| 审计日志包含本次操作 | PASS | `cendB-13`（含域名/令牌记录） |
| 工作流新建弹窗 | PASS | `cendB-14` |

**F4（已修）**：提供商配置项在账户弹窗里显示原始键（`virtual_enabled`、`virtual_seed` 等）。
修复：`configFieldLabel` 增补虚拟/测试提供商的裸键映射，并保留「未知键去前缀」兜底。

**F5（已修）**：顶栏「实时」长期显示**已断开**。
根因：React 严格模式下 effect 挂载→卸载→再挂载，旧连接的 `onclose` 在新一轮里触发，被当成意外掉线 → 立刻重连 → 又触发旧连接关闭，形成每秒抖动。
修复：卸载时先摘掉 `onopen/onmessage/onclose/onerror` 再 `close()`。复测：顶栏显示「实时已连接」。

**F6（已知限制，非缺陷）**：虚拟提供商默认不出现在提供商下拉（需要 `HIDNS_ENABLE_VIRTUAL_PROVIDER=true`，防止生产误用）。因此本次演练在隔离实例上显式开启；真实用户使用云厂商账号即可。

### 4. 第二批业务（进阶功能）

| 操作 | 结果 | 证据 |
| --- | --- | --- |
| 记录批量导入（`api A 5.6.7.8` / `mail A 9.9.9.9`） | PASS | `cendC-04/05` |
| 导出 Zone（触发下载 `zone.json`） | PASS | `cendC-04-export` |
| NS 监控新增 | PASS | `cendC-07/08` |
| 域名续期新增弹窗 | PASS | `cendC-09` |
| 安全页 2FA 入口（TOTP 可开启） | PASS | `cendC-10/11` |
| 系统管理 7 个 tab（overview/database/security/access/network/notifications/workflow） | 全部可达 | `cendC-03` |
| 新建普通成员 `cendmember` | PASS | `cendC-01/02` |

### 5. 普通成员视角（权限收口）

| 检查 | 结果 |
| --- | --- |
| 登录后进入 `/dash` | PASS |
| 侧边栏隐藏「用户 / 审计日志 / 自动化工作流 / 系统管理」 | PASS |
| 直接访问 `/dash/users` | 被重定向回 `/dash`，页面无「新建用户」 |
| 域名列表隔离 | 显示「共 0 个域名」（成员没有任何账户/域名） |
| 顶栏实时状态 | 「实时已连接」 |

证据：`ai-censorship/evidence/cendD-01..03.png`。

### 6. 工作流 Web 端到端（本轮新增验证）

| 步骤 | 结果 | 证据 |
| --- | --- | --- |
| 新建工作流（触发器「解析记录变更」+ 动作「列出解析记录」，域名 `example.test`） | PASS | `cendE-01/02` |
| 手动运行 | **success**，返回 trace `bc926f0e…` | `cendE-03/04` |
| 运行记录 | 可见（不再显示「还没有运行记录」） | `cendE-05` |

说明：工作流的**动作必须用可视化编辑器填写必填参数**（如「域名」）；只改高级 DSL 文本不会回填必填项，保存会被拦下——这属于预期，但首次使用者容易踩，建议在 DSL 文本框旁提示「必填参数请在可视化表单填写」。

### 7. 「先去创建账户」空态引导（本轮新增功能）

新增域名弹窗在**没有任何 DNS 账户**时不再只显示禁用的「请选择账户」，而是给出：
「还没有 DNS 账户 — HiDNS 的域名需要从 DNS 提供商账号同步过来…」+ 按钮「去创建 DNS 账户」。

实测（用无账户的二号管理员 `cendadmin2`）：弹窗显示引导 → 点击按钮跳转 `/dash/accounts`；按钮文案在 0 选时由「添加 个域名」改为「添加域名」。
证据：`cendF-empty-accounts.png`、`cendF-after-guide.png`。

## 二、发现但未修（建议下轮处理）

1. **域名新增入口依赖提供商账号**：没有 DNS 账户时，「新增域名」弹窗只能看到「请选择账户」，空态未引导「先去创建账户」。建议空态加一句带链接的引导。
2. **安装向导用户名规则**：不接受连字符（`cend-admin` 被拒），提示清楚但与常见习惯略违和；若产品上要允许，需同步改前后端。
3. **服务监控默认 tab 是 SSL 证书**：新建端点监控需要先切「端点探测」tab，脚本需要感知；可考虑把「新增监控」按当前 tab 预选类型（实现已如此，但默认 tab 是 SSL）。
4. **工作流 DSL 与必填项的联动**：只改 DSL 文本不会回填可视化必填项，建议在文本框旁加提示或保存时高亮缺失字段。
5. **虚拟提供商状态页**：账户配置项默认 `virtual_state=memory`（重启丢数据），演练/演示场景可能期望 file；建议账户弹窗给默认值提示。

## 三、门禁

- `server`：`tsc --noEmit` 0 错 / vitest **75 文件 606 条全绿** / eslint 0。
- `client`：`tsc -b` 0 错 / vitest **40 文件 158 条全绿** / eslint 0。


## 八、C 端细节轮（三位评审 + 执行层修复，提交 `fd8558`…`e5fa8a3`）

评审分工与结论（报告见各自文件「## C 端细节轮」）：

| 评审 | 范围 | 结论 |
| --- | --- | --- |
| e2e-walkthrough | 服务监控三子页 / NS 监控 / 域名续期 全流程 | P0=1、P1=4、P2=5 |
| adversarial-auditor | 边界输入 / 状态同步 / 静默失败 | P1=4、P2=2 |
| design-critic | 视觉、暗色、窄屏、文案一致性 | P1=2、P2=9 |

### 本轮修掉的

| 级别 | 问题 | 修复 |
| --- | --- | --- |
| P0 | 续期「添加域名」必然 400 Missing required fields | 服务端在 provider_type 缺省时按账号类型推导（老客户端也兼容） |
| P1 | 检测成功仍显示「未检测」 | `monitorStatus()` 补 ok/warning（后端口径），不再只认 healthy/degraded/down |
| P1 | NS 从未检测却显示「正常」 | last_check_at 为空一律显示「未检测」 |
| P1 | 合法 IPv6 被拒（`2001:DB8::1`） | 改用语法规校验（URL 解析 + 字符集），不再拿规范化结果做字符串相等 |
| P1 | 监控保存零校验（端口 70000 / 告警 -5 / 目标带 @ 均入库） | 前端 + 服务端双重校验：端口 1–65535、周期 30–86400、告警 1–365、路径 `/` 开头、目标禁 `@` |
| P1 | 表单缺字段（检查方式/端口/路径、期望状态码/响应体、启用开关） | 全部补齐并写入 config |
| P1 | 同账号多页签 WS 互踢 + 幽灵行 | 连接表改为按连接 key 存储（userId#seq），广播/心跳/断开全部多连接语义 |
| P1 | 断线重连后不刷新 | 重连成功时 `invalidateQueries()` 全量兜底 |
| P1 | 表格窄屏逐字竖排（1024/768） | TableHead/TableCell 加 `whitespace-nowrap` |
| P1 | 暗色卡片像「凹陷」（页面比卡片亮） | 控制台暗色蒙层 0.86→0.93；surface-page 暗色薄纱加深；实测页面 `rgb(10,15,26)` 暗于卡片 |
| P2 | 弹窗校验错误被遮罩挡住（NS/监控） | 改为弹窗内联错误提示 |
| P2 | 空态缺空格（还没有DNS/SSL） | 统一「还没有 X」 |

### 第二轮 P2 收尾（提交 `bd0948a8` / `5a9228b3`）

| 项 | 修复 |
| --- | --- |
| 文案量词/动词不统一 | 创建入口统一「新增 X」（账户/记录/令牌/团队/用户/工作流/密钥），计数统一「共 N 条」 |
| 空态无图标 | `TableEmpty` 默认 Inbox 图标 + 文案，三张表生效 |
| 服务监控缺搜索 | 补搜索框（名称/目标），后端 list 增加 keyword LIKE 过滤；实测过滤生效 |
| 工作流列表显示 record.changed / call | 用 meta 渲染中文触发器与动作名；实测无原始标识 |
| 工作流弹窗底部按钮需滚动 | 内容区滚动 + 底部操作栏常驻；实测保存按钮 y=797（视口 900 内） |
| 停用状态仍可点「续期」 | 按钮禁用 + 中文 title「自动续期已停用，请先开启」；实测 disabled=true |
| 错误中英混杂 | 新增 `humanizeError`（ENOTFOUND/ECONNREFUSED/timeout/Credential check failed 等），应用于监控/续期/团队 |
| 故障转移重复「目标」字段 | 目标改为所选域名的只读回填；实测选中 example.test 后自动填充 |
| 端点目标不校验 | 补空格/协议/URL 校验；保存期即拦截 |
| 团队名无限长 | 服务端 1–50 + 前端 maxLength + 中文报错 |
| 卡片内距不一致 | 监控/NS/续期改用 CardContent 默认内距（与工作流一致） |
| 目标含空格可入库 | 前后端统一拒绝（实测弹窗内提示「目标不能包含空格」） |

### 仍未处理（已登记，非阻塞）

- 检测 10–40s 期间只有按钮 spinner，没有进度百分比（值不值得做取决于是否接异步任务查询）。
- NS 的 `poisoned` 状态词条缺失（代码里没有该 label），当前无法构造污染数据验证。
- 背景图在数据极少的页面仍较显眼；已有「关闭背景图」开关，是否需要降低默认透明度可再定。

门禁：server 75 文件 606 条、client 41 文件 161 条全绿，eslint 0，build 通过。
