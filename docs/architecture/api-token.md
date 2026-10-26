# API Token 架构

## 概述

HiDNS 的 API 访问令牌系统，允许用户创建和管理用于程序化访问的令牌（前缀 `hidns_`，兼容旧的 `dnsmgr_`）。令牌权限继承创建者角色，可限制到特定域名，并受服务级门禁约束。

> 代码里**没有** SOK 这个概念，旧文档里的「SOK (Secure API Key)」「DNSMgr」都是历史命名，不要按它检索代码。

## 设计理念

1. **权限继承**: 令牌继承创建者的用户权限，无需单独配置
2. **域名隔离**: 可限制令牌只能访问特定域名
3. **时间控制**: 支持设置生效时间和过期时间
4. **安全存储**: 令牌哈希存储，数据库中不保存明文
5. **审计追踪**: 记录令牌使用时间和来源

## 令牌格式

```
dnsmgr_<64位十六进制字符串>
```

**示例**: `dnsmgr_a1b2c3d4e5f6...`

- **前缀**: `dnsmgr_` - 用于快速识别令牌类型
- **随机部分**: 32字节 (256位) 随机数，十六进制编码为64字符
- **总长度**: 72字符

## 核心组件

### 1. 令牌服务 (service/token.ts)

```typescript
// 生成新令牌
export function generateToken(): string

// 哈希令牌用于存储
export function hashToken(token: string): string

// 创建用户令牌
export async function createUserToken(userId: number, data: UserTokenCreate): Promise<{ token: string; tokenData: UserTokenResponse }>

// 验证令牌
export async function verifyToken(plainToken: string): Promise<TokenPayload | null>

// 获取用户令牌列表
export async function getUserTokens(userId: number): Promise<UserTokenResponse[]>

// 删除令牌
export async function deleteUserToken(tokenId: number, userId: number): Promise<void>

// 切换令牌状态
export async function toggleTokenStatus(tokenId: number, userId: number, isActive: boolean): Promise<void>
```

### 2. 令牌数据结构

```typescript
interface UserToken {
  id: number;
  user_id: number;           // 创建者用户ID
  name: string;              // 令牌名称（便于识别）
  token_hash: string;        // SHA-256 哈希值
  allowed_domains: string;   // JSON 数组，允许的域名ID列表
  allowed_services: string;  // JSON 数组，允许的服务（["*"] 表示全部）
  start_time: string | null; // 生效时间
  end_time: string | null;   // 过期时间
  max_role: number;          // 最大角色级别（继承用户）
  is_active: boolean;        // 是否启用
  created_at: string;
  last_used_at: string | null;
}

interface TokenPayload {
  type: 'token';             // 标识这是 API Token
  tokenId: number;
  userId: number;            // 关联用户ID
  maxRole: number;           // 角色级别
  allowedDomains: number[];  // 允许的域名
  allowedServices: string[]; // 允许的服务
}
```

### 3. 权限检查

```typescript
// 服务级：allowed_services 数组包含该服务，或包含 '*'
export function hasServicePermission(tokenPayload: TokenPayload, service: string): boolean

// 域名级：令牌白名单 ∩ 创建者对域名的实际权限
export async function hasDomainPermission(tokenPayload: TokenPayload, domainId: number): Promise<boolean>
```

**当前只有服务级 + 域名级两层粒度**，没有「读记录 / 写记录」这种操作级权限；`AVAILABLE_SERVICES` 是工作流动作的命名空间，与令牌无关。

门禁落点只有一个：`api/mount.ts` 的 `buildServiceGate()`，在模块声明了 `service` 时插入。`middleware/auth.ts` 里的 `requireServicePermission()` 目前**没有任何路由调用**——不要以为它生效。

已知边界（当前实现的真实行为，不是遗漏）：

1. 门禁只读 `Authorization: Bearer`。携带 UserToken 的 **cookie** 请求绕过服务级门禁，只经过路由的 `authMiddleware`。
2. 服务级门禁在前，路由级 `authMiddleware` 在后，两者都对同一个令牌做一次 `verifyToken`（每请求两次查库，属已知开销）。

## API 端点

### 令牌管理

| 方法 | 路径 | 功能 | 权限 |
|------|------|------|------|
| GET | `/api/tokens` | 获取令牌列表 | 已认证 |
| POST | `/api/tokens` | 创建新令牌 | 已认证 |
| DELETE | `/api/tokens/:id` | 删除令牌 | 已认证 |
| PATCH | `/api/tokens/:id/status` | 启用/禁用令牌 | 已认证 |
| GET | `/api/tokens/domains` | 获取可授权域名 | 已认证 |

### 创建令牌

**请求**:
```http
POST /api/tokens
Authorization: Bearer <user-jwt-token>
Content-Type: application/json

{
  "name": "CI/CD 部署令牌",
  "allowed_domains": [1, 2, 3],  // 空数组表示所有域名
  "start_time": "2025-01-01T00:00:00Z",  // 可选
  "end_time": "2025-12-31T23:59:59Z"     // 可选，null表示永不过期
}
```

**响应**:
```json
{
  "code": 0,
  "data": {
    "token": "dnsmgr_abc123...",  // 明文令牌，只显示一次
    "tokenData": {
      "id": 1,
      "name": "CI/CD 部署令牌",
      "allowed_domains": [1, 2, 3],
      "allowed_services": ["*"],
      "start_time": "2025-01-01T00:00:00Z",
      "end_time": "2025-12-31T23:59:59Z",
      "max_role": 2,
      "is_active": true,
      "created_at": "2025-01-15T10:30:00Z",
      "last_used_at": null
    }
  },
  "msg": "Token created successfully"
}
```

**重要**: `token` 字段只会在创建时返回一次，请妥善保存。如果丢失，只能删除重新创建。

### 使用令牌

在 API 请求中使用令牌代替用户 JWT：

```http
GET /api/domains
Authorization: Bearer dnsmgr_abc123...
```

## 安全机制

### 1. 存储安全

- 数据库只存储令牌的 SHA-256 哈希值
- 明文令牌只在创建时返回一次
- 即使数据库泄露，也无法还原原始令牌

### 2. 权限控制

```
用户权限 → 令牌权限 → 实际访问权限
```

- 令牌权限 **不超过** 创建者用户权限
- 管理员创建的令牌具有管理员权限
- 普通用户创建的令牌只有普通权限

### 3. 时间限制

- **生效时间**: 令牌在指定时间前不可用
- **过期时间**: 令牌在指定时间后自动失效
- **使用记录**: 每次使用更新 `last_used_at`

### 4. 域名隔离

```typescript
// 令牌允许访问域名 [1, 2]
const tokenDomains = [1, 2];

// 用户有权限访问域名 [1, 2, 3, 4]
const userDomains = [1, 2, 3, 4];

// 令牌实际可访问：交集 [1, 2]
const effectiveDomains = intersection(tokenDomains, userDomains);
```

## 使用场景

### 1. CI/CD 自动化

```bash
# 在 GitHub Actions 中使用
- name: Update DNS Record
  run: |
    curl -X POST https://hidns.example.com/api/domains/1/records \
      -H "Authorization: Bearer ${{ secrets.HIDNS_TOKEN }}" \
      -H "Content-Type: application/json" \
      -d '{"name": "deploy", "type": "A", "content": "1.2.3.4"}'
```

### 2. 第三方集成

```python
import requests

headers = {
    'Authorization': 'Bearer dnsmgr_xxx...',
    'Content-Type': 'application/json'
}

# 获取域名列表
response = requests.get('https://dnsmgr.example.com/api/domains', headers=headers)
domains = response.json()['data']

# 添加解析记录
record = {
    'name': 'api',
    'type': 'A',
    'content': '192.168.1.1',
    'ttl': 300
}
requests.post(f'https://dnsmgr.example.com/api/domains/{domain_id}/records', 
              headers=headers, json=record)
```

### 3. 监控脚本

```bash
#!/bin/bash
# 检查域名解析并自动切换

TOKEN="dnsmgr_xxx..."
DOMAIN_ID=1

# 检查当前解析
CURRENT_IP=$(dig +short example.com)

if [ "$CURRENT_IP" != "$EXPECTED_IP" ]; then
  # 更新解析记录
  curl -X PUT "https://dnsmgr.example.com/api/domains/$DOMAIN_ID/records/1" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"content\": \"$EXPECTED_IP\"}"
fi
```

## 最佳实践

### 1. 令牌命名规范

```
[环境]-[用途]-[创建者]-[日期]

prod-deploy-alice-20250115
dev-testing-bob-20250110
ci-cd-github-20250101
```

### 2. 定期轮换

- 生产环境令牌建议 90 天轮换一次
- 设置合理的过期时间
- 删除不再使用的令牌

### 3. 最小权限原则

- 只授予必要的域名访问权限
- 避免使用 `allowed_domains: []`（所有域名）
- 为不同用途创建独立的令牌

### 4. 安全存储

```bash
# ✅ 正确：使用环境变量或密钥管理系统
export HIDNS_TOKEN=hidns_xxx...

# ❌ 错误：硬编码在代码中
const token = "dnsmgr_xxx...";

# ❌ 错误：提交到版本控制
echo "dnsmgr_xxx..." >> config.txt && git add config.txt
```

## 故障排查

### 令牌验证失败

```
401 Unauthorized
{
  "code": 401,
  "msg": "Invalid or expired token"
}
```

**可能原因**:
- 令牌格式错误（必须以 `dnsmgr_` 开头）
- 令牌已删除或禁用
- 令牌已过期
- 令牌尚未生效

### 权限不足

```
403 Forbidden
{
  "code": 403,
  "msg": "Token does not have permission for this domain"
}
```

**可能原因**:
- 令牌未授权访问该域名
- 创建者用户失去了该域名的权限

### 使用统计

```http
GET /api/tokens
```

响应中的 `last_used_at` 字段显示最后使用时间，可用于识别未使用的令牌。

## 与 JWT 认证的区别

| 特性 | JWT (用户登录) | API Token |
|------|---------------|-----------|
| 用途 | 用户会话 | 程序化访问 |
| 有效期 | 短期（通常几小时） | 长期（可配置） |
| 权限 | 完整用户权限 | 可限制域名 |
| 撤销 | 等待过期或全局登出 | 随时可禁用/删除 |
| 使用场景 | 浏览器/Web UI | 脚本/自动化/第三方 |

## 实现细节

### 认证中间件流程

实际顺序（`server/src/middleware/auth.ts`）：

1. **先看 cookie** `req.cookies.token`，没有再取 `Authorization: Bearer`。
2. 先按 JWT 验签（会话）；失败才走 `verifyToken()`（API Token）。
3. `verifyToken()` 依次校验：前缀（`hidns_` / 旧 `dnsmgr_`）→ 哈希查库 → `is_active` → `start_time` / `end_time` 时间窗 → 更新 `last_used_at`。
4. 通过后把 `{ userId, username: 'token:<id>', role: maxRole }` 写进 `req.user`，并把完整 payload 放到 `(req as any).tokenPayload`，供 `requireDomainPermission` / `requireTokenDomainPermission` 使用。
5. 失败统一 `sendError(res, 'Unauthorized', 401)` / `'Invalid or expired token', 401`，信封为 `{ code, data, msg }`。

注意：`req.tokenPayload` 是挂在请求对象上的自定义字段（TS 里用 `as any` / 断言访问），不是 Express 官方属性。

### 数据库表结构

**表结构的唯一真源是 `server/src/db/dsm/schemas/complete-schema.ts` 里的 `user_tokens` 声明**（DSM 声明式管理，禁止手写 DDL）。字段要点：

| 列 | DSM 类型 | 说明 |
|---|---|---|
| `id` | `id` / 自增主键 | |
| `user_id` | `integer` NOT NULL | 外键 → `users.id`，`ON DELETE CASCADE` |
| `name` | `string(500)` | |
| `token_hash` | `string(500)` UNIQUE | SHA-256 十六进制（64 字符，字段留了余量） |
| `allowed_domains` | `json` NOT NULL | JSON 数组；**空数组 = 不限制域名**（兼容 ddns-go） |
| `allowed_services` | `json` NOT NULL | JSON 数组，如 `["dns"]` / `["*"]` |
| `start_time` / `end_time` | `datetime` NULL | 有效窗口 |
| `max_role` | `integer` 默认 1 | 令牌角色上限 |
| `is_active` | `integer` 默认 1 | |

`json` 列在各驱动下的实际形态不同：SQLite 为 TEXT，MySQL / PostgreSQL 可能直接返回对象。读写两端都要兼容（`typeof value === 'string' ? JSON.parse(value) : value`）。索引为 `idx_user_tokens_user_id`、`idx_user_tokens_token_hash`。
