# HiDNS 前端架构审核报告（fe-arch）

- 审核对象：`client/`（必要时对照 `server/` 接口与 `.github/workflows`）
- 依据：`root.ai.md` §代码审核团（第 5 条强制全面审查）、§客户端架构、§路由
- 审核日期：2026-10-23
- 审核员：fe-arch-review（代码审核团 · 前端架构）
- 立场声明：中立性守则（root.ai.md §代码审核团 1）——本报告不针对任何提交者，只针对仓库现状；全程只读，未修改任何源码，未执行 git commit/push。

## 范围与方法

1. 静态核对：`client/src` 全量文件树（`find`）、`package.json`、`pnpm-lock.yaml` importer 分区、`vite.config.ts` / `vitest.config.ts` / `tsconfig*.json` / `eslint.config.js`。
2. 契约核对：`lib/http.ts` 的信封 / `ensureOk` / `requestRaw` 约定 → 22 个 api 模块逐一比对写方法（`http.post` vs `postOk` vs `ensureOk`），并穷举 `fetch(` 调用点。
3. 依赖核对：`grep` 全仓 `tdesign|i18next|axios|pages/|contexts/`，区分「代码残留」「lockfile 其它 importer」「node_modules 实际安装」三态。
4. 一致性核对：`app/realtime.tsx` 的 `EVENT_QUERY_MAP` ↔ 各 feature 的 `queryKey:` 字面量 ↔ `server` 侧 `wsService.broadcast*` 的 `type` 三方对齐。
5. 可访问性：按 HSL token 实算 WCAG 相对亮度与对比度（自写计算，非目测），检查 `aria-label` / `role=alert|status` / `alt` / `focus-visible` / skip-link。
6. 门禁实跑：在 `client/` 下逐条执行 `tsc -b`、`vitest run`、`vite build`、`eslint .`、`eslint src`，用 `$?` 与 `PIPESTATUS` 精确取退出码（不经过 `tail` 吞掉），并用 `eslint -f json` 统计实际检查文件数。
7. 未做：真实浏览器视觉走查（无浏览器会话）、CI 远端日志、`VITE_API_URL` 部署实测（该变量未在 `.env.example` 出现，按「待核实」标注）。

## 结论

前端在**技术栈、目录分层、数据层主路径、门禁真实性**四项上确实达到了 root.ai.md 的重构要求，四项门禁全绿且 CI 真的在跑。
但**「唯一出口」契约有缺口（`utils/rsaEncrypt.ts` 绕过 `lib/http.ts`）**、重复实现未收敛（`unwrap` 8 份、告警条 42 处、日期格式化 4 处），且文档对「Toast 容器」「四件套齐全」的两处描述与代码不符。
无 P0：没有发现会让默认部署白屏/登录不可用的问题；P1 仅 1 条，且触发条件是 `VITE_API_URL` 部署。

## 发现表

| # | 级别 | 置信度 | 主题 | 位置 |
|---|------|--------|------|------|
| 1 | P1 | 高（事实）/ 中（影响面） | `rsaEncrypt.ts` 绕过 `lib/http`：硬编码 `/api`、丢 401/超时/信封约定 | `src/utils/rsaEncrypt.ts:18` |
| 2 | P2 | 高 | `unwrap` 重复实现 8 份 + 2 个变体，应下沉到 `lib/http.ts` | 8 个 api 模块 |
| 3 | P2 | 高 | 告警/成功条样板复制 `role="alert"` 29 处 + `role="status"` 13 处，跨 27 文件，无 `ui/alert` | 27 个文件 |
| 4 | P2 | 高 | 日期/倒计时格式化重复，未复用 `lib/format.ts` | 5 处 |
| 5 | P2 | 高 | `timeoutMs` 注释称抛 `ApiError`，实际抛 `AbortError` | `src/lib/http.ts:53,67-81` |
| 6 | P2 | 高 | 文档说存在 Toast/ToastContainer，代码中不存在 | `root.ai.md:526,539` |
| 7 | P2 | 高 | 文档目录结构漏 `utils/ types/ styles/ test/`；「四件套齐全」与 6 个 feature 不符 | `root.ai.md:523-545` |
| 8 | P2 | 高 | `vite.config.ts` 残留 tdesign/i18next 的 manualChunks 死配置 | `vite.config.ts:34-35` |
| 9 | P2 | 高 | 依赖 `punycode.js` 全仓无 import（仅剩 d.ts） | `package.json` + `src/types/punycode.d.ts` |
| 10 | P2 | 高 | 实时事件表缺 `resource:snapshot`，且该事件每 10s 全量广播无消费方 | `src/app/realtime.tsx:13-66` ↔ `server/src/service/resource/job.ts:22` |
| 11 | P2 | 高 | 浅色 `--input`/`--border` 对比 1.34/1.24:1，不达 SC 1.4.11；无 skip-link | `src/ui/tokens.css:26-27,163-166` |
| 12 | P2 | 中 | 默认背景图来自第三方随机图源，自托管/内网实例每次加载外连 | `src/ui/tokens.css:66` + `landing-page.tsx:77` |

计数：**P0 = 0，P1 = 1，P2 = 11**，合计 12 条（未超 12 条上限）。

## 逐条详情

### 1 · P1 · `utils/rsaEncrypt.ts` 绕过 `lib/http` 唯一出口

**证据**
- `src/utils/rsaEncrypt.ts:18`：`const response = await fetch('/api/auth/public-key')` —— 硬编码相对路径，未使用 `apiBaseUrl()`。
- `src/lib/http.ts:31-35` 明确定义了 `apiBaseUrl()`：`VITE_API_URL` 优先，否则 `${protocol}//${host}/api`。`rsaEncrypt` 完全忽略这条口径。
- 该处 fetch 没有 `credentials: 'include'`、没有 `timeoutMs`、没有 401 处理、失败只 `console.error` 后抛裸 `Error`（`rsaEncrypt.ts:27-30`），与 `lib/http.ts` 的 `ApiError` 体系统一分层不一致。
- 使用面很大：`login-page.tsx:107,150,181,220`（登录 / 2FA / 找回密码）与 `settings-page.tsx:206`（改密）全部依赖它。
- root.ai.md:549-552「统一信封…`lib/http.ts`…」+ root.ai.md:532 把 `http.ts` 定为 `lib/` 的 HTTP 层；`utils/` 甚至不在 root.ai.md:523-540 的目录结构里。

**为什么是 P1 而不是 P2**：只要部署时设置 `VITE_API_URL`（http.ts 已支持该模式），前台登录、2FA、找回密码、改密五条路径全部打到错误主机 → 登录彻底不可用。`VITE_API_URL` 未出现在 `.env.example`（`grep VITE_ .env.example` 无输出），因此当前默认部署不受影响——这是它没有升到 P0 的唯一理由。历史评审（`ai-censorship/evidence/panel-20261023-D.md:119`）已就旧前端同类问题提过一次，重构后该文件被原样搬到 `utils/`。

**可执行建议**
1. 在 `src/features/auth/api.ts` 增加 `publicKey: () => http.get<{ publicKey: string }>('/auth/public-key')`（`/auth/public-key` 已在 `http.ts:38` 的 `AUTH_FREE_PATHS` 白名单里，不会触发 401 跳转）。
2. `rsaEncrypt.ts` 的 `getPublicKey()` 改为调用该 api，删除内部 `fetch` 与 `console.error`；缓存失效策略随之统一（密钥轮换时由 `clearKeyCache()` 控制）。
3. 在 `eslint.config.js` 加一条只针对业务的 `no-restricted-globals`/`no-restricted-syntax` 规则禁止 `src/**` 直接调用 `fetch`（`lib/http.ts` 本身用 `/* eslint-disable */` 局部豁免），防止再次回流。

### 2 · P2 · `unwrap` 重复实现 8 份

**证据**（均为同一签名的逐字复制）
`features/domains/renewal-api.ts:31`、`features/domains/service-monitor-api.ts:41`、`features/setup/setup-api.ts:48`、`features/system/network-api.ts:35`、`features/system/security-api.ts:62`、`features/workflows/workflows-api.ts:82`、`features/users/api.ts:29`、`features/mcp/api.ts:40`。
变体另有：`features/settings/use-settings.ts:5`（`unwrap` 接收 thunk）、`features/domains/ns-monitor-api.ts:42`（`unwrapNs`）、`features/teams/api.ts:52`（`unwrapList`）。

**影响**：一条 `unwrap` 的行为修正（例如 `code !== 0` 时抛 `ApiError` 而非静默返回 `data`）需要在 8-11 处同步；`lib/__tests__/http.test.ts` 只覆盖 `lib/http.ts`，这些副本零测试。直接违反 root.ai.md:544「禁止深路径相互 import 内部实现」的立法意图（同一份工具被复制而非导出）。

**可执行建议**：在 `src/lib/http.ts` 导出
```ts
export async function unwrap<T>(promise: Promise<ApiEnvelope<T>>): Promise<T> {
  return ensureOk(await promise).data;
}
```
把 8 处本地定义替换为 `import { unwrap } from '../../lib/http'`；`unwrapNs`/`unwrapList` 保留在各自 feature 但改为调用公共 `unwrap`。补 `lib/__tests__/http.test.ts` 中 `unwrap` 的失败分支用例。

### 3 · P2 · 告警条 / 成功条样板复制 42 处

**证据**：`grep -ro 'role="alert"' src | wc -l` = **29**，`grep -ro 'role="status"' src | wc -l` = **13**，涉及 **27** 个文件（其中 29 个文件含 `bg-destructive/10` 同一套类名）。样板的类名字符串逐字相同：
`flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive`（例：`features/domains/domains-page.tsx:121`、`features/system/security-tab.tsx:26`、`features/mcp/mcp-page.tsx:79`）。

**影响**：`ui/index.ts` 已有 13 个原语却没有 Alert，导致「提示条」成为事实上的第二个设计系统；深色模式的 `dark:border-success-900` 等成对类名靠人工复制，任何一处遗漏都会在深色模式下失效。

**可执行建议**：新增 `src/ui/alert.tsx`（`variant: 'error' | 'success'`，内部固定 `role={variant==='error'?'alert':'status'}`），替换 42 处；替换后 `grep -c 'bg-destructive/10' src | grep -v ui/alert` 应为 0，并加一条 vitest 快照验证两种 variant 的 role 属性。

### 4 · P2 · 日期/倒计时格式化重复

**证据**
- `features/domains/renewal-api.ts:65-70` 的 `daysLeft(iso)` 与 `lib/format.ts:25-30` 的 `daysUntil(iso)` 逻辑逐行相同（`Math.ceil((time - Date.now()) / 86400000)`）。
- `features/security/api.ts:89`：`new Date(last).toLocaleString('zh-CN')`；`features/security/security-page.tsx:378` 同样写法；`features/about/about-page.tsx:104`：`toLocaleDateString('zh-CN')` —— 三处均未用 `formatDate`。
- `features/dashboard/api.ts:76` 自己定义 `const DAY_MS = 24*60*60*1000`，而 `lib/format.ts:5` 已 `export const DAY_MS`。

**影响**：`lib/format.ts` 头部注释写着「纯函数，禁止在组件内重复实现」，实际有 5 处绕过；时区/格式口径（`toLocaleString` 带时间 vs `formatDate` 只到日）在同屏不同区块不一致。

**可执行建议**：`renewal-api.ts` 的 `daysLeft` 改为 `export { daysUntil as daysLeft }`（或直接改调用方）；三处 `toLocale*` 换成 `formatDate`/`formatRelative`；`dashboard/api.ts` 改为 `import { DAY_MS } from '../../lib/format'`。

### 5 · P2 · `timeoutMs` 的异常契约与注释不符

**证据**：`src/lib/http.ts:53-54` 注释「超时按网络错误抛 ApiError」；实现 `http.ts:67-81` 是裸 `await fetch(...)`，没有 `try/catch`。`AbortController.abort()` 让 fetch 以 `DOMException: AbortError` 拒绝，不会进入 `new ApiError(...)` 分支；同时 `clearTimeout(timer)`（`http.ts:81`）在异常路径上被跳过。
唯一使用方：`features/domains/service-monitor-api.ts:56`（`timeoutMs: 60_000`）。该页 `catch` 里按 `instanceof Error` 取 `err.message`，用户会看到英文 `The operation was aborted`。

**可执行建议**：
```ts
let response: Response;
try {
  response = await fetch(url.toString(), { /* ... */ });
} catch (error) {
  if (controller?.signal.aborted) {
    throw new ApiError('请求超时，请稍后重试', { status: 408, data: { path } });
  }
  throw new ApiError(error instanceof Error ? error.message : '网络错误', { status: 0, data: { path } });
} finally {
  if (timer) clearTimeout(timer);
}
```
并在 `lib/__tests__/http.test.ts` 加一条「超时抛 ApiError(408)」的用例（用 `vi.useFakeTimers` + `fetch` mock 不 resolve）。

### 6 · P2 · 文档声称的 Toast / ToastContainer 不存在（文档漂移）

**证据**
- `root.ai.md:526`：`app-shell.tsx  # 侧边栏 + 顶栏 + 主题切换 + Toast 容器`。
- `root.ai.md:539`：`└── components/  # 仅剩 ErrorBoundary 与 ToastContainer`。
- 实际：`grep -rn 'Toast|toast' client/src` → **0 命中**；`ls client/src/components/` → 只有 `ErrorBoundary.tsx`。
- 页面实际靠每个 feature 内联的 `role="alert"` 条（见发现 3）做反馈，没有全局 Toast。

**可执行建议**：二选一，必须落到代码或文档其一——
(a) 若确定不用全局 Toast：把 `root.ai.md:526` 改成「侧边栏 + 顶栏 + 主题切换」，`root.ai.md:539` 改成「仅剩 ErrorBoundary」，并在 `root.ai.md:534` 的 feature 约定里补一句「反馈走 `ui/alert`」（与发现 3 合并）。
(b) 若产品仍要 Toast：实现 `src/ui/toast.tsx` + 在 `app-shell.tsx` 挂 `<Toaster/>`，并给出与内联 `role="alert"` 的分工规则（页面级错误→内联，跨页操作→Toast）。

### 7 · P2 · 目录结构与「四件套齐全」与代码不符（文档漂移）

**证据**
- `root.ai.md:523-540` 的目录树只列了 `app/ ui/ lib/ copy/ features/ components/`。实际还存在 `src/utils/`（`rsaEncrypt.ts`）、`src/types/`（`record-types.ts`、`punycode.d.ts`）、`src/styles/globals.css`（3080 行）、`src/test/setup.ts`。发现 1 之所以能长期存活，正是因为 `utils/` 不在规范覆盖范围内。
- `root.ai.md:545`「每个 feature 自持 `api.ts` + `use-*.ts` + 页面 + 用例，四件套齐全才算完成」。实测（`features/<d>/` 逐项检查）：`about`（无 api.ts、无 use-*.ts，跨 feature 复用 `system/api`）、`marketing`（无 api.ts、无 hooks）、`auth`/`mcp`/`oauth`/`setup`（无 `use-*.ts`）、`workflows`（只有 `use-workflow-meta.ts`，无 `use-workflows.ts`）、`session`（无页面、无用例，是被多处复用的横切模块）。

**可执行建议**
1. `root.ai.md` 目录树补 `utils/`、`types/`、`styles/`、`test/`，并对 `utils/` 明写「只放纯函数，禁止发请求」。
2. 把「四件套齐全」改成按规模分档：有服务端状态的 feature 必须 `api.ts + use-*.ts + 页面 + 用例`；纯展示页（`about`/`marketing`）只要求「页面 + 用例」；横切模块（`session`）标注为例外并要求用例由复用方覆盖。
3. 若不愿改文档：给 `mcp`/`oauth`/`setup`/`auth` 补 `use-*.ts` 把页面里的 `useQuery` 抽出来（`mcp-page.tsx:34-36`、`about-page.tsx:49-57`、`system-page.tsx:66-67` 目前都是页面内直写 query）。

### 8 · P2 · `vite.config.ts` 残留 tdesign / i18next 死配置

**证据**：`client/vite.config.ts:34-35`
```ts
if (id.includes('tdesign-react') || id.includes('tdesign-icons-react')) return 'tdesign-vendor';
if (id.includes('i18next') || id.includes('react-i18next')) return 'i18n-vendor';
```
而 `root.ai.md:511` 明写「旧实现（TDesign、i18next、`pages/`、`contexts/`、`api/` 旧封装）已于 2026-10 全部删除，仓库内不再保留」。实测：`client/src` 中 `tdesign` 仅剩 4 处注释性文字（`app/nav.ts:20`、`styles/globals.css:63,1027`、`test/setup.ts:6`），i18next 0 处，`node_modules` 无安装，`package.json` 无声明。

**影响**：不会出错，但会让下一个读者误判「还有 tdesign 依赖」，且 `globals.css` 的两处注释（1027 行处还写着「TDesign 虚拟滚动模式下 cell 为 flex item」）描述的样式来源已不存在，属于无法追溯的遗产注释。

**可执行建议**：删掉 `vite.config.ts:34-35` 两行；把 `globals.css:63`、`globals.css:1027`、`test/setup.ts:6`、`nav.ts:20` 的历史注释改写成「历史原因保留」或直接删除；`vite.config.ts:48-53` 的 `/ws` 代理也已无客户端使用（实际连的是 `/api/socket/ws`，见 `app/realtime.tsx:97`），一并清理或改注释。

### 9 · P2 · 未使用依赖 `punycode.js`

**证据**：`client/package.json` dependencies 声明 `"punycode.js": "^2.3.1"`；`grep -rn 'punycode' client/src` 只有 `src/types/punycode.d.ts`（4 处声明，含 `toASCII`/`toUnicode`），**无任何 `import`**；构建产物里也没有对应 chunk。该 d.ts 是给一个不存在的引用方准备的。

**可执行建议**：确认 IDN 处理确实无人使用后，删除 `package.json` 依赖与 `src/types/punycode.d.ts`，跑 `pnpm install` 更新 lockfile；若预留，则在 `record-dialog.tsx` 的域名输入处真正用上 `toASCII` 校验（并补测试），避免「声明了但没接线」。root.ai.md:547「新增依赖前先看 `ui/` 与 `lib/` 是否已覆盖」同样适用于收敛依赖。

### 10 · P2 · 实时事件表缺 `resource:snapshot`（三方对齐断了一环）

**证据**
- `src/app/realtime.tsx:13-66` 的 `EVENT_QUERY_MAP` 共 39 个事件。
- 服务端 `server/src/service/resource/job.ts:22`：`wsService.broadcast({ type: 'resource:snapshot', data: snapshot })`，**每 10 秒**执行一次（`job.ts:19-26`）。
- 客户端全仓 `grep 'resource:snapshot|resource:'` → **0 命中**，既无映射也无消费者。
- root.ai.md:553：「新增后端事件时必须同步补表」。
- 反向核对是好消息：映射表里的 39 个事件，服务端 `broadcast*` 全部存在（无「前端瞎等」）；服务端其余 `type:` 命中项经人工甄别为 OAuth/Provider 枚举误报，不是 WS 事件。

**影响**：（a）映射表与后端事件源之间存在无主事件，后续再加事件时无人能判断「该不该补表」；（b）每 10s 向**所有在线用户**（`broadcast` 非 `broadcastToUsers`）推一份资源快照却无人消费，是纯带宽与序列化开销，且与仓库里其他事件普遍使用 `broadcastToUsers` 的受众收窄口径不一致——**这点属于后端范畴，见「需上报项目团队的事项」**。

**可执行建议**：前端侧先把 `resource:snapshot` 显式登记为「已知但前端未消费」——在 `realtime.tsx` 的映射表旁加一个 `const KNOWN_UNMAPPED = ['resource:snapshot']` 并在 `onmessage` 分支 `if (KNOWN_UNMAPPED.includes(type)) return;`，配一条 `realtime.test.tsx` 用例断言「收到未映射事件不抛错、不失效任何 query」；随后由后端决定删除该广播或前端补一个 `useResourceSnapshot`。

### 11 · P2 · 浅色模式输入框/边框对比度不达 SC 1.4.11；缺 skip-link

**证据**（HSL→sRGB→相对亮度实算，非目测）
| 组合 | 对比度 | 要求 |
|---|---|---|
| 浅色 `--foreground` 222 47% 11% / 白 | 17.90:1 | AA 正文 4.5 ✓ |
| 浅色 `--muted-foreground` 215 20% 40% / 白 | 6.16:1 | ✓（token 注释写的 6.13 属实） |
| 浅色 `--muted-foreground` / `--muted` | 5.61:1 | ✓（注释 5.60 属实） |
| 浅色 主按钮白字 / `--primary` 199 89% 35% | 5.01:1 | ✓（注释 5.03 属实） |
| 浅色 `--destructive` 白字 | 5.81:1 | ✓ |
| **浅色 `--input` 214 32% 88% / 白** | **1.34:1** | **✗ 需 3:1** |
| **浅色 `--border` 214 32% 91% / 白** | **1.24:1** | ✗（装饰性边框可豁免，输入框不行） |
| 深色 `--input` 215 25% 46% / `--card` | 3.29:1 | ✓ |
| 深色 `--border` 217 28% 26% / `--card` | 1.53:1 | 装饰豁免 |

`ui/button.tsx:7` 的 `variant: outline` 用 `border-input`，`ui/input.tsx` 同理 → 浅色模式下输入框与描边按钮的边界在白卡片上几乎不可见，低视力用户在深色模式正常、浅色模式失效，属「深色可用、浅色不可用」的单向退化。
另有：`app-shell.tsx:74-219` 没有「跳到主内容」链接，侧栏 15 个导航项 + 分组标题在每次路由切换后都要重新 Tab 穿越；`:focus-visible` 全局样式（`tokens.css:163-166`，`outline: 2px solid hsl(var(--ring))`）本身是达标的。

**可执行建议**
1. 浅色 token 改 `--input: 214 20% 62%`（对白底约 3.4:1，仍低于文字级要求但满足非文本 3:1），`--border` 保持装饰用途不动；或给 `ui/input.tsx` 加 `border-input ring-1 ring-border` 之外的 `shadow-[inset_0_0_0_1px_hsl(var(--input))]` 提高边界可见度。
2. `app-shell.tsx` 首个可聚焦元素加 `<a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2">跳到主内容</a>`，并给 `<main>`（`app-shell.tsx:213`）加 `id="main-content" tabIndex={-1}`。
3. 用 `@axe-core/playwright` 在 `client/e2e` 里加一条深/浅两色的 axe 扫描用例，把 1.4.11 变成可回归的门禁项。

### 12 · P2 · 默认背景图来自第三方随机图源

**证据**
- `src/ui/tokens.css:66`：`--app-bg-image: url('https://t.alcy.cc/moez');`，`tokens.css:129-144` 把它强制挂到 `body` 的 `background-image`（含 `background-attachment: fixed`），即**每一个页面**（含 `/login`、`/setup`、`/oauth/*`）首次加载都会向外部主机发起请求。
- `src/features/marketing/landing-page.tsx:77` 又硬编码同一主机。
- 用户可通过偏好关闭（`lib/theme.tsx:97-101` 的 `'none'` → `data-bg="off"`），但默认是开启。

**影响**：（a）自托管/内网/离线实例每次加载都外连第三方域名，客户端 IP 与 UA 被该主机收取；（b）图源不可用时无背景（视觉退化但不报错，属可接受）；（c）随机图源内容不受控，可能与企业内使用场景不符。仓库内没有 CSP，故也不存在被 CSP 拦下的兜底。

**可执行建议**：默认值改为空（纯色 + `--scrim`），把远程图作为「设置页里可选的示例图」并注明外部依赖；或把示例图放进 `client/public/`（`landing-page.tsx:77` 同步改成本地路径）；若要保留远程默认，至少加 `onerror`/`loading="lazy"` 与 `referrerpolicy="no-referrer"`，并在 README 的部署章节说明该外连。

## 门禁实跑结果

执行环境：工作区 `/workspace/HiDNS/client`，node 侧仅有一条与本任务无关的 `UNDICI-EHPA` 环境告警（`EnvHttpProxyAgent is experimental`），已从下表中剔除。

| 命令（逐条顺序执行） | 退出码 | 真实输出 |
|---|---|---|
| `npx tsc -b` | **0** | 无任何诊断输出 |
| `npx vitest run` | **0** | `Test Files 37 passed (37)`、`Tests 146 passed (146)`、`Duration 79.16s` |
| `npx vite build` | **0** | `✓ built in 4.55s`；最大 chunk `assets/index-*.js 221.24 kB │ gzip 69.65 kB`，其次 `react-vendor 181.79 kB`、`ui 137.32 kB`；**无 chunk-size 警告** |
| `npx eslint src`（root.ai.md:561 原文命令） | **0** | 无输出 |
| `npx eslint .`（本次额外要求） | **0** | 无输出；`eslint -f json` 统计：**151 个文件、0 error、0 warning** |
| `npx tsc --noEmit`（验证 root.ai.md:563 的说法） | **0** | 无诊断 → 确认「`tsc --noEmit` 不会检查任何文件」成立（`tsconfig.json` 是 solution 式，`files: []`） |

与 root.ai.md:559-563 的一致性核对：
- 文档命令 `cd client && npx tsc -b && npx vitest run && npx vite build && npx eslint src` —— **可逐字执行且全绿**，与实测一致。
- 「`tsconfig.json` 为 solution 式，`tsc --noEmit` 不会检查任何文件」—— **属实**（上表末行）。
- CI 侧真的在跑这套门禁，不是只写在文档里：`.github/workflows/test-suite.yml:97-100`（`dnsmgr-client run lint` = `eslint .`）、`:102-105`（`dnsmgr-client run build` = `tsc -b && vite build`）、`:206-207`（`dnsmgr-client run test -- --coverage`，注释明写「不加 `|| true`」）；`.github/workflows/commit-checks.yml:108-119` 另走 `lint` + `tsc -b`。
- 唯一措辞差异：文档写 `npx`，CI 写 `pnpm --filter dnsmgr-client run *`，两者落到同一组命令（`package.json` 的 `lint`/`build`/`test`/`typecheck`），**不构成漂移**。

## 经核实无问题

以下项按「明确核对过、结论是没问题」记录，避免后续复审重复劳动：

1. **技术栈与文档完全一致**：React `19.2.4`、Vite `8.0.1`、`@tanstack/react-query 5.80.7`、`react-router-dom 7.2.0`、`tailwindcss 3.4.17`、Radix（dialog/dropdown-menu/label/select/slot/switch 六个包）、`lucide-react 0.511.0`；表单 RHF 7.90 + zod 4.4 + `@hookform/resolvers`（`login-page.tsx:62-75` 实际在用）。
2. **旧栈零残留**：`client/src` 中 `axios` 0 命中、`i18next/useTranslation/react-intl` 0 命中、`pages/`/`contexts/` 目录不存在、`node_modules` 未安装 tdesign/i18next（`pnpm-lock.yaml` 里的 `axios@1.14.0` 归属 `server` importer，不是客户端残留）。`tdesign` 字面量仅剩 4 处历史注释（已列入发现 8）。
3. **数据层主路径干净**：22 个 api 模块全部经 `lib/http`；写操作要么用 `postOk/putOk/patchOk/deleteOk`（内建 `ensureOk`），要么显式 `ensureOk(...)`/`unwrapNs`——**没有一处**「`http.post` 写完不判 code」。信封缺失校验在 `http.ts:106-109` 落实，与 root.ai.md:550 一致；裸 JSON 的 `/mcp/oauth/authorize` 确实走 `requestRaw`（`features/oauth/mcp-consent-page.tsx:41`，`requestRaw` 调用点唯一），与 root.ai.md:552 一致。
4. **路由口径与守卫**：`App.tsx` 一处集中声明全部路由（60-95 行）；`/dash/*` 全部在 `ProtectedShell`（`app/protected-shell.tsx`）内；管理页再套 `RequireAdmin`（`app/require-admin.tsx:9-15`，判定唯一走 `isAdminUser`）；`ProtectedShell` 对「5xx/网络错」与「未登录」做了区分（`protected-shell.tsx:21-35`），没有把服务端故障误判成掉登录。与 root.ai.md:546 一致。
5. **模块化边界**：`components/` 只剩 `ErrorBoundary.tsx`，页面逻辑没有回流；跨 feature 引用共 11 处，全部是显式导出（`session/use-session`、`domains/use-domains` 的 `useDomainAccounts`、`accounts/use-accounts`、`system/api`），**无深路径 import 内部实现**。
6. **实时失效表的正向覆盖**：`EVENT_QUERY_MAP` 39 个事件在服务端全部能找到对应 `broadcast*`；各 feature 的 `queryKey` 与表里的前缀能对上（`['domain']`→`['domain', id]`、`['records']`→`['records', domainId, query]`、`['system-security']`→`['system-security', *]`、`['security','devices']` 直匹配）。反向缺口只有发现 10 的 `resource:snapshot`。
7. **主题**：`ThemeProvider` 在 `App.tsx:56` 包住全部路由（含 `/login`、`/setup`、`/oauth/*`）；存储键 `theme`，写入值 `light|dark|auto`（`theme.tsx:28-30` 把内部 `'system'` 写回 `'auto'`，与 root.ai.md:557 的取值一致）；`index.html:9-20` 内联脚本在首屏前应用，深色用户无白闪。与 root.ai.md:555-557 一致。
8. **对话框可访问性**：全仓 `<DialogContent` 与 `<DialogTitle` 逐文件计数**完全相等**（无一处 Radix 缺标题）；`ui/dialog.tsx:25-30` 的关闭按钮有 `aria-label="关闭"`；`<img>` 4 处中 3 处 `alt=""`（装饰图）+ 1 处语义化的「两步验证二维码」，无缺 alt 的图片。
9. **错误提示可被读屏感知**：页面级错误统一用 `role="alert"`、成功用 `role="status"`（42 处），不是纯颜色变化；`RealtimeIndicator`（`app-shell.tsx:25-35`）用 `sr-only` 文本 + `aria-hidden` 圆点，未把状态塞给颜色。
10. **加载/降级路径完整**：路由级 `Suspense` fallback（`App.tsx:41-50`）、`ErrorBoundary`、会话校验 loading/错误态（`protected-shell.tsx:11-34`）、`QueryClient` 默认 `retry: 1 / staleTime 30s`（`App.tsx:36-38`），未见「白屏无提示」的页面。
11. **测试覆盖真实**：37 个测试文件覆盖 `app/`（guards、realtime）、`lib/`（http、write-envelope）、15 个 feature 的页面与关键 api（`ns-monitor-api`、`batch-api`、`workflow-dsl`），146 用例全绿；`write-envelope.test.ts` 还专门扫描源码禁止裸 `http.post` 写操作（`lib/__tests__/write-envelope.test.ts:51`），是一条有效的防腐门禁。

## 需上报项目团队的事项

1. **P1 尚只 1 条、未达「多次出现 P0」的上报门槛**（root.ai.md §代码审核团 2），故本报告不触发「申请抹杀编写 AI」流程。但发现 1 与发现 8/9 性质相同：**重构把旧文件整目录搬进 `utils/`，规范目录只覆盖 `app/ui/lib/copy/features/components`，于是「搬运」成了绕过契约的标准路径**。建议项目团队把 root.ai.md:523-540 的目录树补全（发现 7），否则同类问题会在下一轮重构重现。
2. **后端范畴，前端无法闭环**：`server/src/service/resource/job.ts:22` 每 10s 用 `wsService.broadcast`（全体在线用户）推送 `resource:snapshot`，而前端无任何消费者（发现 10）。请后端确认该广播是「待接线的功能」还是「历史遗留」；若是前者，顺带评估是否应改用 `broadcastToUsers` 收窄受众（该快照含主机/资源指标，与其他事件普遍收窄受众的做法不一致）。
3. **文档一致性请求**：`root.ai.md:526`、`:539`（Toast/ToastContainer 不存在）、`:545`（四件套）、`:523-540`（目录缺 4 项）四处需由文档维护者定夺「改文档」还是「补代码」——本报告已在发现 6/7 给出双向落地方案，避免审核团与开发方各按各的理解执行。
4. **建议纳入门禁**：把 `@axe-core/playwright` 的深/浅色扫描接进 `.github/workflows/test-suite.yml` 的 `e2e-test` 作业（发现 11 的回归保障），并把「`src/**` 禁止直接 `fetch`」写成 ESLint 规则（发现 1 的防腐）。这两条都是「一次投入、长期生效」的门禁，比拼一次性整改更值得。

---

*本报告只读审核，未修改任何源码，未执行 git commit/push。*
