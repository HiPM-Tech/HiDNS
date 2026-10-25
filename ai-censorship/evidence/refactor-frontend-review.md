# 前端重写前 6 提交独立评审（路由/鉴权 · 数据层 · 契约 · 组件样式 · 一致性 · 测试）

> 评审员：代码审核团独立评审（只读代码与 git 历史，未修改任何源码）
> 评审基线：HEAD `040d421`；对照 `2b4fed0`（ui 地基）→ `807cd4a`（登录）→ `b621d57`（外壳+仪表盘）→ `8c8f31c`（域名）→ `3766425`（记录）→ `040d421`（批量导入+账户）
> 规范依据：`root.ai.md`、`docs/refactor/00-PLAN.md`
> 说明：按任务指定路径落盘（`ai-censorship/evidence/refactor-frontend-review.md`）；`root.ai.md` §4 建议的 `ai-censorship/[模型名]_review-YYYYMMDD.md` 命名由任务方另行归档。

## 范围

- 6 个提交的 diff（`git show` 逐个核对）与迁移后的现状代码：`client/src/app/*`、`client/src/lib/http.ts`、`client/src/lib/theme.ts`、`client/src/copy/zh-CN.ts`、`client/src/ui/*`、`client/src/features/{auth,session,dashboard,domains,records,accounts}/*`、`client/src/App.tsx`。
- 被删除的旧实现（`pages/LoginCard.tsx`、`components/Layout.tsx`、`components/Sidebar.tsx`、`components/RecordForm.tsx`、`pages/Records.tsx`、`pages/Accounts.tsx`、`pages/Dashboard.tsx`）用于回归对照。
- 服务端只读核对（不属本次提交范围，仅用于判断前端契约是否成立）：`server/src/routes/{auth,accounts,records,domains}.ts`、`server/src/service/{record-line,account-config}.ts`、`server/src/db/bal/business-adapter.ts`。
- 门禁复跑（评审期间、当时的工作区状态）：`client` 下 `npx tsc --noEmit` 0 错；`npx vitest run` 14 文件 / 101 用例全绿。
- **评审期间工作区有并行改动**（评审以 `HEAD` 为基线，工作区变化单独标注）：评审开始时为 `M accounts-page / M domains-page / M ui/index.ts + ?? ui/pagination.tsx + ?? ui/confirm-dialog.tsx`；结束前又扩展到 `M records-page.tsx / M dashboard-api.ts / M dashboard-page.tsx`。所有涉及工作区的结论均注明「未提交工作区」并给出观察时刻的 `git status`。
- 不在范围：`client/src/pages/**` 旧页面自身的存量问题（除被新壳影响者）、后端语义提交 `6ec0191`/`1e36b41` 的独立评审。

## 结论

1. 路由与鉴权骨架成立（`/dash/*` 全部经 `ProtectedShell`、`AdminRoute` 仍在、旧页面无绕过守卫的路径），但**登录页重写删掉了 WebAuthn 登录入口**：仅启用 WebAuthn 二步的用户被彻底锁死，属 P0 回归。
2. 新壳替换旧 `Layout` 时**漏挂 `ToastContainer`**，19 处旧页面的成功/失败提示变成静默无反馈；记录页**没有实现 `proxied` 新语义**（CF/ESA 代理开关从 UI 消失），属两条 P1 功能回归。
3. 数据层方向正确（类型化 fetch + 信封 + Query 缓存），但存在双会话源/双 `isAdmin` 口径、`/auth/me` 吞错、双主题实现互相覆盖、列表页公共件未抽完且工作区未提交等问题，需在 P4 前收口。

## 发现表

| # | 级别 | 标题 | 位置 | 归属 | 置信度 |
| --- | --- | --- | --- | --- | --- |
| 1 | **P0** | 登录页丢失 WebAuthn 登录与 OAuth 登录入口，仅 WebAuthn 二步用户无法登录 | `client/src/features/auth/login-page.tsx:84-89,100-123`；旧 `client/src/pages/LoginCard.tsx:182-200,257-291,540-545`（已删） | 本次重写引入（807cd4a） | 高（入口在仓库内已不存在）；影响面待核实（部署是否启用 WebAuthn/OAuth） |
| 2 | **P1** | 新壳未挂载 `ToastContainer`，19 处旧页面的 toast 静默失效 | `client/src/app/app-shell.tsx:47-193`（无 Toast 容器）；旧 `client/src/components/Layout.tsx:95`（已删） | 本次重写引入（b621d57） | 高 |
| 3 | **P1** | 记录页未落地 `proxied` 新语义：CF/ESA 代理开关从 UI 消失，列表也不显示代理态 | `client/src/features/records/record-dialog.tsx:126-139`、`records-page.tsx:186-193`、`api.ts:14,45`；旧 `components/RecordForm.tsx:330-341`（已删） | 本次重写引入（3766425） | 高（字段只存在于类型，无任何读写点） |
| 4 | **P1** | 会话与权限双份实现：两处 `/auth/me`、两套 `isAdmin`、`role` 类型谎报、`me` 吞错、401 不回跳 | `features/session/{api.ts:7,14-21,use-session.ts:19-23}`、`contexts/AuthContext.tsx:23-34,64`、`utils/roles.ts:7-9`、`lib/http.ts:85-87`、`app/protected-shell.tsx:7` | 本次重写引入（b621d57/807cd4a） | 高 |
| 5 | **P1** | 双主题实现并存且互相覆盖：新壳主题偏好刷新后被旧 `ThemeProvider` 重置 | `lib/theme.ts:4,26-38` 与 `contexts/ThemeContext.tsx:16,57-74`；`App.tsx:54` 仍挂旧 Provider；`app/app-shell.tsx:25` 用新 hook | 本次重写引入（2b4fed0/b621d57） | 高（机制可推导：父级 effect 后于子级生效） |
| 6 | **P2** | 三张列表页重复实现分页/删除确认/搜索防抖/骨架，公共件只存在于未提交工作区，且 records 未跟进 | `features/domains/domains-page.tsx:236-259,263-280`、`features/records/records-page.tsx:254-275,296-313`、`features/accounts/accounts-page.tsx:166-183`；`ui/pagination.tsx`、`ui/confirm-dialog.tsx`（未跟踪） | 本次重写引入（8c8f31c/040d421） | 高 |
| 7 | **P2** | 记录删除/批量导入后缓存失效不全；批量导入部分成功不刷新、失败行号错位 | `features/records/use-records.ts:56-65`、`records-page.tsx:293`、`batch-import-dialog.tsx:69,124` | 本次重写引入（3766425/040d421） | 高 |
| 8 | **P2** | 对话框 effect 依赖不稳定数组，查询失败/加载中时表单每次渲染被重置（无法输入） | `features/records/records-page.tsx:283-284` + `record-dialog.tsx:51-80`；`features/accounts/accounts-page.tsx:162` + `account-dialog.tsx:33-48` | 本次重写引入（3766425/040d421） | 中（需 `record-types`/`lines`/`providers` 无数据才触发） |
| 9 | **P2** | 导航与路由守卫口径不一致：审计日志对非管理员可见但路由会弹回；隧道不再受偏好开关约束 | `app/nav.ts:47`（缺 `adminOnly`）、`nav.ts:49`；旧 `components/Sidebar.tsx:55-59,173-178`（三项均 `isAdmin` 控制） | 本次重写引入（b621d57） | 高；设计意图待核实 |
| 10 | **P2** | 测试只守渲染与二次确认，未守数据层行为；`line:'0'` 旧语义被写进夹具 | `features/*/__tests__/*`、`records/__tests__/records-page.test.tsx:28-29`；缺 `lib/http.ts` 测试 | 本次重写引入 | 高 |

## 逐条详情

### 1 · P0 · 登录页丢失 WebAuthn / OAuth 入口

**现象**：`LoginPage` 只有「账号密码 → 2FA（验证码/备用码）→ 找回密码」三条分支。`submitTwoFactor` 只提交 `totpCode` / `backupCode`（`login-page.tsx:108-114`），二步分支不读服务端返回的 `types`（`login-page.tsx:84-89` 一律 `setStep('2fa')`）。

**证据**
- 旧实现：`LoginCard.tsx` 按 `supported2FATypes` 渲染 TOTP/WebAuthn 两套二步（`257-291`），用 `startAuthentication` 走 WebAuthn 登录（`540-545`），并渲染 OAuth 登录按钮（`182-200`）。
- 现状：`grep -rn "startAuthentication|webauthnLoginOptions" client/src` 只剩 `client/src/api/auth.ts:12` 的死代码定义；`oauthStart` 在 `client/src` 内已无调用点（仅 `pages/Settings.tsx:108` 用 `oauthStatus` 做绑定展示）。
- 服务端仍会返回 `types: ['webauthn']`（`server/src/routes/auth.ts:657-661`，HTTP 200 + `code:-2`），前端却只给验证码输入框。

**影响**：启用「仅 WebAuthn」二步的账号，密码正确后进入验证码步骤，任何输入都会被服务端拒绝，且无降级路径——完全无法登录。启用 OAuth 单点登录的部署失去免密入口（仍可用密码登录，故严重度低于 WebAuthn 部分）。

**建议**：登录页补齐 `types` 分支：`totp` 走现有表单、`webauthn` 走 `startAuthentication` 后带 `webauthnResponse` 重投 `/auth/login`；OAuth 按钮按 `/auth/oauth/status` 渲染。回归用例需覆盖 `types:['webauthn']` 与 `types:['totp','webauthn']` 两条分支。

**待核实**：目标部署是否启用 WebAuthn/OAuth（决定影响面；P0 定级基于「能力已从产品中消失」而非「必有用户被锁」）。

### 2 · P1 · 新壳未挂载 ToastContainer

**现象**：旧 `Layout` 在 `Layout.tsx:95` 渲染 `<ToastContainer />`，`useToast()` 是模块级订阅（`hooks/useToast.ts:20-38`）。`b621d57` 删除 `Layout` 后，新 `AppShell`（`app-shell.tsx:47-193`）没有任何 toast 容器。

**证据**：`grep -rn "<ToastContainer" client/src` 无结果；`useToast()` 仍有 19 处调用（`pages/Tokens.tsx:71`、`pages/Users.tsx:79`、`pages/Teams.tsx:84`、`pages/system/*`、`pages/OAuthCallback.tsx:37` 等），`features/*` 无调用。

**影响**：所有仍在旧页面的保存/删除/复制/重跑操作成功或失败都没有任何反馈（订阅者数为 0，`addToast` 静默丢弃）。用户会重复点击破坏性操作；失败也无从得知。这是「静默吞错」的一种形态。

**建议**：在 `AppShell` 挂 `<ToastContainer />`（或把 `useToast` 迁到新 `ui/` 的 `Toaster`），并加一条断言「调用 `toast.error` 后 DOM 出现提示」的用例。

### 3 · P1 · 记录页未落地 proxied 新语义

**现象**：`RecordPayload` 声明了 `proxied?: boolean`（`records/api.ts:45`），`DnsRecordRow` 也声明了 `cloudflare.proxied / proxiable`（`records/api.ts:14`），但仓库内**没有任何读写点**：`record-dialog.tsx` 提交体只有 `name/type/value/ttl/line/mx/weight/remark`（`126-139`），列表也没有代理列（`records-page.tsx:186-193`）。

**证据**：旧 `RecordForm` 对 `proxiable` 提供商把线路下拉改成「关闭/开启」，并发送 `cloudflare.proxied` / `aliyunesa.proxied`（`RecordForm.tsx:330-341,353-365,515-521`）。服务端已支持独立 `proxied`（`server/src/routes/records.ts:474-479,720-725` + `service/record-line.ts`），列表也回传 `cloudflare.proxied`（`records.ts:33-36`）。

**影响**：Cloudflare/阿里云 ESA 域名无法再切换橙云代理，也无法在列表看出某条记录是否被代理；`00-PLAN` §3「`proxied` 独立布尔」只在服务端落地，前端仍停留在「线路下拉」旧心智。属于功能回归，不是样式问题。

**建议**：`RecordDialog` 在 `provider.capabilities.dns.proxiable` 为真时渲染独立「代理」开关，提交 `proxied`；列表增加代理标记列（数据已存在）。

**待核实**：`/domains/:id/lines` 对代理型提供商返回的线路集合（若仍是 `[{id:'0'},{id:'1'}]`，用户可借线路下拉间接改代理，但语义与显示都错位）。

### 4 · P1 · 会话与权限双份实现

**现象**（四点同源）
1. **双请求**：`AuthProvider` 挂载即用旧 axios 客户端请求 `/auth/me`（`contexts/AuthContext.tsx:23-34`），`ProtectedShell` 又用 `useSession` 请求一次（`features/session/use-session.ts:5-17`）。每次进入 `/dash/*` 固定两次 `/auth/me`。
2. **双 `isAdmin`**：旧 `isAdmin(role?: number)` 按数值等级（`utils/roles.ts:7-9`），新 `isAdminUser` 先比字符串再比 `role_level`（`use-session.ts:19-23`）；`AdminRoute` 用前者（`components/ProtectedRoute.tsx:13-15`），侧栏用后者（`app/app-shell.tsx:38`）。两者若因任一请求失败而不一致，就会出现「侧栏不给入口 / 直接输 URL 能进」或反之。
3. **类型谎报**：`SessionUser.role?: string`（`session/api.ts:7`）、`AuthUser.role?: string`（`auth/api.ts:8`），而服务端 `role` 是 `role_level` 的数值别名（`server/src/db/bal/business-adapter.ts:480`）。于是 `isAdminUser` 里 `role === 'admin'` 是死分支，`app-shell.tsx:166` 会把角色渲染成 `2`。
4. **吞错与 401**：`sessionApi.me` 用 `catch { return null }` 把网络错误/500/503 一律当作「未登录」（`session/api.ts:14-21`），用户被弹到 `/login`，而真正原因（后端不可达）无处可见；`lib/http.ts:85-87` 的 401 用 `window.location.href='/login'` 硬跳，不保留来源路径，且与 `ProtectedShell` 的 `<Navigate>` 形成两套跳转机制。

**影响**：身份与权限存在两个真相源，前端守卫与导航可能对同一用户给出不同结论；后端故障被伪装成登录失效（与 `root.ai.md` §数据库「严禁把不可达判定为未初始化」是同一类混淆）。二次请求也放大了登录态失效时的抖动。

**建议**：`ProtectedShell`/`AppShell`/`AdminRoute` 统一读 `useSession`（或让 `AuthProvider` 改用 `http` 客户端并暴露 `isAdmin`），删除一份 `isAdmin`；`SessionUser.role` 改成 `number`（或只暴露 `role_level`）；`me` 区分 401（未登录）与其他错误（抛给错误态）；401 跳转带 `?returnTo=`。

### 5 · P1 · 双主题实现互相覆盖

**现象**：新壳用 `lib/theme.ts`（storage key `hidns.theme`，值 `light|dark|system`，切换 `<html class="dark">`），旧 `ThemeContext` 仍在 `App.tsx:54` 挂载（storage key `theme`，值 `light|dark|auto`，同样切 `dark` 类并额外写 `data-theme`/`theme-mode`）。

**证据**：`ThemeContext.tsx:57-74` 的 effect 在挂载时无条件执行 `applyTheme(theme)`；`ThemeProvider` 是 `AppShell` 的祖先，React 被动 effect 按子→父顺序 flush，因此**旧 Provider 的 effect 最后执行并覆盖**新壳刚应用的主题。`theme` 默认 `auto`（`ThemeContext.tsx:22-24`），即按系统色。之后系统主题变化时 `handleSystemThemeChange` 再次覆盖。

**影响**：用户在顶栏选「暗色」后刷新页面会回到系统色；系统切到夜间会把用户显式选择顶掉。两个 storage key 也让「设置页/顶栏」对同一偏好的读写互不可见。

**建议**：删除 `ThemeContext`，`App.tsx` 去掉 `ThemeProvider`，`useTheme()` 的调用点（`pages/MailSetupModal.tsx:22`）改读 `lib/theme`；或让 `lib/theme.ts` 复用旧 key 并在旧 Provider 卸载前完成迁移。

### 6 · P2 · 列表页重复实现 + 公共件停留在未提交工作区

**现象**：三张列表页各自实现「每页条数下拉 + 第 x/y 页 + 上下页 + 加载指示」与「删除二次确认对话框」，共 3 份（`domains-page.tsx:236-259,263-280`；`records-page.tsx:254-275,296-313`；`accounts-page.tsx:166-183`），搜索防抖也各写一遍（`domains-page.tsx:26-29`、`records-page.tsx:38-41`、`accounts-page.tsx:21-24`），加载骨架同样三份。

**证据（按 HEAD 基线）**：`HEAD=040d421` 上三份实现全部内联，`ui/` 无 `Pagination`/`ConfirmDialog`。**（按评审期间的工作区）**：出现了未跟踪的 `ui/pagination.tsx`、`ui/confirm-dialog.tsx`，domains/accounts 已切换；`records-page.tsx` 在评审开始时尚未跟进，评审结束前也被并行改动切换过去（`git diff --stat` 显示 `records-page.tsx | 87 +-`）。即「已在改、尚未提交、HEAD 与工作区语义不一致」。此外新原语从 barrel 反向导入（`ui/pagination.tsx:2` `from './index'`，`confirm-dialog.tsx:3` 同）构成 `index → pagination → index` 循环。

**影响**：`root.ai.md` §提交相关 1 要求改动即提交，当前 HEAD 与工作区语义不一致，评审与回滚都以不确定状态为基线（本轮 6 个提交的验收结论也因此只能对 HEAD 成立）；抽件完成前，任何新列表页都会再复制一份。循环导入虽在运行时可用（render 期取值），但会随原语增加变成脆弱点。

**建议**：`records-page.tsx` 一并切到 `Pagination`/`ConfirmDialog`，原语内部改为从 `./button`、`./select`、`./dialog` 直接导入，然后提交。

### 7 · P2 · 记录删除/批量导入的缓存失效不全

**现象**
- `useSaveRecord` 失效 `['records', domainId]`、`['domain', domainId]`、`['domains']`（`use-records.ts:48-53`）；`useDeleteRecord` 只失效前两个（`56-65`），`useToggleRecordStatus` 只失效第一个（`67-75`）——删除/停用记录后域名列表的 `record_count` 保持旧值（`domains-page.tsx:190` 展示）。
- 批量导入成功后回调 `records.refetch()`（`records-page.tsx:293`），绕过 `invalidateQueries`，因此 `['domain', domainId]`（页头「共 N 条记录」）与 `['domains']` 均不更新。
- `batch-import-dialog.tsx:69` 用 `batch.results.every(item => item.ok)` 决定是否刷新：部分成功（最常见的批量场景）**不刷新**，用户看不到成功那几条；空结果数组时 `every` 为 `true`，语义也不对。
- `batch-import-dialog.tsx:124` 的「第 N 条」用的是**过滤后**失败数组下标，不是输入行号；而 `parseBatchLine` 已算出真实行号 `row.line` 却未使用。

**影响**：列表与计数出现「操作成功但界面没变」的假象；批量导入部分失败时错误定位指向错误的行。

**建议**：三处 mutation 统一失效 `['records', domainId]` + `['domain', domainId]` + `['domains']`；批量导入改 `onImported` 为 `invalidateQueries`（`['records', domainId]`、`['domain', domainId]`、`['domains']`），并按 `result.results.some(ok)` 触发；失败列表改为 `第 {有效行原始行号} 行`。

### 8 · P2 · 对话框 effect 依赖不稳定数组导致表单被重置

**现象**：`records-page.tsx:283-284` 传 `recordTypes={types.data ?? ['A','AAAA','CNAME','TXT','MX','SRV']}`、`lines={lines.data ?? []}`——查询无数据时**每次渲染都产生新数组**。`record-dialog.tsx:51-80` 的初始化 effect 依赖 `[open, record, recordTypes, lines]`，因此只要对话框打开且 `record-types`/`lines` 任一无数据，每次输入触发的渲染都会重跑 effect，把 `name/value/ttl/line` 重置回初值。同型问题在 `accounts-page.tsx:162`（`providers={providers.data ?? []}`）+ `account-dialog.tsx:33-48`。

**影响**：`/domains/:id/record-types` 或 `/lines` 报错、或提供商不支持时，记录对话框无法输入（敲一个字就回滚）；账户页在 `/accounts/providers` 失败时同理。

**建议**：把默认值提到模块常量（`const FALLBACK_TYPES = [...] as const`），或把初始化 effect 的依赖收敛为 `[open, record?.id, lines.data, types.data]` 并在内部判空。

### 9 · P2 · 导航与路由守卫口径不一致

**现象**：`AdminRoute` 覆盖 `/dash/users`、`/dash/audit`、`/dash/workflows`、`/dash/system/*`（`App.tsx:79-90`），但 `nav.ts` 只给「用户」「自动化工作流」「系统管理」标了 `adminOnly`（`nav.ts:40,48,57`），**「审计日志」漏标**（`nav.ts:47`）。

**证据**：旧 `Sidebar` 把 `/dash/users`、`/dash/audit`、`/dash/workflows` 一起放进 `adminItems` 并整体受 `isAdmin` 控制（`git show b621d57^:client/src/components/Sidebar.tsx:55-59`，`isAdmin` 包裹在 `:173-178`）。另：旧侧栏的「隧道」入口受 `showTunnels` 偏好控制（同文件 `:95,107-109,166-170`），新 `nav.ts:49` 常显，偏好项被丢弃。

**影响**：非管理员侧栏出现「审计日志」，点击后被 `AdminRoute` 静默弹回 `/dash`（无提示），形成「看得见进不去」的死链；隧道入口对所有用户强制出现（低危，但属未登记的行为变更）。

**建议**：`nav.ts:47` 补 `adminOnly: true`；隧道入口恢复偏好开关或明确登记为有意变更（`00-PLAN` §6 台账）。

**待核实**：`nav.ts` 漏标是否为有意（例如计划让非管理员看自己的审计记录——但后端 `/logs` 已按角色过滤，仍需 `AdminRoute` 放行才成立）。

### 10 · P2 · 测试只守渲染，未守行为

**现象**：新增 6 个测试文件（101 用例全绿）覆盖「渲染字段 / 空态 / 删除二次确认 / 表单校验 / 2FA 提交流程」，但没有一条断言数据层行为：
- 无 `lib/http.ts` 用例：401 跳转、信封缺失、`code` 非 0、错误传播（`ApiError.status/code`）全未覆盖——这是新前端唯一出口。
- 无「创建/删除后列表是否刷新」断言（对应发现 7 的三处失效缺失无法被测试发现）。
- 无账户 `***` 往返用例（编辑态提交体应原样包含 `***`，且必填校验不应把它判空）。
- 无会话门禁用例（`ProtectedShell`/`useSession`），旧的 `ProtectedRoute.test.tsx` 只测 `AdminRoute`。
- `records-page.test.tsx:28-29` 用 `line: '0'` 作夹具、线路表也用 `{id:'0',name:'默认'}`（`:49`），把已被 `00-PLAN` 判定要淘汰的旧语义固化进测试。

**影响**：本轮 6 条 P1 中至少 3 条（发现 2/3/7）现有测试无法发现；后续重构会以「测试全绿」作为正确性证据。

**建议**：补 `lib/http.test.ts`（401/信封/错误）、`use-records.test.ts`（invalidate 断言）、`account-dialog` 的掩码往返用例、`protected-shell` 用例；把 `line` 夹具改为 `undefined` + 独立 `proxied`。

## 经核实无问题

1. **路由覆盖完整**：`App.tsx:64-91` 中 `/dash`、`/dash/accounts`、`/dash/domains`、`/dash/domains/:id/records`、`/dash/{tunnels,tokens,mcp,teams,settings,security,about}` 与旧页面的 `/dash/domains/{servicemonitor,ns-monitor,renewal}` 全部在 `ProtectedShell` 子路由内；未发现任何 `/dash/*` 脱离守卫。
2. **AdminRoute 仍生效**：`App.tsx:79` 的 `<Route element={<AdminRoute />}>` 嵌套在 `ProtectedShell` 内层，`components/ProtectedRoute.tsx:12-16` 未改动；`ProtectedRoute.test.tsx` 3 条用例仍通过。
3. **旧页面未丢失权限判断**：逐页核对 `pages/{Settings,Security,Teams,Tokens,Users,System,Workflows,Domains,Audit}.tsx` 在旧 `App.tsx` 与新的路由位置一致，无「旧页从 AdminRoute 内移到外层」的情况（`/dash/accounts` 在旧版同样不在 `AdminRoute` 内）。
4. **401 目标口径与旧实现一致**：`lib/http.ts:40-46`（排除 `/login`、`/`、`/setup`、`/oauth/*`、登录/公钥/重置接口）与旧 axios 拦截器 `api/client.ts:26-41` 判定等价；差异仅在实现方式（见发现 4）。
5. **无 TDesign / i18next 引用**：`grep -rn "tdesign|useI18n|i18next|from '.*\.css'" client/src/{features,app,ui,lib,copy}` 无结果；新文件不引入页面级 CSS（`main.tsx` 仍全局引入 `tdesign-react/es/style/index.css`，属 P5 收口项，非本次引入）。
6. **`***` 掩码往返成立**：服务端 `service/account-config.ts` 的 `mergeMaskedConfig` 对 `'***'` 做「键存在→沿用原值，键不存在→丢弃」，前端 `account-dialog.tsx:40,73-78` 原样回传，必填校验（`:67-72`）不会把 `'***'` 误判为空；「不会把占位符写库」的界面文案（`:156-161`）与实现一致。
7. **未偷偷回传 `'0'`**：`record-dialog.tsx:134` 提交 `line: line || undefined`（空串→undefined），服务端 `service/record-line.ts:normalizeLineId` 把 `'0'`/`''` 归一为 `undefined`，代理型提供商由独立 `proxied` 表达（`records.ts:474-479`）。前端唯一的 `'0'` 残留是**显示**（`records-page.tsx:211` 对历史 `line:'0'` 会显示 `0`），不构成写回。
8. **分页参数统一**：domains/records 都用 `page`(1 起)/`pageSize`，选项 `[20,50,100]`，与 `00-PLAN` §3 及服务端 `Math.min(pageSize,100)`（`routes/accounts.ts:147`）一致；accounts 未传分页参数走数组形态，与服务端「有 `page` 才分页」的兼容分支匹配（`accounts.ts:145-153`）。
9. **暗色 token 可用**：`ui/tokens.css:31-49` 提供完整 `.dark` 覆盖，`tailwind.config.js:49-72` 存在 `success-*`/`warning-*` 色阶，页面使用的 `text-warning-600 dark:text-warning-400`、`bg-success-50 dark:bg-success-900/30` 等类都能生成（非空类名）。
10. **可访问性基本面达标**：搜索/筛选/每页/翻页/删除按钮均有 `aria-label` 或 `role="alert"`（`domains-page.tsx:108,113,126,221,251,254`；`records-page.tsx:148,153,160,167,228,240,267,270`），表单 `Label htmlFor` 与 `id` 一一对应（`record-dialog.tsx:164-218`、`account-dialog.tsx:105-152`、`login-page.tsx:206-342`），`aria-invalid` 随校验态联动；`Dialog` 基于 Radix，焦点陷阱/Esc/标题关联由原语提供。
11. **门禁通过（评审时点）**：`client` `npx tsc --noEmit` 0 错；`npx vitest run` 14 文件 / 101 用例全绿（本次复跑，运行于评审期间的工作区状态；此后工作区新增的并行改动未纳入该结论）。
