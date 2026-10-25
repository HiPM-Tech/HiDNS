# 前端可接触接口核验（2026-10-23）

> 依据：root.ai.md 的「外部应用集成 API」（API 文档第一权威）与「客户端架构」（数据层唯一出口 lib/http）。
> 方法：静态解析 + 抽样人工核对 + 修复后回归。

## 1. 覆盖面（机器解析）

| 项 | 数量 | 说明 |
| --- | --- | --- |
| 后端已注册路由 | **218** | 由 server/src/api/index.ts 的 23 个模块前缀 + 各路由文件解析（含 composeMcpRouter() 的 5 个子挂载） |
| 前端发起的调用 | **151** | client/src 中全部 http.* 调用点（含 *Ok 与 requestRaw） |
| 方法+路径未匹配 | **0** | 归一化 ${x} 与 :param 后逐一比对 |
| 绕过 lib/http 的裸 fetch | **0** | 全仓 grep fetch( 只剩 refetch() 命中 |

## 2. 发现与修复

### F1 · 触发器声明请求了不存在的源（已修）

use-workflow-meta.ts 的 useTriggerMetas() 请求 GET /api/workflows/meta/triggers，但后端 STATIC_META_SOURCES 只有
actions / triggerTypes / recordTypes / domainFields / nsStatuses —— **没有 triggers**，每次打开编辑器必 404；
TriggerConfigFields 拿不到 params，永远退回 JSON 文本框（页面上「触发器配置」看起来不支持表单）。
同一页面的另一处（workflows-page.tsx）却用了正确的 triggerTypes，两处并存。

修复：统一到 triggerTypes，并删掉页面里重复的那次查询（默认选中第一个触发器改用 hook 的 items）。

### F2 · 后端触发器声明缺 params，表单无法渲染（已修）

即使改用 triggerTypes，buildStaticMeta('triggerTypes') 只返回 {value,label}，没有 params，前端按「params 为空 → JSON」处理。
而 workflow/engine.ts 的 TriggerSpec 明确要求：

| 触发器 | 配置字段 | 语义 |
| --- | --- | --- |
| record.changed | recordTypes（A/AAAA） | 只监听这两种记录（§4.0.5） |
| ns.changed | statuses（ok/mismatch/missing/poisoned） | 空 = 只报「非 ok」 |
| whois.expiring | withinDays（必填，数字） | 提前多少天 |

修复：meta.ts 按上表下发 params；前端新增 multiselect 参数类型（勾选框组，空数组表示不过滤）与文案键；
并把 workflow/__tests__/i18n-keys.test.ts 的守护从「仅动作」扩到「触发器 label / param label / hint」。

### F3 · 非管理员打开 MCP 页会打 adminOnly 接口（已修）

/dash/mcp 未套 RequireAdmin（合理：API 密钥与 OAuth 客户端是个人资源），但页面无条件请求 GET /api/mcp/config，
该端点带 adminOnly → 普通用户进入即 403，且 React Query 默认重试 3 次。
修复：enabled: canManage + retry: false；管理开关本来就没渲染给非管理员，行为一致。

## 3. 核过但未发现问题的部分

| 面 | 结论 |
| --- | --- |
| 方法/路径 | 151/151 命中；含动态段（/domains/${id}/records/${recordId}）与 MCP 组合挂载 |
| 查询参数 | 抽查 5 个列表端点：/audit/logs（domain/userId/action/startDate/endDate）、/domains（pageSize）、/domains/:id/records（page/pageSize/keyword/type/line/status）、/accounts（keyword）、/domains/renewable-domains（page/pageSize/keyword/account_id/status）——服务端逐项读取 |
| 写载荷 | 脚本对 **25** 个带对象字面量的 POST/PUT 调用点做字段级比对（客户端字段 vs 服务端 `req.body` 解构/读取），**0** 处服务端未读取的字段；另人工抽查令牌创建（name/allowed_domains/allowed_services/start_time/end_time/max_role）与团队创建（name）的响应键（{token,tokenData} / {id}）一致 |
| 列表形状 | users/accounts 前端兼容「裸数组」与「{list}」；audit 用 {total,list}；workflows/mcp 用 {items}——与服务端实际返回一致 |
| 鉴权闸门 | users/audit/workflows/system/* 均在 RequireAdmin 下；security 策略卡按 admin 开启查询；teams 为 authMiddleware + 团队内权限 |
| 信封契约 | 全仓 http.* 统一走 lib/http；写操作 *Ok 内建 ensureOk；裸 JSON 端点仅 mcp/oauth/authorize（requestRaw） |

## 4. 观察项（未改，记录备查）

1. GET /api/users、GET /api/tokens 返回**裸数组**，而 accounts/audit 返回 {list,total}——前端两种都能吃，但口径不齐，建议后续统一。
2. dash/teams 对普通用户开放：列表按团队可见性过滤，但「新建团队」权限在后端判定，前端未按角色隐藏按钮（点击会得到 403 文案）。
3. /api/workflows/meta/* 全部 adminOnly：若将来给普通用户开放工作流只读视图，需要同步放宽。

## 5. 复现

```bash
node /tmp/audit_routes.cjs        # server routes: 218 / client calls: 151 / unmatched: 0
node /tmp/audit_body.cjs          # checked POST/PUT bodies: 25 / potential mismatches: 0
grep -rn 'fetch(' client/src | grep -v refetch   # → 0
```

门禁：(cd server && npx tsc --noEmit && npx vitest run) → 0 / 64 文件 556 条；
(cd client && npx tsc -b && npx vitest run && npx vite build && npx eslint .) → 0 / 37 文件 146 条 / 通过 / 0。
