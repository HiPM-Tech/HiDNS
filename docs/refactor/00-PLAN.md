# HiDNS 重构总纲（2026-10-23 起）

> 本文是重构的唯一方向文件。后续每一轮改动都应对照本文的「边界」与「门禁」自查；偏离必须在此登记理由。
> 关联：`root.ai.md`（项目规范，第一权威）、`ai-censorship/dsh-agent_review-20261023-panel.md`（86 条隐性问题清单）。

## 1. 目标与非目标

**目标**
1. 前端整体重写：抛弃现有组件库、样式组织与 i18n 运行时，采用主流框架与组件库，界面审美与交互一致性达标。
2. API 语义收敛：字段单一含义、错误码与 HTTP 状态一致、分页/幂等/权限口径统一。
3. API 注册独立成后端子模块：一处声明、一处挂载、门禁由声明派生。
4. 清理遗留隐性问题（panel 报告 P0/P1 优先），并用契约测试与门禁防复发。
5. 前后端解耦：后端只承诺 HTTP 契约；前端只依赖契约与生成的类型。

**非目标（本轮不做）**
- 不改数据库 schema（DSM 协调器保持现状）。
- 不重写 DNS 提供商适配器实现，只修其对外语义与错误通道。
- 不引入新的运行时（Node/Express 版本不变）。

## 2. 目标架构

```
server/src/
├── api/                 # 传输层：注册清单 + 初始化门禁 + 挂载 + 契约校验
│   ├── index.ts         # 唯一注册点（模块清单，顺序即匹配顺序）
│   ├── registry.ts      # 清单校验（id/prefix 唯一、格式、probe 归属）
│   ├── init-gate.ts     # 三态门禁（initialized / uninitialized / unreachable）
│   ├── mount.ts         # 唯一挂载点
│   └── modules/         # 无独立 routes 文件的端点（logs 等）
├── routes/              # 过渡期：业务路由器实现，逐步收敛为 service 调用
├── service/             # 应用层：用例编排，禁止 import express
├── db/                  # 持久化：dl / dal / bal / dsm 四层（保持不变）
└── lib/                 # 基础设施：logger / dns / proxy / utils

client/src/
├── app/                 # 应用外壳：路由表、Providers、布局、错误边界
├── ui/                  # 设计系统原语（Button/Input/Card/Dialog/Table…），无业务语义
├── features/<domain>/   # 垂直切片：api.ts + hooks.ts + components/ + pages/
├── lib/                 # api client、query client、工具（纯函数）
└── copy/                # 集中文案（单一简体中文）
```

**依赖方向（强制）**：`api → service → db`；`lib` 不得反向依赖上层；`features/*` 之间只能通过各自的 `index.ts` 公共出口互相引用。

## 3. 已定技术决策

| 项 | 决策 | 理由 |
| --- | --- | --- |
| 前端框架 | React 19 + Vite + TypeScript（沿用，版本不降级） | 现有工程链成熟，重写聚焦架构与 UI |
| 组件库 | **shadcn/ui 风格**：Radix 原语 + CVA + Tailwind，本地 `ui/` 目录持有源码 | 主流、可审计、无运行时锁定；Tailwind 已在仓库启用 |
| 样式 | Tailwind 原子类 + 设计 tokens（CSS 变量），禁止页面级 CSS 文件 | 对齐 `root.ai.md` §样式规范 |
| 数据层 | TanStack Query（沿用）+ 类型化 fetch 客户端 | 去掉 axios 与手写 loading 状态 |
| 路由 | react-router 7（沿用） | 与现有部署路径一致 |
| 表单 | react-hook-form + zod | 取代手写 useEffect 同步（`useFormSync` 的强制项由 RHF 满足） |
| i18n | **抛弃 i18next 与 11 语言包**，单一简体中文，文案集中 `copy/`，保留 `t()` 签名 | 维护成本 >> 收益；后续要多语言只需替换 `copy/` 实现 |
| 图标 | lucide-react | 与 shadcn 生态一致，去掉 tdesign-icons |
| API 信封 | `{ code, data, msg }`，`code === HTTP 状态码`（0 表示 200 成功） | 消除「200 + code:-1」的静默失败 |
| `line` 语义 | `line` 只表示线路 ID；`proxied` 独立布尔表达 CF/ESA 代理 | 解掉一字段三义（panel P0-6） |
| 分页 | `page`（1 起）/ `pageSize`（默认 20，上限 100）/ `total` / `list` | 三套口径收敛为一套 |

## 4. 阶段与验收

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| **P0（已完成）** | API 子模块、三态门禁、大小写绕过修复、删除被遮蔽的 securityPolicy 路由 | server tsc 0 错；vitest 全绿；冒烟：`/api/init/status` 200、`/api/users` 503 needsInit、`/API/users` 503、`/api/rdap` 200 |
| **P1（已完成）** | API 语义：`proxied` 拆分、`sendError` 状态码、令牌权限归一化、分页统一 | 契约测试覆盖；`docs/api.md` 同步 |
| **P2（已完成）** | 隐性问题：panel 报告 P0 全部 + P1 安全类 | 每条附回归用例或断言 |
| **P3（已完成）** | 前端地基：tokens、`ui/` 原语、app shell、auth、api client、登录页 | `tsc -b` + build 通过；登录可用；明暗主题切换 |
| **P4（已完成）** | 前端页面迁移：29 个页面/区块全部迁至 `features/`，旧 `pages/` 删除 | 每页迁移即删旧文件；主包 619 kB → 219 kB |
| **P5（已完成）** | 收口：删除 TDesign/i18next/axios 与旧 contexts/api/i18n、文档对齐、lint 清零、覆盖率可用 | 旧栈零残留；`grep -r tdesign client/src` 为空；eslint 0 problem |

## 5. 门禁（每轮必跑）

```bash
cd server && npx tsc --noEmit && npx vitest run
# client 的 tsconfig 是 solution 式（files: [] + references），
# `tsc --noEmit` 在这类工程下**不检查任何文件且退出码为 0**（第三轮评审 P0-2 实测）。
# 必须用 `tsc -b`（等价于 package.json 的 build 前半段）才能真正类型检查。
cd client && npx tsc -b && npx vitest run && npx vite build
```

外加：改动涉及 API 语义时同步 `docs/api.md`；涉及路由/模块时同步 `root.ai.md` §路由；每阶段结束跑一次「代码审核团」子代理评审（至少 2 条线：契约一致性、隐性问题复发）。

## 6. 进度台账

| 日期 | 内容 | 状态 |
| --- | --- | --- |
| 2026-10-23 | 建立 `server/src/api/`（types/registry/init-gate/mount/index + modules/logs），app.ts 由 944 行降至 771 行；删除被遮蔽的 `routes/securityPolicy.ts`；门禁改三态 + 大小写不敏感；新增 10 条单测 | 完成 |
| 2026-10-23 | 前端地基：Tailwind 语义 token（`ui/tokens.css` + `tailwind.config.js` 扩展）、`ui/` 原语（Button/Input/Card/Badge/Label/cn）、运行时依赖落地（Radix/CVA/RHF/zod/tailwind-merge），client 构建与 79 条用例通过 | 完成 |
| 2026-10-24 | **第六轮复测确认**：pentest 复核 6-1/6-2/6-3/CSV 四项全部 PASS，「可以上线」；据此补管理员级 `allowPrivate` 开关（默认只允许公网、元数据地址永远拒绝、MCP 不可开启），恢复自建内网 DNS 的故障转移能力。server 75/606 全绿 | 完成 |
| 2026-10-24 | **极端审核第六轮**：结构收尾+性能实测（分组 QPS 4.6x→1.15x、OAuth 闭环 PASS），注入面补测发现 failover userinfo 注入 SSRF、MCP 服务监控跨租户；执行层修 6-1/6-2/6-3 + CSV 多行公式 + 域名创建回滚 + 全部限流器 JSON 化。server 75/606 全绿 | 完成 |
| 2026-10-24 | **多轮评审直到通过**：第一轮 4 位评审出 P0×1/P1×6；修复后第二轮 3 位 PASS、design 因「非 failover 仍落 domain_id」判不通过；补提交 274f3780 后 design 复核通过。四位评审一致判定可合入。server 75/608、client 41/161 全绿 | 完成 |
| 2026-10-24 | **代码审核团评审（C 端批次）**：4 位评审对 `fd855871..HEAD` 出 P0×1/P1×6/P2×16；执行层修 PUT 监控跨租户写、续期新增账号归属、WS 连接上限与索引、监控 enabled/config 回填、审计列宽、卡片内距、搜索防抖、LIKE 转义、config 类型校验；be/fe-arch 复核 4/4 PASS 并判定可合入。server 75/606、client 41/161 全绿 | 完成 |
| 2026-10-24 | **极端审核第五轮**：E2E 复验（45 步管理员 + 5 步只读）+ 稳定性回归（FAIL 1/PARTIAL 2）；执行层修授权码首兑（第四轮改法未闭环）、SRV 无法新建、实时 WS 代理、遗留标记误判、限流 429 HTML、MCP 拒绝分支、令牌审计。server 74/604、client 40/158 全绿 | 完成 |
| 2026-10-24 | **极端审核第四轮**：对抗审核回归 5 FAIL（P0×3/P1×2）；执行层修授权码影响行数（授权码全失效）、MCP 8 个 domainId 工具跨租户写、CORS 同源 500、账号锁键不一致，并加分组缓存进程内解析层（消除 1.3MB 重复 parse）。server 73/603、client 39/156 全绿 | 完成 |
| 2026-10-24 | **极端审核第二轮（回归 + 新角度）**：两位审核员复测 10 项修复（9 PASS / 1 FAIL、3 PARTIAL），新增 P1×5/P2×10；执行层据反馈修掉 SSRF 守卫误杀与漏面（endpoint/ssl/重定向三处）、password-strength CPU 阻塞（限长 72 + 节流）、WHOIS 队列饿死（每轮 200）、分组缓存惊群（未命中不再 bump、定时刷新改清空重建）。server 70/593、client 39/156 全绿 | 完成 |
| 2026-10-23 | **审核团极端业务测试 + E2E 走查**：对抗测试（P0=0/P1=7/P2=7）与真实前后端走查（P0=1/P1=4/P2=7）各出报告；执行层修复全部 6 条 P1（令牌越权读、/whois 遮蔽、分组 IDN 口径、domain_type 顶域判定、域名/记录输入校验、NFC 归一化）+ E2E 的 P0（MX 拼值）与 3 条 P1（系统字段、实时代理、提供商文案、新库误判已初始化、虚拟站点自动建站）。server 69/588、client 39/156 全绿 | 完成 |
| 2026-10-23 | **PSL 内嵌 + IDN 适配 + 双响应契约**：①内嵌 `server/src/data/public-suffix-list.dat`（publicsuffix.org DAT，MPL-2.0 声明）作为首次播种/离线兜底；②PSL 的 Unicode 后缀解析时转 Punycode，`例子.公司.cn` 等 IDN 域名可正确归组；③抽出 `resolveDomainListShape()` 并单测，UI（分页对象/Unicode/can_write）与 API（裸数组/Punycode/display_name）两套契约显式分离；④DDNS-Go 兼容结论：不抛弃，写明弃用前提。server 67/579、client 37/148 全绿 | 完成 |
| 2026-10-23 | **父域未添加提示 + 公共后缀入库**：①组头透出 `parentPresent`，前端显示「父域未添加」警示徽标；②新增 `public_suffixes` 表与 BAL、`service/public-suffix.ts`（内存快照 + PSL 通配 + 解析）、`publicSuffixJob`（启动载入 + 每 7 天从 `PUBLIC_SUFFIX_LIST_URL` 下拉，失败不入库）；③`getRootDomain` 改读动态集合。server 66/572、client 37/148 全绿 | 完成 |
| 2026-10-23 | **虚拟分组支持无条件造组**：`groupDomains` 增 `virtualRoots`（父域未添加也成组，组头 id = 组名哈希偏移）；`GET /domains` 新增 `virtual_groups` 参数；前端加「分组方式」开关（总是分组/仅父域存在，localStorage 记忆，默认总是分组）。server 566、client 148 全绿 | 完成 |
| 2026-10-23 | **域名虚拟分组 + 权限可见性**：①公共后缀表（cc.cd/dpdns.org/us.kg… 按最长匹配）替代「取最后两段」，`groupDomains` 改按可注册域聚合；②`grouped=true` 返回虚拟组头 `_type='group_header'`/`_groupParentId`，前端默认分组、组头可折叠；③`GET /domains`、`/domains/:id` 透出 `can_write`，前端隐藏写按钮并显示「只读」；④非管理员隐藏「新增账户/新增域名」。server 65/564、client 37/147 全绿 | 完成 |
| 2026-10-23 | **前端可接触接口核验（root.ai.md §外部应用集成 API）**：脚本比对 **218 条后端路由 vs 151 个前端调用点，未匹配 0**；修 3 处真实接口缺陷——①`useTriggerMetas` 请求不存在的 `triggers` 源（改 `triggerTypes` 并去重查询）②后端 `triggerTypes` 缺 `params`（补 recordTypes/statuses/withinDays，前端加 `multiselect`）③MCP 页面非管理员仍请求 `adminOnly` 的 `/mcp/config`（`enabled: canManage`）。报告 `ai-censorship/deepseek-v4.1-flash_review-20261023-fe-api-audit.md` | 完成 |
| 2026-10-23 | **P2/P3 全量闭合**：后端 7 条（批量归一化 / 分页口径 / allowedDomains 语义 / provider 日志 / 列表日志降级 / 分层与未用导入 / 文档漂移）+ 前端 3 条（`ui/alert` 统一 27 文件 / 目录结构文档 / 背景图构建开关）+ P3 三条（mcp-config 按端点豁免 + 协议形状断言、批量上限纯函数边界用例）。server 64/554、client 37/146 全绿 | 完成 |
| 2026-10-23 | **前端 P2 第一批**：`rsaEncrypt` 走 `lib/http`（P1）、`expectData/expectDataList` 收敛 3 份 `unwrap`、超时统一抛 `ApiError`、`--input/--border` 提到 ≥3:1、加 skip-link、日期/数字格式化统一、移除 `punycode.js`、删 `vite.config.ts` 死 manualChunks、`resource:snapshot` 无消费方时跳过采集 | 完成 |
| 2026-10-23 | **响应契约第三批（按复核 R1/R2/R3）**：契约测试改为「`res.status(N).json` 块内缺 `code` 或 `msg` 即失败」，扫描加入 `api/`，协议端点（mcp-oauth/mcp-config/rdap）显式 allowlist；据此捞出并修掉 `ns-monitor` 13 处 `{success:false,error}`、`providers` 2 处 `{error}`；批量接口补 `MAX_BATCH_RECORDS=100` + 422 并同步 docs/api.md；删除未挂载死路由 `routes/emailTemplates.ts`；`root.ai.md` 门禁改子 shell。server 64 文件 / 551 条全绿 | 完成 |
| 2026-10-23 | **响应契约第二批**：`routes/security.ts` **27 处**旧式 `code: 1` 配 4xx/5xx 全部改 `sendError`（成功缺 `data` 的改 `sendSuccess`）；契约测试新增**解析式扫描** `res.status(N).json` 块内 `code` 必须等于 N（此前只拦 `code:-1`，漏掉这一整类）。全仓 status/code 不一致计数 27 → 0 | 完成 |
| 2026-10-23 | **腐化用例处置（删除 + 补回意图）**：新建 `tests/helpers/test-db.ts`（临时 sqlite + `initializeDSM()` 建表 + 清理）验证可行性；修补 `domain-filter` 时暴露 schema 漂移（`users.password` → `password_hash`），移植成本高、价值低 → **删除 4 个不可运行用例**，补 `tests/db-bootstrap.test.ts`（建表 + 关键列）与 `src/utils/domain-classify.test.ts`（顶域/子域），并顺带修复 `normalizeDomain` 不处理末尾 FQDN 点的缺陷；`vitest.config.ts` 的 `exclude` 清空至仅剩基础设施项。server 63 文件 / 549 条全绿 | 完成 |
| 2026-10-23 | **收尾清理第一批（响应契约 + 日志卫生 + 门禁 + 腐化用例评估）**：①errorHandler 5 处分支与 auth/validate/webauthn 共 12 处 `code:-1` 全部改走 `sendError`（`code === HTTP`）；契约守护测试扩展为扫描 `routes/ + middleware/` 并直测 errorHandler 三种异常；②OAuth 三处 debug 日志去敏（body/payload/header 只留键名与布尔摘要）；③`root.ai.md` 补服务端门禁命令 + 说明 `*.test.node.ts` 与 4 个已知腐化用例；④四个被排除用例实跑评估（2 条导入失效、2 条 `no such table`，`initSchema()` 不建表 → 非小修可救），结论与 A/B/C 方案写入 `docs/refactor/02-CLEANUP.md`。server 544 条全绿 | 完成 |
| 2026-10-23 | **按 root.ai.md §代码审核团 发起双团核验**：前端架构团（P0=0 / P1=1 / P2=11，四门禁实测全绿）与后端约束团（P0=0 / P1=4 / P2=8，四项门禁实测全绿）各出报告；执行层对 5 条关键指控逐条核对源码（rsaEncrypt 绕过 http、vite 死配置、auth 中间件 code:-1、OAuth 敏感值进 debug 日志、批量无上限）——**全部属实**，另记录独立复核结论与建议处置顺序：`ai-censorship/{...-fe-arch, ...-be-constraints, ...-verification}.md` | 完成 |
| 2026-10-23 | **Logo 收敛为「H + 中心胶囊」**：负责人反馈 Record-Row 过于花哨、缺中心；改为只有两个元素——H 竖线 + 正中一枚横向胶囊（被解析出的记录），大尺寸是清晰焦点、16px 与竖线自然并成加粗 H。另出「H+点 / 胶囊横杠 / H 单字母 / 圆环+点」四版中心感对比图 `evidence/logo-center.png` 供选择 | 完成 |
| 2026-10-23 | **Logo 交由视觉评审出方案并定稿为 Record-Row**：评审给出 4 个候选（Record-Row / Zone-Bracket / H-Point / Stack）与 9 档尺寸实测，推荐 Record-Row——「空心块=名字、竖线=分隔、实心块=地址」，不需要图例即可读，16px 仍保三段结构；已替换 `ui/logo.tsx`（子元素各自声明 stroke/fill）、`public/logo.svg`、badge 缩放 0.58→0.66。证据：`evidence/{logo-candidates.png,logo-v11-logo,login-v11-logo}.png`，方案 `logo-candidates.md` | 完成 |
| 2026-10-23 | **Logo 定稿为「H + 右向箭头」**：菱形版抽象、不直白，改成两根竖线（H）+ 横穿而出的箭头（解析/指向），起于左竖线、止于右竖线内侧，16px 仍可辨方向；同步更新 `ui/logo.tsx`、`public/logo.svg` 与 favicon。另存三版对比图 `evidence/logo-compare.png` 供选择 | 完成 |
| 2026-10-23 | **控制台背景提感 + 新 Logo**：控制台蒙层 0.88→0.80（深 0.91→0.86）、内容区薄纱 0.55→0.35，图在留白处可见但正文仍由实色卡片兜底；新增极简标识 `ui/logo.tsx`（`LogoMark`/`LogoBadge`：H + 断开横线 + 菱形节点，currentColor + 2px 圆头描边，16px 可辨），落地为 `public/logo.svg` 与 `index.html` 的 svg favicon（保留 ico 回退），替换壳层/登录页/落地页原有 ShieldCheck/Globe2 图标块。证据：`evidence/{dash-v9-light,dash-v9-dark,login-v9-light,logo-v3}.png` | 完成 |
| 2026-10-23 | **视觉二次修**（按评审员复评）：面板 α 改实色（1 / 0.98）——半透明面板叠图会让卡片与背景对比度掉到 1.0、同页两卡颜色不一；内容区加 `.surface-page` 薄纱（55%）保证页面标题压在图上 ≥4.5:1；登录页左栏白纱 55%→12%（此前双层蒙层叠加到 87%，图几乎不可见）；落地页统一中轴 984、hero 去列间距（608+376 不再溢出）、标题 68→42px；中文标题去掉负字距。证据：`evidence/{dash-v8-light,dash-v8-dark,login-v8-light,landing-v8}.png`；评审报告 `design-review-2.md` | 完成 |
| 2026-10-23 | **剔除 Cloudflare 隧道功能**：删除 `client/src/features/tunnels`（api/page/test）、后端 `routes/tunnels.ts` 与其事件测试、`/api/tunnels` 模块注册、云适配器的 4 个 tunnel 方法、令牌作用域 `tunnels.read/write`、侧栏导航项、实时映射两条事件；文档 `root.ai.md` 与 `docs/api.md` 同步移除。server 541 条、client 146 条全绿 | 完成 |
| 2026-10-23 | **视觉重构（黄金比例 + 背景图 + 登录图标）**：新增 φ 阶梯 tokens（间距 5/6/8/10/13/16/21/27/34/43/55/70、侧栏 232/89、顶栏 55、内容宽 984/1252/1592、认证卡 376）与语义字号（micro/caption/title/heading/hero）；修正对比度（主色 48%→35%、muted 47%→40%、深色卡片 11%→14%）；删除 `zoom:0.9` 与 body 中失效的 `--td-*` 规则；恢复默认背景图 `t.alcy.cc/moez`（body 双层 background + 蒙层，控制台 `data-surface=console` 加强为底纹，设置页支持自定义/关闭/预览并做 URL 协议白名单防 CSS 注入）；登录页改 61.8/38.2 分栏、表单区实色，第三方入口统一 outline + 图标（Logto→LogIn、OIDC→Network、通行密钥→Fingerprint），2FA/重置按钮补 Smartphone/Mail；落地页 hero 锁 `61.8dvh` 并 608:376 分栏放图。证据：`evidence/{login-v4,dash-v6,dash-v7,landing-v3}.png` | 完成 |
| 2026-10-23 | **文档自检纳入门禁**：新增 `server/src/__tests__/docs-consistency.test.ts`，把 `root.ai.md` 里出现的 **全部 `server/src/**/*.ts` 路径**逐个 `existsSync`（P1-5 那 6 个失效引用就是靠人工发现才修的），并断言文档不再出现 `speakeasy` / `client/src/pages/` / `client/src/i18n/` / `tdesign` 等已废弃字样。server 544 条全绿 | 完成 |
| 2026-10-23 | **第四轮终审 P1/P2 落地**：①错误码契约——tunnels 6 处 `code:-1`（→ `sendError` 502）、auth 2 处（空更新→`sendSuccess`、User not found→404），并新增 `routes/__tests__/error-contract.test.ts` 扫描全路由禁止 `code: -1`；②`root.ai.md` 修 6 个失效 service 引用、TOTP `speakeasy`→`otplib`、邮件模板前缀、补 `/api/auth/webauthn` 与 `/api/resource-monitor` 与审计导出；③`docs/api.md` 分页默认 50→20、`pinned_domains` 语义改为「ID 列表排序」；④删除死代码 `styles/theme.ts`、根目录两个失效 i18n 脚本、Toast 链路（容器零生产者，页面本就用内联提示）；⑤移除未用依赖 `@radix-ui/react-tabs/tooltip`；⑥审计 `keyword` 死参数删除；⑦`<html lang>` 改 zh-CN；⑧主题选择同步写入服务端偏好。新增 api 层契约用例 5 条（NS 信封 / 批量 results），补上"组件用例把 api 整体 mock"的盲区 | 完成 |
| 2026-10-23 | **第四轮终审 P0 三条全修**：①NS 监控全域不可用——`routes/ns-monitor.ts` 11 处 `{success:true}` 无 `code`，而 `lib/http.ts` 必抛错（`unwrapNs` 在 `await` 之后永不执行）→ 全部改用 `sendSuccess`；②批量导入必崩——后端返回 `{addedIds}`、前端读 `results` 且**记录已写入**（诱发重复导入）→ 后端改为逐条 `results[]`（line/ok/recordId/error）并统一 200 信封，前端把失败行映射回用户原始行号；③覆盖率门禁崩溃 + `coverage.include` 指向已删目录 → `@vitest/coverage-v8` 对齐到 2.1.9，`coverage.include` 改为 `src/**` 并排除测试/类型，新增 `testTimeout: 15s` 消除偶发超时。实跑：client 36 文件 144 条全绿、覆盖率 74.36% | 完成 |
| 2026-10-23 | **修一处跨仓库断链**：`server/src/workflow/__tests__/i18n-keys.test.ts` 仍在扫描已删除的 `client/src/i18n/locales`，导致服务端 541 条里挂 1 条。守护目标改为「客户端的 `workflow-labels.ts` 覆盖服务端下发的全部文案键」，并补齐 10 个缺失的参数文案（EdgeOne / 虚拟源站组）。server 60 文件 541 条、client 35 文件 142 条全绿 | 完成 |
| 2026-10-23 | **工作流可视化动作构建器补回（登记缺口清零）**：新增 `action-builder.tsx`（动作卡片增删/排序、按 meta.params 渲染 text/number/boolean/select、级联下拉缺依赖时禁用、suggestSource 用 datalist、validation 行内预警）、`condition-editor.tsx`（可视化条件 ↔ JSON 双向，JSON 为唯一真相）、`workflow-dsl.ts`（纯转换层，认不出的节点挂 raw 逐字回写）、`use-workflow-meta.ts`、`workflow-labels.ts`（后端 i18n 键 → 中文）。DSL 仍是唯一真相，全模块零 useEffect。新增 22 条用例（工作流共 26 条）。**限制**：后端无 `meta/triggers` 源，触发器可视化分支线上回退 JSON | 完成 |
| 2026-10-23 | **域名列表与用户页补齐 review-2 P1-6**：域名页增加 WHOIS 状态徽标、行内备注编辑、置顶（本地偏好 + `pinned_domains` 参数）；用户页增加「本人」徽标与「二次验证」入口（GET/PUT `/security/users/:id/require-2fa`，全局强制时禁用并说明）。新增 4 条用例 | 完成 |
| 2026-10-23 | **lint 清零**：剩余 14 处 `set-state-in-effect` 全部消除（3 个对话框改「按需挂载 + key + 惰性初始化」、外壳移动端抽屉改「按打开时的路由」派生、安全策略卡改派生 override、2FA 初始化改挂载期一次性请求、工作流触发器默认值改派生、手动运行表单按域名归属状态），并把该规则由 warn **收紧为 error**；`react-refresh` 用 `allowExportNames` 精确放行 Provider+hook 同文件导出；`no-control-regex` 按文件豁免并注明是有意匹配控制字符。`npx eslint .` 退出 0、0 problem；tsc -b 0 错、vitest 116 条全绿 | 完成 |
| 2026-10-23 | **第三轮评审 P1 最后一条（写接口信封覆盖）**：`lib/http` 新增 `postOk/putOk/patchOk/deleteOk`，把 `code !== 0` 抛错内建进写操作，23 个 api 模块 57 处写调用一次切换；登录（-2 两步验证）、找回密码、OAuth 跳转、安装向导、工作流 test/run 因需自判 code 或返回裸结果体保留原始方法，并在 `write-envelope.test.ts` 里以 allowlist 显式登记。新增用例用 AST 级扫描守住该约定（新增 api 忘记校验即失败） | 完成 |
| 2026-10-23 | **第三轮评审 P1 前四条**：①主题收敛为 `lib/theme.tsx` 的 `ThemeProvider` 唯一来源（此前 app-shell/settings/landing 各持一份 useState），并包裹整个应用使 `/login`、`/setup`、`/oauth/*` 也应用已存主题；`index.html` 增加内联脚本，首屏前消除深色白闪。②登录页支持 `return_to`（`resolveReturnTo` 只接受站内相对路径，防外跳），修掉 MCP 同意页 return_to 死链。③`/dash/mcp` 全局开关按管理员收敛（非管理员禁用并提示只读）。④realtime 映射补齐 `ns_monitor_prefs_updated`、`2fa_enabled/disabled`，并对记录/域名事件追加 `['domain']` 前缀失效。另补 `app/__tests__/guards.test.tsx` 4 条（未登录/普通用户/管理员/校验中）与 `root.ai.md` §客户端架构整章重写。tsc -b 0 错、vitest 114 条全绿 | 完成 |
| 2026-10-23 | **第三轮评审 P0 全部修复**：①门禁空转——`client/tsconfig.json` 是 solution 式，`tsc --noEmit` 不检查任何文件却退出 0；改用 `tsc -b`（新增 `typecheck` 脚本，台账门禁命令同步修正），暴露出 10 条真实类型错误并全部修掉；②`http.patch` 从未实现（令牌启停/续期开关点击即崩）→ 补齐 patch 与 timeoutMs；③MCP 同意页对裸 JSON 端点误用信封校验 → 新增 `requestRaw` 专用通路；④补 `src/lib/__tests__/http.test.ts`（5 条契约测试，不再把被测函数自身 mock）。tsc -b 0 错、vitest 110 条全绿、eslint 0 error / 18 warning | 完成 |
| 2026-10-23 | P5 lint 阶段一：6 个「表单回填」effect 改成**派生状态**（`override ?? remote`），消除级联渲染且不丢失编辑中的输入：system 的 security-tab(4 处)/access-tab(2)/network-tab/workflow-tab、settings 的资料卡与偏好卡；`set-state-in-effect` 由 27 降为 22 | 完成 |
| 2026-10-23 | P5 包体与 lint 口径：App 路由改回**路由级懒加载**（落地页/登录页保持同步），主包 **619 kB → 218 kB（gzip 169 → 68.5 kB）**，产物 38 个 chunk；eslint 将 `src/ui/**` 的 fast-refresh 规则按目录豁免（shadcn 风格导出 variants 属常规写法，须放在配置末位才生效）；余 31 warning（27 个 set-state-in-effect 待批量改派生状态） | 完成 |
| 2026-10-23 | **P5 依赖收口**：删除 tdesign-react / tdesign-icons-react / i18next / react-i18next / axios 五个依赖；删除 `contexts/{Auth,I18n,Theme,UiScale}Context`、`i18n/`（含 12 个语言包与覆盖率用例）、`components/` 下 10 个旧组件与 `components/workflows/*`、`hooks/` 下 7 个旧 hook、`utils/` 下 6 个旧工具、整个 `src/api/` 旧封装；ToastContainer 用 ui 重写（原依赖 TDesign Alert/CloseIcon）。`@typescript-eslint/no-unused-vars` 收紧为 error。client 105 条用例、build 通过（主包 619 kB / gzip 169 kB），eslint 0 error / 39 warning | 完成 |
| 2026-10-23 | **旧 `client/src/pages/` 目录整体删除**：MCP 授权同意页原生重写（逐模块展示真实 scope、客户端与回调地址、同意/拒绝均回调客户端、未登录先引导登录并保留 return_to），删除死代码 `MailSetupModal`(231)、`ResourcePanel`(279) 与 `Login.css`(656)。至此所有路由页面都跑在 `features/` 新栈上，client 167 条用例全绿 | 完成 |
| 2026-10-23 | 安装向导与 OAuth 回调迁移：SetupPage（三步：数据库 → 管理员 → 完成，SQLite/MySQL/PG 切换、测试连接、已有数据时提示「重置并初始化」风险、管理员表单本地校验、已完成安装自动跳登录）与 OAuthCallbackPage（缺参/error 参数直接报错、**同一 code+state 只兑换一次**、按 mode 落地设置页或控制台）；删除旧 Setup(502)、OAuthCallback(216)。另修正 i18n 覆盖率用例中「静态 key 数 > 100」的脆弱阈值（迁移使该数自然下降） | 完成 |
| 2026-10-23 | MCP 管理页原生重写：全局开关、**API 密钥**（脱敏列表/新建后一次性明文+复制/撤销/恢复/删除）、**OAuth 客户端**（新建返回一次性 secret、按模块的 scope 编辑、权限摘要、删除）；删除旧 McpManagement 页（1330 行）；client 154 条用例全绿 | 完成 |
| 2026-10-23 | 工作流页原生重写：列表（触发器、动作徽标、启停、损坏行只删）、新建/编辑（名称/触发器下拉取自 meta/触发器配置 JSON/条件 JSON/动作 DSL 数组，保存前做结构与 JSON 校验）、运行记录、手动运行、配置检查；删除旧 Workflows 页（970 行）与其旧测试。**已知缺口**：旧页的「可视化动作构建器」（按 meta 逐参数渲染、候选下拉、条件行编辑器）未迁移，改为 DSL 编辑；已在台账登记，后续轮次补回 | 完成 |
| 2026-10-23 | 公共页迁移：**关于页**（版本/部署模式/Node、最新 Release、社区与文档链接、技术栈、GitHub 贡献者，GitHub 失败时降级展示）与**落地页**（hero + 6 项能力 + CTA + 页脚，单页无外部依赖）；删除旧 About(283)、Landing(328)+Landing.css(656)；client 160 条用例全绿 | 完成 |
| 2026-10-23 | review-2 P1-6/P1-8/P2 局部收口：OAuth 绑定行字段改为后端真实字段 `email`（此前用外部字段名，绑定邮箱列恒空）；改邮箱增加本地校验（非空/格式/需验证码），并把「保存资料」按钮从"缺验证码就禁用"改为可点击后给出明确原因 | 完成 |
| 2026-10-23 | 实时刷新（review-2 P1-7）：新增 `app/realtime.tsx` 单连接 WebSocket + 事件→queryKey 映射表（token/team/user/domain/record/account/audit/service-monitor/ns-monitor/tunnel/system 共 30+ 事件），指数退避重连；仅在登录区挂载（避免未登录握手失败导致重连风暴）；头部增加实时状态指示（已连接/连接中/已断开）。替代旧「每页各开一条 WS」的 useRealtimeData。client 156 条用例全绿 | 完成 |
| 2026-10-23 | 服务监控 tab 原生重写：三类监控（SSL 证书 / 端点探测 / DNS 故障转移）分标签、状态徽标（正常/异常/不可用/未检测）、证书剩余天数、响应时间、检测周期、检测/编辑/删除；编辑器按类型渲染字段（端口/告警天数、协议/路径/跟随重定向、记录名/TTL/主备值/自动切回）；删除旧 ServiceMonitorTab（746 行），`pages/domains` 目录清空。**已知缺口**：故障转移与端点监控的「绑定子监控」UI 未迁移（后端 children 接口仍在），已登记 | 完成 |
| 2026-10-23 | 审核团第二轮（review-2）修复第一批——**P0-1 SMTP 字段名**（user/pass/from → username/password/fromEmail/fromName，补 secure 与显示名）；**P0-2 域名新增入口**（AddDomainDialog：账户 → provider-list → 多选托管）；**P1-3 写接口不判信封**（http.ensureOk，系统 8 个写接口统一）；**P1-4 团队可操作闸门**（canManageTeam：超管/团队 admin/创建者，其余只读并显示「只读」）；**P1-5 审计搜索语义**（后端无 keyword，搜索框改为「按域名搜索」） | 完成 |
| 2026-10-23 | NS 监控 tab 原生重写：列表（搜索/分页）、状态徽标（正常/不一致/缺失）、告警次数与最近检测、启用开关、检测（展示当前 NS）、新增/编辑（域名选择、期望 NS 自动填充、告警开关）、删除；删除旧 NSMonitorTab（709 行）；client 145 条用例全绿 | 完成 |
| 2026-10-23 | 域名续期 tab 原生重写：列表（搜索/账户/状态筛选、分页）、剩余天数与到期高亮、自动续期开关、手动续期、移除、从提供商导入（账户 → 域名多选，逐条结果）；删除旧 DomainRenewalTab（557 行）；client 141 条用例全绿 | 完成 |
| 2026-10-23 | 用户管理页原生重写：列表（搜索/角色徽标/状态/创建时间）、新建与编辑对话框、启停、删除；**按服务端口径收敛可操作范围**（超管不可改、同级或更高角色不可被更低角色修改、可分配角色按调用者等级收窄）；删除旧 Users 页（476 行）；client 137 条用例全绿 | 完成 |
| 2026-10-23 | 域名域收口 + 隧道页：删除旧 `pages/Domains` 与 `DomainListTab`（853 行，已被新域名页替代），新增 `DomainMonitoringPage` 子页外壳（列表/服务监控/NS 监控/续期，三个监控 tab 暂挂旧组件）；隧道页原生重写（列表/状态/账户/删除二次确认），删除 `pages/Tunnels` 与 `components/TunnelList`；client 133 条用例全绿 | 完成 |
| 2026-10-23 | 系统剩余三个 tab 原生重写：网络（连通性测试 + 代理 SOCKS5/HTTP 配置）、通知（渠道列表/新增/编辑/启停/删除，按类型渲染字段）、工作流（出站白名单 chips + 纯主机名校验 + 空白名单语义提示）；删除 `pages/system` 整个目录与 `components/NotificationChannels`，**旧系统页彻底清空**；client 130 条用例全绿（新增 4 条） | 完成 |
| 2026-10-23 | 系统「访问」tab 原生重写：JWT 密钥查看（密码校验 + 默认打码 + 复制）、通用 OIDC 配置（Issuer/端点/字段映射 + **OIDC 自动发现**填充）、Logto 专用配置；删除旧 417 行 AccessTab。安全 tab 的「OAuth 未迁移」提示改为指向本页；client 130 条用例全绿 | 完成 |
| 2026-10-23 | 系统「安全」tab 原生重写：登录限制（阈值/锁定时长 + 失败统计 + 应急解锁）、SMTP（含测试发送）、安全与敏感信息（凭据明文开关/JWT 邮件通知/到期提醒天数）、审计规则（阈值与非工作时段）、MCP 全局开关；删除旧 675 行 SecurityTab。**已知缺口**：OAuth/OIDC 配置暂未迁移，页内已注明；client 127 条用例全绿 | 完成 |
| 2026-10-23 | 团队补「成员角色变更」下拉（PUT /teams/:id/members/:userId）；系统页迁移：新标签页外壳 + 概述/数据库两页原生实现，安全/访问/网络/通知/工作流 5 个 tab 暂以旧组件挂载（下一轮逐个替换）；删除旧 System 壳；client 124 条用例全绿 | 完成 |
| 2026-10-23 | 团队页迁移：团队列表与增删改、成员（添加/移除）、团队域名权限（新增/移除，支持子域与读写级别）、成员个人权限（查看/新增/移除）；删除旧 Teams 页（630 行）。**已知缺口**：成员角色变更（`PUT /teams/:id/members/:userId`）尚未提供入口，待补；client 121 条用例全绿 | 完成 |
| 2026-10-23 | 审计页迁移：筛选（关键词/操作/起止日期）、分页、CSV/JSON 导出（带筛选条件）、中文动作标签与详情摘要（未登记动作原样展示）；删除旧 Audit 页与 AuditLogList 组件。**同时**用 `app/require-admin.tsx`（新会话源）替换旧 `AdminRoute`——旧守卫依赖旧 AuthContext，导致 /dash/audit 被误判非管理员并重定向（截图验证发现）；client 117 条用例全绿 | 完成 |
| 2026-10-23 | 设置页迁移：个人资料（昵称/邮箱 + 邮箱验证码）、修改密码（RSA 加密提交）、偏好（主题与站内/邮件通知、头像与背景图）、账号绑定（列出/解绑/绑定跳转）；删除旧 Settings 页（472 行）。**弃用**旧页的「显示缩放」控件（新壳固定视觉比例，UiScale 仅作为兼容变量保留）与「隧道」快捷卡片（侧边栏已有入口）；client 114 条用例全绿 | 完成 |
| 2026-10-23 | 安全页迁移：两步验证（TOTP 二维码/密钥/备用码/启用/停用）、可信设备（单删/全删）、**通行密钥管理（注册 + 删除）**、安全策略表单（管理员，7 个字段 + 两个开关）；删除旧 Security 页（536 行）。旧页的「会话管理」调用的是服务端不存在的 `/api/security/sessions`（死接口），新页不再展示并在评审记录中说明；client 111 条用例全绿 | 完成 |
| 2026-10-23 | API 令牌页迁移：列表（域名数/服务标签/角色上限/有效期/最近使用/启停/删除）、新建对话框（域名复选+搜索、服务预设与自定义、角色上限按当前用户封顶、生效/失效时间）、**明文令牌仅展示一次**并支持复制；删除旧 Tokens 页（530 行）；client 107 条用例全绿 | 完成 |
| 2026-10-23 | 审核团前端评审闭环：**P0** 恢复通行密钥登录与 SSO 入口（含回归用例）；**P1** 新壳挂载 ToastContainer、记录页落地 `proxied` 代理开关与列表代理徽标、会话单飞缓存 + 5xx 不再误判未登录 + isAdmin 口径对齐、主题存储键与旧 ThemeContext 统一；**P2** 抽 `ui/Pagination`/`ui/ConfirmDialog` 并解除 barrel 循环、记录删除联动刷新域名与仪表盘、批量导入部分成功即刷新、导航审计项加 adminOnly、对话框改用稳定数组引用 | 完成 |
| 2026-10-23 | 记录页补批量导入（逐行解析「主机记录 类型 记录值 [TTL] [备注]」、引号保留空格、逐条结果反馈）；DNS 账户页迁移（列表/搜索/提供商筛选、新建与编辑对话框按 `configFields` 动态渲染、凭据「***」语义、删除二次确认），删除旧 Accounts 页；client 98 条用例全绿、账户页与对话框截图核对 | 完成 |
| 2026-10-23 | DNS 记录页：`features/records`（列表/搜索/类型·线路·状态筛选/分页、新建与编辑对话框（按 `DNS_RECORD_DEFS` 动态渲染 MX 优先级、SRV 优先级/权重/端口）、启停、删除二次确认、导出 Zone）；`/dash/domains/:id/records` 切到新页，删除旧 Records 页与 RecordForm（约 1200 行）；client 94 条用例全绿、明暗与对话框截图核对。**已知缺口：批量导入尚未迁移**，下轮补 | 完成 |
| 2026-10-23 | API 语义收敛：`sendError` 默认状态码 200→400 且 `code` 与 HTTP 一致（403/404/409 批量修正 14 处）、记录列表分页统一为默认 20/上限 100、记录数与缓存只回写非空结果、令牌创建支持 `allowed_services`/`max_role`（策略抽到 `service/token-policy.ts`，6 条单测）；服务端 60 文件 / 541 用例全绿 | 完成 |
| 2026-10-23 | 域名列表页：`features/domains`（列表/搜索防抖/账户与状态筛选/分页/启用停用/删除二次确认）、新增 `ui/` 的 Select/Dialog/Table 原语、`lib/format.ts` 统一日期与相对时间（仪表盘同步复用）；`/dash/domains` 切到新页；client 90 条用例全绿、明暗截图核对 | 完成 |
| 2026-10-23 | 应用外壳与仪表盘：`app/nav.ts`（导航唯一来源）、`app/app-shell.tsx`（可折叠侧栏 + 顶栏 + 主题切换 + 账户菜单）、`app/protected-shell.tsx`（会话校验）、`features/session`、`features/dashboard`（统计卡/到期提醒/提供商分布/最近操作，含空态与错误态）；`/dash/*` 全部切到新外壳，删除旧 Layout/Sidebar/Header/Dashboard（约 1260 行）；client 构建通过、87 条用例全绿、明暗主题截图核对 | 完成 |
| 2026-10-23 | 首个页面切片：`lib/http.ts`（类型化 fetch + 信封 + 401 处理）、`copy/zh-CN.ts`（单一中文文案）、`features/auth`（api/hooks 内聚的登录页：账号密码 + 2FA + 找回密码），路由 `/login` 切换至新页，删除旧 `pages/Login.tsx`/`LoginCard.tsx`；client 构建通过、84 条用例全绿、明暗主题与重置流程已截图核对 | 完成 |
| 2026-10-23 | 隐性问题批修：初始化标记与数据目录同源并可回报落盘结果（P0-3）、DSM 删表默认 `never`（P0-2）、账号 `***` 掩码合并（P0-7）、线路语义收敛到 `service/record-line.ts`（`proxied` 独立 + `'0'` 归一为未指定，P0-6）、工作流不再硬编码 `'0'` 并保留原 TTL/线路（E-01）；门禁 probes 增加方法维度、注册表前缀归一化（大小写/参数名） | 完成 |
