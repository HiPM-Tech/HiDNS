# 线路语义审计（国内云 + 宝塔/彩虹）

审计范围：aliyun、aliyunesa、huawei、huoshan、jdcloud、qingcloud、baidu、tencenteo、bt、caihongdns。
方法：逐适配器读 `getRecordLines` / `addDomainRecord` / `updateDomainRecord` / `getDomainRecords`；对照官方文档（能取到正文的取正文，取不到的标「待核实」并给 URL）。未改代码、未提交。

判定基线（root.ai.md §2.2）：① `getRecordLines` 的 id 必须是「上游线路 ID」；② 写记录时只传 ID，不得传名称；③ 未指定线路时必须用 `defaultLine`；④ builtin 的 `defaultLine` 必须在返回列表内；⑤ 上游不允许改线路时不得透传。

| 提供商 | 文档 URL | 代码现状（id 语义 / 写入字段 / 默认值 / 更新 / 列表过滤） | 结论 | 证据（adapter 行号） |
|---|---|---|---|---|
| **aliyun** | https://api.aliyun.com/meta/v1/products/Alidns/versions/2015-01-09/apis/AddDomainRecord/api.json （已取正文：`Line` 默认值与示例均为 **default**） | `getRecordLines` 取 `LineCode`（=线路 ID，正确）；写记录传 `Line: normalizeLine(line) ?? '0'` → **未指定时发送 '0'，而上游枚举/默认是 'default'**；registry `defaultLine: '0'`；上游返回空列表时兜底 `[{id:'0'}]` | **P0** | aliyun/adapter.ts:205-215, 33-48, 135, 167；registry.ts:80 |
| **huawei** | https://support.huaweicloud.com/api-dns/ （SPA 未取正文，本条依据代码注释 + PR #39） | `getRecordLines` 取 `/v2.1/system-lines` 的 `id`（ID）；写 `line: resolveProviderLine(line,'default_view')`；**update 显式丢弃 line**（线路创建后不可改）；列表过滤 `line_id` 仅当 ≠'0' | **OK（本组唯一完全合规者）** | huawei/adapter.ts:389-410, 288-295, 316-330, 231 |
| **baidu** | https://cloud.baidu.com/doc/DNS/s/okc0f3v2x （SPA，仅取到 shell） | `getRecordLines` 内置 6 项 `default/ct/cnc/cmnet/edu/search`（名称即编码，待核实）；写记录 `resolveProviderLine(line,'default')` 硬编码回退 **'default'**，而 registry `defaultLine: '0'` → **两套默认值，且 '0' 不在自身列表内**；列表过滤参数未使用 | **P1** | baidu/adapter.ts:386-395, 20, 63；(defaultLine) registry.ts:117 |
| **huoshan** | https://www.volcengine.com/docs/6758/144869 （SPA 未取正文） | `getRecordLines` **丢弃上游 `Value==='default'` 并改写为 '0'**，其余取 `Value`；写记录 `Line: resolveProviderLine(line,'0')`；update 仍透传 Line；默认 `= '0'` 是否被上游接受 **待核实** | **P1（风险）** | huoshan/adapter.ts:343-361, 24/45（add/update）, registry.ts:129 |
| **jdcloud** | https://docs.jdcloud.com/cn/jd-cloud-dns/api/create-resource-record （未取正文） | `getRecordLines` 由 `viewTree` 递归取 `viewId`（ID）；写 `viewValue: toNumber(resolveProviderLine(line,'0'),0)`；update 同样以请求 line 覆盖；**列表过滤 `_line` 未使用** | **P1（更新会把记录移到默认线路；筛选无效）** | jdcloud/adapter.ts:360-377, 33/61 |
| **qingcloud** | https://docsv3.qingcloud.com/ （未取正文） | `getRecordLines` 取 `zone_views.id`（ID 形态待核实是否数字）；写 `view_id: toNumber(...)` —— **非数字 id 会被 `toNumber` 压成 0**；update 前虽 GET 了现有记录，仍用请求 line 覆盖 view_id；列表过滤 `_line` 未使用 | **P1** | qingcloud/adapter.ts:406-419, 31, 49, 94 |
| **tencenteo** | https://cloud.tencent.com/document/api/1553 （未取正文） | `getRecordLines` 内置 `Default/Mainland/Overseas`（编码式，待核实）；写 `Location: resolveProviderLine(line,'Default')`；update 亦透传；列表过滤 `_line` 未使用 | **P1（update 透传线路 + 筛选无效，编码待核实）** | tencenteo/adapter.ts:293-300, 13, 48 |
| **bt** | 面板私有接口，无公开文档 | `getRecordLines` 取 `get_views` 的 `viewId`（ID）；写 `view_id: toNumber(...)`；update 同；列表过滤用 `searchKey='line'/'searchValue`（是否为 viewId 待核实） | **P2（ID 语义正确，待核实 viewId 是否为数字）** | bt/adapter.ts:291-299, 24, 61, 35-37 |
| **caihongdns** | 聚合商，无公开文档 | `getRecordLines` 返回**中文名称**作为 id（`默认/电信/联通/移动/教育网/境外`）；写记录 `if (line) body.line = line` → **若上游要 ID 则同类于 DNSPod 的「名称当 ID」问题** | **P2（待核实；若上游要 ID 即升 P0）** | caihongdns/adapter.ts:420-429, 24, 69 |
| **aliyunesa** | https://help.aliyun.com/zh/esa/ （未取正文） | `getRecordLines` 恒返回 `[{id:'0'}`（ESA 无线路）；`line` 被复用为**代理开关**（`line==='1' → Proxied=true + BizName=web`），符合 `PROXY_LINE_PROVIDERS` 约定 | **OK（约定内；建议在注释中写明 ESA 不传线路）** | aliyunesa/adapter.ts:332-334, 24-27, 82-88 |

## 系统性问题（跨提供商）

- **S1（P1）更新时未保留原线路**：`routes/records.ts` 的 PUT 用 `resolveLineInput` 归一后，未指定线路为 `undefined`；除 huawei 外，本组 8 家适配器都把 `undefined` 回落成默认线路再写回（aliyun '0'、huoshan '0'、jdcloud 0、qingcloud 0、baidu 'default'、tencenteo 'Default'、bt 0、caihongdns 不传）。UI 编辑会带原 line 所以看不出，**但 API Token / DDNS 客户端只改 value 时会静默把记录挪到默认线路**（或触发上游报错）。建议：适配器在 `line === undefined` 时先 `getDomainRecordInfo` 取现有 line 再用。
- **S2（P2）列表线路过滤形同虚设**：jdcloud、qingcloud、tencenteo、caihongdns、baidu 的 `getDomainRecords` 参数名为 `_line` 或未使用，前端「按线路筛选」对这些提供商返回全量。

## 与 DNSPod 历史问题的对照

DNSPod 的问题是把「线路名称」写进 `RecordLine`（应为 `RecordLineId`）。本组复核结果：**没有一家再把名称当 ID 传给上游**（huawei/jdcloud/bt 明确用 ID，baidu/tencenteo 用的是接口自定的编码，不是展示名）；但有 **aliyun 把哨兵 '0' 当线路值**（与 DNSPod 同类的「值域不对」），以及 **caihongdns 以中文名称作 id** 的潜在同类风险（待核实上游是否需要 ID）。

## 待核实清单（需真实账号或可取正文的文档）

1. aliyun：上游是否接受 `Line='0'`（文档默认 'default'，枚举未见 '0'）；若拒绝，本组创建默认线路记录会 400。
2. huoshan：`Line` 是否接受 '0'；`Value='default'` 被改写成 '0' 是否有据。
3. qingcloud：`zone_views.id` 是否为数字；非数字被 `toNumber` 压成 0 的影响。
4. baidu：line 编码集合（default/ct/cnc/cmnet/edu/search）是否与官方一致。
5. tencenteo：`Location` 取值是否就是 Default/Mainland/Overseas。
6. caihongdns / bt：上游 line 字段要 ID 还是名称。

## 结论

- 本组 **P0 = 1**（aliyun：未指定线路时向上游发送 '0'，而官方默认是 'default'），**P1 = 4**（baidu 双默认口径、huoshan 改写 'default'→'0' + 待核实、系统性问题 S1 更新回落默认线路、qingcloud view_id 数字强转），**P2 = 5**（列表过滤失效类、caihongdns 名称作 id 待核实、bt/aliyun 兜底项）。
- huawei 与 aliyunesa 在本组内合规；huawei 的「update 不透传 line」应作为其他提供商的对齐范本。