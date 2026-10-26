# PR #40 审查报告 · feat: fine-grained token permission

- 审查日期：2026-10-26
- 审查对象：[HiPM-Tech/HiDNS#40](https://github.com/HiPM-Tech/HiDNS/pull/40)，base `ab146dff`(main) ← head `dfe646bc`，25 个文件 / +900 −144 / 2 commits
- 审查依据：`root.ai.md`（项目开发规范）
- 审查方式：逐行读 diff + 在 PR head 上跑门禁 + Express 路由上下文体外探针 + 权限边界探针（SQLite 实库）

## 结论

**请求变更（Request changes）**。权限模型本身是对的，语义收紧也做得比历史实现干净：写不隐含读、空配置不放行、旧数组迁移只展开到既有服务、时间窗只在显式清空时删除。这些我都实测确认过。

但执行点放在「`baseUrl` 字符串匹配 + 默认返回 null（放行）」上，**新模块默认不受控**；另外三处读路径对「损坏权限数据」的处理不一致，其中一处会把整页打成 500。这两条列为 P1。

| 级别 | 数量 | 合并阻塞 |
|---|---|---|
| P0 | 0 | — |
| P1 | 2 | 是 |
| P2 | 4 | 建议同批处理，P2-1 可拆后续 |
| P3 | 3 | 否 |

## 一、已核实通过（附证据）

| 核对项 | 结果 | 证据 |
|---|---|---|
| 真实挂载下 `req.baseUrl` / `req.route.path` 可用 | 通过 | Express 4.22.1 探针：挂载 `/api/domains/:domainId/records` 时 `baseUrl=/api/domains/11/records`（保留原始大小写，故必须 `toLowerCase()`），route 级中间件能拿到 `req.route.path='/:recordId'`，HEAD 命中 GET handler |
| 8 个 `service:'dns'` 模块全部有权限映射 | 通过 | `api/index.ts` 清单：accounts / domain-email-templates / domains / providers / records / ns-monitor / servicemonitor / workflows；`token-permissions.ts` 8 个分支逐一对应，路径拼写 `/:id/lines`、`/:id/record-types`、`/:id/run`、`/:id/test`、`/resolve-ns`、`/:id/check`、`/providers` 与真实路由一致 |
| 写不隐含读、`{}`/`{"dns":[]}` 不放行、`mcp` 仅 `['*']` | 通过 | `hasDnsPermission` 精确匹配；`parseAllowedServices` 拒绝未知服务/未知权限/错误类型/`mcp:[]`（400） |
| 旧数组迁移不授予未来服务 | 通过 | `["*"]` → `{"dns":["*"],"mcp":["*"]}`，`["dns"]` → `{"dns":["*"]}`，`["records.write","unknown"]` → `{}`；`hasServicePermission` 对 `future-service` 恒 false |
| 时间窗语义 | 通过 | 后端 `undefined` 保留、`null` 清除；前端 `startTime` 状态保留原 ISO 值，只在字段被清空或原值为空时提交 `null`，未复现「仅编辑权限即删有效期」 |
| dry-run 不写入、重复初始化不扩大权限 | 通过 | `tests/db-bootstrap.test.ts` 实测通过（新库建表 + 迁移 + 二次 init + 手动收紧后再次 init） |
| 门禁 | 通过 | server `tsc --noEmit` ✓、改动文件 `eslint --max-warnings=0` ✓、全量 vitest **91 文件 / 714 用例** ✓；client `tsc -b` ✓、全量 vitest **51 文件 / 191 用例** ✓、`eslint` ✓ |
| 文档同步 | 部分通过 | `docs/api.md` 已更新契约与权限表（符合 §外部应用集成 API「api.md 是第一权威」）；但 `docs/architecture/api-token.md` 仍是旧数组契约（见 P2-3） |

> 用例总数 714 与 PR 自带自审文件里的「714」一致；前端 191 与其文档后半段一致（前半段写 183，属该文件内部不一致，见第五节）。

## 二、问题清单

### P1-1 · 权限执行点是「枚举 + 默认放行」，新增 DNS 模块直接不受控

**位置**：`server/src/api/token-permissions.ts:27-28`（`default: return null`）、`server/src/middleware/auth.ts:44-48`（`if (permission && ...)`，null 即跳过校验）

**证据（实测，非推理）**：把一个新模块 `{ id:'example', prefix:'/api/example', service:'dns' }` 挂到真实 `mountApiModules` 上，用只持有 `{"dns":["accounts.read"]}` 的令牌请求：

```
PROBE-UNMAPPED read= 200 write= 200 {"code":0,"data":"UNMAPPED DNS WRITE"}
```

DELETE 也放行。也就是说：任何后续新增的 dns 模块（仓库现有 20+ 个 API 模块且仍在增加，如 `/api/resource-monitor`、`/api/workflows`）只要忘了改 `token-permissions.ts`，细粒度权限对它完全失效，且**没有任何测试或启动校验会报警**。

同一根因还有两个次级表现：

1. `req.route?.path` 是精确字符串比较。某天把 `/:id/lines` 改写成 `/:domainId/lines`，`records.read` 令牌会静默降级为模块默认的 `domains.read`（仍是 fail-closed，只是权限语义漂移，用户看到莫名 403）。
2. 若某天有人在 DNS 路由里写 `router.use(authMiddleware)`（当前没有），`req.route` 为 undefined、`route=''`，`/api/workflows/:id/run` 会被判成 `workflow.write`（今天不可利用，因为 run/write 还额外要求 JWT；但它说明「按路径字符串分类」这条路没有兜底）。

**规范依据**：

- §路由：「实现必须采用「默认拒绝 + 显式豁免」，**禁止**逐个枚举受保护前缀」——本实现正好相反。
- §客户端架构 4：「先在后端判定，再把判定结果透出……三步缺一不可」——执行点不在声明层，新增端点无法自动继承约束。
- `docs/refactor/04-AUDIT-2.3.0.md:86` 记录的 P0 整改要求是「**在 `api/` 模块声明层接线** `requireServicePermission`」，本 PR 走了另一条路（`baseUrl` 字符串匹配），偏离了该结论。

**建议（可直接落地）**：把权限声明前移到模块清单，`registry.ts` 启动期 fail-fast，执行点改用「模块（mount 时已确定）+ 只读 route 覆盖」，彻底删掉 `baseUrl` 字符串匹配。

```ts
// server/src/api/types.ts
import type { DnsTokenPermission } from '../types/token';

export interface ApiModule {
  // ... 现有字段
  /** DNS 操作权限默认值；service === 'dns' 时必填（registry 强校验） */
  readonly permission?: DnsTokenPermission;
  /** 可选：按方法/路由细化；返回 null 表示沿用 permission，绝不允许返回「放行」 */
  readonly resolvePermission?: (method: string, routePath: string) => DnsTokenPermission | null;
}
```

```ts
// server/src/api/registry.ts —— defineApiModules 循环内，与现有 fail-fast 同风格
if (module.service === 'dns' && !module.permission) {
  throw new Error(`DNS API module ${module.id} must declare permission (fail-closed)`);
}
```

```ts
// server/src/api/mount.ts —— 把模块绑到请求上，执行点不再猜前缀
function buildServiceGate(module: ApiModule) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    (req as { apiModule?: ApiModule }).apiModule = module;
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) { next(); return; }
    const payload = await verifyToken(header.slice(7).trim());
    if (!payload) { next(); return; }
    if (!hasServicePermission(payload, module.service!)) {
      sendError(res, 'Token does not have permission for ' + module.service, 403);
      return;
    }
    next();
  };
}

export function mountApiModules(app: Application, modules: readonly ApiModule[]): void {
  for (const module of modules) {
    const gate = module.service ? [buildServiceGate(module)] : [];
    app.use(module.prefix, ...gate, ...(module.middlewares ?? []), module.router);
  }
}
```

```ts
// server/src/middleware/auth.ts —— verifyToken 成功之后
const apiModule = (req as { apiModule?: ApiModule }).apiModule;
if (apiModule?.service === 'dns') {
  const permission = apiModule.resolvePermission?.(req.method, req.route?.path ?? '') ?? apiModule.permission!;
  if (!hasDnsPermission(tokenPayload, permission)) {
    sendError(res, 'Token does not have permission for dns:' + permission, 403);
    return;
  }
}
```

`token-permissions.ts` 随之退化为每个模块的 `resolvePermission` 实现（例如 domains 模块：`routePath === '/:id/lines' || routePath === '/:id/record-types' ? 'records.read' : (read ? 'domains.read' : 'domains.write')`），并补一条注册表用例：**遍历 `buildApiModules()`，断言每个 `service:'dns'` 模块都有 `permission`**。这样新增模块不声明就起不来，比「新增模块忘了改 switch」可靠。

### P1-2 · 单条损坏权限数据会让 `GET /api/tokens` 永久 500，且无法在 UI 里删除

**位置**：`server/src/service/token.ts:111-145`（`getUserTokens` 内 `readAllowedServices(t.allowed_services)` 未包 try）、`server/src/service/token-permissions.ts:29`（`JSON.parse`）、`server/src/service/token-migration.ts:13-18`（迁移刻意跳过损坏行）

**证据（实测）**：

```
PROBE-GETUSERTOKENS message: Expected property name or '}' in JSON at position 1 (line 1 column 2)
PROBE-VERIFY: null
```

`verifyToken` 对同一行 fail-closed 返回 null（401，符合预期）；`getUserTokens` 直接把异常抛出，经 `asyncHandler` 变成 500。而迁移逻辑**明确承认**这种行会存在（`catch { continue; }`，注释「不能让一条坏凭据阻止整个数据库启动」）。三处读路径三种策略：

| 读路径 | 损坏数据行为 | 结论 |
|---|---|---|
| `verifyToken`（鉴权） | 返回 null → 401 | 正确 |
| `migrateTokenServicePermissions`（启动） | 跳过、静默 | 可接受但缺日志（见 P2-2） |
| `getUserTokens`（列表） | 抛异常 → 500 | **缺陷** |

**影响**：升级后该用户的「API 令牌」页整页报错，列表里拿不到行，也就没法通过 UI 删除坏行，只能改库。

**建议**：

```ts
// server/src/service/token-permissions.ts
/** 读路径专用：任何无法解析的持久化值都降级为「无任何服务权限」，绝不抛给调用方。 */
export function readAllowedServicesSafe(value: unknown): AllowedServices {
  try { return readAllowedServices(value); } catch { return {}; }
}
```

`getUserTokens` 改用它；如需让用户知道，响应里带 `invalid_permissions: true`（列表页显示「配置损坏，请重新设置」），比整页 500 有用。同一降级函数也建议在迁移里复用，避免迁移与读取两套判断。


### P2-1 · cookie 携带的 UserToken 绕过服务级隔离（既有缺陷，本 PR 未收口）

**位置**：`server/src/api/mount.ts:12-17`（门禁只认 `Authorization: Bearer`）、`server/src/middleware/auth.ts:16-20`（cookie 优先）

**证据（实测）**：

```
PROBE-MCP bearer= 403 cookie= 200 {"code":0,"data":"MCP CONFIG"}
```

同一个 `{"dns":["accounts.read"]}` 令牌：Bearer 走 → 403；放进 cookie → 200，进入 MCP 路由。

根因是服务级门禁在 mount 层只看 Bearer，而 `authMiddleware` 支持 cookie，且 `requireServicePermission` 全仓 0 调用方（`grep -rl requireServicePermission routes/` = 0，与 `04-AUDIT-2.3.0.md:45` 记录一致）。本 PR 新增的 DNS 操作权限同样以 `baseUrl` 为准、对 `/api/mcp` 返回 null，所以补不上这个洞。

**说明**：这不是本 PR 引入的（`buildServiceGate` 在 base 里已存在），但 PR 的测试用例名写着「服务隔离」，覆盖的却是 Bearer 分支，容易让人误以为隔离已闭环；且 P1-1 的改法顺手就能修掉（服务判定搬进 `authMiddleware`，那里 payload 已解析、cookie/Bearer 统一）。建议同批处理，或单开 issue 并在此处留 TODO 引用。

### P2-2 · DSM 层反向依赖 service 层；迁移零日志

**位置**：`server/src/db/dsm/init-dsm.ts:8`（`import { migrateTokenServicePermissions } from '../../service/token-migration'`）、`:47`（调用）、`server/src/service/token-migration.ts`（全文件无 logger）

1. **依赖方向**。§数据库 2 的调用链是「路由/Service/Middleware → BAL → DAL → DL」，DSM 属数据层。现在 `db/dsm/` 反向 import `service/`，等于把业务层塞进数据层：`initializeDSM` 被 `/api/init` 与测试直接调用，等于让 schema 工具依赖业务代码；`db/dsm/` 里任何一个模块将来 import service 都会放大成循环依赖风险（`service/token-migration → BAL`，BAL 又依赖 DSM schema 常量）。
   - 现成落点就在同文件：`registerDefaultMigrations(runner)` + `DataMigrationRunner`。该 runner 已有 id 幂等、失败收集（`result.failed`），只需放宽「仅 legacy 才跑」的条件——把 `await migrateTokenServicePermissions()` 改成注册一条 migration，并在 `!dryRun` 路径无条件跑（legacy 分支保持现状）。
   - 或者最省事：把这次调用移出 `initializeDSM`，放到启动编排（`app.ts` 或 `service/` 的启动步骤）里，在 DSM 完成之后执行。
2. **日志缺失**。§日志 5：「错误日志必须包含详细错误信息」「操作日志必须包含详细操作信息」；§日志 9 要求高频日志限流。迁移静默跳过损坏行（`token-migration.ts:15-18`），运维在升级后完全无法知道「有几条令牌被降级为无权限」。至少要：

```ts
// server/src/service/token-migration.ts
import { createLogger } from '../lib/logger';
const log = createLogger('Token').sub('Migration');

let migrated = 0;
let skipped = 0;
// 循环内
try { /* ... */ } catch {
  skipped += 1;
  if (skipped === 1 || skipped % 100 === 0) {           // 限流，避免刷屏
    log.tag('SKIPPED').warn('Token permission row is not valid JSON; left untouched', { tokenId: Number(row.id), skipped });
  }
  continue;
}
// 结束
log.tag('DONE').info('Token service permissions migrated', { migrated, skipped });
```

3. **边界（低风险，仅记录）**：迁移在每次非 dry-run 的 `initializeDSM` 里全表 keyset 扫描（每 200 行一次查询）。空表 1 次查询；万级令牌约 50 次。可接受，但如果 `/api/init/database` 会在运行期触发 DSM 初始化，这段就落在请求链路上，值得在注释里写明成本。

### P2-3 · 文档只更新了一半，且 `api.md` 的通用规则与实现不完全一致

1. `docs/architecture/api-token.md:63`（`allowed_services: string; // JSON 数组`）、`:130`（示例 `["*"]`）、`:384`（`allowed_services TEXT NOT NULL, -- JSON 数组`）仍是旧契约。§外部应用集成 API 说 api.md 是第一权威，但架构文档与权威文档互相矛盾时，后来者会按架构文档写代码。
2. `docs/api.md`（新增段落）写「读取包括 GET/HEAD；其余方法默认按写入处理（上表明确列出的例外除外）」，但实现里 `/api/providers`（`token-permissions.ts:18-19`）与 `/api/domains/email-templates`（`:16-17`）**与 method 无关**，一律返回 `*.read`。当前这两个路由确实只有 GET（`routes/providers.ts:20,105`；`routes/records.ts` 的 emailTemplatesRouter 全是 GET），所以行为与文档一致；但文档承诺的是一条通用规则，代码留的是一个「将来加写路由就被 read 权限静默覆盖」的缺口。建议二选一：代码按 method 收紧（`return read ? 'providers.read' : null` → 由 P1-1 的模块默认权限兜底），或文档明确写「按资源整体只读」。
3. `docs/CHANGELOG.md` 没有本次条目。`allowed_services` 从数组改成对象是**破坏性 API 变更**（外部工具若调用 `POST/PUT /api/tokens` 会直接 400）。按 §版本发布流程，发布时必须在 `docs/CHANGELOG.md` 记一条，并明确「旧数组一律 400，历史数据由启动迁移转换」。

### P2-4 · 权限清单在前端复制了一份，无一致性约束

`server/src/types/token.ts:49-57` 与 `client/src/features/tokens/permissions.ts:2-10` 是同一份 15 项列表的手抄。加一项权限时忘改前端 = UI 里永远选不到（后端支持但前端不暴露）；改错一个字 = 前端提交 400。建议：CI 里加一条断言（读 server 常量与 client 常量比对，不等则失败），或从 OpenAPI/生成脚本产出客户端常量。

另外 PR 描述写「直接复用了 AVAILABLE_SERVICES」，与实际不符：`DNS_TOKEN_PERMISSIONS`（`types/token.ts:49-57`）是新常量，`AVAILABLE_SERVICES`（`:67-80`）保留给工作流动作，两者交集只是子集关系（后者没有 `providers.read`/`email-templates.read`/`ns-monitor.*`/`servicemonitor.*`，却多了 `system.read`/`network.fetch`/`notify.send`）。若有人照 PR 描述往 `AllowedServices` 里塞 `system.read`，会被 `parseAllowedServices` 直接判 400。建议把 PR 描述改准确，并在 `types/token.ts` 两处常量上方各写一句「谁在用、扩展时要同步什么」。

### P3-1 · UI 文案与可达性

- 权限小标签直接展示 `records.read` 这类英文键。§客户端架构 1 要求「单一简体中文，文案集中在 copy/zh-CN.ts 与各 feature 内部」。建议标签用中文（「记录·读」），键放 `title`/`aria-description` 供技术人员核对。
- `tokens-page.tsx:141` 用 `title` 承载权限明细，键盘/触屏无法触达；可加 focusable 的 Popover 或把摘要写进可见文本。
- `TokenServicePicker` 用 `useId()` 生成 `:r1:` 作为元素 id（`token-service-picker.tsx:9,54,61`）。合法但 `querySelector('#:r1:')` 不可用，且与部分 a11y 工具的匹配规则冲突，建议加固定前缀如 `token-perm-${id}-${service}`。
- `aria-pressed` 用在「服务开关」与「权限小标签」上是合适的；展开按钮用 `aria-expanded`+`aria-controls` 也对。这部分做得比仓库现有组件规范更严谨。

### P3-2 · 授予了却永远用不了的权限项

`workflow.write` / `workflow.run` 能被授权，但写入与运行端点强制 `requireJwtAuth`（`routes/workflows.ts:82,389,455,525`），UserToken 永远过不去。api.md 已注明「不能通过 UserToken 执行」，但 UI 里仍可勾选，属于「能点但无效」。建议这两项在 UI 置灰并加说明，或干脆不放进 `DNS_TOKEN_PERMISSIONS`。

### P3-3 · 细节

- `createUserToken`（`service/token.ts:28-51`）库里存的是 `parseAllowedServices(...)` 的规整结果，但返回体用的是**入参** `data.allowed_services`，重复项/顺序不一致时响应与实际持久化不符。改成复用同一个变量即可。
- `OPTIONS` 会被判成写权限（`read` 只认 GET/HEAD）。正常预检不带 Authorization，影响可忽略；若要严谨，`OPTIONS` 视为不需要操作权限（仍保留服务级判定）。
- `req.route?.path ?? ''` 的兜底空串会让「路由级中间件」以外的一切挂载方式静默降级——这是 P1-1 的一部分，改完后可删掉这个兜底。

## 三、规范逐条对照

| root.ai.md 条款 | 判定 | 说明 |
|---|---|---|
| §代码审核团 4 审查文件放 `ai-censorship/`、命名 `[模型名]_review-YYYYMMDD.md` | 通过 | 本 PR 自带 `ai-censorship/gpt-6.1-sol_review-20261026.md` |
| §代码审核团 1 审查中立性 | 部分 | 该文件是**实现方自审**，不构成独立审查（见第五节） |
| §数据库 2 调用链禁止跨层 | **不通过** | DSM → service 反向依赖（P2-2） |
| §数据库 2 数据库操作必须走 BAL | 通过 | 新增 `TokenOperations.getServicePermissionBatch` 落在 BAL，未直连 query/驱动 |
| §日志 5 / 9 错误日志与限流 | **不通过** | 迁移静默跳过坏行、无任何日志（P2-2） |
| §路由 默认拒绝 + 显式豁免 | **不通过** | 权限门是枚举 + 默认放行（P1-1） |
| §外部应用集成 API 必须同步 `docs/api.md` | 通过 | 契约、字段语义、映射表都补了 |
| §提交信息格式 | 部分 | 两条 commit 首行合规（`feat: ...`），但正文没有任何 `详细描述：` 分段（`git log -2 --format=%B` 只有主题行） |
| §版本发布 / CHANGELOG | 待办 | 破坏性变更需在发布时记入 `docs/CHANGELOG.md`（P2-3） |

## 四、复现与验证

```bash
# 取 PR head 到本地只读分支，建临时工作区（不碰 main 工作树）
git fetch --no-tags origin pull/40/head:refs/heads/pr40-review
git worktree add -f /tmp/pr40wt pr40-review

# 服务端门禁（实测通过）
cd /tmp/pr40wt/server && npx tsc --noEmit
cd /tmp/pr40wt/server && npx vitest run            # 91 files / 714 tests
cd /tmp/pr40wt/server && npx eslint src/api src/service src/middleware src/routes/tokens.ts src/types/token.ts --max-warnings=0

# 前端门禁（实测通过）
cd /tmp/pr40wt/client && npx tsc -b
cd /tmp/pr40wt/client && npx vitest run            # 51 files / 191 tests
cd /tmp/pr40wt/client && npx eslint src/features/tokens --max-warnings=0

# 用完清理
git worktree remove --force /tmp/pr40wt
```

P1-1 的边界探针（可直接放进 `server/src/api/__tests__/`，改 P1-1 后应当**失败**）：

```ts
it('未登记权限的新 dns 模块必须被拒绝', async () => {
  const example = express.Router();
  example.delete('/secret', authMiddleware, (_q, s) => s.json({ code: 0 }));
  mountApiModules(app, [
    { id: 'example', prefix: '/api/example', service: 'dns', router: example, description: 'new dns module' } as never,
  ]);
  // 令牌只持有 accounts.read；修复前返回 200
  expect((await call('/api/example/secret', 'dnsonly', 'DELETE')).status).toBe(403);
});
```

P1-2 的边界探针（当前实现抛异常）：

```ts
vi.mocked(TokenOperations.getByUserId).mockResolvedValue([
  { id: 1, user_id: 2, name: 'x', is_active: 1, max_role: 1, allowed_domains: '[]', allowed_services: '{bad-json' } as never,
]);
expect(await getUserTokens(2)).toHaveLength(1);   // 修复前：抛 SyntaxError
```

## 五、对 PR 自带自审文件的意见

`ai-censorship/gpt-6.1-sol_review-20261026.md`：

- 结论「未发现未解决的 P0/P1」与本次两项 P1 冲突。P1-1 的探针一跑就出；P1-2 的问题点就在它自己写的「损坏权限数据在验证时拒绝认证」旁边——验证路径确实 fail-closed，列表路径没管。
- 同一文件内前端数字前后不一致（先「50 个文件、183 个用例」，后「51 个文件、191 个用例」）。实测当前 head 是 51/191，前半段应为过期数据。
- 值得肯定的部分：如实披露了「未运行真实 MySQL / PostgreSQL 实例集成测试」「未做浏览器实机端到端联调」，也没有把测试通过写成功能验收。§代码审核团 2 关注的是「靠日志拖延、不细查」，这份文件不属于该情形。
- 但按 §代码审核团 1，实现方自审不能替代独立审查；本报告即为独立审查。

## 六、合并前置条件

1. **P1-1**：权限声明进 `ApiModule`，`defineApiModules` 对 `service:'dns'` 强制要求 `permission`，执行点去掉 `baseUrl` 字符串匹配，补「新增模块必须声明权限」的注册表用例。
2. **P1-2**：列表读路径复用 `readAllowedServicesSafe`，补一条「损坏行不出 500」的用例。
3. **P2-2**：迁移移出 DSM 或改走 `DataMigrationRunner`；补 `log`（含限流）与计数。
4. **P2-3**：更新 `docs/architecture/api-token.md` 三处旧契约；`api.md` 的「其余方法按写处理」与实现对齐；发布时补 CHANGELOG。
5. **P2-4**：前后端权限清单加一致性断言（可放 CI）。
6. **P2-1**：服务级判定搬进 `authMiddleware`（与 P1-1 同批最省），或开 issue 并在 `mount.ts` 注释里留引用。
7. P3 不阻塞，但 §提交信息格式 的 `详细描述：` 段落建议补上。

## 七、备注

- 本报告只审 PR #40 的 25 个文件，不是全仓审查结论；未覆盖 MySQL / PostgreSQL 实例验证（与 PR 自审同样的限制）。聚合列 `json` 在 MySQL/PG 驱动下可能直接返回对象，代码里 `typeof row.allowed_services === 'string'` 两条分支都已处理，静态看没问题，但建议发布前在真实 MySQL 跑一次 `tests/db-bootstrap.test.ts`。
- 复核用：已把 PR head 取到本地只读分支 `pr40-review`（仅本地 ref，未 push），可用 `git show pr40-review:<path>` 对照本报告的行号。

