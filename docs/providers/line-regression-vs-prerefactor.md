# 线路语义：重构前后对比（对比基线 `59f93ed7^`）

> 目的：用重构前版本判断「当前线路问题」是重构引入的回归，还是历史遗留。
> 基线：`59f93ed7^`（删除旧前端/重构前的最后一次提交）；当前：`main @ 27941ede`。
> 方法：逐提供商抽取 `getRecordLines` / `addDomainRecord` / `updateDomainRecord` / 列表过滤中与 line 相关的行，做集合 diff；只列语义变化，纯 import 变化忽略。

## 一、结论

1. **重构没有引入新的「线路值域」回归**：除 Aliyun/Baidu 的默认值声明外，各提供商写入上游的 line 取值与重构前一致。
2. **Aliyun / Baidu 的问题来自「重构时新增的 registry defaultLine」与老适配器不一致**（Aliyun 老实现就发 `0`，registry 沿用了 `0`；Baidu 老实现回退 `default`，registry 却写 `0`）。两者已在 `27941ede` 修正。
3. **DNSPod 的 `RecordLineInvalid` 不是重构引入**：重构前就是 `RecordLine: line || '0'`（把 `0` 当线路名）；本轮改为只传 `RecordLineId` 是修复历史问题。
4. 其余待核实项（huoshan `0`、qingcloud `toNumber`、tencenteo `Location`、caihongdns 中文 id、west/bt 线路编辑）**在重构前后行为一致**，属历史遗留，不是回归。
5. Cloudflare「更新未传 proxied 会关橙云」同样重构前后一致（老适配器也把缺省当 false），本轮在路由层改为「未指定则保留原值」，属于行为修正而非回归修复。

## 二、逐提供商 diff（只列变化）

| 提供商 | 重构前 | 当前 | 判定 |
| --- | --- | --- | --- |
| aliyun | `Line: normalizeLine(line) ?? '0'`；兜底 `[{id:'0'}]` | `Line: normalizeLine(resolveProviderLine(line,'default'))`；兜底 `default` | **默认值修正**（文档 `default`） |
| baidu | `line: line || 'default'` | `line: resolveProviderLine(line,'default')` | 语义不变；registry `defaultLine` 已对齐 `default` |
| dnspod | `RecordLine: line || '0'` | 只传 `RecordLineId` | **修复历史 bug**（名称/ID 混用） |
| huawei | `line || '0'`；update 透传 line；静态假线路 | `default_view` 归一；update 不透传；`ListSystemLines`；`default_view` 排首位 | **PR #39 + 语义修正**（已评审） |
| namesilo | `mapRecord(line='default')` | `mapRecord(line='0')` | 读回对齐列表 id（本轮） |
| powerdns | `Line: 'default'` | `Line: '0'` | 读回对齐列表 id（本轮） |
| tencenteo / rainyun / virtual / dnsneko / dnsla / huoshan / qingcloud / jdcloud / bt / west / hidns_v2 / caihongdns | `line || '<default>'` / `toNumber(line,0)` | 外层换成 `resolveProviderLine(line,'<default>')`（默认值不变） | **语义等价**，仅统一哨兵处理 |
| aliyunesa | `line === '1'` 作为代理开关 | 不变 | 语义等价（代理约定） |
| cloudflare / gcore / spaceship / vps8 / dnshe / dpdns_reverse / hidns / powerdns(写) | 不传 line 或忽略 | 不变 | 无线路能力，符合预期 |

## 三、历史遗留（对比确认非回归，登记 backlog）

| 项 | 提供商 | 说明 |
| --- | --- | --- |
| `Line='0'` 未验证 | huoshan | 重构前后一致；上游是否接受 `0` 待真实账号验证 |
| `view_id: toNumber(...)` | qingcloud / jdcloud / bt | 重构前后一致；若线路 ID 非纯数字会被压成 0 |
| `Location` 编码 | tencenteo | 重构前后一致；`Default/Mainland/Overseas` 待核对 |
| 中文名称作 id | caihongdns | 重构前后一致；无公开文档 |
| 线路筛选未接线 | jdcloud/qingcloud/tencenteo/caihongdns/baidu | 重构前后一致（`_line` 未使用） |
| 线路不可改但 UI 可编辑 | west | 重构前后一致；缺少 `lineEditable` 能力位 |

## 四、复核方式

```bash
git show 59f93ed7^:server/src/lib/dns/providers/<provider>/adapter.ts | grep -iE 'line|view'
grep -iE 'line|view' server/src/lib/dns/providers/<provider>/adapter.ts
```

结论：**「其它提供商」的线路问题均可判定为历史遗留而非重构回归**；需要真实账号验证的 6 项已登记，不再作为重构阻断项。
