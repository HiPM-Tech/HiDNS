# 前端重构收口阶段独立评审（第三轮）

评审对象：`d30315f`（P5 依赖收口）、`190786f`（路由级代码拆分）、`ad11455`（Auth 同意页 + 删 pages/）、`01333e6`（安装向导/回调）、`b9b4be5`（MCP 页）、`b88fe9c`（工作流页）。
评审方式：`git show` 逐提交读 diff + 现状代码通读 + 五道自跑门禁（`tsc --noEmit`、`tsc -b --force`、`npm run build`、`vite build`、`vitest run`、`eslint .`）。只读，未改任何源码。

## 范围

- 提交范围：上述 6 个提交（HEAD 为 `190786f`），以及它们依赖的 `client/src` 现状（166 个文件）。
- 核查维度：①上下文删除后的运行时等价性 ②路由/鉴权与 Suspense ③数据层信封与 queryKey 一致性 ④死代码与残留 ⑤测试保护面 ⑥文档一致性。
- 不在范围：后端业务逻辑、DNS 适配器、数据库层（仅在需要判定前端行为时引用后端契约）。
- 证据来源标注：`[FACT]` 可复现（命令/diff/代码行）、`[INFERENCE]` 由代码推导、`[待核实]` 未能验证。

## 结论

本轮「删旧实现 + 路由拆分」的机械目标基本达成（依赖删净、pages/ 清零、主包 619 kB→218 kB），但**契约层有两处硬断裂**：MCP 同意页与后端响应信封不符（功能必失败）、`http.patch` 从未存在（令牌启停/续期开关点击即 TypeError），两者都被 mock 型用例掩盖成"绿"。
更关键的是**门禁已空转**：`npx tsc --noEmit` 在 solution 式 tsconfig 下不检查任何文件、退出 0，而 `npm run build` 实际退出 2（10 条类型错），因此台账里反复出现的"tsc 0 错、build 通过"自 P5 起不成立。
主题（原 ThemeContext）在收口后退化为"三份独立 state + 无根挂载点"，/login、/setup、/oauth/* 完全不应用已存主题，属可见回归；实时刷新与 Toast 也各留了未收口的一角。

## 发现表

| # | 级别 | 标记 | 结论 | 位置 | 置信度 |
|---|---|---|---|---|---|
| 1 | P0 | 本轮引入 | MCP 同意页同意/拒绝必失败：后端返回裸 `{redirect_url}`，前端判「非信封」直接抛错 | `client/src/lib/http.ts:98-101` / `client/src/features/oauth/mcp-consent-page.tsx:38-47` / `server/src/routes/mcp-oauth.ts:401,408,414,438` | HIGH |
| 2 | P0 | 本轮引入+存量 | 类型门禁空转；`npm run build` 退出 2（10 错），其中 `hooks/useRecords.ts` 断链由本轮删 `src/api` 造成 | `client/tsconfig.json:2-6` / `client/package.json:11` / `client/src/hooks/useRecords.ts:8,38` | HIGH |
| 3 | P0 | 存量 | `http.patch` 不存在：令牌启停、域名续期开关点击即 TypeError（用例把自身函数 mock 掉，假绿） | `client/src/lib/http.ts:114-119` / `features/tokens/api.ts:60` / `features/domains/renewal-api.ts:51` | HIGH |
| 4 | P1 | 本轮引入 | 主题无唯一来源：3 份独立 `useThemeMode` 实例互不同步；/login、/setup、/oauth/* 完全不应用已存主题 | `app/app-shell.tsx:40` / `features/settings/settings-page.tsx:255,294` / `features/marketing/landing-page.tsx:4` / `lib/theme.ts:34-53` | HIGH |
| 5 | P1 | 本轮引入 | 同意页 `return_to` 是死链：新登录页不读该参数，未登录用户授权流程登录后被丢到 /dash | `features/oauth/mcp-consent-page.tsx:64,72` / `features/auth/login-page.tsx:40` | HIGH |
| 6 | P1 | 本轮引入 | `/dash/mcp` 全局开关对非管理员可见可点，但 `/api/mcp/config` GET/PUT 均 adminOnly → 必 403 且状态误显示为「已关闭」 | `features/mcp/mcp-page.tsx:30,91-97` / `server/src/routes/mcp-config.ts:122,158,178` | HIGH |
| 7 | P1 | 存量 | 写接口信封校验覆盖不一致（23 个 api 模块，仅 8 个用 `ensureOk`），后端仍留 8 处「200+code:-1」→ 两处必现假成功 | `features/tunnels/api.ts:24` / `features/settings/api.ts:23` / `server/src/routes/tunnels.ts:162,165` / `server/src/routes/auth.ts:1223,1231` | HIGH |
| 8 | P1 | 存量 | realtime 事件→queryKey 映射有缺口：`ns_monitor_prefs_updated`、`2fa_enabled/disabled` 无映射；`['domain',id]` 永不被失效；覆盖用例只抽检 12 个事件 | `app/realtime.tsx:13-64` / `features/records/use-records.ts:9` / `server/src/routes/ns-monitor.ts:195` / `server/src/routes/security.ts:204,244` / `app/__tests__/realtime.test.tsx:79-87` | HIGH |
| 9 | P1 | 本轮引入 | 路由/守卫零测试：删掉 `ProtectedRoute.test.tsx`(59 行) 未替换，105 条用例中无一条覆盖 App 路由表、`RequireAdmin`、`ProtectedShell`、主题 | `client/src/App.tsx:57-97`（对照 `d30315f` 删除项） | HIGH |
| 10 | P1 | 存量+本轮 | 文档与代码相反：`root.ai.md` §客户端架构仍写 contexts/pages/i18n/api、11 语言、i18next、Context API；路由表无 /dash 前缀；台账 eslint「39 warning」≠ 实测 22；门禁空转未登记 | `root.ai.md:515-516,581-640,719-735,758-777` / `docs/refactor/00-PLAN.md:76,87,88` | HIGH |
| 11 | P2 | 本轮引入 | 死代码/残留 9 处（`styles/theme.ts` 152 行、`App.css`、`config/gravatar.ts`、`require-session.tsx`、Toast 全链路零生产者、`consentApi()`、vitest coverage 指向已删路径、vite tdesign/i18n vendor 分支、根目录 i18n 校验脚本已崩） | 见 §11 | HIGH |
| 12 | P2 | 本轮引入 | 工作流启停 `void toggle.mutateAsync(...)` 无 catch、无乐观回滚 → 失败无提示且开关静默回弹 | `features/workflows/workflows-page.tsx:125-130` | MEDIUM |

## 逐条详情

### 1 · P0 · 本轮引入 · MCP 同意页端到端不可用（HIGH）

`[FACT]` 后端 `POST /api/mcp/oauth/authorize` 四个成功分支全部是裸对象、无信封：

```ts
// server/src/routes/mcp-oauth.ts:438（其余 401/408/414 同形）
res.json({ redirect_url: redirectUrl });
```

`[FACT]` 前端唯一出口要求信封，缺 `code` 直接抛：

```ts
// client/src/lib/http.ts:98-101
const envelope = payload as ApiEnvelope<T> | undefined;
if (!envelope || typeof envelope.code !== 'number') {
  throw new ApiError('Malformed API response', { status: response.status, data: payload });
}
```

`[FACT]` 同意页据此取 `envelope.data.redirect_url`（`mcp-consent-page.tsx:45-48`），因此「同意」与「拒绝」两条路径都必然进入 `catch`，页面显示「Malformed API response」，`window.location.href` 永不执行——即 `ad11455` 交付的核心页面没有任何一条成功路径。

`[FACT]` 该页面用例把 `http` 整体 mock 并喂了合规信封，等于把被测契约替换掉了：

```ts
// features/oauth/__tests__/mcp-consent-page.test.tsx:6,37-40
vi.mock('../../../lib/http', () => ({ http: { post: vi.fn() } }));
vi.mocked(http.post).mockResolvedValue({ code: 0, msg: 'success', data: { redirect_url: 'http://127.0.0.1:8765/cb?code=abc' } });
```

失败路径：真机上 MCP 客户端（Claude Desktop 等）发起授权 → 用户点同意 → 报错 → 授权码从不签发。修法二选一（需与后端 owner 确认哪边是权威）：后端改 `sendSuccess(res, { redirect_url })`（该文件已有 8 处 `sendSuccess`，改法自洽），或前端按 OAuth 裸响应特例解析；无论哪种，用例必须改为对真实 `http.ts` + `fetch` 桩的响应体断言。

### 2 · P0 · 本轮引入+存量 · 类型门禁空转、构建红（HIGH）

`[FACT]` 自跑结果（本机 HEAD）：

```
$ cd client && npx tsc --noEmit          → GATE_EXIT=0（无任何输出）
$ cd client && npx tsc -b --force        → BUILD_TSC_EXIT=2，10 条 error TS
$ cd client && npm run build (=tsc -b && vite build) → NPM_RUN_BUILD_EXIT=2
$ cd client && npx vite build            → 通过，index-*.js 218.30 kB / gzip 68.51 kB
```

`[FACT]` 空转原因：`client/tsconfig.json` 是 solution 式配置（`"files": []` + `references`），`tsc --noEmit` 在这个 project 上没有任何输入文件，因此**永远退出 0**；真正检查的是 `tsc -b`（`package.json:11` 的 `build` 与编辑器的 tsconfig.app.json 都走它）。而 `00-PLAN.md:76` 与台账反复引用的门禁恰是无效的那条。

`[FACT]` 10 条错误的归属（逐一 `git log` 追溯）：

| 错误 | 引入提交 | 归属 |
|---|---|---|
| `hooks/useRecords.ts:8 Cannot find module '../api'`、`:38 implicit any` | `d30315f` 删除 `src/api/` | **本轮引入** |
| `app/__tests__/realtime.test.tsx:14`（参数属性语法 vs `erasableSyntaxOnly`） | `1ce1468` | 存量 |
| `features/tokens/api.ts:60`、`domains/renewal-api.ts:51`（`http.patch` 不存在） | `ea0f333` / `de629b3` | 存量（见 #3） |
| `domains/service-monitor-api.ts:56`（`timeoutMs` 不在 `RequestOptions`） | `eb0c449` | 存量 |
| `accounts/use-accounts.ts:35`、`records/use-records.ts:46`、`teams/use-teams.ts:51`（mutate 返回值联合类型）、`system/system-page.tsx:80`（可能为 null） | 各自迁移提交 | 存量 |

`[FACT]` 因此 `d30315f` 提交信息里的「client tsc 0 错、vite build 通过」与 `00-PLAN.md:88` 的同一表述均不成立：它引用的命令是空转的那条。这同时违反 `root.ai.md:21`（"完全依赖日志/未仔细检查，直接按 P0 上报"）。

失败路径：类型安全对 `src/**` 全量失效已达 30+ 提交（#3 的两个运行时 TypeError 就是被它漏掉的），任何后续页面新增都不会被拦。

### 3 · P0 · 存量 · `http.patch` 不存在，两个功能点击即崩（HIGH）

`[FACT]` `lib/http.ts:114-119` 只导出 `get/post/put/delete`；`http.patch` 为 `undefined`：

```ts
// features/tokens/api.ts:59-61
export function toggleTokenStatus(id: number, isActive: boolean) {
  return http.patch<null>(`/tokens/${id}/status`, { is_active: isActive });  // TypeError: http.patch is not a function
}
// features/domains/renewal-api.ts:51 同形
toggle: (id, enabled) => http.patch<null>(`/domains/renewable-domains/${id}/toggle-enabled`, { enabled }),
```

`[FACT]` 后端确实用 PATCH（`server/src/routes/tokens.ts:287`、`routes/domains.ts:1687`），所以是前端客户端缺方法。调用链：`tokens-page.tsx:163`（启用/停用按钮）→ `handleToggle`(`tokens-page.tsx:42-48`，捕获后 `setActionError`，用户看到原始英文 `http.patch is not a function`）；`renewal-tab.tsx:60-64` 同。

`[FACT]` 两处用例都把**被测函数本身** mock 掉，所以永远是绿的：`tokens/__tests__/tokens-page.test.tsx:18 toggleTokenStatus: vi.fn()`、`domains/__tests__/renewal-tab.test.tsx:15 toggle: vi.fn()`（后者 `:65-72` 还断言了 mock 被调用）。

修法：`http` 增 `patch`（3 行）；用例改为对 `lib/http` 桩断言 method 与 URL，而不是 mock 业务函数。

### 4 · P1 · 本轮引入 · 主题/缩放失去唯一来源（HIGH）

`[FACT]` 删除 `ThemeContext` 后，主题状态退化为"谁用谁建"的三个独立 `useState`：

- `app/app-shell.tsx:40` `const { mode, cycle } = useThemeMode();`（顶栏按钮 `:158-160`，`title={`主题：${mode}`}`）
- `features/settings/settings-page.tsx:255`（`:294` 的 `<Select value={theme.mode}>`）
- `features/marketing/landing-page.tsx:4`（落地页切换按钮）

三者共享 localStorage 键 `'theme'` 与 `applyTheme`（`lib/theme.ts:34-53`），但**不共享状态**。`[INFERENCE]` 在 `/dash/settings` 两个实例同时挂载：用设置页把主题改成「深色」后，顶栏图标的 `mode` 仍是旧值（`System`），再点顶栏按钮会按旧状态循环出错误的下一个主题；反向亦然。

`[FACT]` 更实际的一处：`/login`、`/setup`、`/oauth/callback`、`/oauth/authorize` 四个路由的组件树里**没有任何** `useThemeMode`，`index.html` 也没有预置主题脚本 → 存了 dark 的用户打开登录页一定先看到浅色，登录后再闪成深色。对照 `d30315f^` 的 `App.tsx:41`（`<ThemeProvider>` 挂在根上，全站生效），这是本轮删除 Context 直接带来的行为差。

`[FACT]` 缩放：`UiScaleContext` 已删，但 `styles/globals.css:74` 仍对 `#root` 施加 `zoom: var(--app-ui-scale)`（0.9），`ui/tokens.css:28` 用 `--shell-h: calc(100dvh / var(--app-ui-scale, 1))` 补偿——这与台账「UiScale 仅作为兼容变量保留」一致，判定为**设计内固定 0.9**，不列为缺陷，但 `root.ai.md` 未记录该口径（并入 #10）。

修法：`useThemeMode` 升级为模块级 store（`useSyncExternalStore`）或恢复一个根 Provider；`index.html` 加 3 行内联脚本按 localStorage 预置 `dark` class。

### 5 · P1 · 本轮引入 · 同意页 `return_to` 死链（HIGH）

`[FACT]` 新同意页会把未登录用户送去带参数的登录页：

```ts
// features/oauth/mcp-consent-page.tsx:64,72
const returnTo = '/oauth/authorize?' + params.toString();
<Button onClick={() => navigate('/login?return_to=' + encodeURIComponent(returnTo))}>去登录</Button>
```

`[FACT]` 而新登录页从不读该参数，成功即整页跳控制台：

```ts
// features/auth/login-page.tsx:40
const defaultOnSuccess = () => window.location.assign('/dash');
```

`[FACT]` 被迁掉的旧登录页（`git show 807cd4a^:client/src/pages/Login.tsx:15-16`）本来是读的：`const returnTo = searchParams.get('return_to') || '/dash';`。也就是说 `ad11455` 的提交信息「未登录先引导登录并保留 return_to」只做了一半——参数一路传过去，落地端早已不认。

失败路径：MCP 客户端发起授权 → 用户未登录 → 登录成功 → 落在 /dash，授权请求丢失，用户必须回客户端重开流程。

### 6 · P1 · 本轮引入 · `/dash/mcp` 全局开关对非管理员开放（HIGH）

`[FACT]` 页面无任何 admin 判定，`全局开关` 卡片无条件渲染：

```tsx
// features/mcp/mcp-page.tsx:30,91-97
const config = useQuery({ queryKey: ['mcp', 'config'], queryFn: mcpApi.globalConfig });
{config.isLoading ? <Skeleton/> : <Switch checked={Boolean(config.data?.enabled)} onCheckedChange={...} />}
```

`[FACT]` 后端这三个端点是 adminOnly（`server/src/routes/mcp-config.ts:122,158,178`），密钥与 OAuth 客户端（`routes/mcp-apikeys.ts`、`routes/mcp-oauth.ts`）不是。所以普通用户看到的是：密钥/客户端正常、全局开关恒显示「关闭」（查询 403 → `data` 为 undefined）且点击必报 `Admin access required`（英文原文直出）。

`[FACT]` 对照同仓正确写法：`features/security/security-page.tsx:15,29` 用 `isAdminUser(user)` 收起了管理员区域——说明本页漏了同一守卫，不是设计选择。修法：与 security 页一致，按 `isAdminUser` 条件渲染该卡片，或把该卡片挪进系统页。

### 7 · P1 · 存量 · 写接口信封校验不一致，存在必现假成功（HIGH）

`[FACT]` 23 个 feature api 模块里，只有 8 个（`mcp/api`、`workflows/workflows-api`、`domains/service-monitor-api`、`system/network-api`、`system/security-api` 部分、`setup/setup-api`、`realtime`）用了 `ensureOk`；其余写接口直接返回 `http.post/put/delete` 的 envelope，调用方只拿到 HTTP 层结果。抽样（`文件:行`）：

```
accounts/api.ts:63,67,71        domains/api.ts:82,91,95        records/api.ts:85,89,93,97,112
security/api.ts:50,57,58,62,66,71,72   settings/api.ts:23,24,26,30,34   teams/api.ts:63-85
tokens/api.ts:48,52,56,60       tunnels/api.ts:24             users/api.ts:40,41,42
domains/renewal-api.ts:50,51,52,58    system/security-api.ts:72,76,90,94
```

`[FACT]` 这不是纯风格问题：后端仍有 8 处「HTTP 200 + code:-1」（`grep -rn "res.json({ code: -1" server/src/routes`）：

| 后端位置 | 触发条件 | 前端未校验的调用 | 用户可见后果 |
|---|---|---|---|
| `routes/tunnels.ts:162,165` | 删除失败/异常 | `tunnels/api.ts:24` → `tunnels-page.tsx:23-31` | `mutateAsync` 正常 resolve → `setPendingDelete(null)` 关窗、列表刷新后条目还在、**无任何错误提示** |
| `routes/auth.ts:1223,1231` | `Nothing to update` / `User not found` | `settings/api.ts:23` → `settings-page.tsx:149` | 弹「个人资料已保存」，实际未改 |

`[INFERENCE]` 其余写接口当前不会误报（后端错误已走 `sendError`），但 P1-3 的整改只覆盖了一半模块，下一次后端回退到 200 信封时同类问题会再次静默。

修法：把「写」统一为 `ensureOk(await http.x(...))`（或让 `request()` 在 method≠GET 时默认严格），并让 `tunnels`/`tokens`/`auth` 的 200 分支改用 `sendError`。

### 8 · P1 · 存量 · realtime 映射表缺口与其"覆盖用例"的假保障（HIGH）

`[FACT]` 后端在用 `wsService` 发送的事件共 33 种，前端 `EVENT_QUERY_MAP`（`app/realtime.tsx:13-64`）覆盖 29 种，缺 4 种：

| 事件 | 后端发送点 | 应失效的 key | 现状 |
|---|---|---|---|
| `ns_monitor_prefs_updated` | `routes/ns-monitor.ts:195` | `['ns-monitors']` | 无映射，其它端改偏好后列表不刷新 |
| `2fa_enabled` / `2fa_disabled` | `routes/security.ts:204,244` | `['security','2fa']` | 无映射，多端不一致 |
| `resource:snapshot` | `service/resource/job.ts:22` | — | 后端仍在广播，前端已无消费者（旧 ResourcePanel 已删），属孤儿事件 |

另外映射**目标 key 本身覆盖不到**的两处：`['domain', domainId]`（`features/records/use-records.ts:9`，域名详情）没有任何事件指向它，只能在页面内手动失效（`use-records.ts:50,63`）；`['tokens','…']` 之外的多级 key（如 `['mcp','keys']`）也没有服务端事件（MCP 密钥变更不广播），登出/多标签场景靠 staleTime。

`[FACT]` 声称为"覆盖关键事件"的用例只抽检 12 个名字（`app/__tests__/realtime.test.tsx:79-87`），因此 `ns_monitor_prefs_updated` 缺失一直没被发现：

```ts
for (const type of ['token_created', ..., 'ns_monitor_updated', 'tunnel_deleted', 'smtp_updated']) {
  expect(EVENT_QUERY_MAP[type], type).toBeDefined();
}
```

修法：把映射表补 3 个事件；用例改为"从后端事件清单文件快照比对"（或至少断言 `Object.keys(EVENT_QUERY_MAP).length` 与清单一致），否则该用例只是自我确认。

### 9 · P1 · 本轮引入 · 路由与守卫零测试（HIGH）

`[FACT]` `d30315f` 删除了 `components/ProtectedRoute.test.tsx`（59 行，唯一一条守禁用例）与旧 `ProtectedRoute`；`190786f` 随后重排整张路由表（`App.tsx:57-97`：3 层嵌套 + 19 条 lazy + 1 个 Suspense + `*→/` 兜底）。当前 105 条用例（29 文件）中，`grep -rl "ProtectedShell|RequireAdmin" --include=*.test.*` 为空——**新的鉴权链没有任何测试**。

`[FACT]` 现状本身是对的（这一条不是缺陷而是保护缺口）：我逐条对过 `App.tsx:81-92` 的 `RequireAdmin` 子路由与 `app/nav.ts:40,47,48,57` 的 `adminOnly` 标记、以及后端 adminOnly，三者一致（users/audit/workflows/system* 全部在守卫内，nav 也只对这些项打标）。但这条"对"是本次人肉核对出来的，机器不设防。

`[FACT]` 主题、Toast、UiScale 同样零用例：`grep -rl "useThemeMode|useToast|addToast" --include=*.test.*` 为空。台账 `00-PLAN.md:111` 声称"P0 恢复通行密钥登录与 SSO 入口（含回归用例）"仅还原了登录页入口，主题/Toast 从未有过用例。

建议补 4 条即可闭环：①非管理员访问 `/dash/users` 重定向 /dash；②未登录访问 `/dash` 重定向 /login；③`/dash` 首屏 lazy 加载后 shell 与页面同时出现；④主题在 /login 与 /dash 间一致（配合 #4 的修法）。

### 10 · P1 · 存量+本轮 · 文档漂移（HIGH）

`[FACT]` `root.ai.md`（自称第一权威，`:4`）与现状逐条冲突：

| 文档 | 行 | 文档写的 | 现状 |
|---|---|---|---|
| 技术栈 | 515-516 | Context API（Auth/Theme/I18n/UiScale）+ i18next + 11 语言包 | 四个 Context 与 i18n 已全删，单一简体中文 |
| 目录结构 | 581-640 | `contexts/`、`pages/`、`i18n/locales/`、`api/`、`components/` 清单 | 全部不存在；现为 `app/ features/ lib/ ui/ copy/` |
| 国际化规范 | 719-735 | 强制 `useI18n()` + `i18n/locales/` + 提交前跑 `check_i18n_simple.js` | 该脚本读 `client/src/i18n/locales`，目录已删 → 直接 `ENOENT` 崩；且与 `00-PLAN.md:55` 的"抛弃 i18next"决策相反 |
| 路由表 | 758-777 | `/dashboard`、`/accounts`、`/domains`（无 /dash 前缀）、无 /login | `/dash/*`、`/login`、`/oauth/authorize`、`/setup` |
| 表单规范 | 655-670 | 强制 `useFormSync` | `hooks/useFormSync.ts` 已删，改 RHF（`00-PLAN.md:54` 已声明替代，但 root.ai.md 未同步） |

`[FACT]` `00-PLAN.md` 台账两处与实测不符：`:88` "eslint 0 error / 39 warning"（实测 `npx eslint .` = **0 error / 22 warning**）；`:76` 门禁命令 `tsc --noEmit` 空转（见 #2），据此得出的"client tsc 0 错"整列失效。`grep tdesign client/src` 为空这条属实（`vite.config.ts:34-35` 仍有 tdesign/i18n 分支，但在 `client/src` 之外，未违背该条字面）。

`[FACT]` 其他文档残留（均在本次提交范围内被删文件）：`docs/WORKFLOW_ENGINE_DESIGN.md:1646,1650`、`docs/WORKFLOW_ENGINE_NAMESPACE_PLAN.md:367` 仍指 `client/src/pages/`、`client/src/i18n/`、`client/src/api/workflows.ts`；`docs/CHANGELOG.md` 属历史记录，不必回改。

### 11 · P2 · 本轮引入 · 死代码与残留 9 处（HIGH）

| # | 对象 | 证据 | 性质 |
|---|---|---|---|
| a | `src/hooks/useRecords.ts` | `:8 import { recordsApi } from '../api'`（`src/api/` 已删）→ 唯一被本轮新增的类型错误 | 断链死代码（并入 #2 的 P0） |
| b | `src/styles/theme.ts`（152 行） | `grep -rn "styles/theme"` 无引用；与 `lib/theme.ts`、`ui/tokens.css` 三套颜色口径并存 | 死代码 |
| c | `src/App.css`（1 行注释） | `main.tsx:3` 只 import `./index.css` | 空文件残留 |
| d | `src/config/gravatar.ts` | 零引用（`utils/gravatar.ts` 已删，此配置文件没人读） | 死代码 |
| e | `src/features/session/require-session.tsx` | 零引用（实际守卫是 `app/protected-shell.tsx` + `app/require-admin.tsx`） | 死代码，与现有守卫重复 |
| f | `src/hooks/useToast.ts` + `src/components/ToastContainer.tsx` | 全仓零生产者：`grep "useToast(\|addToast("` 仅命中自身；`app-shell.tsx:207-208` 的注释「旧页面 toast 依赖这个容器」已过时（所有页面改用内联 `role="alert"`） | 死链路（含全局 store + 挂载点） |
| g | `features/oauth/consent-api.ts:26-28` | `export function consentApi() { return http; }` 零引用，页面直接 import `http` | 死导出 |
| h | `client/vitest.config.ts:14` | `coverage.include: ['src/pages/Workflows.tsx','src/utils/workflows.ts','src/components/workflows/**']` 三条路径全已删除 | 配置残留（跑 coverage 会告警/空报表） |
| i | `client/vite.config.ts:34-35` + `client/src/test/setup.ts:4,6` + 根 `check_i18n_simple.js:4`、`check_i18n_keys.js` | manualChunks 仍分 `tdesign-vendor`/`i18n-vendor`（依赖已删，永远不命中）；setup.ts 注释仍称"TDesign 组件挂载会用 matchMedia"并写死 `localStorage.locale`；两个 i18n 校验脚本读已删目录必崩 | 残留 |

### 12 · P2 · 本轮引入 · 工作流启停失败静默（MEDIUM）

`[FACT]` 同文件里其它动作都走 try/catch 或 `run()` 包装，只有启停是裸的：

```tsx
// features/workflows/workflows-page.tsx:125-130
<Switch checked={Boolean(row.enabled)}
  onCheckedChange={(checked) => { void toggle.mutateAsync({ id: row.id, enabled: checked }); }} />
```

`[INFERENCE]` `void` 丢弃了 rejection → 未处理 Promise 拒绝（控制台报错），页面无 toast/提示；`checked` 完全由服务端数据驱动且 `onSuccess` 才 `invalidate`，所以失败时开关会静默回弹，用户以为"点了没反应"。对照 `mcp-page.tsx:95` 用 `run(...)` 包了一层，属同批实现不一致。修法：`onCheckedChange={(c) => void run(() => toggle.mutateAsync({...}), '已更新')}`。

## 回归风险清单

按"用户能做什么会踩到"排序，全部可在本地复现：

1. **MCP 客户端授权永远失败**（#1）：任何 MCP 客户端走浏览器授权 → 点同意 → 报 Malformed API response。
2. **令牌启停 / 续期开关一点就报错**（#3）：/dash/tokens 行内「停用」、/dash/domains/renewal 的自动续期开关 → 红字 `http.patch is not a function`。
3. **隧道删除"删掉了又回来了"**（#7）：删除失败时弹窗关闭、无提示、条目仍在。
4. **个人资料假保存**（#7）：什么都不改直接点保存 → 「已保存」，实际后端回 `Nothing to update`。
5. **深色用户看登录页是白屏闪**（#4）：localStorage 有 dark，直接访问 /login、/setup、/oauth/callback → 全程浅色，登录后才切换。
6. **设置页改完主题，顶栏图标不对**（#4）：`/dash/settings` 两个 `useThemeMode` 实例不同步，顶栏 `title`/图标停留在旧模式。
7. **未登录走授权流程后回不去**（#5）：登录成功落到 /dash，MCP 授权页丢失。
8. **普通用户看到不可用的全局开关**（#6）：/dash/mcp 开关恒"关闭"，点击报英文 403。
9. **构建门禁继续放行**（#2）：`npm run build` 现在就是红的，若 CI 用的是文档里的 `tsc --noEmit`，会一直绿。
10. **工作流启停静默失效**（#12）；**NS 监控偏好改了别人看不到**（#8）。
11. **未来任何页面新增都不会被类型检查兜住**（#2 的组合后果），且守卫/主题无测试兜底（#9）。

## 经核实无问题

以下为逐项核实后**判定无缺陷**的结论，附证据，供下一轮免于重复核对：

1. **Suspense 边界不会导致外壳闪烁或实时连接重建**（评审预设的怀疑不成立）。`App.tsx:57` 的 Suspense 在 `<Routes>` 之上，若按传统 setState 语义会整棵卸载；但 `react-router-dom@7.14.0` 的 `BrowserRouter` 默认把所有 location 变更包进 `startTransition`（`node_modules/.pnpm/react-router@7.14.0…/dist/development/chunk-QFMPRPBF.mjs:10054-10080`：`unstable_useTransitions === false ? setStateImpl : startTransition(...)`），因此页内跳转期间旧页面保持可见、`AppShell`/`RealtimeProvider` 不重挂、WS 不重连。硬刷新时整棵树一次性挂载，fallback 只出现一次，符合预期。
2. **鉴权不闪烁、不重复请求**：`ProtectedShell`(`:8-35`) 先判 `isLoading`→`isError`→`!user`，内层 `RequireAdmin`(`:9-15`) 复用同一 `['session']` query（同 key 去重）+ `session/api.ts:14-38` 的 3 秒 `meCache` 单飞，实测无重复 `/auth/me`。5xx 不会被当成未登录（`:26-28` 只把 401 转 null）。
3. **管理页守卫覆盖完整**：`App.tsx:81-92`（users/audit/workflows/system 六页）⊂ `nav.ts` 的 `adminOnly` 集合，与后端 `adminOnly` 一致（`/dash/mcp` 例外见 #6）。
4. **依赖确实删净**：`package.json` 已无 tdesign-react/tdesign-icons-react/i18next/react-i18next/axios；`grep -rn "tdesign|i18next|axios" client/src` 为空；`main.tsx` 不再引 tdesign CSS。
5. **`pages/` 目录与旧 CSS 清零**：`client/src` 无 `pages/`；`Login.css`/`Setup.css`/`Workflows.css` 随提交删除。
6. **路由级拆分真实生效**：`vite build` 产出 38 个 chunk，主包 `index-*.js` 218.30 kB / gzip 68.51 kB（台账 619 kB→218 kB 属实），`ui-*.js` 136 kB、`react-vendor` 181 kB 合理分块。
7. **用例全绿**：`npx vitest run` = 29 文件 / 105 用例通过（与台账 `00-PLAN.md:88` 的 105 一致；`:89-95` 的 167/160/156 是删除前历史值，非矛盾）。
8. **eslint 无 error**：`npx eslint .` = 0 error / 22 warning（warning 数台账写 39，见 #10）。
9. **工作流手动运行 `domainId: 0` 不是 bug**：后端在 `domainId<=0 && domainName` 时按名称反查并回填（`server/src/routes/workflows.ts:465-484`），前端 `workflows-page.tsx:404-408` 传 `domainId:0 + domainName` 与契约自洽。
10. **安装向导"已初始化自动跳登录"实际生效**（我最初怀疑 `Promise.all` 会因 `/init/db-config` 403 而整体拒绝，核实后不成立）：`setup-api.ts:64-70` 的 `dbConfig` 内部 catch 返回 `null`，`Promise.all` 不会 reject，`setup-page.tsx:41` 能正常 `navigate('/login')`。
11. **安装向导的步骤门槛正确**：「下一步」在未测试连接前禁用（`setup-page.tsx:212`）；已有数据时必须走显式「重置并初始化」（`:218-225`），与 `/init/database` 的 `reset` 语义一致。
12. **OAuth 回调页契约正确**：`POST /auth/oauth/callback` 返回标准信封（`routes/auth.ts` 内 `res.json({code:0,data:{mode}})` 四处），`oauth-callback-page.tsx:57-64` 的 `code`/`state` 单次兑换 + `sessionStorage` 去重成立。
13. **主题存储键兼容**：`lib/theme.ts:6,23-32` 用 `'theme'` + `'auto'` 与旧 `ThemeContext` 双向兼容，`applyTheme` 同时设 `dark` class 与 `colorScheme`。
14. **无遗留的旧上下文引用**：`grep -rn "useI18n|useAuth|useThemeContext|useUiScale|contexts/"` 在 `client/src` 为空，删除面无悬挂引用（唯一断链是 #11a 的 `hooks/useRecords.ts`）。

## 附录 · 复核命令

```bash
cd client && npx tsc --noEmit; echo $?         # 0：空转（tsconfig files: []）
cd client && npx tsc -b --force; echo $?       # 2：10 条 error TS
cd client && npm run build; echo $?            # 2：build 实际失败
cd client && npx vite build                    # 通过，主包 218.30 kB
cd client && npx vitest run                    # 29 files / 105 tests passed
cd client && npx eslint . | tail -3            # 0 error / 22 warning
grep -rn "res.json({ code: -1" server/src/routes            # 8 处 200+code:-1
grep -rn "http.patch" client/src                            # 2 处（http 上无此方法）
grep -rl "ProtectedShell\|RequireAdmin" --include=*.test.* client/src   # 空
```
