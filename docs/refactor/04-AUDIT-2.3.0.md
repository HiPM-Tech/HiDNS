# 2.3.0 重构目标达成度审核（审核团 · 2026-10-25）

> 审核依据：`root.ai.md`（第一权威）→ `docs/refactor/00-PLAN.md`（目标与非目标）→ `ai-censorship/dsh-agent_review-20261023-panel.md`（86 条隐性问题）→ 当前代码与门禁。
> 审核方式：4 位评审分线独立核对（后端约束 / 前端架构 / 架构 / 视觉），每人给判定与可复现证据；本文件为主审汇总。
> 基线：本地 tag `v2.3.0`（提交 `1935263d`）与当前 HEAD（2.3.1 未发布）。**判定区分「2.3.0 时点」与「HEAD」**。

## 一、总结论

| # | 00-PLAN §1 目标 | 2.3.0 时点 | HEAD（含 2.3.1 收尾） | 关键缺口 |
| --- | --- | --- | --- | --- |
| 1 | 前端整体重写 | **部分达成** | **部分达成** | 3080 行 legacy `globals.css` 仍在包内（109 条 `.t-*`、38 处 `!important`、2 处失效变量引用）；四件套 12/19；2 个页面直连 http |
| 2 | API 语义收敛 | **部分达成** | **部分达成** | `code===HTTP` 已 0 违例，但 138 处 `{code,msg}` 缺 `data`；分页四套上限/0 基与 1 基并存；`allowed_services` 只有声明无执行点；畸形 JSON → 500 |
| 3 | API 注册独立子模块 | **达成** | **达成** | 文档写 24 模块、实际 23（口径需统一） |
| 4 | 遗留隐性问题清理 | **部分达成** | **部分达成** | P0 5/7（P0-4 换成了新问题、P0-5 在 2.3.1 才修）；P1 抽样 24 条：11 达成 / 3 部分 / 10 未达成 |
| 5 | 前后端解耦 | **部分达成** | **部分达成** | 无「生成的类型」（openapi/codegen 零命中）；依赖环 15 模块 SCC 未收敛；DSM 无 rollback |
| — | **DNS 适配器语义** | **未达成** | **达成**（2.3.1 收尾） | 线路模型、`lineSource/defaultLine`、redirect 能力位均来自 `03bd1c08`/`9e6d9070`/`57f2292f`/`9fd03ac6` |

**一句话**：2.3.0 的「接线类」目标（API 子模块、门禁三态、契约测试、前端迁移）确实落地；「收尾类」目标（旧样式清理、类型生成、执行点闭环、台账准确性）只完成一半。**若以 `v2.3.0` 标签为验收点，DNS 适配器语义明确不达标；以 HEAD 验收则达标。**

## 二、逐目标证据

### 目标 1 · 前端整体重写：部分达成

已达成（可复现）：
- 技术栈：React 19.2.4 / Vite 8.0.1 / TanStack Query 5.80 / React Router 7.2 / Tailwind 3.4.17 / Radix + lucide
- 旧栈代码：`grep -r 'tdesign|i18next|axios' client/src` 仅 5 处注释；`client/src/{pages,contexts,api,i18n,hooks}` 均不存在
- 门禁实数：`tsc -b` 0 错；`vitest` **41 文件 / 161 用例**；`vite build` 主包 **222.08 kB（gzip 69.99 kB）**；`eslint` 158 文件 0 problem
- 暗色/窄屏/弹窗/文案：暗色卡片/页面 1.12:1、1440/1024/768 三档 11 页 `docOverflow=0`、768 弹窗 576px 不裁切、焦点环 2px

未达成：
- **legacy 样式未抛弃**：`client/src/styles/globals.css` **3080 行**，`.t-*` **109 条**、`--td-*` 引用 **149 处**、`!important` **38 处**；与 152 个 TS 文件求交后**仅 2 个类被引用、226 个零引用**，仍随 `index.css` 全量 `@import` 进入 `dist/index-*.css`（87,335 B / gzip 15.5 kB）
- **失效变量引用**：`globals.css:109-121` 滚动条用 `--td-bg-color-page`/`--td-component-stroke`（运行时 undefined）；`:79,1790,1829` 的 `var(--app-scaled-vh)` 计算为 0px
- 四件套覆盖 **12/19**（about/marketing 无 `api.ts`；auth/mcp/oauth/setup/about/marketing 无 `use-*.ts`）
- 页面直连 http：`oauth-callback-page.tsx:57`、`mcp-consent-page.tsx:41`
- 间距令牌：`gap-phi-*` 32 处 vs `gap-3/4` 43 处；9 个文件 `CardContent` 用 `p-4/p-6` 覆盖默认 27px
- 量化表失真：01-SUMMARY 写 149/544/219kB/38 chunk，实测 **161/638/222.08kB/39**

### 目标 2 · API 语义收敛：部分达成

已达成：`code===HTTP` 扫描 0 违例；分页参数名统一 `page/pageSize/total/list`；域名权限口径（`can_write`/团队/只读）统一；批量上限与 422 已落地。

未达成：
- **138 处 `{code,msg}` 缺 `data`**（`server/src/**`），与「信封恒有 data」冲突
- **分页未真正收敛**：0 基与 1 基并存、四套上限（100/200/1000/1440）、`/api/accounts` 返回形状随 `page` 参数切换
- **`allowed_services` 零执行点**：`service/token.ts:174-176` 的 `hasServicePermission` 唯一调用方 `middleware/auth.ts:69` 的 `requireServicePermission`，而 `grep -rl requireServicePermission routes/` = **0**；`token-policy.ts` 自述“服务级门禁尚未全面接线”，与 `docs/api.md:775` 承诺不符
- 畸形 JSON 请求体 → **500**（`errorHandler.ts` 只处理 `entity.too.large`，无 `entity.parse.failed`）

### 目标 3 · API 注册独立子模块：达成

- `server/src/api/{registry,init-gate,mount,index}` 存在；`app.ts` 仅保留 `/api/docs`，业务 `app.use` 为 0
- `registry.ts` 强制前缀唯一；`init-gate.ts` 三态门禁实测 503/200 正确，且由模块声明派生
- 差异：文档写 24 模块，`index.ts` 实际 **23** 个 `id:` 声明（需统一口径）

### 目标 4 · 遗留隐性问题清理：部分达成

- **P0：5/7 达成，2/7 部分**
  - 已修：P0-1 初始化守卫、P0-2 DSM 删表默认 `never`、P0-3 标记同源、P0-6 `line` 语义、P0-7 凭据掩码
  - P0-4 部分：`recordCountCache.ts:18-24` 用 `total>0` 规避而非建立失败通道 → 抖动写 0 修了，但「真删到 0 条永不刷新」成为新问题；92 处错误折叠仍在
  - P0-5：`RecordId` 的 `'success'` 兜底在 2.3.1（`03bd1c08`）才清除，2.3.0 时点未达成
- **P1 抽样 24 条（约 41%）**：11 达成 / 3 部分 / 10 未达成
  - 未达成示例：`taskManager.ts:260-271/326-330` 超时只 `reject` 不取消 `fn()`（同 ID 双跑窗口）；`rateLimit.ts:102-107` 任意 `Bearer x` 免 RDAP 限流；`settings.ts:385` `/smtp/test` 缺 `noTokenAuth`；`providers.ts:20` icon 无鉴权
- 台账准确性：`00-PLAN §4` 把「分页统一」「panel P0 全部 + P1 安全类」标为已完成，与上述冲突

### 目标 5 · 前后端解耦：部分达成

已达成：`client` 0 处 import server；`lib/http.ts` 是唯一 HTTP 出口（`fetch` 仅 2 处，features 内 0 处）；会话/令牌双契约只在 api 层处理；`docs/api.md` 1082 行 + 3 个契约测试。

未达成：
- **没有「生成的类型」**：`grep -r 'openapi|swagger|codegen|generated' client/` = 0；14 个 `api.ts` + 8 个 `*-api.ts` 全手写
- 契约测试只查文档路径与废弃词，不查字段级一致性 → 本会话已因此产生 `enabled`、`expectedStatus` 等 2 处 P1
- 前端 41 条用例全 mock，无 fetch 层契约断言；UI 靠 `msg` 文本匹配分类错误
- 架构：15 模块强连通分量未收敛；DSM 无 rollback

### DNS 适配器语义：2.3.0 未达成，HEAD 达成

- 2.3.0 tag 上不存在 `service/providerLines.ts`、`providerLinesJob.ts`，`registry.ts` 的 `lineSource:` 计数为 0，`redirect` 仍在 `DnsCapabilities` 且无执行点
- HEAD 已达成：线路模型（builtin/dynamic、defaultLine、3600s 缓存、失败仅默认、5min 重试、PSL 共用 taskManager）、redirect 能力位（未声明一律忽略）、RecordId 真实化、能力位执行（proxiable/status/remark/weight）、别名归一化
- 依据：`03bd1c08`、`9e6d9070`、`57f2292f`、`9fd03ac6` 四个提交 + `adapter-contract.test.ts` / `providerLines.test.ts` / `huawei-line.test.ts`

## 三、按优先级排的缺口（建议下一轮修）

| 优先级 | 缺口 | 建议修法 |
| --- | --- | --- |
| P0 | legacy CSS 3080 行随包发布（旧样式组织未抛弃） | 删除零引用类/变量 + 加 CSS 体积与「无 `.t-*`」门禁 |
| P0 | `record_count` 失败折叠（P0-4） | 适配器失败抛错、服务层 fail-closed，删除 `total>0` 规避 |
| P0 | `allowed_services` 零执行点 | 在 `api/` 模块声明层接线 `requireServicePermission`，并补测试 |
| P1 | 138 处信封缺 `data` | 统一 `sendError` 调用点，扫描门禁覆盖 |
| P1 | 分页 0/1 基与四套上限 | 收敛为 `page`（1 基）+ 上限 100，例外白名单化 |
| P1 | 畸形 JSON → 500 | `errorHandler` 增加 `entity.parse.failed` → 400 |
| P1 | `taskManager` 超时不取消 | 引入 AbortSignal/取消语义，running 状态延后释放 |
| P1 | 鉴权漏点（RDAP Bearer、`/smtp/test`、providers icon） | 逐端点补 `noTokenAuth`/鉴权与限流 |
| P2 | 无生成类型 | 用 `docs/api.md` 或 OpenAPI 生成客户端类型 + 字段级契约测试 |
| P2 | 四件套 12/19、2 页直连 http | 补齐 `api.ts`/`use-*.ts`，把 HTTP 调用移出页面 |
| P2 | 台账与量化表失真 | 更新 `00-PLAN §4`、`01-SUMMARY` 的实测数字与完成度 |

## 四、评审报告索引

- 后端约束：`ai-censorship/dsh-agent_review-20261023-be.md`「## 2.3.0 重构目标核对」
- 前端架构：`ai-censorship/dsh-agent_review-20261023-fe-arch-review.md` 同名章节
- 架构：`ai-censorship/dsh-agent_review-20261023-arch.md` 同名章节
- 视觉：`ai-censorship/dsh-agent_review-20261023-design-critic.md` 同名章节

## 五、审核团判定（汇总）

| 评审 | 覆盖目标 | 判定 |
| --- | --- | --- |
| be-constraint-review | 2、3、适配器语义 | 3 达成；2 部分；适配器 2.3.0 未达成 / HEAD 达成 |
| fe-arch-review | 1、5 | 均部分达成 |
| arch-auditor | 4、架构 | 4 部分（P0 5/7）；结构风险未收敛 |
| design-critic | 1（审美/一致性） | 审美与一致性达标，旧样式组织未抛弃 → 部分 |

**主审结论**：**2.3.0 计划的重构目标未全部达成**；其中「API 子模块」达成，其余四项部分达成；**DNS 适配器语义在 2.3.0 时点未达成，在 HEAD（2.3.1 未发布）达成**。
