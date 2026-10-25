# HiDNS 重构终审（第四轮 · 全仓独立评审）

> 评审员：代码审核团独立终审（只读；未修改任何源码、未提交、未 push）
> 基线：HEAD `c66e96f`（`docs(server): 修正 settings 路由注释…`）。评审开始时工作区干净（`git status` 空）；**评审过程中出现并行改动**：`git status` 变为 `D client/src/config/gravatar.ts`、`D client/src/features/session/require-session.tsx`（他人/并行任务所删，非本评审所为）。所有结论以 `c66e96f` 为准，涉及这两个文件的条目已注明现状。
> 必读依据：`root.ai.md`、`docs/refactor/00-PLAN.md`、`docs/api.md`
> 前序：`ai-censorship/evidence/{refactor-p0-api-review,refactor-frontend-review,refactor-frontend-review-2,refactor-final-review}.md`（24 条已声明关闭）
> 规范要求（`root.ai.md:21`）：本文所有结论附可复现证据；未能验证的一律标注。

---

## 1. 范围与方法

**范围（全仓，只读）**

| 维度 | 覆盖 |
| --- | --- |
| 文档一致性 | `root.ai.md` §客户端架构 / §路由 / §服务层 / §安全规范；`docs/api.md`（信封、错误码、分页、端点表）；`docs/refactor/00-PLAN.md` §5 门禁与 §6 台账 |
| 前后端契约 | 16 个前端 feature 的 `api.ts`（≈120 处 `http.*` 调用）逐条对照 `server/src/routes/*`；重点：路径/方法/参数名/响应字段/信封形状 |
| 门禁 | 实跑 `server: tsc --noEmit / vitest run / eslint . --max-warnings=0`；`client: tsc -b / vitest run / vite build / eslint .`；外加 `vitest run --coverage`（CI 实际使用的命令）与 CI 配置核对 |
| 隐性问题 | 错误码契约（400/403/404/409/422/503）、`***` 掩码往返、`line` 语义、分页 20/100、初始化门禁三态 |
| 死代码/依赖 | 全量导入图分析（自写只读脚本，未改仓库）＋ 依赖使用扫描 |
| 测试有效性 | 抽查 8 条用例（跨 8 个 feature），判断是否守行为 |

**方法**

1. 先读三份必读文档，再用 `grep` 抽取**全部**前端 `http.*` 调用点与**全部**后端 `router.get/post/put/patch/delete` 定义，做表对账（不是抽样记忆）。
2. 对每个可疑契约点回到后端处理器读 `sendSuccess/sendError/res.json` 的实际形状，而不是只看 Swagger 注释。
3. 门禁全部**本机实跑**，记录退出码/用例数；对不稳定项**重复跑**以区分「必现」与「偶发」。
4. 死代码用「反向导入扫描」（基名 → 所有文件中的 `from '...'`/`import()`/`require()`），并对命中为 0 的文件人工复核。

**未覆盖（诚实声明）**：浏览器端到端（无部署实例）；真实 DNS 提供商适配器行为；数据库三方言下的页面行为；Docker/SEA 构建产物。

---

## 2. 结论

**重构的机械目标达成**：旧 `pages/`/`contexts/`/`api/`/`i18n/` 与 TDesign/i18next/axios 已彻底清零（单条 `i18n` 命中仅是注释），`server tsc`/`server vitest 541`/`client tsc -b`/`client vite build`/`两端 eslint` 全部真实通过，初始化门禁三态、`line` 语义、`***` 掩码往返、409/403/404 落点均经复核成立。

但**终审仍不能放行**，原因集中在三处：

1. **两个功能面必失败，且都被 mock 型用例掩盖**：NS 监控域 7 个端点全部返回 `{success:true}` 无 `code`，前端唯一出口 `lib/http.ts` 必抛 `Malformed API response`（`unwrapNs` 适配器写在 `await http.get` 之后，永远执行不到）；记录批量导入前后端响应结构不符（后端 `{addedIds}`，前端读 `results`），点击即 `TypeError`。
2. **门禁真实性仍有洞**：客户端的覆盖率门禁**直接崩溃**（`vitest@2.1.9` 与 `@vitest/coverage-v8@5.0.5` 大版本不兼容），而这正是 CI `unit-test-client` 里跑的命令；同时 `vitest run` 全量两次实跑一次红（1 failed）一次绿（142 passed），台账里 5 处「全绿」不可复现。
3. **文档与代码仍有多处相反**：`docs/api.md` 声称「不再出现 HTTP 200 + code:-1」，实际 `tunnels.ts` 6 处、`auth.ts` 2 处仍是；`/api/domains` 分页默认写 50、实现是 20；`root.ai.md` §服务层引用 6 个已不存在的文件、TOTP 依赖写成 speakeasy（实际 otplib）、邮件模板前缀与实际挂载点不同、路由表漏 `/api/resource-monitor`。

**风险判断**：P0 两条是「用户看得见的坏功能」，修复量小但必须由负责人拍板改哪一侧；门禁两条说明**当前「全绿」不能作为验收凭据**；文档类问题会让下一轮评审继续按错口径核对。

---

## 3. 发现表

| # | 级别 | 归属 | 结论 | 位置 | 置信度 |
| --- | --- | --- | --- | --- | --- |
| 1 | P0 | 存量(后端形状)+本轮(前端接入) | NS 监控 7 个端点全部不可用：后端返回 `{success:true}` 无 `code`，`lib/http.ts` 必抛错，`unwrapNs` 永不执行 | `server/src/routes/ns-monitor.ts:47,107,204,229,281,306,407,463,503,561,607`；`client/src/lib/http.ts:106-109`；`client/src/features/domains/ns-monitor-api.ts:42-88` | HIGH |
| 2 | P0 | 本轮引入 | 记录批量导入必崩：后端返回 `{addedIds}`，前端读 `results` → `TypeError` | `server/src/routes/records.ts:668-671`；`client/src/features/records/api.ts:106-114`；`client/src/features/records/batch-import-dialog.tsx:67-70,78` | HIGH |
| 3 | P0 | 本轮引入 | 客户端覆盖率门禁崩溃（版本不兼容）+ `coverage.include` 指向已删目录；CI 该步必红 | `client/package.json:41,68`（devDeps）；`client/vitest.config.ts:11-14`；`.github/workflows/test-suite.yml:206-215` | HIGH |
| 4 | P1 | 本轮引入 | `client npx vitest run` 全量不确定：同 HEAD 两次实跑 1 红 1 绿；红因首个用例撞 5s 默认超时 | `client/src/features/workflows/__tests__/action-builder.test.tsx:131`；`client/vitest.config.ts:6-15`（无 `testTimeout`） | HIGH |
| 5 | P1 | 存量 | `root.ai.md` §服务层/§安全规范与代码不符：6 个文件不存在、speakeasy≠otplib、邮件模板前缀错、路由表漏 `/api/resource-monitor` | `root.ai.md:381,401,409,411,430-432,640`；对照 `server/src/api/index.ts:60-110`、`server/package.json:54` | HIGH |
| 6 | P1 | 存量 | `docs/api.md` 错误码契约不成立：仍有 8 处「HTTP 200 + code:-1」 | `docs/api.md:32`；`server/src/routes/tunnels.ts:82,101,130,133,162,165`；`server/src/routes/auth.ts:1223,1231` | HIGH |
| 7 | P1 | 存量（第三轮 P2-11 声明关闭但未落实） | 零引用文件 3 个 + Toast 零生产者 + 根目录 2 个 i18n 脚本运行时 ENOENT | `client/src/styles/theme.ts`、`client/src/config/gravatar.ts`、`client/src/features/session/require-session.tsx`、`client/src/hooks/useToast.ts:47`、`check_i18n_keys.js`、`check_i18n_simple.js` | HIGH |
| 8 | P1 | 存量 | 未使用依赖：`@radix-ui/react-tabs`、`@radix-ui/react-tooltip`（`ui/` 无对应原语） | `client/package.json`（dependencies）；`client/src/ui/` 文件清单 | HIGH |
| 9 | P1 | 存量 | `docs/api.md` `GET /api/domains` 分页默认值写 50，实现是 20 | `docs/api.md:304`；`server/src/routes/domains.ts:187`；`docs/refactor/00-PLAN.md:59` | HIGH |
| 10 | P1 | 本轮引入 | 测试有效性缺口：3 处把被测契约整体 mock（NS 监控、MCP 同意页、批量导入只测解析器），正是 P0-1/P0-2 的成因 | `client/src/features/domains/__tests__/ns-monitor-tab.test.tsx:8-20`；`client/src/features/oauth/__tests__/mcp-consent-page.test.tsx:8`；`client/src/features/records/__tests__/batch-import.test.ts:1-22` | HIGH |
| 11 | P2 | 存量 | 审计列表前端仍发 `keyword`，后端不认（UI 已改「按域名搜索」，参数成死字段；导出 URL 同） | `client/src/features/audit/api.ts:33,46-52`；`server/src/routes/audit.ts:19-27` | HIGH |
| 12 | P2 | 存量 | 偏好 `theme` 与服务端脱钩：保存不带 `theme`，主题只写 localStorage，服务端 `preferences.theme` 永不更新（跨设备丢主题） | `client/src/features/settings/settings-page.tsx:266-273`；`client/src/lib/theme.tsx:50-52`；`server/src/routes/auth.ts:1432` | MEDIUM |
| 13 | P2 | 存量 | `<html lang="en">` 与「单一简体中文」产品定位不符（无障碍/朗读语言错误） | `client/index.html:2` | HIGH |
| 14 | P2 | 本轮引入 | `root.ai.md` 客户端门禁命令写 `npx eslint src`，仓库实际口径是 `npx eslint .`；且未登记 vitest 偶发红与 coverage 崩溃 | `root.ai.md:561`；`client/eslint.config.js:8-12`；`.github/workflows/test-suite.yml:99-100` | MEDIUM |

---

## 4. 逐条详情

### 1 · P0 · NS 监控全域不可用（HIGH · 存量后端形状 + 本轮前端接入）

`[FACT]` 后端 `ns-monitor` 全部响应使用 `{ success: true, data }`，**没有 `code` 字段**（11 处）：

```ts
// server/src/routes/ns-monitor.ts:228-231
res.json({
  success: true,
  data: { list, total, page, pageSize },
});
```

`[FACT]` 前端唯一出口强制要求 `code` 为数字：

```ts
// client/src/lib/http.ts:106-109
const envelope = payload as ApiEnvelope<T> | undefined;
if (!envelope || typeof envelope.code !== 'number') {
  throw new ApiError('Malformed API response', { status: response.status, data: payload });
}
```

`[FACT]` 适配器写在 `await` **之后**，异常先抛出，永远到不了：

```ts
// client/src/features/domains/ns-monitor-api.ts:49-51
const envelope = await http.get<{ list?: NsMonitorRow[]; total?: number }>('/ns-monitor', { query });
const data = unwrapNs(envelope) ?? {};   // ← 上一行已 throw
```

**失败面**：`GET /api/ns-monitor`（列表）、`/available-domains`、`POST /api/ns-monitor`、`PUT /:id`、`DELETE /:id`、`POST /check`、`POST /resolve-ns` —— **NS 监控 tab 无任何可用路径**，页面停在错误态。

`[FACT]` 该保护的用例把 api 层整体替换，因此从未触达 `lib/http`（见第 10 条）。

**修复建议（二选一，需后端 owner 拍板；推荐 A）**

A. 后端适配信封（与其余 22 个模块一致）：把 `ns-monitor.ts` 的 11 处 `res.json({ success: true, ... })` 改为 `sendSuccess(res, data)`；`success:false` 分支改 `sendError(res, msg, status)`（`server/src/utils/http.ts:84` 已保证 `code === HTTP status`）。随后删掉前端的 `unwrapNs`（`ns-monitor-api.ts:42-47`）并把 5 处 `unwrapNs(...)` 改成直接取 `envelope.data`。

B. 前端特例：新增 `requestRaw` 风格的通路（`lib/http.ts:130`）解析 `{success,data}`，`ns-monitor-api.ts` 全部改用该通路。**代价**：把「一种信封」变成「两种信封」，与 `00-PLAN.md:57` 的决策相反 —— 不建议。

**回归用例（必须新增）**：仿 `client/src/lib/__tests__/http.test.ts` 的 fetch 桩写法，对真实 `http.ts` + `ns-monitor-api.ts` 断言：给一份 `{success:true,data:{list:[],total:0}}` 必须抛 `ApiError`（暴露当前缺陷）；修 A 后改为断言 `{code:0,data:{...}}` 能解析出 `list`。

---

### 2 · P0 · 批量导入必崩（HIGH · 本轮引入）

`[FACT]` 后端返回 `addedIds`（成功与部分成功一致）：

```ts
// server/src/routes/records.ts:667-671
if (errors.length > 0) {
  sendError(res, errors.join('; '), 200, { addedIds });   // 注意：200 经 sendError 归一为 400，data 带 addedIds
} else {
  sendSuccess(res, { addedIds });
}
```

`[FACT]` 前端类型与解析却是 `{ total, results }`：

```ts
// client/src/features/records/api.ts:106-114
export interface BatchResult { total: number; results: BatchResultItem[]; }
export async function batchCreateRecords(domainId: number, records: RecordPayload[]): Promise<BatchResult> {
  const envelope = await http.postOk<BatchResult>(...);
  return envelope.data ?? { total: records.length, results: [] };   // data 是 {addedIds} → results === undefined
}
```

`[FACT]` 调用方第一行就取 `results`：`batch-import-dialog.tsx:70` `batch.results.some(...)`（第 78 行同理）→ `Cannot read properties of undefined (reading 'some')`，被 `catch` 显示成「导入失败」，而记录**其实已经写入**（用户重复导入会得到重复记录）。

**修复建议（推荐 A）**

A. 前端按后端形状改：`BatchResult` 改为 `{ addedIds?: string[]; total?: number }`，对话框改为按 `addedIds.length` 展示成功数、按行数算失败数；`onImported` 在 `addedIds.length > 0` 时触发。同时把 `sendError(..., 200, ...)` 改为 `sendError(res, msg, 400, { addedIds })` 并在 UI 上区分「部分成功」（此时 `postOk` 会抛错，需改用 `http.post` 自判 `code`，参照 `lib/http.ts:152-163` 的原始方法组）。

B. 后端改为返回 `{ total, results }`：需逐条 try/catch 并记录每行 `{ok, recordId, error}`（当前只收集 `errors: string[]`，信息不足）。

**回归用例**：用 fetch 桩断言「`{code:0,data:{addedIds:['r1','r2']}}` → 对话框显示成功 2 条且触发 `onImported`」；再断言「`{code:400,data:{addedIds:[]},msg:'...'}` → 显示错误且不崩」。

---

### 3 · P0 · 客户端覆盖率门禁崩溃 + include 指向已删目录（HIGH · 本轮引入）

`[FACT]` 实跑（本机）：

```
$ cd client && npx vitest run src/lib/__tests__/http.test.ts --coverage
SyntaxError: The requested module 'vitest/node' does not provide an export named 'BaseCoverageProvider'
 ❯ loadProvider .../@vitest+coverage-v8@5.0.5_vitest@2.1.9_.../dist/load-provider-*.js
```

原因：`client/package.json` 里 `vitest ^2.1.9` 与 `@vitest/coverage-v8 ^5.0.5` 跨两个大版本（coverage 包 v5 对应 vitest v5）。

`[FACT]` 覆盖率口径本身也已失效：

```ts
// client/vitest.config.ts:11-14
coverage: {
  provider: 'v8',
  reporter: ['text', 'lcov'],
  include: ['src/pages/Workflows.tsx', 'src/utils/workflows.ts', 'src/components/workflows/**'],
},
```

三个路径全部在 P5 被删除（`client/src/pages`、`client/src/components/workflows` 不存在，`client/src/utils` 只剩 `rsaEncrypt.ts`）。

`[FACT]` CI 正好跑这条命令：`.github/workflows/test-suite.yml:206-207` `pnpm --filter dnsmgr-client run test -- --coverage` —— 一旦真的执行就是红，且 `codecov` 无 `client/coverage/lcov.info` 可上传。

**修复建议**

1. 对齐版本：`pnpm --filter dnsmgr-client add -D @vitest/coverage-v8@^2.1.9`（与 vitest 同主版本）。
2. 重写 `coverage.include`：`include: ['src/features/**/*.{ts,tsx}', 'src/lib/**/*.{ts,tsx}', 'src/app/**/*.{ts,tsx}']`，`exclude: ['**/__tests__/**', 'src/types/**', 'src/ui/**']`；先不设 `thresholds`，跑一版拿到真实基线后再定阈值（否则一次性设 60% 会让 CI 立刻红）。
3. CI 两步分离：`run test` 与 `run test -- --coverage`，避免覆盖率工具故障连带掩盖单测结果。

---

### 4 · P1 · `vitest run` 全量不确定（HIGH · 本轮引入）

`[FACT]` 同一 HEAD、同一台机器、连续两次全量：

| 次 | 结果 | 耗时 | 说明 |
| --- | --- | --- | --- |
| #1 | **Test Files 1 failed / 34 passed；Tests 1 failed / 141 passed** | 114.7s | `action-builder.test.tsx > 按 meta 渲染参数…` `Error: Test timed out in 5000ms` |
| #2 | **Test Files 35 passed；Tests 142 passed** | 72.8s | 无不稳定 |

`[FACT]` 该用例单独跑是全绿的，但**该文件**总耗时 6.6s、首条用例 1.87s：`npx vitest run src/features/workflows/__tests__/action-builder.test.tsx` → 6 passed。

**判定**：默认 `testTimeout: 5000`（`client/vitest.config.ts` 未配置）在 35 文件并行 + jsdom 抢 CPU 时不够用 → 门禁在无代码变更时也会随机红。台账（`00-PLAN.md:92-99`）多处「vitest 全绿」正是这种一次性抽样，无法复现。

**修复建议**

1. `client/vitest.config.ts` 增 `test: { testTimeout: 20000, hookTimeout: 20000 }`（与 server 侧 `server/vitest.config.ts` 的 30000 对齐）。
2. `action-builder.test.tsx` 用例级再兜一层：`it('...', async () => {...}, 30000)`，并把「打开对话框 + 输入」的 `userEvent.setup({ delay: null })` 提速。
3. 台账写法修正：门禁结论必须写「跑了几次 + 退出码」，单次通过不得写「全绿」。

---

### 5 · P1 · `root.ai.md` 服务端段与代码不符（HIGH · 存量）

逐条 `[FACT]`（`ls` 复核）：

| 文档 | 声称 | 实际 |
| --- | --- | --- |
| `root.ai.md:401` | `whoisJob.ts` WHOIS 定时任务 | 不存在（实为 `service/whois/scheduler.ts`） |
| `root.ai.md:409` | `whoisScheduler.ts + whoisInit.ts` | `whoisInit.ts` 不存在 |
| `root.ai.md:411` | `whois/whoisScheduleManager.ts` | 不存在 |
| `root.ai.md:430` | `whoisService.ts` | 不存在（模块已拆到 `service/whois/*`，见第 435-458 行同一文档，自相矛盾） |
| `root.ai.md:431` | `whoisProvider.ts` | 不存在 |
| `root.ai.md:432` | `dnsUpdateService.ts` | 不存在（实为 `dns-provider-service.ts`，第 433 行已列） |
| `root.ai.md:640` | TOTP 通过 **speakeasy** | `server/package.json:54` 是 `otplib`，`service/totp.ts:1` `import { authenticator } from 'otplib'` |
| `root.ai.md:381` | `/api/email-templates` | 实际挂载 `/api/domains/email-templates`（`api/index.ts:76-80`，且 `docs/api.md:506-508` 写的是对的） |
| `root.ai.md:367-389` | 路由清单 | 漏 `/api/resource-monitor`（`api/index.ts:106`）、漏 `/api/auth/webauthn`（`:71`）、漏 `/api/audit/export/*` |

**修复建议**：按 `api/index.ts:60-110` 的模块清单机械重写 §路由 2；§服务层 2/3/4 的条目改为「表名 = 目录内实际文件」并用 `ls server/src/service` 校对；TOTP 一行改为 `otplib`。**建议同时加一条自检**（避免复发）：

```bash
# 文档提到的 server/src/service/*.ts 是否都存在（可放进 CI 的 file-check）
grep -oE 'service/[a-zA-Z0-9_/-]+\.ts' root.ai.md | sort -u | while read -r p; do
  [ -f "server/src/$p" ] || echo "MISSING: $p"
done
```

---

### 6 · P1 · 错误码契约仍被 8 处违反（HIGH · 存量）

`[FACT]` `docs/api.md:32` 写「`code` 与 HTTP 状态码一致（**不再出现**「HTTP 200 + code:-1」）」，`server/src/utils/http.ts:80-82` 注释同口径，但：

```ts
// server/src/routes/tunnels.ts:80-83（82）、99-102（101）、129-134（130,133）、161-166（162,165）
res.json({ code: -1, msg: e instanceof Error ? e.message : String(e) });   // HTTP 200
// server/src/routes/auth.ts:1223    res.json({ code: -1, msg: 'Nothing to update' });
// server/src/routes/auth.ts:1231    res.json({ code: -1, msg: 'User not found' });
```

`[INFERENCE]` 前端因为已全面切到 `postOk/putOk/deleteOk`（`lib/http.ts:156-163`），这 8 处**不会造成假成功**；但契约文本与实现相反，任何人按文档写外部适配器（DDNS-Go 等）会把失败当成功。

**修复建议**

1. `tunnels.ts` 6 处 → `sendError(res, msg)`（默认 400）/ `sendError(res, msg, 502)`（上游失败）；`auth.ts:1223` → `sendSuccess(res)`（幂等空更新直返成功），`:1231` → `sendError(res, 'User not found', 404)`。
2. 加一条守护测试（`server/src/routes/__tests__/error-contract.test.ts`）：AST 扫描 `routes/**` 出现 `res.json({ code: -` 即失败，把契约钉死。
3. 若短期不改，把 `docs/api.md:32` 改为「除 `tunnels` 与 `auth/profile` 的 8 个历史端点外」。

---

### 7 · P1 · 死代码/残留未清零（HIGH · 第三轮 P2-11 声明关闭但未落实）

`[FACT]` 反向导入扫描（113 个生产文件）零引用：

| 文件 | 大小/行数 | 说明 |
| --- | --- | --- |
| `client/src/styles/theme.ts` | 152 行（第三轮报告已点名） | 无人 import；主题已由 `lib/theme.tsx` 承担 |
| `client/src/config/gravatar.ts` | 18 行 | 头像镜像配置，新设置页只收 URL 输入框（**评审期间已被并行任务删除**） |
| `client/src/features/session/require-session.tsx` | — | 守卫已统一到 `app/protected-shell.tsx` + `app/require-admin.tsx`（**评审期间已被并行任务删除**） |

`[FACT]` Toast 链路只有容器没有生产者：`app/app-shell.tsx:207` 挂了 `<ToastContainer />`，`hooks/useToast.ts:47` 的 `useToast()` **零调用方**，`addToast` 只在同一个 hook 内部被调用（`:49-51`）→ 容器永远渲染不出东西，属于「看起来有提示通道、其实没有」。

`[FACT]` 根目录两个 i18n 校验脚本已随 `i18n/` 删除而失效：

```
$ node check_i18n_simple.js
Error: ENOENT: no such file or directory, open '/workspace/HiDNS/client/src/i18n/locales/en.json'
```

（`check_i18n_keys.js` 同理；`root.ai.md:34` 还要求根目录只保留 README。）

**修复建议**

```bash
git rm client/src/styles/theme.ts client/src/config/gravatar.ts client/src/features/session/require-session.tsx
git rm check_i18n_keys.js check_i18n_simple.js
```

Toast 二选一：①在 `app/app-shell.tsx` 的写操作成功/失败路径接 `useToast().success/error`（至少覆盖 5 个高频写操作）；②删掉 `ToastContainer` + `hooks/useToast.ts`，改用页面内联提示（现有页面已是内联提示为主，删更省）。**不要**保留「只挂容器」的中间态。

---

### 8 · P1 · 未使用依赖（HIGH · 存量）

`[FACT]` `client/package.json` 声明但全仓零引用：`@radix-ui/react-tabs`、`@radix-ui/react-tooltip`（`client/src/ui/` 只有 badge/button/card/cn/confirm-dialog/dialog/index/input/label/pagination/select/separator/skeleton/switch/table，无 tabs/tooltip 原语）。

`[INFERENCE]` 这是 P5「依赖收口」时按规划预留、但页面最终没用到；留着会让「零未使用依赖」的自查结论失真。

**修复建议**：`pnpm --filter dnsmgr-client remove @radix-ui/react-tabs @radix-ui/react-tooltip`；若后续要用，在 `00-PLAN.md` 登记「已装待用」。其余 `@types/*`、`autoprefixer/postcss/typescript` 为工具链必需（扫描误报），不必动。

---

### 9 · P1 · `docs/api.md` 分页默认值写错（HIGH · 存量）

`[FACT]` `docs/api.md:304`：「`pageSize` 每页数量，默认 **50**，最大 100」（`GET /api/domains`）；`server/src/routes/domains.ts:187` 实际 `Math.min(100, Math.max(1, parseInteger(pageSize) || 20))` → **默认 20**。而 `docs/api.md:418`（记录）写 20 是对的，`00-PLAN.md:59` 定的口径也是 20/100。

**修复建议**：改 `docs/api.md:304` 为「默认 20，最大 100（超出截断为 100）」；顺手在 §7 补 `pinned_domains` 的真实语义（`:311` 写「是否返回置顶域名」，实现是逗号分隔的域名 ID 列表，见 `domains.ts:204-206`）。

---

### 10 · P1 · 测试有效性缺口：把被测契约整体 mock（HIGH · 本轮引入）

抽查 8 条用例（`tokens-page`、`http.test`、`realtime.test`、`action-builder.test`、`ns-monitor-tab.test`、`mcp-consent-page.test`、`batch-import.test`、`domains-page-pin.test`）后，**5 条在守行为、3 条在守自己的替身**：

| 用例 | 判定 | 证据 |
| --- | --- | --- |
| `tokens-page.test.tsx:61-86` | ✅ 守行为 | 断言 `createToken` 载荷 `{name, allowed_domains:[3], allowed_services:['dns'], max_role:2}`；并断言未选域名时**不发请求** |
| `lib/__tests__/http.test.ts:38-50` | ✅ 守行为 | 断言 `http.patch` 真的发 `PATCH` 且 body 精确；`ensureOk` 对 `code:-1` 抛错 |
| `realtime.test.tsx:54-89` | ✅ 守行为 | 断言事件→queryKey 失效表（`team_member_added` 两条 key） |
| `action-builder.test.tsx:131-163` | ✅ 守行为 | 断言 DSL `args.domain = {kind:'literal'}`、`ttl` 为 **number** |
| `domains-page-pin.test.tsx` | ✅ 守行为 | 断言 `pinned_domains` 作为查询参数下发、备注提交 `remark` |
| `ns-monitor-tab.test.tsx:8-20` | ❌ 全替身 | `vi.mock('../ns-monitor-api')` 把 7 个函数全替换 → 断言的是「页面能渲染假数据」，`lib/http` 契约从未进入视野（P0-1 由此逃逸） |
| `mcp-consent-page.test.tsx:8` | ❌ 替身 | `vi.mock('../../../lib/http', () => ({ requestRaw: vi.fn() }))` —— 把「裸 JSON 适配」这个本轮刚修的核心逻辑替换掉，只测 `window.location.href` 赋值 |
| `batch-import.test.ts:1-22` | ❌ 只测纯函数 | 只覆盖 `parseBatchLine`；请求/响应结构完全无覆盖（P0-2 由此逃逸） |

**修复建议（按性价比排序）**

1. 新增 `client/src/lib/__tests__/contract.test.ts`：用 fetch 桩把**每个 feature 的一条读 + 一条写**打穿到 `http.ts`，断言真实响应形状（NS 监控 → `{success:true}` 必须报错；批量导入 → `{addedIds}` 必须能解析）。这一条能同时守住 P0-1/P0-2 的复发。
2. `mcp-consent-page.test.tsx`：删掉 `vi.mock('../../../lib/http')`，改为 `vi.stubGlobal('fetch', ...)` 返回裸 `{redirect_url}`，让 `requestRaw` 真跑。
3. `ns-monitor-tab.test.tsx`：保留现有渲染用例，**再加一条**走真实 api 模块（不 mock）的用例，只 mock fetch。
4. `batch-import.test.ts`：新增「`batchCreateRecords` 收到 `{code:0,data:{addedIds:['r1']}}` 时返回结构与对话框展示」的断言。

---

### 11 · P2 · 审计 `keyword` 是死参数（HIGH · 存量）

`[FACT]` `client/src/features/audit/api.ts:33` 与导出 `:46-52` 仍拼 `keyword`；后端 `server/src/routes/audit.ts:19-27` 的 `getAuditFilters` 只读 `domain/userId/action/startDate/endDate`。UI 已改「按域名搜索」（`audit-page.tsx:73`），`keyword` 恒为 `undefined`，属于第二轮的半成品收尾。

**修复建议**：删掉 `AuditFilters.keyword` 与两处拼接；若确需全文搜索，后端加 `keyword` 并在 `getAuditLogs` 里对 `domain/action` 做 `LIKE`，同时更新 `docs/api.md:706`。

---

### 12 · P2 · 偏好 `theme` 与服务端脱钩（MEDIUM · 存量）

`[FACT]` `settings-page.tsx:266-273` 保存时只提交 `notificationsEnabled/emailNotifications/avatarImage/backgroundImage`；主题下拉直接写 `localStorage`（`lib/theme.tsx:50-52`）；服务端 `PUT /auth/preferences` 支持 `theme`（`auth.ts:1432`）却永远收不到。

`[INFERENCE]` 后果：换设备/清缓存后主题丢回默认；管理员无法从 `preferences` 侧看到用户主题。这与「三份 theme state 收敛为唯一来源」并不冲突，但**取舍未登记**。

**修复建议**：在 `save` 里带上 `theme: theme.mode === 'system' ? 'auto' : theme.mode`（与 `lib/theme.tsx:28-30` 的存储映射同口径），首次登录时若 `preferences.theme` 存在且本地无记录则回填；若决定不落库，在 `root.ai.md:555-557` 明写「主题仅本地，不随账号同步」。

---

### 13 · P2 · `<html lang="en">`（HIGH 事实 · P2 影响）

`[FACT]` `client/index.html:2` 仍是 `lang="en"`，而产品按 `root.ai.md:520` 为单一简体中文。影响：屏幕阅读器语言错误、浏览器翻译提示误触发。

**修复建议**：改 `<html lang="zh-CN">`。

---

### 14 · P2 · `root.ai.md` 门禁命令与仓库口径不一致（MEDIUM · 本轮引入）

`[FACT]` `root.ai.md:561` 写 `npx tsc -b && npx vitest run && npx vite build && npx eslint src`；仓库/CI 的实际口径是 `npx eslint .`（`client/eslint.config.js:8-12` 只 `globalIgnores(['dist'])`，且 `src/ui/**`、`src/types/record-types.ts` 两条按目录豁免只有在 `. ` 范围内才生效；`test-suite.yml:100` 跑的也是 `run lint`=`eslint .`）。

`[FACT]` 同一行未登记两个已知失败模式：`vitest run` 偶发超时红（第 4 条）、`--coverage` 崩溃（第 3 条）。

**修复建议**：把该行改为

```bash
cd client && npx tsc -b && npx vitest run && npx vite build && npx eslint .
```

并在其后加一行「本仓库 `vitest` 全量跑需 ≥20s 单测超时；`--coverage` 目前因 coverage-v8 版本不兼容不可用（见终审 P0-3）」。

---

## 5. 门禁实跑结果（本机，HEAD `c66e96f`）

| 门禁 | 命令 | 结果 | 判定 |
| --- | --- | --- | --- |
| server 类型 | `cd server && npx tsc --noEmit` | **exit 0**，无输出 | ✅ 真通过 |
| server 单测 | `cd server && npx vitest run` | **exit 0**；`Test Files 60 passed (60)`，`Tests 541 passed (541)`，37.8s | ✅ 真通过 |
| server lint | `cd server && npx eslint . --max-warnings=0` | **exit 0**；397 文件，0 error / 0 warning | ⚠️ 通过但强度低：配置只 `files: src/**/*.ts` 且刻意关掉 `no-unused-vars`/`no-undef`/`no-undef` 等，实质只守 `eval` 类规则（`server/eslint.config.mjs:1-14` 有说明，属已知取舍） |
| client 类型 | `cd client && npx tsc -b` | **exit 0**，无输出 | ✅ 真通过（第三轮「空转门禁」确认已修） |
| client 单测 #1 | `cd client && npx vitest run` | **`Test Files 1 failed / 34 passed`，`Tests 1 failed / 141 passed`**；`action-builder.test.tsx > 按 meta 渲染参数…` `Test timed out in 5000ms` | ❌ 红（见 P1-4） |
| client 单测 #2（复跑） | 同上 | **exit 0**；`35 passed`，`142 passed`，72.8s | ✅ 绿（= 不确定） |
| client 构建 | `cd client && npx vite build` | **exit 0**；`index-CvuXHPqv.js 218.98 kB / gzip 68.68 kB`，路由 chunk 齐全（`domains-page` 12.76 kB、`records-page` 26.72 kB、`workflows-page` 42.29 kB…） | ✅ 真通过 |
| client lint | `cd client && npx eslint .` | **exit 0**；155 文件，**0 error / 0 warning** | ✅ 真通过（台账「22 警告/39 警告」的历史表述已过时） |
| client 覆盖率 | `cd client && npx vitest run <file> --coverage` | **崩溃**：`SyntaxError: The requested module 'vitest/node' does not provide an export named 'BaseCoverageProvider'` | ❌ 红（见 P0-3） |

**结论**：任务指定的 5 条门禁中，`server tsc / server vitest / client tsc -b / client vite build / 两端 eslint` 均真实通过；**`client vitest run` 不稳定，CI 使用的 `--coverage` 变体直接崩溃**。因此「门禁全绿」只能以「多次运行 + 退出码」的形式成立，单次报告不足为据。

**其它空转门禁排查结果**

- `server` 侧 lint/test 均已补齐且非空转（397 文件被检查、541 用例真实执行）；`vitest.config.ts` 里 4 个 `exclude`（`tests/db-migration`、`proxy-config`、`ns-monitor`、`domain-filter`）有明确「已知腐化待修」注释，属**已登记的欠账**而非偷偷放水。
- CI：`commit-checks.yml:108-124` 跑 server+client lint、双端 tsc、server 单测；`test-suite.yml` 另有 client 单测（带 `--coverage`，见 P0-3）与 e2e。**无 `|| true` 容错**（历史坑已修）。
- `client/package.json:11` `build = tsc -b && vite build` 与 `typecheck` 一致，不再有空转分支。

---

## 6. 经核实无问题（避免下一轮重复劳动）

1. **初始化门禁三态**（`server/src/api/init-gate.ts:27-74`）：`initialized` 全放行；`uninitialized` 仅 `exempt`（`/api/init`、`/api/rdap`）；`unreachable` 初始化面关闭且只放行 `closedStateProbes` 的 **GET/HEAD/OPTIONS**；路径统一 `toLowerCase()`，`GET /API/mcp/status` 绕过已被堵死。`app.ts:429` 在 `apiLayer.mount` 之前注册，顺序正确。
2. **`***` 掩码往返**：后端 `POST/PUT /api/accounts` 用 `mergeMaskedConfig` 把 `'***'` 还原为原值（`accounts.ts:370`），前端编辑框以 `MASK` 做占位提示（`account-dialog.tsx:142`）并原样提交 → 既不会拿 `***` 去验凭据，也不会把 `***` 写库。
3. **`line` 语义**：`service/record-line.ts` 是唯一归一化点（`'0'/''/undefined` → `undefined`；代理型提供商 `cloudflare/aliyunesa` 由 `proxied` 表达，兼容旧 `line:'0'|'1'`），`docs/api.md:58`/`00-PLAN.md:58` 表述与之一致。
4. **分页口径**：`/domains`、`/records`、`/servicemonitor`、`/ns-monitor` 的 `pageSize` 均为「默认 20 / 上限 100」（`domains.ts:187`、`records.ts:195`、`servicemonitor.ts:143`、`ns-monitor.ts:223`）；`/audit/logs`、`/logs` 为 50/200 并在 `parsePagination` 显式声明 —— 差异是设计而非漂移（唯一文档错见 P1-9）。
5. **409/403/404 落点**：团队重复成员 `409`（`teams.ts:456`）、重复域名权限 `409`（`:721,995`）、重名用户 `409`（`users.ts:135`）、无写权限 `403`（`records.ts:599` 等）、不可见域名 `404`（`records.ts:190`），前端一律走 `ApiError.msg` 展示，无静默失败。
6. **MCP 同意页契约**（第三轮 P0-1）：后端确为裸 `{redirect_url}` / `{error,error_description}`（`mcp-oauth.ts:396-441`），前端走 `requestRaw`（`mcp-consent-page.tsx:40-49`），`root.ai.md:552` 有登记 —— 已闭环。
7. **`http.patch`**：已实现（`lib/http.ts:149`）并有契约用例（`http.test.ts:38-45`）；令牌启停（`tokens/api.ts:60`）与续期开关（`renewal-api.ts:51`）均与后端 `PATCH /tokens/:id/status`、`PATCH /domains/renewable-domains/:id/toggle-enabled` 对齐。
8. **主题唯一来源**：`ThemeProvider` 包裹整个应用（`App.tsx:57`），`/login`、`/setup`、`/oauth/*` 均继承；`index.html:8-19` 内联脚本首屏前应用，无白闪。
9. **旧栈清零**：`grep -r 'tdesign|i18next|axios'` 在 `client/src` 为 0（仅 `server/src/routes/workflows.ts:394` 一条注释提到 axios 行为）；`client/src/{pages,contexts,api,i18n}` 均不存在。
10. **实时映射**：`EVENT_QUERY_MAP`（`app/realtime.tsx:13-68`）与后端 46 个事件类型逐一比对，仅映射到不存在的 key 的只有既有的 `['service-monitors']`/`['ns-monitors']` 两类前缀（前端确有同名 queryKey，成立）；`ns_monitor_prefs_updated`、`2fa_enabled/disabled`、`['domain']` 前缀失效均已在（第三轮 P1-8 闭环）。
11. **契约抽样一致的 feature**（≥10）：tokens、accounts、domains、records(除 batch)、users、teams、audit、settings、security、system(info/version)、network(proxy/connectivity)、settings(security/smtp/oauth/allowlist/notifications)、mcp(config/api-keys/oauth/audit-logs)、servicemonitor、tunnels、workflows、auth(login/oauth/preferences) —— 路径、方法、参数名、响应字段均与 `server/src/routes/*` 一致。

---

## 7. 建议的收尾清单（按优先级，全部可执行）

1. **[P0] NS 监控信封统一**：`server/src/routes/ns-monitor.ts` 11 处 `{success:true}` → `sendSuccess`；删 `client/src/features/domains/ns-monitor-api.ts:42-47` 的 `unwrapNs`；补 fetch 桩契约用例。
2. **[P0] 批量导入结构对齐**：`client/src/features/records/api.ts:100-114` 与 `batch-import-dialog.tsx:67-78` 按 `{addedIds}` 改写；部分成功改用 `http.post` 自判 `code`；补响应结构用例。
3. **[P0] 覆盖率门禁**：`@vitest/coverage-v8` 降到 `^2.1.9`；重写 `coverage.include`；CI 把 `test` 与 `test --coverage` 拆成两步。
4. **[P1] 单测稳定性**：`client/vitest.config.ts` 设 `testTimeout/hookTimeout = 20000`；`action-builder` 首条用例单独放宽；台账改记「跑 N 次 + 退出码」。
5. **[P1] 文档三处**：`root.ai.md` §服务层/§路由按 `api/index.ts` 重写、TOTP 改 `otplib`、邮件模板前缀改 `/api/domains/email-templates`；`docs/api.md:304` 改 20、补 `pinned_domains` 与批量响应；`docs/api.md:32` 或改实现或改声明（8 处 `code:-1`）。
6. **[P1] 死代码与依赖**：`git rm` 三个零引用文件 + 根目录两个 i18n 脚本 + 两个未用 Radix 包；Toast 决定「接生产者」或「整条删」。
7. **[P2] 小项**：`index.html` `lang="zh-CN"`；`audit/api.ts` 删 `keyword`；主题偏好是否落库二选一并登记；`root.ai.md:561` 门禁命令改 `eslint .`。
8. **验收口径**：以上 P0 全部修复后，用**同一份命令清单跑 3 次**（含 `--coverage`）全绿再宣布收口；并把这 3 次输出落到 `ai-censorship/evidence/` 作为验收证据。
