# HiDNS 端到端走查（全新实例 · 普通用户路径）

- 执行时间：2026-10-24（UTC+8 16:19–16:52）
- 实例：全新 SQLite 库（`/tmp/hidns-e2e-run5/hidns.db`），后端 `tsx src/app.ts` 端口 3001，前端 `vite` 端口 5274（vite `/api` 代理 → 3001）
- 浏览器：Playwright Chromium（1440×900，zh-CN），真实前端 + 真实后端，无 mock
- 虚拟提供商：`HIDNS_ENABLE_VIRTUAL_PROVIDER=1`（否则新建账户里根本没有 virtual 选项）
- 隔离措施：运行目录 `/tmp/hidns-e2e-run5`（避免 `server/data/.env` 覆盖 DB 路径、避免污染仓库 `data/`）；结束后我起的进程已全部 kill
- 证据：本轮截图见下方「截图清单」（带 `A-`/`B-`/`C-`/`D-` 前缀的 69 张）；同一目录下未带这些前缀的 `e2e-0X-*.png` 是本次走查早期草稿或被其他成员暂存的历史证据，请忽略
- **代码版本**：后端进程于 16:19 启动，跑的是当时工作树（HEAD `fdab7b3` 之前）。16:41 期间有队友提交 `fdab7b3 fix(virtual): 域名页新增的域名可自动建站点` 等改动，故本文 P2-3 描述的是**走查时**的行为；最新代码下 UI 新增的域名应已能自动建站点，但「用 API 直接创建的域名（如本轮 IDN）记录页仍报 400」这一路径未在最新代码上复验。

## 结论

1. **普通用户主路径基本能走通**：`/setup` 三步初始化 → `/login` → 仪表盘 → DNS 账户 → 域名 → 记录 → 三个监控子页 → API 令牌 → 团队 → 用户 → 设置 → 安全 → 系统管理 7 个 tab → 审计日志 → 工作流编辑器 → MCP → 关于，全程**没有白屏、没有 5xx、没有「加载中」卡死、没有表格列错位**。
2. **卡在「写记录」这一步**：新建记录选 **MX** 时必然失败，报英文错误 `Invalid hostname value`，弹窗不关闭；直连接口（value 不带优先级）却返回 200。这是本轮唯一的 **P0**，影响 MX/SRV/CAA 等所有带「附加字段」的记录类型（UI 无法新建，只能走 API）。
3. 另有 3 个"第一眼就不对"的问题：系统概览把**可用数据库**标成「不可达」；右上角实时连接徽标**永远停在「实时连接中」**（dev 代理未转发 WS 升级）；提供商名称/配置项在界面上**直接显示 i18n key**（`provider.aliyun`、`provider.config.virtual_enabled_on`）。
4. 正面结论也要记：**IDN 域名显示正常**（`中文测试.中国`，无乱码、无 punycode 泄漏到域名列表与记录页标题）；空态文案基本合理；2FA 二维码可正常渲染；令牌创建/复制/停用、批量导入、主题切换、昵称保存均可用；普通用户侧的权限按钮隐藏正确（新建账户/新增域名/新建记录/批量导入全部隐藏，直连受限路由静默跳回仪表盘）。

级别口径：P0 阻断核心功能；P1 明显错误或误导、有绕行方案；P2 体验/文案/一致性；P3 细节。

## 步骤表

> 「错误」列只记该步骤期间新增的 console error / 4xx/5xx；— 表示干净。

| # | 步骤 | 结果 | 证据截图 | 错误 |
|---|---|---|---|---|
| A1 | 打开 `/setup` | 向导正常（三步导航 + 数据库配置卡） | `e2e-A-01-A1_打开setup.png` | — |
| A2 | 测试连接 | 连接成功，但提示**「检测到已有数据」**并出现「重置并初始化」红色危险入口（全新库！） | `e2e-A-02-A2_测试连接.png` | — |
| A3 | 下一步（初始化 DB） | 进入管理员步骤；提示文案为英文 `Database already initialized. Proceed to create admin user.` | `e2e-A-03-A3_初始化数据库.png` | — |
| A4 | 创建管理员 | 「安装完成」页出现，`数据库：sqlite` | `e2e-A-04-A4_创建管理员.png` | — |
| A5 | 登录 | 落地 `/dash` | `e2e-A-05-A5_登录.png` | — |
| A6 | 仪表盘 | 概览/提供商分布/最近操作渲染正确；**实时徽标=「实时连接中」**（未变成已连接） | `e2e-A-06-A6_仪表盘与实时连接.png` | — |
| B1 | DNS 账户空态 | `共 0 个账户` + 「还没有 DNS 账户」 | `e2e-A-07-B1_账户空态.png` | — |
| B2 | 新建虚拟账户 | 创建成功（`共 1 个账户`）；**提供商下拉/表格列显示 `provider.aliyun…provider.virtual` 原始 key**，配置项显示 `provider.config.virtual_enabled_on` | `e2e-A-08-B2_新建虚拟账户.png` | — |
| C1 | 域名空态 | `共 0 个域名`；空态文案「还没有添加域名」（与账户页措辞不统一，非缺陷） | `e2e-A-09-C1_域名空态.png` | — |
| C2 | 新增域名弹窗 | 选账户后从提供商拉到 `example.test`，可勾选 | `e2e-A-10-C2_新增域名弹窗.png` | — |
| C3 | 提交新增 | 「已添加 1 个」，列表出现 `example.test` | `e2e-A-11-C3_提交新增.png` | — |
| C4 | 重复新增同一域名 | 弹窗内红色提示 `Domain already exists: example.test`（英文），与描述「已存在的会被跳过」矛盾 | `e2e-A-12-C4_重复新增同一域名.png` | 400 POST /api/domains |
| C5 | 补 IDN 域名（接口） | `中文测试.中国`、`普通站点.test` 均 200（前端无手工输入域名入口，只能用与前端同源的 POST /api/domains） | `e2e-A-13-C5_API补IDN域名.png` | — |
| C6 | 域名列表 | `共 3 个域名`；**IDN 显示 Unicode 正常**（`中文测试.中国`）；表头 6 列 / 首行 6 列对齐；记录数列为 0（未同步） | `e2e-A-14-C6_域名列表与IDN显示.png` | — |
| C7 | 域名分组 | 默认已开启分组（按钮「已分组」/`aria-pressed=true`、分组方式=总是分组），但 3 个顶点域名**没有任何组头行**，视觉上与未分组完全一致；补一个 `www.example.test` 后出现组头「example.test 2 个子域」 | `e2e-A-15-C7_域名分组.png` | — |
| B-D0 | IDN 域名记录页 | 标题正确显示 `中文测试.中国`，但表体报 `虚拟站点不存在: xn--fiq228copfr97a.xn--fiqs8s`，同时仍显示「共 0 条记录」+「新建记录/批量导入」入口 | `e2e-B-01-D0_IDN域名记录页_空_异常_.png` | 400 GET /api/domains/2/records（×2） |
| B-D1 | 记录页（example.test） | `共 3 条记录`，表头 7 列 / 首行 7 列对齐 | `e2e-B-02-D1_进入记录页_example_test_.png` | — |
| B-D2 | 新增 A 记录 | 成功（列表 4 条） | `e2e-B-03-D2_新增A记录.png` | — |
| B-D3 | 新增 TXT 记录 | 成功（列表 5 条） | `e2e-B-04-D3_新增TXT记录.png` | — |
| B-D4 | 新增 MX 记录 | **失败**：弹出英文 `Invalid hostname value`，弹窗不关，记录未写入 | `e2e-B-05-D4_新增MX记录.png`、`e2e-B-05b-MX错误弹窗.png` | 纯前端校验，无网络请求 |
| B-D4b | MX 接口对照 | `value=mail.example.test` + `mx=10` → **200**；`value="10 mail.example.test"` → **400 Invalid hostname value** | `e2e-B-06-D4b_MX接口对照.png` | 400 POST /api/domains/1/records（对照用） |
| B-D5 | 记录列表 | `共 6 条记录`（含接口建的 `mx-raw`） | `e2e-B-07-D5_记录列表.png` | — |
| B-D6 | 编辑 A 记录 | 值 198.51.100.7 → 198.51.100.8，列表即时更新 | `e2e-B-08-D6_编辑记录.png` | — |
| B-D7 | 启停记录 | TXT 记录 已启用 → 已停用，行内按钮变「启用」 | `e2e-B-09-D7_启停记录.png` | — |
| B-D8 | 批量导入 | 3 行预览正确（含引号内空格），提交后「全部导入成功（3 条）」 | `e2e-B-10-D8_批量导入.png` | — |
| B-D9 | 记录终态 | `共 9 条记录`，MX 行（API 建的）显示正常 | `e2e-B-11-D9_记录终态.png` | — |
| B-E1 | 服务监控 | 空态「还没有 SSL 证书监控」，三个按钮（SSL/端点/DNS 故障转移）正常 | `e2e-B-12-E1_服务监控.png` | — |
| B-E2 | NS 监控 | 空态「还没有 NS 监控，点击「新增监控」开始」 | `e2e-B-13-E2_NS监控.png` | — |
| B-E3 | 域名续期 | 空态「还没有可续期域名，点击「添加域名」从提供商导入」 | `e2e-B-14-E3_域名续期.png` | — |
| B-F1 | 令牌页 | 空态「还没有 API 令牌」 | `e2e-B-15-F1_令牌页.png` | — |
| C-F1 | 令牌页（复跑） | 同上 | `e2e-C-01-F1_令牌页空态.png` | — |
| C-F2 | 新建令牌 | 未勾选域名时提示「至少选择一个域名」；勾「全选当前」后创建成功，明文令牌仅展示一次 | `e2e-C-02-F2_新建令牌_选域名_.png` | — |
| C-F3 | 复制令牌 | 剪贴板得到完整 `hidns_…`，提示「已复制」 | `e2e-C-03-F3_复制令牌.png` | — |
| C-F4 | 关闭并禁用 | 行按钮「停用」→ 状态「已停用」+「启用」按钮 | `e2e-C-04-F4_关闭并禁用令牌.png` | — |
| C-G1 | 团队 | 「新建团队」+ 左列表空态「还没有团队 / 选择左侧团队查看详情」 | `e2e-C-05-G1_团队页.png` | — |
| C-H1 | 用户 | `共 1 个用户`，行内「停用/二次验证/编辑/删除」 | `e2e-C-06-H1_用户页.png` | — |
| C-H2 | 新建用户 | 角色选项「普通用户/管理员」；此次误选管理员（脚本选择器取末项），D-H3 用正确角色复验 | `e2e-C-07-H2_新建普通用户.png` | — |
| C-I1 | 设置 | 个人资料/密码/偏好/账号绑定四张卡 | `e2e-C-08-I1_设置页.png` | — |
| C-I2 | 改昵称（首轮） | 脚本按「保存」找按钮失败（实际按钮文案为「保存资料」） | `e2e-C-09-I2_改昵称.png` | — |
| C-I3 | 主题改深色 | `html class=dark`，立即生效 | `e2e-C-10-I3_改主题为深色.png` | — |
| C-I4 | 背景 | 提交 `none`，提示「偏好已保存」 | `e2e-C-11-I4_改背景.png` | — |
| C-J1 | 安全 | 2FA「未启用」+ 可信设备 + Passkey + 安全策略 | `e2e-C-12-J1_安全页与2FA入口.png` | — |
| C-J2 | 打开 2FA 启用弹窗 | 二维码 naturalWidth=212 正常渲染，手动密钥 + 8 组恢复码正常；取消后无副作用 | `e2e-C-13-J2_打开2FA启用弹窗.png`、`e2e-J2-2fa-dialog.png` | — |
| C-K1 | 系统管理·概述 | **「数据库连接 不可达」（红色）**，而 /api/system/version 返回 `dbConnected:true`；「已运行 —」「Node —」「时区 UTC」 | `e2e-C-14-K1_系统概览.png` | — |
| C-K2 | 数据库 | sqlite / 3.51.3 / node:sqlite 正常 | `e2e-C-15-K2_数据库.png` | — |
| C-K3 | 安全（登录限制/SMTP） | 表单与统计正常（totalLocked 0） | `e2e-C-16-K3_安全策略.png` | — |
| C-K4 | 访问控制 | JWT 密钥「查看」、OIDC 配置项齐全 | `e2e-C-17-K4_访问控制.png` | — |
| C-K5 | 网络 | 「开始测试 尚未测试」、代理配置齐全 | `e2e-C-18-K5_网络.png` | — |
| C-K6 | 通知 | 「新增渠道」+ 空态「还没有通知渠道」 | `e2e-C-19-K6_通知.png` | — |
| C-K7 | 工作流（出站白名单） | 「当前为空：出站请求会被全部拒绝」+ 添加/保存 | `e2e-C-20-K7_工作流配置.png` | — |
| C-L1 | 审计日志 | `共 13 条`，首行 update_preferences…theme: dark，时间列「8 小时前」 | `e2e-C-21-L1_审计日志.png` | — |
| C-M1 | 工作流 | 空态「还没有工作流」+ 白名单说明 | `e2e-C-22-M1_工作流页.png` | — |
| C-M2 | 工作流编辑器 | 打开正常（触发器=解析记录变更、条件可视化/JSON/DSL 三视图）；默认动作显示「未选择动作类型」「这个动作不在当前后端声明里」警告 | `e2e-C-23-M2_打开工作流编辑器.png`、`e2e-M2-workflow-editor.png` | — |
| C-N1 | MCP | 全局开关 + 密钥/OAuth 两个 tab + 空态 | `e2e-C-24-N1_MCP页.png` | — |
| C-O1 | 关于 | v2.2.0、部署模式 dev、最新版本 v2.2.0（2026/10/22）、文档/反馈/Telegram 链接 | `e2e-C-25-O1_关于页.png` | — |
| D-P1 | 实时连接 20s 采样 | 5/10/15/20 秒均为「实时连接中」；Playwright 记录 `ws://…/api/socket/ws` 反复 open 后 `WebSocket is closed before the connection is established`，后端日志**没有**任何 `New WebSocket connection attempt` | `e2e-D-01-P1_实时连接20秒观察.png` | WS 握手失败 |
| D-I2b | 改昵称（正确按钮） | 填「E2E 管理员」→「个人资料已保存」，侧栏昵称即时变化 | `e2e-D-02-I2b_改昵称_保存资料_.png` | — |
| D-H3 | 新建普通用户（角色=普通用户） | 行显示「普通用户」，角色正确 | `e2e-D-03-H3_新建普通用户_正确角色_.png` | — |
| D-Q1 | 普通用户登录 | 侧栏只剩 概览/资源/协作(团队)/API 令牌/系统(设置,安全)/MCP/关于；仪表盘管理员区块显示「仅管理员可见」 | `e2e-D-Q1_普通用户登录.png` | 403 GET /api/users、403 GET /api/logs |
| D-Q2 | 普通用户·账户页 | 「新建账户」隐藏；「刷新」可用；空态正常 | `e2e-D-Q2_普通用户_账户页按钮.png` | — |
| D-Q3 | 普通用户·域名页 | 「新增域名」隐藏；空态「还没有添加域名」 | `e2e-D-Q3_普通用户_域名页与分组.png` | — |
| D-Q4 | 普通用户·记录页 | 「新建记录」「批量导入」均隐藏，无「只读」徽标；页面显示英文 `Domain not found` | `e2e-D-Q4_普通用户_记录页只读.png` | 400 GET /api/domains/1；404 …/records、…/lines、…/record-types |
| D-Q5 | 普通用户·受限路由 | /dash/users、/dash/audit、/dash/workflows、/dash/system 直连 → 静默跳回 /dash，**没有任何提示**；/dash/tokens、/dash/teams 可访问；/dash/mcp 显示无权限说明 | `e2e-D-Q5_普通用户_受限页面.png` | 多次 403 GET /api/users、403 GET /api/logs |

## 缺陷

### P0-1　UI 无法新建 MX 记录（所有带附加字段的记录类型都受影响）

- 页面：`/dash/domains/:id/records` → 新建记录
- 复现：类型选 **MX** → 优先级填 `10` → 记录值填 `mail.example.test` → 点「创建」
- 实际：弹窗红色英文错误 `Invalid hostname value`，记录未创建，弹窗不关闭（截图 `e2e-B-05b-MX错误弹窗.png`）
- 期望：创建成功（后端 POST /records 传 `value:"mail.example.test", mx:10` 返回 200）
- 根因：`client/src/features/records/record-dialog.tsx` 的 `composeValue()` 把附加字段拼进 value（变成 `"10 mail.example.test"`），随后 `validateRecordValue()` 按 hostname 规则校验整串 → 必然失败；服务端 `server/src/lib/dns/record-types.ts:205` 也用 hostname 规则校验，形成"双保险"式的必然拒绝。对照实验：`value=mail.example.test` 200 / `value="10 mail.example.test"` 400。
- 影响面：MX（优先级）、SRV（优先级/权重/端口）、CAA（flags/tag）、NAPTR 等所有 `extraFields` 非空的类型，UI 全部写不进去。

### P1-1　系统概览把可用数据库显示为「不可达」

- 页面：系统管理 → 概述
- 复现：以管理员进入 `/dash/system`
- 实际：运行状态卡片「数据库连接 **不可达**」（红色徽标），「已运行 —」「Node —」；同一时刻 /api/system/version 返回 `{"nodeStatus":{"status":"running","uptime":815,"dbConnected":true}}`，数据库 tab 也正常显示 sqlite 3.51.3
- 期望：「已连接」+ 已运行时长 + Node 版本
- 根因：前端 `src/features/system/system-page.tsx:84-105` 读 `data.dbConnected / data.uptime / data.node`，后端实际放在 `data.nodeStatus.*` 且没有 `node` 字段（截图 `e2e-C-14-K1_系统概览.png`）。

### P1-2　实时连接徽标永远停在「实时连接中」，实时推送在 dev 下完全不可用

- 页面：全局右上角状态点（app-shell）
- 复现：任一登录页停留 20 秒以上
- 实际：一直「实时连接中」；Playwright 捕获 WS 反复握手失败（`WebSocket is closed before the connection is established`），后端 Websocket 日志只有初始化一条，**没有** `New WebSocket connection attempt`；用 node ws 带 cookie 直连 `ws://127.0.0.1:3001/api/socket/ws` 可立即 open
- 期望：「实时已连接」，事件可推送
- 根因：`client/vite.config.ts` 只给 `/ws` 配了 `ws: true`，而前端（`src/app/realtime.tsx`）连的是 `/api/socket/ws`，落入未开启 WS 升级的 `/api` 代理；任何"只转发 /api HTTP"的反向代理部署同样中招。用户侧完全静默（只有灰黄点，无错误提示）。

### P1-3　提供商名称/配置项在界面上直接显示 i18n key

- 页面：DNS 账户 → 新建账户（提供商下拉、配置项标签）、账户表格「提供商」列
- 实际：`provider.aliyun`、`provider.dnspod`、`provider.virtual`、`provider.config.virtual_enabled_on`
- 期望：阿里云、DNSPod、虚拟、启用/关闭
- 根因：后端 registry 返回 `name: 'provider.virtual'`，前端 `client/src/copy/zh-CN.ts` 没有 `provider.*` 词条，也没有回退翻译（截图 `e2e-A-08-B2_新建虚拟账户.png`）。

### P1-4　全新实例首次「测试连接」就提示「检测到已有数据」

- 页面：`/setup` 第一步
- 复现：空目录 + 全新 DB 文件启动 → /setup → 测试连接
- 实际：`连接成功，检测到已有数据` + 「检测到已有数据」徽标 + 「重置并初始化（会删除既有账号与域名记录）」按钮；数据库里其实只有启动时 DSM 自动建的 schema
- 期望：全新实例只说「连接成功」；只有真的存在用户/域名时才提示已有数据
- 影响：首装用户极易误点「重置并初始化」，或误以为装错环境（截图 `e2e-A-02-A2_测试连接.png`）。

### P2-1　错误文案英文泄漏（中文界面）

- 出现位置：`Database already initialized. Proceed to create admin user.`（安装向导）、`Domain already exists: example.test`（重复添加域名）、`Invalid hostname value`（MX）、`Domain not found`（普通用户记录页）；接口 msg 会被原样展示。
- 期望：服务端统一中文，或前端按错误码映射文案。

### P2-2　重复添加域名返回 400 错误，而不是「跳过 N 个」

- 页面：域名 → 新增域名
- 实际：红色 `Domain already exists: example.test`，弹窗里仍保留上一次的「已添加 1 个」成功提示，两行信息互相矛盾
- 期望：`已添加 0 个，跳过 1 个（已存在）`（后端 POST /domains 已有 `duplicates` 分支，但 `added===0` 时直接 `sendError`）
- 证据：`e2e-A-12-C4_重复新增同一域名.png`，400 POST /api/domains

### P2-3　"提供商侧不存在"的域名，记录页半死不活

- 页面：`/dash/domains/2/records`（`中文测试.中国`，用 API 直接建的）
- 实际：表体 `虚拟站点不存在: xn--…` + 重试，同时标题仍是「共 0 条记录」，「新建记录 / 批量导入」入口仍在（点进去提交才报同样的错）
- 期望：明确错误态（禁止写入 + 引导"同步/删除该域名"），不要伪装成空列表
- 证据：`e2e-B-01-D0_IDN域名记录页_空_异常_.png`

### P2-4　普通用户点开无权域名的记录页：400 + 英文 Domain not found

- 复现：普通用户访问 `/dash/domains/1/records`
- 实际：`400 GET /api/domains/1`，随后 records/lines/record-types 三个 404，页面显示英文 `Domain not found` + 重试，也没有「只读/无权限」说明
- 期望：403/404 语义一致 + 中文「无权访问该域名或域名不存在」

### P2-5　普通用户仪表盘直接打管理员接口（403 控制台噪音）

- 实际：普通用户进入 `/dash` 即 `403 GET /api/users`、`403 GET /api/logs?page=1&pageSize=50`（React StrictMode 下双发），页面用「仅管理员可见 / 仅管理员可查看操作日志」兜底
- 期望：前端按角色跳过请求（`enabled` 门控），避免每条普通用户会话都产生 4xx 与控制台红字

### P2-6　IDN 在令牌「可访问域名」里回退成 punycode

- 页面：API 令牌 → 新建令牌 → 可访问域名
- 实际：域名列表里是 `中文测试.中国`，令牌弹窗里变成 `xn--fiq228copfr97a.xn--fiqs8s`
- 期望：与域名页一致显示 Unicode（后端已提供 `display_name`），或两者同时给出
- 证据：`e2e-C-02-F2_新建令牌_选域名_.png`

### P2-7　分组状态与视觉不一致，组头计数口径含糊

- 页面：域名 → 分组
- 实际：默认按钮「已分组」/`aria-pressed=true`，但只有顶点域名时列表与未分组完全相同（无组头、无缩进）；补 `www.example.test` 后出现组头「example.test **2 个子域**」，其中包含父域本身（实际只有 1 个子域）
- 期望：无分组内容时提示「当前没有可分组域名」；组头徽标区分「父域 + N 个子域」或只计子域
- 证据：`e2e-A-15-C7_域名分组.png`

### P3-1　工作流编辑器默认动作即报"未选择动作类型 / 不在后端声明里"

- 打开「新建工作流」后，动作区第 1 项显示「未选择动作类型」+ 橙色说明「这个动作不在当前后端声明里，参数请到高级 DSL 里填」，与"新建"语义不符（应为空动作占位）。证据 `e2e-M2-workflow-editor.png`

### P3-2　域名列表「记录数」初始为 0

- `example.test` 提供商侧有 3 条记录、记录页能看到 3 条，但域名列表显示 `0` 直到后台 recordCountCache 刷新；无「同步中」提示。证据 `e2e-A-14-C6_域名列表与IDN显示.png`

### P3-3　系统概览文案与运行模式不符

- 「版本信息」卡描述写「前后端同源构建」，但本次是 dev（vite 5274 + 后端 3001 分离）；「时区 UTC」而审计日志按本地时间显示「8 小时前」

### P3-4　受限路由静默跳转

- 普通用户直连 /dash/users、/dash/audit、/dash/workflows、/dash/system 会直接跳回 /dash，无 toast/提示，用户会以为"点了没反应"

## 截图清单

全部位于 `ai-censorship/evidence/`（69 张，其中 3 张为 MX/2FA/工作流编辑器专项特写，其余按流程编号；`A-` 初始化/账户/域名，`B-` 记录/监控/令牌，`C-` 令牌至关于，`D-` 实时与普通用户视角）：

| 文件名 | 说明 |
|---|---|
| `e2e-A-01-A1_打开setup.png` | 安装向导第一步 |
| `e2e-A-02-A2_测试连接.png` | 全新库却提示「检测到已有数据」 |
| `e2e-A-03-A3_初始化数据库.png` | 管理员步骤（英文提示泄漏） |
| `e2e-A-04-A4_创建管理员.png` | 安装完成页 |
| `e2e-A-05-A5_登录.png` | 登录后落地 /dash |
| `e2e-A-06-A6_仪表盘与实时连接.png` | 仪表盘 + 「实时连接中」 |
| `e2e-A-07-B1_账户空态.png` | 账户空态 |
| `e2e-A-08-B2_新建虚拟账户.png` | 提供商下拉/表格显示 i18n key |
| `e2e-A-09-C1_域名空态.png` | 域名空态 |
| `e2e-A-10-C2_新增域名弹窗.png` | 从提供商拉取域名 |
| `e2e-A-11-C3_提交新增.png` | 已添加 1 个 |
| `e2e-A-12-C4_重复新增同一域名.png` | 重复添加报 400 英文错误 |
| `e2e-A-13-C5_API补IDN域名.png` | 接口补 IDN 域名 |
| `e2e-A-14-C6_域名列表与IDN显示.png` | IDN 正常显示 Unicode |
| `e2e-A-15-C7_域名分组.png` | 分组开关（无组头） |
| `e2e-B-01-D0_IDN域名记录页_空_异常_.png` | 虚拟站点不存在 400 |
| `e2e-B-02-D1_进入记录页_example_test_.png` | 记录页初始 3 条 |
| `e2e-B-03-D2_新增A记录.png` | 新增 A |
| `e2e-B-04-D3_新增TXT记录.png` | 新增 TXT |
| `e2e-B-05-D4_新增MX记录.png` | MX 提交失败后的列表 |
| `e2e-B-05b-MX错误弹窗.png` | **MX 必然失败的直接证据** |
| `e2e-B-06-D4b_MX接口对照.png` | 接口对照（raw 200 / composed 400） |
| `e2e-B-07-D5_记录列表.png` | 6 条记录 |
| `e2e-B-08-D6_编辑记录.png` | 编辑生效 |
| `e2e-B-09-D7_启停记录.png` | 停用后徽标变化 |
| `e2e-B-10-D8_批量导入.png` | 批量导入成功 3 条 |
| `e2e-B-11-D9_记录终态.png` | 9 条记录 |
| `e2e-B-12-E1_服务监控.png` | 服务监控空态 |
| `e2e-B-13-E2_NS监控.png` | NS 监控空态 |
| `e2e-B-14-E3_域名续期.png` | 续期空态 |
| `e2e-B-15-F1_令牌页.png` | 令牌空态 |
| `e2e-B-16-F2_新建令牌.png` | 令牌弹窗（未选域名） |
| `e2e-B-17-F3_复制令牌.png` | 未创建成功时的复制步骤 |
| `e2e-B-18-F4_关闭并禁用令牌.png` | 令牌列表空态 |
| `e2e-C-01-F1_令牌页空态.png` | 令牌空态 |
| `e2e-C-02-F2_新建令牌_选域名_.png` | 令牌创建 + IDN punycode |
| `e2e-C-03-F3_复制令牌.png` | 复制到剪贴板 |
| `e2e-C-04-F4_关闭并禁用令牌.png` | 停用令牌 |
| `e2e-C-05-G1_团队页.png` | 团队空态 |
| `e2e-C-06-H1_用户页.png` | 用户列表 |
| `e2e-C-07-H2_新建普通用户.png` | 角色误选管理员（脚本问题） |
| `e2e-C-08-I1_设置页.png` | 设置四卡 |
| `e2e-C-09-I2_改昵称.png` | 首轮按钮定位失败 |
| `e2e-C-10-I3_改主题为深色.png` | 主题切换生效 |
| `e2e-C-11-I4_改背景.png` | 偏好已保存 |
| `e2e-C-12-J1_安全页与2FA入口.png` | 安全页 |
| `e2e-C-13-J2_打开2FA启用弹窗.png` | 2FA 二维码 |
| `e2e-J2-2fa-dialog.png` | 2FA 弹窗特写 |
| `e2e-C-14-K1_系统概览.png` | **数据库「不可达」/已运行 —** |
| `e2e-C-15-K2_数据库.png` | 数据库信息正常 |
| `e2e-C-16-K3_安全策略.png` | 登录限制/SMTP |
| `e2e-C-17-K4_访问控制.png` | JWT/OIDC |
| `e2e-C-18-K5_网络.png` | 连通性/代理 |
| `e2e-C-19-K6_通知.png` | 通知渠道空态 |
| `e2e-C-20-K7_工作流配置.png` | 出站白名单 |
| `e2e-C-21-L1_审计日志.png` | 13 条日志 |
| `e2e-C-22-M1_工作流页.png` | 工作流空态 |
| `e2e-C-23-M2_打开工作流编辑器.png` | 编辑器打开 |
| `e2e-M2-workflow-editor.png` | 编辑器特写 |
| `e2e-C-24-N1_MCP页.png` | MCP |
| `e2e-C-25-O1_关于页.png` | 关于 |
| `e2e-D-01-P1_实时连接20秒观察.png` | 实时连接 20s 采样 |
| `e2e-D-02-I2b_改昵称_保存资料_.png` | 昵称保存成功 |
| `e2e-D-03-H3_新建普通用户_正确角色_.png` | 普通用户创建成功 |
| `e2e-D-Q1_普通用户登录.png` | 普通用户侧栏 |
| `e2e-D-Q2_普通用户_账户页按钮.png` | 新建账户已隐藏 |
| `e2e-D-Q3_普通用户_域名页与分组.png` | 新增域名已隐藏 |
| `e2e-D-Q4_普通用户_记录页只读.png` | 写入入口隐藏 + Domain not found |
| `e2e-D-Q5_普通用户_受限页面.png` | 受限路由跳回仪表盘 |

## 复现脚本与限制

- 脚本：`/tmp/e2e/harness.mjs`、`wt1.mjs`（初始化/登录/账户/域名）、`wt2.mjs`（记录/监控）、`wt3.mjs`（令牌→关于）、`wt4.mjs`（实时采样 + 普通用户视角）、`mx-evidence.mjs`（MX 专项）；原始结果 `/tmp/e2e/wt-part{1..5}.json`。均为 /tmp 临时产物，未写入仓库。
- 本次**未覆盖**（受沙箱限制，不代表无缺陷）：真实第三方 DNS 提供商（仅 virtual 演示 provider，因此到期列全为 —、续期页永远空态）、SMTP/邮件实际投递、SSO/Logto 登录、通行密钥注册（需真实认证器）、2FA 完整绑定（需 TOTP 校验）、工作流实际执行与出站白名单抓包、MCP 客户端真实连接。
- 环境提示（对运维是真实的坑）：`server/src/config/env.ts` 以 `override: true` 加载 `data/.env`，所以"换 DB 只改 `DB_PATH`"无效，必须换运行目录；`.initialized` 标记写在数据库同目录，若同目录残留旧标记而 DB 是新的，`/api/init/*` 会全部 403（本次走查就被这一组合挡过一次，换干净目录后才通过）。建议部署文档写明"换库请同时删除 .initialized"。


## 修复状态（执行层回填，2026-10-23，提交 `b454522` / `fdab7b3`）

| 编号 | 状态 | 说明 |
| --- | --- | --- |
| P0-1 MX 无法新建 | ✅ 已修 | `composeValue` 只把无独立字段的 extras 拼进 value；`mx` 走独立字段。抽出 `composeRecordValue()` 并加 4 条用例（MX / SRV / 无 extras） |
| P1 系统概览字段错位 | ✅ 已修 | 前端改读 `data.nodeStatus.{dbConnected,uptime}`；后端补 `nodeVersion`，页面显示 Node 版本 |
| P1 实时徽标停在「连接中」 | ✅ 已修（dev 环境） | `vite.config.ts` 增加 `/api/socket` 的 `ws: true` 代理（前端连的是 `/api/socket/ws`，不是 `/ws`）。生产同源部署不受影响 |
| P1 提供商/配置项显示 i18n key | ✅ 已修 | 新增 `features/accounts/provider-labels.ts`（26 个提供商 + 常见配置项），账号列表与弹窗改用映射，未知 key 回退去前缀 |
| P1 全新库提示「检测到已有数据」 | ✅ 已修 | 历史标记只在「旧版布局」（`<cwd>/data` 下存在 sqlite 库文件）时才被采信，避免开发机残留标记污染新库 |
| P1 IDN 记录页「虚拟站点不存在」 | ✅ 已修（`fdab7b3`） | 虚拟提供商在 id/name 都查不到时按域名自动建站点（仅 dev/test 提供商；真实提供商由上游决定站点） |
| P2 重复新增域名报英文 400 | ⏳ 未修 | 建议改为「已存在则跳过并在结果里标注」，与弹窗文案一致 |
| P2 C7 全顶域时「已分组」无组头 | ⏳ 未修 | 语义正确（无可注册域子域时本就没有组），但按钮态可改为「无可分组」提示 |
| P2 其余（文案统一、计数刷新、监控页细节） | ⏳ 未修 | 见报告正文 |

门禁：`server` 69 文件 / 588 条、`client` 39 文件 / 156 条，均全绿。

## 第五轮（HEAD 6732b3c · 修复后复验）

- 时间：2026-10-24 20:00–20:20；实例：全新 SQLite 库（`/tmp/hidns-r5/hidns.db`），后端 3001 + vite 5274，虚拟提供商开启
- 方式：与第四轮同一套 Playwright harness（`E2E_PART=r5`），管理员路径 45 步 + 普通用户路径 5 步，真实前后端
- 截图：`ai-censorship/evidence/e2e-r5-*.png`（51 张）；原始结果 `/tmp/e2e/r5-admin.json`、`/tmp/e2e/r5-plain.json`

### 结论

1. **能全程走通**（初始化→账户→域名→记录→监控→令牌→团队→用户→设置→安全→系统 7 tab→审计→工作流→MCP→关于→普通用户视角），无白屏、无 5xx、无「加载中」卡死。
2. 唯一**功能卡点**：**SRV 记录仍无法新建**（同第四轮 P0 的同一根因残留：`composeRecordValue` 只把 `mx` 视为独立字段）。MX 已修复，A/TXT/MX/SRV 中 SRV 失败。
3. 计数：**P0 = 0，P1 = 2，P2 = 2，P3 = 4**。
4. 第四轮主要问题已修并本轮实证：系统概览（已连接 / 已运行 5 分钟 / Node v22.23.3）、提供商名称中文化、MX 可写、备注 200/201 限长（201 被中文提示拦截）、分组两种模式与展开收起、只读徽标、普通用户隐藏写入口。

### 修复验证（第四轮 → 第五轮）

| 第四轮问题 | 本轮实测 | 结论 |
|---|---|---|
| 系统概览「数据库连接 不可达」、已运行/Node 为 — | 已连接 / 已运行 5 分钟 / Node v22.23.3（`e2e-r5-35-system_overview.png`） | 已修 |
| 提供商显示 `provider.aliyun` | 下拉为 阿里云/腾讯云 DNSPod/华为云/百度云/火山引擎/京东云/Cloudflare/DNS.LA/西部数码/青云；域名表格无 `provider.` 字样 | 已修（名称）/ 配置项未译（见 P2-1） |
| 全新实例误报「检测到已有数据」 | 仍出现（`e2e-r5-02-setup_test_conn.png`） | **未修** |
| MX 记录无法新建 | extra=1、无错误、弹窗关闭、列表出现（`e2e-r5-19-record_MX.png`） | 已修 |
| SRV 记录（第四轮同类） | extra=3、仍报 `Invalid hostname value`、弹窗不关（`e2e-r5-20-record_SRV.png`） | **未修** |
| 备注 200/201 | 200 字保存成功无提示；201 字被拦「备注最多 200 个字符」（`e2e-r5-12/13`） | 已修 |
| 分组无组头 / 无模式切换 | 默认「已分组」，组头「example.test 2 个子域」，模式可选 总是分组/仅父域存在，展开 2→4 行、收起 4→2 行（`e2e-r5-14/15`） | 已修 |
| 实时徽标停在「实时连接中」 | 变为「实时连接中 → 实时已断开」，仍未出现「已连接」 | 部分（见 P1-1） |
| 普通用户隐藏写入口 / 只读徽标 | 新建账户、新增域名、新建记录、批量导入全部隐藏；域名行与记录页均显示「只读」徽标（`e2e-r5-03/04`） | 已修/已验 |

### 步骤表（第五轮）

| 步骤 | 结果 | 截图 |
|---|---|---|
| /setup 三步 → 测试连接 | 连接成功，**仍提示「检测到已有数据」+重置按钮** | `e2e-r5-01/02-setup_open/test_conn.png` |
| 初始化 DB → 创建管理员 | 成功；提示文案已中文化（不再出现 `Database already initialized`） | `e2e-r5-03/04` |
| 登录 → 仪表盘（实时采样 3×4s） | 落地 /dash；实时状态 连接中→已断开→已断开 | `e2e-r5-05/06` |
| DNS 账户 空态 → 新建虚拟账户 | 共 1 个账户；提供商中文；配置项仍 `provider.config.virtual_enabled_on/off` | `e2e-r5-07/08` |
| 域名 新增（从提供商） | 已添加 1 个 example.test | `e2e-r5-09` |
| IDN + 子域（接口补） | 中文测试.中国 / www.example.test 均 200 | `e2e-r5-10` |
| 域名列表 | 共 2 个域名（分组态）；IDN 显示 Unicode；提供商列中文；表头 6 列对齐 | `e2e-r5-11` |
| 备注 200 字 | 保存成功，列表展示长备注 | `e2e-r5-12` |
| 备注 201 字 | 被拦「备注最多 200 个字符」（400 PUT，中文文案） | `e2e-r5-13` |
| 分组模式 / 展开收起 | 两种模式可选；组头 + aria-expanded 联动正常 | `e2e-r5-14/15` |
| 记录页 | 共 3 条记录，表头 7 列 / 首行 7 列 | `e2e-r5-16` |
| 新增 A / TXT / MX | 全部成功 | `e2e-r5-17/18/19` |
| 新增 SRV | **失败**：`Invalid hostname value`，弹窗不关 | `e2e-r5-20` |
| 记录列表 / 编辑 / 启停 | 6 条记录；e2e-a → 198.51.100.9；TXT 已停用 | `e2e-r5-21/22/23` |
| 批量导入 3 行 | 预览 3 行有效，全部导入成功 | `e2e-r5-24` |
| 服务监控 / NS 监控 / 域名续期 | 三页空态文案正常，无「加载中」卡死 | `e2e-r5-25/26/27` |
| API 令牌 新建/复制/停用 | 明文仅展示一次；剪贴板拿到 `hidns_…`；停用成功 | `e2e-r5-28/29` |
| 团队 | 新建团队成功（创建者自动为成员）；前端「添加成员→添加授权」脚本未能走通，改用 API 验证成员/只读授权均 200 | `e2e-r5-30/31` |
| 用户 | 新建 e2eplain（普通用户），列表角色正确 | `e2e-r5-32` |
| 设置 昵称/主题/背景 | 「个人资料已保存」；html class=dark；「偏好已保存」 | `e2e-r5-33` |
| 安全 2FA 入口 | 弹窗打开，二维码 naturalWidth=212，恢复码正常 | `e2e-r5-34` |
| 系统管理 7 tab | 全部正常；概述显示 已连接 / 已运行 5 分钟 / Node v22.23.3 | `e2e-r5-35…41` |
| 审计日志 | 共 15 条，首行 update_preferences | `e2e-r5-42` |
| 工作流编辑器 | 打开正常；默认动作仍提示「未选择动作类型」 | `e2e-r5-43`、`e2e-r5-workflow-editor.png` |
| MCP / 关于 | 正常；关于页 Node 仍为「—」 | `e2e-r5-44/45` |
| 普通用户：账户/域名/记录 | 写入口全部隐藏；域名行与记录页显示「只读」徽标 | `e2e-r5-02/03/04-plain_*.png` |
| 普通用户：受限路由 | 静默跳回 /dash，无提示 | `e2e-r5-05-plain_restricted.png` |

### 发现（8 条）

**P1-1　实时状态徽标始终到不了「已连接」（第四轮遗留）**
- 复现：登录后停在 /dash，每 4 秒读一次右上角状态点（共 12 秒）
- 实际：`实时连接中` → `实时已断开`；Playwright 记录 `ws://…/api/socket/ws` 报 `WebSocket is closed before the connection is established` 后 close；后端无 `New WebSocket connection attempt` 日志；用 node ws 带 cookie 直连 3001 可立即 open
- 期望：`实时已连接` 并接收推送
- 说明：dev 侧 `client/vite.config.ts` 的 `/api` 代理未开 `ws: true`（前端连的是 /api/socket/ws）；只转发 /api HTTP 的反代部署同样受影响（截图 `e2e-r5-06-dashboard_realtime.png`）

**P1-2　SRV 记录仍无法新建（MX 已修，根因未除）**
- 复现：记录页 → 新建记录 → 类型 SRV → 优先级 10 / 权重 5 / 端口 5060 / 记录值 sip.example.test → 创建
- 实际：红色 `Invalid hostname value`，弹窗不关，记录未创建；接口对照：`value="10 5 5060 sip.example.test"` → 400，`value="sip.example.test" + priority/weight/port` → 200
- 期望：与 MX 一致，附加字段走独立字段，value 只放主机名
- 根因：`client/src/features/records/record-dialog.tsx` 的 `composeRecordValue()` 只把 `mx` 放进 `dedicated` 白名单，SRV 的 priority/weight/port 仍被拼进 value 后按 hostname 校验（截图 `e2e-r5-20-record_SRV.png`）

**P2-1　提供商配置项仍显示 i18n key**
- 复现：DNS 账户 → 新建账户 → 选「虚拟」→ 配置项下拉
- 实际：`provider.config.virtual_enabled_on` / `provider.config.virtual_enabled_off`（提供商名称本身已中文化）
- 期望：启用 / 关闭（截图 `e2e-r5-08-account_create.png`）

**P2-2　全新实例首次「测试连接」仍提示「检测到已有数据」**
- 复现：空目录 + 全新 DB 启动 → /setup → 测试连接
- 实际：`连接成功，检测到已有数据` + 徽标 + 「重置并初始化（会删除既有账号与域名记录）」
- 期望：全新库只提示「连接成功」；仅当存在用户/域名时才提示（截图 `e2e-r5-02-setup_test_conn.png`）

**P3-1　关于页 Node 版本仍为「—」**
- 系统概览已能显示 `v22.23.3`，关于页仍为空，说明两处数据来源/取值不一致（截图 `e2e-r5-45-about.png`）

**P3-2　工作流编辑器默认动作仍提示「未选择动作类型 / 这个动作不在当前后端声明里」**
- 新建工作流后动作区第一项即出现该橙色警告（截图 `e2e-r5-workflow-editor.png`）

**P3-3　普通用户直连受限路由静默跳转**
- 复现：普通用户访问 /dash/users、/dash/audit、/dash/workflows、/dash/system
- 实际：直接回到 /dash，无 toast / 无「无权限」说明（页面上的「仅管理员可见」是仪表盘自身文案）
- 期望：提示无权限（截图 `e2e-r5-05-plain_restricted.png`）

**P3-4　仅通过 API 创建的域名，记录页仍报 400「虚拟站点不存在」**
- 本轮 UI 新增的 example.test 正常（新修复生效）；但用 `POST /api/domains` 直接建的 中文测试.中国 进入记录页仍为 400 + 「共 0 条记录」+ 可点「新建记录」
- 期望：API 创建路径也补建站点，或记录页给出不可写提示

### 截图清单（`e2e-r5-*.png`，51 张）

- 初始化/登录/仪表盘：`01-setup_open`、`02-setup_test_conn`、`03-setup_init`、`04-setup_admin`、`05-login`、`06-dashboard_realtime`
- 账户/域名：`07-accounts_empty`、`08-account_create`、`09-domain_add`、`10-idn_and_sub`、`11-domain_list`、`12-domain_remark_200`、`13-domain_remark_201`、`14-grouping_modes`、`15-grouping_expand`
- 记录：`16-records_open`、`17-record_A`、`18-record_TXT`、`19-record_MX`、`20-record_SRV`、`21-record_list`、`22-record_edit`、`23-record_toggle`、`24-batch_import`
- 监控/令牌/团队/用户：`25-monitor_service`、`26-monitor_ns`、`27-monitor_renewal`、`28-token`、`29-token_copy_disable`、`30-teams`、`31-team_member_perm`、`32-users`
- 设置/安全/系统/审计/工作流/MCP/关于：`33-settings`、`34-security_2fa`、`35-system_overview`…`41-system_workflow`、`42-audit`、`43-workflow_editor`、`44-mcp`、`45-about`、`e2e-r5-workflow-editor`
- 普通用户视角：`01-plain_login`、`02-plain_accounts`、`03-plain_domains`、`04-plain_records_readonly`、`05-plain_restricted`

### 覆盖说明

- 团队「添加成员 / 添加域名授权」的前端弹窗本轮**未走通**（脚本选择器在成员下拉处超时），成员加入与只读授权改用 `POST /api/teams/:id/members`、`POST /api/teams/:id/members/:uid/domain-permissions` 验证（均 200），并据此完成普通用户「只读徽标」验证；该弹窗的 UI 交互属未覆盖项，不代表无缺陷。
- 真实第三方提供商、SMTP、SSO、Passkey、2FA 完整绑定、工作流实际执行仍未覆盖（同第四轮）。


## 第五轮修复状态（执行层回填，提交 `68aa53b`）

| 编号 | 状态 | 说明 |
| --- | --- | --- |
| P1 SRV 无法新建 | ✅ 已修 | 前后端 `validateRecordValue` 增加 SRV 四段校验（priority weight port target）；表单组合+校验有用例 |
| P1 实时徽标到不了「已连接」 | ✅ 已修（dev） | vite `/api` 代理也开 `ws: true`（此前只有 `/api/socket`，被 `/api` 先匹配） |
| P2 全新实例提示「检测到已有数据」 | ✅ 已修 | 遗留标记只在「配置的 DB_PATH 位于 cwd/data」时才采信 |
| P2 提供商配置项显示原始 key | ✅ 已修 | 裸键（virtual_enabled_on）也映射中文 |
| P3 关于页 Node「—」/ 工作流默认动作警告 / 受限路由静默跳转 | ⏳ 未修 | 见报告正文 |

## C 端细节轮（服务监控 / NS 监控 / 域名续期）

- 环境：前端 `http://localhost:5173`（Vite dev）+ 后端 3001，隔离库 `/tmp/cend/data/app.db`，虚拟提供商开启；**未重启服务、未改代码**
- 会话：复用 `/tmp/cend/state.json`（拷到 `/tmp/e2e-cend/state.json`），管理员 cendadmin；空态覆盖用 cendadmin2（仅登录 1 次）
- 截图：`ai-censorship/evidence/e2e-walkthrough-cend-*.png`（49 张）；原始结果 `/tmp/e2e-cend/part*.json`
- 数据背景：账户「C 端虚拟账户」、域名 example.test（A/TXT/MX/SRV）、SSL 监控 4 条（含 3 条「C 端站点监控」）、端点 1 条、故障转移 1 条、团队 1 个、工作流 1 个；NS 监控与续期初始为空

### 覆盖矩阵（每页：加载/空态/错误态/校验/成功后刷新）

| 子页 | 加载态 | 空态 | 错误态 | 提交校验 | 成功后即时刷新 |
|---|---|---|---|---|---|
| SSL 证书监控 | Skeleton 正常 | 「还没有SSL 证书监控」（缺空格，见 P2-5） | 不可达目标 → 状态「检测失败」 | 名称/目标必填，端口与告警天数有默认值 | 新增/编辑/删除后列表即时更新（invalidate 生效） |
| 端点探测 | 正常 | 「还没有端点探测监控」 | 检测失败后状态可见 | 仅必填校验，无 URL 格式校验（P2-2） | 列表会重取，但状态显示错（P1-1） |
| DNS 故障转移 | 正常 | 「还没有DNS 故障转移监控」（缺空格） | 主值不可达 → 「检测失败」+ 响应耗时 | 除必填外还强制「目标」（P2-1） | 新增/编辑/删除即时；无启停开关（P1-3） |
| NS 监控 | 正常 | 「还没有 NS 监控，点击「新增监控」开始」 | 检测完成提示「缺失/不一致」 | 域名+期望 NS；无域名账号时退化为手输 | 保存/删除/启停即时；新建未检测显示「正常」（P1-4） |
| 域名续期 | 正常 | 「还没有可续期域名，点击「添加域名」从提供商导入」 | 「添加」必然 400（P0-1） | 仅「请选择账户/至少选择一个域名」 | 移除、启停、续期后即时更新 |

### 发现（10 条）

**P0-1　「添加可续期域名」在 UI 上必然失败（400 Missing required fields）**
- 复现：域名续期 → 添加域名 → 选「C 端虚拟账户」→ 勾 example.test → 添加
- 实际：红字 `Missing required fields`（英文），列表仍为空；网络 `400 POST /api/domains/renewable-domains`。同一份数据用 API 补上 `provider_type: "virtual"` 后立即 200 并出现在列表
- 期望：添加成功（`已添加 1 个域名`）
- 根因：`client/src/features/domains/use-renewal.ts:43-58` 里 `providerType` 由弹窗传 `undefined`，服务端 `POST /domains/renewable-domains` 要求 `provider_type` 必填；弹窗只拿到 `{id,name}`，没有账号类型
- 截图：`e2e-walkthrough-cend-07-R2_续期添加域名.png`、`e2e-walkthrough-cend-04-R6_续期通过接口补齐.png`

**P1-1　服务监控「状态」列映射错：检测成功仍显示「未检测」**
- 复现：端点探测 → 任一监控点「检测」→ 等待提示「…检测完成」（约 15s）
- 实际：列表行状态仍是「未检测」，API 里 `status: "ok"`、`response_time: 5252`；SSL 同理（example.com 检测后仍「未检测」）；只有 `error` 能正确显示「检测失败」
- 期望：显示「正常 / 异常 / 不可用」
- 根因：后端状态取值为 `ok | warning | error | unknown`，前端 `monitorStatus()` 只映射 `healthy/degraded/down/error`（`client/src/features/domains/service-monitor-api.ts:69-79`），`ok/warning` 全部落到 default「未检测」
- 截图：`e2e-walkthrough-cend-03-E10_端点检测后列表刷新.png`、`e2e-walkthrough-cend-02-E8_端点检查_example_com_.png`

**P1-2　端点探测无法配置「期望状态码 / 期望响应体」**
- 复现：端点探测 → 新增监控 → 查看字段
- 实际：仅 名称/目标/检测周期/端口/协议/路径 + 跟随重定向；页面任何位置都没有期望值输入
- 期望：可填期望状态码（如 204）与期望响应体，检测按期望判定
- 依据：后端 `serviceMonitor.ts:481-489` 已支持 `config.expectedStatus`、`config.expectedBody`，前端完全没有暴露
- 截图：`e2e-walkthrough-cend-02-E2_端点弹窗字段核对.png`

**P1-3　DNS 故障转移缺少「检查方式 / 端口 / 路径」，且三类监控都没有启停开关**
- 复现：DNS 故障转移 → 新增监控 → 查看字段；再回列表看行操作
- 实际：字段只有 名称/目标/周期/域名/记录类型/记录名/TTL/主值/备用值/自动切回；未暴露 http·tcp·ping、端口、路径；列表行只有「检测 / 编辑 / 删除」，没有启停
- 期望：可选择检查方式与端口/路径；行内有启停开关（任务要求的「启停」无法完成）
- 依据：后端 `serviceMonitor.ts:107/565` 支持 `checkMethod('http'|'tcp'|'ping')`、`checkPort`、`checkPath`，默认 tcp/80
- 截图：`e2e-walkthrough-cend-08-F2_转移弹窗字段核对.png`、`e2e-walkthrough-cend-07-F1_故障转移列表.png`

**P1-4　新建 NS 监控未检测就显示「正常」**
- 复现：NS 监控 → 新增（example.test，期望 ns1.example.com, ns2.example.com）→ 保存
- 实际：行状态「正常」、最近检测「—」；API `status: "ok"`、`last_check_at: null`、`current_ns: ""`。点「检测」（约 20s）后才变「缺失」并提示「example.test 检测完成：缺失（当前 NS：）」
- 期望：未检测显示「未检测」，只有检测通过才显示「正常」
- 附带：`STATUS_LABEL`（`ns-monitor-tab.tsx:17-21`）没有 `poisoned` 词条，真出现污染状态时徽标会直接显示英文 `poisoned`（本轮无法构造污染，未实测）
- 截图：`e2e-walkthrough-cend-02-N2_NS新增example_test.png`、`e2e-walkthrough-cend-01-N6_NS检测复测.png`

**P2-1　DNS 故障转移表单要求语义重复的「目标」**
- 复现：DNS 故障转移 → 新增 → 只填 名称/域名/记录/主备值 → 保存
- 实际：红字「请输入目标」，保存被拦；必须再手填一遍 `example.test`
- 期望：选定域名+记录后自动派生目标（或干脆不要求该字段）
- 截图：`e2e-walkthrough-cend-09-F3_故障转移新增.png`、`e2e-walkthrough-cend-04-F6_故障转移新增_填目标_.png`

**P2-2　端点目标无格式校验，内网地址也照收**
- 复现：端点探测 → 新增 → 目标填 `abc`（协议 HTTPS）→ 保存；再试 `127.0.0.1` + 端口 3001 + 路径 `/api/system/version`
- 实际：两次都保存成功，没有任何提示；检测后才失败（TLS 错误 / 连接失败）
- 期望：非法 URL 保存前报可理解的错误；内网探测要有明确开关与说明（后端只在 `config.allowPrivate` 且非管理员时报 403，UI 未暴露）
- 截图：`e2e-walkthrough-cend-03-E3_端点非法URL.png`、`e2e-walkthrough-cend-01-E7_端点检查_内网_.png`、`e2e-walkthrough-cend-04-E4_端点内网地址.png`

**P2-3　续期「停用」状态下仍可点「续期」，报英文错误**
- 复现：续期页把「自动续期」开关关掉 → 点「续期」
- 实际：红字 `Cannot renew disabled domain. Please enable it first.`（400 POST /domains/1/renew）
- 期望：停用时按钮置灰或提示中文「请先启用自动续期」
- 截图：`e2e-walkthrough-cend-05-R7_续期列表与启停.png`

**P2-4　检测耗时 10–40 秒且无进度/耗时提示**
- 复现：端点探测检测（≈15s）、DNS 故障转移检测（≈41s）、NS 检测（≈20s）
- 实际：仅按钮内 spinner，无倒计时/进度；期间无「最近检测」变化，用户容易重复点击或误判无响应
- 期望：显示「检测中…」状态行或预计耗时，完成后高亮该行
- 截图：`e2e-walkthrough-cend-02-E8_端点检查_example_com_.png`、`e2e-walkthrough-cend-05-F7_故障转移检测与编辑.png`

**P2-5　空态文案缺空格**
- 复现：空账户管理员（cendadmin2）进入 服务监控 → SSL 证书 / DNS 故障转移
- 实际：`还没有SSL 证书监控`、`还没有DNS 故障转移监控`（英文缩写与中文之间无空格；「还没有端点探测监控」正常）
- 期望：`还没有 SSL 证书监控` / `还没有 DNS 故障转移监控`
- 截图：`e2e-walkthrough-cend-02-Z2_SSL证书空态.png`、`e2e-walkthrough-cend-04-Z4_故障转移空态.png`

### 已验证正常的部分

- SSL：新增（目标/端口/告警天数）→ 列表即时出现 + 「监控已保存」；编辑告警天数回读正确；不可达目标检测后状态「检测失败」；删除有二次确认且列表即时移除
- 端点：新增/编辑/删除、协议与路径保存正确（API config 回读一致）；检测完成提示「…检测完成」
- 故障转移：新增/编辑主值生效（API `primaryValue` 回读）、主值不可达 → 「检测失败」+ 耗时、删除确认正常
- NS：新增/编辑期望 NS、启停开关刷新后仍保持、检测后状态从「正常」变「缺失」、删除后正确回到空态文案
- 续期：空态文案与「添加域名」弹窗（账户选择、提供商域名列表、已选计数）；通过 API 建记录后列表展示 2027/01/31 + 99 天；自动续期开关刷新后保持；移除有二次确认；域名页 example.test 行联动显示（到期 15 天）
- 所有页面无白屏、无 5xx、无控制台 error（除上述 400 的预期业务报错）

### 未覆盖 / 说明

- NS「污染」标记未实测（无法构造污染解析），仅按代码判断徽标会显示英文 `poisoned`
- 真实 NS 检测结果依赖沙箱 DNS 出网能力（本轮返回「缺失」且 `current_ns` 为空）
- 「续期」实际执行依赖提供商能力（虚拟账户无续期接口），本轮只验证了按钮与错误提示，未验证真实续期成功路径
