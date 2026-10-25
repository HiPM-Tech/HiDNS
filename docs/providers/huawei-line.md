# 华为云 DNS 线路语义（对齐官方文档）

> 本文是华为云适配器的线路约定，来源于：华为云 DNS API《查询系统线路 ListSystemLines》《创建记录集 CreateRecordSetWithLine》《修改记录集 UpdateRecordSets》，以及上游 PR #39（`sylingd/HiDNS`）的评审结论。

## 1. 线路 ID 空间

- 官方线路类型的基础集合：`default_view`（默认）、`Dianxin`（电信）、`Liantong`（联通）、`Yidong`（移动）、`Jiaoyuwang`（教育网）、`Tietong`（铁通）、`Pengboshi`（鹏博士）、`CN`（中国大陆）、`Abroad`（境外），另有运营商细分（如 `Dianxin_Beijing`）与地区线路（如 `AP`）。
- **不存在 `"0"`**。历史实现沿用阿里云式 `0–4` 是错的；本仓库自 2.3.1 起不再使用该哨兵。
- 实际可选集合以 `ListSystemLines`（`GET /v2.1/recordsets/lines?limit=&offset=`）返回为准，前端展示时**必须把 `default_view` 排首位**（前端按「首项=默认」取默认值）。

## 2. 创建与修改

| 操作 | 官方接口 | line 语义 |
| --- | --- | --- |
| 创建记录 | `CreateRecordSetWithLine`（`POST /v2.1/zones/{zone_id}/recordsets`） | 可传 `line`；未指定或传旧哨兵 `"0"` 时，适配器统一落到 `default_view` |
| 修改记录 | `UpdateRecordSets`（`PUT /v2.1/zones/{zone_id}/recordsets/{recordset_id}`） | **不接受 `line`**：线路创建后不可修改，适配器显式不透传 |
| 查询记录 | `ListRecordSetsWithLine` | 返回的 `line` 为空时按 `default_view` 处理 |

因此前端在**编辑**记录时禁用线路选择，并提示「该提供商的线路创建后不可修改」；新建时以服务端返回的首项（`default_view`）为默认。

## 3. 适配器实现位置

- `server/src/lib/dns/providers/huawei/adapter.ts`
  - `getRecordLines()` → `ListSystemLines`，分页拉取（limit=500，最多 10 页），去重后把 `default_view` 排首位；空结果按失败抛出。
  - `addDomainRecord()` → `line` 归一化为 `line && line !== '0' ? line : 'default_view'`。
  - `updateDomainRecord()` → 不透传 `line`。
  - `getDomainRecords()` → `Line` 缺失时返回 `default_view`，按线路过滤时忽略 `'0'`。
- 回归用例：`server/src/lib/dns/providers/__tests__/huawei-line.test.ts`（4 条）。

## 4. 与上游 PR #39 的关系

PR #39 的方向（替换假的阿里云式线路表、从 `UpdateRecordSets` 移除 `line`）与本仓库一致；本仓库在合并其意图的同时补齐了评审指出的问题：

1. `default_view` 排首位（PR 未处理返回顺序，可能导致默认建到境外线路）；
2. `'0'` 哨兵在适配器内兜底为 `default_view`（PR 的 `line || 'default_view'` 对真值 `'0'` 不生效）；
3. 线路查询失败抛错而不是回退成静态列表；
4. 回归用例覆盖上述三条。

## 5. 已知限制

- 华为云线路数量可能随账号/区域变化，适配器最多拉取 5000 条（10×500）；超出时以首批为准并记录告警日志。
- 线路创建后不可修改是上游限制，前端只能禁用编辑，不做「删除重建」自动化。
