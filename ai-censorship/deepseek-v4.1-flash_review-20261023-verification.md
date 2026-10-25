# 审核团核验复核（复核人：执行层 AI）

> 依据 root.ai.md 第 5 条「当 AI 阅读到本文件时，需要进行全面代码审查」，本轮向前端架构审核团与后端约束审核团发出核验请求。
> 本文只记录**我对两份报告的独立抽查**，不重复报告内容。

## 输入

| 审核团 | 报告 | 计数 | 门禁实跑 |
| --- | --- | --- | --- |
| 前端架构 | `deepseek-v4.1-flash_review-20261023-fe-arch.md`（252 行） | P0=0 / P1=1 / P2=11 | `tsc -b` 0、`vitest` 37 文件 146 条全绿、`vite build` 0、`eslint .` 0（151 文件 0 warning） |
| 后端约束 | `deepseek-v4.1-flash_review-20261023-be-constraints.md`（169 行） | P0=0 / P1=4 / P2=8 | `tsc --noEmit` 0、`vitest` 61 文件 541 条全绿、`eslint` 0、`tsx --test` 149 通过 |

## 抽查结果（逐条核对源码）

| # | 报告主张 | 我的核对 | 结论 |
| --- | --- | --- | --- |
| 1 | 前端 P1：`utils/rsaEncrypt.ts` 绕过 `lib/http` | `rsaEncrypt.ts:18` 确有硬编码 `fetch('/api/auth/public-key')`，无 `apiBaseUrl()`、无 401/超时约定 | **属实** |
| 2 | 前端 P2：`vite.config.ts` 残留 tdesign/i18next 死配置 | `vite.config.ts:34-35` 仍有两组 `manualChunks` 分支 | **属实** |
| 3 | 后端 P1-1：auth 中间件 `code:-1` + errorHandler 用 `{code,message}` | `middleware/auth.ts:24/54/69/90/100` 为 `code:-1` 配 401/403；`errorHandler.ts:49-55` 返回 `{code,message,details,timestamp}`，缺 `msg`/`data` | **属实**（与 docs/api.md 契约冲突） |
| 4 | 后端 P1-2：OAuth 敏感值进 debug 日志 | `routes/auth.ts:285` 记录 token 请求 body（含 client_secret）、`:295` 记录 token 响应 payload（含 access_token/id_token） | **属实**（默认 info 不输出，开 debug 即明文落盘） |
| 5 | 后端 P1-3：`POST /records/batch` 无条数上限 | `routes/records.ts:591` 起无长度校验；文件内 `batchSize=100`（:241）属导出分页，与此无关 | **属实** |

结论：抽查的 5 条全部与源码一致，两份报告未见夸大或臆测；其余未抽查条目按报告标注的置信度处理。

## 复核中额外确认

- `tsc --noEmit` 在 client 的 solution 式 tsconfig 下确实零诊断（报告主张成立），门禁只能用 `tsc -b`；
- `grep -rn 'tdesign|i18next|axios|contexts/|src/pages|src/i18n' client/src client/package.json` 零命中 → 旧栈运行时代码确已清零，仅 `vite.config.ts` 有死配置残留；
- `server/src/api/index.ts` 共 23 个 `prefix:` 模块条目，与「API 注册独立成子模块」一致。

## 建议的处置顺序（供项目团队拍板）

1. **前端 P1**（`rsaEncrypt` 走 `lib/http`）：影响 `VITE_API_URL` 部署下的登录链路，1 处改动 + 1 条用例；
2. **后端 P1-1**（`code` 与 HTTP 状态一致 + errorHandler 改 `sendError` 形状）：影响所有 401/403 的前端提示质量；
3. **后端 P1-2**（日志去敏）：把 body/payload 改为键名摘要，3 行改动；
4. **后端 P1-3**（批量上限 + 走 `record-line` 归一化）：与 docs/api.md 的 422 承诺对齐；
5. 文档漂移（Toast/ToastContainer、四件套、服务端门禁命令、OAuth/邮件模板前缀）：一次文档提交收敛。
