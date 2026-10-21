# HiDNS API 接口文档

Base URL: `http://<部署地址>:3001/api`

## 鉴权方式

| 方式 | 请求头 | 说明 |
|------|--------|------|
| **JWT** | `Authorization: Bearer <token>` | 用户登录后获取，有效期 7 天 |
| **API Token** | `Authorization: Bearer <token>` | 系统管理页创建，支持域名/服务/时间范围限制 |

- `noTokenAuth()` 标记的路由仅允许 JWT 鉴权，禁止 API Token
- `adminOnly` 标记的路由仅限管理员/超级管理员
- `requireTokenDomainPermission()` 标记的路由要求 Token 具备域名级写权限
- 公共路由（`/api/init/*`、`/api/rdap/*`、`/api/system/*`、`/api/mcp/.well-known/*`）无需鉴权

### 通用响应格式

```json
{
  "code": 0,
  "data": "...",
  "msg": "success"
}
```

- `code === 0`：成功
- `code !== 0`：失败，`msg` 包含错误描述

---

## 1. 系统初始化

### `GET /api/init/status`
鉴权：无（公开）

获取系统初始化状态。

### `GET /api/init/db-config`
鉴权：无（公开），仅在初始化前可访问

获取当前数据库配置。

### `POST /api/init/test-db`
鉴权：无（公开）

测试数据库连接。

请求体：
```json
{
  "type": "sqlite|mysql|postgresql",
  "sqlite": { "path": "./HiDNS.db" },
  "mysql": { "host": "", "port": 3306, "user": "", "password": "", "database": "" },
  "postgresql": { "host": "", "port": 5432, "user": "", "password": "", "database": "" }
}
```

### `POST /api/init/database`
鉴权：无（公开）

初始化/重置数据库。

请求体：同上 + `{ "reset": true }`

### `POST /api/init/admin`
鉴权：无（公开）

创建初始管理员用户。

请求体：
```json
{
  "username": "admin",
  "email": "admin@example.com",
  "password": "********"
}
```

---

## 2. 认证

### `GET /api/auth/public-key`
鉴权：无（公开）

获取 RSA 公钥用于密码加密传输。

### `POST /api/auth/login`
鉴权：`loginLimiter`（限流）

用户登录。

请求体：
```json
{
  "username": "admin",
  "password": "********",
  "totpCode": "123456",
  "backupCode": "xxxxx",
  "webauthnResponse": {},
  "trustDevice": false,
  "encrypted": false
}
```

### `POST /api/auth/logout`
鉴权：`authMiddleware`

退出登录。

### `GET /api/auth/me`
鉴权：`authMiddleware`

获取当前登录用户信息。

### `PUT /api/auth/password`
鉴权：`authMiddleware`

修改当前用户密码。

```json
{ "oldPassword": "***", "newPassword": "***", "encrypted": false }
```

### `PUT /api/auth/profile`
鉴权：`authMiddleware`

更新个人资料（昵称、邮箱）。

```json
{ "nickname": "新昵称", "email": "new@example.com", "emailCode": "123456" }
```

### `POST /api/auth/profile/email-code`
鉴权：`authMiddleware`、`emailLimiter`

发送邮箱验证码。

```json
{ "email": "new@example.com" }
```

### `GET /api/auth/preferences`
鉴权：`authMiddleware`

获取用户偏好设置（主题、语言等）。

### `PUT /api/auth/preferences`
鉴权：`authMiddleware`

更新用户偏好设置。

```json
{
  "theme": "light|dark|auto",
  "language": "zh-CN|en|ja|...",
  "notificationsEnabled": true,
  "emailNotifications": true,
  "backgroundImage": "url",
  "avatarImage": "url"
}
```

### `GET /api/auth/preferences/pinned-domains`
鉴权：`authMiddleware`

获取置顶域名 ID 列表。

### `PUT /api/auth/preferences/pinned-domains`
鉴权：`authMiddleware`

更新置顶域名 ID 列表。

```json
{ "domainIds": [1, 2, 3] }
```

### `POST /api/auth/password-reset/request`
鉴权：无（公开）

请求密码重置验证码。

```json
{ "email": "user@example.com" }
```

### `POST /api/auth/password-reset/confirm`
鉴权：无（公开）

确认密码重置。

```json
{ "email": "user@example.com", "code": "123456", "newPassword": "***", "encrypted": false }
```

### OAuth

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/api/auth/oauth/status` | 无 | 获取已启用的 OAuth 提供商 |
| POST | `/api/auth/oauth/start` | 无 | 开始 OAuth 登录流程 |
| POST | `/api/auth/oauth/start-bind` | `authMiddleware` | 为当前用户绑定 OAuth |
| POST | `/api/auth/oauth/callback` | 无 | OAuth 回调（兑换 code） |
| GET | `/api/auth/oauth/bindings` | `authMiddleware` | 列出用户的 OAuth 绑定 |
| DELETE | `/api/auth/oauth/bindings/:provider` | `authMiddleware` | 解绑 OAuth 提供商 |

---

## 3. WebAuthn

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/api/auth/webauthn/registration-options` | `authMiddleware` | 获取 WebAuthn 注册选项 |
| POST | `/api/auth/webauthn/registration-verify` | `authMiddleware` | 验证 WebAuthn 注册 |
| GET | `/api/auth/webauthn/credentials` | `authMiddleware` | 列出用户的 WebAuthn 凭证 |
| DELETE | `/api/auth/webauthn/credentials/:id` | `authMiddleware` | 删除 WebAuthn 凭证 |
| GET | `/api/auth/webauthn/login-options` | 无 | 获取 WebAuthn 认证选项 |

---

## 4. 用户管理

全部要求 `authMiddleware` + `noTokenAuth('user management')` + `adminOnly`。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/users` | 列出所有用户 |
| POST | `/api/users` | 创建用户 `{ username, nickname?, email?, password, role? }` |
| PUT | `/api/users/:id` | 更新用户 `{ nickname?, email?, role?, status?, password? }` |
| DELETE | `/api/users/:id` | 删除用户 |

---

## 5. 团队管理

全部要求 `authMiddleware`。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/teams` | 列出团队 |
| POST | `/api/teams` | 创建团队 `{ name, description? }` |
| GET | `/api/teams/:id` | 获取团队详情（含成员） |
| PUT | `/api/teams/:id` | 更新团队 `{ name?, description? }` |
| DELETE | `/api/teams/:id` | 删除团队 |
| GET | `/api/teams/:id/members` | 列出团队成员 |
| POST | `/api/teams/:id/members` | 添加成员 `{ user_id, role: 'admin'|'member' }` |
| PUT | `/api/teams/:id/members/:userId` | 更新成员角色 `{ role }` |
| DELETE | `/api/teams/:id/members/:userId` | 移除成员 |
| GET | `/api/teams/:id/domain-permissions` | 列出团队域名权限 |
| POST | `/api/teams/:id/domain-permissions` | 添加域名权限 `{ domain_id, permission, sub? }` |
| PUT | `/api/teams/:id/domain-permissions/:permissionId` | 更新权限 `{ permission }` |
| DELETE | `/api/teams/:id/domain-permissions/:permissionId` | 移除权限 |
| GET | `/api/teams/:id/members/:userId/domain-permissions` | 列出成员域名权限 |
| POST | `/api/teams/:id/members/:userId/domain-permissions` | 添加成员域名权限 `{ domain_id, permission, sub? }` |
| DELETE | `/api/teams/:id/members/:userId/domain-permissions/:permissionId` | 移除成员域名权限 |

---

## 6. DNS 账号

全部要求 `authMiddleware`。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/accounts/providers` | 获取支持的 DNS 提供商列表 |
| GET | `/api/accounts` | 列出 DNS 账号 `?purpose=dns|renewal` |
| POST | `/api/accounts` | 添加 DNS 账号（自动校验）`{ type, name, config, remark?, team_id? }` |
| GET | `/api/accounts/:id` | 获取账号详情 |
| PUT | `/api/accounts/:id` | 更新账号 `{ name?, config?, remark?, team_id?, type? }` |
| DELETE | `/api/accounts/:id` | 删除账号 |
| PATCH | `/api/accounts/:id/toggle-enabled` | 切换账号启用状态 `{ enabled: boolean }` |

---

## 7. 域名管理

全部要求 `authMiddleware`。

### `GET /api/domains`
鉴权：`authMiddleware`

列出域名（分页）。

查询参数：
- `page` - 页码，默认 1
- `pageSize` - 每页数量，默认 50，最大 100
- `account_id` - 按 DNS 账号过滤
- `keyword` - 域名关键词搜索
- `domain_match` - 智能域名匹配（专为 API Token 设计，传入完整 FQDN 自动匹配后缀）
- `domain_type` - 域名类型过滤
- `domain_status` - 域名状态过滤
- `format` - 返回格式
- `pinned_domains` - 是否返回置顶域名
- `include_disabled` - 是否包含已禁用的域名

> Token 认证时，直接返回数组而非 `{ list, total }` 对象。

### `POST /api/domains`
鉴权：`authMiddleware`

添加域名。

```json
{
  "account_id": 1,
  "name": "example.com",
  "third_id": "ns1.dns.com",
  "remark": "",
  "domains": [
    { "name": "example.com", "third_id": "", "record_count": 0, "remark": "" }
  ]
}
```

### `POST /api/domains/sync`
鉴权：`authMiddleware`

从 DNS 提供商同步域名。

```json
{ "account_id": 1 }
```

### `GET /api/domains/provider-list/:accountId`
鉴权：`authMiddleware`

列出提供商上可用但未添加到系统的域名。

### `GET /api/domains/:id`
鉴权：`authMiddleware`

获取域名详情。

### `PUT /api/domains/:id`
鉴权：`authMiddleware` + `requireTokenDomainPermission()`

更新域名。

```json
{ "remark": "", "is_hidden": 0, "enabled": 1 }
```

### `DELETE /api/domains/:id`
鉴权：`authMiddleware` + `requireTokenDomainPermission()`

删除域名。

### `GET /api/domains/:id/lines`
鉴权：`authMiddleware`

获取域名的 DNS 解析线路列表。

### `GET /api/domains/:id/record-types`
鉴权：`authMiddleware`

获取域名支持的记录类型列表（返回 `string[]`）。

### `POST /api/domains/:id/whois`
鉴权：`authMiddleware` + `requireTokenDomainPermission()`

刷新域名 WHOIS 信息。

### `POST /api/domains/:id/renew`
鉴权：`authMiddleware`

发送域名续期请求（通过调度器执行）。

### `GET /api/domains/whois`
鉴权：`authMiddleware`

查询域名 WHOIS 信息。

查询参数：`?domain=example.com&accountId=1`

### 续期域名

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/api/domains/renewable-domains` | `authMiddleware` | 列出续期域名 `?page&pageSize&keyword&account_id&status` |
| POST | `/api/domains/renewable-domains` | `authMiddleware` | 添加续期域名 `{ account_id, provider_type, domain_name, third_id, full_domain, expires_at?, remark? }` |
| DELETE | `/api/domains/renewable-domains/:id` | `authMiddleware` | 从续期列表移除 |
| PATCH | `/api/domains/renewable-domains/:id/toggle-enabled` | `authMiddleware` | 切换续期启用状态 `{ enabled }` |
| POST | `/api/domains/renewable-domains/sync` | `authMiddleware` | 同步到续期列表 `{ account_id, domain_ids: [{ id, full_domain, name?, expires_at? }] }` |

---

## 8. DNS 记录管理

全部要求 `authMiddleware` + `requireTokenDomainPermission('domainId')`（除 GET 列表外）。

路径前缀：`/api/domains/:domainId/records`

### `GET /api/domains/:domainId/records`
鉴权：`authMiddleware`

列出 DNS 记录（分页）。

查询参数：
- `page` - 页码，默认 1
- `pageSize` - 每页数量，默认 20，最大 100
- `keyword` - 关键词搜索
- `subdomain` - 主机记录过滤
- `value` - 记录值过滤
- `type` - 记录类型过滤
- `line` - 线路过滤
- `status` - 状态过滤

### `GET /api/domains/:domainId/records/:recordId`
鉴权：`authMiddleware` + `requireTokenDomainPermission('domainId')`

获取单条 DNS 记录详情。

### `POST /api/domains/:domainId/records`
鉴权：`authMiddleware` + `requireTokenDomainPermission('domainId')`

添加 DNS 记录。

```json
{
  "name": "www",
  "type": "A",
  "value": "1.2.3.4",
  "line": "0",
  "ttl": 600,
  "mx": 0,
  "weight": 0,
  "remark": "",
  "cloudflare": { "proxied": false },
  "aliyunesa": { "proxied": false }
}
```

### `PUT /api/domains/:domainId/records/:recordId`
鉴权：`authMiddleware` + `requireTokenDomainPermission('domainId')`

更新 DNS 记录。

```json
{
  "name": "www",
  "type": "A",
  "value": "1.2.3.5",
  "line": "0",
  "ttl": 600,
  "mx": 0,
  "weight": 0,
  "remark": "",
  "status": 1,
  "cloudflare": { "proxied": true },
  "aliyunesa": { "proxied": false }
}
```

### `DELETE /api/domains/:domainId/records/:recordId`
鉴权：`authMiddleware` + `requireTokenDomainPermission('domainId')`

删除 DNS 记录。

### `PUT /api/domains/:domainId/records/:recordId/status`
鉴权：`authMiddleware` + `requireTokenDomainPermission('domainId')`

启用/禁用 DNS 记录。

```json
{ "status": 0 }
```

### `POST /api/domains/:domainId/records/batch`
鉴权：`authMiddleware` + `requireTokenDomainPermission('domainId')`

批量添加 DNS 记录。

```json
{
  "records": [
    { "name": "www", "type": "A", "value": "1.2.3.4", "line": "0", "ttl": 600 },
    { "name": "mail", "type": "MX", "value": "mail.example.com", "mx": 10 }
  ]
}
```

---

## 9. 邮件模板

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/api/domains/email-templates` | `authMiddleware` | 列出可用邮件模板 |
| GET | `/api/domains/email-templates/:templateId` | `authMiddleware` | 获取模板详情 |
| GET | `/api/domains/email-templates/:templateId/preview` | `authMiddleware` | 预览模板 `?domain=...` |

---

## 10. DNS 提供商

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/api/providers/:type/icon` | 无 | 获取提供商图标（SVG/PNG） |
| GET | `/api/providers/:type/renewable-domains` | `authMiddleware` | 列出提供商上的续期域名（管理员+） |

---

## 11. RDAP/WHOIS 查询

路由来源：`routes/rdap.ts`，挂载于 `app.use('/api/rdap', rdapLimiter, rdapRouter)`。

### 鉴权方式

**可选鉴权**：支持 JWT Token 与 API Token，但**不强制**。

| 状态 | 限流规则 | 实现方式 |
|------|----------|----------|
| **未认证** | 2 请求/秒（按 IP） | 命中 `rdapLimiter`，返回 429 |
| **已认证**（Bearer token 或 session cookie） | 不限速 | `rdapLimiter` 的 `skip` 回调检测到认证信息后跳过 |

限流器配置（`middleware/rateLimit.ts:88-99`）：
```typescript
export const rdapLimiter = rateLimit({
  windowMs: 1000,     // 1 秒窗口
  max: 2,             // 每窗口 2 次请求
  skip: (req) => {
    const hasSessionCookie = !!(req as any).cookies?.token;
    const hasBearerToken = req.headers.authorization?.startsWith('Bearer ');
    return hasSessionCookie || !!hasBearerToken;
  },
});
```

认证请求头示例：
```
Authorization: Bearer <jwt_token_or_api_token>
```

不传认证头仍可正常查询，仅受频率限制。

### 端点

#### `GET /api/rdap/domain/:domain`

实时 RDAP/WHOIS 域名查询，返回符合 RFC 7483 标准的 JSON 格式。

**路径参数：**
- `domain` — 域名（支持 Unicode/IDN 和 Punycode，如 `hins.io.ht`、`例子.测试`）

**查询参数：**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `mode` | string | 否 | 指定上游查询模式，逗号分隔。可选值：`rdap`、`whois`、`http`。默认全部 |

示例：
```
GET /api/rdap/domain/hins.io.ht
GET /api/rdap/domain/example.com?mode=rdap,whois
GET /api/rdap/domain/例子.测试?mode=http
```

**查询策略（分层并行竞速）：**
1. 顶域 RDAP 并行查询（所有匹配 RDAP 提供商竞速）
2. 顶域 WHOIS 并行查询
3. 子域 RDAP 并行查询（如果适用）
4. 子域 WHOIS 并行查询
5. 第三方 RDAP / HTTP-API 并行查询
6. 第三方 WHOIS 并行查询

> 注意：此接口不会查询 DNS 提供商（需要账号鉴权），仅使用公开 WHOIS/RDAP 数据源。

**成功响应（200）：**
```json
{
  "objectClassName": "domain",
  "ldhName": "example.com",
  "unicodeName": "example.com",
  "handle": "EXAMPLE.COM",
  "status": ["ok"],
  "events": [
    { "eventAction": "expiration", "eventDate": "2026-07-15T00:00:00.000Z" },
    { "eventAction": "registration", "eventDate": "2020-07-15T00:00:00.000Z" },
    { "eventAction": "last changed", "eventDate": "2025-07-15T00:00:00.000Z" }
  ],
  "nameservers": [
    { "objectClassName": "nameserver", "ldhName": "ns1.example.com" }
  ],
  "entities": [
    {
      "objectClassName": "entity",
      "roles": ["registrar"],
      "vcardArray": ["vcard", [["version", {}, "text", "4.0"], ["fn", {}, "text", "Example Registrar Inc."]]]
    }
  ],
  "rdapConformance": ["rdap_level_0", "icann_rdap_technical_implementation_guide_0"],
  "notices": [
    {
      "title": "Raw WHOIS Data",
      "description": ["..."],
      "type": "result-set-truncated"
    }
  ]
}
```

Content-Type: `application/rdap+json`

**错误响应：**
| 状态码 | 说明 |
|--------|------|
| 400 | 域名格式无效 |
| 404 | 未找到该域名的 RDAP 信息 |
| 429 | 未认证请求超过限流（2 req/s） |
| 500 | 查询过程内部错误 |

#### `GET /api/rdap/help`

返回 RDAP 帮助信息，无需鉴权。

---

## 12. 系统信息

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/api/system/info` | 无 | 系统信息（版本、数据库、时区） |
| GET | `/api/system/version` | 无 | 版本、部署模式、日志级别 |

---

## 13. 系统设置

全部要求 `authMiddleware` + `noTokenAuth('system settings')` + `adminOnly`。

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/settings/jwt-secret` | 验证密码查看 JWT 密钥 `{ password }` |
| GET | `/api/settings/notifications` | 获取通知渠道 |
| PUT | `/api/settings/notifications` | 保存通知渠道 `{ channels }` |
| GET | `/api/settings/audit-rules` | 获取审计规则 |
| PUT | `/api/settings/audit-rules` | 保存审计规则 |
| GET | `/api/settings/security` | 获取安全配置 |
| PUT | `/api/settings/security` | 更新安全配置 |
| GET | `/api/settings/smtp` | 获取 SMTP 配置 |
| PUT | `/api/settings/smtp` | 更新 SMTP 配置 |
| POST | `/api/settings/smtp/test` | 发送测试邮件 `{ to? }` |
| GET | `/api/settings/oauth` | 获取通用 OAuth 配置 |
| PUT | `/api/settings/oauth` | 更新通用 OAuth 配置 |
| GET | `/api/settings/oauth/logto` | 获取 Logto OAuth 配置 |
| PUT | `/api/settings/oauth/logto` | 更新 Logto OAuth 配置 |
| POST | `/api/settings/oauth/oidc-discover` | 自动发现 OIDC 端点 `{ issuer }` |
| GET | `/api/settings/login-limit` | 获取登录限制配置 |
| PUT | `/api/settings/login-limit` | 更新登录限制配置 |
| GET | `/api/settings/login-attempts/stats` | 获取登录尝试统计 |
| POST | `/api/settings/login-attempts/unlock` | 手动解锁账户 `{ identifier }` |

---

## 14. 安全设置

### TOTP 双因素认证

路由来源：`routes/security.ts`

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/api/security/policy` | `authMiddleware` + `noTokenAuth` + `adminOnly` | 获取安全策略 |
| PUT | `/api/security/policy` | 同上 | 更新安全策略 |
| POST | `/api/security/password-strength` | 无 | 检查密码强度 `{ password }` |
| POST | `/api/security/validate-password` | 无 | 验证密码是否符合策略 `{ password }` |
| GET | `/api/security/requires-2fa` | `authMiddleware` | 检查当前用户是否需要 2FA |
| GET | `/api/security/2fa-status` | `authMiddleware` | 查看当前用户的 2FA 状态 |
| POST | `/api/security/2fa/setup` | `authMiddleware` | 设置 TOTP 2FA（生成密钥） |
| POST | `/api/security/2fa/enable` | `authMiddleware` | 启用 TOTP `{ secret, token, backupCodes }` |
| POST | `/api/security/2fa/disable` | `authMiddleware` | 禁用 TOTP `{ token }` |
| GET | `/api/security/trusted-devices` | `authMiddleware` | 列出信任设备 |
| DELETE | `/api/security/trusted-devices/:deviceId` | `authMiddleware` | 移除信任设备 |
| DELETE | `/api/security/trusted-devices` | `authMiddleware` | 移除所有信任设备 |
| GET | `/api/security/users/:userId/require-2fa` | `authMiddleware` + `noTokenAuth` + `adminOnly` | 获取用户 2FA 要求 |
| PUT | `/api/security/users/:userId/require-2fa` | 同上 | 更新用户 2FA 要求 `{ require2FA }` |
| POST | `/api/security/user-require-2fa` | 同上 | 设置用户 2FA `{ userId, require2FA }` |

### 安全策略（备用路由）

路由来源：`routes/securityPolicy.ts`

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/api/security/policy` | `authMiddleware` + `noTokenAuth` + `adminOnly` | 获取安全策略 |
| PUT | `/api/security/policy` | 同上 | 更新安全策略 |
| POST | `/api/security/password-strength` | 无 | 检查密码强度 |
| GET | `/api/security/2fa/requirement` | `authMiddleware` | 获取当前用户 2FA 要求 |
| GET | `/api/security/trusted-devices` | `authMiddleware` | 列出信任设备 |
| DELETE | `/api/security/trusted-devices/:id` | `authMiddleware` | 移除信任设备 |
| POST | `/api/security/check-device` | `authMiddleware` | 检查设备是否信任 |

---

## 15. 审计日志

全部要求 `authMiddleware` + `noTokenAuth('audit logs')` + `adminOnly`。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/audit/logs` | 列出审计日志 `?page&pageSize&domain&userId&action&startDate&endDate` |
| GET | `/api/audit/export/csv` | 导出 CSV |
| GET | `/api/audit/export/json` | 导出 JSON |
| GET | `/api/audit/anomalies/:userId` | 异常操作检测 `?timeWindow=60` |
| GET | `/api/audit/stats/:userId` | 用户操作统计 `?days=7` |
| GET | `/api/audit/time-distribution/:userId` | 操作时间分布 `?days=7` |

---

## 16. 操作日志（内联路由）

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/api/logs` | `authMiddleware` + `adminOnly` | 同 `/api/audit/logs` |

---

## 17. Cloudflare Tunnel

全部要求 `authMiddleware`。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/tunnels` | 列出所有 Cloudflare Tunnel |
| GET | `/api/tunnels/:accountId/:tunnelId` | 获取 Tunnel 配置 |
| PUT | `/api/tunnels/:accountId/:tunnelId/config` | 更新 Tunnel 配置 |
| DELETE | `/api/tunnels/:accountId/:tunnelId` | 删除 Tunnel |

---

## 18. API Token

全部要求 `authMiddleware` + `noTokenAuth('token management')`。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/tokens` | 列出用户 API Token |
| POST | `/api/tokens` | 创建 Token `{ name, allowed_domains, start_time?, end_time? }` |
| PUT | `/api/tokens/:id` | 更新 Token `{ name?, allowed_domains?, start_time?, end_time? }` |
| DELETE | `/api/tokens/:id` | 删除 Token |
| PATCH | `/api/tokens/:id/status` | 切换 Token 状态 `{ is_active }` |
| GET | `/api/tokens/domains` | 获取用户可访问的域名列表 |

---

## 19. NS 监测

全部要求 `authMiddleware`。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/ns-monitor` | 列出 NS 监测 `?page&pageSize&keyword` |
| GET | `/api/ns-monitor/available-domains` | 列出可监测的域名 |
| GET | `/api/ns-monitor/user/prefs` | 获取用户监测偏好 |
| PUT | `/api/ns-monitor/user/prefs` | 更新监测偏好 `{ notify_email?, notify_channels?, check_interval? }` |
| POST | `/api/ns-monitor` | 创建监测 `{ domain_name, expected_ns?, enabled? }` |
| GET | `/api/ns-monitor/:id` | 获取监测配置 |
| PUT | `/api/ns-monitor/:id` | 更新监测 `{ expected_ns?, enabled? }` |
| DELETE | `/api/ns-monitor/:id` | 删除监测 |
| POST | `/api/ns-monitor/check` | 手动触发 NS 检查 `{ domain_name }` |
| POST | `/api/ns-monitor/resolve-ns` | 解析 NS 记录 `{ domain }` |

---

## 20. 网络设置

全部要求 `authMiddleware`。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/network/proxy` | 获取代理配置 |
| POST | `/api/network/proxy` | 更新代理 `{ enabled, type, host, port, username?, password? }` |
| GET | `/api/network/connectivity` | 测试网络连通性 |

---

## 21. 服务监控

全部要求 `authMiddleware`。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/servicemonitor/stats` | 仪表盘统计 |
| GET | `/api/servicemonitor` | 列出监控 `?page&pageSize&type` |
| GET | `/api/servicemonitor/available-domains` | 列出可用于 DNS 故障转移的域名 |
| GET | `/api/servicemonitor/children/:parentId` | 获取故障转移子监控 |
| POST | `/api/servicemonitor` | 创建监控 `{ name, type, target, domainId?, parentId?, config?, checkInterval?, checkTimeout?, enabled?, notifyOnFailure?, notifyOnRecovery? }` |
| GET | `/api/servicemonitor/:id` | 获取单个监控 |
| PUT | `/api/servicemonitor/:id` | 更新监控 |
| DELETE | `/api/servicemonitor/:id` | 删除监控 |
| POST | `/api/servicemonitor/:id/check` | 手动触发检测 |

类型：`ssl_certificate` | `endpoint` | `dns_failover`

---

## 22. 资源监控

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/api/resource-monitor/current` | `authMiddleware` | 获取最新资源快照 |
| GET | `/api/resource-monitor/history` | `authMiddleware` | 获取历史数据 `?page&pageSize&hours` |
| POST | `/api/resource-monitor/prune` | `authMiddleware` + `adminOnly` | 手动清理 72 小时前的历史数据 |

### 实时推送

WebSocket 事件：`resource:snapshot`，每 10 秒推送一次当前资源快照。

### 快照字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `cpu_percent` | `number \| null` | CPU 使用率（%） |
| `memory_percent` | `number \| null` | 堆内存使用百分比 |
| `memory_mb` | `number \| null` | 堆内存使用（MB） |
| `disk_percent` | `number \| null` | 磁盘使用率（预留） |
| `uptime_hours` | `number \| null` | 运行时长（小时） |
| `task_queue_depth` | `number` | 任务队列深度 |
| `db_queries_total` | `number` | 本周期数据库查询数 |
| `db_errors_total` | `number` | 本周期数据库错误数 |
| `http_probe_count` | `number` | HTTP 探针样本数 |
| `http_avg_ms` | `number \| null` | HTTP 平均延迟 |
| `http_p50_ms` | `number \| null` | HTTP P50 延迟 |
| `http_p95_ms` | `number \| null` | HTTP P95 延迟 |
| `http_p99_ms` | `number \| null` | HTTP P99 延迟 |
| `dns_probe_count` | `number` | DNS 探针样本数 |
| `dns_avg_ms` | `number \| null` | DNS 平均延迟 |
| `dns_p50_ms` | `number \| null` | DNS P50 延迟 |
| `dns_p95_ms` | `number \| null` | DNS P95 延迟 |
| `dns_p99_ms` | `number \| null` | DNS P99 延迟 |
| `sqlite_io_reads` | `number` | SQLite IO 读次数（其他数据库为 0） |
| `sqlite_io_writes` | `number` | SQLite IO 写次数（其他数据库为 0） |
| `recorded_at` | `string` | ISO 8601 记录时间 |

---

## 23. MCP（Model Context Protocol）

### 23a. 配置与发现

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/api/mcp/.well-known/jwks.json` | 无 | JWKS 公钥集 |
| GET | `/api/mcp/.well-known/oauth-protected-resource` | 无 | OAuth 保护资源元数据 |
| GET | `/api/mcp/.well-known/oauth-authorization-server` | 无 | OAuth 授权服务器元数据 |
| GET | `/api/mcp/.well-known/mcp.json` | 无 | MCP 能力发现 |
| GET | `/api/mcp/status` | 无 | MCP 启用状态 |
| GET | `/api/mcp/config` | `authMiddleware` + `adminOnly` | 获取 MCP 配置 |
| POST | `/api/mcp/config` | `authMiddleware` + `adminOnly` | 更新 MCP 配置 `{ enabled }` |
| PUT | `/api/mcp/config` | `authMiddleware` + `adminOnly` | 同上 |

### 23b. API Key

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/api/mcp/api-keys` | `authMiddleware` | 列出 MCP API Key（脱敏） |
| POST | `/api/mcp/api-keys` | `authMiddleware` | 创建 Key `{ description, expires_in_days?, expiresAt? }` |
| POST | `/api/mcp/api-keys/:id/revoke` | `authMiddleware` | 吊销 Key |
| POST | `/api/mcp/api-keys/:id/restore` | `authMiddleware` | 恢复 Key |
| PUT | `/api/mcp/api-keys/:id/expiry` | `authMiddleware` | 更新过期时间 `{ expires_at? }` |
| DELETE | `/api/mcp/api-keys/:id` | `authMiddleware` | 删除 Key |

### 22c. OAuth

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/api/mcp/oauth/clients` | `authMiddleware` | 列出 OAuth 客户端 |
| POST | `/api/mcp/oauth/clients` | `authMiddleware` | 创建客户端 `{ app_name, redirect_uris, scope? }` |
| PUT | `/api/mcp/oauth/clients/:id/scope` | `authMiddleware` | 更新权限范围 |
| PUT | `/api/mcp/oauth/clients/:id/expiry` | `authMiddleware` | 更新过期时间 |
| DELETE | `/api/mcp/oauth/clients/:id` | `authMiddleware` | 删除客户端 |
| GET | `/api/mcp/oauth/authorize` | `authMiddleware` | OAuth 授权（跳转授权页） |
| POST | `/api/mcp/oauth/authorize` | `authMiddleware` | OAuth 授权确认 `{ client_id, redirect_uri, scope?, state?, decision }` |
| POST | `/api/mcp/oauth/register` | 无 | 动态客户端注册 |
| POST | `/api/mcp/oauth/token` | 无 | 令牌端点（签发/刷新） |
| GET | `/api/mcp/oauth/tokens` | `authMiddleware` | 列出已签发的令牌 |
| POST | `/api/mcp/oauth/tokens/:id/revoke` | `authMiddleware` | 吊销令牌 |
| POST | `/api/mcp/oauth/introspect` | 无 | 令牌内省 |
| POST | `/api/mcp/oauth/revoke` | 无 | 令牌撤销 |

### 22d. 审计日志

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/api/mcp/audit-logs` | `authMiddleware` | 列出 MCP 审计日志 |
| GET | `/api/mcp/audit-logs/export` | `authMiddleware` | 导出审计日志 |
| GET | `/api/mcp/audit-stats` | `authMiddleware` | 审计统计 |

### 23e. 协议端点

全部使用 `mcpEnabledCheck` 中间件。

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/mcp` | Streamable HTTP JSON-RPC |
| GET | `/api/mcp/sse` | SSE 传输（建立连接） |
| POST | `/api/mcp/sse` | SSE 传输（发送 JSON-RPC） |

---

## 24. 自动化工作流

> 全部端点要求 **JWT 登录** + **管理员（role ≥ 2）**；创建工作流、修改定义、删除、手动运行、测试额外要求 `requireJwtAuth`（禁止 API Token 调用）。
> `/api/workflows` **不在** `initCheckMiddleware` 豁免清单内：系统未初始化时一律 503。

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/api/workflows` | JWT + admin | 列出**自己**的工作流（按 `owner_id` 过滤；超管跨 owner 的详情/修改走 `/:id` 的豁免分支） |
| POST | `/api/workflows` | JWT + admin + noToken | 创建工作流 |
| GET | `/api/workflows/:id` | JWT + admin | 详情；非本人且非超管 → 403 |
| PUT | `/api/workflows/:id` | JWT + admin + noToken | 更新（部分字段可省略，省略即保留旧值） |
| DELETE | `/api/workflows/:id` | JWT + admin + noToken | 删除（同事务清理运行记录） |
| GET | `/api/workflows/:id/runs` | JWT + admin | 运行记录，支持 `?limit`（默认 50，上限 200）；每条含 `steps`（逐步执行记录的 JSON，字段见下） |
| GET | `/api/workflows/:id/sample-event` | JWT + admin | 最近一次运行的事件快照，供 `(...)` 预览；无记录返回 `null` |
| POST | `/api/workflows/:id/run` | JWT + admin + noToken | 手动运行（限流 10 次/分钟） |
| POST | `/api/workflows/:id/test` | JWT + admin + noToken | 保存期校验（不执行，限流 30 次/分钟） |
| GET | `/api/workflows/meta/:source` | JWT + admin | 候选值 |

### 24a. 候选值 `meta/:source`

| source | 返回 |
|--------|------|
| `actions` | 全部已注册动作（含 `actionClass` / `risk` / `dslVisible` / `params`） |
| `triggerTypes` | `record.changed` / `domain.changed` / `ns.changed` / `whois.expiring` |
| `recordTypes` | 仅 `A` / `AAAA`（§4.0.5） |
| `domainFields` | `remark` / `is_hidden` / `enabled` |
| `nsStatuses` | `ok` / `mismatch` / `missing` / `poisoned` |
| `domains` | 当前用户可访问域名（`value` 为域名 ID，带 `id` / `group`（账号名）字段） |
| `domainNames` | 同上但 `value` 为**域名名称**——`dns.record.*` 的 `domain` 参数接受名称而非 ID |
| `accounts` | 当前用户可见且启用的 DNS 账号（超管看全部，其他人按自己创建 + 所属团队） |
| `records` | 需 `?domain=`（域名名称）；返回该域名下的解析记录，标签为「主机名 类型 → 值」；域名不属于调用方 → 404，上游失败 → 502 并带原因 |
| `originGroups` | 需 `?domainId=`；由域名反查账号与站点，返回源站组及其记录数/引用数；域名不属于调用方 → 404 |
| `edgeoneZones` | 需 `?domainId=`；EdgeOne 站点候选（DNSPod 凭据复用时用于显式指定站点） |
| `outboundAllowlist` | 当前**生效**的出站白名单（读自内存策略，与执行一致） |

`records` 的返回项形如 `{ value: '<记录ID>', label: 'www A → 1.2.3.4' }`——只给 ID 无法判断选的是哪一条。

### 24a-1. 运行记录里的 `steps`

`GET /api/workflows/:id/runs` 的每条记录带 `steps`（JSON 字符串，可能为 `null`）：

```json
[{ "action": "dns.domain.list", "status": "success", "durationMs": 6, "input": {}, "inputDigest": "a1b2c3d4e5f60718" }]
```

| 字段 | 说明 |
|------|------|
| `action` | 动作全名 |
| `status` | `success` / `failed` |
| `durationMs` | 该步耗时 |
| `input` | **脱敏后**的实参（凭据类键名遮成 `***`，超长值截断，对象折叠） |
| `inputDigest` | 原始实参的 sha256 前 16 位，用于在不存明文的前提下比对参数是否相同 |
| `error` | 失败原因（仅失败步骤） |

### 24b. 错误码

| 状态码 | 来源 |
|--------|------|
| 401 | 未登录 / JWT 失效 |
| 403 | 非管理员；或非本人工作流 |
| 404 | 工作流不存在；候选值来源未知；源站组域名无权限 |
| 422 | 保存期校验失败（DSL 结构、必填参数、`dslVisible`、域名变动触发写动作、触发配置取值） |
| 429 | 手动运行超限 |
| 503 | 系统未初始化，或工作流模块未启动（数据库不可达降级模式） |

### 24c. 创建/更新请求体

```json
{
  "name": "同步回源",
  "enabled": true,
  "triggerType": "record.changed",
  "triggerConfig": { "recordTypes": ["A"] },
  "condition": {
    "kind": "compare", "op": "==",
    "left": { "kind": "ref", "path": "event.record.type" },
    "right": { "kind": "literal", "value": "A" }
  },
  "actions": [
    {
      "kind": "call",
      "action": "dns.record.update",
      "args": {
        "domain": { "kind": "literal", "value": "example.com" },
        "recordId": { "kind": "literal", "value": "r-123" },
        "value": { "kind": "ref", "path": "event.record.value" }
      }
    }
  ]
}
```

- `triggerConfig`：`record.changed` → `recordTypes`；`domain.changed` → `fields`；`ns.changed` → `statuses`；`whois.expiring` → `withinDays`。
- **`condition` 语义（重要）**：
  - **省略该键** → 保留原条件（PUT）；创建时等价于「无条件」。
  - **显式 `null`** → **清空条件**（PUT 生效；创建时同样视为无条件）。
  - 传入非 `null` 的节点 → 作为新条件；`null` 不会被当作节点校验。
  - 前端关闭条件开关时会显式发送 `null`（因为 `undefined` 会被 JSON 序列化丢弃）。
- **损坏数据占位项**：`GET /api/workflows` 对无法解析的行返回 `corrupted: true` 的占位项（`name` 为原值、`actions` 为空），使该行**可见且可删除**；`GET /api/workflows/:id` 对同类行返回 **422**（不是 500）；`DELETE` 不解析定义，因此损坏行可正常删除。
- `actions` 中的 `call.action` **必须是字面量**且已注册；引用 `dslVisible:false` 的动作会被 422 拒绝。
- 必填参数缺失、`select` 取值越界同样在保存期 422。

---

## 25. Swagger 文档

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/api/docs` | 无 | Swagger UI 交互式文档 |

---

## 26. 工作流出站白名单

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/api/settings/workflow-http-allowlist` | JWT + admin + noToken | 读取当前白名单 |
| PUT | `/api/settings/workflow-http-allowlist` | JWT + admin + noToken | 覆盖白名单（写审计，立即热重载） |

请求体：`{ "allowlist": ["api.ipify.org", "*.cloudflare.com"] }`（字符串数组；空数组合法，表示全部拒绝）。

响应体：`{ "code": 0, "data": { "allowlist": [...] }, "msg": "success" }`（返回**写入后立即生效**的列表）。

条目约束：必须是**纯主机名**——含 scheme、端口、路径、查询串、凭据或空白的条目会被 **422** 拒绝（IPv6 字面量除外，如 `2606:4700::1111`）。
匹配语义：大小写与尾点归一化；`*.example.com` 同时命中裸 `example.com` 与其子域；私网/本地地址即使命中白名单仍被拒绝。

语义：`http.outbound.fetch` 仅允许命中该白名单的主机；白名单为空时**所有出站请求都会被拒绝**（fail-closed）。
存储键：`system_settings.workflow_http_allowlist`，值为 JSON 数组字符串；也兼容逗号分隔的旧格式。

---

## 附录：鉴权中间件速查

| 中间件 | 作用 |
|--------|------|
| `authMiddleware` | 验证 JWT Token 或 API Token |
| `adminOnly` | 限制 role_level >= 2（管理员/超级管理员） |
| `noTokenAuth('feature')` | 禁止 API Token 访问（仅 JWT 会话） |
| `requireTokenDomainPermission()` | Token 认证时校验域名级写权限 |
| `loginLimiter` | 登录接口限流 |
| `emailLimiter` | 邮箱验证码限流 |
| `rdapLimiter` | RDAP 查询限流 |
| `initCheckMiddleware` | 系统初始化检查（未初始化返回 503） |
| `mcpEnabledCheck` | MCP 启用检查（未启用返回 503） |
---
