# 系统初始化流程

## 首次启动检测流程

```mermaid
graph TB
    A[应用启动 app.ts] --> B[加载环境变量]
    B --> C[创建数据库连接]
    C --> D{连接成功?}
    D -->|否| E[记录错误并退出]
    D -->|是| F[初始化 Schema]
    F --> G[initSchemaAsync]
    G --> H{检测数据库类型}
    H -->|SQLite| I[执行 SQLite Schema]
    H -->|MySQL| J[执行 MySQL Schema]
    H -->|PostgreSQL| K[执行 PostgreSQL Schema]
    I --> L[创建表结构]
    J --> L
    K --> L
    L --> M[检查是否有用户]
    M --> N{用户数 > 0?}
    N -->|是| O[系统已初始化]
    N -->|否| P[系统未初始化]
    O --> Q[启动 HTTP 服务器]
    P --> R[等待初始化向导]
```

## 数据库初始化流程

### SQLite 初始化

```mermaid
sequenceDiagram
    participant App as app.ts
    participant Schema as schema.ts
    participant SQLite as sqlite.ts
    participant DB as SQLite Database
    
    App->>Schema: initSchemaAsync(conn, reset)
    Schema->>SQLite: initSQLiteSchema(conn, reset)
    
    alt reset = true
        SQLite->>DB: DROP TABLE IF EXISTS ...
        DB-->>SQLite: 删除完成
    end
    
    SQLite->>DB: CREATE TABLE users (...)
    SQLite->>DB: CREATE TABLE teams (...)
    SQLite->>DB: CREATE TABLE dns_accounts (...)
    SQLite->>DB: CREATE TABLE domains (...)
    SQLite->>DB: CREATE TABLE domain_records (...)
    SQLite->>DB: CREATE TABLE audit_logs (...)
    SQLite->>DB: CREATE TABLE runtime_secrets (...)
    SQLite->>DB: CREATE TABLE whois_cache (...)
    SQLite->>DB: CREATE TABLE renewable_domains (...)
    SQLite->>DB: CREATE TABLE user_preferences (...)
    SQLite->>DB: CREATE TABLE ns_monitor_configs (...)
    SQLite->>DB: CREATE TABLE failover_configs (...)
    SQLite->>DB: CREATE TABLE api_tokens (...)
    SQLite->>DB: CREATE TABLE tunnels (...)
    
    DB-->>SQLite: 表创建完成
    SQLite-->>Schema: 初始化完成
    Schema-->>App: Schema 就绪
```

### MySQL/PostgreSQL 初始化

```mermaid
sequenceDiagram
    participant App as app.ts
    participant Schema as schema.ts
    participant Driver as mysql.ts / postgresql.ts
    participant DB as MySQL/PG Database
    
    App->>Schema: initSchemaAsync(conn, reset)
    
    alt MySQL
        Schema->>Driver: initMySQLSchema(conn, reset)
        Driver->>DB: CREATE TABLE IF NOT EXISTS ...
    else PostgreSQL
        Schema->>Driver: initPostgreSQLSchema(conn, reset)
        Driver->>DB: CREATE TABLE IF NOT EXISTS ...
    end
    
    DB-->>Driver: 表创建完成
    Driver-->>Schema: 初始化完成
    Schema-->>App: Schema 就绪
```

## 管理员创建流程

```mermaid
sequenceDiagram
    participant User as 用户
    participant Frontend as Setup.tsx
    participant API as init.ts Route
    participant Service as Init Service
    participant Adapter as Business Adapter
    participant DB as Database
    participant Audit as Audit Service
    
    User->>Frontend: 1. 访问 /setup
    Frontend->>API: 2. GET /api/init/status
    API->>Adapter: 3. query() 查询用户数
    Adapter->>DB: 4. SELECT COUNT(*) FROM users
    DB-->>Adapter: 返回用户数
    Adapter-->>API: 返回结果
    API-->>Frontend: 5. 返回 {initialized: false}
    
    Frontend->>User: 6. 显示初始化表单
    User->>Frontend: 7. 填写管理员信息
    Frontend->>API: 8. POST /api/init/database
    API->>Service: 9. 初始化数据库
    Service->>Adapter: 10. execute() 创建初始数据
    Adapter->>DB: 11. INSERT INTO system_settings
    DB-->>Adapter: 插入完成
    Adapter-->>Service: 完成
    Service-->>API: 数据库初始化完成
    API-->>Frontend: 12. 返回成功
    
    Frontend->>API: 13. POST /api/init/admin
    API->>Service: 14. 创建管理员
    Service->>Service: 15. bcrypt.hash 密码
    Service->>Adapter: 16. insert() 插入用户
    Adapter->>DB: 17. INSERT INTO users
    DB-->>Adapter: 返回用户 ID
    Adapter-->>Service: 返回 ID
    
    Service->>DB: 18. 生成 runtime_secret
    DB-->>Service: 返回 secret
    
    Service->>Audit: 19. logAuditOperation()
    Audit->>Adapter: 20. execute() 记录日志
    Adapter->>DB: 21. INSERT INTO audit_logs
    DB-->>Adapter: 记录完成
    Adapter-->>Audit: 完成
    Audit-->>Service: 完成
    
    Service-->>API: 22. 返回管理员信息
    API-->>Frontend: 23. 返回 {user, token}
    Frontend->>Frontend: 24. 存储 token
    Frontend-->>User: 25. 跳转到 Dashboard
```

## 运行时密钥生成流程

```mermaid
graph TB
    A[创建管理员] --> B[生成随机密钥]
    B --> C[randomHex 32 bytes]
    C --> D[存储到 runtime_secrets 表]
    D --> E{JWT_SECRET 存在?}
    E -->|是| F[组合密钥 = JWT_SECRET + runtime_secret]
    E -->|否| G[警告: 使用不安全默认值]
    G --> F
    F --> H[用于 JWT 签名]
    H --> I[返回 Token 给前端]
```

### 密钥轮换机制

1. **首次初始化**: 生成 runtime_secret 并存储
2. **管理员创建后**: 主动轮换 runtime_secret
3. **Token 失效**: 旧 Token 因密钥变化而失效
4. **重新登录**: 用户使用新密钥获取新 Token

## Schema 迁移流程

### 自动迁移检测

```mermaid
graph TB
    A[应用启动] --> B[initSchemaAsync]
    B --> C{检测数据库类型}
    C -->|SQLite| D[同步执行迁移]
    C -->|MySQL| E[异步执行迁移]
    C -->|PostgreSQL| F[异步执行迁移]
    
    D --> G[检查表是否存在]
    E --> G
    F --> G
    
    G --> H{表存在?}
    H -->|否| I[创建新表]
    H -->|是| J[检查字段]
    
    J --> K{需要迁移?}
    K -->|是| L[ALTER TABLE 添加字段]
    K -->|否| M[跳过]
    
    I --> N[创建索引]
    L --> N
    M --> N
    
    N --> O[迁移完成]
```

### 迁移脚本示例

**添加 whois_cache 表:**
```typescript
// server/src/db/dsm/schemas/generate-sql.ts（sqliteSchema）
conn.exec(`
  CREATE TABLE IF NOT EXISTS whois_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT NOT NULL UNIQUE,
    data TEXT,
    expires_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);
```

**添加 pinned_domains 字段:**
```typescript
// PostgreSQL / SQLite
conn.exec(`
  ALTER TABLE user_preferences 
  ADD COLUMN IF NOT EXISTS pinned_domains TEXT
`);

// MySQL
conn.execute(`
  ALTER TABLE user_preferences 
  ADD COLUMN pinned_domains JSON
`);
```

## 初始化状态检查

### API 端点

```
GET /api/init/status
```

**响应示例:**
```json
{
  "initialized": false,
  "database": true,
  "admin_exists": false
}
```

### 初始化保护

- `/api/init/*` 仅在未初始化时可访问
- 已初始化后返回 `403 Forbidden`
- 防止重复初始化和数据覆盖

## 环境变量配置

### 必需变量

```bash
# 数据库配置
DB_TYPE=sqlite          # sqlite / mysql / postgresql
DB_PATH=./hidns.db     # SQLite 数据库路径

# JWT 配置（生产环境必须设置）
JWT_SECRET=your-secret-key-here

# 服务器配置
PORT=3001
NODE_ENV=production
```

### 可选变量

```bash
# MySQL / PostgreSQL 配置
DB_HOST=localhost
DB_PORT=3306
DB_NAME=hidns
DB_USER=root
DB_PASSWORD=password
DB_SSL=false

# SMTP 邮件配置
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=noreply@example.com
SMTP_PASSWORD=password
```

## 初始化检查清单

- [ ] 数据库连接成功
- [ ] Schema 创建完成
- [ ] 所有核心表存在
- [ ] 索引创建完成
- [ ] 初始数据插入
- [ ] 管理员账户创建
- [ ] runtime_secret 生成
- [ ] 审计日志记录
- [ ] JWT Token 返回
- [ ] 前端跳转成功

## 故障排查

### 常见问题

1. **数据库连接失败**
   - 检查 DB_TYPE 配置
   - 验证数据库服务运行状态
   - 确认网络连接和防火墙设置

2. **Schema 创建失败**
   - 检查数据库权限
   - 查看错误日志定位具体 SQL
   - 手动执行失败的 SQL 语句

3. **管理员创建失败**
   - 检查用户名/邮箱是否唯一
   - 验证密码强度要求
   - 确认 runtime_secret 生成成功

4. **Token 无效**
   - 检查 JWT_SECRET 配置
   - 确认 runtime_secret 已存储
   - 清除浏览器缓存重新登录

### 日志位置

```
server/data/hidns.log      # 应用日志
server/data/hidns.db       # SQLite 数据库
```

## 安全注意事项

1. **JWT_SECRET**: 生产环境必须设置强密钥
2. **runtime_secret**: 自动生成，不要手动修改
3. **管理员密码**: 使用强密码，至少 8 位
4. **初始化接口**: 初始化后自动禁用
5. **审计日志**: 所有初始化操作都记录日志
