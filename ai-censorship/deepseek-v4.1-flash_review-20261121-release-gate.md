# 审核团：Release Gate 与本地门禁一致性（2026-11-21）

> 依据 `root.ai.md` §代码审核团。评审成员：`reviewer-test`（门禁一致性）。
> 触发事件：v2.3.9 首次发布被 `Release Gate` 挡住（run 44906404255），失败项 `tsc -b` 报 TS2353 / TS2339。

## 结论

失败不是「漏跑某项检查」，而是**本地根本没有一条与 CI 等价的命令**：`client/` 的 `tsc --noEmit` 是空转（实测检查 0 个文件却 exit 0），仓库根目录连 `tsc` 都没装。

## 发现

### P0 · 本地无等价门禁

- `client/tsconfig.json` 是 solution 式（`"files": []` + `references`），非 `-b` 模式的 `tsc --noEmit` 不做任何检查却 exit 0。
- 证据：`cd client && tsc --noEmit --listFilesOnly | wc -l` → `0`；`tsc -p tsconfig.app.json --noEmit --listFilesOnly` → `710`。
- 同一问题在 2026-10-23 已记录并修过一次（`docs/refactor/01-SUMMARY.md:28`），本轮复发的原因是当时只改了文档里的命令，没固化成脚本。

### P1 · Release Gate 覆盖面不足

- Gate 只跑 5 件（两端 lint、两端 build、`check:actions`、server vitest、server node:test），**没有 client 测试**。
- 缺 `root.ai.md` §提交前校验 第 8 条的两项：文档源码路径可达性、三处 `package.json` 与 CHANGELOG 顶部版本一致性。
- tag / input 版本 / 三处 package.json 三者之间没有一致性校验；tag 推送本身不触发任何门禁。
- `server/tsconfig.json` 只覆盖 `src/**/*`，`server/tests/**` 与 `server/scripts/**` 不在任何 tsc 项目里。

### P2 · 名不副实的 gate 与仓库卫生

- `check:actions` = `vitest run src/workflow`，与下一行全量 `test` 重复；真正约束命名空间的只是一个普通用例。
- 根目录没有聚合脚本、也没有声明 `typescript`。
- `server/tsconfig.tsbuildinfo` 被 git 跟踪，但 `server/tsconfig.json` 并未开启增量构建。
- 无 `.nvmrc` / `engine-strict`，本地可在 Node 22 上跑，而 CI 固定 24.22.1。

## 已落实（提交 56e0569e）

| 项 | 处理 |
|---|---|
| 唯一入口 | 根 `package.json` 新增 `gate` / `gate:docs` / `gate:versions` |
| 文档路径校验 | `scripts/verify-docs-paths.mjs`（跳过归档/历史文档） |
| 版本一致性 | `scripts/verify-versions.mjs`（三处 package.json + CHANGELOG 顶部） |
| CI 统一 | `release.yml` 与 `commit-checks.yml` 的 Gate 步骤都改为 `pnpm gate` |
| `check:actions` | 改为精确跑 `namespaces.test.ts` |
| 构建产物 | `git rm --cached server/tsconfig.tsbuildinfo` + `.gitignore` 加 `*.tsbuildinfo` |
| 文档 | `websocket-integration-guide.md` 的 `.tsx` 扩展名修正 |

本地 `pnpm gate` 实测：**EXIT=0**（server 791 + client 216 用例全绿，含文档与版本校验）。

## 未落实（记录在案）

1. **`server/tests/**` 类型检查**：尝试加 `server/tsconfig.test.json` 后暴露 7 个既存错误（`tests/setup.ts` 缺 vitest 全局、`scripts/lib/*.test.node.ts` 引用 `.mjs` 无声明、`import.meta` 模块配置）。需要先修这批既存问题再纳入门禁，属独立任务。
2. **e2e 与三库矩阵**：`test-suite.yml` 有，Release Gate 未含。按发布时长决定，暂时保留在 test-suite。
3. **`.nvmrc` / `engine-strict`**：本地 Node 版本与 CI 不一致会导致「本地绿 ≠ CI 绿」，建议补。
4. **tag 与版本一致性**：本次已人工核对（三处 package.json 均 2.3.9、tag 已撤销），但未进 gate 脚本。

## 需要拍板

1. 是否把 `server/tests/**` 的类型检查纳入门禁（需要先修 7 个既存错误，工作量中等）。
2. Release Gate 是否包含 e2e / 三库矩阵（会显著拉长发版时间）。