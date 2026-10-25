# HiDNS 对抗性业务测试报告（IDN / 分组 / 权限 / 输入边界）

- 审查对象：`/workspace/HiDNS`（server + client，只读源码；未修改任何生产代码）
- 探针位置：`ai-censorship/evidence/adversarial-probe.domains.test.ts`（临时拷进 `server/src/routes/__probe__/` 运行，跑完已删）
- 说明：工作区存在**他人既有未提交改动**（`server/src/utils/domain.ts` 的 NFC 归一化补丁），本报告在「工作区状态」与「HEAD 状态」两种前提下分别标注，我没有改动该文件。

## 结论

**P0 = 0，P1 = 7，P2 = 7，待核实 = 1。**
权限线未达可上线质量：Token 域名白名单只约束写、不约束读（含整域 zone 导出），读写口径不对称。
IDN 与分组线未达可上线质量：分组视图下中文关键词搜索恒为空、`domain_type` 把中文顶域/多段后缀顶域判成子域、组头直显 `xn--`；服务器端对域名与记录名零格式校验。

## 缺陷表

| 级别 | 编号 | 置信度 | 位置 | 一句话 |
|---|---|---|---|---|
| P1 | P1-1 | 确认 | `server/src/routes/records.ts:176`、`server/src/routes/records.ts:226` | `GET /domains/:id/records` 与 `/records/export/zone` 只挂 `authMiddleware`，没有 `requireTokenDomainPermission`，白名单 Token 可读他域记录并导出整域 zone（写接口却是 403） |
| P1 | P1-2 | 确认 | `server/src/routes/domains.ts:1521`（被 `server/src/routes/domains.ts:641` 遮蔽） | 文档化的 `GET /api/domains/whois` 永远匹配到 `/:id` 而不可达；该 handler 的 `accountId` 分支（`domains.ts:1534-1544`）本身也没有归属校验，属埋着的跨账户存在性 oracle |
| P1 | P1-3 | 确认 | `server/src/routes/domains.ts:382-385` | `grouped=true` 时关键词在内存里按 Punycode 名匹配，中文关键词恒 0 条；同一关键词非分组路径能搜到（DB 侧 `normalizeDomain`） |
| P1 | P1-4 | 确认 | `server/src/routes/domains.ts:377-381`、`server/src/db/bal/query-builders/domain-query-builder.ts:243-257` | `domain_type` 用「点数 ≤ 2」判顶域，与 `getRootDomain`（PSL）口径冲突：`例子.公司.cn`、`c.dpdns.org` 这类真顶域被判成子域 |
| P1 | P1-5 | 确认 | `server/src/routes/domains.ts:672-709`（`isValidDomain` 在 `domains.ts:22` 导入但全文件无调用） | `POST /api/domains` 零格式校验：`a..b`、`-bad.com`、`bad_name!.com`、`xn--zzzz`、`example.com..` 全部 200 入库，随后分组名会算出 `.com`/`.b` |
| P1 | P1-6 | 确认 | `server/src/routes/records.ts:455-466`、`server/src/routes/records.ts:480`（`validateExtraField` 在 `records.ts:23` 导入未调用） | 记录名/TTL/MX 优先级无服务端校验：64 字符标签、`name=" "`、`ttl=-1`、`mx=99999` 全部 200 并原样发往上游 |
| P1 | P1-7 | 确认（HEAD；工作区已有未提交补丁） | `server/src/utils/domain.ts:55-66`（HEAD） | NFC/NFD 未归一化时 `café.com` 与 `cafe+U+0301` 产生两个 Punycode，同一域名可入库两次、进两个分组、绕过按名比较的白名单 |
| P2 | P2-1 | 确认 | `server/src/routes/domains.ts:413-420` + `client/src/features/domains/domains-page.tsx:266` | `group_header.groupName` 保持 Punycode 且前端原样渲染：组头显示 `xn--fsqu00a.xn--55qx5d.cn`，而组内子行是 `例子.公司.cn` |
| P2 | P2-2 | 确认 | `server/src/routes/domains.ts:470-476`、`server/src/routes/domains.ts:101-108`、`server/src/routes/records.ts:459` | 子域级写规则下 `can_write` 仍为 `true`（只看「是否有一条 write 规则」），真实写 `@`/`other` 全 403，前端按钮「点了必 403」 |
| P2 | P2-3 | 确认 | `server/src/routes/domains.ts:430`、`server/src/routes/domains.ts:446-448`、`server/src/routes/domains.ts:206` | grouped 模式 `pageSize` 不受 100/1000 上限约束（回显 100000）；`page` 越界静默夹到末页；`page=999999999999999999999` 回显 `1e+21`（`utils/http.ts:24-50` 无上限） |
| P2 | P2-4 | 确认（纯函数） | `server/src/service/whois/domain-utils.ts:79-83`、`:100-124` | 同一域名挂在两个账户时 `domainsByName` 只留第一条，另一条落进 `standalone`：UI 出现「组头 + 同名独立行」两条 `example.com` |
| P2 | P2-5 | 确认 | `server/src/routes/domains.ts:347`（`!tokenPayload` 守卫）、`domains.ts:250-256` | `Token + grouped=true` 静默降级（返回未分组数组、无组头），白名单 Token 还忽略 `pageSize`（`getByIds` 不分页），与非白名单 Token 行为不一致 |
| P2 | P2-6 | 确认 | `server/src/routes/records.ts:634-647` | 批量导入 `records:[null]` 触发 `TypeError`，返回 500 的 HTML 错误页（非 JSON 信封） |
| P2 | P2-7 | 确认 | `server/src/utils/domain.ts:182-193`、`:94-111`、`:124-135` + `server/src/utils/dns.ts:30` | 校验工具自身有坑：`isValidSubdomain` 按 UTF-16 长度判 63（63 个中文过校验，Punycode 后 69 字符）；`isValidDomain('xn--zzzzzz.com')` 为 true；`utils/dns.ts` 仍导出 naive 版 `getRootDomain`（取后两段），与 PSL 版并存 |
| 待核实 | X-1 | 中 | `server/src/routes/domains.ts:182-186`、`:407` | 虚拟组 id = `-(1000000 + hash % 900000)`，父域组头 id = `-parentId`；域名 id ≥ 1,000,000 时两者取值域重叠，前端按 id 做 key/展开会串组（未在真实大 id 数据上验证） |
## 逐条复现

### 通用脚手架

HTTP 级用例全部走同一份内存 mock 探针（无 DB、无上游、无网络）：

```bash
cd /workspace/HiDNS/server
mkdir -p src/routes/__probe__
cp ../ai-censorship/evidence/adversarial-probe.domains.test.ts src/routes/__probe__/adv.test.ts
./node_modules/.bin/vitest run src/routes/__probe__/adv.test.ts
# → 12 passed；下面的「实际输出」都是该探针 console.log 的原文
rm -rf src/routes/__probe__
```

纯函数级用例用 `tsx -e`，无需建文件。

### P1-1 Token 白名单只约束写，不约束读（含 zone 导出）

探针：令牌 `allowedDomains=[1]`，请求域名 2。

```
[P1-1] GET records → 200 | export/zone → 200 | POST record → 403
```

期望：三行都是 403（或读接口在文档里明确声明「不受令牌域名限制」）。
根因：`records.ts:176`（`router.get('/', authMiddleware, ...)`）与 `records.ts:226`（`router.get('/export/zone', authMiddleware, ...)`）没有 `requireTokenDomainPermission('domainId')`，而同文件 `:404/:438/:604/:713/:798/:874` 都挂了。对照 `middleware/auth.ts:147-194`，写路径 fail-closed，读路径完全绕过。
影响面：zone 导出是前端真实入口（`client/src/features/records/api.ts:123`），一次请求拿走该域名全部解析记录；`docs/api.md:434-435` 也把「仅 authMiddleware」写成契约，说明这是长期口径而非漏改一行。

### P1-2 文档化的 `GET /api/domains/whois` 不可达

```
[P1-2] GET /domains/whois → 400 Domain not found or no permission | GET /domains/1 → 400 Domain not found or no permission
```

期望：`/whois` 命中 `domains.ts:1521` 的 handler。实际被 `domains.ts:641` 的 `GET /:id` 抢先匹配（`id='whois'` → `Number('whois')` → `NaN` → `getDomainAccess(0)` → 400），`/:id` 内没有 `next()`。
附带风险：`domains.ts:1534-1544` 的 `accountId` 分支只做 `getByAccountIdAndName` 就返回，没有 `resolveDomainAccess`；一旦有人给 `/:id` 加 `next()` 或调整顺序，任意登录用户可用 `?accountId=N&domain=x` 做跨账户域名存在性探测。
文档侧：`docs/api.md:409-414` 明确写了该接口，实际 100% 不可用。

### P1-3 grouped 视图下中文关键词恒空

```
[P1-3] grouped keyword=例子 → 0 条 | 非分组 → 6 条
```

根因：`domains.ts:382-385` 用 `d.name.toLowerCase().includes(keyword.toLowerCase())` 匹配内存中的 **Punycode** 名；非分组路径把关键词交给 DB，`domain-query-builder.ts:160-183` 会先 `normalizeDomain(keyword)`。
期望：两条路径答案一致（都命中或都不命中），不能「同一关键词、两种视图、两种答案」。

### P1-4 `domain_type=apex` 把中文顶域 / 多段后缀顶域判成子域

```
[P1-4] apex → ["a.com","例子.中国"] | subdomain → ["sub.a.com","例子.公司.cn","www.例子.公司.cn","c.dpdns.org"]
```

期望：`例子.公司.cn`、`c.dpdns.org` 是 `getRootDomain` 判定的可注册域（`例子.中国` 因只有两段侥幸判对），应出现在 `apex`。
根因：`domain-query-builder.ts:243-257` 用 `d.name LIKE '%.%.%'`，`domains.ts:377-381` 用 `split('.').length > 2`，两处同源错误，与 `domain-utils.ts:33-42` 的 PSL 判定冲突；`例子.公司.cn` 有 3 段 → 被判子域。
连带：`grouped=true&domain_type=apex` 与组头（PSL 造组）互相矛盾——组里明明只有一个顶域，筛选「只看顶域」却把它过滤掉。

### P1-5 `POST /api/domains` 零格式校验

```
[P1-5] POST /domains "a..b" → 200
[P1-5] POST /domains "-bad.com" → 200
[P1-5] POST /domains "bad_name!.com" → 200
[P1-5] POST /domains "xn--zzzz" → 200
[P1-5] POST /domains "example.com.." → 200
[P1-5] 实际入库: ["a..b","-bad.com","bad_name!.com","xn--zzzz","example.com."]
```

期望：至少 400（`isValidDomain` 已在同文件第 22 行导入）。
根因：`domains.ts:672-709` 只做 `normalizeDomain` + 去空；`isValidDomain` 全项目只在 `ns-monitor.ts:86`、`rdap.ts:221` 被调用。
链式后果：`example.com..` 归一化后剩 `example.com.`（`utils/domain.ts:58` 只去掉一个末点），`getRootDomain` 算出 `.com`：

```bash
cd /workspace/HiDNS/server && ./node_modules/.bin/tsx -e "import { groupDomains } from './src/service/whois/domain-utils'; const rows=[{id:1,name:'example.com..'},{id:2,name:'a.example.com'}]; console.log(JSON.stringify(groupDomains(rows as any, [], {virtualRoots:true}).groups.map(g=>({name:g.name,children:g.children.map((c:any)=>c.id)}))));"
# → [{"name":".com","children":[1]},{"name":"example.com","children":[2]}]
```

### P1-6 记录名 / TTL / MX 无服务端校验

```
[P1-6] {"name":"aaaa…（64 字符）","type":"A"} → 200
[P1-6] {"name":" ","type":"A"} → 200
[P1-6] {"name":"www","type":"A","ttl":-1} → 200
[P1-6] {"name":"www","type":"MX","value":"mail.a.com"} → 200        （缺优先级）
[P1-6] {"name":"www","type":"MX","value":"mail.a.com","mx":99999} → 200
[P1-6] 直发上游: [["aaaa…","A","1.1.1.1",null,null,null,null,null],[" ","A","1.1.1.1",null,null,null,null,null],["www","A","1.1.1.1",null,-1,null,null,null],["www","MX","mail.a.com",null,null,null,null,null],["www","MX","mail.a.com",null,null,99999,null,null]]
```

期望：`name` 走 `isValidSubdomain`（支持 `@`/`_dmarc`/IDN）、`ttl` 落在 1..2147483647、MX/SRV/CAA 的 `extraFields` 走 `validateExtraField`（`lib/dns/record-types.ts:216-228` 已实现但无人调用）。
根因：`records.ts:455-466` 只校验 `value`；`:480` 直接把 `ttl/mx/weight` 透传适配器；批量路径 `:634-647` 同样只校验 value。

### P1-7 NFC/NFD 未归一化（HEAD 状态）

```bash
cd /workspace/HiDNS/server && node -e "const p=require('punycode.js'); console.log(p.toASCII('caf\u00e9.com'), p.toASCII('cafe\u0301.com'), p.toASCII('caf\u00e9.com')===p.toASCII('cafe\u0301.com'));"
# → xn--caf-dma.com xn--cafe-yvc.com false
```

即：HEAD 版 `normalizeDomain`（`utils/domain.ts:55-66`，无 `normalize('NFC')`）下同一域名的两种 Unicode 写法得到两个 Punycode → `getByAccountIdAndName` 判不出重复、`domain-utils.ts:79-83` 分成两组、按名比较的子域规则/白名单失配。
**工作区当前已有未提交补丁**（`git diff server/src/utils/domain.ts` 加了 `.normalize('NFC')`），所以本报告其他 IDN 探针（`例子。中国`、NFC/NFD）在工作区上是通过的。该补丁未提交，也没有 NFD 回归用例（`service/__tests__/public-suffix.test.ts` 未覆盖），需随修复一起落地。

### P2-1 组头直显 Punycode

```
[P2-1] 组头: ["a.com","xn--fsqu00a.xn--55qx5d.cn"] | 子行名称: ["a.com","sub.a.com","例子.公司.cn","www.例子.公司.cn","例子.中国","c.dpdns.org"]
```

期望：组头 `例子.公司.cn`。根因：`domains.ts:413-420` 直接塞 `groupName: g.name`（Punycode），子行才走 `getDisplayDomain(item.name, true)`（`:455`）；前端 `domains-page.tsx:266` 原样渲染 `{item.groupName}`，`:271` 的「父域未添加」提示也会显示 Punycode。

### P2-2 `can_write` 与真实写不一致

```
[P2-2] can_write: [{id:1,can_write:true},…,{id:6,can_write:true}] | 写 www → 200 | 写 @ → 403
```

规则：用户 8（role 1）只被授予 `a.com` 的 `sub='www'` 写权限。列表把 6 个域全标 `can_write:true`，真正能写的只有 `www`。
根因：`domains.ts:101-108` 的 `canWrite = perms.some(permission==='write')` 与 `writeSubs` 脱钩；`records.ts:459` 才用 `canWriteSubdomain` 收口。注释 `domains.ts:468-469` 声称「避免点了必 403」，实际正是这个效果。

### P2-3 grouped 分页边界

```
[P2-3] pageSize 回显 100000 | page=999 → page 4 / totalPages 4 | page 巨大值回显 1e+21
```

期望：`pageSize` 收敛到 `docs/api.md:34` 声明的 1000；`page` 越界返回空页或 400，而不是静默变成末页（前端页码与内容错位）；页码回显保持整数。
根因：`domains.ts:430` 的 `pageSizeActual` 没有 `Math.min`；`:446-448` 用 `Math.min(currentPage, groupedTotalPages)` 夹取；`:206` 只有 `Math.max(1, …)`。

### P2-4 跨账户同名域 → 组头 + 独立行重复

```bash
cd /workspace/HiDNS/server && ./node_modules/.bin/tsx -e "import { groupDomains } from './src/service/whois/domain-utils'; const rows=[{id:1,name:'example.com'},{id:2,name:'example.com'},{id:3,name:'a.example.com'}]; const r=groupDomains(rows as any, [], {}); console.log(JSON.stringify({groups:r.groups.map(g=>({parent:g.parent?.id,children:g.children.map((c:any)=>c.id)})), standalone:r.standalone.map((d:any)=>d.id)}));"
# → {"groups":[{"parent":1,"children":[1,3]}],"standalone":[2]}
```

同一域名挂在两个 DNS 账户是常见场景（迁移/双供应商）。期望组头能标识「有 2 条同名顶域」，而不是把第 2 条踢成独立行。

### P2-5 `Token + grouped=true` 静默降级且忽略分页

```
[P2-5] token+grouped 返回 数组 长度 3 | 含组头 false
```

`domains.ts:347` 的分支条件是 `grouped === 'true' && !tokenPayload && format !== 'array'`，Token 与 `format=array` 都静默丢掉分组；`domains.ts:250-256` 的白名单分支用 `getByIds` 直接全量返回，`pageSize` 失效（同接口非白名单 Token 走 `getAccessibleDomainsWithPagination`，是分页的）。
期望：要么显式 400「该组合不支持」，要么在 `docs/api.md:333-337` 写清优先级。

### P2-6 批量导入 `[null]` → 500 HTML

```
[P2-6] batch [null] → 500 <!DOCTYPE html> <html lang="en"> … TypeError
```

根因：`records.ts:634-637` 的 `for (const r of records)` 直接读 `r.name`，元素为 `null` 时抛 `TypeError`，被 Express 默认错误页接管。期望 400 + 统一 JSON 信封。
对照：`[]` → 400、`[{}]` → 400、`'notarray'` → 400、`[1,2,3]` → 400 都正常，只有 `null` 元素漏了。

### P2-7 校验/工具函数自身的三处坑

```bash
cd /workspace/HiDNS/server && ./node_modules/.bin/tsx -e "import { isValidSubdomain, normalizeDomain, isValidDomain, getRootDomain } from './src/utils/domain'; const psl=(require('./src/service/whois/domain-utils') as any).getRootDomain; console.log(JSON.stringify({sub63cn:isValidSubdomain('例'.repeat(63)), punyLen:normalizeDomain('例'.repeat(63)).length, badPuny:isValidDomain('xn--zzzzzz.com'), fqdn:isValidDomain('example.com.'), naive:getRootDomain('例子.公司.cn'), psl:psl('例子.公司.cn')}));"
# → {"sub63cn":true,"punyLen":69,"badPuny":true,"fqdn":false,"naive":"xn--55qx5d.cn","psl":"xn--fsqu00a.xn--55qx5d.cn"}
```

1. `isValidSubdomain`（`utils/domain.ts:182-193`）先按 UTF-16 长度判 63、再 Punycode 化 → 63 个中文标签「合法」，实际 69 字符超 DNS 上限（应 Punycode 后再判）。
2. `isValidDomain`（`utils/domain.ts:94-111`）只做正则 `xn--[a-z0-9-]+`，`xn--zzzzzz.com` 通过但 `punycode.toUnicode` 解不出来；同时它拒绝合法 FQDN 写法 `example.com.`（出现空 label），而 `normalizeDomain` 接受——两函数对同一输入合法性判断相反。
3. `utils/dns.ts:30` 仍导出 `utils/domain.ts:124-135` 的 naive `getRootDomain`（取后两段），与 `service/whois/domain-utils.ts:33` 的 PSL 版共存。当前生产代码只引用 PSL 版（`domains.ts:17`、`rdap.ts:17`），naive 版仅测试引用——是等着被误用的坑，不是现状 bug。

### X-1（待核实）虚拟组 id 与父域 id 取值域重叠

```
[P2-x] 虚拟组 id: [-1,-3]（父域 id ≥ 1,000,000 时 headerId=-parentId 会落进同一取值域）
```

`domains.ts:407`：有父域时 `headerId = -parent.id`；虚拟组时 `-(1000000 + hashGroupName(name))`，`hashGroupName` 取模 900000（`:182-186`）→ 虚拟组 id ∈ [-1899999, -1000000]。当某域名 id ≥ 1000000，其组头 id 会落进虚拟组区间，前端用 id 作 key/展开状态时可能串组。未在真实大 id 数据上验证，标待核实。
## 经核实无问题（下轮不必重复）

| 场景 | 结论 | 依据 |
|---|---|---|
| 多段公共后缀 | 正确：`bar.foo.cc.cd→foo.cc.cd`、`y.x.dpdns.org→x.dpdns.org`、`x.us.kg→x.us.kg`、`a.b.c.dpdns.org→c.dpdns.org` | `getRootDomain` 与 `groupDomains` 都走 PSL，纯函数探针与路由探针结论一致 |
| `*.ck` 通配 | 生效：`x.ck` 是后缀，`a.x.ck→a.x.ck`、`a.b.x.ck→b.x.ck` | `public-suffix.ts:65-71` |
| `!` 例外（`!www.ck`） | 被跳过（`public-suffix.ts:78-80` 有注释），`www.ck` 被当后缀；对成组结果无副作用（`www.ck` 自成一组，子域归入其中），但与 PSL 语义相反，属已知权衡 | 纯函数探针 |
| 大小写 / 末尾点 / 全角句号 / Unicode+Punycode 混写 | 归一化正确：`XN--FSQU00A…`、`例子.xn--55qx5d.cn`、`例子.公司.CN`、`例子。中国`（U+3002）都落到同一 Punycode | `tsx` 探针 |
| NFC/NFD（当前工作区） | 一致（`café` 与 `cafe+U+0301` 同 Punycode）——**依赖未提交补丁**，见 P1-7 | `tsx` 探针 + `git diff` |
| `groupDomains` 基本语义 | 父域缺失 + `virtualRoots=false`→standalone；只有顶域时不造空组；100 子域成一组且父域在首位；置顶子域排在父域之后；父域大小写不同仍能成组；空名/纯 TLD 不崩 | 13 组分组矩阵探针 |
| 子域级规则的实际拦截 | 本身有效：写 `www` 200，写 `@`、`other` 均 403，无越权 | `records.ts:459` 探针 |
| 批量导入基本边界 | 100 条 → 200；101 条 → 422；`[]` → 400；非数组 → 400；元素缺字段 → 400 | 探针 |
| 常规分页参数 | 非 grouped 路径 `page=0/-5`→1、`pageSize=0`→默认 20、`-1`→1、`10000`→100，符合 `utils/http.ts` 的 min/max | 探针 |
| `allowedDomains=[]` 放开语义 | 创建侧强制至少 1 个有效 id（`routes/tokens.ts:142-151`），空数组只可能来自历史/迁移数据；`docs/api.md:25` 已声明该语义 | 代码 + 文档 |
| `/domains/provider-list/:accountId` | 未被 `/:id` 遮蔽（两段路径），可正常进入 handler | 探针 |
| `requireTokenDomainPermission` 对畸形 id | id 非数字/缺失 → 403（fail-closed）；`[]`/`null` 语义与文档一致 | `middleware/auth.ts:147-194` |

## 我认为最该先修的 3 条

1. **P1-1 Token 读越权（含 zone 导出）** — 改动最小、风险最高：`records.ts:176`、`:226` 补 `requireTokenDomainPermission('domainId')`，同步 `docs/api.md:434-435`。修完要回归 ddns-go/certd 适配器（它们依赖读接口）。
2. **P1-5 + P1-6 把已写好的校验接上线** — `isValidDomain`/`isValidSubdomain`（`domains.ts:22`、`records.ts:20` 引入未用）、`validateExtraField`（`records.ts:23` 引入未用）都是现成的。接线时顺手修 P2-7 的两个语义坑（Punycode 后判长、接受 `example.com.`），否则一接线就会拒掉合法的 FQDN 写法。
3. **P1-3 + P1-4 统一 IDN 判定口径** — grouped 内存过滤改用 `normalizeDomain`；`domain_type` 的 apex/subdomain 改用 `getRootDomain(name) === normalizeDomain(name)`（SQL 侧至少按 `root_domain` 列或后缀表判定）。这条决定「分组视图 + 中文域名」能不能给用户用，也是 IDN 线里唯一会让功能直接归零的问题。

---

附：探针文件 `ai-censorship/evidence/adversarial-probe.domains.test.ts`（12 个用例，含上表 P1-1/P1-2/P1-3/P1-4/P1-5/P1-6/P2-1/P2-2/P2-3/P2-5/P2-6 与 X-1）留在 evidence 目录供复跑；`server/src/**/__probe__` 已删除，未改任何生产代码。

## 修复状态（执行层回填，2026-10-23，提交 `b5f6d0d` / `7dac823`）

| 编号 | 状态 | 说明 |
| --- | --- | --- |
| P1-1 | ✅ 已修 | `GET /records`、`/records/export/zone` 补 `requireTokenDomainPermission('domainId')` |
| P1-2 | ✅ 已修 | `/whois` 前置到 `/:id` 之前；`accountId` 分支补账号归属 + `canRead` 校验（403/404 均带 envelope） |
| P1-3 | ✅ 已修 | grouped 关键词同时匹配 Punycode 与 Unicode 显示名 |
| P1-4 | ✅ 已修 | `domain_type` 改用 `getRootDomain`（PSL）判定 |
| P1-5 | ✅ 已修 | `normalizeAndValidateDomainNames()`：拒绝 `a..b` / 首尾 `-` / 非法字符 / 无效 xn--，重复去重 |
| P1-6 | ✅ 已修 | `validateRecordInput()` 单条 + 批量接入；`records:[null]` 从 500 HTML 改为 400 信封 |
| P1-7 | ✅ 已修 | `normalizeDomain` / `toPunycode` 先做 NFC 归一化（提交 `7dac823`，含 NFC/NFD 回归用例） |
| P2-1 | ✅ 已修 | 组头 `groupName` 改 `getDisplayDomain(..., true)`，不再显示 `xn--` |
| P2-3 | ✅ 部分修 | grouped `pageSize` 夹取到 1000；`page` 仍静默夹到末页（**保留**：夹取比 400 更友好，但需在 docs 注明） |
| P2-6 | ✅ 已修 | 批量 `records` 元素非对象 → 400 |
| P2-2 | ⏳ 未修 | `can_write` 仍只看「是否有 write 规则」；子域级规则下按钮仍可能点了 403。需要后端按"该域名是否存在任意可写子域"再细算，或前端改为"按子域规则提示" |
| P2-4 | ⏳ 未修 | 同一域名挂两个账号时 `domainsByName` 只留第一条：分组会出现「组头 + 同名独立行」。修法：分组键改为 `name+account_id`，或组内允许同名多条 |
| P2-5 | ⏳ 未修 | `Token + grouped=true` 静默降级为未分组数组：属契约边界，建议在 docs/api.md 明写「Token 不分组」，或对 Token 直接 400 |
| P2-7 | ⏳ 未修 | 校验工具自身：`isValidSubdomain` 按 UTF-16 计长、`isValidDomain('xn--zzzzzz.com')` 为 true、`utils/dns.ts` 仍导出 naive `getRootDomain`（与 PSL 版并存，容易误用） |
| X-1 | ⏳ 待核实 | 虚拟组 id 取 `-(1000000+hash)`，与域名 id ≥ 1e6 时区间重叠；需要把偏移扩大到 1e9 或改用字符串 id |

门禁：`server` 69 文件 / 588 条全绿、`tsc` 0 错。

## 第四轮

复测对象：`a74c1f4`（授权码原子领取 / 账号锁按账号+IP / CORS 默认拒绝 / MCP CSV 转义 / 孤儿 NS 回收）+ `64b62bb`（MCP 可见性 / TRUST_PROXY / 备注限长）。
结论：**P0 = 3，P1 = 2，P2 = 4；FAIL 5 项 + 部分通过 2 项**。三项声称已修的安全项里有两项**反向破坏**（授权码兑换全废、账号锁 fail-open），CORS 收紧则把默认同源部署的写请求打死。

### 复测结果一览

| # | 项 | 结果 | 级别 |
|---|---|---|---|
| 1 | A-4 授权码并发兑换 | **FAIL**：并发 10 次成功 0 次，码被置 used=1 但换不出 token | P0 |
| 2 | A-5 账号锁按「账号\|IP」 | **FAIL**：失败计数永远不涨，5 次后仍 `9 attempt(s) remaining`，锁形同不存在 | P1 |
| 3 | A-6 CORS 跨源拒绝 | **部分 FAIL**：evil Origin 被拒（但 500），**同源生产域名 POST 也 500** | P0 |
| 4 | N-1 MCP domainId 工具可见性 | **FAIL**：`update_domain_status`/`list_domain_records`/`create_dns_record` 可操作他租户域名 | P0 |
| 5 | N-2 `list_domains_filtered` | **FAIL**：仍走超管口径，member 读到全租户 | P1 |
| 6 | A-1 三工具可见性 | PASS（三工具已修；续期按账号过滤导致同账号未授权域名可见） | P2 |
| 7 | A-2 TRUST_PROXY=true | PASS（进程存活/200；附 express-rate-limit 告警 + XFF 可伪造） | P2 |
| 8 | A-3 备注 200 上限 | 部分 PASS：更新路径 400/200 正确；**创建路径无校验** | P2 |
| 9 | A-6 MCP 审计 CSV 转义 | PASS | — |
| 10 | B 监控残留 / 审计漏记 | 待核实 / 确认 | P2 |

### 1. P0 · A-4 授权码兑换 100% 失败（码还被烧掉）

`executeInternal` 的签名是 `Promise<void>`（`server/src/db/bal/business-adapter.ts:278-302`），而 `consumeAuthCode` 用 `(claim as { changes?: number })?.changes ?? 0` 判定（`server/src/db/bal/business-adapter.ts:5025-5031`）→ `changes` 永远是 `undefined` → 恒为 0 → 永远返回 `null`。

```bash
cd /workspace/HiDNS/server
cp ../ai-censorship/evidence/r4-authcode-burn.probe.test.ts src/r4-authcode.test.ts
./node_modules/.bin/vitest run src/r4-authcode.test.ts
# [A4+] used before = [{"used":0}] | consume#1 = null | used after = [{"used":1}] | consume#2 = null
```

并发探针（10 个并发 `consumeAuthCode`）：`[A4] 并发兑换成功次数 = 0 / 10`。期望 1/10。
用户可见后果：`server/src/routes/mcp-oauth.ts:694-697` 对所有 code 返回 `400 invalid_grant`，而 code 已在库里被标记 `used=true`——重试也无效，MCP OAuth 授权流程彻底不可用（不是并发问题，是 100% 失败）。
修法：改用返回影响行数的 `run()`/`runInternal()` 读 `changes`（`business-adapter.ts:334-346`、`:387`），或把 `executeInternal` 的返回值透出。

### 2. P1 · A-5 账号锁 fail-open：读键与写键不一致

`recordFailedAttempt` 读的是 `attemptKey(identifier, ip)`=`账号|IP`（`server/src/service/loginLimit.ts:122`），但新建记录时写的是**裸账号**：`server/src/service/loginLimit.ts:174` `createAttempt(normalizedIdentifier, ipAddress)`。于是每次失败都查不到上一行 → 每次新建一行 `attempt_count=1` → `newCount` 永远到不了 `maxAttempts`。

```bash
# 真实进程（TRUST_PROXY=true 启动）连发 5 次错密码：
curl -s -X POST -H 'Content-Type: application/json' -H 'X-Forwarded-For: 1.1.1.1' \
  -d '{"username":"xffprobe","password":"bad"}' http://127.0.0.1:39001/api/auth/login
# 5 次全部返回：{"code":401,...,"msg":"Invalid username/email or password. 9 attempt(s) remaining."}
```

DB 级探针同样复现（`cp ../ai-censorship/evidence/r4-db-security.probe.test.ts src/r4-db-security.test.ts && ./node_modules/.bin/vitest run src/r4-db-security.test.ts`；其中 3 条断言当前为红＝缺陷本身）：5 次失败后 `checkLoginAllowed(victim, attackerIp)` → `{"allowed":true,"remainingAttempts":5}`；`clearLoginAttempts(user,'192.0.2.12')` 也清不掉裸账号行（`[A5] 清 ipB 后 → ipA {"allowed":true...}`）。
期望：同 IP 第 5 次失败后 `allowed:false`，另一 IP 仍 `allowed:true`。现状：两个方向都「放行」，暴力破解只受 `loginLimiter` 的 IP 限流约束（而该限流在 TRUST_PROXY=true 下可被 XFF 伪造绕过，见第 7 条）。
附带：每次失败多插一行 `login_attempts`，长期运行会累积垃圾行（`getTopIdentifiers` 统计会失真）。

### 3. P0 · A-6 CORS 收紧把同源部署打死

`server/src/app.ts:356-370`：只有 `localhost/127.0.0.1/[::1]` 在非生产环境放行，其余一律 `callback(new Error('Not allowed by CORS'))`。而浏览器对**同源**的 POST/PUT/DELETE 也会带 `Origin`——默认部署（单进程同时服务 UI+API，`CORS_ORIGIN` 未配置，`.env.example:64` 就是空的）下，登录与所有写请求全部 500。

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Origin: https://dns.example.com' \
  -H 'Content-Type: application/json' -d '{"username":"nobody","password":"x"}' \
  http://127.0.0.1:39001/api/auth/login
# → 500   （响应体 {"code":500,"msg":"Internal server error"}）
curl -s -D - -o /dev/null -H 'Origin: https://evil.example' http://127.0.0.1:39001/api/init/status | grep -i access-control-allow-origin
# → 无 ACAO 头（跨源确实被拒，但状态码 500 而非 403）
```

期望：同源/无 `CORS_ORIGIN` 时按「同源信任」放行（或至少 `Origin` 与 `Host` 相同则放行），跨源返回 403 且保留正常响应体。
另：拒绝路径走 error handler 记成 500，会把真实 CSRF 拒绝与服务器故障混在监控里。

### 4. P0 · N-1 MCP 里 10+ 个 `domainId` 工具没有可见性校验（第三轮修了 3 个读工具，写工具没动）

`getAccessibleScope` 只被 `list_domains` / `get_domain_info` / `get_renewable_domains` 调用；同文件的写/读记录工具直接拿 `domainId` 就去操作：
- `server/src/mcp/tools.ts:1171` `update_domain_status` → `DomainOperations.setEnabled(domainId, …)`
- `server/src/mcp/tools.ts:1241` `list_domain_records` → `DnsProviderService.getRecords(domainId, …)`
- `server/src/mcp/tools.ts:1346` `create_dns_record` → `DnsProviderService.createRecord(domainId, …)`（同族还有 `update_dns_record`/`delete_dns_record`/`get_dns_lines`/`manual_renew_domain`/`disable_domain_renewal`/`get_domain_whois`/`refresh_ns_monitor`）
`DnsProviderService.getAdapter(domainId)`（`server/src/service/dns-provider-service.ts:20-28`）只查域名、不看调用者，`validateToolPermission` 又只是「工具级」权限。

```bash
cd /workspace/HiDNS/server
cp ../ai-censorship/evidence/r4-mcp-visibility.probe.test.ts src/mcp/r4-mcp.test.ts
./node_modules/.bin/vitest run src/mcp/r4-mcp.test.ts
# [NEW-2] update_domain_status(3,false) → Domain 3 disabled successfully | setEnabled 调用 [[3,0]]
# [NEW-3] list_domain_records(3) → { "total": 1, ...} | create_dns_record(3) → DNS record created successfully ...
```

（member 42 只对 domain 1 可见，domain 3 属另一租户。）期望：403 或 not found。
这条是本轮最该优先修的：跨租户**写**（启停域名、增删解析记录）比读更致命，且与第三轮修的是同一类缺陷。

### 5. P1 · N-2 `list_domains_filtered` 仍是超管口径

`server/src/mcp/tools.ts:1684-1730` 未加可见性过滤，直接 `getAllForSuperAdminWithPagination` 并原样返回：

```
[NEW-1] list_domains_filtered → ["shared.com","super-private.com","other-tenant.com"] total 3
```

期望：只返回 `shared.com`。这条与第三轮报告的跨租户读是同一个洞，只是换了个工具名。

### 6. PASS（含 P2）· A-1 三工具可见性已修，但续期域名按「账号」过滤过宽

```
[A1-1] list_domains → ["shared.com"] total 1          ← 只看到自己可见的 ✅
[A1-2] own → { "domain": ...} | other → Domain with ID 3 not found   ← 越权 not found ✅
[A1-3] renewable → ["shared.com","secret-same-account.com"]        ← 同账号未授权的域名也可见 ⚠️
```
`server/src/mcp/tools.ts:398-407` 用 `accountIds` 过滤：只要 member 在该账号下有任一域名，就能看到同账号其他域名的到期时间与名称。建议改为按 `domainIds` 过滤（`renewable_domains` 有 `third_id/full_domain` 时按名匹配，或补 domain_id 列）。

### 7. PASS（含 P2）· A-2 TRUST_PROXY=true 可启动；但 IP 可伪造

`PORT=39001 TRUST_PROXY=true … tsx src/app.ts` → 进程存活、`/api/init/status` 200（`exit=124` 由 timeout 结束，非崩溃）。`app.ts:288-300` 的归一化对 `true/1/TRUE/false/0/数字/列表` 都成立（正则带 `i`）。
但 `express-rate-limit` 报 `ERR_ERL_PERMISSIVE_TRUST_PROXY`（日志 3 次），实测 `X-Forwarded-For` 可任意伪造并让限流按伪造 IP 计数：伪造 IP 连发 5 次后仍是 `9 attempt(s) remaining`，换 IP 立刻「重置」。这既让 A-5 的「账号|IP」锁失效，也让登录限流可轮换 IP 绕过。
建议：默认不放行 `true`（或仅在显式 `TRUST_PROXY=1` 跳数/网段时启用），并同步 `.env.example` 注明风险。

### 8. 部分 PASS · A-3 备注限长只覆盖「更新」，创建路径没有

```
[A3] PUT 400 字符 → 400 备注最多 200 个字符 | PUT 200 字符 → 200
[A3] POST 创建 400 字符 → 探针里备注 400 字符已进 create 参数（接口无长度检查）
```
`server/src/routes/domains.ts:1267` 只在 `PUT /:id` 校验；`POST /api/domains`（`:852-903`，含 `domains[]` 批量）与 `POST /renewable-domains`（`:1723`）都没有检查。前端 `client/src/features/domains/domains-page.tsx:295` 已加 `max-w-[26rem] truncate` + `title`（截断 ✅），但超长备注仍可从 API 灌进库并在导出/其他视图里撑破布局。
（说明：探针里创建接口后来抛 500 属我 mock 缺桩，未计入缺陷；`isValidDomain`/remark 的缺失是代码事实。）

### 9. PASS · A-6 MCP 审计 CSV 转义

```
id,user_id,auth_type,module,action,resource_type,resource_id,response_status,ip_address,created_at
1,2,api_key,domain_management,'=cmd|'/C calc'!A0,domain,"a,b",success,1.1.1.1,2026-10-24 10:00:00
2,2,api_key,m,list_domains,,"q""uote",,,2026-10-24 10:01:00
```
`=` 前缀加 `'`、含逗号/引号字段加引号并双写（`server/src/routes/mcp-audit.ts:130-145`）✅。注意：CSV 仍包在 `sendSuccess` 的 JSON `data` 字段里返回（非 `text/csv` 直出），浏览器直接下载会得到 JSON 包壳，属既有设计，未计入本轮缺陷。

### 10. P2 · 监控残留与 MCP 审计漏记

- **监控残留（待核实）**：删除域名只清同名 NS 监控（`server/src/routes/domains.ts:1382-1391`），`service_monitors.domain_id`（`server/src/db/dsm/schemas/complete-schema.ts:416`）没有对应清理；`runDnsFailoverCheck` 只在 `domainInfo` 存在时判启停（`server/src/service/serviceMonitor.ts:526-537`），域名删掉后仍会继续跑检查。运行时是否产生告警噪音未实测。
- **审计漏记（确认）**：MCP 工具仅在成功路径调用 `logMcpAction`；鉴权失败、参数校验失败、越权返回都不落审计（例：`create_dns_record` 的 `validateRecordValue` 失败直接 return，`list_domains` 的 catch 只 `log.error`）。身份字段取自 token（`auth.userId`），不可由请求体伪造 ✅；但「失败尝试」链路不可追溯，与「审计闭环」目标不符。

### 本轮修复确认（避免重复劳动）

- 虚拟组 id 撞父域 id 的问题已修（`server/src/routes/domains.ts:407` 偏移改为 `1000000000`），上轮 X-1 可结案。
- 前端只读隐藏有效：`client/src/features/domains/domains-page.tsx:284` `const canWrite = domain.can_write !== false`，按钮按此渲染（can_write 本身的子域粒度问题见上轮 P2-2，仍存在）。
- 组头仍直显 Punycode（`domains.ts:416` `groupName: g.name`），上轮 P2-1 未修，非本轮新增。


## 第四轮修复状态（执行层回填，提交 `5b17e1c`）

| 编号 | 状态 | 说明 |
| --- | --- | --- |
| P0 A-4 授权码兑换 100% 失败 | ✅ 已修 | `executeInternal` 返回 void → 改 `runInternal` 取 `{changes}`；`changes===0` 才判无效 |
| P0 N-1 MCP 跨租户写 | ✅ 已修 | `update_domain_status/list_domain_records/create_dns_record/get_dns_lines/update_dns_record/delete_dns_record/get_domain_remark/list_domains_filtered` 全部接 `assertDomainVisible` / 可见性过滤 |
| P0 A-6 CORS 打死同源 | ✅ 已修 | 拒绝时 `callback(null, false)`（不发 ACAO，不再 500）；实测同源 POST 登录 401 JSON、跨源同样 401 且无 ACAO |
| P1 A-5 账号锁 fail-open | ✅ 已修 | 写入与读取统一 `attemptKey`（账号\|IP）；实测失败计数 9→8 正常递减 |
| N-2 list_domains_filtered 超管口径 | ✅ 已修 | 非超管按 `getAccessibleScope` 过滤，total 用过滤后长度 |
| 仓卫：探针目录进仓 | ✅ 已清 | `__probe__` 移入 `ai-censorship/evidence/`，vitest exclude `**/__probe__/**` |
| P2：续期按账号过滤过宽 / 创建域名未限 / XFF 伪造削弱限流 | ⏳ 未修 | 见报告正文 |

## C 端细节轮

环境：前端 `http://localhost:5173`（Vite dev）+ 后端 `3001` + 隔离库 `/tmp/cend/data/app.db`；全程**未重启服务、未改代码**，复用 `/tmp/cend/state.json` 的会话副本（无任何登录尝试，未触碰 5 次/15 分钟限流）。
测试产生的数据（9 个监控、4 条 IDN/emoji 记录、`duptest`/`wsapi*` 记录、1 个 120 字符团队）已全部删除，库恢复原状（记录 12 条、团队 1 个、监控 6 个）。

**结论：P0 = 0，P1 = 4，P2 = 2。** 表单校验与重复提交做得比预期好；真正扎手的是**多页签下的实时连接互踢**与**监控/记录值的校验口径**。

| # | 级别 | 一句话 | 截图 |
|---|---|---|---|
| 1 | P1 | 两个页签同时打开时 WS 互相踢下线，状态每秒在「已连接/已断开」间闪烁，B 页签看不到 A 的新增/删除 | `adversarial-cend-ws-two-tabs.png` |
| 2 | P1 | WS 掉线期间的数据恢复后不补拉（20s 内不出现），且断网 3s 内指示器仍显示「实时已连接」 | `adversarial-cend-ws-offline.png`、`adversarial-cend-ws-heal.png` |
| 3 | P1 | 合法 IPv6 非规范写法（大写、全 8 组、IPv4-mapped）全部被拒，提示 `Invalid IPv6 address` | `adversarial-cend-aaaa-fullform.png`、`adversarial-cend-aaaa-upper.png` |
| 4 | P1 | 服务监控保存零校验：端口 70000、`warn_days=-5/9999`、`https://example.com@evil.test`、`@1.2.3.4` 全部入库；端口 0/周期 0 被静默改写 | `adversarial-cend-monitor-port70000.png`、`adversarial-cend-monitor-userinfo-target.png` |
| 5 | P2 | 错误提示中英混杂并直接抛上游/系统原文：`Invalid A record value…`、`Credential check failed: Specified access key is not found.`、`getaddrinfo ENOTFOUND …` | `adversarial-cend-record-english-error.png`、`adversarial-cend-account-english-error.png` |
| 6 | P2 | 团队名称/描述无长度上限（120/500 字符入库），且创建成功后上一条错误横幅仍挂在页面上 | `adversarial-cend-team-long.png` |

### 1. P1 · 两个页签 = 两条 WS，互相踢下线（状态同步失效）

复现：同一浏览器上下文开两个 `/dash/domains` 页签，每秒采样右上角连接指示器；随后在 A 页签新建一条记录，观察 B 页签。

| 场景 | 实际 | 期望 |
|---|---|---|
| 单页签 8s 采样 | `连接 ×8` | 稳定连接 |
| 双页签 A / B 8s 采样 | `连接,断开,连接,断开…` / `断开,连接,断开,连接…` | 两页都稳定连接 |
| A 新建 `syntest` | A 计数 16 ✅，**B 不刷新看不到** | B 通过 WS 自动出现 |
| A 删除 `syntest` | A 15 ✅，**B 仍显示 16（幽灵行）** | B 同步移除 |

服务端日志（`/tmp/cend/server.log`）每个 300–500ms 一条 `Closing existing WebSocket connection { userId: 1 }` 紧跟一条 `client connected` —— 同用户只保留一条连接（`server/src/service/websocket.ts:107`），两个页签于是无限互踢。
影响：只要用户开第二个页签（或 IDE 预览 + 浏览器），实时更新就整页失效，且指示灯持续闪断；多设备同账号同样如此。

### 2. P1 · 掉线后不自愈：数据要手动刷新才回来

复现（单页签，排除互踢）：记录页 → `context.setOffline(true)` → 用 API 新建 `wsapi2` → 恢复网络，轮询 20s。

| 观测点 | 实际 | 期望 |
|---|---|---|
| 断网 3s 后指示器 | 仍显示「实时已连接」 | 尽快显示断开 |
| 恢复网络 20s 内 `wsapi2` | **始终不出现**（20s 采样全是 `断开/连接` 交替） | 自动重连并补拉一次列表 |
| 恢复网络后手动刷新 | 记录出现 | — |

断线重连只建连、不触发任何 refetch，掉线窗口内的变更永久丢失（只能靠用户刷新）。截图：`adversarial-cend-ws-heal.png`。

### 3. P1 · 合法 IPv6 被当成非法

复现：`/dash/domains/1/records` → 新建记录 → 类型 AAAA → 依次填入下列地址 → 创建。

| 输入 | 实际 | 期望 |
|---|---|---|
| `2001:db8::1` | 创建成功 | ✅ |
| `2001:DB8::1`（大写） | `Invalid IPv6 address` | 接受 |
| `2001:0db8:0000:0000:0000:0000:0000:0001`（全 8 组） | `Invalid IPv6 address` | 接受 |
| `::ffff:127.0.0.1`（IPv4-mapped，RFC 4291） | `Invalid IPv6 address` | 接受 |
| `::ffff:7f00:1`（规范压缩形式） | 创建成功 | ✅ |

根因：校验拿 `new URL('http://[v]').hostname` 与字面量 `'[' + v + ']'` 做**字符串相等**比较（`client/src/types/record-types.ts:215`、`server/src/lib/dns/record-types.ts:213`），而 URL 会把地址规范化成小写压缩形式，任何非规范写法都判失败。
用户视角：从云厂商文档/终端复制的 IPv6 地址十有八九不是压缩形式，等于「照抄就报错」。

### 4. P1 · 服务监控「保存零校验」：非法配置全部入库

复现：`/dash/domains/servicemonitor` → 新增监控 → SSL 证书 → 逐项填写 → 保存（每次都提示「监控已保存」）。保存后用 `GET /api/servicemonitor` 核对存储值。

| 输入 | 存储结果 | 期望 |
|---|---|---|
| 端口 `70000` | `config.port = 70000` | 400（1–65535） |
| 端口 `0` | `config.port = 443`（静默改写） | 400 或提示已改 |
| 检测周期 `0` | `check_interval = 300`（静默改写） | 400 或提示 |
| 到期前告警天数 `-5` / `9999` | `warn_days_before = -5 / 9999` | 400（合理区间） |
| 目标 `https://example.com@evil.test` | 原样入库 | 400（非法主机名） |
| 目标 `@1.2.3.4` | 原样入库 | 400 |
| 目标 `127.0.0.1` | 入库，但检测时返回「目标不允许指向内网/保留地址」 | 保存时即可提示 |

服务端只校验 `name/type/target` 非空与 `type` 枚举（`server/src/routes/servicemonitor.ts:193-230`），端口、周期、阈值、目标主机名一律不校验。
缓解：SSRF 在**执行期**有守卫（`127.0.0.1` 被拦）✅；但非法配置会一直躺在列表里，每次检测都失败并回显 `getaddrinfo ENOTFOUND https://example.com@evil.test`，面板噪音与「保存成功」的错觉并存。

### 5. P2 · 错误提示中英混杂、直接抛上游原文

| 场景 | 实际提示 | 期望 |
|---|---|---|
| A 记录值 `999.1.1.1` | `Invalid A record value: must be a valid IPv4 address` | 中文 + 指向「记录值」字段 |
| AAAA 非法 | `Invalid IPv6 address` | 同上 |
| CNAME 值 `evil.example@1.2.3.4` | `Invalid hostname value` | 同上（并说明不支持 userinfo/@） |
| 新建阿里云账户（假凭据） | `Credential check failed: Specified access key is not found.` | 「凭据校验失败：AccessKey 不存在」 |
| 监控检测失败 | `目标无法解析: getaddrinfo ENOTFOUND …` | 中文原因 + 建议 |

同一产品里中文提示（`请输入主机记录`、`TTL 必须大于 0`、`记录名不能包含连续的点`、`第 1 个动作还没选动作类型`）质量不错，混进英文原文后整体观感割裂，且英文消息不指向具体字段。

### 6. P2 · 团队名称/描述无长度上限 + 旧错误横幅残留

复现：`/dash/teams` → 新建团队 → 名称留空保存（出现红色横幅「请输入团队名称」）→ 再填 120 字符名称 + 500 字符描述保存。
实际：团队**创建成功**（`server/src/routes/teams.ts:155-168` 只校验非空），列表用省略号截断（布局没崩 ✅），但页面顶部**仍挂着上一条「请输入团队名称」的红色横幅**（截图 `adversarial-cend-team-long.png`），用户会以为保存失败。
期望：名称 ≤ 64、描述 ≤ 200 的服务端约束；创建成功后清空上一轮错误态。

### 本轮核实无问题（下轮不必重复）

| 场景 | 结果 |
|---|---|
| 记录名超长（64 字符）、`a..b`、TTL `0`/`-1`、空表单 | 全部被中文提示拦截：`记录名单个标签超过 63 个字符`、`记录名不能包含连续的点`、`TTL 必须大于 0`、`请输入主机记录`/`请输入记录值` ✅ |
| 双击「创建」记录 | 首次点击后按钮即 `disabled`，只生成 1 条（`adversarial-cend-dup-submit.png`）✅ |
| 新增域名未选账户 | 「添加域名」按钮 `disabled`，不会发出空提交（`adversarial-cend-domain-disabled.png`）✅ |
| 工作流空名 / 未选动作 | 中文提示「请输入名称」「第 1 个动作还没选动作类型」，不落库 ✅ |
| 记录名 emoji / 中文 / 多级 IDN（`😀`、`例子`、`例子.测试`、`www.例子`） | 均可创建并在列表正常显示（虚拟提供商；真实提供商是否接受取决于上游）✅ |
| 监控目标指向 `127.0.0.1` | 执行期被拦：`目标不允许指向内网/保留地址`（SSRF 守卫有效）✅ |
| 登录限流 | 全程复用 storageState，0 次登录尝试，未触发 5 次/15 分钟限制 ✅ |

### 建议修复顺序

1. **WS 互踢**（P1-1）：同用户多连接改为「保留全部、按连接投递」，或前端跨页签用 BroadcastChannel 选主连接；至少不要 `close` 旧连接（`server/src/service/websocket.ts:107`）。
2. **重连补拉**（P1-2）：`open` 成功后触发一次当前页 refetch；断网时 5s 内把指示器改为断开。
3. **IPv6 规范化比较**（P1-3）：改成 `hostname.replace(/^\[|\]$/g,'')` 与规范化后的输入比较，或直接用 `net.isIPv6(v)`。
4. **监控字段校验**（P1-4）：端口 1–65535、周期 ≥ 60、warn_days 0–365、目标必须是裸主机名（禁 `://`、`@`、`/`）。

## 代码审核团评审

评审范围：`git diff fd855871..HEAD`（8 个提交：WS 多连接、监控校验、续期添加、团队/工作流 UI、错误中文化、NS 表单校验）。只读代码 + 独立实例（/tmp/rev/app.db，端口 39102）实测，未改动仓库代码、未提交。

**结论：P0 = 0，P1 = 2，P2 = 8**（以 HEAD 为准）。WS 多连接与监控校验的主体思路正确（IPv6 规范化、续期 enabled 三层一致、广播返回值无人使用），但**监控更新接口的域名写权限缺口**与**续期添加的账号归属缺口**是这批改动触及到却没补的跨租户口子。

> 评审期间工作区存在**他人并发未提交改动**（`git diff HEAD -- server/src` 43 行）：已补上 PUT 域名写权限、PUT type 枚举、`Number.isInteger(interval)`、`checkMethod` 枚举、`expectedBody ≤ 200`，并新增「单用户 10 连接」上限。下面第 1、6 条与第 7 条后半段针对的是这些改动**之后**的残留问题；行号以评审时工作区为准，HEAD 上没有 `:41` 那个常量。

| # | 级别 | 位置 | 问题 |
|---|---|---|---|
| 1 | P1 | `server/src/routes/servicemonitor.ts:342-385`（对比创建分支 `:280-286`） | `PUT /api/servicemonitor/:id` 可改 `domain_id` 而不校验域名写权限 → 借故障转移把记录写进他人域名 |
| 2 | P1 | `server/src/routes/domains.ts:1764-1780` | `POST /renewable-domains` 的 `provider_type` 兜底只 `getById(account_id)`，无归属校验 → 管理员可把续期行挂到他人账号，自动续期用他人凭据执行 |
| 3 | P2 | `server/src/routes/servicemonitor.ts:47-79`、`:251-256`、`:363-368` | `config` 传字符串时 `cfg.port`/`cfg.allowPrivate` 全为 undefined → 所有 config 校验与 allowPrivate 门禁被绕过 |
| 4 | P2 | `server/src/routes/servicemonitor.ts:42-50` | `Number()` 强转造成类型漂移：`port:true`（→1）、`interval:"1e3"`/`" 30 "` 通过并原样入库 |
| 5 | P2 | `server/src/routes/servicemonitor.ts:34-40` + `client/src/features/domains/service-monitor-tab.tsx:283-295` | 前端拦、后端放：`example.com/foo`（ssl 目标带路径）、`ftp://`、`http://` 都能入库，之后每次检测必失败 |
| 6 | P2 | `server/src/routes/servicemonitor.ts:376-385`（对比 `:269-272`） | PUT 不校验 `type` 枚举，可把监控类型改成任意串/空串 |
| 7 | P2 | `server/src/service/websocket.ts:41`、`:124-126`（工作区新增）+ `client/src/app/realtime.tsx:119-126` | HEAD 无单用户连接上限（20/100 条都能建）；工作区加了 10 上限但新连接被 `4005` 静默拒绝、客户端无限重连且每次 `onopen` 全量刷新 |
| 8 | P2 | `server/src/service/websocket.ts:142`、`:229`、`:288-305` | `sendToClient` 语义从「单连接」变成「该用户全部连接广播」：欢迎/pong/错误消息被复制 N 份（实测 3 连接 → welcome 计数 3/2/1，ping 的 pong 3/3/3） |
| 9 | P2 | `server/src/service/websocket.ts:38-50`、`:340-372` | `socketsOf` 每次全表扫描，`sendToClient`/`broadcastToUsers` 均为 O(用户数×连接数) |
| 10 | P2 | `server/src/routes/teams.ts:156-170`、`:289-300` + `client/src/features/teams/teams-page.tsx:319`、`:326` | 名称限 50 按 UTF-16 计（26 个 emoji 即被拒）；描述仍无任何长度限制（前端也没 maxLength） |

### 1. P1 · 监控更新接口缺域名写权限 → 跨租户写 DNS 记录

创建分支对 `dns_failover` 做了 `getDomainAccess(domainId).canWrite` 校验（`servicemonitor.ts:280-286`），但 `PUT /:id` 只校验「监控属于本人」，随后直接把 `domain_id` 写进去（`:382-385`）。执行期 `updateFailoverDnsRecord(domainId, ...)`（`service/serviceMonitor.ts:639-658`）只用域名所属账号的凭据写记录，不再看调用者。

```text
# 探针（mock 掉 auth/DB，只测路由授权判定）：PUT /api/servicemonitor/7  body={domain_id:999,...}
[PUT] 改 domain_id → 999 → 200 {"code":0,"data":{"id":7}} | getDomainAccess 调用次数 = 0
```

利用链：普通用户创建一条绑定自己域名的 `dns_failover` 监控（通过 canWrite）→ PUT 把 `domain_id` 改成受害者域名、`primaryValue` 指向不可达地址 → 下一次检测必然切到 `backupValues`，用受害者账号的凭据把记录改成攻击者指定值。建议 PUT 补齐与创建相同的检查：

```ts
if ((type ?? existing.type) === 'dns_failover') {
  const targetDomainId = domainId ?? existing.domainId;
  if (targetDomainId) {
    const access = await getDomainAccess(Number(targetDomainId), req.user!.userId, normalizeRole(req.user!.role));
    if (!access.canWrite) { sendError(res, 'No write permission for the specified domain', 403); return; }
  }
}
```

### 2. P1 · 续期添加的 `provider_type` 兜底不校验账号归属

`domains.ts:1766-1769` 新增「provider_type 缺省时按 account_id 反查账号类型」，但整个 handler 只用 `role >= 2` 做门槛，没有 `getAccessibleByUserId` 归属校验（同文件删除/开关/续期三处都有：`:1655`、`:1808`、`:1954`）。

```text
POST /api/renewable-domains {account_id: <他人账号>, third_id: <他人域名ID>, full_domain: 'victim.com'}
→ 200；随后 domainRenewalJob 遍历所有账号（domainRenewalJob.ts:27,55-115）命中该行，
  scheduler.renewDomain(他人账号 config, third_id) 执行续期。
```

附带：审计 `logAuditOperation(..., { providerType: provider_type })`（`:1809`）记的是**原始入参**，走兜底时是 `undefined`，审计里看不出实际使用的 provider。建议补 `if (!ownedAccountIds.has(Number(account_id))) return 403;`，审计改记 `resolvedProviderType`。

### 3. P2 · `config` 传字符串可绕过全部 config 校验与 allowPrivate 门禁

`validateMonitorInput` 用 `const cfg = (config ?? {}) as Record<string, unknown>`（`:47`），字符串没有属性 → `port/warn_days_before/expectedStatus/path/checkPort/checkPath/checkMethod/expectedBody` 全部跳过；allowPrivate 门禁也只看 `typeof config === 'object'`（`:251-256`、`:363-368`）。

```text
[CASE] config 字符串带 port 70000 → 200（stored configType=string, config='{"port":70000}'）
[CASE] config 对象 port 70000      → 400 端口需在 1–65535 之间
[CASE] config 字符串 allowPrivate  → 200（role=1）
[CASE] config 对象 allowPrivate    → 403 Only administrators can allow private targets
```

影响：非管理员可持久化带 `allowPrivate:true` 的字符串 config；当前 `guardTarget(target, config.allowPrivate)` 因 config 是字符串而读到 `undefined`，内网仍被拦（**未形成 SSRF**），但 `rowToMonitor`（`serviceMonitor.ts:942`）解析出的是字符串，端口/告警天数回退默认值，属坏数据。建议入口先 `typeof config !== 'object' || Array.isArray(config) → 400`。

### 4. P2 · `Number()` 强转造成的类型漂移

```text
[CASE] interval 30.5   → 400 检测周期需为 30–86400 之间的整数秒  ✅
[CASE] interval "1e3"  → 200，check_interval 存成字符串 "1e3"
[CASE] interval " 30 "  → 200，check_interval 存成 " 30 "
[CASE] port true      → 200，config.port = true（Number(true)=1 通过整数校验）
```

`check_interval` 变成字符串后原样回给前端、`checkInterval * 1000` 依赖隐式转换；`port:true` 会让 `net.connect({port:true})` 抛错，监控永久失败。建议 `Number.isInteger(Number(x)) && typeof x !== 'boolean'`，并统一转 number 入库。

### 5. P2 · 前端拦、后端放的三类目标

```text
[CASE] ssl 目标 example.com/foo → 200（前端：非 URL 且含 '/' → 拦截）
[CASE] endpoint 目标 ftp://example.com → 200（前端：非 https?:// 且含 '/' → 拦截）
[CASE] endpoint 目标 http:// → 200（前端 new URL 会抛错 → 拦截）
```

后端 `validateMonitorInput` 只挡了 `@`、空格、协议（非 endpoint）与长度（`:34-40`）。这类监控入库后 `guardTarget` 解析失败，永远显示「检测失败」。建议 endpoint 强制 `new URL(target)` 且 protocol ∈ {http:,https:}，其余类型禁 `/`。

### 6. P2 · PUT 不校验 `type` 枚举

创建分支校验 `['ssl_certificate','endpoint','dns_failover'].includes(type)`（`:269-272`），PUT 只把它拼进 `validateMonitorInput`，而后者不校验 type（`:34` 只拿它做协议分支）。`PUT {type:''}` 或任意串会把类型改坏，`performCheck` 的 switch 无 default → 返回 undefined，`runCheckAndUpdate` 解构时报错。

### 7. P2 · 单用户连接上限：HEAD 没有，工作区的拒绝路径没处理

```text
# HEAD（本次评审区间）：代码里没有 MAX_CONNECTIONS/4005（git show HEAD:server/src/service/websocket.ts | grep 为空）
#   → 每条连接都注册，20/100 条均可建立（无上限，放大不受控，见第 9 条）
# 工作区（并发未提交）：慢速开 20 条 → connected = 10，其余 close code = 4005 ×10
```

HEAD 的无上限意味着「一个账号开上千条连接」时内存与广播放大不受控（每条广播对每个连接都 send 一次，见第 9 条）。工作区加上限是正确方向，但被拒的是**最新连接**且客户端不区分 close code：`realtime.tsx:142-146` 一律 `scheduleReconnect()`（1s→2s→…→30s），而握手成功时 `onopen` 已跑过（`:119-126`），`wasReconnect` 为真 → 每次重连都 `invalidateQueries()` **全量重拉**。用户开 11 个页签时，第 11 个页签会周期性把全站查询重拉一遍，指示器反复「在线/离线」。建议：服务端改踢最旧连接或 4005 时给只读降级；客户端对 4005 停止重连并提示，且只在 offline→online 边沿刷新一次。

### 8. P2 · `sendToClient` 语义扩大为「该用户全部连接」

```text
3 连接 welcome: [3,2,1]（第 3 条连上时把 welcome 又发给了前两条）
A 发一次 ping → pong 数 A/B/C: [1,1,1]
```

同用户内不跨租户，且前端 `EVENT_QUERY_MAP` 没有 `connected` 键、也没人发 ping，当前**无功能影响**；但属语义错位 + N 倍放大，后续加「按连接回包」（终端/日志流）会串到其它标签页。建议 `handleMessage` 直接 `client.ws.send(...)`，只有用户级推送才走 `sendToClient`。

### 9. P2 · 连接表结构导致 O(用户数×连接数)

`clients: Map<string, WSClient>`（key 为 `userId#seq`，`:34`）+ `socketsOf` 全表扫描（`:38-50`）：`broadcastToUsers` 对每个目标用户扫一遍全部连接（`:340-372`），1000 用户 × 5000 连接时每次广播 500 万次比较。建议 `Map<number, Set<WSClient>>`，`socketsOf` 变 O(1)。

### 10. P2 · 团队名 50 上限按 UTF-16 计，描述仍无限制

`teams.ts:161` `name.trim().length > 50` 与前端 `maxLength={50}`（`teams-page.tsx:319`）都以 UTF-16 码元计数：50 个汉字正常，26 个 emoji 就被判「超过 50」。`description` 服务端无长度校验、前端 Input 也没 maxLength（`:326`），上一轮的 500 字符描述仍可入库。建议按 `[...name].length` 计字符，描述加 200 上限。

### 已核实无问题（避免下轮重复）

| 项 | 结论 |
|---|---|
| IPv6 校验修复 | `2001:DB8::1`、全 8 组、`::ffff:127.0.0.1`、`::` 全部通过；`1::2::3`、`2001:db8::1/64`、`fe80::1%eth0`、`::ffff:999.1.1.1` 被拒（`record-types.ts:185-200`） |
| 续期 enabled | UI 禁用 + `POST /:id/renew` 显式 `if (!renewableDomain.enabled)`（`domains.ts:1655-1660`）+ 自动任务跳过 disabled（`domainRenewalJob.ts:103-112`），三层一致 |
| 续期记录删除/开关/续期的归属 | 均有 `getAccessibleByUserId` 校验（`domains.ts:1655`、`:1808`、`:1954`） |
| 监控 interval 整数 / expectedBody 200 / checkMethod 枚举 / checkPath 空格@ | 均已生效（`:42-79`） |
| `broadcastToUsers` 返回值语义变化 | 仓库内无调用方使用返回值，无影响 |
| 断线清理 | 按 socket 身份删除（`websocket.ts:252-264`），实测 17 连接/17 断开一致，无残留 |
| 工作流 DSL | 本批只改前端标签/布局，`server/src/workflow/**` 无改动，未发现本批引入的问题 |

### 并发改动提示（评审结束时的工作区状态）

评审期间 `git diff HEAD -- server/src` 已有他人未提交改动（43 行），与本报告的关系：

| 工作区改动 | 影响的发现 |
|---|---|
| `servicemonitor.ts` PUT 补 `getDomainAccess(canWrite)` + type 枚举 | 关闭 P1-1、P2-6（建议补单测：改 `domain_id` 越权应 403） |
| `servicemonitor.ts` interval 改 `Number.isInteger`、checkMethod 枚举、expectedBody ≤200 | 关闭 P2-4 的浮点分支；P2-3/P2-4 的字符串/布尔强转仍未覆盖 |
| `websocket.ts` 新增 10 连接上限 | 缓解连接放大；但引入 P2-7（4005 静默 + 重连风暴），合入前需客户端一起改 |

以上改动**未提交、未跑本报告的探针**；若与本次评审同时合入，请以「P1-1/P2-6 已修、P2-7 由『无上限』变为『拒绝路径未处理』」更新台账。


### 修复状态（执行层回填，提交 `436443f9`）

| 编号 | 状态 | 说明 |
| --- | --- | --- |
| P1 PUT 监控缺域名写权限 | ✅ 已修 | 实测 PUT domain_id=1（他人）→ 403 |
| P1 续期新增未校验账号归属 | ✅ 已修 | 实测 admin2 挂他人账号 → 403「无权操作该账户」 |
| P2 config 字符串绕过校验 | ✅ 已修 | 非对象 config 直接 400；数值字段拒绝 boolean |
| P2 类型漂移（port:true / interval:"1e3"） | ✅ 已修 | interval 必须整数；port 等拒绝 boolean |
| P2 WS 上限客户端未处理 4005 | ⏳ 未修 | 客户端仍会重连；连接上限只在异常场景触发，建议下一批加「被拒即停止重连并提示」 |
| P2 sendToClient 语义变为全连接广播 | ⏳ 未修 | 当前无功能影响，保留待评估 |

### 第二轮验收（修复后复核）

| 评审 | 判定 | 说明 |
| --- | --- | --- |
| be-constraint-review | ✅ 通过（P0=0/P1=0） | P0 越权链闭合；WS 上限/索引对称；续期归属 PASS；非 failover domain_id 记 P2 |
| fe-arch-review | ✅ 通过（P0=0/P1=0） | 4005 停止重连、enabled/config 回填、审计列宽、pt-phi-8、防抖、MCP 用词均 PASS |
| adversarial-auditor | ✅ 通过（P0=0/P1=0） | 两道式改类型/置空/字符串 id 均无法绕过；续期归属 PASS |
| design-critic | ✅ 通过（阻塞项 274f3780 后复核） | 实测 POST/PUT type=endpoint + domain_id=999 → 200 且回读 domain_id=null |

最终：**四位评审一致通过，可合入**。
