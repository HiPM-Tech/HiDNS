# HiDNS - DNS 聚合管理平台

> **原名**: DnsMgr (HiPm DnsMgr) | **现名**: HiDNS (HiPm DNS Aggregation Management Platform)
>
> 一个现代化的 DNS 聚合管理平台，前端使用 React + TailwindCSS，后端使用 Node.js + TypeScript。

## Repository
[![License](https://img.shields.io/github/license/HiPM-Tech/HiDNS)](https://github.com/HiPM-Tech/HiDNS/blob/main/LICENSE)
[![Release](https://img.shields.io/github/release/HiPM-Tech/HiDNS)](https://github.com/HiPM-Tech/HiDNS/releases)
![Downloads](https://gh-down-badges.linkof.link/HiPM-Tech/HiDNS)
[![Issues](https://img.shields.io/github/issues/HiPM-Tech/HiDNS)](https://github.com/HiPM-Tech/HiDNS/issues)\
[![Stars](https://img.shields.io/github/stars/HiPM-Tech/HiDNS?style=social)](https://github.com/HiPM-Tech/HiDNS/stargazers)
[![Forks](https://img.shields.io/github/forks/HiPM-Tech/HiDNS?style=social)](https://github.com/HiPM-Tech/HiDNS/forks)\
[![Release Build](https://github.com/HiPM-Tech/HiDNS/actions/workflows/release.yml/badge.svg)](https://github.com/HiPM-Tech/HiDNS/actions/workflows/release.yml)
[![Nightly Docker Build](https://github.com/HiPM-Tech/HiDNS/actions/workflows/nightly-build.yml/badge.svg)](https://github.com/HiPM-Tech/HiDNS/actions/workflows/nightly-build.yml)
[![Test Suite](https://github.com/HiPM-Tech/HiDNS/actions/workflows/test-suite.yml/badge.svg)](https://github.com/HiPM-Tech/HiDNS/actions/workflows/test-suite.yml)\
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/HiPM-Tech/HiDNS)
[![zread](https://img.shields.io/badge/Ask_Zread-_.svg?style=flat-square&color=00b0aa&labelColor=000000&logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB3aWR0aD0iMTYiIGhlaWdodD0iMTYiIHZpZXdCb3g9IjAgMCAxNiAxNiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTQuOTYxNTYgMS42MDAxSDIuMjQxNTZDMS44ODgxIDEuNjAwMSAxLjYwMTU2IDEuODg2NjQgMS42MDE1NiAyLjI0MDFWNC45NjAxQzEuNjAxNTYgNS4zMTM1NiAxLjg4ODEgNS42MDAxIDIuMjQxNTYgNS42MDAxSDQuOTYxNTZDNS4zMTUwMiA1LjYwMDEgNS42MDE1NiA1LjMxMzU2IDUuNjAxNTYgNC45NjAxVjIuMjQwMUM1LjYwMTU2IDEuODg2NjQgNS4zMTUwMiAxLjYwMDEgNC45NjE1NiAxLjYwMDFaIiBmaWxsPSIjZmZmIi8%2BCjxwYXRoIGQ9Ik00Ljk2MTU2IDEwLjM5OTlIMi4yNDE1NkMxLjg4ODEgMTAuMzk5OSAxLjYwMTU2IDEwLjY4NjQgMS42MDE1NiAxMS4wMzk5VjEzLjc1OTlDMS42MDE1NiAxNC4xMTM0IDEuODg4MSAxNC4zOTk5IDIuMjQxNTYgMTQuMzk5OUg0Ljk2MTU2QzUuMzE1MDIgMTQuMzk5OSA1LjYwMTU2IDE0LjExMzQgNS42MDE1NiAxMy43NTk5VjExLjAzOTlDNS42MDE1NiAxMC42ODY0IDUuMzE1MDIgMTAuMzk5OSA0Ljk2MTU2IDEwLjM5OTlaIiBmaWxsPSIjZmZmIi8%2BCjxwYXRoIGQ9Ik0xMy43NTg0IDEuNjAwMUgxMS4wMzg0QzEwLjY4NSAxLjYwMDEgMTAuMzk4NCAxLjg4NjY0IDEwLjM5ODQgMi4yNDAxVjQuOTYwMUMxMC4zOTg0IDUuMzEzNTYgMTAuNjg1IDUuNjAwMSAxMS4wMzg0IDUuNjAwMUgxMy43NTg0QzE0LjExMTkgNS42MDAxIDE0LjM5ODQgNS4zMTM1NiAxNC4zOTg0IDQuOTYwMVYyLjI0MDFDMTQuMzk4NCAxLjg4NjY0IDE0LjExMTkgMS42MDAxIDEzLjc1ODQgMS42MDAxWiIgZmlsbD0iI2ZmZiIvPgo8cGF0aCBkPSJNNCAxMkwxMiA0TDQgMTJaIiBmaWxsPSIjZmZmIi8%2BCjxwYXRoIGQ9Ik00IDEyTDEyIDQiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSIxLjUiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPgo8L3N2Zz4K&logoColor=ffffff)](https://zread.ai/HiPM-Tech/HiDNS)

## 功能特性

- **多服务商支持**: 可管理 22+ DNS 服务商的解析记录：
  - **国内**：阿里云 (Aliyun), DNSPod (腾讯云), 华为云 (Huawei Cloud), 百度云 (Baidu Cloud)
    火山引擎 (Volcengine), 京东云 (JD Cloud), 西部数码 (West Digital), 青云 (Qingcloud)
    宝塔面板 (BT Panel), 阿里云 ESA (Aliyun ESA), 腾讯 EdgeOne (Tencent EdgeOne), 雨云 (Rainyun), VPS8
  - **国际**：Cloudflare, NameSilo, Spaceship, PowerDNS, DNS.LA, DNSHE, HiDNS, 彩虹DNS聚合 (CaihongDNS), Gcore

- **高级功能**:
  - WHOIS 查询与智能缓存（支持注册商模式）
  - 域名续期管理（自动化续期调度）
  - NS 监测与故障转移（高可用保障）
  - API Token 管理（细粒度权限控制）
  - Cloudflare Tunnel 集成
  - 多语言支持（中/英/日/西）
  - OAuth2/OIDC 单点登录
  - WebAuthn/Passkeys 无密码登录
  - TOTP 双因素认证
  - 完整的审计日志系统
  - 安全策略与登录限制
  - 邮件通知与模板管理

- **多用户与团队管理**: 基于角色的访问控制（admin/member），团队共享域名
- **完整的 DNS 记录管理**: 支持所有记录类型的增删改查（A、AAAA、CNAME、MX、TXT、SRV、CAA 等）
- **现代化 UI**: React 18 + TailwindCSS，响应式设计
- **API 文档**: Swagger UI 位于 `/api/docs`
- **可扩展架构**: 抽象 DNS 接口，易于添加新服务商

## 架构

### 架构总览

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/architecture/hidns-architecture-dark.png">
  <img alt="HiDNS 架构总览：运维用户到 React SPA 到 Express API 到统一数据访问层，旁挂 DNS 厂商适配层、后台任务调度、DNS 解析器与 MCP Server" src="docs/architecture/hidns-architecture-light.png">
</picture>

> **交互版** —— 支持缩放、搜索、关系追踪、明暗主题、演示模式以及 PNG/SVG 导出：
> [`docs/architecture/hidns-architecture.html`](docs/architecture/hidns-architecture.html)（下载后用浏览器打开）。

### 系统架构

```
HiDNS/
├── server/          # Node.js + TypeScript 后端
│   ├── src/
│   │   ├── lib/dns/ # DNS 服务商适配器（抽象接口）
│   │   ├── routes/  # REST API 路由
│   │   ├── middleware/ # 认证（JWT）、校验
│   │   ├── service/ # 业务逻辑服务
│   │   │   ├── whoisService.ts      # WHOIS 查询服务
│   │   │   ├── whoisScheduler.ts    # WHOIS 调度器
│   │   │   ├── renewalScheduler.ts  # 域名续期调度器
│   │   │   ├── nsMonitorJob.ts      # NS 监测任务
│   │   │   ├── failover.ts          # 故障转移服务
│   │   │   ├── taskManager.ts       # 任务管理器
│   │   │   ├── notification.ts      # 通知服务
│   │   │   ├── audit.ts             # 审计服务
│   │   │   ├── token.ts             # API Token 服务
│   │   │   └── session.ts           # 会话管理
│   │   └── db/      # 三层数据库架构
│   │       ├── business-adapter.ts  # 业务适配器层（函数式 API）
│   │       ├── core/                # 数据库抽象层
│   │       ├── drivers/             # 数据库驱动（MySQL/PostgreSQL/SQLite）
│   │       └── schemas/             # 数据库 Schema
├── client/          # React + Vite + TailwindCSS 前端
    └── src/
        ├── pages/   # 页面
        │   ├── NSMonitor.tsx        # NS 监测页面
        │   ├── Tokens.tsx           # API Token 管理
        │   ├── Tunnels.tsx          # Tunnel 管理
        │   ├── Security.tsx         # 安全设置
        │   └── OAuthCallback.tsx    # OAuth 回调
        ├── components/ # 复用组件
        └── api/     # API 客户端
```

### 数据库架构（四层设计）

HiDNS 实现了严格的多层数据库架构：

```
路由/服务层 → 业务适配器层(BAL) → 抽象层(DAC) → 驱动层(DL) → 数据库
                            ↕
                   声明式模式管理层(DSM)
```

**第一层：业务适配器层** (`server/src/db/bal/`)
- 函数式 API：`query()`、`get()`、`execute()`、`insert()`、`run()`
- 业务操作模块：`UserOperations`、`DnsAccountOperations` 等 24+ 个模块
- 所有数据库操作必须通过此层
- 自动日志记录和性能监控

**第二层：数据库抽象层** (`server/src/db/core/`)
- 统一类型定义
- 连接管理器（单例模式）
- 数据库配置管理
- 查询构建器与 SQL 编译器

**第三层：驱动层** (`server/src/db/dl/`)
- MySQL 驱动（连接池）
- PostgreSQL 驱动（连接池）
- SQLite 驱动（better-sqlite3）
- 通用 SQL 编译逻辑在基类 `BaseDriver` 中统一实现

**第四层：声明式模式管理层** (`server/src/db/dsm/`)
- 声明式 Schema 定义（`complete-schema.ts`）
- Schema 协调器（自动检测并同步表结构差异）
- 数据迁移运行器（旧系统升级）
- 版本管理

### 数据库 API 使用

```typescript
// ✅ 正确 - 使用业务适配器函数
import { query, get, execute, insert, UserOperations } from '../db';

const user = await get<User>('SELECT * FROM users WHERE id = ?', [userId]);
const users = await query<User>('SELECT * FROM users WHERE status = ?', ['active']);
const id = await insert('INSERT INTO users (name, email) VALUES (?, ?)', [name, email]);

// 使用业务操作模块
const user = await UserOperations.getById(1);
```

详见 [ARCHITECTURE.md](ARCHITECTURE.md) 获取详细架构文档。

## 快速开始

### 环境要求
- Node.js >= 18
- pnpm

### 安装依赖

```bash
pnpm install
```

### 开发模式

#### 方式一：并发启动（推荐大多数用户使用）

使用单个命令同时启动前后端（分别运行在不同端口）：

```bash
# 同时启动后端（端口 3001）与前端（端口 5173）
pnpm dev
```

访问地址：http://localhost:5173

> 首次启动提示：如果系统尚未初始化，请访问初始化向导 `http://localhost:5173/setup`（单端口模式为 `http://localhost:3001/setup`）配置数据库并创建首个管理员。

#### 方式二：独立启动（适合高级用户）

在独立终端中分别启动前后端：

```bash
# 终端 1 - 仅后端（端口 3001）
cd server && pnpm dev

# 终端 2 - 仅前端（端口 5173）
cd client && pnpm dev
```

### 生产构建

```bash
pnpm build
```

### 源码运行 - 聚合模式（单端口）

前后端在同一个端口（3001）运行 - 后端同时提供静态文件服务：

```bash
# 步骤 1：先构建前端
pnpm --filter client build

# 步骤 2：仅启动后端（同时提供 API 和前端页面，端口 3001）
cd server && pnpm dev
```

访问地址：http://localhost:3001

此模式适用于以下场景：
- 只需暴露一个端口
- 与 Docker 部署行为保持一致
- 简化反向代理配置

### Docker 部署

Docker 部署使用一体化模式（前后端合并在一个容器中）。

#### 方式一：使用预构建镜像（推荐）

```bash
# 使用 GitHub Container Registry 的预构建镜像
docker run -d \
  -p 3001:3001 \
  -v $(pwd)/data:/app/data \
  --name hidns \
  ghcr.io/hipm-tech/hidns:latest
```

或使用 Docker Compose：

```bash
# 下载编排文件
curl -O https://raw.githubusercontent.com/HiPM-Tech/HiDNS/main/docker-compose.yml

# 启动服务
docker-compose up -d
```

#### 方式二：从源码构建

```bash
# 构建并运行
docker build -t hidns .
docker run -d \
  -p 3001:3001 \
  -v $(pwd)/data:/app/data \
  --name hidns \
  hidns
```

访问地址：http://localhost:3001

### 环境变量

将 `.env.example` 复制为 `server/.env`：

```bash
cp server/.env.example server/.env
```

| 变量 | 默认值 | 说明 |
|----------|---------|-------------|
| `PORT` | `3001` | 服务端端口 |
| `NODE_ENV` | `development` | 运行环境 |
| `JWT_SECRET` | 未设置 | JWT 基础密钥；若不设置会回退到不安全默认值（生产环境必须设置） |
| `DB_PATH` | `./Hidns.db` | SQLite 数据库路径 |
| `DB_TYPE` | `sqlite` | 数据库类型：`sqlite`、`mysql` 或 `postgresql` |
| `DB_HOST` | - | 数据库主机（MySQL/PostgreSQL 使用） |
| `DB_PORT` | - | 数据库端口（MySQL/PostgreSQL 使用） |
| `DB_NAME` | - | 数据库名称（MySQL/PostgreSQL 使用） |
| `DB_USER` | - | 数据库用户（MySQL/PostgreSQL 使用） |
| `DB_PASSWORD` | - | 数据库密码（MySQL/PostgreSQL 使用） |
| `DB_SSL` | `false` | MySQL/PostgreSQL 是否启用 SSL |

### JWT 运行时密钥轮换（重要）

- JWT 实际签名密钥为：`JWT_SECRET + runtime_secret`（`runtime_secrets` 表）。
- 若运行时密钥不存在，系统会自动生成并落库。
- 初始化流程创建首个管理员后，会主动轮换运行时密钥。
- 运行时密钥变化后，旧 JWT 会失效。

## 初始化与安全说明

- `/api/init/*` 仅用于未初始化阶段。
- 当系统已初始化（数据库结构就绪且存在用户）后，`/api/init/database` 会返回 `403`，拒绝再次初始化。
- 管理员账号通过初始化向导/API（`/api/init/admin`）创建，不存在固定默认账号。

## API 文档

服务启动后访问：`http://localhost:3001/api/docs`

## 记录模型说明

- DNS 记录仍保留通用 `line` 字段以兼容历史逻辑。
- 对于 Cloudflare，请使用请求/响应中的服务商专用字段：
  - `cloudflare.proxied`: 代理开关（`true` = 代理，`false` = 仅 DNS）
  - `cloudflare.proxiable`: 当前记录类型是否支持代理
- Cloudflare 创建/更新的优先级：
  - 如果提供 `cloudflare.proxied`，则优先使用
  - 否则回退到 `line`（`'1'` = 代理，`'0'` = 仅 DNS）

## 添加新的 DNS 服务商

1. 在 `server/src/lib/dns/providers/myprovider.ts` 中创建新的适配器并实现 `DnsAdapter`
2. 在 `server/src/lib/dns/DnsHelper.ts` 中注册（加入 `DNS_PROVIDERS` 映射）
3. 在 `server/src/lib/dns/providers/index.ts` 中导出

适配器需要实现 `DnsAdapter` 接口：

```typescript
interface DnsAdapter {
  check(): Promise<boolean>;
  getDomainList(...): Promise<PageResult<DomainInfo>>;
  getDomainRecords(...): Promise<PageResult<DnsRecord>>;
  addDomainRecord(...): Promise<string | null>;
  updateDomainRecord(...): Promise<boolean>;
  deleteDomainRecord(...): Promise<boolean>;
  setDomainRecordStatus(...): Promise<boolean>;
  // ...
}
```

## Provider 类型与别名映射

创建/更新 DNS 账号时，API 会将 lego 风格 provider 名称归一化为内部 provider 类型。

| 内部类型 | 支持别名 |
|---|---|
| `aliyun` | `aliyun`, `alidns` |
| `aliyunesa` | `aliesa` |
| `baidu` | `baiducloud` |
| `huawei` | `huaweicloud` |
| `huoshan` | `huoshan`, `volcengine` |
| `west` | `westcn` |
| `cloudflare` | `cloudflare` |
| `jdcloud` | `jdcloud` |
| `namesilo` | `namesilo` |
| `rainyun` | `rainyun` |
| `powerdns` | `powerdns`, `pdns` |
| `dnspod` | `dnspod`, `tencentcloud` |
| `tencenteo` | `tencenteo`, `edgeone` |
| `dnsla` | `dnsla` |
| `bt` | `bt` |
| `qingcloud` | `qingcloud` |
| `spaceship` | `spaceship` |
| `dnshe` | `dnshe` |
| `Hidns` | `Hidns` |
| `caihongdns` | `caihongdns` |
| `vps8` | `vps8` |
| `gcore` | `gcore` |

## 技术栈

**后端:**
- Node.js + TypeScript
- Express.js
- SQLite (better-sqlite3)、MySQL (mysql2)、PostgreSQL (pg)
- JWT 认证
- Swagger/OpenAPI 文档
- node-cron / node-schedule: 定时任务调度
- nodemailer: 邮件发送
- @simplewebauthn/server: WebAuthn 支持
- speakeasy: TOTP 生成验证
- axios: HTTP 客户端

**前端:**
- React 18 + TypeScript
- Vite
- TailwindCSS v3
- React Router v6
- @tanstack/react-query
- Axios
- lucide-react
- react-hook-form: 表单管理
- zod: 数据验证
- date-fns: 日期处理
- clsx / tailwind-merge: CSS 类名合并

## License

MIT


## 多语言支持 (i18n) 与贡献指南

HiDNS 使用 `react-i18next` 进行国际化（i18n）支持。目前已支持的语言包括：英文、简体中文、西班牙语和日语。

我们非常欢迎社区参与多语言的共建！如果你想添加新的语言支持，请参考以下步骤：

1. 复制现有的语言文件（例如 `client/src/i18n/locales/zh-CN.ts`）并重命名为新的语言代码，如 `fr.ts`（法语）。
2. 将文件中的对应字符串翻译为目标语言。
3. 在 `client/src/i18n/index.ts` 中引入你的新文件，并添加到 `resources` 对象中。
4. 在 `client/src/pages/Settings.tsx` 中的语言选择器里添加你的新语言选项。

**提示：** 我们强烈推荐使用 VS Code 插件 [i18n-ally](https://marketplace.visualstudio.com/items?itemName=Lokalise.i18n-ally)。本项目已经内置了 `.vscode/settings.json` 配置，你可以利用它直接在编辑器中查看翻译缺失情况并高效管理多语言键值。

## 添加新的 DNS 提供商

我们开箱即支持多个 DNS 提供商（Cloudflare, 阿里云, 腾讯云, 华为云, DNSPod, GoDaddy）。如果你使用的提供商尚未支持，你可以很方便地自行添加：

1. **实现适配器**：在 `server/src/lib/dns/providers/` 下创建一个新文件，实现 `DnsAdapter` 接口。
2. **注册适配器**：在 `server/src/lib/dns/DnsHelper.ts` 的工厂方法中添加你的适配器。
3. **更新前端**：在 `client/src/pages/Accounts.tsx` 的 `PROVIDERS` 列表中添加你的提供商及其所需的配置字段。
4. **提交 PR**：我们非常欢迎 Pull Requests！请确保你的代码符合现有的代码风格并能通过测试。

---

## 🛡️ AI 审核团与代码质量

HiDNS 项目采用严格的 AI 代码审核机制，确保代码质量和项目规范。

### 审核标准

- **P0 级别**（必须修复）：数据库规范、安全漏洞、功能缺陷
- **P1 级别**（建议修复）：代码质量、性能优化、i18n 完整性
- **P2 级别**（可选优化）：代码注释、命名规范、抽象复用

### 核心要求

1. ✅ 所有数据库操作必须通过业务适配器层
2. ✅ JWT 认证使用双层密钥结构
3. ✅ 完整的日志记录（请求、响应、错误、业务操作）
4. ✅ 支持 OAuth2/OIDC 标准
5. ✅ 完整的 i18n 多语言支持

### 文档链接

- [开发规范](docs/DEVELOPMENT.md) - 代码规范、数据库规范、开发流程
- [AI 审核团](ai-censorship/root.md) - 代码审核标准和审查清单
- [架构文档](docs/architecture/overview.md) - 系统架构设计
- [API 文档](docs/api-reference.md) - 完整的 RESTful API 参考

## Star History

<a href="https://www.star-history.com/?repos=HiPM-Tech%2FHiDNS&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=HiPM-Tech/HiDNS&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=HiPM-Tech/HiDNS&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=HiPM-Tech/HiDNS&type=date&legend=top-left" />
 </picture>
</a>

## 社区与支持

- **GitHub 仓库**: https://github.com/HiPM-Tech/DNSMgr
- **Telegram 群组**: https://t.me/HiDNSManager
- **开源协议**: GPL-3.0

## ☕ 赞助支持

如果 HiDNS 对你有帮助，不妨请我喝杯咖啡！你的支持是项目持续维护的动力。

<p align="center">
  <img src="mm_reward_qrcode_1785249713101.png" width="200" alt="赞赏码" />
  <img src="1785249805924.jpg" width="200" alt="收款码" />
</p>

<p align="center">
  <i>赞赏码 &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; 收款码</i>
</p>

---

<p align="center">
  Made with ❤️ by HiPM Tech
</p>
