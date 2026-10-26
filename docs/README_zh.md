# HiDNS 文档中心（中文）

> 单一真源：规范看 [root.ai.md](https://github.com/HiPM-Tech/HiDNS/blob/main/root.ai.md)，API 看 [docs/api.md](api.md)，其余文档都是展开或解释。完整分级与历史归档清单见 [文档中心（English/主版）](README.md)。

## 项目介绍在哪

本站点内的「项目介绍」只保留入口，正文以仓库根的中文 README 为准：

- [README_zh.md（GitHub）](https://github.com/HiPM-Tech/HiDNS/blob/main/README_zh.md) —— 功能、部署、技术栈、协议
- [README.md（English）](https://github.com/HiPM-Tech/HiDNS/blob/main/README.md)

## 快速跳转

| 你要找的 | 去哪 |
|---|---|
| 工程规范（数据库四层、日志、路由、提供商、客户端、门禁、发布、审核） | [root.ai.md](https://github.com/HiPM-Tech/HiDNS/blob/main/root.ai.md) |
| 对外 API（端点、参数、鉴权、令牌权限） | [docs/api.md](api.md) |
| 文档分级与历史归档 | [docs/README.md](README.md) |
| API Token 模型 | [architecture/api-token.md](architecture/api-token.md) |
| API 路由与挂载顺序 | [architecture/api-routes.md](architecture/api-routes.md) |
| 数据库层 | [architecture/database-layer.md](architecture/database-layer.md) |
| 环境搭建 / Docker / 配置 | [development/quick-start.md](development/quick-start.md)、[docker-deploy.md](development/docker-deploy.md)、[configuration.md](development/configuration.md) |
| 更新日志 | [CHANGELOG.md](CHANGELOG.md) |

## 三条硬约定

1. **信封**：`{ code, data, msg }`，`code === 0` 才算成功。
2. **语言**：界面只有简体中文（i18n 框架已于 2026-10 移除，`client/src/i18n/**`、`client/src/pages/**` 不再存在）。
3. **协议**：GPL-3.0，见仓库根 `LICENSE`。

## 旧版说明

本页旧版是一份 320 行的项目介绍副本，与根 README_zh 内容重复且已过期（React 18、`client/src/pages/**`、`DnsHelper.ts` 的 `DNS_PROVIDERS`、多语言章节、MIT 协议等均已失效）。现改为索引，避免第三份介绍继续分叉。
