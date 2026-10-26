# API 索引（旧版摘要已归档）

> **权威文档是 [`docs/api.md`](api.md)。** 本页不再复制端点表、参数表或示例代码——这些内容只维护一份，就在 `api.md`。
>
> 旧版（`DNSMgr API 参考文档`）只覆盖域名/记录/账号/用户/审计/系统 6 个模块，标题与示例仍用 `DNSMgr` 旧名；`servicemonitor`、`resource-monitor`、`workflows`、`ns-monitor`、`network`、`mcp`、`security`、`settings`、`tokens` 等模块完全没有。它不能作为对接依据，故降级为本索引。

## 去哪找

| 你要查的 | 位置（`docs/api.md`） |
|---|---|
| 鉴权方式（JWT / API Token）、统一信封 | §鉴权方式 |
| 系统初始化、认证、WebAuthn | §1 系统初始化；§2 认证；§3 WebAuthn |
| 用户、团队 | §4 用户管理；§5 团队管理 |
| DNS 账号、域名（含分组 / `can_write` / 导出） | §6 DNS 账号；§7 域名管理 |
| 解析记录（批量导入上限、多线路、代理开关） | §8 DNS 记录管理 |
| 邮件模板 | §9 邮件模板 |
| DNS 提供商元数据、图标、可续期域名 | §10 DNS 提供商 |
| RDAP / WHOIS 查询 | §11 RDAP/WHOIS 查询 |
| 系统信息、系统设置、安全设置 | §12 系统信息；§13 系统设置；§14 安全设置 |
| 审计日志与导出 | §15 审计日志 |
| Cloudflare Tunnel | §17 Cloudflare Tunnel |
| API Token（`allowed_services`、`max_role`、有效期） | §18 API Token |
| NS 监测 | §19 NS 监测 |
| 网络工具 | §20 网络设置 |
| 服务监控与故障转移 | §21 服务监控 |
| 资源监控 | §22 资源监控 |
| MCP（Streamable HTTP / SSE / OAuth / API Key） | §23 MCP |
| 自动化工作流（受初始化门禁保护） | §24 自动化工作流 |
| Swagger 地址、工作流出站白名单 | §25；§26 |

## 三处硬约定（对接前必须知道）

1. **统一信封**：`{ code, data, msg }`，`code === 0` 才算成功。只看 HTTP 200 会漏判。
2. **域名列表两套契约**：浏览器会话返回 `{ list, total, page, pageSize, totalPages }` + Unicode 域名 + `can_write`；API Token 或 `format=array` 返回**裸数组** + Punycode + `display_name`。判定集中在 `routes/domains.ts` 的 `resolveDomainListShape()`，详见 [`development/domain-list-api-format.md`](development/domain-list-api-format.md)。
3. **分页安全上限**：全量遍历最多 10 页（1000 条）；写操作先按 `subdomain` + `type` 查重做幂等。

## 文档维护规则

- 新增 / 修改 / 废弃端点：同一提交内更新 `docs/api.md`，否则视为未完成（§外部应用集成 API）。
- 本页只在 `api.md` 章节结构变化时更新映射表；不要在此新增端点细节。
