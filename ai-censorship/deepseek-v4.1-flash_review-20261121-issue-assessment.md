# 审核团评估：issue 批量排期（2026-11-21）

> 依据 `root.ai.md` §代码审核团（第 10-28 行）。评审成员：`assess-backend`（RDAP / PowerDNS / 令牌权限）、`reviewer-code`（Passkey / ECharts / 背景 / 邮箱登录）。
> 评审过程只读，未改动仓库文件；本文件由 lead 汇总落盘。

## 一、评估结论总览

| Issue | 主题 | 优先级 | 工作量 | 批次 | 状态 |
|---|---|---|---|---|---|
| #56 | PowerDNS 增删误报失败 / 第二条 TXT 覆盖 | **P0** | 中 | A | **已修复**（`bd7faef4`） |
| #57 | Passkey 注册找不到硬件 | P1 | 小 | A | **已修复**（`30509ef8`） |
| #59 | .site 等后缀拿不到到期时间 | P1 | 中 | A | **已修复**（`846c7f7f`） |
| #50 | 背景透明度 / 模糊 | P2 | 小 | A | 待拍板后开工 |
| #52 | ECharts 图表 | P2 | 中→大（拆 52-A/52-B） | A / B | 待拍板 |
| #43 | 邮箱验证码登录 | P2（安全等同 P1） | 大 | C | 待拍板 + 数据整改 |
| #38 | 细粒度 API 令牌权限 | P2 | 大 | C1/C2 | 待拍板 |

## 二、已实施（本轮）

### #56 PowerDNS（P0）

- 根因：`powerdns/adapter.ts:80` 无条件 `res.json()`，而 `PATCH /zones/{id}` 成功返回 **204 空体** → 抛 `Unexpected end of JSON input`；原 `res.status === 204 ? true : data` 分支永远不可达。
- 根因：`rrsetReplace` 以 `changetype: 'REPLACE'` 只回写 1 条记录，而 PowerDNS 的记录模型是 **rrset（name+type 集合）** → 同名同类型其它记录被抹掉（ACME 多 TXT 直接失效）。
- 根因：`update/delete/setDomainRecordStatus` 以 `!this.rrsetsCache` 早退，而路由每次新建 adapter → 请求未发出即失败。
- 修复：`request` 先读 `text` 再按需 `JSON.parse`；`add` 改为「读现有 rrset → 追加（同值去重）→ 回写」；新增 `ensureRrsets` 按需拉取 zone；写操作包 `withDomainLock`。
- 用例：204 空体不报错且先拉 zone / 第二条 TXT 追加 / 删除单条保留其它（仓库此前无 powerdns 测试）。

### #57 Passkey（P1）

- 根因：`server/src/routes/webauthn.ts:54` 写死 `authenticatorAttachment: 'platform'`，没有平台认证器的机器（Linux 桌面、外接 USB 安全密钥）必然失败。
- 修复：移除该限制；新增 `client/src/lib/webauthn-error.ts` 按 `err.name` 给出可操作提示（NotAllowed / NotSupported / SecurityError / InvalidState / Constraint），并保留密码登录退路。

### #59 RDAP（P1）

- 根因：`lookup.ts:217-218` 在 `providers.length === 0` 时先 `return null`，让后面的 IANA 兜底（`:221-224`）成为死代码 → 所有没有内置 RDAP 条目的后缀（`.site/.de/.fr/.xyz/.top…`）都拿不到到期时间。
- 根因：`initRdapServerList()` 全仓库零调用，`rdap_server_cache` 永远为空。
- 修复：先试 IANA 再判空；`app.ts` 启动后异步预热（失败只 warn，不阻塞启动）。

## 三、待拍板

1. **#57 是否允许非平台认证器** —— 本轮已按「允许」实施（移除 `authenticatorAttachment`），若产品要求只允许平台认证器需回退。
2. **#50 透明度作用层级** —— (A) 只调背景蒙层 `--scrim-alpha`；(B) 蒙层 + 卡片面板；(C) 全量（含侧栏顶栏）。注意 `tokens.css:112-125` 把 `--scrim-alpha` 重新定义在 `body` 上，只改 `:root` 无效。
3. **#52 图表范围** —— (A) 仅现有数据（提供商占比 / 到期分布 / 资源指标）；(B) 接受新增采样表（服务监控历史 / 解析量）→ 需 DB 变更与保留期策略。
4. **#43 定位** —— 「邮箱 2FA 第二因子」还是「独立免密登录」；且 `users.email` **无唯一约束**、无 `email_verified`，必须先做数据整改。
5. **#38 权限词表** —— 统一到 `资源:动作`（保留 `dns`/`mcp` 别名一个版本），还是在模块名上叠加动作位。
6. **#56 记录 ID 契约** —— 继续位置式 `rrsetId_recordId`（顺序变化可能删错），还是改稳定键。

## 四、未确认（不猜）

- `.site` 的 `whois.nic.site` 具体响应格式为何解析不出 expiry（需真实响应）。
- #56 用户实际命中的是「204 解析抛错」还是「`rrsetsCache` 为 null 早退」（需 debug 日志；本轮两条都已修）。
- 用户库 `rdap_server_cache` 为空是「从未调用」还是「调用过但下载失败」（需启动日志）。
- RDAP 下载与查询目前走原生 `https.request`，未走 `fetchWithFallback` → **代理部署下预热可能仍失败**，需后续统一出站通道（见 `root.ai.md` 对出站通道的要求）。

## 五、后续批次

- **批次 A（进行中）**：#56 ✅ / #57 ✅ / #59 ✅ / #50（待拍板）/ #52-A（待拍板）。
- **批次 B**：#52-B（历史表）/ #43 数据整改（`users.email` 唯一性 + 验证状态）。
- **批次 C1/C2**：#38 词表统一 → 前端 + 子域级。