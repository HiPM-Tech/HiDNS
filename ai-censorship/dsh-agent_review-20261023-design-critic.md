# HiDNS 评审记录 · 视觉与细节一致性

评审员：design-critic（视觉评审）
环境：前端 http://localhost:5173（Vite dev）/ 后端 3001 / 隔离库 /tmp/cend/data/app.db
会话：复用 /tmp/cend/state.json（未触发登录限流）
方式：Playwright 实渲染截图 + DOM 计算样式采集 + 截图逐像素取样（对比度/明度跨度），**只读审计，未改动任何代码**

---

## C 端细节轮

### 结论摘要

本轮覆盖服务监控三子页（SSL 证书 / 端点探测 / DNS 故障转移）、NS 监控、域名续期、工作流编辑器，以及暗色与 1280/1024/768 三档窄屏。

- **未发现 P0（功能不可用）**：所有页面可加载、弹窗可开合、表格可横向滚动到达最后一个操作、分页禁用态正确。
- **2 个 P1**：① 1024/768 下表格单元格竖排换行，数据可读性崩塌；② 暗色下卡片与页面底色的层次反转（1.05:1）。
- **其余为 P2 细节**：量词/动词/空态句式不统一、卡片内距两套标准、背景图在数据稀疏页仍抢注意力。
- 颜色与字号本身达标：主色白字 5.03:1、次要文字 6.13:1、「未检测」徽标 5.60:1，均过 AA。

| # | 严重度 | 一句话 |
|---|---|---|
| 1 | P1 | 1024/768 表格单元格逐字竖排（未检测 / 8 分钟前 / 5 分钟全断行） |
| 2 | P1 | 暗色卡片比页面底色更暗或同色，浮起感靠 1px 边框独撑 |
| 3 | P2 | 同一页两种量词：「共 N 项」vs「共 N 条」 |
| 4 | P2 | 三处空态三套句式，且都无图标 |
| 5 | P2 | 「还没有DNS 故障转移监控」中英文间缺空格 |
| 6 | P2 | 按钮动词四套：新增 / 新建 / 添加 / 导入 |
| 7 | P2 | 服务监控页缺搜索筛选（NS/续期都有） |
| 8 | P2 | 卡片内距两套：三页 p-4(16px) vs 工作流 27px |
| 9 | P2 | 工作流表格 record.changed / call 未本地化 |
| 10 | P2 | 工作流编辑器弹窗底部「保存」需滚动 370px 才可见，无 sticky footer |
| 11 | P2 | 控制台背景图在数据稀疏页仍抢注意力（明度跨度 26–31/255 且形状可辨认） |

---

### 发现 1 · 窄屏表格逐字竖排（P1）

**复现**：登录 → 资源 / 服务监控 → 浏览器宽度调到 1024（保持侧边栏展开）或 768。观察「状态 / 响应 / 最近检测 / 周期」四列。
**期望**：单元格内容不换行，表格在容器内横向滚动（列宽有下限）。
**实际**：徽标「未检测」被拆成三行竖排（未 / 检 / 测），"6571 ms" 断成 "6571 / ms"，"8 分钟前" 断成 "8 分 / 钟前"、"5 分钟" 断成 "5 / 分 / 钟"；表头「最近检测」「周期」同样折行。1024 与 768 两档都复现。
**根因**：`client/src/ui/table.tsx:27`（TableHead）与 `:34`（TableCell）没有 `whitespace-nowrap`，表格 `w-full` 自动布局在 7 列被压缩时只能靠折行消化宽度。
**截图**：`design-critic-cend-svc-ssl-w1024.png`、`design-critic-cend-svc-ssl-w768.png`、`design-critic-cend-renewal-w1024.png`

### 发现 2 · 暗色下卡片与页面底色层次反转（P1）

**复现**：顶栏点「切换主题」进入暗色 → 服务监控页 → 观察卡片与卡片下方留白。
**期望**：卡片（elevation-1）比页面底色更亮，边界由亮度和边框双重表达。
**实际**：页面留白取样 **#1e232d ~ #090e19**（随背景图漂移），卡片 **#161d30**，对比 **1.05:1**，且在图片较亮区**页面比卡片更亮**——卡片看起来"凹进"页面；侧栏 #161e31 与卡片 #161d31 几乎同色，结构只剩 1px 边框。
**量化**：卡片/页面 1.05:1（浅色为 1.28:1）；同一页面内留白区亮度从 #1e232d 漂到 #090e19（差约 21/255），说明页面底色本身不稳定，卡片无法用固定亮度建立层级。
**截图**：`design-critic-cend-svc-ssl-dark.png`、`design-critic-cend-workflows-dark.png`

### 发现 3 · 同一页面两种量词（P2）

**复现**：服务监控页，看卡片副标题与底部分页条。
**期望**：同一实体全页统一量词。
**实际**：副标题「…；共 **3 项**」（features/domains/service-monitor-tab.tsx:68），分页条「每页 20 **条** · 共 **3 条**」（ui/pagination.tsx:41）。同类不一致：NS 监控用「共 N **条**」，续期用「共 N **个**可续期域名」。
**截图**：`design-critic-cend-svc-ssl-light.png`、`design-critic-cend-ns-monitor-light.png`、`design-critic-cend-renewal-light.png`

### 发现 4 · 空态三套句式且无图标（P2）

**复现**：服务监控 → 切到「端点探测」「DNS 故障转移」；NS 监控；域名续期（均为空列表）。
**期望**：空态统一为"图标 + 一句说明 + 一个主行动"。
**实际**：三页三种句式且全部纯文字无图标：
- 「还没有端点探测监控」（无行动指引）
- 「还没有 NS 监控，点击「新增监控」开始」（有指引）
- 「还没有可续期域名，点击「添加域名」从提供商导入」（有指引且带来源说明）
**截图**：`design-critic-cend-svc-endpoint-light.png`、`design-critic-cend-svc-failover-light.png`、`design-critic-cend-ns-monitor-light.png`、`design-critic-cend-renewal-light.png`

### 发现 5 · 中英文之间缺空格（P2）

**复现**：服务监控 → DNS 故障转移 子页（空列表）。
**期望**：「还没有 DNS 故障转移监控」（中文与拉丁字母之间留空格，与「还没有 NS 监控」一致）。
**实际**：「还没有DNS 故障转移监控」——service-monitor-tab.tsx:130 用 `还没有{MONITOR_TYPE_LABEL[type]}监控` 拼接，标签本身以 "DNS" 开头，导致空格丢失。
**截图**：`design-critic-cend-svc-failover-light.png`

### 发现 6 · 按钮动词四套（P2）

**复现**：依次打开 服务监控 / NS 监控 / 域名续期 / 工作流 四个列表页。
**期望**：同一语义（创建）在同一产品内统一一个动词。
**实际**：「新增监控」「新增域名」「**添加**域名」（续期页）「**新建**工作流」四种写法并存；且续期页按钮叫「添加域名」，动作实为"从提供商导入"，按钮动词与动作不符。
**截图**：`design-critic-cend-renewal-light.png`、`design-critic-cend-workflows-light.png`

### 发现 7 · 服务监控缺搜索/筛选（P2）

**复现**：对比三个子页工具栏。
**期望**：同一层级的列表页提供一致的检索能力。
**实际**：NS 监控（ns-monitor-tab.tsx:103）与续期（renewal-tab.tsx:103）都有「搜索域名」+ 筛选；**服务监控没有搜索框**，只有类型 tab。当前库内已有 13 条监控记录（含其他评审注入的 adv-* 数据），只能逐页翻找。
**截图**：`design-critic-cend-svc-ssl-dark.png`（13 条）、`design-critic-cend-ns-monitor-light.png`

### 发现 8 · 卡片内距两套标准（P2）

**复现**：对比服务监控卡片与工作流卡片的内容到边框距离。
**期望**：全站卡片内距统一为 tokens 的 `--pad-card` 27px。
**实际**：三个域名监控页都覆盖成 `p-4`（16px，service-monitor-tab.tsx:64 / ns-monitor-tab.tsx:78 / renewal-tab.tsx:76），工作流页用默认 27px。同屏对比时留白明显不齐。
**截图**：`design-critic-cend-svc-ssl-light.png` vs `design-critic-cend-workflows-light.png`

### 发现 9 · 技术值未本地化（P2）

**复现**：工作流列表表格。
**期望**：触发器显示「解析记录变更」，动作显示「调用」。
**实际**：触发器原样显示 `record.changed`、动作原样显示 `call` 内部枚举；而同一行的编辑器里同名字段显示为「解析记录变更」「列出解析记录」——列表与详情两套措辞。
**截图**：`design-critic-cend-workflows-light.png`、`design-critic-cend-workflow-editor-light.png`

### 发现 10 · 编辑器弹窗底部操作需长滚动（P2）

**复现**：工作流页 → 点某行「编辑」→ 不滚动直接找「保存」。
**期望**：长表单弹窗使用 sticky footer，主操作常驻可见。
**实际**：弹窗高 792px、内容高 1162px（溢出 370px），「保存」初始位于视口外（top≈1165），必须滚动到底部才可见；`overflow-y:auto` 生效但无滚动提示。
**截图**：`design-critic-cend-workflow-editor-light.png`

### 发现 11 · 控制台背景图仍抢注意力（P2）

**复现**：任一数据稀疏的控制台页（工作流、空态页）。
**期望**：背景图退成"底纹"。
**实际**：控制台 scrim 0.80（浅）/0.86（深）下，内容区背景明度跨度仍有 **26–31/255**，且插画的大尺度形状（人物、服饰）可辨认；在工作流这种只有一行数据的页面上，视觉重心明显被背景夺走。
**量化**：取样 `design-critic-cend-svc-failover-light.png` 空白区 min #e9e3e6 / max #ffffff（跨度 26.5）。
**截图**：`design-critic-cend-workflows-light.png`、`design-critic-cend-svc-failover-light.png`

---

### 通过项（复核后无问题）

| 检查点 | 结果 |
|---|---|
| 按钮禁用态 | 分页「上一页/下一页」disabled + opacity .5 + cursor: default，空列表页正确禁用 ✓ |
| 徽标对比度 | 「未检测」#52637a / #f1f5f9 = **5.60:1** ✓；徽标字号 12px、内距 2×8 一致 ✓ |
| 暗色文字对比度 | 次要文字 #a3b0c2 于卡片 #161d30 ≈ **7.5:1** ✓；侧栏导航文字可读 ✓ |
| 弹窗窄屏可用性 | 768 下弹窗 576px 宽、左右各留 96px，不裁切 ✓（`design-critic-cend-dialog-addmonitor-w768.png`） |
| 窄屏导航 | 768 下自动切抽屉（侧栏 x=-232），顶栏出现汉堡按钮 ✓ |
| 横向溢出 | 1280/1024/768 三档 document.scrollWidth == innerWidth，无页面级横向滚动 ✓ |
| 工作流表格滚动 | 768 下 overflow-x:auto 可滚 41px，删除按钮可达 ✓（`design-critic-cend-workflows-w768-scrolled.png`） |
| 中文标点 | 副标题统一用「；」连接描述与计数，空态统一用直角引号「」 ✓ |
| 时间单位 | 弹窗「检测周期（秒）」300 与表格「5 分钟」换算一致；「到期前告警天数」30 ✓ |

---

### 建议的修复优先级（供研发排期）

1. **P1-1**：`ui/table.tsx` 给 TableHead/TableCell 补 `whitespace-nowrap`，并给 Table 外层容器一个最小宽度（如 `min-w-[720px]`），让窄屏走横向滚动而不是逐字折行。
2. **P1-2**：暗色把 `--panel-alpha` 提到 1，并让 `--card` 与页面底色重新拉开（如 14% → 17%），或控制台 scrim 升到 0.90，让"卡片 > 页面"重新成立。
3. **P2 批量**：量词统一（建议列表一律「条」）；动词统一为「新建」；空态统一为"图标 + 说明 + 主按钮"；`还没有{label}监控` 改为 `还没有 {label} 监控`。
4. **P2**：三个监控页 `p-4` 改为 `p-phi-8`（27px）与全站对齐；服务监控补搜索框；工作流列表补触发器/动作的中文映射。

> 备注：本轮数据库中出现 `adv-int0 / adv-warmbig / adv-loop / adv-atip / adv-userinfo / adv-portmax` 等记录，鉴定为其他评审通道注入的测试数据，非产品缺陷，未计入。

---

## 代码审核团评审

**评审范围**：`fd855871..HEAD`（7 个提交，含 2 个 docs 提交）
**方式**：只读静态审查 + 真实环境实测（Vite dev 5173 + 隔离库，复用会话；结论均为浏览器内实测，未改代码、未写入数据）
**专项检查**：nowrap 溢出 / 空态图标 / 卡片内距 / 弹窗固定底栏 / 文案动词 / 暗色层次

### 结论

- **P0：0 条；P1：2 条；P2：3 条。**
- 六项专项里 **4 项通过**：nowrap 未造成页面级横向滚动（三档 `doc.scrollWidth == innerWidth`，表格在容器内滚动）、空态图标对齐居中（offCenterX=0、gap=8px）、工作流弹窗 1280×800 / 1280×768 / 1024×700 三档「保存」均常驻可见、暗色层次已修正（卡片 #161d30 亮于页面 #0c1220，1.12:1，方向正确）。
- **2 项未通过**：审计日志表格在 1440 桌面宽度就溢出（nowrap 的副作用）；三张监控卡片顶部内距被改没了（标题贴边 1px）。

### P1-1 · 审计日志表格在 1440 也横向溢出，详情列被切断

- **`client/src/ui/table.tsx:34`**（`TableCell` 全局加 `whitespace-nowrap`）+ **`client/src/features/audit/audit-page.tsx:148`**（详情 span `max-w-2xl truncate`）
- **问题**：nowrap 使各列不再能被压缩，详情列内 `truncate` 的 span 以 `max-w-2xl`（672px）参与表宽计算，整表被撑到 **1134px**，而容器只有 **1084px**（1440 视口）。
- **影响**：审计页在标准桌面宽度出现 50px 横向溢出，详情列末尾被卡片边缘切断且**没有省略号**；实测把 `white-space` 还原为 normal 时溢出为 0，说明是本批改动引入（此前该页在 1440 恰好放下）。1024 下溢出 466px，768 下 446px。
- **修复**：把详情列上限从 `max-w-2xl` 收到 `max-w-xl`（576px）——实测溢出 50 → **0**。

```diff
- <span className="block max-w-2xl truncate text-xs text-muted-foreground" title={auditDetail(log.data)}>
+ <span className="block max-w-xl truncate text-xs text-muted-foreground" title={auditDetail(log.data)}>
```

> 更彻底的做法：`ui/table.tsx` 只在 `TableHead` 上保留 nowrap，`TableCell` 改为按需传入，避免"长文本列"再触发同类问题。

### P1-2 · 三张监控卡片顶部内距变成 0，标题贴卡片上沿

- **`client/src/features/domains/service-monitor-tab.tsx:64`**（`CardContent className="space-y-3"`）、**`ns-monitor-tab.tsx:78`**、**`renewal-tab.tsx:76`** 同一改法
- **问题**：本轮把 `p-4` 换成默认的 `CardContent`（`ui/card.tsx:33` = `p-phi-8 pt-0`），但这三处 Card 内**没有 CardHeader**，`pt-0` 没有对应的头部来补内距。
- **影响**：实测卡片内首个文字距卡片上沿 **1px**（padding-top = 0），而工作流卡片是 **28px**；三页标题紧贴边框、与其余页面明显不齐，视觉上像"内容顶出卡片"。
- **修复**：补回上内距即可（不必引入 CardHeader）：

```diff
- <CardContent className="space-y-3">
+ <CardContent className="space-y-3 pt-phi-8">
```

> 三页同改；改完与工作流卡片（27px 四周）一致。

### P2-1 · 服务监控搜索框没有防抖，逐字符发请求

- **`client/src/features/domains/service-monitor-tab.tsx:66-77`**（`onChange` 里直接 `setKeyword(next.trim())` 并 `setPage(1)`，`keyword` 进入 queryKey）
- **问题**：每敲一个字符就换一次 queryKey → 一次请求。实测输入 9 个字符触发 **16 次** `/api/servicemonitor` 请求；同批次的 NS 监控（`ns-monitor-tab.tsx:34-38`）与续期（`renewal-tab.tsx:27-31`）都用 300ms 防抖。
- **影响**：输入时列表反复 loading、闪烁；服务端被打满（多管理员同时搜索时更明显）。
- **修复**：复用另外两页的写法：

```diff
 const [keywordInput, setKeywordInput] = useState('');
 const [keyword, setKeyword] = useState('');
+useEffect(() => {
+  const timer = setTimeout(() => { setKeyword(keywordInput.trim()); setPage(1); }, 300);
+  return () => clearTimeout(timer);
+}, [keywordInput]);
@@
-                onChange={(event) => {
-                  const next = event.target.value;
-                  setKeywordInput(next);
-                  setKeyword(next.trim());
-                  setPage(1);
-                }}
+                onChange={(event) => setKeywordInput(event.target.value)}
```

### P2-2 · 空态文案仍缺空格，且三页句式不统一

- **`client/src/features/domains/service-monitor-tab.tsx:150`**：`<TableEmpty colSpan={7}>还没有{MONITOR_TYPE_LABEL[type]}监控</TableEmpty>`
- **问题**：本轮给 `TableEmpty` 加了 Inbox 图标，但文案拼接未改，实测渲染为「还没有**SSL 证书监控**」（中英文之间无空格）；NS 页是「还没有 NS 监控，点击「新增监控」开始」、续期页是「还没有可续期域名，点击「添加域名」从提供商导入」。
- **影响**：三页空态三种句式，且服务监控页缺少行动指引；空格缺失是肉眼可见的排版瑕疵。
- **修复**：

```diff
- <TableEmpty colSpan={7}>还没有{MONITOR_TYPE_LABEL[type]}监控</TableEmpty>
+ <TableEmpty colSpan={7}>还没有 {MONITOR_TYPE_LABEL[type]} 监控，点击「新增监控」开始</TableEmpty>
```

### P2-3 · 创建动词仍有第三套：MCP 页保留「新建」

- **`client/src/features/mcp/mcp-page.tsx:73,75,325,376`**（「新建 API 密钥」「新建 OAuth 客户端」）
- **问题**：本批已把工作流、记录等页的「新建」统一成「新增」（`workflows-page.tsx:75,308`、`records-page.tsx:133`），但 MCP 页漏改；同时团队页仍是「新增团队 / 添加成员 / 添加授权」、续期页仍是「添加域名」。
- **影响**：同一产品并存「新增 / 新建 / 添加」三种创建动词，与本次"文案统一"的提交目标不一致。
- **修复**：MCP 四处 `新建` → `新增`；团队页「添加成员/添加授权」语义确为"往既有团队里加"，可保留；续期页「添加域名」建议改「导入域名」以匹配实际动作（从提供商导入）。

### 通过项（本轮改动无问题）

| 检查点 | 实测结论 |
|---|---|
| 1. nowrap 是否引发页面横向滚动 | 1440/1024/768 三档全站 `docOverflow = 0`，表格在 `overflow-x: auto` 容器内滚动（除 P1-1 的审计页在 1440 溢出 50px） |
| 2. 空态图标 | 24×24、居中偏差 0px、图标-文字间距 8px，浅色 #52637a @0.5、暗色可见 ✓ |
| 3. 卡片内距 | 水平内距三页与工作流统一为 27px ✓（垂直方向见 P1-2） |
| 4. 工作流弹窗固定底栏 | 1280×800 / 1280×768 / 1024×700 三档「保存」均在视口内（saveVisible=true），内容区独立滚动 ✓ |
| 5. 暗色层次 | 页面 #0c1220 ~ #131721，卡片 #161d30，**1.12:1 且卡片更亮**——上轮"卡片凹陷"已修复 ✓ |
| 6. 禁用态 | 分页禁用保持 0.5 opacity + default cursor ✓ |

---

## 2.3.0 重构目标核对

> **本节只覆盖目标 1（前端的「审美与交互一致性」部分）**；目标 2–5 与 DNS 适配器语义由其他评审员核对。
> 复核对象：HEAD `9fd03ac6`（2.3.1 未发布），运行环境 http://localhost:5173 + 隔离库，只读实测（未改代码、未写数据）。

### 目标 1 · 前端整体重写：**部分达成**

**判定依据**：审美与一致性本身已可量化达标（字体层级、暗色、窄屏、弹窗、文案五项全 PASS）；但「抛弃旧组件库 / i18n / 样式组织」只做了一半——**3080 行遗留样式表仍在包内被引入**，且有活选择器引用已删除的变量。

| # | 结论 | 证据 |
|---|---|---|
| 1-1 | ✅ 字体层级令牌化完成 | `grep 'text-heading'` = **15 处**，`text-lg font-semibold` 遗留 = **0 处**；页面主标题实测 `h2 26px`；`grep 硬编码色值` = **0 处** |
| 1-2 | ❌ 旧样式组织未抛弃 | `client/src/styles/globals.css` 仍 **3080 行**：`--td-*` 引用 **149 处**、`.t-*` 规则 **109 条**，而 tsx 中使用这些类 = **0 处**；`client/src/index.css:2` 仍全量 `@import` 它 |
| 1-3 | ❌ 遗留样式含"活"的失效引用 | 已删除变量仍在生效选择器里：`globals.css:109-121` 滚动条 `::-webkit-scrollbar-track/thumb` 用 `--td-bg-color-page`/`--td-component-stroke`（运行时实测均为 undefined → 自定义滚动条静默失效）；`globals.css:79,1790,1829` 的 `min-height: var(--app-scaled-vh)` 实测 computed 为 **0px** |
| 1-4 | ⚠️ 间距令牌采用约四成 | `gap-phi-*` **32 处** vs `gap-3/gap-4` **43 处**；9 个文件用 `p-4/p-6` 覆盖 `CardContent` 默认 27px（accounts/audit/domains/mcp×2/oauth/records/setup/tokens/users） |
| 1-5 | ✅ 暗色模式达标 | 实测页面 `#0c1220~#131721`、卡片 `rgba(22,30,49,.98)` → **1.12:1 且卡片更亮**（方向正确）；次要文字 `#a3b0c2` / 卡片 ≈ **7.5:1** |
| 1-6 | ✅ 窄屏达标 | 1440/1024/768 三档、11 个页面全部 `documentElement.scrollWidth - innerWidth = 0`；表格改在容器内滚动（1024：86–370px，768：86–350px）；768 下侧栏切抽屉 |
| 1-7 | ✅ 弹窗达标 | 768 视口下工作流编辑器弹窗宽 576px 不裁切，头部/内容/底部三段式，**「保存」常驻可见**（saveVisible=true），内容区独立滚动 |
| 1-8 | ✅ 文案统一 | 分页统一「每页 20 条 · 共 N 条」；创建动词统一「新增」（MCP 的「新建」已改）；空态补齐 Inbox 图标；实测服务监控页「共 6 条」与标题行量词一致 |
| 1-9 | ✅ 可访问性（对比度/焦点） | 浅色次要文字 `#52637a`/白 = **6.13:1**，暗色 **7.5:1**；Tab 焦点环实测 `outline: solid 2px` |
| 1-10 | ⚠️ 标题语义与视觉不一致（P2） | 全站**唯一 `h1` 是顶栏 13px 面包屑**，页面主标题是 `h2 26px`；监控三子页的卡片标题是 `<p class="text-sm">`（14px，无 heading），与 `/dash/domains` 的 26px 形成落差 |
| 1-11 | ⚠️ 768 表格横向滚动无提示（P2） | `/dash/domains/servicemonitor` @768 表格需滚 94px，操作列的「编辑/删除」在视口外且无渐隐/滚动条提示 |
| 1-12 | ⚠️ 错误态未验证 | 无 500/断网场景可安全触发，本轮未实测（加载骨架、空态已覆盖） |

### 一句话结论

审美与交互一致性**已经达标**（字体层级、暗色、窄屏、弹窗、文案、对比度六项均有实测数据支撑）；但目标 1 的另一半「抛弃旧样式组织」**未完成**——3080 行 legacy CSS 仍随包发布且含失效变量引用，建议在 2.3.1 清理后即可判为完全达成。




### 修复状态（执行层回填，提交 `436443f9`）

| 编号 | 状态 | 说明 |
| --- | --- | --- |
| P1 审计表 1440 横向溢出 | ✅ 已修 | 详情列 max-w-2xl → xl；实测 table==box==1084 |
| P1 三张卡顶部内距 1px | ✅ 已修 | 补 pt-phi-8 |
| P2 搜索无防抖 | ✅ 已修 | 300ms |
| P2 空态缺空格 | ✅ 已修 | 「还没有 SSL 证书监控」 |
| P2 MCP 页仍用「新建」 | ✅ 已修 | 统一「新增」 |

### 第二轮验收（修复后复核）

| 评审 | 判定 | 说明 |
| --- | --- | --- |
| be-constraint-review | ✅ 通过（P0=0/P1=0） | P0 越权链闭合；WS 上限/索引对称；续期归属 PASS；非 failover domain_id 记 P2 |
| fe-arch-review | ✅ 通过（P0=0/P1=0） | 4005 停止重连、enabled/config 回填、审计列宽、pt-phi-8、防抖、MCP 用词均 PASS |
| adversarial-auditor | ✅ 通过（P0=0/P1=0） | 两道式改类型/置空/字符串 id 均无法绕过；续期归属 PASS |
| design-critic | ✅ 通过（阻塞项 274f3780 后复核） | 实测 POST/PUT type=endpoint + domain_id=999 → 200 且回读 domain_id=null |

最终：**四位评审一致通过，可合入**。

---

## 复审 1（f1022dd4）

> 复核对象：HEAD `f1022dd4`；范围同前，仅目标 1 的「审美与交互一致性」。
> 方式：只读 + 实跑（Vite dev 5173 实测、`npx vite build`、`npx vitest run src/styles/__tests__/legacy-css.test.ts`）。

### 判定：**PASS**（目标 1）

| 核验项 | 结果 | 证据 |
|---|---|---|
| legacy CSS 清理 | ✅ | `client/src/styles/globals.css` **3080 → 309 行**；`.t-*` **0**、`!important` **0**、`--td-*` 仅剩 1 处且**在注释里**（`:63`，门禁测试先剥离注释再断言）|
| 失效变量 | ✅ | 全仓 `grep -- '--td-\|--app-scaled-vh'` 命中仅 2 处：globals.css 注释 + 测试断言字符串；运行时 `--app-scaled-vh` 已无引用（此前 3 处 `min-height` 计算值 0px 的问题消失）|
| 门禁 | ✅ | 实跑 `legacy-css.test.ts` → **3 tests passed**（选择器/变量、!important、行数 <600）|
| 构建体积 | ✅ | 实跑 `vite build`：`dist/assets/index-*.css` = **40,528 B（40.53 kB）**，gzip **8,576 B（8.58 kB）**，与整改说明一致 |
| 视觉回归 · 三档布局 | ✅ 无回归 | 1440/1024/768 × 5 页，`docOverflow` 全 **0**；表格容器滚动量与整改前**逐项一致**（1024：svc 114 / records 140 / workflows 106 / audit 370；768：94/120/86/350）；无 console error |
| 视觉回归 · 暗色 | ✅ 无回归 | 卡片仍 `rgba(22,30,49,.98)`、`--scrim-alpha 0.93`、正文 `#f1f5f9`，与整改前完全一致；截图 `evidence/recheck-dark.png` |
| 视觉回归 · 基础样式 | ✅ | body 背景图（渐变+url，cover）、`Inter` 字体、页面色 `#0f1729`、滚动条 `8px / 4px` 圆角均保留 |
| 间距令牌比例 | ⚪ 未变化 | `gap-phi-*` **32** : `gap-3/gap-4` **43**（本批未涉及；属目标 1 的 P2 残留）|

### 仍存在的 P2（不阻断）

1. `client/src/styles/globals.css` 仍有 **5 条零引用选择器**：`.tab-btn.active::after`、`.servicemonitor-tabs-wrapper`、`.app-td-dialog`、`settings-image-preview__mask`、`.app-has-background`（tsx 中命中 0 处；`.team-member` 5 处、`.about-contributors` 1 处为活规则）。
2. 标题语义：全站唯一 `h1` 是顶栏 13px 面包屑，页面主标题为 `h2 26px`；监控三子页卡片标题仍是 `<p class="text-sm">`，无 heading。
3. 768 下表格横向滚动无可见提示（操作列在视口外）。

### 阻断项

**无。** 清理未引入任何视觉或布局回归，失效引用与门禁均已落地，目标 1 由「部分达成」转为 **PASS**。

