# 第 11–21 轮前端迁移 · 独立评审（第二份）

- 评审对象：`ea0f333`（令牌）`aecd917`（安全）`f10670e`（设置）`0ebc035`（审计）`ad19cae`（团队）`7856c66`（系统壳 / 团队成员角色）`b465ce6`（系统安全）`7212a77`（系统访问）`74825a9`（网络 / 通知 / 工作流）`aba1fc4`（域名子页 / 隧道）`8530f64`（用户）
- 依据：`root.ai.md`、`docs/refactor/00-PLAN.md`。
- 方法：`git show <commit>` 逐条读 diff → 读现状代码 → 读对应后端路由/服务核对契约。**全程只读，未改任何源码**。
- 行号均指**基线 HEAD（8530f64）**的文件行；「旧实现」指被删除文件（用 `git show <commit>^:<path>` 复核）。
- 基线说明：评审过程中工作区出现了**未提交**的并行改动（`D client/src/pages/domains/NSMonitorTab.tsx`、新增 `features/domains/ns-monitor-tab.tsx`、`domains/monitoring-page.tsx` 改挂新组件），因此「残留」类结论以 HEAD 为准；涉及该文件的条目已注明，下一轮需重新核对。

## 范围

| 维度 | 覆盖内容 |
| --- | --- |
| 功能等价性 | 旧 `pages/{Tokens,Security,Settings,Audit,Teams,Users,Tunnels,Domains}`、`pages/domains/DomainListTab`、`pages/system/{SecurityTab,AccessTab,NetworkTab,WorkflowTab,OverviewTab,DatabaseTab}`、`components/{TunnelList,AuditLogList,NotificationChannels}`，逐字段/逐操作对账 |
| 契约 | 信封解包（`code!==0` 是否抛错）、403/404/409 的展示路径、分页与筛选参数、字段命名；对照 `server/src/routes/{tokens,users,teams,settings,security,audit,network,tunnels}.ts` 与 `service/{token,token-policy,smtp}.ts` |
| 权限 | `RequireAdmin` 覆盖、`canModify` / `assignableRoles`、令牌 `max_role` 与服务端 `resolveTokenPolicy` |
| 一致性 | 各 feature 的 api/hooks/page 三层是否同构、是否有重复实现、`queryKey` 命名与失效链 |
| 测试 | 12 个新增用例文件逐条判断是否守行为（载荷 / 参数 / 禁用态） |
| 残留 | `tdesign` / `i18next` / 旧 `api/index` 引用，旧组件是否仍被打包 |

未覆盖：浏览器端到端（无运行环境）；截图仅作旁证，不作为结论依据。

## 结论

2 条 P0：系统「安全」tab 的 SMTP 表单字段名与后端不匹配（用户名/密码/发件人三项**恒显示为空、且在前端编辑后会被服务端静默丢弃**，管理员无法再从界面维护邮件通道）；域名域已无「新增域名」入口（旧表单随 `DomainListTab` 一起删除，台账未登记）。
另有 6 条 P1：系统各项保存不判断信封、团队页缺可操作性闸门、审计「搜索」不发请求、域名/用户列表字段缺失、新壳整体失去实时刷新、改邮箱的反馈通道混淆；P2 4 条聚焦绑定字段名、失效范围、重复实现、测试盲区。
**契约解包在 403/404/409 上未发现静默失败**：非 2xx 一律抛 `ApiError` 并展示 `msg`；「HTTP 200 + code 非 0」属存量问题，见第 12 条。

## 发现表

| # | 级别 | 归属 | 置信度 | 位置 | 标题 |
| --- | --- | --- | --- | --- | --- |
| 1 | P0 | 本轮引入（b465ce6） | 高 | `client/src/features/system/security-api.ts:9-17`、`security-tab.tsx:13,144,187,191,195` | SMTP 字段名（user/pass/from）与后端（username/password/fromEmail）不一致：三项恒空、前端编辑被静默丢弃 |
| 2 | P0 | 存量（域名页 8c8f31c）/ 本轮删旧实现后暴露（aba1fc4） | 高 | `client/src/features/domains/domains-page.tsx:83-86,202-221`、`use-domains.ts` | 域名域已无「新增域名」入口（含从提供商同步），前端无任何创建路径，台账未登记 |
| 3 | P1 | 本轮引入 | 高 | `security-tab.tsx:59-64,146-151,223-228,265-270`；`access-tab.tsx:123-128,178-183`；`network-tab.tsx:101-106`；`workflow-tab.tsx:33-42` | 系统各项保存只看 HTTP 是否 2xx，信封 `code` 非 0 时仍提示已保存 |
| 4 | P1 | 本轮引入（前端）/ 存量（后端规则） | 高 | `client/src/features/teams/teams-page.tsx:112-114,119-121,157-167,182-184` | 团队页没有任何可操作性闸门，非管理者点每个按钮都收到服务端 403 |
| 5 | P1 | 存量（后端无 `keyword`）/ 本轮新增控件 | 高 | `client/src/features/audit/api.ts:33`、`audit-page.tsx:71-75` | 「搜索域名或操作」的 `keyword` 后端不认，搜索框完全无效 |
| 6 | P1 | 存量（域名页）/ 本轮（用户页 8530f64） | 高 | `domains-page.tsx:143-199`；`users-page.tsx:118-161,181-190` | 列表字段缺失：域名缺 WHOIS 状态/子域标记/备注编辑/置顶，用户缺「本人」标记与 2FA 强制开关 |
| 7 | P1 | 存量（新壳第 10 轮，本轮全面铺开） | 中 | `client/src/features/**`（零 `useRealtimeData`）、`app/app-shell.tsx` | 新壳丢弃全部实时刷新（WebSocket 事件 + 60–120s 轮询），`00-PLAN.md` 未登记该决定 |
| 8 | P1 | 本轮引入（f10670e） | 高 | `settings-page.tsx:120-121,133,138` | 改邮箱：「发送验证码」与「保存资料」共用一个提示通道；清空邮箱时直接吃英文 400 |
| 9 | P2 | 本轮引入 | 高 | `settings/api.ts:12-17` vs `settings-page.tsx:76` | 绑定行邮箱字段写成 `external_email`（后端实为 `email`），永远显示「—」 |
| 10 | P2 | 本轮引入 | 高 | `teams/use-teams.ts:8-33,45,69,77,86,97,108` | 团队 mutation 全部按前缀失效，一个团队的操作会让所有团队的成员/权限查询重取 |
| 11 | P2 | 本轮引入 | 高 | `security-tab.tsx:339-351` 与 `access-tab.tsx:224-236`；`tunnels-page.tsx:93`、`security-page.tsx:386`、`security/api.ts:89` | 重复实现未抽公共件（逐字相同的 `ToggleRow`、三处手写日期格式化），令牌有效期精度回退 |
| 12 | P2 | 本轮（测试盲区）/ 存量（信封） | 高 / 中 | `tokens-page.test.tsx:61-86`、`security-tab.test.tsx:44`、`lib/http.ts` | 用例 mock 用了后端不存在的 SMTP 字段、令牌未覆盖角色上限夹取；200 + 非零码不抛错 |

## 逐条详情

### 1. [P0·本轮引入·高] SMTP 字段名不一致：恒空 + 编辑被静默丢弃
- 前端类型与默认值用 `user / pass / from`：`security-api.ts:9-17`、`security-tab.tsx:13`；三个输入框绑定在 `:187`（用户名）、`:191`（密码）、`:195`（发件人）。
- 后端 `server/src/service/smtp.ts:7-17` 是 `username / password / fromEmail / fromName`，`parseConfig`（`:32-45`）按这些键读，`sendRawSmtpMail`（`:89`）在 `fromEmail` 为空时抛 `SMTP configuration is incomplete`。
- 读：`useSmtpConfig`（`use-security-tab.ts:10-12`）返回的是后端形态，草稿是 `{...SMTP_DEFAULTS, ...smtp.data}`（`security-tab.tsx:144`）——运行时 `draft` 里既有后端键也有前端的空 `user/pass/from`。界面读 `draft.user`，因此**已配置的用户名/密码/发件人一律显示为空**，管理员无法确认当前配置。
- 写：`useSaveSmtp` 提交整个 `draft`，其中 `user/pass/from` 是（空的或新输入的）新键，而后端 `updateSmtpConfig`（`smtp.ts:59-79`）只认 `username/password/fromEmail`——用户在「用户名」框里输入的内容**不会进入后端任何字段**，保存成功后依旧是旧值，且界面继续显示空；同时 `user/pass/from` 三个垃圾键会被写进 SMTP 配置 JSON。
- 数据安全性：因为 `draft` 通过展开保留了后端返回的 `username/password/fromEmail/fromName` 并原样回传，服务端 `{...current, ...input}` 不会把既有凭据清空——**这是「功能失效 + 静默丢弃输入」，不是数据损坏**（更正：初稿曾写「保存即清空配置」，经复核 `security-tab.tsx:144` 的展开保留了原值，该表述有误）。
- 附带缺失：`secure`（TLS 开关）与 `fromName`（发件人显示名）在新页没有控件，而后端在非 465 端口依赖 `secure`、「发件人」依赖 `fromName`，管理员从此无法调整。
- 建议：`SmtpConfig` 与 `SMTP_DEFAULTS` 改用后端真实字段并补 `fromName`；用例断言提交载荷含 `username/fromEmail`（现有 `security-tab.test.tsx:44` 的 mock 也写成 `user/from`，与后端同错 → 单测与截图都不会暴露）。

### 2. [P0·存量 / 本轮暴露·高] 域名域没有「新增域名」入口
- `aba1fc4` 删除 `pages/domains/DomainListTab.tsx`（853 行）时，把 `AddDomainForm`（手动添加 + 从提供商同步、`existsOther`/`parentExists` 标记、`third_id`、`remark`）一并删除；新 `domains-page.tsx` 只有「记录 / 启用停用 / 删除」（`:202-221`），`use-domains.ts` 没有 `useCreateDomain`。
- 全前端已无创建域名路径：`features` 与 `pages` 无 `createDomain`/`listFromProvider` 调用，`pages/Setup.tsx` 也不含域名创建。因此新部署后除直接打 HTTP 接口外，无法通过 UI 添加域名——核心流程阻断。
- 归属：域名列表页上轮（`8c8f31c`）就没带新增；本轮删掉旧文件后彻底无回退路径，且交付说明把删除理由写成「列表页早已由新页面替代，旧文件成为死代码」，掩盖了表单遗漏；`00-PLAN.md` 第 88 行只登记「域名子页与隧道」。
- 建议：补 `features/domains/add-domain-dialog`（手动 + 从提供商同步），与第 6 条的备注/置顶一起补齐，并在台账登记缺口。

### 3. [P1·本轮引入·高] 系统各项保存不判断信封 `code`
- `security-tab.tsx:59-64,146-151,223-228,265-270`、`access-tab.tsx:123-128,178-183`、`network-tab.tsx:101-106`、`workflow-tab.tsx:33-42` 全是 `try { await save.mutateAsync(...); onSaved('…已保存') } catch { onError(...) }`。
- 对应写入方法直接返回 `http.put(...)` 信封而不 unwrap：`security-api.ts:68,73,77,80,88,92`、`network-api.ts:43,50,56`。`lib/http.ts` 只在非 2xx 抛错，因此「200 + code 非 0」会走成功分支（来源见第 12 条）。
- 不一致点：同一 feature 的**查询**侧有 unwrap（`security-api.ts:60-64`），**写入**侧没有；而 `features/security/use-security.ts:6-11`、`features/settings/use-settings.ts:5-10` 是写入侧也 unwrap 的写法。同一仓库两套口径本身即缺陷模式。
- 建议：写入侧统一 unwrap，页面只处理 reject；或在 `lib/http.ts` 统一把 `code!==0` 视为错误（需先清掉后端 24 处 `code:-1`）。

### 4. [P1·本轮引入 / 存量后端·高] 团队页没有可操作性闸门
- 新页无条件渲染「编辑 / 删除」（`teams-page.tsx:112-114`）、「添加成员」（`:119-121`）、成员角色下拉与移除（`:157-167`）、「添加授权」与授权删除（`:182-184,264`）。
- 后端 `server/src/routes/teams.ts` 的写接口一律要求 `isSuper || created_by === userId || member.role === 'admin'`，否则 403：`PUT /:id`（`:272`）、`DELETE /:id`（`:327`）、`POST /:id/members`（`:441`）、`PUT /:id/members/:userId`（`:527`）、`DELETE /:id/members/:userId`（`:581`）、`POST /:id/domain-permissions`（`:706`）。
- `GET /teams`（`:101-131`）对所有登录用户返回「我所在的团队」，所以普通成员会看到一整排点了就 403 的按钮；旧页有 `canManageTeam = isAdmin(me?.role) || myMember?.role === 'owner'` 包裹，新页把这个闸门整体丢了。
- 另两处细节：后端禁止改自己角色（`:534`）与移除团队创建者（`:588`），前端对这两行也渲染可操作控件，且无提示。
- 建议：`TeamRow` 补上后端已返回的 `my_role`（`teams.ts:110-131` 已算好，`teams/api.ts:3-10` 未声明），用 `isAdminUser(user) || my_role ∈ {admin, super}` 统一守卫；本人行禁用角色下拉。

### 5. [P1·存量后端 / 本轮新增控件·高] 审计页「搜索域名或操作」无效
- `audit/api.ts:33` 下发 `keyword`；`server/src/routes/audit.ts:17-25` 的 `getAuditFilters` 只读 `domain/userId/action/startDate/endDate`，`service/auditExport.ts` 也无 `keyword`。`audit-page.tsx:71-75` 的搜索框输入后只会多发一次请求、结果不变。
- 归属：后端缺能力是存量，但旧页没有这个控件（旧页是「域名」输入 + 「操作类型」下拉），承诺是本轮新增的，故记 P1。
- 建议：先降级为 `domain=keyword`（后端已支持模糊），或在后端补 `keyword` 并同步 `docs/api.md`。

### 6. [P1·存量域名页 / 本轮用户页·高] 列表字段缺失
- 域名页 `domains-page.tsx:143-199` 相比旧 `DomainListTab` 少：①注册状态（`whois_status` 多状态标签与配色）；②子域标记（`isApexDomain` 徽标）；③**备注编辑**（旧页「编辑备注」对话框 → `PUT /domains/:id {remark}`；`updateDomain` 现仅在 `use-domains.ts:23` 用于切 `enabled`，`remark` 分支不存在）；④置顶（`getPinnedDomains/updatePinnedDomains` 与 `pinned_domains` 参数）；⑤分组折叠（`grouped=true` 与 `_group_header`）。
- 用户页 `users-page.tsx:118-161` 相比旧 `Users`：①缺「本人」标记；②缺每用户「要求两步验证」开关（旧页 `securityApi.getUser2FARequirement/setUser2FARequirement`，后端 `routes/security.ts:105,133,318` 仍在）；③删除按钮不再排除自己（旧页 `disabled={user.id === me?.id}`），现只靠服务端 `users.ts:266-269` 兜底，丢失「先置灰」的可预期性。
- 补充：`users/api.ts:49-56` 的 `roleLevel` 字符串分支是死代码——后端 `getAll()` 返回 `role_level as role`（`business-adapter.ts:489`），`Number(user.role)` 恒有限，字符串分支永不命中；两套语义并存易误改。

### 7. [P1·存量（新壳第 10 轮）·中] 新壳整体失去实时刷新
- 旧页面普遍挂 `useRealtimeData({ queryKey, websocketEventTypes, pollingInterval: 60–120s })`（令牌/用户/团队/审计/域名/隧道/安全），后端至今仍在推送 `token_created`、`user_updated`、`team_member_added`、`audit_log_created`、`smtp_updated` 等事件（`routes/users.ts:27-38`、`routes/teams.ts:64-74`、`routes/settings.ts:360-372`）。
- 现状：`client/src/features/**` 与 `client/src/app/**` 零 WebSocket / 零 `useRealtimeData`（仅旧 `pages/domains/{NSMonitorTab,ServiceMonitorTab}` 还在用）；`00-PLAN.md` 未登记「以轮询/焦点刷新替代推送」的决定。
- 影响：令牌被吊销、角色被改、团队新增成员、审计新记录、SMTP 变更都不会自动出现，只能手动点「刷新」；各页 `staleTime` 30–60s，实际表现为「切走再回来才更新」。
- 建议：补统一 `useRealtimeInvalidation`（事件类型 → `invalidateQueries`），或在台账登记该决策并给各页补 `refetchInterval`。

### 8. [P1·本轮引入·高] 改邮箱的反馈通道混淆 + 清空邮箱吃英文 400
- `settings-page.tsx:120-121`：`emailChanged = email.trim() !== '' && email.trim() !== initialEmail`，`canSave` 要求 `!emailChanged || code 非空`。用户改完邮箱后「保存资料」被禁用，唯一可用的是「发送验证码」。
- `:133` 发送成功与`:139` 保存成功调用的是同一个 `onSaved`（顶部绿条），界面上「验证码已发送到新邮箱」与「个人资料已保存」共用一条通道 → 用户会把「已发送」当作「已保存」，离开页面即丢失修改。
- 清空邮箱路径：`email.trim()===''` 使 `emailChanged=false` → 允许提交 `email:''` 且不带 `emailCode`，服务端 `routes/auth.ts:1242-1247` 判定 `nextEmail !== user.email` 后要求验证码，返回 400，前端把英文原文「Valid email verification code is required」直接渲染在页面顶部。
- 建议：拆分两个反馈通道并显式给出禁用原因；`email.trim()===''` 要么禁用保存并提示「邮箱不能为空」，要么要求验证码。补两条用例（现 `settings-page.test.tsx:66-89` 固定先发送再输码，两个问题都被绕过）。

### 9. [P2·本轮引入·高] 绑定行邮箱字段名写错
- `settings/api.ts:12-17` 声明 `external_email`，`settings-page.tsx:76` 读 `binding.external_email`；后端 `business-adapter.ts:1469` 的查询是 `SELECT provider, subject, email, created_at`。结果：所有已绑定账号的邮箱列恒显示「—」（旧页用 `binding.email || binding.subject`）。
- `api.ts:14` 的 `providerName` 后端同样不返回（`settings-page.tsx:75` 已兜底成 `provider`），属冗余声明。

### 10. [P2·本轮引入·高] 团队 mutation 失效范围过大
- `use-teams.ts:45` 的 `invalidate(['team-members'])` / `['member-permissions']` 按**前缀**失效，而查询键是 `['team-members', teamId]`（`:8-15`）、`['member-permissions', teamId, userId]`（`:26-33`）——添加一名成员会让**所有团队**的成员/权限查询全部重取（`:69,77,86,97,108` 五处）。
- 命名也不统一：`['teams']`、`['team-permissions']`、`['team-user-options']`、`['team-domain-options']` 与令牌 `['tokens']`、用户 `['users']`、域名 `['domains', query]` 风格不同；建议 `['teams'] / ['teams', id, 'members']` 并按精确键失效。

### 11. [P2·本轮引入·高] 重复实现未抽公共件 + 令牌有效期精度回退
- `security-tab.tsx:339-351` 与 `access-tab.tsx:224-236` 是逐字相同的 `ToggleRow`；另有多处手写同一套「左标题+副标题 / 右 Switch」行（`security-tab.tsx:86-92,169-175`、`network-tab.tsx:117-123`、`settings-page.tsx:306-319`、`security-page.tsx:527-549`），`ui/` 下没有 `SwitchRow` 原语。
- 日期格式化绕过 `lib/format.ts`（文件头注释即「纯函数，禁止在组件内重复实现」）：`tunnels-page.tsx:93`、`security-page.tsx:386`、`security/api.ts:89` 各自 `new Date(x).toLocaleString('zh-CN')`；`audit-page.tsx:48` 手写 `total.toLocaleString('zh-CN')`（`formatNumber` 已存在）。后果是列表用相对时间、详情用绝对时间，空值表现也不一致（`—` vs 空串）。
- 令牌有效期：`tokens-page.tsx:20-25` 的 `formatWindow` 用 `formatDate`（只到日），旧页 `DatePicker` 带 `enableTimePicker`，有效期精确到秒；新列表把「今天 23:59 到期」与「今天 00:01 到期」显示成同一天。

### 12. [P2·本轮（测试）/ 存量（信封）·高 / 中] 测试盲区与信封语义
- 测试整体质量合格：令牌（`tokens-page.test.tsx:61-86`）、用户（`users-page.test.tsx:57-76`）、设置（`settings-page.test.tsx:91-107`）、系统（`security-tab.test.tsx:58-70`、`access-tab.test.tsx:40-52`）、团队（`teams-page.test.tsx:70-81`）都断言了**提交载荷**；禁用态有 `users-page.test.tsx:47-55`；隧道/域名/审计有空态与筛选断言。没有只断言渲染的空用例。
- 缺口恰好落在第 1、2 条与角色上限上：①`security-tab.test.tsx:44` 把 SMTP mock 成 `{user, from}`，与后端字段同错，第 1 条测不出来；②`tokens-page.test.tsx:79-84` 只断言超管视角的 `max_role: 2`，没有「`currentRoleLevel` 夹取、选项不出现 3」的用例，而 `token-dialog.tsx:38,50` 的 `Math.min(currentRoleLevel, 2)` 会让超管每次签发同级令牌都要手动改；③`teams-page.test.tsx:26,55` 把 `/users` 与 `/domains` 都 mock 成成功，非管理员的 403 路径（第 4 条）无从暴露。
- 信封存量：`lib/http.ts` 只在非 2xx 抛 `ApiError`，尾部仅校验 `typeof envelope.code === 'number'`；后端仍有 24 处 `code: -1`（`routes/{tunnels,auth,webauthn}.ts`、`middleware/{auth,validate}.ts`、3 个 DNS provider adapter），`routes/auth.ts:1220-1233` 的 `PUT /auth/profile` 就是 200 + `code:-1`。新 api 层有的补了 unwrap（`tunnels/api.ts:12-16`、`users/api.ts:29-33`、`teams/api.ts:50-57`），有的没有（`tokens/api.ts:36-61`、`settings/api.ts` 全裸返回），口径不统一是这 11 个提交的共同问题。

## 功能等价性对账

### 已确认保留

| 页面 | 保留项（证据） |
| --- | --- |
| 令牌 `features/tokens` | 列表（名称/域名数/有效期/状态/最近使用）、启停（`tokens-page.tsx:150-161`）、删除二次确认（`:215-228`）、明文一次性展示+复制（`:189-213`）、域名复选与搜索、全选筛选结果/清空（`token-dialog.tsx:196-205`）、服务权限与角色上限（新增能力，后端 `token-policy` 已支持）、创建后失效列表（`use-tokens.ts:15-18`） |
| 安全 `features/security` | TOTP 二维码/密钥/备用码/启用/停用（`security-page.tsx:219-361`）、可信设备单删与全删（`:93-121,163-171`）、通行密钥注册与删除（`:123-144,363-437`，`startRegistration` 链路完整）、安全策略 7 字段+2 开关且仅管理员可见（`:146-153,439-563`）；旧页死接口 `/api/security/sessions` 移除属正确收敛 |
| 设置 `features/settings` | 昵称/邮箱+验证码（`settings-page.tsx:106-183`）、改密（RSA 加密，`:185-236`）、偏好（主题/站内/邮件通知/头像/背景图，`:238-328`）、绑定列表/解绑/发起绑定（`:59-101`）；「显示缩放」「隧道快捷卡」弃用已在台账登记 |
| 审计 `features/audit` | 操作/起止日期筛选、分页、CSV+JSON 导出且参数同源（`api.ts:46-58`）、中文动作标签与未登记动作原样展示（`labels.ts:29-35`）、详情摘要（`labels.ts:38-52`） |
| 团队 `features/teams` | 团队增删改、成员增删、**本轮补齐的成员角色变更**（`teams-page.tsx:134-149`）、团队域名授权（读/写 + `sub` 子域粒度）、成员个人权限查看/新增/移除（`:458-501`） |
| 用户 `features/users` | 列表（昵称/用户名/角色/邮箱/状态/创建时间）、搜索、新建（用户名正则+密码长度）、编辑（昵称/邮箱/重置密码/角色）、启停、删除二次确认；`canModify`（`:67-72`）与 `users.ts:188-198,279-288` 的「超管不可改、同级不可改」一致；`assignableRoles`（`users/api.ts:69-73`）与 `users.ts:105-107` 一致 |
| 系统「安全」 | 登录限制（阈值/锁定时长+失败统计+应急解锁，`security-tab.tsx:49-135` ↔ `settings.ts:513-665`）、安全与敏感信息 4 项（`:216-256` ↔ `settings.ts:304-354`）、审计规则 5 项（`:258-310`，`settings.ts:289-302` 的 `{rules}` 包裹已对上）、MCP 全局开关（`:312-337`）。**SMTP 除外**，见第 1 条 |
| 系统「访问」 | JWT 密钥（密码校验+默认打码+显示切换+复制，`access-tab.tsx:42-104`）、通用 OIDC（12 字段+自动发现，`:106-169`）、Logto 专用（`:171-211`）；字段名与 `settings.ts:155-167` 的必填校验一致 |
| 系统「网络/通知/工作流」 | 连通性测试+代理 SOCKS5/HTTP（`network-tab.tsx` ↔ `routes/network.ts:63,82,173` 方法路径一致）、通知渠道增删改启停按类型渲染字段（`notifications-tab.tsx`）、出站白名单 chips+纯主机名校验+空白名单语义（`workflow-tab.tsx:17-31,66-68` ↔ `settings.ts:675-706` 的 400/422 语义） |
| 系统「概述/数据库」 | 版本、服务端版本、运行时长、时区、CI 标记；数据库类型/版本/驱动版本+维护提示（`system-page.tsx:65-144`） |
| 隧道 `features/tunnels` | 列表（名称/状态/账户/创建时间）、刷新、删除二次确认；删除路径 `/tunnels/:accountId/:tunnelId` 与 `routes/tunnels.ts:137` 一致 |
| 域名列表 | 搜索防抖、账户筛选（只列当前用户账户）、状态筛选、分页、启用停用、删除二次确认、到期天数与过期红标（`domains-page.tsx:163-227`） |

### 确认缺失（需登记或补回）

| # | 缺失项 | 旧实现 | 新现状 | 级别 |
| --- | --- | --- | --- | --- |
| A | 新增域名（手动+从提供商同步） | `DomainListTab` 的 `AddDomainForm` | 无任何创建入口 | P0（第 2 条） |
| B | SMTP 用户名/密码/发件人的**读写** | 旧页 `smtpForm.username/password/fromEmail/fromName` | 三项恒空、输入被丢弃；`fromName`/`secure` 无控件 | P0（第 1 条） |
| C | 域名备注编辑 | 旧「编辑备注」对话框 → `PUT /domains/:id {remark}` | `updateDomain` 只用于切 `enabled` | P1（第 6 条） |
| D | 域名注册状态（WHOIS）与子域标记 | 旧 `whois_status` 列 + `isApexDomain` 徽标 | 字段仍在 `domains/api.ts:12-13` 但未渲染 | P1（第 6 条） |
| E | 域名置顶 | `getPinnedDomains/updatePinnedDomains` + `pinned_domains` 参数 | 无 | P1（第 6 条） |
| F | 域名分组/折叠 | `grouped=true` + `_group_header` | 无（`DomainQuery` 无 `grouped`） | P2 |
| G | 域名类型筛选（顶级域/子域） | `domain_type` 下拉 | `DomainQuery.domain_type` 已声明（`domains/api.ts:38`）但页面无控件 | P2 |
| H | 用户「本人」标记 | `Tag` + 删除按钮 `disabled` | 无 | P2 |
| I | 用户级「要求两步验证」开关 | 旧编辑弹窗 ↔ `/security/users/:id/require-2fa` | 无入口（后端接口仍在） | P2 |
| J | 令牌「编辑」（名称/域名/有效期） | 旧 `EditIcon` → `PUT /tokens/:id` | `updateToken` 有 api+hook 但无 UI | P2 |
| K | 审计 MCP 日志源 | 旧「系统/MCP」切换 + 用户 ID/动作筛选 | 无 MCP 来源（`pages/McpManagement.tsx` 未见等价审计视图，**待核实**是否另有入口） | P2 |
| L | 安全页备用码下载/单码复制 | 旧页 `downloadBackupCodes` / `copyBackupCode` | 新页只在弹窗内平铺展示（`security-page.tsx:277-282`） | P2 |
| M | 系统「强制 HTTPS（即将上线）」占位卡 | 旧 `SecurityTab` 末尾 | 无 | 可接受（占位） |
| N | 令牌「不设到期」复选框 | 旧 `no_expiry` | 新页以空 `datetime-local` 表达，语义等价 | 已对齐 |

## 经核实无问题

1. **新增/删除类操作的信封解包一致**：`tunnels/api.ts:12-16`、`users/api.ts:29-33`、`teams/api.ts:50-57`、`system/security-api.ts:60-64`、`settings/use-settings.ts:5-10`、`security/use-security.ts:6-11` 均在 `code!==0` 时抛错。
2. **403/404/409 仍能正确展示**：非 2xx 一律抛 `ApiError(envelope.msg)`，各页 `catch` 后写入 `error`/`actionError` 并以 `role="alert"` 渲染（`teams-page.tsx:67-71`、`users-page.tsx:93-97`、`tokens-page.tsx:91-95`、`settings-page.tsx:29-33`）。
3. **令牌 `max_role` 上界与后端一致**：`token-dialog.tsx:135` 只渲染 `<= currentRoleLevel` 的选项，`currentRoleLevel` 取自 `/auth/me` 的 `role_level`（`business-adapter.ts:480`），与 `token-policy.ts:27-29` 的 403 对齐；默认值偏保守（第 12 条），不会触发 403。
4. **令牌至少选一个域名与服务端一致**：`token-dialog.tsx:85-88` 前置拦截，`routes/tokens.ts:149-152` 也要求非空；旧页「空数组=全部域名」的歧义已双向消除（`routes/tokens.ts:100` 的 swagger 仍写「empty array means all domains」，属文档残留）。
5. **用户页权限口径与服务端一致**：`canModify`（`users-page.tsx:67-72`）对超管返回不可改、对管理员要求 `level < myLevel`，与 `users.ts:188-198` 一致；`users.ts:211-213` 的局部更新语义使「内联停用」只提交 `{status}` 是安全的（不会清空昵称/邮箱）。
6. **管理页全部走 `RequireAdmin`**：`App.tsx` 把 `dash/{users,audit,workflows}` 与 `dash/system{,/database,/security,/access,/network,/notifications,/workflow}` 包在同一个 `<Route element={<RequireAdmin />}>` 内；`app/require-admin.tsx:6-14` 基于 `useSession` 单一口径，与 `nav.ts` 的 `adminOnly` 覆盖一致（`/dash/mcp` 例外，属既有设计）。
7. **审计导出与列表同源**：`audit/api.ts:46-58` 复用同一组参数名，`routes/audit.ts:131,178` 共用 `getAuditFilters`，不会「列表筛了、导出没筛」。
8. **系统「访问」字段与后端对齐**：OIDC 12 个字段名与 `settings.ts:155-167` 必填校验项一致；`applyOAuthTemplate` 自动补 Logto 端点；`oidc-discover` 结果增量合并（`access-tab.tsx:117-118`）。
9. **网络代理方法与路径一致**：`GET/POST /network/proxy` 对应 `routes/network.ts:63,82`（旧客户端也是 POST）；`useConnectivity` 由 `useQuery` 改 `useMutation` 更贴合「点一次测一次」。
10. **令牌 api 对返回形态有防御**：`tokens/api.ts:36-45` 兼容数组与 `{list}`；`isTokenActive`（`:63-65`）兼容 `boolean|number|undefined`，与 `service/token.ts:128` 的 `!!t.is_active` 不冲突；`roleLabel` 对 `undefined/0` 的分支（`tokens-page.tsx:13-18`）与后端 `max_role` 可为 0 的语义一致。
11. **残留检查通过**：`client/src/features/**` 内 `tdesign` / `i18next` / `useI18n` / `useToast` / 旧 `api/index` 零命中（仅测试引用自家 `../api`）；11 个提交删除的旧页面无残留 import。基线 HEAD 上仍在打包的旧件只有 `components/{Modal,Table,ConfirmDialog}`（被 `pages/{McpManagement,Workflows,MailSetupModal}` 与 `pages/domains/{NSMonitorTab,ServiceMonitorTab}` 使用，`features/domains/monitoring-page.tsx:4-6` 仍挂这三个旧组件；**工作区已有未提交的 NS 监控迁移**，该子项待复核）；`components/{PaginatedSelect,Avatar,PageTransition}` **零引用**，属死代码，「00-PLAN.md」§4 P5 的「旧文件零残留」尚未达成。
12. **`queryKey` 失效链在页内闭合**：令牌（`use-tokens.ts:15-18`）、用户（`use-users.ts:8-11`）、域名（`use-domains.ts:19-25` 额外失效 `['dashboard']`）、审计（键含整个 query 对象，筛选变化自然重取）、设置（`use-settings.ts:24,39,47` 分别失效 `session/preferences/oauth-bindings`）都能在操作后刷到新数据；跨页联动符合预期。团队的超范围失效见第 10 条。
