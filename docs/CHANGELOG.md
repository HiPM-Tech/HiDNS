# 更新日志

## [2.1.4] - 2026-10-09

### 🐛 Bug 修复
- **Rainyun 域名与记录列表恒为空**: 适配器读取了不存在的 `res.data.data` / `res.data.total` 字段，而接口实际返回 `Records` / `TotalRecords`；记录列表的 `res.data.data.map()` 还会在字段缺失时抛 `TypeError` 并被 `catch` 静默吞没，导致列表恒为空
- **Rainyun 分页参数错误**: 域名列表查询参数 `per_page` 修正为 `perPage`，并补充接口要求的 `columnFilters` 与 `sort`
- **HiDNS V2 的 MX/SRV 优先级不可用**: 写入体字段由 `priority` 修正为服务端实际字段 `mx`，读取改为 `mx ?? priority`。此前优先级既写不进也读不出，恒为 0
- **HiDNS V2 域名列表在 Token 认证下为空**: 接口在 Token 认证时返回裸数组，适配器此前只识别 `{ total, list }` 形状，现兼容两种响应
- **HiDNS V2 多处字段名不匹配**: 域名、记录数、到期时间、更新时间分别修正为 `name`、`record_count`、`expires_at`、`updated_at`，并保留旧字段兜底
- **HiDNS V2 连接检测误判**: `check()` 现同时接受 `apiVersion` 为 `2` 或 `v2` 并支持顶层取值，此前要求严格等于 `v2`，会把返回 `2` 的服务端判为失败

### 🧹 优化
- **Rainyun 请求头统一**: `X-Api-Key` / `X-API-Key` 统一为小写 `x-api-key`
- **Rainyun 取值容错**: 记录列表与记录详情增加 `|| []` 兜底，避免响应缺字段时抛异常
- **HiDNS V2 类型完善**: 补充 `third_id`、`record_count`、`expires_at`、`mx`、`updated_at` 等字段声明，`id` 类型放宽为 `string | number`
- **清理未使用导入**: Rainyun 适配器移除 4 个未使用导入

### 📝 文件变更
- `server/src/lib/dns/providers/rainyun/adapter.ts` - 响应字段、分页参数与取值容错修正
- `server/src/lib/dns/providers/rainyun/auth.ts` - 请求头统一为小写
- `server/src/lib/dns/providers/hidns_v2/adapter.ts` - 字段名、响应形状、MX 写入与连接检测修正

### ⚠️ 已知风险与行为变化
- **HiDNS V2 `ThirdId` 格式变更（待修复）**: `ThirdId` 由 `${domainType}:${id}` 改为裸 id，经 `createAdapter` 写入 `config.zoneId` 后无法被 `parseDomainRef` 恢复（仅含冒号时才切分），4 处记录操作将恒发 `domainType=internal`。使用非 `internal` 类型域名的账号需验证后另行修复
- **HiDNS V2 连接检测变宽松**: `check()` 移除了原 `GET /domains` 探测，不再验证凭据能否实际读取数据，"测试连接"由强校验退化为仅版本探测

## [2.1.3] - 2026-08-02

### 🧹 优化
- **前端效果优化**: 前段首页与登录页效果展示优化，强调https环境下密码非对称加密传输

## [2.1.2] - 2026-07-29

### 🐛 Bug 修复
- **NS记录过滤过宽**: Dnspod/Gcore 适配器全局过滤了所有 NS 记录，现改为只过滤 @（根域名）的托管商默认 NS 记录，保留子域名 DNS 委派 NS 记录
- **PostgreSQL 布尔类型不兼容**: 修复 `ns_monitor_domains.enabled` 字段在 PostgreSQL 下因类型为 `integer` 却传入 `boolean` 导致写入失败的问题

### 🧹 优化
- **业务适配器 enabled 传参**: 统一所有 `enabledValue` 传参方式为 `'1'`，避免 DB 类型判断分支

### 📝 文件变更
- `server/src/lib/dns/providers/dnspod/adapter.ts` - 增加 `Name` 检查，只过滤根域名 NS
- `server/src/lib/dns/providers/gcore/adapter.ts` - 增加 `Name` 检查，只过滤根域名 NS
- `server/src/db/bal/business-adapter.ts` - 统一 enabled 传参为 `1`

## [2.1.1] - 2026-07-28

### 🐛 Bug 修复
- **运行时间显示 0 问题**: 修复 CSS 选择器类名不匹配（`t-statistic__value` → `t-statistic-content-value`），运行时间前不再显示多余的 0
- **HTTP 探针无数据**: 修复 `fetchWithFallback` 直连 `fetch()` 路径未记录 HTTP 探针的问题，现在无论是否启用代理，所有 HTTP 请求都会记录延迟
- **DNS 明文探针无数据**: 修复 `preferEncrypted` 模式下加密 DNS 成功后不记录明文探针的问题，现在加密查询成功后并行发起明文查询（fire-and-forget）并记录探针

### 🔧 优化
- **探针采集覆盖**: `fetchWithFallback` 所有分支（直连、代理、降级）均统一记录 HTTP 探针

### 📝 文件变更
- `client/src/styles/globals.css` - 修复 CSS 选择器类名
- `server/src/lib/proxy-http.ts` - 直连路径添加 HTTP 探针记录
- `server/src/lib/dns/resolver/resolver.ts` - 并行采集明文 DNS 探针

## [2.1.0] - 2026-07-27

### 🚀 新功能
- **系统资源监控面板**: 全新资源监控系统，支持 CPU/内存/磁盘/运行时间/队列深度/数据库查询等系统指标实时监控
- **DNS Zone 文件导出**: 支持将域名解析记录导出为标准 BIND Zone 文件格式，包含 ASCII 标识和 HiDNS 信息
- **Zone 导出格式选择**: 弹窗让用户选择"相对主机名"（默认，使用 @ 和相对子域名）或"完整主机名（FQDN）"（所有记录为完整域名）
- **DNS 加密/明文探针拆分**: 将 DNS 探测数据拆分为加密（DoH/DoT）和明文两个独立指标，分别记录 p50/p95/p99 延迟百分位
- **探针百分位持久化**: p50/p95/p99 延迟百分位数据持久化到数据库，服务重启后不丢失
- **HiDNS ASCII 标识**: 启动日志和 Zone 文件头部添加 HiDNS ASCII 艺术字标识

### 🐛 Bug 修复
- **DNSPod 导出失败**: 修复 DNSPod 分页导出时 `ResourceNotFound.NoDataOfRecord` 错误导致无限循环的问题
- **DNSPod 记录获取修复**: 修复 DNSPod 适配器吞掉非预期错误导致前端无法感知的问题
- **运行时间显示修复**: 修复运行时间小于 30 分钟时显示为 0 的问题，改为秒级精度实时显示
- **P50/P95/P99 数据覆盖**: 修复数据库 NULL 值覆盖 RingBuffer 实时有效百分位数据的问题
- **探针数据清空问题**: 修复 clearProbes() 每 60 秒清空 RingBuffer 导致前端 loading 直到新数据积累的问题

### 🔧 优化
- **资源监控架构重构**: 采用高频采集、低频写入、内存 RingBuffer、时序数据管理架构
- **WebSocket 轮询保底**: 始终使用轮询获取资源监控数据（15 秒间隔），WebSocket 不稳定时自动保底
- **运行时间显示优化**: 仅显示格式化字符串（Xd Xh Xm Xs / X天 X小时 X分钟 X秒），英文版/中文版自适应
- **数据库初始化流程**: 优化启动顺序：connect() → initializeDSM() → checkpoint() → disconnect() → connect() → 启动业务服务
- **DSM Schema 完善**: 为 `resource_metric_history` 表添加 `uptime_seconds` 等缺失列定义

### 💄 样式
- **页面标题字体阴影**: 暗夜模式黑色阴影、白昼模式白色阴影，确保自定义背景时标题可见
- **按钮字体阴影**: 所有按钮添加自适应字体阴影，提升自定义背景下的可读性

### 🌐 国际化
- **全语言 i18n 对齐**: 补齐 11 种语言（en/zh-CN/ja/ar/de/es/fr/ko/pt/ru/zh-CN-Mesugaki）的 Zone 导出和资源监控相关翻译键

### 📝 技术细节
- **文件变更**:
  - `server/src/service/resource/` - 资源监控服务全套（collector、cache、resolver、monitor、job）
  - `server/src/db/bal/resource-metrics-operations.ts` - 资源指标 BAL 层
  - `server/src/db/dsm/schemas/complete-schema.ts` - 资源监控相关表 schema
  - `server/src/routes/resource-monitor.ts` - 资源监控路由
  - `server/src/routes/records.ts` - Zone 导出功能
  - `server/src/lib/dns/providers/dnspod/adapter.ts` - DNSPod 错误处理修复
  - `server/app.ts` - HiDNS ASCII 标识、启动流程优化
  - `client/src/pages/ResourcePanel.tsx` - 资源监控面板
  - `client/src/pages/Records.tsx` - Zone 导出 UI
  - `client/src/api/resource-monitor.ts` - 资源监控 API
  - `client/src/api/records.ts` - Zone 导出 API
  - `client/src/styles/globals.css` - 字体阴影、运行时间样式
  - `client/src/i18n/locales/*.json` - 11 种语言文件更新
  - `client/package.json`, `server/package.json`, `package.json` - 版本 2.1.0

## [2.0.12] - 2026-07-15

### 🚀 新功能
- **CNAME 展平支持确认**: 为 Cloudflare、DNSHE、Gcore、DnsNeko、DNSPod、Aliyun、AliyunESA、Huawei、Spaceship 启用 `cnameFlattening: true`

### 🐛 Bug 修复
- **DNSPod/Gcore 系统 NS 记录过滤**: 过滤托管商默认 NS 记录（`*.dnspod.net`、`*.dnsv2-5.com`、`*.gcorelabs.net`、`*.gcdn.services` 等），避免与 CNAME 冲突导致无法创建解析
- **DNSPod NS 值末尾点号处理**: `.replace(/\.+$/, '')` 去除尾部点号再匹配，兼容 `f1g1ns2.dnspod.net.` 格式

### 📝 技术细节
- **文件变更**:
  - `server/src/lib/dns/providers/dnspod/adapter.ts` - `isSystemNsRecord()` 过滤系统 NS，`DNSPOD_NS_SUFFIXES` 覆盖全套餐
  - `server/src/lib/dns/providers/gcore/adapter.ts` - 过滤 `*.gcorelabs.net`、`*.gcore-dns.com`、`*.gcdn.services`
  - `server/src/lib/dns/providers/registry.ts` - 9 家提供商 `cnameFlattening: true`
  - `client/package.json`, `server/package.json`, `package.json` - 版本 2.0.12

## [2.0.11] - 2026-07-15

### 🐛 Bug 修复
- **CF 域名被误禁用**: Cloudflare 适配器仅返回 `status=active` 的 zone，避免暂停/删除的 zone 被计入域名列表；同步任务增加空结果安全网，当提供商返回 0 域名但数据库仍有域名时跳过同步，防止全量清空 `enabled`
- **同步任务分页错误处理**: 任何分页请求失败（429 限流、403 等）均跳过同步，不再使用可能不完整的部分结果

### 🔧 优化
- **Cloudflare 域名列表过滤**: API 请求添加 `&status=active` 参数，只同步活跃的域名

### 📝 技术细节
- **文件变更**:
  - `server/src/lib/dns/providers/cloudflare/adapter.ts` - `&status=active` 过滤、`CfZone.status` 字段
  - `server/src/service/domainSyncJob.ts` - 空结果安全网增强、所有分页错误跳同步
  - `client/package.json`, `server/package.json`, `package.json` - 版本 2.0.11

## [2.0.10] - 2026-07-14

### 🚀 新功能
- **HiDNS V2 提供商适配**: 新增 `hidns-v2` DNS 提供商，支持 Bearer 认证、动态线路获取、记录类型透传、域名同步
- **DNS 记录类型 API**: 新增 `GET /api/domains/{id}/record-types` 接口，前端从后端动态获取支持的记录类型
- **记录类型与服务端验证**: 新增 `isTypeSupportedByProvider()` 验证，POST/PUT/batch 三入口校验记录类型是否被提供商支持；动态类型提供商（HiDNS V2）跳过静态核验
- **DnsNeko 适配器完善**: 扩展至 20 种记录类型（`DNSNEKO_RECORD_TYPES`），动态调用 `GET /geo-lines` 获取线路数据
- **Modal 点击外部配置**: `Modal.tsx` 新增 `closeOnOverlayClick` 属性，默认 `false`，表单弹窗不再因点击背景关闭
- **虚拟滚动支持**: `Table.tsx` 和页面组件增加虚拟滚动，优化大量数据渲染性能

### 🔧 优化
- **DSM Schema 自动生成**: 替换三个手写方言文件为 `generate-sql.ts` 统一生成，`complete-schema.ts` 为唯一数据库定义源
- **前端打包与渲染性能**: 优化 Vite 配置和 React 渲染，提升页面加载速度
- **线路选择器重构**: 替换虚拟滚动为搜索过滤，提升线路选择体验
- **域名列表布局优化**: 优化单元格截断和布局效果
- **数据库文件名统一**: 默认数据库名统一规范化

### 🐛 Bug 修复
- **Gcore 重复记录显示**: `mapRRSetToRecords()` RecordId 追加索引，同一 RRset 的多条记录不再冲突
- **Gcore 动态线路禁用**: `getRecordLines()` 仅返回默认线路，保留原动态代码注释
- **DNSPod 线路重复/过滤**: 移除 `N.` 前缀虚拟线路，重复 ID 自动去重
- **DnsNeko 线路硬编码**: `getRecordLines()` 改为动态从 API 获取地理线路
- **NS 监测开关样式**: 修复开关被压缩成圆点的问题
- **Modal 表单意外关闭**: 点击外部不再自动关闭编辑/添加弹窗

### 📝 技术细节
- **文件变更**:
  - `server/src/lib/dns/providers/hidns-v2/` - HiDNS V2 适配器全套（**新建**）
  - `server/src/lib/dns/providers/dnsneko/adapter.ts` - 20 种类型 + 动态 geo-lines
  - `server/src/lib/dns/providers/dnspod/adapter.ts` - 线路去重 + N. 前缀过滤
  - `server/src/lib/dns/providers/gcore/adapter.ts` - 重复记录修复 + 动态线路禁用
  - `server/src/lib/dns/providers/registry.ts` - DNSNEKO_RECORD_TYPES、hidns-v2 注册、proxiable 能力
  - `server/src/lib/dns/DnsInterface.ts` - line name 可选
  - `server/src/lib/dns/record-types.ts` - E-ALICS/ALICS 移除
  - `server/src/routes/records.ts` - isTypeSupportedByProvider 提供商类型验证
  - `server/src/routes/domains.ts` - record-types API、safe config 解析
  - `server/src/mcp/tools.ts` - create/update 记录类型验证
  - `server/src/db/dsm/schemas/` - 方言文件移除 + generate-sql.ts 统一生成
  - `client/src/components/Modal.tsx` - closeOnOverlayClick 属性
  - `client/src/pages/Records.tsx` - recordTypes API 集成
  - `client/src/api/domains.ts` - recordTypes 方法
  - `client/src/api/types.ts` - DNSLine.name 可选、proxiable
  - `client/src/components/RecordForm.tsx` - 代理标志支持
  - `client/src/components/Table.tsx` - 虚拟滚动
  - `client/src/pages/domains/NSMonitorTab.tsx` - 列省略号 + 开关样式修复
  - `client/package.json`, `server/package.json`, `package.json` - 版本 2.0.10

## [2.0.9] - 2026-06-25

### 🚀 新功能
- **RecordType 统一与结构化**: 前后端共享 `RecordType` 联合类型（78 种 IANA 有效类型），`DNS_RECORD_DEFS` 包含 `valueType`、`extraFields`（优先级/权重/端口/算法/标志等）、`validateRecordValue()`、`validateExtraField()`
- **复合值组合**: 为 URI/HTTPS/SVCB/CAA/CERT/DS/SSHFP/IPSECKEY/DNSKEY/TLSA/SMIMEA 添加 `composeValue()`/`parseInitialValue()`，自动组装和解析前缀字段值
- **数据驱动表单**: `RecordForm.tsx` 从 `DNS_RECORD_DEFS` 动态渲染额外字段，无需手写每种类型的控件
- **新增记录类型**: 增加 TLSA、SMIMEA、IPSECKEY、DNSKEY、SSHFP、DS、CERT、URI 等 DNSSEC 和安全记录支持

### 🔧 优化
- **代理记录类型缩减**: `PROXIABLE_RECORD_TYPES` 仅保留 A/AAAA/CNAME，移除 HTTPS
- **i18n 字段标签**: 额外字段标签使用 `t('records.<key>')` 国际化，回退到英文标签
- **Vite base 路径**: `vite.config.ts` `base` 从 `'./'` 改为 `'/'`（绝对路径）
- **类型安全**: `DnsRecord.type` 和 `Provider.capabilities.dns.recordTypes` 全部使用 `RecordType` 类型
- **DOMAIN_VALUE_TYPES**: 改为从 `DNS_RECORD_DEFS` 动态计算
- **后端验证重构**: 路由层调用 `validateRecordValue()` 替代内联验证

### 🐛 Bug 修复
- **HTTP 不安全请求升级**: 禁用 `upgradeInsecureRequests` CSP 头，兼容 HTTP 部署

### 📝 技术细节
- **文件变更**:
  - `server/src/lib/dns/record-types.ts` - 统一记录类型定义与验证（**新建**）
  - `client/src/types/record-types.ts` - 前端镜像（**新建**）
  - `client/src/components/RecordForm.tsx` - 数据驱动表单重写
  - `server/src/routes/records.ts` - 后端验证委托
  - `client/src/api/types.ts` - 类型导入更新
  - `client/src/pages/Records.tsx` - 导入调整
  - `client/src/pages/MailSetupModal.tsx` - 类型兼容处理
  - `server/src/lib/dns/providers/registry.ts` - 能力类型同步
  - `client/vite.config.ts` - base 路径调整
  - `client/package.json`, `server/package.json`, `package.json` - 版本 2.0.9

## [2.0.8] - 2026-06-20

### 🐛 Bug 修复
- **JWT 密钥多模块不一致导致 WebSocket 鉴权失败**: `auth.ts` 与 `websocket.ts` 各维护一套独立的 `BASE_JWT_SECRET` + `getRuntimeSecret`，若 `JWT_SECRET` 环境变量未设置则生成不同随机密钥，前端 WebSocket 连接被拒绝。统一抽离到 `server/src/service/jwt.ts`，两模块共享同一份密钥
- **UDP 域名查询不支持 IPv6 DNS 服务器**: `dgram.createSocket('udp4')` 创建的 IPv4-only socket 发送到 IPv6 地址时报 `send EINVAL`。改为通过 `parseHostPort` 检测地址类型，IPv6 用 `udp6` socket、IPv4 用 `udp4` socket
- **DoH 查询 HTTP 4xx 无回退**: Alidns 对特定域名拒绝 Google JSON API 格式（`?name=&type=`）返回 HTTP 400，导致 DNS 查询失败。改为收到 HTTP 4xx 时自动回退到 `queryDoHWire()`（RFC 8484 wire format）

### 🔧 优化
- **DNS Resolver IPv6 兼容**: `parseHostPort()` 统一替换 `split(':')`，覆盖 UDP/TCP/DoT 全部 DNS 解析路径

## [2.0.7] - 2026-06-19

### 🚀 新功能
- **MCP 禁用态页面**: 全局 MCP 关闭时 `/dash/mcp` 显示禁用提示而非加载管理 UI，支持 10 种语言

### 🐛 Bug 修复
- **Gcore 域名误禁用**: `request()` 静默吞掉所有 API 错误返回空对象，导致 `domainSyncJob` 认为账号下没有域名而禁用全部域名。改为请求失败时 `throw`，并增加 `getError()` 安全网双重防护
- **SQLite 写入未持久化**: WAL 模式下缺少 `PRAGMA synchronous = NORMAL`，重启后数据丢失。新增关闭前 WAL checkpoint + init 完成后强制 checkpoint

### 🔧 优化
- **WHOIS 内存缓存移除**: `WhoisLookup.cache` 无上限 Map 移除，完全依赖 `whois_cache` 数据库缓存（3 小时 TTL），解决内存占用
- **WHOIS 数据库缓存裁剪**: `whois_cache` 表最多保留 100 条，防止无限膨胀
- **SQLite 写入性能**: `PRAGMA synchronous = NORMAL` 消除每次提交的 fsync 等待

## [2.0.6] - 2026-06-16

### 🚀 新功能
- **域名续期高级筛选**: 续期页面新增账号选择器、启用/禁用状态筛选、可折叠筛选面板
- **到期时间自动同步**: `domainSyncJob` 定时同步各提供商返回的 `ExpiresAt` 到本地 `renewable_domains.expires_at` 字段
- **后端续期状态统计**: `GET /api/domains/renewable-domains` 返回 `active`/`expiring`/`expired` 计数（过期阈值 60 天）

### 🔧 优化
- **续期路由泛化**: `POST /api/domains/:id/renew` 通过 `renewalRegistry` 调度，新增续期提供商无需修改路由
- **上游错误透传**: 续期失败时上游 API 原始错误信息直接返回给客户端，不再吞并为 "Renewal failed"
- **提交移除子域名参数**: 续期接口不再需要 body 参数，后端从数据库推导
- **DNS 服务商能力定义重构**: 统一能力定义结构，提高可扩展性
- **过期阈值调整**: 续期过期提醒阈值从 30 天调整为 60 天

### 🐛 Bug 修复
- **Docker 构建失败**: `DomainRenewalTab.tsx` 中 `ReactNode` 未使用 `type` 导入，导致 `verbatimModuleSyntax` 下 tsc 报错
- **CNAME 冲突校验路径错误**: `RecordForm` 中 capabilities 引用路径修复

## [2.0.5] - 2026-06-15

### 🐛 Bug 修复
- **dpdns_reverse 域名每日被禁用**: `getDomainList()` 未实现导致 `domainSyncJob` 将 dpdns_reverse 账号下所有域名/续期域名视为不存在而禁用
  - `getDomainList()` 由空列表改为调用 dpdns API 获取真实域名列表
  - 拆分 `fetchAllDomains()` 内部方法，`listFreeDomains()` 和 `listAllDomains()` 均复用该统一 API 调用

### 🔧 优化
- 完善 GitHub Release 工作流（CHANGELOG 路径修复、PR/Commits 自动汇总）
- 补充版本发布流程和提交信息格式文档

## [2.0.4] - 2026-06-15

### 🚀 新功能
- **dpdns_reverse 提供商**: 新增 DigitalPlat Domains 逆向实现，支持 free 域名列表拉取、续期及定时调度
- **账号按用途过滤**: GET /api/accounts?purpose=dns|renewal 后端过滤，前端域名列表/续费页使用
- **i18n 国际化**: 新增多语言支持（中/英/日/韩/法/德/西/葡/俄/阿），替换 useTranslation 为 useI18n
- **服务商名称本地化**: Accounts 页面、域名列表编辑页、域名续费页使用 t('provider.xxx') 国际化 key

### 🐛 Bug 修复
- **MySQL LIMIT/OFFSET**: 修复 prepared statement 不支持 LIMIT/OFFSET 参数绑定，改为内联整数
- **MySQL 日期格式**: parseDpdnsDate 输出 ISO 8601 格式导致 DATETIME 列写入失败，改为 YYYY-MM-DD HH:mm:ss
- **DSM schema 重建 NOT NULL 冲突**: rebuildTableForSQLite 在 INSERT...SELECT 时对 NOT NULL 列使用 IFNULL 兜底默认值
- **通知渠道无法添加**: NotificationChannels useEffect 用 API 数据覆盖本地未保存的新 channel，新增编辑中跳过逻辑
- **dpdns_reverse 认证**: 添加完整 Chrome 131 浏览器请求头绕过风控拦截
- **Dashboard 提供商分布**: 修复 provider 名称 i18n key 错误

### 🔧 优化
- dpdns_reverse 认证头优化
- 分页参数类型安全处理
- schema-reconciler 字段迁移兼容性提升
- Provider 注册表添加 dns/renewal 能力标识

## [2.0.3] - 2026-06-12

### 🚀 主要更新

#### WHOIS 服务架构重构 ⭐
- **全新适配器+工厂模式架构**：替换旧的调度器体系，实现 WHOIS/RDAP/HTTP-API 三种标准查询适配器
  - WHOIS 协议适配器（端口 43 文本查询）
  - RDAP 协议适配器（HTTP RESTful JSON）
  - HTTP API 适配器（支持自定义字段映射，如 DnsNeko、whoiscx）
- **统一提供商注册表**：`registry.ts` 集中管理顶域/子域/第三方提供商定义，支持多协议并行查询
- **分层并行竞速策略**：顶域 RDAP→WHOIS→HTTP-API→第三方 与 子域 DNS→RDAP→WHOIS→第三方 的智能查询链路
- **DNS 提供商 WHOIS 自动注册**：通过 `whoisSchedulers` 数组自动汇集调度器，新增提供商无需改动 WHOIS 模块
- **查询模式过滤**：新增 `mode` 参数，支持指定上游查询模式（rdap/whois/http），可多选，默认全部
- **平级查询控制**：新增 `noUplevel` 提供商配置，限制 DnsNeko 等限定后缀提供商的平级查询范围
- **状态规范化**：HTTP API 适配器支持状态字段数组转字符串
- **第三方提供商扩展**：新增 whoiscx HTTP API 第三方 WHOIS 提供商
- **创建时间提取**：`WhoisResult` 新增 `creationDate` 字段，DnsNeko 等 HTTP-API 提供商支持注册时间解析
- **缓存策略调整**：内存缓存 TTL 从 6 小时调整为 1 小时（数据库缓存保持 3 小时）

#### SEA 二进制服务管理 ⭐
- **服务安装/卸载支持**：`-i install/-i uninstall` 参数支持 Windows/Linux/macOS 三平台服务部署
  - install 自动携带 `-l info -p 3001` 启动参数
  - Windows 注册为系统服务，Linux 创建 systemd 单元，macOS 使用 launchd plist
- **SEA 自动更新**：`-u on/off` 参数控制自动更新开关
  - 启动时检查 GitHub Releases 新版本，之后每小时检查一次
  - 检测到新版本后自动下载并替换二进制文件后重启服务
  - 支持 Windows/Linux/macOS 全平台

#### 前端增强
- **关于页最新版展示**：新增 GitHub 最新发布版本卡片，支持点击跳转官方发布页
- **多语言补全**：补充关于页最新版块相关的国际化词条

### 📝 技术细节

#### 修改文件统计
- **WHOIS 模块重构**（核心）：
  - `service/whois/types.ts` - 新增 `WhoisResult.creationDate`、`WhoisProviderDefinition.noUplevel`
  - `service/whois/registry.ts` - 新增查询模式过滤、whoiscx 第三方提供商、DnsNeko registerTimeKey
  - `service/whois/lookup.ts` - 分层并行竞速策略重构、查询模式过滤、缓存 TTL 调整
  - `service/whois/methods/http-api.adapter.ts` - 创建时间提取、状态规范化
  - `service/whois/methods/dns-provider.registry.ts` - DNS 提供商自动注册
  - `routes/rdap.ts` - 新增 `mode` 查询参数文档与支持
- **SEA 功能**：
  - `scripts/service-manager.ts` - 跨平台服务管理（**新建**）
  - `scripts/auto-updater.ts` - 自动更新服务（**新建**）
  - `scripts/build-sea.mjs` - 更新支持 `-u` 参数打包
  - `app.ts` - CLI 参数解析扩展
- **前端**：
  - `pages/about/About.tsx` - 最新版 GitHub Release 卡片

### 🔧 兼容性
- ✅ WHOIS 模块完全向后兼容，旧配置和数据不受影响
- ✅ SEA 二进制新增 `-i`/`-u` 参数，不影响现有 CLI 用法
- ✅ 公开 RDAP 路由新增 `mode` 参数，默认行为不变

---

## [2.0.2] - 2026-06-10

### ⚠️ 重大变更

**Node.js 最低版本要求提升至 24.x**：因底层数据库驱动迁移至内置 `node:sqlite` 模块，需 Node.js 24+ 运行环境。

### 🚀 主要更新

#### SEA（Single Executable Applications）二进制打包支持 ⭐
- **node:sqlite 模块迁移**：将底层数据库驱动从 `better-sqlite3` 替换为 Node.js 24+ 内置的 `node:sqlite` 模块
  - 彻底解决 SEA 打包中原生模块的加载兼容性问题
  - 消除对预编译 `.node` 文件的依赖，简化构建流程
  - 同步驱动性能无损失，保持现有数据库操作行为一致
- **跨平台 SEA 构建**：支持将前后端打包为单一可执行二进制文件
  - **Windows**：x64 + ARM64 双架构支持
  - **Linux**：x64 + ARM64 双架构支持
  - **macOS**：x64 + ARM64（Universal Binary）双架构支持
- **嵌入式静态资源**：前端构建产物内嵌至后端代码，二进制独立运行无需外部静态文件
- **CLI 参数支持**：SEA 二进制支持 `-p/--port` 和 `-l/--log-level` 参数传递
  - 示例：`./HiDNS-Windows-x64-v2.0.2.exe -l info -p 3001`
- **数据库路径适配**：SEA 环境下自动使用平台标准应用数据目录（`%APPDATA%/HiDNS` 等）
- **构建脚本增强**：`build-sea.mjs` 支持跨架构下载、tarball 解压和重定向跟随

#### CI/CD 工作流全面升级 ⭐
- **CI 强制 Node.js 24+**：所有工作流程统一使用 Node.js 24.x
- **Release 工作流重构**：
  - 新增 SEA 二进制并行构建步骤（Windows/Linux/macOS 共 6 个 job）
  - 优化 String 类型目录变量传递，避免 JSON 解析错误
  - ARM64 构建改用原生 ARM runner（Windows ARM64 + Linux ARM64），移除 QEMU 模拟
  - 缩短 Windows ARM64 超时限制（360 → 120 分钟）
  - 为各平台发布包添加 `-Package` 后缀，与 SEA 二进制命名区分
  - 新增 `checksums.txt` 校验和文件，包含所有构建产物的 SHA256 哈希
- **Nightly Docker Build 优化**：改用 ARM runner 避免 QEMU 模拟兼容性问题
- **清理冗余文件**：删除 e2e 和 client 目录下无用的 `package-lock.json`

#### 服务监控增强
- **检查结果推送**：新增服务监控检查结果的 WebSocket 实时推送
- **检查接口超时延长**：延长检查接口超时时间，适配慢速场景
- **queryKey 统一**：统一 React Query 的 queryKey，确保数据正确刷新
- **启用状态校验**：在切换检查中增加域名和账号启用状态校验，防止误操作
- **智能域名匹配**：外部 API 调用新增智能域名匹配逻辑

#### 前端优化
- **仪表盘限制**：仪表盘最近操作展示数量限制为最多 15 条，避免列表过长
- **体验优化**：操作类型分布统计不受限制，保留完整 24h 数据视图

### 🐛 Bug 修复

- **SEA 构建**：修复跨架构构建时 Node.js 二进制下载失败（404）和重定向问题
- **pnpm v11 兼容性**：修复构建脚本审批配置从 `package.json` 迁移至 `pnpm-workspace.yaml` 的兼容性问题
- **发布包命名**：修复 Linux ARM64 传统包与 SEA 产物命名冲突（均添加 `-Package` 后缀区分）
- **服务监控**：修复切换检查中未校验域名和账号启用状态的问题

### 📝 技术细节

#### 修改文件统计
- **后端核心**：
  - `scripts/build-sea.mjs` - SEA 跨架构构建脚本（**新建/重写**）
  - `scripts/embed-client.mjs` - 前端资源内嵌工具（**新建**）
  - `sea-config.json` - SEA 配置文件（**新建**）
  - `app.ts` - CLI 参数解析 + 静态资源内嵌加载 + MIME 类型修复
  - `db/dl/sqlite.ts` - node:sqlite 驱动迁移
  - `db/dal/config.ts` - 数据库路径适配（SEA 环境）
- **CI/CD**：
  - `.github/workflows/release.yml` - 全面重写，新增 SEA 构建和校验和上传
  - `pnpm-workspace.yaml` - pnpm v11 构建配置迁移
- **前端**：
  - `pages/dash/Dashboard.tsx` - 仪表盘活动日志限制
  - `api/providers.ts` - 智能域名匹配 API

#### 构建架构
| 平台 | 架构 | SEA | 传统包 | 校验和 |
|------|------|-----|--------|--------|
| Windows | x64 | ✅ | ✅ | ✅ |
| Windows | ARM64 | ✅ | ✅ | ✅ |
| Linux | x64 | ✅ | ✅ | ✅ |
| Linux | ARM64 | ✅ | ✅ | ✅ |
| macOS | ARM64 | ✅ | ✅ | ✅ |
| macOS | x64 | ✅ | ✅ | ✅ |

### 🔧 兼容性
- ⚠️ **Node.js 24+ 必需**：`node:sqlite` 模块是 Node.js 24 内置模块，无法降级
- ⚠️ **pnpm v11+ 必需**：pnpm workspace 配置格式已更新
- ✅ 数据库文件自动适配（开发/SEA/pkg 不同环境）
- ✅ 前端构建产物嵌入 SEA 二进制，无需额外部署
- ✅ 传统 Docker/源码部署方式不受影响
- ✅ `better-sqlite3` 依赖已移除，`package.json` 和 `node_modules` 无需包含该包

---

## [2.0.1] - 2026-06-08

### 🚀 主要更新

#### DNSNeko 域名解析服务商适配 ⭐
- **新增 DNSNeko 适配器**：支持 DNSNeko 域名解析服务商的完整集成
  - 域名列表获取、DNS 记录增删改查、线路切换等功能
  - 配置项支持用户名和 API Key 验证
  - 内置 DNSNeko 服务商图标与图标配置
  - 修复 DNSNeko 适配器的 API 解析异常和记录操作逻辑

#### 服务端分页与搜索优化 ⭐
- **多模块分页支持**：为多个模块添加真正的服务端分页、搜索和类型过滤功能
  - 域名续期页、NS 监测页、服务监控页的分页向后端数据库迁移
  - 分页总数显示优化，统一展示格式（如 "共 N 页数据"）
  - NS 监测页新增按域名搜索功能
  - NS 监测页和服务监控页样式优化
  - 服务监控 Tab 切换添加玻璃背景效果
- **Gcore DNS 适配优化**：修复 Gcore DNS 提供商的主机名处理逻辑
  - 前端展示时自动提取主机名部分（去除域名后缀）
  - 创建/更新记录时自动拼接完整主机名

#### 数据库兼容性增强
- **PostgreSQL 全面兼容**：
  - 统一 `enabled` 字段的布尔值表示方式，修复 PostgreSQL 中 `integer = boolean` 错误
  - 兼容 PostgreSQL 布尔参数类型
  - 优化 PostgreSQL Schema 比对时的列类型变更和新增列的错误处理
- **MySQL 字段变更容错优化**：增强 MySQL 字段变更时的错误处理
- **DSM 迁移增强**：
  - 处理新增非空列时已有数据含空值的情况
  - 修复数据库 Schema 比对未校验字段长度的问题
  - 补全别名匹配时的长度校验逻辑
  - 调整 `domain` 表 `status` 字段长度为 500

#### 前端样式与组件优化
- **SSL 信息列拆分**：将服务监控 SSL 标签页的单一 `ssl_info` 列拆分为加密类型、颁发机构、验证级别、SAN 域名四个独立列
- **Tooltip 溢出修复**：移除表格容器多余的 `overflow: hidden` 样式，修复 TDesign Tooltip 被裁剪的问题
- **Table 组件增强**：支持自定义表格列省略配置（`ellipsis` 属性），允许特定列关闭溢出省略

#### RDAP 公开查询速率限制
- **新增速率限制**：为 `/api/rdap/domain/{domain}` 接口添加速率限制
  - 未认证（公开 IP）：2 请求/秒
  - 已认证（携带 Cookie 或 API Token）：不限速

### 🐛 Bug 修复

- **DNSNeko 适配器**：
  - 修复类型转换错误导致的 ID 提取失败（类型安全修复）
  - 修复 API 解析异常和记录操作逻辑问题
- **DSM 迁移引擎**：
  - 修复新增非空列时已有数据含空值的兼容性问题
  - 修复 Schema 比对未校验字段长度的问题
  - 补全别名匹配时的长度校验逻辑
- **数据库兼容性**：
  - 修复 PostgreSQL 中 `enabled` 字段布尔值与整数比较错误
  - 修复 PostgreSQL Schema reconcile 中新增列的错误处理
  - 增强 MySQL 字段变更容错
- **域名表结构**：调整 `domain` 表 `status` 字段长度至 500，避免数据截断

---

## [2.0.0] - 2026-06-07

### ⚠️ 重大变更

版本号从 1.x 跃升至 2.0.0，标志着以下三个里程碑式模块的正式引入：

- **DSM（Dynamic Schema Migration）模块** — 数据库迁移系统重构
- **MCP（Model Context Protocol）支持**（Beta）— AI 协议集成
- **Service Monitor（服务监控）**（Beta）— 复合型服务状态监控

### 🚀 主要更新

#### DSM 模块引入 ⭐
- **动态 Schema 迁移系统**：全新的数据库迁移架构，支持运行时自动检测和执行迁移
- **智能列验证**：`column-validator.ts` 自动化列存在性检查，确保幂等迁移
- **三数据库一致性**：MySQL/PostgreSQL/SQLite 迁移逻辑完全对齐，消除差异
- **语义化版本追踪**：`semantic_version` 字段实现细粒度版本管理和追踪
- **迁移完整性验证**：34 张表、全部索引和迁移脚本已对齐验证
- **跨版本跃升支持**：当前测试阶段支持从 1.2.0 直接跃升到最新版本

#### MCP（Model Context Protocol）协议集成（Beta）⭐
- **MCP 协议握手支持**：实现 MCP Streamable HTTP 和 SSE 传输协议
- **OAuth 2.0 授权流程**：
  - 完整的授权码流程（Authorization Code Flow）
  - 动态客户端注册（OAuth Dynamic Client Registration）
  - 令牌内省（Token Introspection，RFC 7662）
  - 令牌撤销（Token Revocation，RFC 7009）
  - 客户端凭证流程（Client Credentials Grant）
- **API Key 认证**：支持 API Key 创建、撤销、恢复、过期管理
- **MCP 能力发现端点**：`/.well-known/mcp.json` 标准化端点
- **图形化权限管理**：Web UI 模块级权限选择器（`disabled`/`read`/`write`）
- **权限粒度控制**：基于 `module:permission` 格式的细粒度授权单元
  - ns_monitor、domain_management、renewal_management、log_query、service_monitor
- **MCP 管理页面**：完整的 Web UI 管理界面，展示公共端点、JSON 配置示例
- **OAuth 授权确认页**：前端渲染的授权确认页，与登录页风格一致
- **临时客户端清理**：5 分钟定期清理未绑定临时客户端（接入任务管理器）

#### Service Monitor（服务监控）（Beta）⭐
- **故障转移全面重构**：从单一故障转移升级为复合型服务状态监控
- **三种监测类型**：
  - **SSL 证书监测**：检测站点 SSL 证书到期和有效性
  - **端点访问监测**：监测域名/URL 的可达性和响应状态
  - **DNS 故障转移**：继承原故障转移功能，自动切换 DNS 解析
- **全新表结构**：`serviceguard_monitors` + `serviceguard_status` 两张专用表
- **定时检测任务**：每 300 秒扫描待检条目，接入任务管理器
- **手动检测支持**：支持立即触发单条监测
- **MCP 集成**：5 个 MCP 工具覆盖服务监控全部操作

#### 日志系统全面重构 ⭐
- **新日志规范**：`日期 级别 [主模块名] [子模块] [函数名] [L行号] ["自定义标签"] 内容`
- **自动调用者信息捕获**：通过 `Error.stack` 自动获取函数名和行号
- **智能显示策略**：`HIDNS_LOG_LEVEL=trace` 时全部显示，否则仅 `ERROR` 级别显示
- **嵌套子模块支持**：通过 `.sub()` 实现多级子模块嵌套
- **自定义标签支持**：通过 `.tag()` 添加标注（适用于 Whois 竞速策略标注）
- **Whois 模块日志体系**：完整的四层子模块 + 策略标签体系（SUCCESS/FAILED/FALLBACK 等）
- **核心层全面迁移**：BAL/DSM/DL 所有日志调用已按新规范迁移
- **DNS Provider 标准化**：通过 `internal.ts` 强制统一日志工厂

#### OAuth 授权页前端化
- **授权确认页迁移**：从后端 HTML 模板渲染迁移到前端 React 组件
- **授权状态管理**：未登录提示 + 正确登录后跳转回授权流程
- **登录页 `return_to` 支持**：登录成功后跳转回原始页面
- **多 OAuth 类型复用**：`type=mcp` 参数标识，未来可扩展 `type=hidns`

#### 国际化与 UI 增强
- **浏览器语言自动检测**：首次访问自动匹配浏览器语言偏好
- **底栏统一**：登录页、OAuth 授权页、加载页统一添加版权底栏
- **全局 CSS 按钮颜色修复**：统一 `var(--td-brand-color)` 变量使用
- **Service Monitor 管理页面**：完整的 Web UI（表格+弹窗+手动检测）

### 📝 技术细节

#### 修改文件统计
- **后端模块**：
  - `routes/mcp-config.ts` - MCP 能力发现端点（**新建**）
  - `routes/mcp-oauth.ts` - OAuth 授权流程（重写，前端化）
  - `routes/mcp-apikeys.ts` - API Key 管理（**新建**）
  - `routes/servicemonitor.ts` - 服务监控路由（**新建**）
  - `service/serviceMonitor.ts` - 服务监控核心（**新建**）
  - `service/serviceMonitorJob.ts` - 服务监控定时任务（**新建**）
  - `service/mcp-permission.ts` - MCP 权限定义（**新建**）
  - `mcp/` - MCP 协议层（tools.ts、transport.ts 等）
  - `db/bal/business-adapter.ts` - ServiceMonitor/API Key 操作
  - `db/dsm/schema-reconciler.ts` - DSM 迁移器
  - `lib/logger.ts` - 日志系统全面重构
  - `service/whois/` - 日志规范迁移
  - `routes/failover.ts` → `routes/servicemonitor.ts`（废弃）
  - `service/failover.ts` → `service/serviceMonitor.ts`（废弃）
- **前端模块**：
  - `pages/McpManagement.tsx` - MCP 管理页面（重写）
  - `pages/McpOAuthConsent.tsx` - OAuth 授权确认页（**新建**）
  - `pages/domains/ServiceMonitorTab.tsx` - 服务监控 Tab（**新建**）
  - `pages/domains/FailoverTab.tsx` - 废弃删除
  - `App.tsx` - 路由注册
  - `components/Sidebar.tsx` - 导航更新
- **国际化**：11 个语言文件全面补全

### 🔧 兼容性
- ✅ 1.7.x 配置和数据完全兼容
- ✅ 旧版 `failover_configs`/`failover_status` 表保留，数据不受影响
- ✅ 旧版 API 路径（`/api/failover`）已废弃，重定向到 `/api/servicemonitor`
- ✅ MCP 客户端需重新注册 OAuth 客户端

---

## [1.7.2] - 2026-05-31

### 🚀 主要更新

#### 域名置顶排序优化 ⭐
- **数据库级置顶排序**：在数据库层面实现置顶域名排序，确保跨页正确显示
  - MySQL：使用 `FIELD()` 函数实现高效排序
  - PostgreSQL/SQLite：使用 `CASE WHEN` 表达式实现排序
  - 置顶域名始终排在结果集最前面，不受分页影响
- **前端加载顺序优化**：修复首次加载时置顶排序不正确的问题
  - 等待置顶列表加载完成后再查询域名列表
  - 将置顶列表加入 queryKey，确保自动刷新
  - 置顶状态变更后立即刷新域名列表
- **同名域名检查**：防止用户在不同账号下置顶同名域名
  - 保存前检查是否有重复的域名名称
  - 返回 400 错误并列出所有重复的域名
- **WebSocket 实时通知**：置顶状态变更后实时推送给前端
  - 新增 `sendToUser()` 方法，向指定用户发送消息
  - 发送 `pinned_domains_updated` 事件
  - 前端监听事件并自动刷新域名列表
  - WebSocket 断开时自动降级为轮询（60秒）

#### API 状态码统一 ⭐
- **全面统一错误响应格式**：所有 API 使用标准 HTTP 状态码
  - 400 Bad Request：参数错误、验证失败
  - 401 Unauthorized：认证失败、密码错误
  - 403 Forbidden：权限不足、账号禁用
  - 404 Not Found：资源不存在
  - 429 Too Many Requests：频率限制、账号锁定
- **业务代码映射**：HTTP 状态码 >= 400 时，业务代码与 HTTP 状态码一致
- **影响范围**：
  - auth.ts：~15 处修复（登录、2FA、WebAuthn、密码修改）
  - webauthn.ts：~8 处修复
  - settings.ts：3 处修复
- **兼容性保证**：DDNS Go 等外部适配器只检查 `code === 0`，不受影响

#### RDAP 公开查询优化
- **Punycode 标准化**：RDAP 查询时使用 Punycode 格式的域名
  - 支持国际化域名（IDN）查询
  - 自动将 Unicode 域名转换为 Punycode
  - 符合 RFC 7483 标准
- **直接透传上游响应**：上游返回 RDAP 格式时直接透传，不做转换
  - 保持数据完整性
  - 减少处理开销
  - 解析失败时降级为内部转换

### 🐛 Bug 修复

- **域名置顶排序延迟问题**：修复页面初始化时置顶排序不正确的问题
- **API 状态码不一致**：统一所有 API 的错误响应格式
- **批量操作功能禁用**：完全移除批量删除功能（后端返回 403，前端注释代码）

### 📝 文档更新

- 更新 CHANGELOG 和 RELEASE_NOTES
- 补充域名查询性能优化详细说明
- 添加 API 状态码规范说明

---

## [1.7.1] - 2026-05-31

### 🚀 主要更新

#### 域名管理增强
- **账号禁用权限控制**：禁用 DNS 账号后，该账号下的所有域名操作被完全冻结
  - 前端列表不显示禁用账号的域名
  - API 查询自动过滤禁用账号的域名（包括 DDNS Go 等外部适配器）
  - 单个域名查询、编辑等操作全部拒绝
  - DNS 记录管理（增删改查）全部拒绝
  - WHOIS 查询不受影响（公共功能）
- **账号筛选器优化**：只显示启用的账号，并显示账号类型
- **域名查询性能优化** ⭐：
  - **Token 认证智能优化**：根据 `allowedDomains` 是否为空选择最优查询策略
    - 有限制的 Token：直接根据 ID 列表查询（`getByIds`），性能最优
    - 允许所有域名的 Token：根据角色选择分页查询
  - **数据库分页支持**：使用 `LIMIT/OFFSET` 在数据库层面进行分页，而非内存分页
    - 超管查询：`DomainOperations.getAllForSuperAdminWithPagination()`
    - 普通用户查询：`DomainOperations.getAccessibleDomainsWithPagination()`
  - **性能提升**：万级域名场景下，查询速度提升 10-50 倍
  - **新增参数**：
    - `domain_status`: 支持 `'enabled' | 'disabled' | 'all'` 状态过滤
    - `include_disabled`: 兼容旧版参数（已废弃）
  - **查询日志**：添加详细的查询性能日志，便于监控和优化

#### DDNS Go 适配插件优化
- **日志国际化**：所有日志从中文改为英文，便于国际用户使用
- **分页查询支持**：
  - 域名查询支持自动分页（最多 10 页/1000 个域名）
  - 记录查询支持自动分页（最多 10 页/1000 条记录）
  - 智能终止条件检测
  - 安全限制防止过度查询
- **错误处理改进**：更详细的错误信息和上下文

#### 安全配置页面全面重构
- **数据回填问题修复**：彻底解决安全配置页面字段回显不正确的问题
  - 引入 `formHelpers` 工具模块，统一数据类型转换
  - 支持多种 API 响应格式（`data`、`config`、`rules` 包装）
  - 兼容 snake_case 和 camelCase 字段命名
  - Switch 组件正确显示布尔值状态
- **新增辅助函数**：
  - `toBoolean()` - 统一布尔值转换
  - `toNumber()` - 统一数字转换
  - `toString()` - 统一字符串转换
  - `readValue()` - 支持多键名回退的属性读取
  - `unwrapConfig()` - 解包不同格式的 API 响应
- **代码质量提升**：
  - 新增明确的 TypeScript 类型定义
  - 减少重复的类型转换逻辑
  - 提高代码可维护性

#### DNS 记录管理增强
- **新增记录详情 API**：`GET /api/domains/{domainId}/records/{recordId}`
  - 获取单个 DNS 记录的详细信息
  - 支持权限检查
  - 用于前端编辑记录时获取完整信息

### 🐛 Bug 修复

- **安全页回显问题**：✅ 已修复（通过 PR #30）
  - Switch 组件现在能正确显示所有安全配置字段的状态
  - 包括：登录限制、SMTP 配置、审计规则、安全策略等

#### 已知问题
- **SMTP 发件问题**：部分运行环境下 SMTP 无法发送邮件（待修复）
- **SQLite 数据库迁移问题**：部分 SQLite 数据库可能出现迁移失败（建议使用 PostgreSQL）

### 📝 技术细节

#### 修改的文件
- `server/src/routes/domains.ts` - 单个域名查询权限检查
- `server/src/db/query-builders/domain-query-builder.ts` - 账号 enabled 过滤
- `server/src/routes/records.ts` - 新增记录详情 API
- `client/src/pages/system/SecurityTab.tsx` - 全面重构，使用 formHelpers
- `client/src/utils/formHelpers.ts` - 新增表单辅助工具模块
- `client/vite.config.ts` - 构建配置优化（emptyOutDir）

#### 贡献者
- @zerosnowe - 安全页面回填问题修复（PR #30）

---

## [1.7.0] - 2026-05-28

### ⚠️ 重要提示

**1.6.0 系列版本为 Bug 版本，建议尽快升级到 1.7.0！**

本版本继承了 1.6.0 系列的全部变更，并修复了多个关键问题。

### 🚀 主要更新

#### 邮件模板系统升级
- **新增邮件模板管理功能**：支持 DMARC、SPF、DKIM 等邮件安全记录的快速配置
- **配置预览功能**：添加邮件记录前可预览完整配置，避免误操作
- **主题适配**：配置预览区域完美适配暗黑/明亮/跟随系统主题
- **智能冲突检测**：自动检测域名下所有解析记录，避免记录冲突
- **缓存优化**：邮件模板数据缓存 5 分钟，提升加载速度
- **悬停预览**：长文本字段（主机记录、记录值）支持鼠标悬停预览

#### 数据库迁移系统全面优化
- **语义化版本管理**：引入 `semantic_version` 字段，支持更精细的版本追踪
- **迁移幂等性增强**：所有迁移操作支持重复执行，不会因已存在而报错
- **列验证工具**：新增自动化列验证机制，确保迁移后表结构正确
- **多数据库一致性**：SQLite、MySQL、PostgreSQL 三数据库迁移逻辑完全对齐
- **错误处理改进**：
  - PostgreSQL：修复 `PRAGMA` 语法错误，改用 `INFORMATION_SCHEMA`
  - MySQL：修复 `domain_id` 删除导致的事务回滚问题
  - SQLite：修复 `ADD COLUMN IF NOT EXISTS` 不支持的语法错误
- **迁移日志优化**：详细的迁移过程日志，便于问题诊断

#### IDN 域名支持全面优化
- **后端标准化**：统一使用 `normalizeDomain()` 函数处理国际化域名
- **定时任务支持**：域名同步、续期检查等定时任务正确处理 IDN 域名
- **前端显示优化**：IDN 域名在前端统一转换为 Unicode 显示，更易读
- **API 返回策略**：根据认证方式区分 Punycode/Unicode 编码返回
- **查询优化**：IDN 域名查询使用后端接口，支持 keyword 模糊搜索

#### 前端展示优化
- **表格组件改进**：DNS 记录表格采用 `tableLayout="fixed"`，列宽更稳定
- **悬停预览功能**：NS 监测、邮件设置等页面的长文本字段支持悬停预览
- **主题切换完善**：所有新组件完美适配暗黑/明亮主题
- **缓存策略优化**：关键数据缓存 5 分钟，减少 API 请求次数
- **用户体验提升**：
  - 域名列表自动显示禁用域名（`include_disabled=true`）
  - DMARC 记录主机名智能拼接（`_dmarc.mail` 格式）
  - 冲突检测覆盖全部解析记录，不仅限于当前页

### 🐛 已知问题

#### SMTP 发件问题
- **问题描述**：部分运行环境下 SMTP 无法发送邮件
- **影响范围**：邮件通知、测试邮件功能
- **临时方案**：检查 SMTP 配置，确认网络连接和认证信息正确
- **计划修复**：1.7.1 版本将增强 SMTP 错误日志和兼容性

#### 系统 > 安全页前端回显异常
- **问题描述**：安全配置页面部分字段回显不正确
- **影响范围**：`/dash/system/security` 页面
- **临时方案**：手动重新保存配置即可
- **计划修复**：1.7.1 版本将重构安全配置页面

#### SQLite 数据库迁移问题
- **问题描述**：部分 SQLite 数据库可能出现迁移失败或升级异常
- **影响范围**：使用 SQLite 作为数据库的用户
- **建议方案**：
  1. **重建数据库**：备份数据后重新初始化
  2. **切换到 PostgreSQL**（强烈推荐）：PostgreSQL 是本项目推荐的数据库
- **原因说明**：SQLite 的 DDL 限制较多，迁移复杂度高于 PostgreSQL/MySQL

### 💡 使用建议

#### 数据库选择
**PostgreSQL 是本项目的推荐数据库**，原因：
- ✅ 迁移脚本更友好，支持 `ADD COLUMN IF NOT EXISTS`
- ✅ 表定义更灵活，类型转换更方便
- ✅ 并发性能更好，适合生产环境
- ✅ 事务支持更完善，迁移更安全

#### 升级路径
- **从 1.6.x 升级**：直接升级到 1.7.0，会自动执行所有迁移
- **从 <1.6.0 升级**：建议先升级到 1.6.3，再升级到 1.7.0
- **SQLite 用户**：强烈建议迁移到 PostgreSQL

### 📝 技术细节

#### 修改的文件
- `server/src/db/migration-manager.ts` - 语义化版本管理
- `server/src/db/column-validator.ts` - 列验证工具（新增）
- `server/src/db/schema.ts` - 迁移逻辑优化
- `server/src/db/business-adapter.ts` - 多数据库元数据查询
- `server/src/db/schemas/*.ts` - 表定义更新
- `client/src/pages/MailSetupModal.tsx` - 邮件设置页面
- `client/src/api/domains.ts` - 域名 API 参数优化

#### 新增文档
- `server/docs/database-migration-improvements.md` - 数据库迁移改进说明
- `server/docs/database-enabled-migration-comparison.md` - 多数据库迁移对比
- `server/docs/sqlite-enabled-migration-audit.md` - SQLite 迁移审计报告
- `server/scripts/diagnose-sqlite.js` - SQLite 诊断工具

---

## [1.6.3] - 2026-05-27

### 🐛 修复

#### 数据库迁移完整性修复
- **问题描述**：PostgreSQL `dns_accounts` 表 export-rebuild 迁移后索引丢失；PostgreSQL 旧表升级时 `COALESCE(enabled, TRUE)` 读取不存在列；SQLite `dns_accounts` 表缺失 `enabled` 列定义及相关索引
- **原因分析**：PostgreSQL export-rebuild 采用 DROP+CREATE+RENAME 模式，原表索引不会自动迁移到新表；`dns_accounts` CREATE TABLE 未定义 `enabled` 列，旧版本直接建表时该列不存在
- **修复方案**：
  - PostgreSQL：export-rebuild 迁移步骤后重建 `idx_dns_accounts_created_by`、`idx_team_id`、`idx_type`、`idx_enabled` 四个索引
  - PostgreSQL：迁移脚本中 `COALESCE(enabled, TRUE)` 改为 `TRUE as enabled`，避免读取不存在列
  - PostgreSQL：`dns_accounts` CREATE TABLE 添加 `enabled BOOLEAN NOT NULL DEFAULT TRUE`
  - SQLite：`dns_accounts` CREATE TABLE 添加 `enabled INTEGER NOT NULL DEFAULT 1`
  - SQLite：`createIndexes` 补全 `idx_dns_accounts_created_by`、`idx_team_id`、`idx_type`、`idx_enabled` 索引
- **关联检查**：以 MySQL 表结构为基准，逐表逐列逐索引对比 PostgreSQL 和 SQLite，确认三数据库完全对齐，无遗漏

#### PostgreSQL `idx_domains_enabled` 索引创建顺序修复
- **问题描述**：PostgreSQL 初始化时 `CREATE INDEX idx_domains_enabled ON domains(enabled)` 在 `ALTER TABLE ADD COLUMN enabled` 之前执行，旧表升级时列不存在导致崩溃
- **修复方案**：将 `ALTER TABLE domains ADD COLUMN IF NOT EXISTS enabled` 提前到 `CREATE INDEX` 之前执行

#### 系统 > 安全页配置预填充回显修复
- **问题描述**：`/dash/system/security` 页面审计告警模块配置值无法正确回显到表单
- **原因分析**：后端 `PUT /api/settings/audit-rules` 接口未返回 `data` 字段；前端 `setAuditRules` 直接覆盖状态可能丢失未提交的本地修改
- **修复方案**：
  - 后端：PUT 接口补充返回 `data` 字段，与 GET 接口格式对齐
  - 前端：改用函数式合并更新 `setAuditRules((prev) => ({ ...prev, ...res.data.data }))`

### 🔧 改进与优化
- 更新版本号至 1.6.3
- 全数据库迁移完整性验证：34 张表、全部索引和迁移脚本已对齐

## [1.6.2] - 2026-05-26

### 🐛 修复

#### PostgreSQL 初始化崩溃 - `idx_domains_enabled` 索引创建失败
- **问题描述**：PostgreSQL 数据库中，`domains` 表升级迁移时 `enabled` 列尚未存在，但 `CREATE INDEX idx_domains_enabled ON domains(enabled)` 提前执行，导致 `column "enabled" does not exist` 错误，服务无法正常启动
- **原因分析**：`createTables` 数组中的 `ALTER TABLE ADD COLUMN enabled` 放在 `migrate` 阶段，晚于 `CREATE INDEX` 执行
- **修复方案**：将 `ALTER TABLE domains ADD COLUMN IF NOT EXISTS enabled` 提前到 `CREATE INDEX` 之前执行，确保列存在后再建索引
- **关联检查**：扫描全部 9 个迁移 ALTER TABLE + SQLite schema，确认仅此一处问题

## [1.6.1] - 2026-05-26

### 🐛 已知问题

#### 系统设置 > 安全页配置回显失败
- **影响范围**：`/dash/system/security` 页面的登录限制、审计告警、邮件服务三个模块
- **问题描述**：页面加载时，已保存的配置值未能正确预填充到表单控件中，显示为默认值而非实际配置
- **触发条件**：系统设置中存在已保存的安全相关配置时，进入该页面会触发
- **修复计划**：下个版本修复前端数据回显逻辑和后端接口响应格式对齐

### 🔧 改进与优化
- 更新版本号至 1.6.1

## [1.6.0] - 2026-05-26

### ✨ 新增功能

#### 首页展示页重构（Landing Page）
- **基于 AI_Animation 模板全面重构**
  - 全屏滚动 + 点击切换的交互效果（4 个 Section：Hero / Pipeline / Features / Footer）
  - Canvas 粒子背景 + 呼吸光晕动画 + 粒子间连线
  - 渐变模糊光晕 Blob 装饰（3 层浮动径向渐变）
  - 动画网格背景 + 噪点纹理位移
  - 导航圆点指示器（环形 + 内圆 + 发光）
  - 滚动提示鼠标动画
  - 键盘导航（↑↓←→ / Home / End）+ 触摸滑动支持
  - 响应式适配（窄屏 / 短屏 / 移动端）

- **核心组件工作流水线图**
  - 新增 Pipeline Section 展示 HiDNS 全链路架构
  - 5 层流水线：接入层 → 安全层 → 核心引擎 → 适配层 → 运维保障
  - 每层 3 个子项卡片，带图标 + 名称 + 描述
  - 动画箭头连接器 + 逐层入场动画
  - 悬浮高亮 + 微动效反馈

#### DNS 提供商日志系统
- **集中式适配器日志包装器**
  - 实现 `createLoggingAdapter`，使用 Proxy 统一拦截所有 DnsAdapter 方法调用
  - 自动记录 providerRequest / providerResponse / providerError 日志
  - 集中管理日志格式和行为，减少适配器重复代码

### 🔧 改进与优化

#### 安全与认证
- **Cookie 协议自适应**
  - Cookie `secure` 标志自动适配 HTTP/HTTPS 协议
  - 生产环境 HTTP 下不设置 secure，HTTPS 下自动启用
  - 保证 HTTP 和 HTTPS 可共同使用 Cookie

- **反向代理信任增强**
  - 生产环境 `trust proxy` 默认信任内网（10.x / 172.16-31.x / 192.168.x）
  - `getClientIP()` 自动信任内网代理 IP
  - 添加 `trustProxyIps` 白名单配置支持

- **CORS 智能配置**
  - 默认允许所有来源（`Access-Control-Allow-Origin: *`）
  - 前端自动携带 `withCredentials`，后端按来源自适应
  - 移除手动 CORS 配置需求，简化部署

- **前端路由鉴权完善**
  - 401 拦截跳转排除公开展示页 `/`
  - 有有效 Cookie 时登录页自动跳转到 `/dash`
  - 路由守卫（ProtectedRoute）覆盖所有仪表盘子路由

- **环境配置样板**
  - 完善 `.env.example` 配置样板，覆盖所有可选环境变量
  - 添加 `TRUST_PROXY_IPS`、`COOKIE_DOMAIN`、`CORS_ORIGINS` 等新配置项
  - 补充配置注释说明

#### 表单系统重构（RecordForm）
- **彻底修复编辑记录数据不回显问题**
  - 移除 TDesign FormItem 组件（其会克隆子组件并覆盖 `value`/`onChange`）
  - 改用独立 `useState` 管理每个字段 + 自定义 div 布局
  - `useEffect` 完整依赖数组确保数据同步
  - `formKey`（基于 `initial?.id`）作为依赖，编辑不同记录时状态正确重置
  - `lineOptions` 的 `value` 改为 `String(line.id)` 确保类型匹配

- **预填充默认值**
  - 添加域名解析时预填充默认值（类型=A, TTL=600, 线路=默认）
  - 编辑记录时主机记录、类型、记录值、TTL、线路、备注完整回显
  - 修复安全设置（登录限制 & 审计告警）默认值预填充
  - 修复 API 令牌编辑时域名勾选在前端显示

#### Gcore DNS 提供商优化
- **API 认证修复**
  - 修正认证头格式：`apikey` → `APIKey`（Gcore API 区分大小写）
  - 使用 `requestJson` 替代原生 `fetch`，支持代理和超时

- **响应格式兼容**
  - 支持 `zones` / `rrsets` / `total_amount` 字段解析
  - 适配器 `check()` 正确调用 `/zones?limit=1`

- **线路列表实现**
  - `getRecordLines()` 调用 Locations API 获取真实地理线路
  - 支持洲（continent）/ 国家（country）/ 地区（region）三级线路

- **日志层级优化**
  - 移除冗余的 providerResponse 日志（由 `createLoggingAdapter` 统一处理）
  - 保持与其他适配器一致的日志行为

#### NS 监测修复
- **路由顺序修复**
  - `/available-domains` 静态路由移到 `/:id` 动态路由之前，解决 404 错误
  - 完善 `GET /:id` 处理函数实现并正确闭合

- **字段统一**
  - 使用 `domain_name` 替代 `domain_id` 作为标识符
  - 修复前端监测配置域名列表展示问题
  - 自动获取结果直接填充到编辑栏

- **冗余路由清理**
  - 移除 `/api/ns-monitor/:id/check` 路由
  - 提取 `performNsCheck` 共享函数

#### 前端页面优化
- 系统 > 安全 Tab：登录限制 & 审计告警默认值预填充，移除未使用的 `loginLimitQuery` 变量
- API 令牌编辑：域名列表正确显示已勾选状态
- 域名解析列表：点击域名跳转到解析列表而非 `/`
- 添加域名解析：默认值预填充（类型=A, TTL=600, 线路=默认）

### 🐛 Bug 修复

- **TDesign Alert 弃用警告**
  - `close` → `closeBtn`，消除控制台弃用警告

- **crypto.subtle 不可用错误**
  - `rsaEncrypt.ts` 添加 `window.crypto?.subtle` 存在性检查
  - HTTP 环境下抛出清晰错误而非静默失败

- **TypeScript 编译错误**
  - 修复 `weight` 变量隐式 `any` 类型和声明前使用问题
  - 修复未使用的 `loginLimitQuery` 变量
  - 修复 Docker 构建中的 TS 错误（`tsc -b` 阶段）

- **Docker CI 超时**
  - `docker-build.yml` 中 `build-amd64` 和 `build-arm64` 添加 `timeout-minutes: 15`

### 📦 技术细节

#### 修改文件统计
- **后端核心**：DnsHelper.ts（日志包装器）、Gcore 适配器、ns-monitor 路由
- **前端页面**：Landing.tsx / Landing.css（全屏滚动 + 流水线图）、RecordForm.tsx、SecurityTab.tsx
- **安全认证**：Cookie 中间件、CORS 配置、trust proxy、路由守卫
- **配置文档**：.env.example、CHANGELOG.md、root.ai.md
- **CI/CD**：docker-build.yml（超时限制）

#### 版本升级说明
- 版本号：1.5.1 → **1.6.0**
- 201 次提交（2 周开发周期）
- 完全向后兼容

### ⚠️ 注意事项
- HTTP 与 HTTPS 混合部署时 Cookie 自动适配，无需手动配置
- 反向代理场景建议检查 `TRUST_PROXY_IPS` 环境变量配置
- 新 `.env.example` 为可选配置样板，现有部署无需修改

---

## [1.5.1] - 2026-05-17

### ✨ 新增功能

#### DNS 提供商图标系统
- **动态图标加载**
  - 实现从后端 API 动态加载提供商图标
  - 支持多种图标格式优先级：SVG > PNG > ICO > JPG
  - 添加详细的图标加载日志，便于调试
  
- **图标管理优化**
  - 将所有提供商图标移动到各自的提供商文件夹
  - 统一图标命名为 `icon.{ext}` 格式
  - 添加构建时图标复制脚本
  - 支持从 src 和 dist 目录加载图标

#### 新增 DNS 提供商
- **Gcore DNS 支持**
  - 添加 Gcore DNS 提供商适配器
  - 使用官方 favicon 作为图标
  - 集成到提供商注册表

### 🔧 改进与优化

#### 文档完善
- **README 更新**
  - 更新许可证为 GPL-3.0
  - 添加 Telegram 群组链接
  - 完善项目介绍和社区信息

#### 测试与工作流
- **测试脚本优化**
  - 更新测试脚本使用 vitest
  - 改进工作流错误处理
  - 提升 CI/CD 稳定性

### 🐛 Bug 修复

#### 图标相关问题
- **图标格式修复**
  - 修复 HiDNS 图标格式（使用正确的 favicon.ico）
  - 移除错误的 favicon.svg，只保留 favicon.ico
  - 替换 CaihongDNS 图标为官方 favicon.ico
  - 替换 VPS8 图标为官方 favicon.ico (vps8.zz.cd)
  - 更新 Gcore 图标为官方 favicon
  
- **类型错误修复**
  - 修复 Gcore 适配器在注册表中的类型错误
  - 确保所有提供商适配器类型一致

#### 路由调试
- **Provider 图标路由**
  - 为 provider 图标路由添加调试日志
  - 支持从 src 和 dist 目录加载图标
  - 改进错误处理和日志输出

### 📦 技术细节

#### 修改文件统计
- **后端**：提供商图标路由、Gcore 适配器、registry 注册表
- **前端**：动态图标加载组件
- **资源**：所有提供商图标文件重组
- **文档**：README 更新、许可证信息
- **CI/CD**：测试脚本优化、构建流程

---

## [1.5.0] - 2026-05-17

### ✨ 重大功能

#### 项目品牌升级
- **项目名称变更**
  - 项目从 DNSMgr 正式更名为 HiDNS
  - 所有文档、配置文件和代码标识统一更新为 HiDNS
  - Docker 镜像标签和发布文件名更新为 HiDNS
  - CI/CD 工作流配置同步更新

#### 前端架构重构
- **TDesign 组件库迁移**
  - 全面将 TailwindCSS 前端迁移到腾讯 TDesign 组件库
  - 使用 TDesign 组件重构所有 UI 组件
  - 提升 UI 一致性和用户体验
  
- **新增全局搜索功能**
  - 添加全局搜索功能和 UI 缩放支持
  - 优化用户操作体验
  
- **开源引用页面**
  - 添加开源引用页面展示前端技术栈信息
  - 透明化技术选型

#### WHOIS/RDAP 架构重构
- **集中化 WHOIS 架构**
  - 完全集中化 WHOIS 架构，职责分明
  - 删除分散的 whoisJob.ts，功能分散到 whois/模块
  - providers 只返回原始数据，data-parser 升格为解析中心
  - 只调用已注册 WHOIS 适配器的提供商
  
- **WHOIS 状态存储**
  - 添加 WHOIS 状态数据库存储和多语言支持
  - RDAP API 返回中添加 status 字段
  - 首次查询时正确提取并保存 WHOIS 状态
  - 改进缓存状态解析，支持 RDAP JSON 和 WHOIS 文本
  - 使用专用函数解析 WHOIS 状态，避免正则滥用
  
- **查询策略优化**
  - 公开 RDAP 路由根据查询类型智能处理
  - 公开 RDAP 路由禁用平级查询
  - 恢复完整的内部分层查询架构
  - DNS 提供商查询优先于缓存
  - DNS 提供商查询使用精确域名匹配
  - 明确公开 RDAP 路由不查询 DNS 提供商的原因
  
- **缓存优化**
  - WHOIS 缓存有效期改为 3 小时（从 1 小时调整）
  - 添加 forceRefresh 参数支持强制刷新
  - 优化数据库迁移逻辑，避免重复字段错误

#### 国际化域名 (IDN) 支持
- **全面 IDN 支持**
  - 添加中文域名 (IDN) 支持
  - 前端 CNAME 和记录表单支持国际化域名 (IDN)
  - RDAP 支持国际化域名 (IDN)
  - WHOIS/RDAP 域名续期查询支持国际化域名 (IDN)
  - NS 监测支持国际化域名 (IDN) 和 Punycode
  - 从提供商同步域名支持国际化域名 (IDN)
  - 支持下划线开头的 DNS 记录名称和值
  - 添加 xn-- 前缀边界情况测试
  - 添加国际化域名 (IDN) 测试用例

#### 安全增强
- **安全问题修复**
  - 修复明文安全问题
  - 修复多个安全漏洞
  - 进一步修复数据填充问题
  - 安全解析 account.config，兼容字符串和对象类型

### 🔧 核心优化

#### 表单系统重构
- **RecordForm 重写**
  - 使用非受控模式重写 RecordForm，使用 defaultValue
  - 修复 SRV 记录编辑时字段不回显问题
  - 使用递增 key 确保 RecordForm 每次都重新挂载
  - 简化编辑记录的 initial 传递逻辑
  - 优化 RecordForm 默认值和回显逻辑
  - 修复表单状态初始化和输入值更新问题
  
- **useFormSync Hook 优化**
  - 优化 useFormSync Hook 的初始状态设置逻辑
  - 优化表单同步 Hook 的日志记录和调试功能
  - 修复表单同步 Hook 中的调试日志和加载状态问题
  - 解决表单输入值类型不匹配问题
  
- **账户页面重构**
  - 重构账户页面表单状态管理
  - 优化账户管理页面的数据转换逻辑
  - 修复前端编辑表单数据展示问题 (P0)

#### 系统稳定性
- **启动优化**
  - 添加启动横幅显示项目信息
  - 在启动横幅中添加 GitHub 仓库地址
  - 添加彩色日志输出支持
  - 关闭时跳过数据库健康检查，避免 ERROR 日志
  
- **WebSocket 优化**
  - 优化 WebSocket 日志输出，减少噪音
  
- **登录页优化**
  - 登录页动态显示 OAuth 提供商，移除硬编码 Logto 按钮

#### 多语言支持
- **国际化完善**
  - 添加多语言支持并优化国际化功能
  - 补全所有语言的翻译
  - 修复 release.yml 乱码

### 🐛 Bug 修复

#### 关键 Bug 修复
- **表单回显问题**
  - 修复域名解析记录编辑无法正确回显的问题（持续调试中）
  - 修复安全设置页面表单默认值回显问题
  - 使用 placeholderData 确保表单默认值立即显示
  
- **主机名通配符支持**
  - ✅ 新增 DNS 记录主机名通配符 (*) 支持
  - 允许创建通配符 DNS 记录（如 `*.example.com`）
  - 通配符只能作为独立值或第一个标签使用
  - 拒绝无效的通配符位置（如 `sub.*.example.com`）
  - 前后端验证逻辑保持一致
  
- **WHOIS 相关**
  - 修复 DNSHE WHOIS 字段映射错误
  - 修复 WHOIS 状态缓存问题
  - 修复 WHOIS 查询和 TypeScript 类型错误
  - 修复 WHOIS 缓存保存原始数据格式
  
- **数据库迁移**
  - 优化 SQLite 迁移日志，避免重复列 ERROR
  - 移除 IF NOT EXISTS from SQLite migration
  - 从缓存的 raw_data 中解析 WHOIS 状态

#### 其他修复
- 移除未使用的 useEffect 导入
- 移除未使用的 domainRenewalApi 导入
- 修复 Settings.tsx 未使用导入
- 删除快捷操作卡片（未实现功能）
- 删除未实现的快捷操作翻译

### 📦 修改文件统计
- **后端核心**：WHOIS 架构重构、RDAP 路由优化、数据库迁移
- **前端组件**：RecordForm 重写、TDesign 迁移、表单系统优化
- **国际化**：IDN 支持、多语言补全
- **安全**：多处安全问题修复
- **CI/CD**：品牌更新、工作流优化

### ⚠️ 已知问题
- **域名解析记录编辑回显异常**：部分情况下编辑记录时字段无法正确回显，正在持续调试中
- **系统安全子页部分模块回显异常**：安全设置页面部分表单字段回显存在问题

---

## [1.4.3] - 2026-05-03

### 🐛 Bug修复

#### 日志系统
- **修复 `[object Object]` 输出问题**
  - `logger.ts`: 改进 `formatError` 方法，正确处理普通对象类型错误
  - 现在会显示对象内容而不是 `[object Object]`

#### SQLite 迁移
- **修复 `IF NOT EXISTS` 语法错误**
  - `schema.ts`: 添加 `checkSQLiteColumnExists()` 函数，使用 `PRAGMA table_info()` 检查列是否存在
  - `schema.ts`: 添加 `addSQLiteColumn()` 函数，带存在检查的列添加
  - `schema.ts`: 添加 `handleSQLiteMigrations()` 函数，处理所有 SQLite 特定迁移
  - `sqlite.ts`: 移除不支持的 `ALTER TABLE ADD COLUMN IF NOT EXISTS` SQL 语句

#### 数据库架构
- **修复架构违规问题**
  - `business-adapter.ts`: 添加 `DomainOperations.getAllForSuperAdmin()` 专用方法
  - `business-adapter.ts`: 删除暴露内部实现的 `queryInternal` 方法
  - `domains.ts`: 路由现在使用专用方法而不是直接调用内部函数

#### 初始化流程
- **修复 Windows 环境下初始化路由 500 错误**
  - `init.ts`: 修复 `/admin` 路由，添加 try-catch 处理数据库未连接的情况
  - `init.ts`: 增强 `/test-db` 和 `/status` 路由的日志记录
  - `business-adapter.ts`: `testSqliteConnection` 添加 Windows 路径处理（统一使用正斜杠）

#### 用户偏好设置
- **修复 `getPinnedDomains` 错误**
  - `business-adapter.ts`: 添加 try-catch，当表或字段不存在时返回空数组

#### Express 中间件
- **修复 `req.ip` 只读属性错误**
  - `clientIP.ts`: 移除设置 `req.ip` 的代码，只设置 `req.clientIP`
  - `errorHandler.ts`: 使用 `getRequestIP()` 替代 `req.ip`

#### 错误处理
- **增强错误日志记录**
  - `errorHandler.ts`: 添加错误堆栈信息、请求路径、方法、IP 地址
  - `init.ts`: 改进数据库连接测试的错误日志

### 📦 修改文件
- `server/src/lib/logger.ts`
- `server/src/middleware/errorHandler.ts`
- `server/src/middleware/clientIP.ts`
- `server/src/db/schema.ts`
- `server/src/db/schemas/sqlite.ts`
- `server/src/db/business-adapter.ts`
- `server/src/routes/init.ts`
- `server/src/routes/domains.ts`

### 🔧 兼容性
- ✅ 完全向后兼容
- ✅ 支持旧版本 SQLite (< 3.2.0)
- ✅ 修复 Windows 路径分隔符问题

---

## [1.4.2] - 2026-05-04

### ✨ 核心改进

#### DNS线路系统全面优化
- **统一线路ID规范**
  - 统一所有DNS提供商默认线路ID为 `'0'`
  - 修复 11+ 个提供商适配器的 fallback 值
  - 确保前后端线路ID完全一致
  
- **前端显示优化**
  - Records.tsx：支持 `'0'` 和 `'default'` 都显示为"默认"
  - RecordForm.tsx：统一表单初始化默认值为 `'0'`
  - 单线路和多线路提供商行为一致
  
- **阿里云适配器修复**
  - normalizeLine 函数保留 `'0'` 不转换
  - mapRecord 使用 normalizeLine 处理线路ID
  - 添加/更新/查询记录的线路ID保持一致

#### DNSHE功能增强
- **CNAME拉平支持**
  - 支持根域CNAME记录（@记录）
  - registry.ts 设置 `cnameFlattening: true`
  - 前端不再显示CNAME冲突错误
  
- **NS监测优化**
  - NSMonitorTab.tsx 前端过滤已添加的域名
  - 避免用户选择后提交遇到重复错误
  - 与续期域名的去重逻辑保持一致

### 🔧 CI/CD优化

#### Telegram通知集成
- **工作流整合**
  - 将 release-tg.yml 集成到 release.yml
  - Telegram通知作为发布流程的最后一步
  - 删除独立的 release-tg.yml 文件
  
- **配置修复**
  - 使用 `topic: 14` 参数（而非 message_thread_id）
  - 使用 Markdown 格式（而非 HTML）
  - 所有消息标签转换为 Markdown 语法

### 🌐 网络层优化

#### WebSocket真实IP获取
- **反向代理支持**
  - websocket.ts 使用 getClientIP 函数
  - 支持 X-Forwarded-For 和 X-Real-IP 头部
  - 日志正确记录真实客户端IP
  
- **TypeScript修复**
  - 添加 getClientIP 导入语句
  - 解决编译错误

### 📦 技术细节

#### 修改文件统计
- **后端适配器**（11个）
  - dnshe, vps8, west, huoshan, baidu, aliyun
  - namesilo, powerdns, spaceship, common, _example
  
- **前端组件**（3个）
  - Records.tsx（线路显示逻辑）
  - RecordForm.tsx（表单初始化和选择器）
  - NSMonitorTab.tsx（NS监测域名过滤）
  
- **CI/CD配置**
  - .github/workflows/release.yml
  
- **中间件**
  - server/src/service/websocket.ts

#### 影响的DNS提供商
阿里云、腾讯云、华为云、火山引擎、京东云、百度云、西部数码、宝塔、DNSHE、VPS8、NameSilo、PowerDNS、Spaceship等

### 🐛 Bug修复
- 修复线路fallback值不一致问题（'default' → '0'）
- 修复前端线路选择器默认值问题（'' → '0'）
- 修复WebSocket IP获取问题（remoteAddress → getClientIP）
- 修复TypeScript编译错误（缺少import）
- 修复阿里云normalizeLine转换问题（'0' → 'default'）

### 🔧 兼容性
- ✅ 完全向后兼容
- ✅ 不影响现有配置和数据
- ✅ 前端同时支持 '0' 和 'default' 显示
- ✅ 自动适配新旧数据格式

---

## [1.4.1] - 2026-05-03

### ✨ 新增功能

#### WebSocket 实时通信系统
- **全系统 WebSocket 支持**
  - 实现单连接复用架构，所有组件共享一个 WS 连接
  - 支持 38 种事件类型，覆盖所有核心功能
  - 后端 12 个路由文件，45+ 个推送点
  - 前端 15 个页面已集成实时数据支持
  
- **优雅降级机制**
  - WebSocket 3 秒超时后自动降级到 React Query 轮询
  - 不同页面有不同的轮询间隔（60秒 ~ 5分钟）
  - 确保在网络不稳定时仍能正常刷新数据
  
- **事件推送覆盖**
  - **域名管理**：`domain_created`/`updated`/`deleted`/`renewed`
  - **账号管理**：`account_created`/`updated`/`deleted`
  - **DNS 记录**：`record_created`/`updated`/`deleted`/`status_changed`
  - **用户管理**：`user_created`/`updated`/`deleted`
  - **团队管理**：`team_created`/`updated`/`deleted`/`member_added`/`removed`
  - **Token 管理**：`token_created`/`revoked`/`updated`
  - **审计日志**：`audit_log_created`（管理员实时查看）
  - **系统设置**：`smtp_updated`/`oauth_updated`/`config_updated`/`security_config_updated`
  - **安全设置**：`2fa_enabled`/`disabled`/`trusted_device_removed`
  - **NS 监测**：`ns_monitor_created`/`updated`/`deleted`
  - **故障转移**：`failover_config_created`/`updated`/`deleted`
  - **隧道管理**：`tunnel_config_updated`/`deleted`

#### 关于页面增强
- **动态贡献者列表**
  - 从 GitHub API 动态获取真实贡献者
  - 显示贡献者头像、用户名和提交次数
  - 点击可跳转到贡献者 GitHub 主页
  - 24 小时缓存策略，减少 API 调用
  
- **信息完善**
  - 添加 GitHub 仓库链接
  - 显示开源协议（GPL-3.0）
  - 添加 Telegram 社区群组链接
  - 支持多语言翻译（10 种语言）

### 🔧 问题修复

#### 路由冲突修复
- **Express 路由顺序问题**
  - 修复 `/renewable-domains` 被 `/:id` 动态路由拦截的问题
  - 将静态路由移到动态路由之前，确保优先匹配
  - 添加路由顺序警告注释，防止未来再次出现
  
- **WebSocket Token 编码**
  - 对 WebSocket token 进行 URL 编码，避免特殊字符导致连接失败
  - 确保兼容性和安全性

#### 数据库兼容性
- **PostgreSQL 类型修复**
  - 修复 `renewable_domains` boolean 类型比较错误（`TRUE` vs `1`）
  - 修复 SMTP 和 RDAP 缓存 SQL 语法错误
  - 修复 WHOIS 缓存 SQL 语法错误
  
- **WHOIS 缓存回退机制**
  - 修复 try-catch 回退机制导致的 SQL 语法错误

#### 性能优化
- **域名列表查询优化**
  - 超管 Token 域名列表查询：直接执行简单 SQL，避免权限检查
  - Token 认证域名列表查询：使用 ID 列表直接查询，避免复杂子查询
  - Token 认证跳过逐个权限检查，提升查询速度
  
- **DNSHE 域名到期时间**
  - 优先使用数据库缓存，避免重复查询 API
  - 通过 WHOIS 调度器获取，与续期功能保持一致

### 🎨 UI/UX 改进

#### 分页与排序优化
- **置顶域名排序**
  - 置顶域名在分页前排序，确保始终显示在第一页
  - 用户体验提升，重要域名始终可见
  
- **DNSPod 线路获取**
  - 添加详细日志以便调试
  - 提升问题诊断效率

#### 代理状态支持
- **Cloudflare 和 Aliyun ESA**
  - 支持代理状态管理
  - 添加 `GET /domains/:id` 接口以支持代理状态显示

###  国际化

- **多语言翻译完善**
  - 补全所有语言的关于页面翻译
  - 添加 `renew_domain` 操作类型的多语言翻译
  - 补全域名续期页 i18n 翻译
  - 优化账号显示格式

### 📚 文档

- **WebSocket 实施文档**
  - 添加 WebSocket 后端推送实施指南
  - 添加 WebSocket 实时数据集成指南
  - 添加快速开始文档
  - 更新实施进度报告（100% 完成）

- **开源协议变更**
  - 更新开源协议为 GPL-3.0
  - 更新 LICENSE 文件

### 🧹 代码清理

- **废弃代码移除**
  - 删除已废弃的旧版 NSMonitor.tsx 页面（692 行）
  - 保持代码库整洁

- **自动续期优化**
  - 自动续期添加数据库更新
  - 移除审计日志（自动任务无需审计）

### 🔒 安全增强

- **Nginx 反向代理支持**
  - 正确获取客户端真实 IP
  - 优化客户端 IP 获取逻辑，自动信任内网 IP 段

### 📊 统计数据

- **提交数量**：50+ commits
- **新增文件**：8 个
- **修改文件**：35+ 个
- **删除文件**：1 个（废弃代码）
- **代码变更**：+3,500 / -1,200 行

---

## [1.4.0] - 2026-04-30

### ✨ 新增功能

#### 域名续期系统重构
- **独立续期域名管理表** (`renewable_domains`)
  - 创建独立的 `renewable_domains` 表，实现续期域名的独立管理
  - 支持多数据库（SQLite/MySQL/PostgreSQL）自动迁移
  - 续期域名与核心域名表解耦，提升数据隔离性
  
- **范式化续期架构**
  - 将域名续期页面改为范式实现，使用通用续期调度器架构
  - 续期域名列表从数据库查询，使用 `domains` 表的 `expires_at` 字段
  - 支持批量添加续期域名到列表
  
- **两步式添加续期域名对话框**
  - 第一步：选择账号
  - 第二步：选择子域名（分页式选择器）
  - 过滤已添加的续期域名，只显示未添加的域名供选择
  - 显式设置 `enabled=1`，修复启用状态问题
  
- **续期权限验证增强**
  - 修复域名续期权限验证逻辑
  - 增强权限检查日志，便于诊断问题
  - 支持多账号权限隔离

#### WHOIS 缓存数据库化
- **WHOIS 缓存改用数据库存储**
  - 创建 `whois_cache` 表，支持 SQLite/MySQL/PostgreSQL
  - 完全接入任务管理器，后台定时刷新
  - 补全 `WhoisResult` 类型所需的 `domain` 和 `raw` 字段
  
- **自动迁移支持**
  - 添加 `whois_cache` 表自动迁移
  - 根据数据库类型选择正确的 SQL 语法
  - PostgreSQL 和 SQLite 支持 `pinned_domains` 字段迁移

#### 任务管理器优化
- **优先级插队机制**
  - 任务管理器支持优先级插队
  - 域名缓存刷新使用高优先级
  - 域名续期和故障转移任务接入任务管理器
  
- **NS 监测并发控制**
  - 引入任务管理器并优化 NS 监测并发控制
  - 防止大量并发请求导致超时

#### 用户置顶域名功能
- **后端实现**
  - 添加用户置顶域名功能（后端+API）
  - 创建 `user_preferences` 表，支持 MySQL JSON 类型
  - 为 PostgreSQL 和 SQLite 添加 `pinned_domains` 字段迁移
  
- **前端 UI**
  - 完成用户置顶域名功能前端 UI
  - 支持用户自定义域名排序

#### DNS 提供商模块化重构
- **DNS 提供商完全模块化**
  - 将 `_template.ts` 转换为 `_example` 示例文件夹
  - 统一 DNS 提供商接口规范
  - 支持 VPS8 等新提供商
  
- **VPS8 支持**
  - 添加 VPS8 提供商支持
  - 修复 record ID 类型转换问题
  - 添加详细操作日志

### 🎨 UI/UX 改进

#### 分页式域名选择器
- **API 令牌域名选择**
  - 为 API 令牌域名选择添加分页支持
  - 完善搜索和过滤功能
  - 每页显示 20 个域名
  
- **NS 监测域名选择**
  - NS 监测添加域名对话框使用分页式选择器
  - 将 `<select>` 下拉框改为单选按钮列表样式
  - 添加搜索功能和分页控件
  - 样式与 API 令牌完全一致
  
- **故障转移页面**
  - 为故障转移页面添加前端分页功能
  - 支持大数据量场景

#### 分页底栏常驻显示
- **统一分页体验**
  - 所有涉及分页的页面，分页底栏常驻显示
  - 即使只有一页数据也显示分页控件
  - 保持界面一致性，避免布局跳动
  - 影响页面：DomainListTab, FailoverTab, Tokens, Records

#### 确认对话框优化
- **文本长度限制**
  - 限制确认对话框文本最多 3 行
  - 超出显示省略号（使用 `line-clamp-3`）
  - 避免长文本破坏布局

### 🌍 国际化 (i18n)

#### 全面补全翻译
- **10 种语言完整翻译**
  - 补全所有语言的域名续期 Tab 翻译（AR, DE, ES, FR, JA, KO, PT, RU, ZH-CN, Mesugaki）
  - 补全所有语言的 NS 监测翻译键
  - 补全雌小鬼语言翻译（超有味的杂鱼风格）
  - 削弱了雌小鬼语言的干扰，保持趣味性但不过度
  
- **翻译键补充**
  - 添加 `common.deselectAll` 翻译键
  - 修复 `common.search` 在 Mesugaki 版本中未翻译的问题
  - 补全英文 i18n 翻译（domainRenewal 和 common.deselectAll）

#### 翻译质量优化
- **人工修复缩进**
  - 肉编模式：人工修复 i18n 缩进
  - 确保 JSON 格式正确
  
- **调试支持**
  - 添加 i18n 调试日志
  - 便于诊断翻译加载问题

### 🔧 技术优化

#### 域名查询优化
- **记录数缓存机制**
  - 实现域名记录数缓存机制
  - 后台定时刷新避免请求阻塞
  - 提升域名列表加载速度
  
- **pageSize 优化**
  - 修复多个页面域名列表只显示第一页的问题
  - 设置 `pageSize=1000`，支持大数据量场景
  
- **accountId 参数支持**
  - 优化域名查询逻辑，支持 `accountId` 参数
  - 添加权限回退机制

#### DNSHE 适配器优化
- **域名拼接逻辑修复**
  - 修复 DNSHE 适配器域名拼接逻辑
  - 使用 API 返回的完整域名（`full_domain`）
  - 避免域名重复问题（如 `xxx.xxx.example.com`）
  
- **恢复使用 full_domain**
  - 从 subdomain 和 rootdomain 重新构建 full_domain
  - 优先使用 API 返回的 `full_domain` 字段
  - 不手动拼接，减少错误

#### Cloudflare 修复
- **zoneId 优先级修复**
  - 修复 Cloudflare zoneId 优先级错误导致无法获取解析记录
  - 修复授权头重复设置问题
  
- **配置字段匹配**
  - 修复 `zoneId` 与 `domainId` 不匹配问题

#### 路由顺序修复
- **动态路由拦截问题**
  - 修复路由顺序问题
  - 将 `/renewable-domains` 移到 `/:id` 之前
  - 避免被动态路由拦截

#### TypeScript 类型修复
- **多处类型错误修复**
  - 修复 DomainListTab TypeScript 错误
  - 修复 business-adapter.ts 中的 TypeScript 类型错误
  - 修复 UserPreferencesOperations 导入问题
  - 修复 RenewableDomainOperations.add 返回值类型错误
  - 修复 filteredDomains TypeScript 类型错误
  - 修复 getByAccountIdAndName 重复定义和类型转换错误

#### 数据库兼容性
- **PostgreSQL boolean 类型**
  - 修复 PostgreSQL boolean 类型比较错误
  - 统一使用 TRUE/FALSE
  
- **remark 字段统一**
  - 统一三种数据库 `renewable_domains` 表 remark 字段定义（允许 NULL）
  - 修复 PostgreSQL renewable_domains 表 remark 字段不能有默认值的问题
  - 修复 MySQL renewable_domains 表 remark 字段不能有默认值的问题

### 🐛 Bug 修复

#### NS 监测修复
- **误报问题修复**
  - 修复 NS 监测误报问题
  - 修复 NS 监测页面超时导致失去登录状态
  
- **PostgreSQL 类型错误**
  - 修复 PostgreSQL NS monitor enabled field type error

#### DNSHE 修复
- **域名格式重复**
  - 修复 DNSHE 域名格式重复问题
  - 添加账号名称唯一性验证
  
- **API 文档对齐**
  - 根据 DNSHE API 文档修复域名列表获取逻辑
  - 移除 `expires_at` 字段，对所有子域名尝试续期

#### 其他修复
- **JSON 语法错误**
  - 修复 zh-CN.json JSON 语法错误
  - 删除 zh-CN.json 中重复的 title 和 subtitle 键
  
- **if 语句块缺失**
  - 修复 domains.ts 中 if 语句块缺少闭合大括号的语法错误
  
- **未使用的导入**
  - 移除未使用的 Calendar 导入以修复 Docker 构建
  - 移除未使用的 RefreshCw 导入以修复 Docker 构建
  - 移除未使用的 selectedAccountId 状态
  - 删除未使用的 handleAddDomain 函数
  - 删除未使用的 dnsheListSubdomains 导入

### 🗑️ 清理和优化

#### 废弃代码清理
- **旧 API 删除**
  - 删除废弃的 `/dnshe-subdomains` API
  - 标记 `/dnshe-subdomains` 为 deprecated
  
- **旧页面删除**
  - 删除旧的 DomainRenewal.tsx 页面和相关路由
  - 删除旧的添加域名表单代码
  - 删除临时脚本文件

#### 通用 API 替代
- **providers API**
  - 前端改用通用 providers API 获取可续期域名
  - 创建通用 providers 路由用于获取可续期域名列表
  - 不再依赖 DNSHE 特定 API

### 📝 文档更新

- **架构文档更新**
  - 更新架构文档，添加 WHOIS 和续期调度器说明
  - 添加任务管理器使用文档
  - 更新文档版本号为 v1.3.2
  
- **提供商文档**
  - 更新文档添加 VPS8 提供商支持
  
- **Tab 文案优化**
  - 修正域名页各 Tab 的标题和简介文案

### 🚀 性能优化

- **代理超时优化**
  - 代理超时缩短为 10 秒
  - 添加性能监控日志
  
- **后台刷新机制**
  - 域名记录数后台定时刷新
  - WHOIS 缓存后台定时刷新
  - 避免前端请求阻塞

---

## [1.3.2] - 2026-04-28

### ✨ 新增功能

- **WHOIS 查询注册商模式**
  - 实现 WHOIS 调度器注册商模式，支持 DNS 提供商注册 WHOIS 查询能力
  - 新增 `WhoisScheduler` 接口和注册表，统一 WHOIS 查询架构
  - DNSHE 提供商实现 WHOIS 调度器
  - 应用启动时自动初始化所有 WHOIS 调度器

- **RDAP 路由查询策略优化**
  - `/api/rdap` 公开路由采用简化查询策略
  - 顶域查询：顶域 > 第三方
  - 子域查询：仅查询子域，失败则放弃（不查询父域）
  - 适用于 NS 托管子域名场景（如 xxx.baidu.com）

- **禁用父域查询选项**
  - `whoisService.query()` 新增 `skipParentFallback` 选项
  - 支持禁用父域 fallback 查询
  - 新增 `querySubdomainOnly()` 私有方法
  - 子域查询顺序：子域 > 平级 > 第三方（仅子域）

### 🔧 架构优化

- **代理请求性能优化**
  - 代理超时从 30 秒缩短为 10 秒
  - 添加详细的性能监控日志
  - 记录代理请求和直连请求的耗时
  - 更快回退到直连，提升用户体验

- **DNSHE API URL 规范化**
  - 修正 DNSHE API 基础 URL 格式
  - baseUrl 改为纯净路径：`https://api005.dnshe.com/index.php`
  - 动态构建完整 URL，代码结构更清晰

### 🐛 Bug 修复

- **DNSHE 凭证检查改进**
  - 添加 Content-Type 检查，避免 JSON 解析 HTML 错误页面
  - 改进错误日志，显示响应预览（前 200 字符）
  - 便于诊断 API 连接问题

- **DNSHE WHOIS 类型修复**
  - 将 DNSHE WHOIS status 字符串转换为数组以符合接口规范
  - 修复类型不匹配导致的运行时错误

- **代码冗余清理**
  - 移除 scheduler.ts 中重复的 result 展开操作
  - 移除 whoisScheduler.ts 中重复的 result 展开操作
  - 避免字段冲突和覆盖

- **域名续期逻辑优化**
  - 根据 DNSHE API 文档修复域名列表获取逻辑
  - 移除 expires_at 字段（API 不返回此字段）
  - 对所有子域名尝试续期，让 API 服务端判断是否过期
  - 移除续期日志中对 expires_at 的引用

### 🎨 UI 改进

- **隐藏域名续期 Tab**
  - 暂时隐藏域名管理页面的续期 Tab
  - 保留后端功能和独立路由，未来可重新启用

## [1.3.1] - 2026-04-26

### ✨ 新增功能

- **域名管理页面重构**
  - 支持域名页面 tabs 结构（域名列表、故障转移、NS 监测）
  - DNSHE 提供商支持根域 CNAME 记录

### 🔧 架构优化

- **DNS 提供商模块化重构**
  - DNS 提供商完全模块化重构，提升代码可维护性
  - 将 _template.ts 转换为 _example 示例文件夹
  - 修复 dnsmgr 被 gitignore 忽略问题
  - 清理 DNSHE 文档文件

### 🐛 Bug 修复

- **Cloudflare 授权修复**
  - 修复 Cloudflare 授权头重复设置问题
  - 修复 Cloudflare zoneId 优先级错误导致无法获取解析记录
  - 确保使用正确的 Zone ID 调用 Cloudflare API

- **NS 监测功能修复**
  - 修复 NS 监测误报问题（DNS 污染检测优化）
  - 修复 NS 监测页面超时导致失去登录状态
  - 优化 React Query 重试策略（retry: 1, staleTime: 30s）

- **VPS8 提供商修复**
  - VPS8 解析记录操作添加详细日志
  - 修复 VPS8 record ID 类型转换问题

- **数据库兼容性修复**
  - 修复 PostgreSQL NS monitor enabled 字段类型错误

- **国际化完善**
  - 补全所有语言 i18n 翻译（英文、中文简体、雌小鬼、日语、韩语、法语、德语、西班牙语、葡萄牙语、俄语、阿拉伯语等）
  - 优化 NS 监测 UI 翻译

- **记录表单线路选择修复**
  - 修复 A、AAAA、CNAME 等记录类型缺少线路选择的问题
  - 确保所有非代理模式的提供商始终显示线路选择器
  - 修复线路表头翻译错误（显示"线路"而非"默认"）
  - 优化 `canSelectProxy` 逻辑，提升用户体验

## [1.3.0] - 2026-04-26

### ✨ 新增功能

- **VPS8 DNS 提供商支持**
  - 添加 VPS8 (vps8.zz.cd) DNS 提供商适配器
  - 支持 HTTP Basic Auth 认证（固定用户名 "client"）
  - 支持域名列表查询和到期时间获取
  - 支持代理配置（fetchWithFallback）
  - 简化配置，仅需 API Key

- **开放的 RDAP 查询服务**
  - 新增 `/api/rdap/domain/{domain}` 公开查询接口
  - 无需鉴权，完全开放访问
  - 符合 RFC 7483 国际标准格式
  - 直接调用 WHOIS/RDAP 系统，不走数据库
  - 支持 CORS 跨域访问
  - 返回标准 RDAP JSON 格式（application/rdap+json）

- **智能到期时间获取策略**
  - 根据域名类型动态调整优先级：
    - 顶域：顶域 WHOIS > DNS 提供商 API > 第三方 WHOIS
    - 子域：DNS 提供商 API > 顶域 WHOIS > 第三方 WHOIS
  - 始终执行 WHOIS 多元查询，确保获取完整信息
  - 保留顶域到期时间（apexExpiryDate）用于显示
  - 排除不准确的提供商（彩虹聚合DNS、DnsMgr）

- **RDAP 服务器列表管理**
  - 集成 IANA 官方 RDAP 服务器列表
  - 从文件缓存迁移到数据库存储
  - 自动刷新 RDAP 服务器列表
  - 支持所有域名后缀的 RDAP 查询

- **DNS 解析模块**
  - 内置 DNS 解析功能
  - 使用 Node.js http/https 模块替代 fetch
  - 加密 DNS 优先（DoH/DoT），降级明文查询
  - 改进错误处理和详细日志

- **NS 监测架构重构**
  - 重新设计 NS 监测为账号级独立设置
  - 用户级独立邮箱通知
  - 限制通知渠道权限
  - 添加 DNS 污染检测功能
  - 双重查询结果展示（加密 DNS + 普通 DNS）
  - NS 记录自动获取（加密 DNS 优先）

### 🔧 架构优化

- **WHOIS 查询策略升级**
  - 重构为分层并行竞速策略
  - 三层并发架构：
    1. 批量处理层：asyncPool 控制并发度（默认 3）
    2. 模块并发层：顶域和子域模块独立并发执行
    3. 提供商竞速层：每个模块内多个提供商并行竞速
  - 子域支持平级查询（无视域名后缀匹配）
  - 第三方查询同时查询根域名和子域名

- **数据库架构优化**
  - 修复 MySQL 迁移 IF NOT EXISTS 语法不支持问题
  - 使用 SHOW COLUMNS 检查字段存在性，消除 ERROR 日志
  - 修复 conn.execute 错误处理
  - 添加详细的数据库迁移日志
  - 修复审计日志表名不一致问题
  - 修复 MySQL 迁移函数提前返回问题

- **安全增强**
  - 加强 API 令牌授权安全限制
  - 修复 API 令牌域名操作权限控制
  - 添加权限修改功能
  - 修复令牌更新时 start_time 空字符串导致 MySQL 错误
  - 防止顶域/子域查询商注册空 suffixes 数组

### 🐛 问题修复

- **NS 监测修复**
  - 修复 NS 监测前端多个问题
  - 修复更新 NS 监测配置接口调用错误
  - 修复仪表盘 NS 监测显示问题
  - 修复 DNS 污染检测误报问题

- **域名管理修复**
  - 修复域名同步和子域判断逻辑
  - 修复子域名使用顶域到期时间时 apexExpiryDate 未定义
  - 修复子域名到期时间显示问题
  - 修复其他页面使用 domainsApi.list 的类型错误
  - 域名列表添加分页功能

- **WHOIS/RDAP 修复**
  - 修复 RDAP 查询 fetch failed 错误
  - 修复 RDAP 查询 403 错误（DigitalPlat）
  - 修复 WHOIS 模块中重复变量声明
  - 添加 .today 域名支持并修复 rdap-box URL
  - 修复第三方 RDAP 查询商匹配逻辑

- **数据库修复**
  - 修复 MySQL 迁移时重复列错误处理
  - 修复 MySQL 迁移脚本存储过程兼容性问题
  - 修复 2FA 数据库表结构和查询逻辑
  - 修复普通用户无法更改邮件通知设置的问题

- **其他修复**
  - 修复 Teams.tsx 语法错误
  - 修复 MX 记录显示优先级
  - 修复网络信息服务代理配置
  - DNS 告警邮件改为纯文本格式
  - 优化 MySQL 迁移日志级别，避免误导性 ERROR 输出

### 📝 文档更新

- 更新 CHANGELOG.md 添加 1.2.0 版本变更日志
- 添加数据库禁忌事项备注（MySQL/PostgreSQL/SQLite）
- 更新多语言国际化文件
- 优化 WHOIS 服务日志和查询逻辑说明

---

## [1.2.0] - 2026-04-24

### ✨ 新增功能

- **NS 记录监控**
  - 监测域名的 NS 记录变更
  - 自动检测 NS 劫持和配置异常
  - 支持邮件和通知渠道告警
  - 支持手动和自动检查

- **网络连通性测试**
  - 测试与 Baidu、Google、Apple、Cloudflare 的连接状态
  - 支持代理模式下的连通性测试
  - 显示各服务的延迟数据

- **团队域名权限管理**
  - 支持为团队成员分配域名权限
  - 支持子域名级别的权限控制
  - 支持读取和编辑权限设置

- **审计日志增强**
  - 添加团队操作审计（创建/更新/删除团队）
  - 添加团队成员操作审计（添加/移除成员）
  - 添加域名权限操作审计
  - 添加 DNS 账号操作审计
  - 添加 WHOIS 更新审计

### 🔧 改进

- **CI/CD 优化**
  - Docker 构建支持并行多架构构建（ARM64/AMD64）
  - 优化构建流程，提高构建效率

- **代理配置优化**
  - 支持 SOCKS5 和 HTTP(S) 代理
  - 代理配置持久化存储
  - 网络信息服务支持代理访问

- **翻译完善**
  - 补全所有语言的 NS 监控相关翻译
  - 补全团队管理相关翻译
  - 补全网络信息相关翻译
  - 添加 Mesugaki 语言特殊表达

### 🐛 问题修复

- **团队管理修复**
  - 修复团队成员角色数据截断问题（添加 `admin` 角色支持）
  - 修复添加成员时 user_id 参数缺失问题
  - 修复域名权限 API 路径不匹配问题
  - 修复成员域名权限保存失败问题
  - 修复超管角色显示为 admin 的问题

- **用户管理修复**
  - 修复用户列表角色显示问题

- **数据库修复**
  - 添加 team_members 表 role 字段迁移脚本
  - 支持 MySQL/PostgreSQL/SQLite 的 ALTER TABLE 迁移

- **其他修复**
  - 修复令牌删除确认对话框（使用自定义悬浮窗口）
  - 修复审计日志操作类型翻译缺失问题
  - 修复 JSON 格式错误

---

## [1.1.4] - 2026-04-19

### 🐛 问题修复

- **Cloudflare 适配器修复**
  - 修复记录停用/启用时 `_cloud_paused` 后缀处理逻辑
  - 简化暂停状态检测，统一使用 `_cloud_paused` 后缀
  - 修复启用记录时 `_cloud` 后缀残留导致前端显示异常的问题

---

## [1.1.3] - 2026-04-18

### 🐛 问题修复

- **WHOIS 域名支持扩展**
  - 新增 `.top` 域名 WHOIS 支持
  - 新增 `.ci` (科特迪瓦)、`.cd` (刚果民主共和国) 等国别域名支持
  - 新增 `.today`、`.tokyo`、`.tools` 等新顶级域名支持
  - 新增欧洲、非洲、亚洲多个国家域名 WHOIS 服务器配置
  - 修复 WHOIS 服务器映射表中的重复键问题

- **WHOIS 日志增强**
  - 增强 WHOIS 查询日志记录，便于诊断域名到期时间获取失败问题
  - 添加详细的错误诊断信息，包括响应预览和日期相关行提取

### 🔧 改进

- **代码质量**
  - 修复 WHOIS_SERVERS 对象中的重复键定义
  - 优化日志级别设置，关键信息使用 info 级别

---

## [1.1.2] - 2026-04-18

### 🐛 问题修复

- **CaihongDns 适配器修复**
  - 修复 `zoneId` 参数支持（DnsHelper 传递的是 zoneId 而非 domainId）
  - 修复 MX 字段类型错误（`number | undefined` → `number`）
  - 修复 baseUrl 拼接逻辑（自动处理带 `/api` 后缀的 URL）
  - 修复 API 路径以匹配官方文档（`/domain`, `/record/data/{id}` 等）
  - 修复非 JSON 响应处理（如 HTML 错误页面）

- **DnsMgr 适配器修复**
  - 修复 baseUrl 拼接逻辑（与 CaihongDns 保持一致）

- **数据库初始化修复**
  - 修复跳过初始化时的数据库连接建立问题
  - 修复现有连接未断开导致的新连接失败问题
  - 添加 `disconnect()` 调用以清理连接管理器状态

### 🔧 改进

- **类型安全**
  - 改进 CaihongDns 响应类型定义（`code` 字段改为可选）
  - 统一错误处理逻辑

---

## [1.1.1] - 2026-04-17

### 🐛 问题修复

- **数据库系统重构**
  - 统一数据库连接系统到 `db/core/connection.ts`
  - 移除旧的 `db/database.ts` 直接调用
  - 修复 PostgreSQL 触发器语法错误 (`CREATE TRIGGER IF NOT EXISTS` 不支持)
  - 修复 MySQL/SQLite/PostgreSQL schema 兼容性问题

- **2FA 功能完善**
  - 修复 2FA 设置/启用/禁用 API 路由缺失问题
  - 添加前端安全页面 (`/security`)
  - 完善 2FA 启用/禁用流程
  - 添加禁用 2FA 的确认流程

### 🔧 新增工具

- **CLI 管理工具** (`npm run cli`)
  - `disable-2fa` - 禁用指定用户的 2FA
  - `reset-db-config` - 重置数据库连接配置
  - `list-users` - 列出所有用户
  - `reset-password` - 重置用户密码

### 📝 文档更新

- 更新 API 文档，添加 2FA 相关接口
- 添加 CLI 工具使用说明

---

## [1.1.0] - 2026-04-16

### ✨ 新增功能

- **API Token 认证系统 (SOK)**
  - 支持创建和管理 API Token
  - Token 权限继承创建者用户权限
  - 支持域名级别的访问控制
  - 支持设置生效时间和过期时间
  - 完整的 Python/Node.js/cURL 示例代码

- **域名到期提醒**
  - WHOIS 自动查询域名到期时间
  - 每小时自动刷新 WHOIS 信息
  - 可配置到期前通知阈值
  - 支持邮件/Webhook 通知
  - 使用原生 Node.js 实现，兼容 pkg 打包

- **Cloudflare Tunnels 管理**
  - 在侧边栏显示 Tunnels 入口
  - 支持添加、编辑、删除 Tunnel 配置
  - 支持查看 Tunnel 状态和凭证

- **自定义背景图**
  - 支持设置登录页自定义背景图
  - 支持任意图片 URL
  - 支持 jpg/png/gif/webp 格式

- **全局 2FA 强制**
  - 管理员可强制所有用户启用 2FA
  - 支持按用户强制启用 2FA
  - 安全策略配置面板

### 🔧 架构改进

- **数据库架构优化**
  - 新增 MySQL/PostgreSQL/SQLite 独立 schema 文件
  - 自动字段迁移机制
  - 修复 `key`/`value` 保留关键字问题

- **业务适配器层完善**
  - 所有数据库操作通过业务适配器层
  - SQL 语句集中管理
  - 类型安全的 TypeScript 支持

### 🐛 问题修复

- 修复 i18n 多语言翻译完整性问题
  - 补全 ja/ko/fr/de/es/pt/ru/ar 语言文件
  - 补全 zh-CN-Mesugaki 特殊语言文件
- 修复数据库初始化时字段缺失问题
- 修复 MySQL 保留关键字冲突
- 修复 WHOIS 查询失败时的错误处理

### 📝 文档更新

- 新增完整的 API 参考文档
- 新增 API Token 使用指南
- 新增第三方对接示例 (Python/Node.js/cURL)
- 优化文档展示样式 (Docsify)

---

## [1.0.0] - 2024-12-20

### 🎉 初始版本发布

- **DNS 服务商支持**
  - 阿里云 DNS
  - 腾讯云 DNSPod
  - 华为云 DNS
  - Cloudflare
  - GoDaddy
  - 等 18+ 服务商

- **核心功能**
  - 多 DNS 账号管理
  - 域名管理
  - DNS 解析记录管理
  - 团队权限管理
  - 审计日志

- **安全特性**
  - JWT 认证
  - 双因素认证 (2FA/TOTP)
  - Passkeys 支持
  - OAuth2/OIDC 登录
  - RBAC 权限控制

- **系统特性**
  - 多数据库支持 (SQLite/MySQL/PostgreSQL)
  - 多语言支持 (10+ 语言)
  - 响应式 Web UI
  - 邮件通知 (SMTP)
  - Webhook/Telegram/DingTalk 通知

---

## 版本说明

版本号格式: `主版本号.次版本号.修订号`

- **主版本号**: 重大架构变更或不兼容更新
- **次版本号**: 新功能添加，向下兼容
- **修订号**: 问题修复，向下兼容
