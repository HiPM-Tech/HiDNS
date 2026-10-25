# 前端视觉评审报告 · HiDNS

> 评审范围：`client/src` 全部公开页 + 控制台外壳 + 内容页样式层
> 证据来源：源码逐行核对、`ai-censorship/evidence/*.png` 现有截图、背景图服务实测响应头、WCAG 对比度实算脚本
> 约束遵守：只读评审，未改动任何源码；未引入新依赖（lucide-react 已有）

---

## 0. 结论摘要

1. **最该先修的不是"好不好看"，是"能不能看清"**：浅色主色按钮白字实测 **2.86:1**（AA 要求 4.5:1），`--muted-foreground` 落在 `bg-muted` 上 **4.29:1**，深色卡片对背景只有 **1.06:1** 的层次差。改这三个数值，观感提升比换十套配色都大。
2. **黄金比例不需要推倒重来**：现有 8px 基准、240 侧栏、20 内边距其实都"差不多"在 φ 网格附近，问题是**没有一条统一的阶梯**。本报告给出**一条** `8 × φ^(n/2)` 阶梯，间距、宽度、字号全从它取数，数值可直接落到 `tokens.css`。
3. **背景图不是"加一张图"，是改曝光策略**：浅色主题下半透明白卡压在任何照片上都保不住 4.5:1。可行解是**面板近实色（0.94）+ 让图只出现在负空间**，登录页则用 61.8/38.2 分栏把图放到"没有文字的 38.2%"里。
4. **背景图能力已经打通到数据库，只差最后一层渲染**：`settings` 存得进、`/auth/me` 吐得出，前端全仓 0 处消费。
5. **一个隐藏放大器**：`body { zoom: 0.9 }`（`styles/globals.css:8,74`）把所有 px 乘了 0.9——14px 正文实际渲染 12.6px。**任何 φ 数值写进去都会失真**，必须先处理它。

---

## 1. 现状诊断（10 条）

> 每条给出 文件:行号、现象、以及它造成的可感知后果。按严重度排序。

### 1.1 浅色主色按钮/链接对比度 2.86:1 —— 硬性不达标
`ui/tokens.css:18`（`--primary: 199 89% 48%`）+ `ui/button.tsx:11`（`bg-primary text-primary-foreground`）。
白字压在 `#0da2e7` 上 = **2.86:1**，连 3:1（大字号豁免线）都过不去。同色还被当作 12px 正文链接（`dashboard-page.tsx:163`「查看全部」），同样 2.86:1。深色模式下是 7.43:1 —— 说明**这是浅色专属失效**，登录页主按钮首当其冲。

### 1.2 次要文字在浅色弱底上跌破 AA
`ui/tokens.css:15`（`--muted-foreground: 215 16% 47%`）在纯白上是 **4.70:1**（勉强过），一旦落到 `bg-muted`（`#f1f5f9`）上就掉到 **4.29:1**。而这两个 token 的典型组合恰恰出现在小字上：`ui/badge.tsx:11`（secondary 徽标）、`landing-page.tsx:75`（`bg-muted/30` 区块）、`login-page.tsx:238`（`bg-muted/40` 整页底）。

### 1.3 深色下层次塌陷（卡片/背景 1.06:1）
`ui/tokens.css:32`（`--background: 222 47% 8%`）与 `ui/tokens.css:34`（`--card: 222 47% 11%`）只差 3% 亮度 = **1.06:1**。对照 `evidence/dash-v2-dark.png`：侧栏、顶栏、卡片、页面几乎是同一块黑板，全部结构只靠 1px 边框（`app-shell.tsx:65,143`）撑着。一旦叠加背景图，这层结构会彻底糊掉。

### 1.4 背景图"存得住、画不出"
`settings-page.tsx:310-311` 收集 `backgroundImage` → `settings-page.tsx:274` 提交 → 服务端 `server/src/routes/auth.ts:1436` 落库 → `/auth/me` 在 `auth.ts:1383` 返回。
但前端全仓 **0 处**消费（grep `background-image|backgroundImage` 只命中类型定义与表单本身）。用户填地址、保存成功、界面毫无变化——这是"功能承诺未兑现"，不只是视觉问题。

### 1.5 `zoom: 0.9` 把整站像素缩水 10%
`styles/globals.css:8`（`--app-ui-scale: 0.9`）+ `styles/globals.css:74`（`body { zoom: var(--app-ui-scale) }`）。
14px 正文 → 实际 12.6px；13px 标注 → 11.7px；12px → **10.8px**，中文已低于可读下限。`ui/tokens.css:28` 的 `--shell-h: calc(100dvh / var(--app-ui-scale))` 就是为它做的补偿。这条不改，本报告所有 px 都会被再乘 0.9。

### 1.6 body 规则引用已不存在的 TDesign 变量，且层级压过 tokens.css
`styles/globals.css:66-75`：`background-color: var(--td-bg-color-page)`、`color: var(--td-text-color-primary)`、`font-family: var(--td-font-family)`。全文件共 178 处 `--td-*`，但仓库里**没有任何 `--td-*` 的定义**，`package.json` 也没有 tdesign。
双重后果：① 这三条声明全部失效（背景变透明、字体回落到 Tailwind 默认栈，`Inter` 从未真正生效）；② 这条 body 规则**未包在 `@layer` 内**，而 `ui/tokens.css:55-60` 的 body 规则在 `@layer base` 里 —— 未分层样式优先级更高，**tokens 的 body 声明被静默丢弃**。

### 1.7 三条互不成比例的内容中轴
落地页 `landing-page.tsx:28,44,76,96,110` 五处 `max-w-6xl`（1152），控制台 `app-shell.tsx:202` 的 `max-w-7xl`（1280），`mcp-consent-page.tsx:68` 与 `oauth-callback-page.tsx:74` 的 `max-w-md`（448），`setup-page.tsx:102` 的 `max-w-3xl`（768）。
同一产品里 1152 / 1280 / 768 / 448 四档宽度互不关联，页面之间切换时"中轴"会跳。

### 1.8 字号阶梯是等距小步，三个"标题级"挤在 14–18px
`tailwind.config.js:120-127` 的档位是 12/14/16/18/20/24/30，相邻比约 1.11–1.17。
实际用法：15 处页面标题统一 `text-lg font-semibold`（18px，如 `dashboard-page.tsx:85`、`settings-page.tsx:25`、`security-page.tsx:55`），卡片标题 16px（`ui/card.tsx:20`），而顶栏的"页面名"又是 14px（`app-shell.tsx:153`）——**比页面标题还小**。三个层级差 2px，视觉上等于没有层级。

### 1.9 卡片内边距比卡片间距还大，分组关系反了
`ui/card.tsx:13,33`（`p-5` = 20px）对 `dashboard-page.tsx:93,106`（`gap-3` = 12px）。20/12 = 1.67 ≈ φ，但**方向反了**：视觉分组靠"外面比里面紧"才成立，现在是两张卡的内容比两张卡本身更疏离。140 处 `CardContent` 全体如此。

### 1.10 登录页的第三方入口是"隐形"的
`login-page.tsx:329-334`：SSO 用 `variant="ghost"`，无边框、无图标，文字被拼成「使用单点登录（SSO） · Logto」（`:331-332`）；而上一行的通行密钥是 `outline` + `Fingerprint` 图标（`:318-327`）。**层级倒挂**——越省事、越通用的入口，视觉越弱。
叠加结构问题：整页 `fixed inset-0` + `max-w-sm`（`:238-239`）在 1440 屏上两侧各空 528px，中间 384px 里还塞了两次品牌信息（`:241-246` 图标 + 站名 + tagline）。

---

## 2. 黄金比例落地方案

### 2.1 推导基准

| 常数 | 值 | 用途 |
|---|---|---|
| φ | 1.618034 | 跨级跳变（正文→标题→hero） |
| √φ | 1.272020 | 相邻层级（间距、尺寸、宽度） |
| φ^(1/4) | 1.127838 | 字号细档 |
| 基准模块 | 8px | 阶梯起点 |

**只有一条阶梯**：`size(n) = 8 × φ^(n/2)`，n 取整数。间距用 n = −1…4.5，布局宽度用 n = 5…11，全部同源。

### 2.2 间距阶梯（n = −1 … 4.5）

| token | 计算 | 取整 | 用途 |
|---|---|---|---|
| `--u-1` | 8/φ = 4.94 | **5** | 图标与数字的极细间隙、徽标内距 |
| `--u-2` | 8/√φ = 6.29 | **6** | 标签与输入框、标题与描述 |
| `--u-3` | 8 | **8** | 图标+文字、按钮内图标间距（基准） |
| `--u-4` | 8×√φ = 10.18 | **10** | 紧密列表项内距 |
| `--u-5` | 8×φ = 12.94 | **13** | 表单字段间距、表格单元水平内距 |
| `--u-6` | 8×φ^1.5 = 16.46 | **16** | **卡片之间的 gap** |
| `--u-7` | 8×φ² = 20.94 | **21** | 侧栏分组间距、行高节奏 |
| `--u-8` | 8×φ^2.5 = 26.63 | **27** | **卡片内边距**、页面纵向内距 |
| `--u-9` | 8×φ³ = 33.86 | **34** | 控件高度、页面横向内距 |
| `--u-10` | 8×φ^3.5 = 43.06 | **43** | **区块间距**（27×φ = 43.7 ✓） |
| `--u-11` | 8×φ⁴ = 54.77 | **55** | 落地页区块纵向节奏、顶栏高度 |
| `--u-12` | 8×φ^4.5 = 69.66 | **70** | hero 上下留白、页脚 |

**关键三条关系**（写进代码注释，评审时一眼能验）：
- 卡片内 27 : 卡片外 16 = **1.69 ≈ φ** —— 分组关系翻正
- 区块 43 : 卡片内 27 = 1.59 ≈ φ
- 70 : 55 : 43 : 34 每级都是 ×1.27（落地页纵向节奏）

### 2.3 字号阶梯（16 × φ^(m/4)）

| token | 计算 | 值 | 行高 | 行高/字号 | 语义 | 现状 |
|---|---|---|---|---|---|---|
| `--text-micro` | 13/√φ | **11px** | 16px | 1.45 | 徽标、分组小标题 | 12px（渲染 10.8） |
| `--text-caption` | 16/√φ = 12.58 | **13px** | **21px** | **1.62 ≈ φ** | 标注、说明、时间戳 | 12px |
| `--text-body-sm` | 16/φ^0.25 = 14.18 | **14px** | 23px | 1.64 | 表格、日志等密排档 | 14px |
| `--text-body` | 16 | **16px** | **26px** | **1.625 ≈ φ** | 正文、表单、卡片描述 | 14px |
| `--text-title` | 16×√φ = 20.36 | **20px** | 26px | 1.30 | 卡片标题 | 16px |
| `--text-heading` | 16×φ = 25.89 | **26px** | 34px | 1.31 | **页面标题 h1/h2** | 18px |
| `--text-stat` | 26×√φ = 33.07 | **33px** | 40px | 1.21 | 统计大数 | 24px |
| `--text-hero` | 26×φ = 41.87 | **42px** | 53px | 1.26 | 平板 hero、登录页大标题 | 48px |
| `--text-hero-lg` | 42×φ = 67.78 | **68px** | 78px | 1.15 | 桌面 hero 主标题 | 48px |

**语义层级正好是 φ 链**：正文 16 →（×φ）页面标题 26 →（×φ）hero 42 →（×φ）hero-lg 68；中间档用 √φ 细分（20 / 33）。相邻语义恒为 √φ 或 φ，**不再出现 18↔16 这种 1.125 的"假层级"**。

> 中文实践说明：正文提到 16px 是为中文可读性（14px 在 1x 屏偏紧），但表格/日志保留 14px 密排档——**φ 只约束层级关系，不强制所有场景同一档**。

### 2.4 布局尺寸（同一条阶梯的延伸，n = 5 … 11）

| token | 计算 | 值 | 说明 |
|---|---|---|---|
| `--h-header` | 8×φ⁴ | **55px** | 顶栏（现状 56，仅差 1px） |
| `--w-sidebar-collapsed` | 8×φ⁵ | **89px** | 收起态（现状 64） |
| `--w-sidebar` | 8×φ⁷ | **232px** | 展开态（现状 240） |
| `--w-auth-card` | 8×φ⁸ | **376px** | 登录卡片（现状 384） |
| `--w-hero-text` | 984/φ | **608px** | 落地页 hero 文案列 |
| `--w-content-narrow` | 8×φ¹⁰ | **984px** | 设置/关于等阅读型页面 |
| `--w-content` | 984×√φ | **1252px** | 控制台默认容器 |
| `--w-content-wide` | 1252×√φ | **1592px** | 表格/日志等宽表页 |

**三条可验证关系**：
- 232 / 89 = **2.607 ≈ φ² = 2.618**（侧栏展开:收起）
- 232 / 55 = **4.2 ≈ φ³ = 4.236**（侧栏:顶栏）
- 608 + 376 = **984**，且 608/984 = **0.618** —— 落地页 hero 的 61.8/38.2 分栏、登录卡宽度，都是同一根中轴切出来的

### 2.5 组件尺寸与圆角

| 项 | 现状 | 建议 | 依据 |
|---|---|---|---|
| 控件高 sm/默认/lg | 32 / 36 / 40 | **27 / 34 / 43** | 阶梯 n=2.5/3/3.5 |
| 卡片内边距 | 20 | **27** | n=2.5 |
| 卡片间距 | 12 | **16** | n=1.5（内/外 = φ） |
| 区块间距 | 24 | **43** | n=3.5 |
| 页面内距 | 12–24 | **横向 34 / 纵向 27** | n=3 / 2.5 |
| 圆角 sm/base/lg/xl | 4/6/8/12 | **5 / 8 / 13 / 21** | 5×φ=8.09、8×φ=12.94 ✓ |
| 图标 xs/sm/md/lg | 16 / 20 | **13 / 16 / 21 / 27** | 阶梯 |
| 表头行高 / 数据行高 | 36 / ~40 | **34 / 43** | n=3 / 3.5 |
| 侧栏项高 | 32 | **34**，项间距 5，组间距 21 | 密度下调一档 |
| hero 最小高度 | 无 | **`clamp(560px, 61.8dvh, 880px)`** | φ⁻¹ 视口 |

### 2.6 可直接粘贴的 tokens.css 追加块

追加到 `client/src/ui/tokens.css` 的 `@layer base { :root { ... } }` 内（颜色见 §5 的 P0 项，此处只列几何）：

```css
/* ============ 黄金比例几何（8 × φ^(n/2)） ============ */
--phi: 1.618034;
--phi-sqrt: 1.272020;

/* 间距阶梯 */
--u-1: 5px;    /* 8/φ      */
--u-2: 6px;    /* 8/√φ     */
--u-3: 8px;    /* 8        */
--u-4: 10px;   /* 8×√φ     */
--u-5: 13px;   /* 8×φ      */
--u-6: 16px;   /* 8×φ^1.5  */
--u-7: 21px;   /* 8×φ^2    */
--u-8: 27px;   /* 8×φ^2.5  */
--u-9: 34px;   /* 8×φ^3    */
--u-10: 43px;  /* 8×φ^3.5  */
--u-11: 55px;  /* 8×φ^4    */
--u-12: 70px;  /* 8×φ^4.5  */

/* 布局宽度 */
--h-header: 55px;
--w-sidebar: 232px;
--w-sidebar-collapsed: 89px;
--w-auth-card: 376px;
--w-hero-text: 608px;
--w-content-narrow: 984px;
--w-content: 1252px;
--w-content-wide: 1592px;

/* 组件尺寸 */
--h-control-sm: 27px;
--h-control: 34px;
--h-control-lg: 43px;
--pad-card: 27px;
--gap-card: 16px;
--gap-section: 43px;
--pad-page-x: 34px;
--pad-page-y: 27px;

/* 圆角（φ 递进：5 → 8 → 13 → 21） */
--radius-sm: 5px;
--radius: 8px;
--radius-lg: 13px;
--radius-xl: 21px;

/* 字号阶梯（16 × φ^(m/4)） */
--text-micro: 11px;    --leading-micro: 16px;
--text-caption: 13px;  --leading-caption: 21px;
--text-body-sm: 14px;  --leading-body-sm: 23px;
--text-body: 16px;     --leading-body: 26px;
--text-title: 20px;    --leading-title: 26px;
--text-heading: 26px;  --leading-heading: 34px;
--text-stat: 33px;     --leading-stat: 40px;
--text-hero: 42px;     --leading-hero: 53px;
--text-hero-lg: 68px;  --leading-hero-lg: 78px;

/* 图标 */
--icon-xs: 13px;
--icon-sm: 16px;
--icon-md: 21px;
--icon-lg: 27px;
```

### 2.7 tailwind.config.js 映射（用命名键，避免误伤 140 处旧类）

**不要**覆盖数字键（`spacing: { 5: '13px' }` 会让全站 `p-5` 从 20px 变 13px）。用前缀键做增量迁移：

```js
// tailwind.config.js → theme.extend
spacing: {
  'phi-1': 'var(--u-1)',  'phi-2': 'var(--u-2)',  'phi-3': 'var(--u-3)',
  'phi-4': 'var(--u-4)',  'phi-5': 'var(--u-5)',  'phi-6': 'var(--u-6)',
  'phi-7': 'var(--u-7)',  'phi-8': 'var(--u-8)',  'phi-9': 'var(--u-9)',
  'phi-10': 'var(--u-10)','phi-11': 'var(--u-11)','phi-12': 'var(--u-12)',
},
fontSize: {
  micro:     ['var(--text-micro)',    { lineHeight: 'var(--leading-micro)' }],
  caption:   ['var(--text-caption)',  { lineHeight: 'var(--leading-caption)' }],
  'body-sm': ['var(--text-body-sm)',  { lineHeight: 'var(--leading-body-sm)' }],
  body:      ['var(--text-body)',     { lineHeight: 'var(--leading-body)' }],
  title:     ['var(--text-title)',    { lineHeight: 'var(--leading-title)' }],
  heading:   ['var(--text-heading)',  { lineHeight: 'var(--leading-heading)' }],
  stat:      ['var(--text-stat)',     { lineHeight: 'var(--leading-stat)' }],
  hero:      ['var(--text-hero)',     { lineHeight: 'var(--leading-hero)' }],
  'hero-lg': ['var(--text-hero-lg)',  { lineHeight: 'var(--leading-hero-lg)' }],
},
maxWidth: {
  content:        'var(--w-content)',
  'content-narrow': 'var(--w-content-narrow)',
  'content-wide': 'var(--w-content-wide)',
  auth:           'var(--w-auth-card)',
},
width: { sidebar: 'var(--w-sidebar)', 'sidebar-sm': 'var(--w-sidebar-collapsed)' },
height: { header: 'var(--h-header)', control: 'var(--h-control)',
          'control-sm': 'var(--h-control-sm)', 'control-lg': 'var(--h-control-lg)' },
borderRadius: {
  sm: 'var(--radius-sm)', DEFAULT: 'var(--radius)',
  lg: 'var(--radius-lg)', xl: 'var(--radius-xl)',
},
```

### 2.8 改造前后 className 对照（三个高频点）

| 位置 | 现状 | 建议 |
|---|---|---|
| `ui/card.tsx:6` | `rounded-lg border ... p-5` 系列 | `rounded-lg border border-border surface-panel`（内距 `p-phi-8` = 27px，一处改 140 处受益） |
| `app-shell.tsx:66` | `collapsed ? 'w-16' : 'w-60'` | `collapsed ? 'w-sidebar-sm' : 'w-sidebar'`（89 / 232） |
| `app-shell.tsx:202` | `max-w-7xl` | `max-w-content`（1252，宽表页用 `max-w-content-wide`） |
| `dashboard-page.tsx:85` | `text-lg font-semibold tracking-tight` | `text-heading font-semibold`（26px，去掉中文 tracking-tight） |
| `app-shell.tsx:153` | `h1 text-sm font-semibold` | `text-caption text-muted-foreground`（顶栏降级为"位置提示"，让页面 h1 独占主标题） |

---

## 3. 背景图方案（`https://t.alcy.cc/moez`）

### 3.1 实测事实（决定方案边界）

对 `https://t.alcy.cc/moez` 实测：

| 项 | 结果 |
|---|---|
| 响应 | `302 → /pic/moe/NN.webp`，**每次请求随机换一张**，302 不缓存 |
| 最终资源 | WebP，**2048×1152（16:9）**，约 **404 KB**，`cache-control: max-age=2592000`（30 天） |
| CORS | 302 带 `access-control-allow-origin: *`；**最终图片不带 ACAO** |
| 含义 1 | `<img>` 可正常显示（图片不需要 CORS）；但 `fetch()` 会因为重定向目标缺 ACAO 而失败 → **前端拿不到固定 URL** |
| 含义 2 | 直接写进 CSS `background-image` → **每次刷新换图**，观感上会"闪变" |
| 含义 3 | 2048×1152 足够 1440p `cover`；竖屏会裁掉 61.8%，需 `background-position: center 32%` 保脸 |

### 3.2 分层结构（z 轴）

| 层 | 内容 | 实现 | 说明 |
|---|---|---|---|
| L0 | 应用底色 | `html { background: hsl(var(--background)) }` | 图片加载失败时的兜底 |
| L1 | 背景图 | `body { background-image: url(...) }` + `background-attachment: fixed` | **必须先删 `zoom`**，见 §5 P0-4 |
| L2 | 蒙层 | 叠加在 L1 上的 `linear-gradient`（同一条 `background-image` 多值） | 统一压对比度 |
| L3 | 结构面（侧栏/顶栏） | `.surface-chrome`：72–80% + `backdrop-blur` | 只有图标/短标签，容错高 |
| L4 | 内容面（卡片） | `.surface-panel`：86–94% + `backdrop-blur` | 承载正文，必须接近实色 |
| L5 | 正文 | 常规 token | 对比度按 L4 的**等效实色**计算 |

用 `body` 的多重 `background-image` 一次搞定 L1+L2，零 JSX 改动：

```css
@layer base {
  body {
    /* 第一层是蒙层（在图上），第二层是图 */
    background-image:
      linear-gradient(
        rgb(var(--scrim-rgb) / var(--scrim-alpha)),
        rgb(var(--scrim-rgb) / var(--scrim-alpha))
      ),
      var(--app-bg-image);
    background-size: cover;
    background-position: center 32%;
    background-repeat: no-repeat;
    background-attachment: fixed;
    background-color: hsl(var(--background));
  }
}
```

### 3.3 各页面曝光策略（关键判断）

**核心结论：浅色主题下，"图可见"不能靠降低面板透明度，只能靠布局留白。**
数学上：白底 + 面板 α=0.62 + 图上亮部（如白衬衫 #f5f5f5）→ 面板等效 `#a0a0a4`，正文对比度掉到 **2.2:1**。所以面板必须接近实色。

| 页面 | 图像层 | 面板 | 曝光结论 |
|---|---|---|---|
| 落地页 hero | 全幅 100% | 无面板（文字直压图） | **不可行**——hero 有大段正文。改为：图只出现在 hero **右 38.2%**（608/376 分栏），文字列在左侧纯色区 |
| 落地页 features / CTA / footer | 关闭（`background-color` 实色） | 卡片 94% | 图在区块之间"透气"即可 |
| 登录页 / 安装向导 / OAuth 回调 / 授权页 | **左侧 61.8% 全幅 100%**，右侧 38.2% 实色 | 表单区实色 | 这是全站最适合展示图的地方（没有文字压在图上） |
| 控制台外壳 | 全幅 | 侧栏 **100% 实色**，顶栏 72/80% + blur | 侧栏是 15 个导航项（14px），透 → 必跌破 4.5:1。**侧栏永远不透** |
| 内容页（卡片） | 由外壳透出 | 卡片 94%（浅）/ 86%（深）+ blur | 卡片之间 16px 的缝和页面边距就是图的"取景框" |

> 这条策略同时回答了"图为什么看不见"：不是透明度不够，是**留白不够**。把 `gap-card` 从 12 提到 16、页面内距提到 34/27 之后，图的可见面积自然增加约 40%。

### 3.4 token 定义 + 深色处理

```css
@layer base {
  :root {
    --app-bg-image: url('https://t.alcy.cc/moez');
    --app-bg-visible: 1;          /* 0 = 用户在设置里关闭背景 */

    --scrim-rgb: 255 255 255;     /* 浅色：白纱打亮，压低图片对比度 */
    --scrim-alpha: 0.56;

    --panel-alpha: 0.94;
    --panel-blur: 10px;
    --chrome-alpha: 0.72;
    --chrome-blur: 14px;
  }

  .dark {
    --scrim-rgb: 8 13 24;         /* 深色：夜色压暗，图退到 30% 亮度 */
    --scrim-alpha: 0.62;

    --panel-alpha: 0.86;
    --panel-blur: 14px;
    --chrome-alpha: 0.80;
    --chrome-blur: 14px;
  }

  /* 用户关闭背景图时整层失效（用属性选择器，不依赖 JS 清变量） */
  html[data-bg='off'] body { background-image: none; }
}

@layer components {
  .surface-chrome {
    background-color: hsl(var(--card) / var(--chrome-alpha));
    backdrop-filter: blur(var(--chrome-blur)) saturate(1.1);
  }
  .surface-panel {
    background-color: hsl(var(--card) / var(--panel-alpha));
    backdrop-filter: blur(var(--panel-blur)) saturate(1.05);
  }
}
```

**深色的三个必须**：
1. 图像亮度压到 **55%**（`filter: brightness(.55) saturate(.75) contrast(.85)`）——因为图中的高光（白色衣领、天空）在深色主题里会变成刺眼的光斑。
2. 图表/表格边框在图上会消失 → `--border` 深色需提到 26% 亮度（见 P0-3）。
3. 深色下 **面板 α 可以比浅色更低（0.86 < 0.94）**：白字在深底上的余量大，背景稍亮仍能保住 4.5:1。

### 3.5 可读性护栏（数值表）

| 场景 | 参数 | 实测/估算对比度 | 结论 |
|---|---|---|---|
| 浅色 · 卡片 | `panel-alpha 0.94` + blur 10px | 正文 16px `#0f1729` 对等效白底 ≈ **15:1** | ✅ 远超 AA |
| 浅色 · 卡片内标注 13px | `--muted-foreground` 改 215 20% 40% | **6.13:1** | ✅ |
| 浅色 · 顶栏 72% | 13px 位置标题 | 最坏（图亮部）≈ **4.6:1** | ⚠️ 刚好，故顶栏文字**只用 muted 之上的一档**，不用正文色压图 |
| 浅色 · 侧栏 | 实色 100% | **不适用**（无图） | ✅ 永远不透 |
| 深色 · 卡片 | `panel-alpha 0.86` + blur 14px | 正文 `#f1f5f9` ≈ **13:1** | ✅ |
| 深色 · 卡片内标注 | muted 215 20% 70% | **7.55:1** | ✅ |
| 深色 · 顶栏 80% | 13px | ≈ **6:1** | ✅ |
| 浅色 · 面板 α=0.62（**反例**） | 图亮部压底 | **2.2:1** | ❌ 这就是不能"贪透"的原因 |

护栏规则（写进 lint/评审清单）：
- 承载 **≤14px 文字**的 surface 必须 `α ≥ 0.72` 且蒙层已压对比度；
- 承载 **16px 正文**的 surface 必须 `α ≥ 0.86`；
- 侧栏 / 表格 / 长文本区：`α = 1`。

### 3.6 设置页自定义背景与默认图的配合

`settings-page.tsx:310-311` 已有输入框，只需补三件事：**注入、校验、关闭开关**。

优先级：**用户自定义 > 默认 `t.alcy.cc/moez` > 纯色**。

```tsx
// 建议放在 ThemeProvider 里（已有 document.documentElement 的写入先例）
useEffect(() => {
  const root = document.documentElement;
  const raw = (preferences?.backgroundImage ?? '').trim();

  if (raw === 'none') {                     // 显式关闭
    root.dataset.bg = 'off';
    root.style.removeProperty('--app-bg-image');
    return;
  }
  root.dataset.bg = 'on';

  if (!raw) { root.style.removeProperty('--app-bg-image'); return; }  // 回落默认

  let url: URL;
  try { url = new URL(raw); } catch { root.style.removeProperty('--app-bg-image'); return; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {          // 拦 data:/javascript:
    root.style.removeProperty('--app-bg-image');
    return;
  }
  // 关键：用 CSSOM 赋值 + JSON.stringify 转义，避免 " 和 ) 造成 CSS 注入
  root.style.setProperty('--app-bg-image', 'url(' + JSON.stringify(url.href) + ')');
}, [preferences?.backgroundImage]);
```

**安全提示（当前就存在）**：`settings-page.tsx:311` 接受任意字符串并原样落库（`server/src/routes/auth.ts:1436` 也未校验）。一旦把它直接拼进 CSS 变量，`backgroundImage = "x'); } body { display:none } .a{ content:('"` 这类值可以破坏整页样式（存储型 CSS 注入）。上面的 JSON.stringify + 协议白名单是最小成本的堵法。

**与默认图的配合规则**：
- 用户设了自定义图 → 完全替换默认图，蒙层参数不变（蒙层属于主题，不属于图片）；
- 用户设 `none` → `data-bg='off'`，页面回到纯色，此时 `--panel-alpha` 应同步置 1（否则卡片会出现"半透明但没有东西可透"的浑浊感）——建议在 `html[data-bg='off']` 里覆写 `--panel-alpha: 1; --chrome-alpha: 1`；
- 设置页应显示 **缩略预览**（`<img>` 96×54，`object-cover`），让用户保存前就知道效果。

### 3.7 兜底与性能

| 风险 | 处理 |
|---|---|
| `t.alcy.cc` 不可达（网络/服务停摆） | 蒙层下方永远是 `hsl(var(--background))`，失败只是"没有图"，不会缺色块 |
| 每次刷新换图 | 前端拿不到固定 URL（见 3.1）。最省事：给 body 加 600ms `background-color` 过渡，把"闪变"变成"淡入"；想彻底固定就加服务端代理（P2，Node 18+ 自带 fetch，无需新依赖） |
| 404 KB 大图拖慢首屏 | 图片不进关键路径：不要加 `<link rel="preload">`；用 body 背景（浏览器低优先级加载）+ 底色先绘 |
| 全屏 `backdrop-filter` 掉帧 | **禁止在整屏蒙层上用 `backdrop-filter`**；只在小面积（卡片/顶栏/侧栏）使用，且 `blur ≤ 14px` |
| 竖屏裁切 | `background-position: center 32%`（人脸通常在画面上 1/3） |
| 打印 | `@media print { body { background-image: none } }` |

---

## 4. 登录页第三方登录图标化

### 4.1 图标分配表（全部来自已装 lucide-react 0.511，已逐个核验存在）

| 入口 | 图标 | 理由 |
|---|---|---|
| 密码登录（主按钮） | `KeyRound` | 已有（`login-page.tsx:308`），保留 |
| 通行密钥 | `Fingerprint` | 已有（`:325`），保留 |
| **Logto** | `LogIn` | 语义="通过外部 IdP 进入"。**不用品牌 logo**：`public/logto.png` 虽在仓库里，但把第三方品牌色块搬进按钮会让登录页像支付页；若产品坚持，用它做 `<img width=18 height=18>` 且仅在 `providerName` 命中 logto 时 |
| **通用 OIDC / 其它 IdP** | `Network` | "外部身份源"的通用语义，中性、不误导 |
| **企业 SSO** | `Building2` | 组织级入口，与个人登录区分 |
| 两步验证（TOTP） | `Smartphone` | 验证器 App 的通用隐喻（当前该步骤无图标，`:345-360`） |
| 忘记密码 / 邮件验证码 | `Mail` | 与"发到邮箱"的动作一致 |
| 返回 / 切换 | 不加图标 | 保持纯文字，避免与主操作抢注意力 |

### 4.2 按钮排版规格

| 项 | 值 |
|---|---|
| 图标尺寸 | **16px**（`--icon-sm`），`strokeWidth={1.75}`（默认 2 在 16px 上偏重，中文界面尤其明显） |
| 图标-文字间距 | **8px**（`--u-3`） |
| 对齐 | `justify-start`（居中会让"图标+文字"整块漂浮，左对齐才有"表单控件"感） |
| 高度 | 主按钮 **43px**（`--h-control-lg`），次要按钮 **34px** |
| 变体 | 主入口 `default`（实色），其余统一 `outline`；**不要**每种登录方式一个颜色 |
| 分割线 | 上下 `13px`，线内文字用 `--text-caption` |
| 图标可访问性 | `aria-hidden`（文字已表意）；**纯图标模式下必须有 `aria-label` + `title`** |

### 4.3 三种形态（按宽度降级）

| 形态 | 触发条件 | 结构 |
|---|---|---|
| A · 图标+文字（**默认**） | 宽度 ≥ 320px | `variant=outline` 全宽，左对齐，图标 16 + 文字 |
| B · 图标+文字，并列两个 | 恰好 2 个第三方入口且宽度 ≥ 320 | `grid grid-cols-2 gap-phi-5`，图标居中 + 文字 |
| C · 纯图标 | 宽度 < 320px 或入口 > 2 个 | 43×43 方形 `ghost`，`aria-label` + `title`，图标 21px |

### 4.4 边界：什么叫"不要过度"

1. **同屏第三方入口 ≤ 4 个**。超过就折叠进「更多方式」。
2. **不使用彩色品牌方块**（GitHub 黑、Google 四色的那种）。统一 `outline` + 前景色图标，否则登录页会变成"应用商店"。
3. **一个按钮只放一个图标**；不要"图标 + 右箭头 + 徽标"三件套。
4. **图标高度不超过文字高度的 1.15 倍**（16px 文字配 ≤18px 图标）。当前 `Button` 里 `[&_svg]:size-4`（`ui/button.tsx:7`）已经是 16px，**不要再放大**。
5. **纯图标只是断点兜底**，不是主形态。Logto / OIDC / SSO 三个图标在中文语境下无法自解释，必须保留文字。
6. **不加动效**（旋转、脉冲）。登录页的动效预算全部留给加载态（`Loader2`）。

### 4.5 改造后的登录入口区（替换 `login-page.tsx:312-334`）

```tsx
<div className="flex items-center gap-phi-5 text-caption text-muted-foreground">
  <span className="h-px flex-1 bg-border" />
  或
  <span className="h-px flex-1 bg-border" />
</div>

<Button
  type="button"
  variant="outline"
  className="w-full justify-start gap-phi-3"
  onClick={() => void handlePasskeyLogin()}
  disabled={passkeyPending || submitting}
>
  {passkeyPending
    ? <Loader2 className="animate-spin" aria-hidden />
    : <Fingerprint strokeWidth={1.75} aria-hidden />}
  {copy.auth.passkeyLogin}
</Button>

{oauth?.enabled && (
  <Button
    type="button"
    variant="outline"
    className="w-full justify-start gap-phi-3"
    onClick={() => void handleOauthLogin()}
  >
    <LogIn strokeWidth={1.75} aria-hidden />
    <span className="truncate">
      {oauth.providerName ? `使用 ${oauth.providerName} 登录` : copy.auth.oauthLogin}
    </span>
  </Button>
)}
```

> ⚠️ **回归风险已核验**：`features/auth/__tests__/login-page.test.tsx:62` 用 `new RegExp(copy.auth.oauthLogin)` 匹配按钮名。当 `providerName='Logto'` 时按钮名变成「使用 Logto 登录」，**该用例会挂**。落地时二选一：① 更新用例为 `new RegExp(oauth.providerName ?? copy.auth.oauthLogin)`；② 文案改为「使用单点登录（SSO）」并在右侧用 `<Badge>` 显示 providerName。推荐 ①。

---

## 5. 优先级清单

### P0 · 正确性问题（先做，做完观感已变一半）

| # | 问题 | 改动点 | 预期效果 |
|---|---|---|---|
| P0-1 | 浅色主色白字 2.86:1 | `ui/tokens.css:18` 的 `--primary: 199 89% 48%` → **`199 89% 35%`**（`#0a76a9`）。若不愿动品牌色，改为新增 `--primary-strong: 199 89% 35%`，把 `ui/button.tsx:11` 的 `bg-primary` 与所有 `text-primary` 链接指过去 | 白字 **2.86 → 5.03:1**，首次过 AA；链接文字同步达标 |
| P0-2 | 次要文字在弱底上 4.29:1 | `ui/tokens.css:15` `--muted-foreground: 215 16% 47%` → **`215 20% 40%`** | 白底 4.70→**6.13**，`bg-muted` 上 4.29→**5.60**；徽标、说明、时间戳全部达标 |
| P0-3 | 深色层次 1.06:1 | `ui/tokens.css:31-49`：`--background: 222 45% 7%`、`--card: 222 38% 14%`、`--muted: 222 30% 18%`、`--border: 217 28% 26%`、`--input: 215 25% 46% / 0.69`、`--muted-foreground: 215 20% 70%` | 卡片/背景 **1.06 → 1.15**，输入框边框对卡片 **3.29:1**（过 WCAG 1.4.11 的 3:1）；`dash-v2-dark.png` 那种"一块黑板"消失 |
| P0-4 | `zoom: 0.9` 让所有 px 失真 | `styles/globals.css:8` 删该变量、`:74` 删 `zoom` 与 `@supports` 回退（`:77-82`）、`:9-10` 删 `--app-scaled-vh/vw` 改 `100dvh/100vw`、`ui/tokens.css:28` 的 `--shell-h` 改 `100dvh` | 12px 标注从渲染 10.8px 回到 12px；**后续所有 φ 数值与设计稿 1:1** |
| P0-5 | body 引用已删除的 TDesign 变量，且压过 tokens | `styles/globals.css:66-75` 整块删除（`--td-*` 全仓无定义），把 `font-family`/底色交给 `ui/tokens.css:55-60`；同时删除 `globals.css` 中已无引用的 `.page-shell`/`.app-layout`/`.t-*` 死样式（tsx 中命中 0 处，约 2800 行） | `Inter` 真正生效；tokens 的 body 规则不再被静默覆盖；CSS 体积降约 60% |
| P0-6 | 背景图存了不渲染 | 按 §3.4 加 token + `.surface-*`；`app-shell.tsx:61` 的 `bg-background` → `bg-transparent`，`:65` 侧栏 `bg-card` 保持实色，`:143` 顶栏 → `surface-chrome`；`ui/card.tsx:6` → `surface-panel`；按 §3.6 注入用户偏好 | 设置里填的地址**立刻生效**；默认图在控制台/登录页可见 |
| P0-7 | 登录页 `fixed inset-0` 不可滚动 | `login-page.tsx:238` `fixed inset-0 ... overflow-auto` → `min-h-dvh` + `items-center justify-center`（保留居中，去掉 fixed） | iOS 键盘弹出、小屏横屏时可滚动，不再出现按钮被裁 |

### P1 · 比例失衡（观感提升的主力）

| # | 问题 | 改动点 | 预期效果 |
|---|---|---|---|
| P1-1 | 侧栏 240/64、密度偏高 | `app-shell.tsx:66` → `w-sidebar / w-sidebar-sm`（232/89）；`:70,143` → `h-header`（55）；`:100` 项高 → 34；`:84` 组间距 → 21；`:86` 组标题 `text-micro`（11px，去掉 `uppercase tracking-wide`，中文无效） | 展开/收起成为 **φ² 关系**；侧栏与顶栏成为 **φ³ 关系**；15 个导航项呼吸感出现 |
| P1-2 | 三条内容中轴 | 落地页 5 处 `max-w-6xl` → `max-w-content-narrow`（984）；`app-shell.tsx:202` → `max-w-content`（1252）；授权/回调页统一 `max-w-auth`（376）；安装向导 → 1252 | 页面切换不再"中轴跳动" |
| P1-3 | 卡片内 20 / 外 12（方向反了） | `ui/card.tsx:13,33` → `p-phi-8`（27）；全站 `gap-3` → `gap-phi-6`（16）（`dashboard-page.tsx:93,106` 等）；区块 `space-y-4` → `space-y-phi-10`（43） | 一组卡"抱团"、组与组"分开"，分组关系第一次成立 |
| P1-4 | 标题层级挤压 | `tailwind.config.js:120-127` 增加 §2.7 的命名档；15 处 `text-lg font-semibold tracking-tight` → `text-heading font-semibold`（26px，去 tracking）；`ui/card.tsx:20` → `text-title`（20px）；`app-shell.tsx:153` → `text-caption text-muted-foreground` | 顶栏→卡片→页面 形成 13→20→26 的**√φ 递增**，主标题终于"最响" |
| P1-5 | 落地页 hero 右半空 | `landing-page.tsx:44` 改 `min-h-[clamp(560px,61.8dvh,880px)] grid lg:grid-cols-[608px_376px]`；右列放背景图取景框（`rounded-xl overflow-hidden`）；`:48` hero 字号 → `text-hero sm:text-hero-lg`（42/68）；区块纵向 `py-14`/`py-16` → 70/55/43/34 节奏 | 空白从"漏"变成"构图"；hero 高度锁定黄金分割 |
| P1-6 | 中文用 `tracking-tight`（21 处） | 全局把中文标签上的 `tracking-tight` 去掉（`landing-page.tsx:32,48,77` 等），英文品牌名可保留 | 中文不再被压字，48px 标题尤其明显 |
| P1-7 | 登录页两侧各空 528px | `login-page.tsx:237-248` 改 `lg:grid lg:grid-cols-[1fr_38.2%]`：左侧图像全幅 + 一句品牌语，右侧实色区居中放 376px 卡片 | 背景图有了**最合适的展台**，登录页从"空"变"有场" |

### P2 · 锦上添花

| # | 项 | 改动点 | 预期效果 |
|---|---|---|---|
| P2-1 | 第三方图标化 | §4.5 的 JSX（`LogIn` / `Network` / `Building2`） | 登录入口可扫描，SSO 不再"隐形" |
| P2-2 | lucide 描边统一 | 全局 `.lucide { stroke-width: 1.75 }`，或每处 `strokeWidth={1.75}` | 16px 图标在中文界面不再"糊成一坨" |
| P2-3 | 数字对齐 | 统计卡、表格数字加 `tabular-nums`（`dashboard-page.tsx:17`） | 数值刷新时不跳动 |
| P2-4 | 背景图固定化 | 服务端加 `GET /api/background`（Node 18 自带 fetch 跟随 302，读 `res.url`，缓存 30 天） | 刷新不再换图，免掉"闪变" |
| P2-5 | 空状态与骨架 | 空状态用 `text-caption` + 一个 `--icon-lg` 线性图标；骨架高度对齐真实行高（43/34） | 加载过程不"跳版" |
| P2-6 | 细节色 | `::selection` 用 `--primary/20`；滚动条宽度 8 → 10，颜色跟 `--border` | 细节统一 |

---

## 6. 验收方法（落地后怎么证明改对了）

1. **对比度**：DevTools → Elements → 颜色块的 Contrast ratio，逐个核对 §3.5 表的八行；附录 A 脚本可离线复算。
2. **比例**：截图后在标尺里量三处 —— 侧栏 232、卡片内 27、卡片间 16；比值 1.69±0.02 即通过。
3. **字号**：`getComputedStyle(h1).fontSize` 应为 26px，且 `document.body` 的 `zoom` 为空。
4. **背景图**：`getComputedStyle(document.body).backgroundImage` 应包含两张图（渐变 + url）；`html[data-bg=off]` 时应为 `none`。
5. **回归**：`pnpm --filter dnsmgr-client test`。已核验 `__tests__` 中**没有任何 `toHaveClass` 断言**（0 处），改类名安全；唯一风险是 §4.5 标注的 OAuth 按钮文案匹配。
6. **视觉回归**：与 `ai-censorship/evidence/` 下现有截图（`landing-v2.png`、`login-v2-light.png`、`dash-v2-*.png`）逐张对比。

---

## 7. 反方意见与风险（自我攻击）

| 反方观点 | 我的回应 | 残留风险 |
|---|---|---|
| "φ 阶梯会产出 13/21/27/34/43 这种奇数，1x 屏上边框会糊" | 正确。所以**边框、分割线、描边单独留在 1px/2px 偶数网格**，只有间距和尺寸走 φ | 低 |
| "正文 14 → 16px 会让表格少显示两行" | 只把卡片/表单/落地页提到 16，**表格与日志保留 14px 密排档**（`--text-body-sm`） | 中：需逐个页面判定，不是无脑全局替换 |
| "浅色 + 背景图必然牺牲可读性" | 是，所以浅色只让图出现在负空间，面板 0.94 近实色。**图的可见度靠留白挣，不靠透明度偷** | 中：需要同时改间距，单改背景不会好看 |
| "二次元壁纸和自托管运维工具的调性不搭" | 属实，这是产品判断不是技术问题。建议默认值**分场景**：登录页/落地页开，控制台默认关（用户可在设置里开） | 高：需要产品拍板 |
| "`--primary` 降到 35% 亮度，品牌青变深蓝，不够年轻" | 属实。备选是双 token：装饰用 48%，文字/按钮底用 35%。代价是两套色要维护 | 中 |
| "删 2800 行 globals.css 有风险" | 已核验 `.page-shell`/`.app-layout` 在 tsx 中命中 0；`.t-card` 1 处、`.t-dialog` 3 处命中需先确认 | 低-中 |

---

## 附录 A · 对比度实算（当前 vs 建议）

| 组合 | 现值 | 建议值 | 判定 |
|---|---|---|---|
| 白字 / `--primary`（浅） | **2.86**（`#0da2e7`） | **5.03**（`#0a76a9`） | ❌→✅ |
| `--muted-foreground` / 白 | 4.70 | 6.13 | ⚠️→✅ |
| `--muted-foreground` / `bg-muted` | **4.29** | **5.60** | ❌→✅ |
| `--foreground` / 白 | 17.87 | 17.87 | ✅ |
| 卡片 / 背景（深） | **1.06** | **1.15** | ❌→⚠️（深色 UI 惯例，配合边框使用） |
| `--muted-foreground` / 卡片（深） | 6.97 | **7.55** | ✅ |
| `--border` / 卡片（深） | 1.20 | **1.52** | ⚠️ |
| `--input` 边框 / 卡片（深） | 1.20 | **3.29** | ❌→✅（1.4.11 要求 3:1） |
| 白字 / `--destructive` | 4.80 | 4.80 | ✅ |

复算脚本（Node，无依赖）：

```js
const hsl2rgb=(h,s,l)=>{s/=100;l/=100;const c=(1-Math.abs(2*l-1))*s;const hp=h/60;const x=c*(1-Math.abs(hp%2-1));
let r=0,g=0,b=0;
if(hp<1){r=c;g=x}else if(hp<2){r=x;g=c}else if(hp<3){g=c;b=x}else if(hp<4){g=x;b=c}else if(hp<5){r=x;b=c}else{r=c;b=x}
const m=l-c/2;return [r+m,g+m,b+m].map(v=>Math.round(v*255))};
const lin=v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)};
const L=([r,g,b])=>0.2126*lin(r)+0.7152*lin(g)+0.0722*lin(b);
const cr=(a,b)=>{const x=L(a),y=L(b),hi=Math.max(x,y),lo=Math.min(x,y);return (hi+0.05)/(lo+0.05)};
console.log(cr(hsl2rgb(199,89,48),[255,255,255]).toFixed(2)); // 2.86 现状
console.log(cr(hsl2rgb(199,89,35),[255,255,255]).toFixed(2)); // 5.03 建议
```

## 附录 B · 一句话给负责人

> 先把 **主色对比度、深色层次、`zoom: 0.9`** 三件事修掉（半天工作量），再把**一条 φ 阶梯**接进 tokens（一天），最后才做背景图和登录页图标（各半天）。顺序反了的话，背景图只会把已经偏灰、偏小、偏平的界面压得更糊。
