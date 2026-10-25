# 域名列表 API 返回格式说明

## 概述

为了兼容外部项目（如 ddns-go、certd）的适配器，`/api/domains` 路由支持两种返回格式。

## 返回格式

### 1. 分页对象格式（默认）

**适用场景**：前端页面展示

**请求示例**：
```bash
GET /api/domains?page=1&pageSize=20
Authorization: Bearer <JWT_TOKEN>
```

**响应格式**：
```json
{
  "code": 0,
  "data": {
    "list": [
      {
        "id": 1,
        "account_id": 1,
        "name": "example.com",
        "third_id": "...",
        "record_count": 12,
        ...
      }
    ],
    "total": 21,
    "page": 1,
    "pageSize": 20,
    "totalPages": 2
  },
  "msg": "success"
}
```

### 2. 直接数组格式

**适用场景**：外部适配器（ddns-go、certd 等）

**触发条件**（满足任一即可）：
- 查询参数 `format=array`
- 使用 API Token 认证（Bearer Token）

**请求示例 1 - 显式指定格式**：
```bash
GET /api/domains?format=array
Authorization: Bearer <JWT_TOKEN>
```

**请求示例 2 - 使用 API Token**：
```bash
GET /api/domains
X-API-Token: <API_TOKEN>
```

**响应格式**：
```json
{
  "code": 0,
  "data": [
    {
      "id": 1,
      "account_id": 1,
      "name": "example.com",
      "third_id": "...",
      "record_count": 12,
      ...
    }
  ],
  "msg": "success"
}
```

## 外部适配器适配指南

### ddns-go (Go)

```go
// getDomainID 获取域名ID
func (h *HiPMDnsMgr) getDomainID(baseURL, apiToken, domainName string) (int, error) {
    // DnsMgr API returns array directly in data when using API Token
    apiResp, err := h.request(baseURL, apiToken, "GET", "/domains?page=1&pageSize=100", nil)
    if err != nil {
        return 0, err
    }
    
    if apiResp.Code != 0 {
        return 0, fmt.Errorf("API错误: %s", apiResp.Msg)
    }
    
    var domains []DnsMgrDomain
    if err := json.Unmarshal(apiResp.Data, &domains); err != nil {
        return 0, err
    }
    
    for _, d := range domains {
        if d.Name == domainName {
            return d.ID, nil
        }
    }
    
    return 0, fmt.Errorf("域名 %s 未找到", domainName)
}
```

### certd (TypeScript)

```typescript
async getDomainList(): Promise<any[]> {
  const response = await this.httpClient.get('/api/domains', {
    headers: {
      'X-API-Token': this.access.apiToken,
    },
  });
  
  // When using API Token, response.data is a direct array
  return response.data;
}
```

## 实现细节

### 后端路由逻辑

```typescript
// server/src/routes/domains.ts

router.get('/', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const { format } = req.query;
  const tokenPayload = (req as any).tokenPayload;
  
  // ... 获取域名列表逻辑 ...
  
  // Return format based on query parameter or token usage
  if (format === 'array' || tokenPayload) {
    sendSuccess(res, paginatedDomains);  // 直接数组
  } else {
    sendSuccess(res, { 
      list: paginatedDomains, 
      total, 
      page: currentPage, 
      pageSize: size, 
      totalPages 
    });  // 分页对象
  }
}));
```

## 注意事项

1. **向后兼容**：默认仍返回分页对象格式，不影响现有前端代码
2. **API Token 自动切换**：使用 API Token 时自动返回数组格式，无需额外参数
3. **显式指定优先**：`format=array` 参数优先级高于 Token 检测
4. **分页仍然有效**：即使返回数组格式，`page` 和 `pageSize` 参数仍然生效

## 相关适配器

- ✅ **ddns-go**: `c:\Users\HINS\Documents\Trae\DNSMgr-1\server\src\lib\dns\providers\dnsmgr.ts`
- ✅ **certd**: HiPM DNSMgr Access & Provider
- ✅ **VPS8**: 已适配分页对象格式


---

## 两套契约（2026-10 起明确分工）

| 契约 | 触发条件 | data 形态 | 域名写法 | 附加字段 |
| --- | --- | --- | --- | --- |
| **UI**（前端） | 浏览器会话（JWT / cookie），无 `format=array` | `{ list, total, page, pageSize, totalPages }` | **Unicode**（前端直接显示） | `can_write`、分组模式下 `_type/group_parentId/groupName/parentPresent` |
| **API**（外部适配器） | `format=array` **或** API Token | 裸数组 | **Punycode** + `display_name`（Unicode） | 与域名行同字段，另附 `can_write` |

判定优先级：`format=array` > Token 认证 > 会话（实现见 `routes/domains.ts` 的 `resolveDomainListShape()`，有单测守护）。

> 为什么必须分开：前端需要分页与展示名，外部工具需要"一次拿全量 + ASCII 名字做后缀匹配"。混用会让一方解析失败——历史上就是 TS 里靠 `format === 'array' || tokenPayload` 隐式判断，容易在改动中走样。

## IDN（xn--）处理

- 入库与比较统一用 **Punycode**（`normalizeDomain` 会把中文/繁中/日文域名转成 `xn--` 形式）；
- 公共后缀表里 PSL 用 Unicode 写的中文后缀（如 `公司.cn`）在解析时**转 Punycode** 入库，否则 `例子.公司.cn` 会被误判成 `公司.cn`；
- API 契约返回 Punycode（`name`）并提供 `display_name`（Unicode）；UI 契约直接返回 Unicode。

## DDNS-Go 兼容现状与结论

| 项 | 现状 | 结论 |
| --- | --- | --- |
| 认证 | `Authorization: Bearer <API Token>`（或会话 cookie） | 兼容 |
| 域名列表 | Token → 裸数组 + `display_name` | 兼容 |
| 域名权限 | `allowed_domains` 为 `null`/`[]` 时**不限制**（历史语义） | 兼容 ddns-go 的"只填令牌"用法 |
| 记录写 | `PUT /api/domains/:domainId/records/:recordId`、`POST /api/domains/:domainId/records`，需 `records.write` | 兼容 |
| 初始化门禁 | 未初始化时 API 一律 503 | 预期行为 |

**是否迭代抛弃：不抛弃。** 理由：

1. 这套契约只多一个分支判断，成本极低；
2. ddns-go / certd 这类工具一旦失败是**静默不更新解析**，用户很难第一时间发现，属于高风险兼容面；
3. 真要收口，先决条件是"Token 仍能拿到全量域名"，而这一点与权限模型（`allowed_domains`）绑在一起，不是单独能删的。

若将来必须改：先在 `X-HiDNS-Compat` 响应头标注弃用期（至少两个 minor 版本），再在 `docs/api.md` 与 CHANGELOG 双处公告。
