# 前端重构收尾总结（2026-10-23）

> 本文是 `00-PLAN.md` 的配套总结：记录**做成了什么、证据在哪、还剩什么**。
> 方向由 `root.ai.md` 定义；本文件不重复架构说明，只回答「完成度」。

## 1. 目标对照

| 目标 | 交付 | 证据 |
| --- | --- | --- |
| 前端逻辑与语言全部抛弃，改用主流框架与组件库 | React 19 + Vite 8 + TanStack Query 5 + React Router 7 + Tailwind 3.4 + Radix/shadcn 风格 `ui/` | `client/src/ui/`、`client/package.json` |
| 保证页面审美 | 29 个页面/区块统一外壳、统一间距与徽标体系；暗色主题全链路（含首屏内联脚本） | `ai-censorship/evidence/*.png` |
| 重构约束 API 语义 | 统一信封 `{code,data,msg}`、`code === HTTP`、写操作强制 `ensureOk`、裸 JSON 端点专用 `requestRaw` | `client/src/lib/http.ts`、`docs/api.md` |
| API 注册独立成后端子模块 | `server/src/api/`（registry / init-gate / mount / index），唯一注册点，24 个模块，三态门禁 | `server/src/api/`、`docs/refactor/00-PLAN.md` |
| 修复遗留隐性问题 | 错误码契约、`***` 掩码往返、`line` 语义、分页 20/100、初始化闸门、WS 事件映射等 | 下文 §3「评审闭环」 |
| 代码审核团多轮评审 | 四轮独立评审，共 **38 条发现**，全部关闭 | `ai-censorship/evidence/refactor-*-review*.md`、`refactor-final-audit.md` |
| 前后端解耦 / 模块解耦 / 微架构 | `features/<domain>/{api,use-*,page,tests}` 四件套；页面不直接拼 URL；后端 routes → service → db 分层 | `client/src/features/`、`server/src/routes/` |

## 2. 量化结果

| 指标 | 重构前 | 现在 |
| --- | --- | --- |
| 前端路由页面 | `client/src/pages/` 约 23 个文件、`pages/domains` 4 个 tab | **29 个页面/区块全部在 `features/`**，`pages/` 目录已删除 |
| UI 依赖 | TDesign + 图标包 + i18next + 11 个语言包 | **无**（TDesign/i18next/axios 均已移除） |
| 主包体积 | 619 kB（gzip 169 kB） | **219 kB（gzip 68.7 kB）**，38 个路由 chunk |
| 用例 | client 少量、server 541 | **client 149 + server 544** |
| 覆盖率 | 无（覆盖率命令本身崩溃） | **语句 74.36%**，`vitest run --coverage` 可用 |
| lint | 数百条存量、CI `|| true` | **0 problem**；`no-unused-vars`、`set-state-in-effect` 已收紧为 error |
| 门禁真实性 | `tsc --noEmit` 在 solution 式 tsconfig 下**空转** | 统一 `tsc -b`，并修正 00-PLAN 与 CI 口径 |

## 3. 评审闭环（四轮，38 条）

| 轮次 | 报告 | 主要产出 |
| --- | --- | --- |
| 一 | `refactor-p0-api-review.md` 等 | 后端 API 子模块、门禁三态、错误码契约 |
| 二 | `refactor-frontend-review-2.md`（12 条） | SMTP 字段名错、新增域名入口丢失、写接口不判信封、团队权限缺闸门 |
| 三 | `refactor-final-review.md`（12 条） | 门禁空转、`http.patch` 缺失、MCP 同意页契约、主题唯一来源 |
| 四 | `refactor-final-audit.md`（14 条） | NS 监控全废、批量导入必崩、覆盖率门禁崩溃、文档漂移 |

关键教训（都写进了代码注释或测试）：

1. **「构建通过」不等于「功能可用」**——NsMonitor 七端点全废、批量导入必崩，都是因为用例把被测 api 整体 mock 掉。现在补了 `ns-monitor-api` / `batch-api` 的 fetch 级契约用例。
2. **门禁本身要验证**——`tsc --noEmit` 在 solution 式工程下退出 0 却不检查任何文件，导致多轮「0 错」结论失效。
3. **删文件要跨仓搜索**——删 `client/src/i18n/` 时服务端仍有测试在扫它；现在有 `docs-consistency.test.ts` 兜底文档路径。

## 4. 已知限制

| 项 | 说明 |
| --- | --- |
| 工作流触发器可视化 | 后端无 `/workflows/meta/triggers` 候选源（404），线上回退 JSON 编辑；动作可视化完整 |
| 服务监控故障转移绑定 | 后端 `children` 接口在，前端暂无绑定/解绑 UI（已在台账登记） |
| 覆盖率 | 74.36%，未设阈值门禁；后续可按模块逐步提高 |
| 浏览器端到端 | 有 Playwright 截图脚本（mock API），未接真实后端的 E2E 套件 |

## 5. 复现门禁

```bash
cd server && npx tsc --noEmit && npx vitest run
cd client && npx tsc -b && npx vitest run && npx vite build && npx eslint .
cd client && npx vitest run --coverage
```
