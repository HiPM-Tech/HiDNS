# WebSocket 实时数据集成指南

## 📖 概述

DNSMgr 现已支持 **WebSocket + 轮询降级** 的实时数据方案，可以在后端数据变更时立即通知前端，同时保证在 WebSocket 不可用时通过轮询保持数据同步。

---

## ✅ 已集成的页面

### 1. 域名列表 (DomainListTab)
- **文件**: `client/src/features/domains/domains-page.tsx`
- **监听事件**: `domain_created`, `domain_updated`, `domain_deleted`
- **轮询间隔**: 60秒
- **状态**: ✅ 已完成

### 2. 账号管理 (Accounts)
- **文件**: `client/src/features/accounts/accounts-page.tsx`
- **监听事件**: `account_created`, `account_updated`, `account_deleted`
- **轮询间隔**: 60秒
- **状态**: ✅ 已完成

### 3. DNS 记录 (Records)
- **文件**: `client/src/features/records/records-page.tsx`
- **监听事件**: `record_created`, `record_updated`, `record_deleted`, `record_status_changed`
- **轮询间隔**: 30秒（记录变化更频繁）
- **状态**: ✅ 已完成

---

## 🔧 待集成的页面清单

### 4. NS 监测 (NSMonitorTab)
**文件**: `client/src/features/domains/ns-monitor-tab.tsx`

```typescript
import { useRealtimeData } from '../../hooks/useRealtimeData';

export function NSMonitorTab() {
  // 实时数据：NS监测结果更新
  useRealtimeData({
    queryKey: ['ns-monitor'],
    websocketEventTypes: ['ns_monitor_updated'],
    pollingInterval: 120000, // 2分钟
  });
  
  // ... rest of component
}
```

---

### 5. 域名续期 (DomainRenewalTab)
**文件**: `client/src/features/domains/renewal-tab.tsx`

```typescript
import { useRealtimeData } from '../../hooks/useRealtimeData';

export function DomainRenewalTab() {
  // 实时数据：域名续期状态更新
  useRealtimeData({
    queryKey: ['renewable-domains'],
    websocketEventTypes: ['domain_renewed', 'domain_expiring_soon'],
    pollingInterval: 300000, // 5分钟
  });
  
  // ... rest of component
}
```

---

### 6. API 令牌 (Tokens)
**文件**: `client/src/features/tokens/tokens-page.tsx`

```typescript
import { useRealtimeData } from '../hooks/useRealtimeData';

function Tokens() {
  // 实时数据：Token变更
  useRealtimeData({
    queryKey: ['tokens'],
    websocketEventTypes: ['token_created', 'token_revoked'],
    pollingInterval: 120000, // 2分钟
  });
  
  // ... rest of component
}
```

---

### 7. 审计日志 (AuditLogs)
**文件**: `client/src/features/audit/audit-page.tsx`

```typescript
import { useRealtimeData } from '../hooks/useRealtimeData';

function AuditLogs() {
  // 实时数据：新审计日志
  useRealtimeData({
    queryKey: ['audit-logs'],
    websocketEventTypes: ['audit_log_created'],
    pollingInterval: 60000, // 1分钟
  });
  
  // ... rest of component
}
```

---

### 8. 团队管理 (Teams)
**文件**: `client/src/features/teams/teams-page.tsx`

```typescript
import { useRealtimeData } from '../hooks/useRealtimeData';

function Teams() {
  // 实时数据：团队变更
  useRealtimeData({
    queryKey: ['teams'],
    websocketEventTypes: ['team_created', 'team_updated', 'team_deleted', 'team_member_added', 'team_member_removed'],
    pollingInterval: 120000, // 2分钟
  });
  
  // ... rest of component
}
```

---

### 9. 系统设置 (Settings)
**文件**: `client/src/features/settings/settings-page.tsx`

```typescript
import { useRealtimeData } from '../hooks/useRealtimeData';

function Settings() {
  // 实时数据：系统配置变更
  useRealtimeData({
    queryKey: ['system-config'],
    websocketEventTypes: ['config_updated'],
    pollingInterval: 300000, // 5分钟
  });
  
  // ... rest of component
}
```

---

### 10. 用户管理 (Users)
**文件**: `client/src/features/users/users-page.tsx`

```typescript
import { useRealtimeData } from '../hooks/useRealtimeData';

function Users() {
  // 实时数据：用户变更
  useRealtimeData({
    queryKey: ['users'],
    websocketEventTypes: ['user_created', 'user_updated', 'user_deleted'],
    pollingInterval: 120000, // 2分钟
  });
  
  // ... rest of component
}
```

---

## 🎯 WebSocket 事件类型规范

### 域名相关
| 事件 | 说明 | 触发时机 |
|------|------|---------|
| `domain_created` | 域名创建 | 添加新域名后 |
| `domain_updated` | 域名更新 | 修改域名备注、配置等 |
| `domain_deleted` | 域名删除 | 删除域名后 |
| `domain_renewed` | 域名续期 | 自动/手动续期成功后 |
| `domain_expiring_soon` | 域名即将到期 | 检测到域名即将到期时 |

### 账号相关
| 事件 | 说明 | 触发时机 |
|------|------|---------|
| `account_created` | 账号创建 | 添加 DNS 账号后 |
| `account_updated` | 账号更新 | 修改账号配置后 |
| `account_deleted` | 账号删除 | 删除账号后 |

### DNS 记录相关
| 事件 | 说明 | 触发时机 |
|------|------|---------|
| `record_created` | 记录创建 | 添加 DNS 记录后 |
| `record_updated` | 记录更新 | 修改 DNS 记录后 |
| `record_deleted` | 记录删除 | 删除 DNS 记录后 |
| `record_status_changed` | 记录状态变更 | 启用/禁用记录后 |

### 团队相关
| 事件 | 说明 | 触发时机 |
|------|------|---------|
| `team_created` | 团队创建 | 创建新团队后 |
| `team_updated` | 团队更新 | 修改团队信息后 |
| `team_deleted` | 团队删除 | 删除团队后 |
| `team_member_added` | 团队成员添加 | 添加成员到团队后 |
| `team_member_removed` | 团队成员移除 | 从团队移除成员后 |

### Token 相关
| 事件 | 说明 | 触发时机 |
|------|------|---------|
| `token_created` | Token 创建 | 创建新 API Token 后 |
| `token_revoked` | Token 撤销 | 撤销 Token 后 |

### 用户相关
| 事件 | 说明 | 触发时机 |
|------|------|---------|
| `user_created` | 用户创建 | 注册新用户后 |
| `user_updated` | 用户更新 | 修改用户信息后 |
| `user_deleted` | 用户删除 | 删除用户后 |

### 系统相关
| 事件 | 说明 | 触发时机 |
|------|------|---------|
| `config_updated` | 配置更新 | 修改系统配置后 |
| `audit_log_created` | 审计日志创建 | 产生新的审计日志时 |
| `ns_monitor_updated` | NS 监测更新 | NS 监测结果更新时 |

---

## 📊 轮询间隔建议

| 页面类型 | 推荐间隔 | 说明 |
|---------|---------|------|
| DNS 记录 | 30秒 | 变化频繁，需要快速响应 |
| 域名列表 | 60秒 | 中等频率变化 |
| 审计日志 | 60秒 | 实时监控操作 |
| 账号管理 | 60秒 | 中等频率变化 |
| 团队管理 | 2分钟 | 变化较少 |
| API 令牌 | 2分钟 | 变化较少 |
| 用户管理 | 2分钟 | 变化较少 |
| NS 监测 | 2分钟 | 定期检查 |
| 系统设置 | 5分钟 | 很少变化 |
| 域名续期 | 5分钟 | 每天检查一次即可 |

---

## ⚙️ 后端推送示例

### 1. 初始化 WebSocket 服务

在 `server/src/app.ts` 中：

```typescript
import http from 'http';
import { wsService } from './service/websocket';

// 创建 HTTP 服务器
const server = http.createServer(app);

// 初始化 WebSocket
wsService.initialize(server);

// 启动服务器
server.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

// 优雅关闭
process.on('SIGTERM', () => {
  wsService.shutdown();
  server.close();
});
```

### 2. 在路由中推送消息

**域名创建示例** (`server/src/routes/domains.ts`):

```typescript
import { wsService } from '../service/websocket';

router.post('/', authMiddleware, asyncHandler(async (req, res) => {
  const newDomain = await createDomain(req.body);
  
  // 推送 WebSocket 消息
  wsService.broadcast({
    type: 'domain_created',
    data: {
      domainId: newDomain.id,
      name: newDomain.name,
    },
  });
  
  sendSuccess(res, newDomain);
}));
```

**域名删除示例**:

```typescript
router.delete('/:id', authMiddleware, asyncHandler(async (req, res) => {
  const domain = await getDomainById(Number(req.params.id));
  await deleteDomain(Number(req.params.id));
  
  // 推送 WebSocket 消息
  wsService.broadcast({
    type: 'domain_deleted',
    data: {
      domainId: domain.id,
      name: domain.name,
    },
  });
  
  sendSuccess(res, null, 'Domain deleted');
}));
```

**DNS 记录更新示例** (`server/src/routes/records.ts`):

```typescript
router.put('/:domainId/records/:recordId', authMiddleware, asyncHandler(async (req, res) => {
  const updatedRecord = await updateRecord(req.params.domainId, req.params.recordId, req.body);
  
  // 推送 WebSocket 消息
  wsService.broadcast({
    type: 'record_updated',
    data: {
      recordId: updatedRecord.id,
      domainId: updatedRecord.domain_id,
    },
  });
  
  sendSuccess(res, updatedRecord);
}));
```

---

## 🧪 测试方法

### 1. 浏览器控制台测试

打开浏览器开发者工具，在 Console 中执行：

```javascript
// 测试 WebSocket 连接
const ws = new WebSocket('wss://your-domain.com/ws?token=YOUR_TOKEN');

ws.onopen = () => {
  console.log('✅ WebSocket connected!');
};

ws.onmessage = (event) => {
  console.log('📨 Message received:', JSON.parse(event.data));
};

ws.onerror = (error) => {
  console.error('❌ WebSocket error:', error);
};

ws.onclose = (event) => {
  console.log('🔌 WebSocket closed:', event.code, event.reason);
};
```

### 2. 查看网络连接

在 Chrome DevTools 的 **Network** 标签中：
1. 筛选 `WS` (WebSocket)
2. 应该能看到 `/ws` 连接
3. 状态应该是 `101 Switching Protocols`

### 3. 后端日志

```
[INFO] WSService - WebSocket client connected { userId: 1, role: '3', totalClients: 1 }
[INFO] WSService - Received message from client { userId: 1, type: 'ping' }
[INFO] WSService - WebSocket client disconnected { userId: 1, totalClients: 0 }
```

---

## 🔐 Nginx 配置

如果使用 Nginx 反代 HTTPS，需要添加 WebSocket 支持：

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.com;

    # SSL 证书配置
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    # 普通 HTTP 请求
    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket 支持 ⭐
    location /ws {
        proxy_pass http://localhost:3000;
        
        # WebSocket 必需的 headers
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        
        # 其他必要 headers
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # 超时设置（WebSocket 是长连接）
        proxy_read_timeout 86400s;    # 24小时
        proxy_send_timeout 86400s;
        proxy_connect_timeout 60s;
        
        # 缓冲设置
        proxy_buffering off;
    }
}
```

---

## 💡 最佳实践

### 1. 按需订阅
只在需要的页面启用 WebSocket，避免不必要的连接。

### 2. 批量更新
多个相关变更合并为一条消息，减少网络开销。

### 3. 防抖处理
短时间内多次相同类型的更新只触发一次刷新。

### 4. 错误处理
WebSocket 失败时静默降级到轮询，不影响用户体验。

---

## ⚠️ 注意事项

1. **HTTPS 环境**：生产环境必须使用 `wss://` 协议
2. **防火墙配置**：确保 WebSocket 端口未被阻止
3. **负载均衡**：如果使用多实例，需要使用 sticky sessions 或 Redis adapter
4. **内存管理**：定期清理断开的连接，避免内存泄漏
5. **Token 安全**：WebSocket 认证使用与 HTTP API 相同的 JWT Token

---

## 📝 架构优势

| 特性 | 说明 |
|------|------|
| 🔄 **自动降级** | WebSocket 失败时自动切换到轮询 |
| ⚡ **实时推送** | WebSocket 连接时立即推送更新 |
| 🛡️ **容错设计** | 不会影响核心功能，优雅降级 |
| 📊 **灵活配置** | 每个页面可自定义轮询间隔 |
| 🔐 **统一认证** | 复用现有的 JWT Token 认证机制 |
| 🚀 **高性能** | 基于 `ws` 库，轻量高效 |

---

## 🎉 总结

WebSocket 实时数据方案为 DNSMgr 带来了：
- ✅ **更好的用户体验**：数据实时更新，无需手动刷新
- ✅ **更高的可靠性**：WebSocket + 轮询双重保障
- ✅ **更强的扩展性**：易于添加新的事件类型和页面
- ✅ **更低的服务器压力**：减少不必要的轮询请求

现在可以放心地在所有需要的页面中使用 `useRealtimeData` Hook 了！🚀
