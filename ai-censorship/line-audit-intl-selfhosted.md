# 线路语义审计 · 国际 + 自建 + 小众组（HEAD c45b710a）

- 范围：cloudflare、gcore、namesilo、spaceship、powerdns、vps8、dnsla、dnshe、dpdns_reverse、dnsneko、hidns、hidns_v2、rainyun、west、virtual；并复核 dnspod 修复是否彻底
- 方法：只读代码（adapter / registry / service/record-line.ts / routes/records.ts）+ 官方文档核对（能取到的取原文，取不到的标"无公开文档"）
- 判据来自 DNSPod 事故形态：**把线路"名称"当"ID"传给上游**（如 `RecordLine: '0'`），或把默认哨兵 `'0'` 当作真实线路值发出

## 0. 结论速览

| 级别 | 条数 | 条目 |
| --- | --- | --- |
| P0 | **0** | 无"名称当 ID"的写路径（DNSPod 事故形态在本组已不复现） |
| P1 | **1** | **cloudflare**：`line` 仍兼作代理开关，更新时未显式给 `proxied` 的调用会被解析成 `proxied:false` → 已代理记录被静默降级为 DNS-only（DDNS-Go/Certd 按兼容说明发 `line:"0"`，正好命中） |
| P2 | **5** | namesilo / powerdns 的 `Line` 回显与线路 id 空间不一致；west 的 `toWestLine` 与"线路不可改却无能力位"；dnspod 默认线路未强制注入列表；dnspod `convertLineCode` 未覆盖中文线路名 |

先给结论：**除 cloudflare 的 `line→proxied` 通道外，本组没有"线路 id / 名称 / 默认哨兵"三者混用的写路径**；`resolveLineInput`（`server/src/service/record-line.ts:37-53`）是唯一的归一化点，把 `'0'/''/undefined` 统一折叠成"未指定"，适配器再用 `resolveProviderLine(line, defaultLine)` 落默认值——这条链路是对的。

## 1. 逐提供商核对

| 提供商 | 文档 URL | 代码现状 | 结论 | 证据（adapter 行号） |
| --- | --- | --- | --- | --- |
| **cloudflare** | https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/edit/ | CF 无线路概念。`getRecordLines` 只返 `[{id:'0',name:'默认'}]`；`buildRecordBody` 用 `toProxiedValue(line)` 把 `'1'/'0'` 解成 `proxied`，非 `'0'/'1'` 时字段缺省；回显 `Line: r.proxied ? '1':'0'` | **P1/风险**：写路径会把"未指定代理"变成**显式 false**。`resolveLineInput('cloudflare', {})` → `{line:'0',proxied:false}`（record-line.ts:48-52），`toProxiedValue('0')` → `false` → PATCH 体里带 `proxied:false`。任何只改 value/TTL 的更新（DDNS-Go、Certd、API Token 脚本，兼容文档记录它们发 `line:"0"`）都会关掉橙云 | adapter.ts:334（回显）、:350-377（body 构造）、:413-417（toProxiedValue）；docs/integrations/ddns-go-certd-compat.md:13-14（外部集成确实发 line:"0"）；service/record-line.ts:44-52；routes/records.ts:578-582 |
| **gcore** | https://gcore.com/docs/dns （locations API 未启用） | 动态线路代码整段注释，只返默认；`line` 参数未进入任何请求体 | OK | adapter.ts:432-470（getRecordLines）、:285-345 |
| **namesilo** | https://www.namesilo.com/api-reference | 上游无线路概念；`getRecordLines` → `[{id:'0'}]`；add/update 的 `_line` 未使用（不传上游 ✔）；但 `getDomainRecords` 把**每条记录**标成 `Line: normalizeLine(line) \|\| 'default'` | **P2/风险**：回显值 `'default'` 与线路表 id `'0'` 不同空间 → 前端线路列/筛选选中态对不上；若把 `line` 传进来会被"盖"到所有行（它不是过滤参数） | adapter.ts:23-25（normalizeLine）、:99（mapRecord 传参）、:193-203 |
| **spaceship** | https://docs.spaceship.dev/ | 默认-only，`_line` 未使用 | OK | adapter.ts:130-165、:209 |
| **powerdns** | https://doc.powerdns.com/authoritative/http-api/record.html | 无线路概念；`getRecordLines` → 默认；写路径不传线路 ✔；但 `getDomainRecords` **硬编码** `Line: 'default'` | **P2/风险**：同 namesilo 的空间不一致（列表 id 是 `'0'`） | adapter.ts:176（Line:'default'）、:388 |
| **vps8** | 无公开文档（逆向实现） | 默认-only，`_line` 未使用 | OK（无法文档验证） | adapter.ts:179-230、:289 |
| **dnsla** | 无公开文档（`/api/availableLine` 逆向） | 动态线路：`getRecordLines` 映射 `{id: row.id, name: row.value}`；add/update 传 `lineId: resolveProviderLine(line,'0')`；列表过滤 `params.lineId = line` | **OK**（id 与字段三处一致，默认 `'0'` 与 registry `defaultLine` 相同） | adapter.ts:266-278、:178、:221、:136-138 |
| **dnshe** | 无公开文档 | 无线路（注释写明不支持），默认-only | OK | adapter.ts:274-278、:384-388 |
| **dpdns_reverse** | 无公开文档 | 显式返回默认（注释：反向代理只支持默认线路） | OK | adapter.ts:115-118 |
| **dnsneko** | 无公开文档（`/geo-lines` 逆向） | 动态线路：id 取 `defaultOption.value` + 分类 `option.value`；`normalizeLine` 把历史 `'0'`/`'1'` 折成 `'default'`，其余走 `resolveProviderLine(line,'default')`；回显 `Line: r.line` | **OK**（id 来源一致，fallback `'default'` 与 registry `defaultLine:'default'` 对齐） | adapter.ts:333-362、:378-383、:393 |
| **hidns** | 无公开文档（自建服务） | `getRecordLines` 内置仅 `'0'`；add/update `if (line) body.line = line`（`'0'` 已被归一化为 undefined ⇒ 不发送）；回显 `Line: r.line` | **OK**（默认不发送，不会把 `'0'` 当线路名发出去）；若上游支持多线路则前端拿不到，属产品缺口不属错误 | adapter.ts:294、:336、:381-386、:236 |
| **hidns_v2** | 无公开文档（自建服务） | 动态 `/domains/:id/lines`；add/update **恒传** `line: resolveProviderLine(line,'0')` | **OK（待上游确认）**：字段名 `line`、默认 `'0'` 与 registry 一致；上游若期望线路名则会命中 DNSPod 同型问题，当前无文档可证 | adapter.ts:273、:316、:358-375 |
| **rainyun** | 无公开文档 | 内置 7 条（`DEFAULT/LTEL/LCNC/LMOB/LEDU/LSEO/LFOR`），registry `defaultLine:'DEFAULT'` 在列表内；add/update `line: resolveProviderLine(line,'DEFAULT')`；列表按 `r.Line === line` 过滤 | **OK**（id 空间自洽，默认在列表内） | adapter.ts:357-368、:262、:309、:195-197 |
| **west** | 无公开文档（第三方配置指南 https://ddns.newfuture.cc/providers/west） | 内置 6 条（`'0'`+LTEL/LCNC/LMOB/LEDU/LSEO）；add `line: this.toWestLine(line)`，`toWestLine` 把空/`'default'` 折成 `''`、其余原样；**update 完全不传 line**；列表 client-side 过滤 `r.Line === line` | **P2/风险**：①`toWestLine('0')` 返回 `'0'`（`'0'` 在列表里是"默认"的 id，上游是否接受该 id 未证实）；②update 不能改线路，但 `ProviderDefinition` 没有"线路可编辑"能力位 → 前端仍可能对更新场景展示线路选择，改了静默无效 | adapter.ts:306、:427-431、:320-345、:236-238 |
| **virtual** | 本地实现（`/tmp/archtest3` 之外的测试提供商） | 默认 `'default'`，`getRecordLines` 返回 `[{id:'default'}]`；add 默认 `'default'`，update 仅在有值时改 | OK | adapter.ts:183-197、:227、:260 |
| **dnspod（复核）** | https://cloud.tencent.com/document/api/1427/56166 | `getRecordLines` 取 `LineId`（`Useful` 过滤 + 去 `N.` 前缀）；add/update **只传 `RecordLineId`**；`convertLineCode` 把 `default/unicom/...` 别名映射成真实 ID（`'0'`、`'10=1'`…）；回显 `Line: LineId` | **OK（修复彻底）**：官方文档原文"如果传 `RecordLineId`，系统会忽略 `RecordLine` 参数"，代码正好只传 `RecordLineId`，事故形态消除 | adapter.ts:24-37、:214-215、:253-254、:300-313、:80、:193 |

## 2. 遗留问题明细（按严重度）

### P1-1 · cloudflare：更新路径把"未指定代理"写成"关闭代理"
- 触发链：`routes/records.ts:578` → `resolveLineInput('cloudflare', {proxied: undefined})` → `service/record-line.ts:48-52` 返回 `{line:'0', proxied:false}` → `cloudflare/adapter.ts:372-373` `toProxiedValue('0')===false` → `body.proxied=false`。
- 影响面：**API Token / 第三方 DDNS 更新**（`docs/integrations/ddns-go-certd-compat.md:13-14` 明确记录 DDNS-Go 与 Certd 的建/改请求都带 `line:"0"`，并声称该值按「未指定」落到 `defaultLine`——但该文档漏掉了 CF 上这一步同时把 `proxied` 写成了 false）；前端编辑框会带 `proxied`，工作流更新会带 `previous.Line`（`workflow/actions/dns/record.ts:130-140`），这两条路径不受影响。
- 建议：`resolveLineInput` 对 CF/ESA 在"三处都未给出"时返回 `proxied: undefined`（而不是 `false`），由适配器省略该字段；仅在显式 `proxied:false` 或 `line:'0'` 时才置 false。

### P2-1 · namesilo / P2-2 · powerdns：记录行回显的 `Line` 与线路表 id 不同空间
- namesilo：线路表 `[{id:'0'}]`，记录回显 `'default'`（`adapter.ts:99 → :193-203`）。
- powerdns：线路表 `[{id:'0'}]`，记录回显硬编码 `'default'`（`adapter.ts:176`）。
- 影响：前端按 `line` 过滤/高亮时恒不命中；若将来允许"按线路筛选"，这两个提供商会永远筛出空。
- 建议：统一回显 `defaultLine`（`'0'`），或把线路表的 id 改成 `'default'` 并同步 registry。

### P2-3 · west：默认哨兵与"线路不可更新"都没有落成声明
- `toWestLine`（`adapter.ts:427-431`）只把空串和 `'default'` 折成 `''`，`'0'` 会原样进 payload；而 `'0'` 是本项目内部约定的"默认/id"，西部数码真实线路 id 空间未知（无公开文档）。
- `updateDomainRecord`（`:320-345`）不带 `line`，说明"线路创建后不可改"；但 `ProviderDefinition` 只有 `lineSource/defaultLine`，没有"线路可编辑"能力位 → UI 无法据此隐藏编辑态。
- 建议：`toWestLine` 对 `'0'` 返回 `''`（与 `resolveProviderLine` 的语义一致），并给能力位补 `lineEditable`。

### P2-4 · dnspod：默认线路 `'0'` 未强制注入列表；P2-5 · 中文线路名未覆盖
- `getRecordLines` 直接透传上游 `Useful` 线路（`adapter.ts:300-355`），不保证包含 `'0'`（默认）。若上游 category/list 都不返回默认行，前端无法选中"默认"，而 `defaultLine` 仍是 `'0'`。
- `convertLineCode`（`:24-37`）只覆盖英文别名（`default/unicom/telecom/mobile/edu/oversea/btvn/search/internal`）；外部集成若按**中文线路名**（"默认"/"电信"）调用，会被当作 `RecordLineId` 原样透传 → 上游 `RecordLineInvalid`。事故形态从"id 当名称"反转为"名称当 id"，仍是同一类多义。

## 3. 复核方法说明

- 归一化链路：`service/record-line.ts`（`'0'/''/undefined → 未指定`）→ 适配器 `resolveProviderLine(line, defaultLine)` → 上游字段；本次逐个核对"是否把名称/哨兵写进上游字段"。
- 官方文档核对：DNSPod（已取原文，确认 `RecordLineId` 与 `RecordLine` 的互斥语义）、Cloudflare（PATCH 端点的 `proxied` 为 optional boolean）。gcore/namesilo/powerdns/spaceship 仅取到产品文档入口；dnsla/dnshe/dnsneko/hidns/hidns_v2/rainyun/west/vps8/dpdns_reverse **无公开 API 文档**，结论以代码与字段自洽性为准，已在表中标注"无公开文档/待上游确认"。
