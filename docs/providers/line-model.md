# DNS 线路模型（2.3.1）

> 规范：`root.ai.md` §DNS提供商适配器「2.2 线路模型」。每个提供商必须显式声明线路来源与默认线路；**内置 / 动态二选一**，不允许动态再给内置兜底。

## 1. 规则

- `lineSource: 'builtin'`：`getRecordLines()` 返回代码内静态表，**不得发起网络请求**；`defaultLine` 必须在表内。
- `lineSource: 'dynamic'`：`getRecordLines()` 必须请求上游；失败时**适配器抛错**，由服务层统一降级为「只返回默认线路」，并在 5 分钟后重试。
- 动态线路拉取成功写入 `provider_lines` 缓存表，TTL **3600s**；失败进入 **300s** 冷却，期间直接用默认线路，不再打上游。
- PSL（公共后缀）与线路刷新共用 `taskManager` 约束（并发/超时/同 ID 去重），且**只对「有启用账号」的提供商**加入拉取。
- 未指定线路（`undefined` / `''` / 历史哨兵 `'0'` 且默认非 `'0'`）→ 适配器使用 `defaultLine`。
- 代理型提供商（Cloudflare / AliyunESA）未指定代理状态 → 统一 `proxied=false`（不代理），线路仍走 defaultLine。
- 契约测试：`server/src/lib/dns/__tests__/adapter-contract.test.ts`（声明完整性 / 内置不联网 / 动态不兜底 / 适配器引用 defaultLine）。

## 2. 提供商一览

| 提供商 | 类型 | 线路来源 | 默认线路 |
| --- | --- | --- | --- |
| 阿里云 (`aliyun`) | dynamic | dynamic | `0` |
| 阿里云 ESA (`aliyunesa`) | builtin | builtin | `0` |
| 百度云 (`baidu`) | builtin | builtin | `0` |
| 宝塔 (`bt`) | dynamic | dynamic | `0` |
| 彩虹 DNS 聚合 (`caihongdns`) | builtin | builtin | `默认` |
| Cloudflare (`cloudflare`) | builtin | builtin | `0` |
| DNSHE (`dnshe`) | builtin | builtin | `0` |
| DNS.LA (`dnsla`) | dynamic | dynamic | `0` |
| DNS Neko (`dnsneko`) | dynamic | dynamic | `default` |
| 腾讯云 DNSPod (`dnspod`) | dynamic | dynamic | `0` |
| DigitalPlat 反向 (`dpdns_reverse`) | builtin | builtin | `0` |
| Gcore (`gcore`) | builtin | builtin | `0` |
| HiDNS (`hidns`) | builtin | builtin | `0` |
| HiDNS v2 (`hidns_v2`) | dynamic | dynamic | `0` |
| 华为云 (`huawei`) | dynamic | dynamic | `default_view` |
| 火山引擎 (`huoshan`) | dynamic | dynamic | `0` |
| 京东云 (`jdcloud`) | dynamic | dynamic | `0` |
| NameSilo (`namesilo`) | builtin | builtin | `0` |
| PowerDNS (`powerdns`) | builtin | builtin | `0` |
| 青云 (`qingcloud`) | dynamic | dynamic | `0` |
| 雨云 (`rainyun`) | builtin | builtin | `DEFAULT` |
| Spaceship (`spaceship`) | builtin | builtin | `0` |
| 腾讯 EdgeOne (`tencenteo`) | builtin | builtin | `Default` |
| 虚拟（测试） (`virtual`) | builtin | builtin | `default` |
| VPS8 (`vps8`) | builtin | builtin | `0` |
| 西部数码 (`west`) | builtin | builtin | `0` |

## 3. 为什么不允许动态兜底

内置兜底会把「上游不可用」伪装成「线路可用」，用户以为能选电信/联通，实际建记录时才知道失败。允许的降级只有一种：**只返回该提供商的默认线路**（`defaultLine`），并把失败记录下来交给任务在 5 分钟后重试；不允许回退到静态线路表。

## 4. 默认线路与历史哨兵

- `0` 只在默认线路本身是 `0` 的提供商（阿里云 / 百度 / 宝塔 / DNSPod 等）里保留；华为云等默认非 `0` 的提供商，收到 `0` 一律回落 `defaultLine`。
- 前端「默认线路」提交空值，由服务端按上表落到各自默认线路。

## 5. 缓存与任务

- 缓存表：`provider_lines(provider_type, line_id, line_name, updated_at)`，唯一键 `(provider_type, line_id)`
- 读取：`DnsProviderService.getLines()` → 内置直接返回；动态走 `getProviderLinesCached()`（缓存 3600s → 拉取 → 失败仅默认 + 300s 冷却）
- 任务：`service/providerLinesJob.ts` 每 60s 检查一次，只处理有启用账号的提供商；与 `publicSuffixJob` 共用 `taskManager`，首次拉取分别延迟 25s / 30s

## 6. 实现位置

- 声明：`server/src/lib/dns/providers/registry.ts`（`ProviderDefinition.lineSource` / `defaultLine`）
- 归一化：`server/src/lib/dns/providers/common.ts`（`resolveProviderLine`）
- 路由语义：`server/src/service/record-line.ts`（未指定代理 → `proxied=false`）
