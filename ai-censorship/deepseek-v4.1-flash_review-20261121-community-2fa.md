# 审核团：社区入口 + #43 闭环复核（2026-11-21）

> 成员：`reviewer-code`（前端与文案）、`reviewer-test`（#43 闭环与门禁）。只读审核。

## 结论

- `reviewer-test`：上一轮两个 P0 的「点」修了，但 `email_verified` 被写成「保存一次资料就置 1」，验证形同虚设；安全页与登录判定口径不一致，存在「显示已启用 → 登录不校验 → 按钮还被禁用」的可达状态。
- `reviewer-code`：三处 QQ 入口渲染正常（原生 `<a>` + `rel=noopener`，登录页全步骤可见），仪表盘那行不碰 grid；但查出关于页与落地页把协议写成 **MIT**，仓库实际是 **GPL-3.0**。

## 已落实（提交 50889edb）

| 级别 | 问题 | 处理 |
|---|---|---|
| P0 | `email_verified` 写在分支外，只改昵称也会置 1 | 移进「邮箱确实变更且验证码通过」分支 |
| P0 | 关于页 / 落地页协议写成 MIT（实际 GPL-3.0） | 两处改为 GPL-3.0 |
| P1 | 管理端改邮箱不重置验证状态 | `users.ts` 同步 `email_verified = 0` |
| P1 | 安全页与登录判定口径不一致 | `/2fa-status` 返回「生效值 + rawEnabled」，按钮据 rawEnabled 允许关闭 |
| P1 | `release.yml` 的 `inputs.version` 无校验 | Prepare 阶段比对三处 package.json，不一致直接失败 |
| P2 | `has2FA` 不认 email | SQL 增加 `type='email'` |
| P2 | `test-suite.yml` 仍手搓 lint/build | 换成 `pnpm gate`，三条 CI 路径同源 |
| P2 | 关于页卡片序列出现 grid 空洞 | QQ 并入「社区与文档」卡，删除独立卡 |
| P2 | 品牌写成 `HIDNS` / 链接可访问名与下划线 | 统一 `HiDNS`、加 `aria-label`、常驻下划线 |
| P2 | Telegram 链接 App 与 README 分叉 | 统一为 README 的 `t.me/HiDNSManager` |

## 未落实（记录在案）

1. **Telegram 有效链接未经人工验证**：沙箱内 `t.me` 直连超时。当前按 README 统一为 `t.me/HiDNSManager`，需人工点开确认。
2. **`check:actions` 与 `vitest run` 冗余**：保留（独立红点有信号价值），未删除。
3. **`server/scripts/**/*.test.node.ts` 与 `e2e/**` 未纳入类型检查**：前者是 ESM + node:test 与 commonjs 主配置冲突，后者连 tsconfig 都没有；两者都需要独立配置，属后续任务。
4. **路由级用例未补**：`PUT /profile` 的分支逻辑没有抽出可测函数，现有 3 条用例覆盖到 BAL 层（含「只改昵称不置 1」）；真正路由级用例需要 app + auth 夹具，未做。
5. **`tsconfig.test.json` 保留 `include: [tests, src]`**：收窄到 `tests` 会误报 `node:sqlite` / `punycode.js` 的类型解析差异（实测 3 个错误），冗余可接受。