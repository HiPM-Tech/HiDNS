# PR 评审报告 · 代码审核团

| 项 | 内容 |
| --- | --- |
| 评审对象 | PR #39 `feat(huawei): 完善华为云线路支持`（`sylingd/HiDNS:main` → `HiPM-Tech/HiDNS:main`，head `59f93ed`，+23 / −9，2 文件） |
| 评审日期 | 2026-10-23 |
| 评审方式 | 单条评审线；对照 `root.ai.md` 规范 + 华为云官方 API 文档逐条核实，并在主仓临时应用该 PR 的两个文件跑门禁后还原 |
| 门禁实测 | `server` tsc = 0 错误；`client` tsc = 0 错误；`server` vitest = 56 文件 / 511 用例全绿（基线同） |
| 评审执行体 | DSH 会话内评审代理（运行环境未声明模型名，文件名以 `dsh-agent` 占位，不冒用其他模型名） |
| 处置（2026-10-23） | **冻结**：PR #39 已转为 draft，不合并、不关闭、分支保留。解冻条件见 §九 治理路线——等新成员接手前端重构后，按「API 改造 / DNS 语义解构 / 前端重构」三线同步推进，届时整体吸收本 PR 改动；期间若华为云用户踩到建记录发 `line:"0"`，可在主干打一行止血补丁并在提交信息注明出处 |

## 一、结论

**方向正确，但不建议按现状直接合并。** 把假的阿里云式线路表（`0`–`4`）换成华为云真实的系统线路 ID、并从 `UpdateRecordSets` 里移除 `line`，两处判断都与官方文档一致，是真修复。问题在于**只改了适配器一层**，线路哨兵 `'0'` 的旧口径仍留在路由与工作流里，而新代码的兜底 `line || 'default_view'` 恰好对 `'0'` 不生效：

> 建记录最常用的三条路径（`POST /api/domains/:id/records` 不带 line、`dns.record.create`、`dns.record.batch`）仍会向华为云发送 `line: "0"`，这个值不在华为云线路 ID 空间内。

| 级别 | 数量 |
| --- | --- |
| P0 | 0 |
| P1 | 4 |
| P2 | 8 |
| P3 / 建议 | 3 |
| 经核实无问题 | 7 |

维护者此前在 PR 下的「大体没问题」与本次结论**不完全一致**：P1-1、P1-2 都会影响真实用户，且都不属于风格问题，建议补完再合。

## 二、P1

### P1-1 `'0'` 哨兵未归一化：建记录路径仍向华为云发送非法线路 ID

- 位置：`server/src/lib/dns/providers/huawei/adapter.ts:292`（PR 版）、`server/src/routes/records.ts:474`、`server/src/routes/records.ts:723`、`server/src/workflow/actions/dns/record.ts:114`、`server/src/workflow/actions/dns/record.ts:194`
- 证据（代码）：`line || 'default_view'` 是**假值兜底**，`'0'` 是真值，永不触发；而路由层 `const effectiveLine = ... : (line ?? '0')` 在调用方不传 line 时**注入 `'0'`**，工作流两条动作则直接硬编码 `'0'`。三者串联后，适配器拿到的永远是 `'0'`。
- 证据（文档）：华为云《创建记录集 CreateRecordSetWithLine》请求示例的 `line` 取值是 `"default_view"`；官方《解析线路类型》表内的基础线路为 `default_view / Dianxin / Liantong / Yidong / Jiaoyuwang / Tietong / Pengboshi / CN / Abroad`，**没有 `"0"`**。
- 影响（[INFERENCE]，置信 MEDIUM，取决于华为云是否静默归一未知线路）：要么这些路径建记录被 400 拒绝；要么依赖未文档化行为通过，但记录回读时 `line` 与新的下拉选项对不上（见 P2-3）。作者在 PR 里自述「已经验证修改部分的功能」——即**没验证建记录**，这条正好落在未验证区。
- 建议：把「未指定」与「默认」在适配器内收敛成一次判断，路由/工作流不必改语义：
  ```ts
  // adapter.ts addDomainRecord
  const effectiveLine = line && line !== '0' ? line : 'default_view';
  ...
  line: effectiveLine,
  ```
  若确认华为云接受 `'0'`，也必须把该行为写进 `docs/api.md`，不能留在隐式约定里。

### P1-2 默认线路取 `lines[0]`，依赖 `ListSystemLines` 未定义的返回顺序；错建后无法再改

- 位置：`client/src/components/RecordForm.tsx:145-149`（`defaultLine`）、`:369`（`firstLine`）；`adapter.ts:386-404`（原样透传 API 顺序）
- 证据：`ListSystemLines` 的 Query 参数只有 `locale / limit / offset`，**没有排序参数**，返回顺序不属于契约；官方响应示例里 `default_view` 恰好排第一，但这只是示例。华为云线路含运营商细分（`Dianxin_Beijing`、`Yidong_Huadong`…）与地区线路（`AP` 亚太地区等），总量数百条。
- 影响：新建记录时 `line` 状态 = `String(lines[0].id)`，一旦首项不是 `default_view`，用户不加注意就会把记录建在「亚太地区」等线路上；而 `UpdateRecordSets` 不支持改线路（本 PR 已确认），**错建后只能删除重建**。这是本 PR 唯一会直接产出错误数据面变更的点。
- 建议：在适配器出口把默认线路排到首位（前端多处都假设「首项 = 默认」，见 `aliyun`、`baidu` 的实现），并加断言用例：
  ```ts
  const lines = raw.map((row) => ({ id: String(row.id), name: String(row.name) }));
  lines.sort((a, b) => (a.id === 'default_view' ? -1 : b.id === 'default_view' ? 1 : 0));
  return lines;
  ```

### P1-3 「线路创建后不可改」没有进入能力模型，且 `PUT` 静默丢弃 `line`

- 位置：`client/src/components/RecordForm.tsx:354`（`providerType === 'huawei'` 硬编码）；`adapter.ts:316-346`（`updateDomainRecord` 的 `line` 形参已完全不使用，未改名、未注释「有意忽略」）
- 证据：`root.ai.md` §DNS提供商适配器 6 规定能力分两层且不得混写，`DnsCapabilities` 现有位为 `remark / status / redirect / weight / proxiable / cnameFlattening / recordTypes`，**没有「线路可编辑」这一位**；服务端对 `line` 的变化既不报错也不回告。
- 影响：违反 §客户端架构 4「禁止静默失败」。第三方（DDNS 客户端、工作流、批量脚本）调用 `PUT` 传了新线路会得到 200，却什么都没改；再出现第二个「线路不可改」的提供商时，客户端会继续堆 `providerType === 'xxx'` 分支。
- 建议：能力位补 `lineEditable: boolean`（或 `lineMode: 'editable' | 'createOnly'`），前端按能力位禁用并在 `tips` 里说明原因；服务端在「传入 line ≠ 现记录 line」时返回 400/422 明确拒绝，而不是吞掉。若本次不想动能力模型，最低限度把 `line` 形参改名 `_line` 并加注释，同时在 `docs/api.md` 写明该行为。

### P1-4 未同步 `docs/api.md`（项目硬性规则）

- 位置：`docs/api.md:349-352`（`GET /api/domains/:id/lines`）、`:414-453`（POST/PUT 示例 `"line": "0"`）、`:469-481`（batch 示例）
- 证据：`root.ai.md` 两处写着「API 文档是第一权威……新增或修改 API 时必须同步更新 `docs/api.md`，否则视为未完成」。本 PR 改变了 `line` 的取值空间（华为云从 `0`–`4` 变成 `default_view / Dianxin / …`）与 PUT 的可写性，属于必须记录的对外行为变更。
- 补充：`line` 这个字段本身已经一词多义——Cloudflare / AliyunESA 用它当代理开关（`0`/`1`），其他提供商当线路 ID 用。文档必须按提供商说明，否则外部适配器无法正确取值。
- 建议：新增「线路 ID 随提供商而异」小节，给出华为云示例 `"line": "default_view"`，并注明「华为云线路创建后不可修改，PUT 的 line 被忽略」。

## 三、P2

| # | 位置 | 问题 |
| --- | --- | --- |
| 1 | `adapter.ts:394-399` + `server/src/routes/domains.ts:1256-1275` | 失败兜底结果会被 `SystemCacheOperations` 缓存 30 分钟：一次网络抖动让该账号在 30 分钟内只看到 3 条基础线路，且用户在这期间建的记录可能落在预期外的线路上。catch 还吞掉了异常、未设置 `this.error`，日志只有 `message` 没有 `name/stack`，也没有 `.tag('FAILED')`（对照 `root.ai.md` §日志相关 5） |
| 2 | `adapter.ts:386-404` | 只取系统线路，未聚合**自定义线路**（`ListCustomLine`，`GET /v2.1/customlines`）与**线路分组**（`ListLineGroups`，`GET /v2.1/linegroups`）——而 `CreateRecordSetWithLine` 文档明确 `line` 的取值可来自这两者。结果是：使用自定义线路的既有记录在列表里显示原始 id、无法按线路筛选，编辑时下拉还被禁用（P1-3） |
| 3 | `adapter.ts:447` | `Line: safeString(row.line) \|\| '0'` 仍是旧哨兵。缺 `line` 字段的记录会回读成 `'0'`，与新的 id 空间不一致，下拉匹配不上、筛选也筛不到。应改成 `'default_view'`，或干脆不回填哨兵 |
| 4 | `adapter.ts:386-393` | 响应未定型也未校验：`res` 走 `Dict` 默认泛型，`res.lines` 为 `any`、`row` 隐式 `any`；缺 `id` 时会产出 `{ id: undefined }` 的选项，选中后提交 `line=undefined`。建议显式声明 `{ lines?: Array<{ id?: string; name?: string }> }` 并 `filter` 掉无效项 |
| 5 | `RecordForm.tsx:369,524` | `firstLine` 是死代码：`line` 状态由 `useState(initial?.line ?? defaultLine)` 初始化为 `string`，永不为 null/undefined，`line ?? firstLine?.value ?? '0'` 取不到 `firstLine`。它还制造了「显示值」与「提交值」两套来源，后续改动容易不一致。按 §客户端架构 2（禁止重复/自由发挥）应删除 |
| 6 | `server/src/lib/dns/providers/huawei/__tests__/`（不存在） | 零测试覆盖。仓库已有 `providers/tencenteo/__tests__`、`providers/virtual/__tests__` 先例，本次至少应覆盖：`getRecordLines` 的字段映射、`default_view` 置首、API 失败兜底、`updateDomainRecord` 请求体不含 `line` |
| 7 | `RecordForm.tsx:517-527` | 编辑态下拉被禁用但没有任何提示（`tips` 只在「单线路」分支出现），用户不知道为什么改不了；同时 `payload.line` 仍照常提交（服务端忽略），前后端各自「半开」，语义不清 |
| 8 | PR 描述 / `59f93ed` | 提交信息只有标题、无详细描述，PR body 为空（`root.ai.md` §提交相关 1 要求「提交信息需要详细说明变更内容」）；作者自述「已经验证修改部分的功能」，未覆盖建记录与自定义线路场景 |

## 四、P3 / 建议

1. `updateDomainRecord` 的 `line` 形参已无用处，改名 `_line` 并补一行注释说明「华为云不支持修改线路」，避免后来者以为漏传。
2. `getRecordLines` 的失败日志建议 `log.sub('Lines').tag('FAILED').warn(msg, { error, stack })`，与 §日志相关 2/5 的标签与上下文要求一致。
3. `ListSystemLines` 支持 `locale` 参数（默认 `zh-cn`），当前固定中文线路名。与仓库其他提供商（返回中文线路名）一致，**不算缺陷**；若后续做多语言可传 `locale`。

## 五、经核实无问题（防止后续误改）

1. **字段映射正确**：`ListSystemLines` 响应为 `{ lines: [{ id, father_id, name }], metadata }`，PR 取 `row.id / row.name` 正确；`father_id` 不参与展示无影响（示例中 `DEFAULT / REGION / ISP` 只作为父级标识出现，不是可选项）。
2. **不需要分页**：`ListSystemLines` 的 `limit` 默认 1000，系统线路总量远小于 1000，不传 `limit/offset` 是安全的。
3. **从 `UpdateRecordSets` 移除 `line` 是对的**：官方表 3 请求体只有 `name / description / type / ttl / records / weight`，确实没有 `line`；响应里仍回显 `line`，那是只读字段，不构成「其实能改」。
4. **线路筛选可用**：`ShowRecordSetByZone`（`GET /v2.1/zones/{zone_id}/recordsets`）的 Query 参数包含 `line_id / offset / limit / name / type / status / search_mode`，所以 `getDomainRecords` 传 `line_id` 有效，**不要**按 v2 的 `ListRecordSetsByZone`（仅 `marker`）去改成 marker 分页。
5. **兜底三条 ID 是真实 ID**：`default_view / CN / Abroad` 均出现在官方《解析线路类型》基础线路表中，不要改成 `0/1/2`。
6. **请求链路合规**：新增调用走 `this.client.request` → `fetchWithFallback`，未直接使用原生 `fetch`，符合 §DNS 提供商适配器 1 的强制要求。
7. **顺带修掉一个隐患**：旧代码每次编辑都发送 `line: line || '0'`；若华为云把未知线路归一为默认线路，旧行为等于「每次编辑都把非默认线路重置为全网默认」。本 PR 移除后该风险消失——这一点值得写进 CHANGELOG。

## 六、建议的修复顺序

1. **P1-1**（适配器归一 `'0'` → `default_view`）：一行改动，直接决定建记录是否可用，先做。
2. **P1-2**（`default_view` 置首 + 用例）：防止错建到地区线路且不可回改。
3. **P1-3**（能力位 `lineEditable` + 服务端显式拒绝 `line` 变更）：去掉硬编码与静默失败。
4. **P1-4**（`docs/api.md`）：补线路取值与「创建后不可改」的说明。
5. P2-1 / P2-2（兜底不入缓存、聚合自定义线路）可排到下个迭代，但要在 CHANGELOG 的「已知问题」里写明「自定义线路暂不支持」。

## 七、附：可直接套用的最小补丁

```ts
// server/src/lib/dns/providers/huawei/adapter.ts
async addDomainRecord(name: string, type: string, value: string, line?: string, ttl = 600, _mx?: number, weight?: number, remark?: string) {
  // 华为云线路 ID 取 ListSystemLines 的 id；'0' 是 HiDNS 历史哨兵（阿里云式），不是华为云线路
  const effectiveLine = line && line !== '0' ? line : 'default_view';
  // ...body 中 line: effectiveLine
}

async getRecordLines(): Promise<Array<{ id: string; name: string }>> {
  try {
    const res = await this.client.request<{ lines?: Array<{ id?: string; name?: string }> }>('GET', '/v2.1/system-lines');
    const lines = (res.lines ?? [])
      .filter((row) => row && row.id)
      .map((row) => ({ id: String(row.id), name: String(row.name ?? row.id) }));
    if (!lines.length) throw new Error('empty system-lines');
    // 前端按「首项 = 默认线路」取值，必须把 default_view 排首位
    lines.sort((a, b) => (a.id === 'default_view' ? -1 : b.id === 'default_view' ? 1 : 0));
    return lines;
  } catch (e) {
    this.error = e instanceof Error ? e.message : String(e);
    log.sub('Lines').tag('FAILED').warn('getRecordLines failed', {
      error: this.error,
      stack: e instanceof Error ? e.stack : undefined,
    });
  }
  return [
    { id: 'default_view', name: '全网默认' },
    { id: 'CN', name: '中国大陆' },
    { id: 'Abroad', name: '境外' },
  ];
}
```

```tsx
// client/src/components/RecordForm.tsx —— 去掉死代码 firstLine
<Select
  disabled={isLineDisabled}
  value={String(line ?? '0')}
  options={lineOptions}
  filterable={lineNeedsFilter}
  onChange={handleLineChange}
/>
```

## 八、归属判定：架构既有 vs 本 PR 引入

只看「这条问题是谁引入的」，本报告 12 条可拆成三类。分开看之后结论会变：**本 PR 自身的缺陷最高只到 P1-3 / P1-4（静默丢参数、文档未同步）**，其余 P1 的根因都在既有架构里，本 PR 是「撞上/放大/该顺手修而未修」。

| 条目 | 归属 | 判定依据 | 若只算 PR 自身 |
| --- | --- | --- | --- |
| P1-1 `'0'` 未归一化 | **既有缺陷（本 PR 未修，且新增了第二套口径）** | 建记录发 `'0'` 是 pre-PR 行为（`72e18d8^` 版 adapter 同样是 `line \|\| '0'`，路由 `line ?? '0'`、工作流硬编码 `'0'` 均在本 PR 之前）；本 PR 把兜底值改成 `'default_view'`，与 `'0'` 并存 → 观感上「已修」 | 不计（仅新增一处口径不一致，P2 级） |
| P1-2 默认线路取 `lines[0]` | **既有假设，被本 PR 的数据源变更激活** | `defaultLine` 逻辑在 `RecordForm.tsx` 既存（所有提供商共用）；pre-PR 华为返回硬编码 5 条且首条就是 `{id:'0',name:'默认'}`，错位风险为零；本 PR 换成 API 顺序不定的数百条线路后风险才成立 | 不计（但**合并瞬间生效**，见下方放行口径） |
| P1-3 静默丢弃 `line` + 客户端硬编码 providerType | **一半既有（能力模型缺位）／一半本 PR（新代码）** | 移除 update 的 `line`、新增 `providerType === 'huawei'` 分支都是本 PR；`DnsCapabilities` 没有「可编辑性」位是既有设计 | P1（静默失败属新引入行为） |
| P1-4 `docs/api.md` 未同步 | **本 PR（流程）** | 规范既有，本次变更未带文档 | P1（项目规则明文「否则视为未完成」） |
| P2-1 兜底值被缓存 30 分钟 | **既有缓存机制，本 PR 首次可触发** | `routes/domains.ts:1256-1275` 的缓存逻辑既有；pre-PR `getRecordLines` 不发网络请求、不会返回兜底值 | P2 |
| P2-2 未聚合自定义线路/线路分组 | **一半架构（接口抽象不足）／一半 PR 完成度** | `getRecordLines(): Array<{id,name}>` 这个签名表达不了层级（`father_id`）、区分不了系统/自定义；PR 目标写的是「完善线路支持」 | P2 |
| P2-3 `mapRecord` 仍回填 `'0'` | **既有代码，本 PR 使其失效** | `adapter.ts:447` 本 PR 未改；`'0'` 与新的 id 空间不再对应 | P2 |
| P2-4 响应未定型/未校验 | **本 PR（新代码）** | 新增的 `getRecordLines` 实现 | P2 |
| P2-5 `firstLine` 死代码 | **本 PR（新代码）** | 新增行 369/524 | P2 |
| P2-6 零测试 | **既有惯例 + 本 PR 未加测** | 仓库多数 provider 同样无测试；但本次新增了网络请求 + 兜底分支 | P2 |
| P2-7 禁用无提示 / payload 仍提交 | **本 PR（新代码）为主** | `isLineDisabled` 是本 PR 新增；`payload.line` 照常提交是既有写法 | P2 |
| P2-8 提交信息/PR 描述 | **本 PR（流程）** | — | P2 |

### 与本 PR 无关、但真正该单独立项的架构问题

这几条不该算在作者头上，但继续留着，下一个改线路的提供商还会再撞一次：

1. **`line` 字段一词多义**：`routes/records.ts:468-474` 与 `RecordForm.tsx:340-341` 把它同时当「线路 ID」和「Cloudflare / AliyunESA 的代理开关（0/1）」。应由 `proxied` 独立承载，`line` 只表示线路。这是本次所有线路问题的总根因。
2. **「首项即默认线路」的隐式契约**：`RecordForm.tsx:145-149`、`aliyun`/`baidu` 的实现都依赖它，但没有任何类型或校验保证。应改为按 id 显式选默认，或在 provider 契约里要求 `getRecordLines()` 把默认项置首并有断言。
3. **`getRecordLines` 接口抽象不足**：签名是扁平 `Array<{id,name}>`，表达不了层级（华为 `father_id` 三级）、表达不了「创建后不可改」、表达不了「系统线路 vs 自定义线路」。能力位（`DnsCapabilities`）也缺 `lineEditable` 这一维。
4. **默认值分散在三层没有单一归一化点**：`routes/records.ts` 注入 `'0'`、工作流硬编码 `'0'`、adapter 兜底 `'default_view'`、各提供商哨兵各不相同（`'0'`、`'ct'`、`'default_view'`、`'proxied 0/1'`）。应在适配器层统一「未指定 → 默认线路」的归一化，路由与工作流不再猜。
5. **`/api/domains/:id/lines` 把失败兜底也写入 30 分钟缓存**：缓存层没有「失败不落盘 / 短 TTL 降级」策略，一条坏数据会存活半小时，对所有提供商通用。

### 放行口径（按归属修正）

- 若只审「本 PR 自己写出了什么」：P1-3、P1-4 打回，其余是 P2，可以合。
- 但 P1-2 的风险由「本 PR 的数据源变更」触发、且**在合并那一刻生效**（线路错建后不可改）。所以放行条件应当是二者之一：① 本 PR 内加 2 行排序（成本最低、可归作者）；② 先单独合并前端 `defaultLine` 的架构修复（另开 PR，但要排在合并之前）。
- P1-1 属于「既有 + 本次该顺手修」：作者没有义务修历史债务，但这是一行改动，且不修则「网页能建、API 不能建」的半通状态继续存在——建议作为合并条件提出，而不是作为缺陷归属提出。

## 九、历史溯源：这笔账在 v0.0.0.1-beta 就埋下了

维护者指出「这些问题源自内测版 0.0.1，贯穿了整个周期；架构上做了分离重构，但细枝末节没被留意」。用 tag 与 `git log -S` 逐条核实，**说法成立，且能精确到四段血缘**：

| 语义 | 起源 | 证据 | 中途是否被重构清理 |
| --- | --- | --- | --- |
| `'0'` 作为线路哨兵（adapter 的 `line \|\| '0'`） | **v0.0.0.1-beta（tag @ `7b14138`，2026-04-06）** | `git show v0.0.0.1-beta:server/src/lib/dns/providers/huawei.ts` → 270 行 `line: line \|\| '0'`、320 行同 | 否。`72e18d8`（2026-04-27「DNS提供商完全模块化重构」）把文件搬进 `providers/huawei/`，该行原样带过；`4ae4f1e`（日志重构）仍未动 |
| `getRecordLines` 返回硬编码假线路 | 同上，0.0.1 | 同文件 362-363 行，注释原文「Return basic lines, full list requires loading from JSON file」 | 否。这条注释一直保留到本 PR 才被删 |
| 路由层 `line ?? '0'` 全局注入 | `9e0bb03`（2026-04-10 `fix(cloudflare): API 默认使用仅DNS模式，避免意外开启代理`） | `git log -S "line ?? '0'" -- server/src/routes/records.ts` | 否。一个**为 Cloudflare 代理开关写的默认值**被扩散成所有提供商的线路默认值——`line` 一词多义就此固化 |
| 前端「首项 = 默认线路」 | 0.0.1 的 `initial?.line ?? (lines[0]?.id ?? '')` | `git show v0.0.0.1-beta:client/src/components/RecordForm.tsx` 102 行 | 否。现行写法由 `c5319b4`（2026-05-16）改写为 `defaultLine`，假设未变 |
| 工作流硬编码 `'0'` | **不是 0.0.1，是 `2818ead`（2026-10-19）** | `server/src/workflow/actions/dns/record.ts:114/194` | — 属「遗产被继续复制」：新代码照着老约定又写了一遍 |

结论有两层：

1. **归属上，本 PR 只背 P1-3 的后半、P1-4 与 P2-4/2-5/2-7/2-8**；P1-1、P1-2、P2-1、P2-3 是 0.0.1 的存量债务，写进评审不是为了追责，而是为了说明「为什么一行兜底改不掉」。
2. **责任上，模块化重构（`72e18d8`）确实漏了这些**。漏的原因不是粗心，而是重构的边界定义在「文件与 import 图」，而线路语义从来没被单点定义过：`line` 的含义分散在 route（`'0'`/`'1'` 代理开关）、form（`lines[0]` 即默认）、adapter（`line \|\| '0'`）、provider（各自哨兵）四处，**任何一处单独改动都会让其它三处失效**，所以细枝末节必然留下。同样因为仓库没有 provider 契约测试，这类语义错位不会被任何门禁拦住。

### 建议的治理路线（四步，每步可独立合入、可回滚）

1. **语义拆分**（解掉总根因）：API 增加 `proxied?: boolean`，Cloudflare / AliyunESA 只认它；`line` 从此只表示线路。兼容期 route 同时接受 `cloudflare.proxied` 与旧 `line: '0'/'1'`，用日志计数确认无调用方后再删旧路径。
2. **契约扩展**：`DnsCapabilities` 增 `lineEditable: boolean`、`defaultLineId?: string`；`getRecordLines()` 返回项扩为 `{ id, name, parentId?: string, kind?: 'system' | 'custom' | 'group' }`（华为的 `father_id` 与 ListCustomLine/ListLineGroups 正好装得进去）。属于扩展字段，22 个 provider 可渐进迁移。
3. **归一化收口**：新增 `server/src/lib/dns/line-resolve.ts`，唯一函数 `resolveLine(providerType, capabilities, raw) → { lineId, editable }`：`undefined / '' / '0'` → `capabilities.defaultLineId ?? '0'`；route 与 workflow 不再自己拼默认值。这一步做完，P1-1 这类问题不会再复发。
4. **契约测试 + 缓存策略**：每个 provider 一个最小用例（`getRecordLines()` 首项 id 必须等于 `defaultLineId`；create 请求体的 `line` 必须属于列表 id 集，adapter 用 HTTP mock）；`/api/domains/:id/lines` 改为「失败不落盘、正常值才缓存」，避免一次抖动毒化 30 分钟。

落地顺序建议 1 → 3 → 2 → 4：先拆语义、再收口归一化；能力位与返回结构可随各 provider 逐个补，最后用契约测试把口子焊死。

## 十、参考

- 华为云《查询系统线路 ListSystemLines》：<https://support.huaweicloud.com/api-dns/ListSystemLines.html>
- 华为云《创建记录集 CreateRecordSetWithLine》：<https://support.huaweicloud.com/api-dns/dns_api_64001.html>
- 华为云《修改记录集 UpdateRecordSets》：<https://support.huaweicloud.com/api-dns/UpdateRecordSets.html>
- 华为云《查询域名下的记录集列表 ShowRecordSetByZone》：<https://support.huaweicloud.com/api-dns/dns_api_64004.html>
- 华为云《解析线路类型》（线路 ID 全表）：<https://support.huaweicloud.com/api-dns/zh-cn_topic_0085546214.html>
- 华为云《查询自定义线路 ListCustomLine》`GET /v2.1/customlines`、华为云《查询线路分组列表 ListLineGroups》`GET /v2.1/linegroups`