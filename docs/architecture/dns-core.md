# DNS 核心层架构

## DNS 接口定义

**文件位置**: `server/src/lib/dns/DnsInterface.ts`

**职责**: 定义 DNS 服务商适配器的标准接口

### 核心接口

```typescript
interface DnsAdapter {
  check(): Promise<boolean>
  getError(): string
  getDomainList(keyword?: string, page?: number, pageSize?: number): Promise<PageResult<DomainInfo>>
  getDomainRecords(
    page?: number,
    pageSize?: number,
    keyword?: string,
    subdomain?: string,
    value?: string,
    type?: string,
    line?: string,
    status?: number
  ): Promise<PageResult<DnsRecord>>
  getDomainRecordInfo(recordId: string): Promise<DnsRecord | null>
  addDomainRecord(
    name: string,
    type: string,
    value: string,
    line?: string,
    ttl?: number,
    mx?: number,
    weight?: number,
    remark?: string
  ): Promise<string | null>
  updateDomainRecord(
    recordId: string,
    name: string,
    type: string,
    value: string,
    line?: string,
    ttl?: number,
    mx?: number,
    weight?: number,
    remark?: string
  ): Promise<boolean>
  deleteDomainRecord(recordId: string): Promise<boolean>
  setDomainRecordStatus(recordId: string, status: number): Promise<boolean>
  getRecordLines(): Promise<Array<{ id: string; name: string }>>
  getMinTTL(): Promise<number>
  addDomain(domain: string): Promise<boolean>
}
```

## DNS 适配器工厂

**文件位置**: `server/src/lib/dns/DnsHelper.ts`

**职责**: 根据服务商类型创建对应的适配器实例，支持日志代理包装

```typescript
// 创建适配器实例（domain/zoneId/domainId 会被注入到 config 中供需要它们的提供商使用）
createAdapter(type: string, config: Record<string, string>, domain?: string, zoneId?: string, domainId?: string): DnsAdapter

// 获取所有支持的服务商
getProviders(includeStub?: boolean): ProviderInfo[]
```

## 服务商注册表

**文件位置**: `server/src/lib/dns/providers/registry.ts`

**职责**: 集中管理所有 DNS 服务商的定义和配置

### Provider 定义

```typescript
export interface ProviderDefinition {
  type: string;
  name: string;
  capabilities: ProviderCapabilities;
  configFields: ProviderConfigField[];
  adapterFactory: (config: Record<string, string>) => DnsAdapter;
}

export interface ProviderCapabilities {
  remark: boolean;        // 支持备注
  status: boolean;        // 支持状态切换
  redirect: boolean;      // 支持重定向
  log: boolean;           // 支持日志
  weight: boolean;        // 支持权重
  line: boolean;          // 支持线路
  cnameFlattening: boolean; // 支持 CNAME 拉平
}

export interface ProviderConfigField {
  key: string;
  label: string;
  type: 'text' | 'password';
  required: boolean;
  group?: string;
}
```

## 支持的服务商列表

| 类型 | 名称 | 能力 |
|------|------|------|
| `aliyun` | 阿里云 | status, log, line |
| `dnspod` | 腾讯云-DNSPod | status, log, line |
| `huawei` | 华为云 | status, line |
| `baidu` | 百度云 | status, line |
| `huoshan` | 火山引擎 | status, line |
| `jdcloud` | 京东云 | status, line |
| `cloudflare` | Cloudflare | remark, redirect, weight, line, cnameFlattening |
| `dnsla` | DNS.LA | status, weight, line |
| `west` | 西部数码 | status, line |
| `qingcloud` | 青云 | status, line |
| `namesilo` | NameSilo | line |
| `bt` | 宝塔 | status, line |
| `spaceship` | Spaceship | line |
| `powerdns` | PowerDNS | status, line |
| `aliyunesa` | 阿里云ESA | status, line |
| `tencenteo` | 腾讯EdgeOne | status, line |
| `dnshe` | DNSHE | line |
| `rainyun` | 雨云 | line |
| `vps8` | VPS8 | status, line |
| `caihongdns` | 彩虹DNS聚合 | remark, status, weight, line |
| `gcore` | Gcore | status |
| `hidns` | HiDNS | remark, status, weight |

## 服务商别名映射

**文件位置**: `server/src/lib/dns/providerAlias.ts`

创建/更新 DNS 账号时，API 会将 lego-style provider 名称归一化为内部 provider 类型。

| 内部类型 | 支持别名 |
|---|---|
| `aliyun` | `aliyun`, `alidns` |
| `aliyunesa` | `aliesa` |
| `baidu` | `baiducloud` |
| `huawei` | `huaweicloud` |
| `huoshan` | `huoshan`, `volcengine` |
| `west` | `westcn` |
| `cloudflare` | `cloudflare` |
| `jdcloud` | `jdcloud` |
| `namesilo` | `namesilo` |
| `rainyun` | `rainyun` |
| `powerdns` | `powerdns`, `pdns` |
| `dnspod` | `dnspod`, `tencentcloud` |
| `tencenteo` | `tencenteo`, `edgeone` |

## 添加新的 DNS 服务商

### 1. 创建适配器

在 `server/src/lib/dns/providers/_example/adapter.ts` 中创建新的适配器（可参考示例模板）：

```typescript
import { DnsAdapter, DomainInfo, DnsRecord, PageResult, BaseAdapter } from '../internal';

export class MyProviderAdapter extends BaseAdapter implements DnsAdapter {
  private config: Record<string, string>;
  private error: string = '';

  constructor(config: Record<string, string>) {
    this.config = config;
  }

  async check(): Promise<boolean> {
    // 验证配置是否正确
    return true;
  }

  async getDomainList(keyword?: string, page?: number, pageSize?: number): Promise<PageResult<DomainInfo>> {
    // 获取域名列表
    return { total: 0, list: [] };
  }

  async getDomainRecords(
    page?: number,
    pageSize?: number,
    keyword?: string,
    subdomain?: string,
    value?: string,
    type?: string,
    line?: string,
    status?: number
  ): Promise<PageResult<DnsRecord>> {
    // 获取解析记录列表
    return { total: 0, list: [] };
  }

  async getDomainRecordInfo(recordId: string): Promise<DnsRecord | null> {
    // 获取单条记录详情
    return null;
  }

  async addDomainRecord(
    name: string,
    type: string,
    value: string,
    line?: string,
    ttl?: number,
    mx?: number,
    weight?: number,
    remark?: string
  ): Promise<string | null> {
    // 添加解析记录
    return null;
  }

  async updateDomainRecord(
    recordId: string,
    name: string,
    type: string,
    value: string,
    line?: string,
    ttl?: number,
    mx?: number,
    weight?: number,
    remark?: string
  ): Promise<boolean> {
    // 更新解析记录
    return false;
  }

  async deleteDomainRecord(recordId: string): Promise<boolean> {
    // 删除解析记录
    return false;
  }

  async setDomainRecordStatus(recordId: string, status: number): Promise<boolean> {
    // 设置记录状态
    return false;
  }

  getError(): string {
    return this.error;
  }

  async getRecordLines(): Promise<Array<{ id: string; name: string }>> {
    // 获取线路列表
    return [];
  }

  async getMinTTL(): Promise<number> {
    // 获取最小 TTL
    return 600;
  }

  async addDomain(domain: string): Promise<boolean> {
    // 添加域名
    return false;
  }
}
```

### 2. 注册到注册表

在 `server/src/lib/dns/providers/registry.ts` 中添加：

```typescript
import { MyProviderAdapter } from './myprovider';

const providerDefinitions: ProviderDefinition[] = [
  // ... 其他服务商
  {
    type: 'myprovider',
    name: 'My Provider',
    capabilities: { remark: false, status: true, redirect: false, log: false, weight: false, line: true, cnameFlattening: false },
    configFields: [
      { key: 'apiKey', label: 'API Key', type: 'text', required: true },
      { key: 'apiSecret', label: 'API Secret', type: 'password', required: true },
    ],
    adapterFactory: (config) => new MyProviderAdapter(config),
  },
];
```

### 3. 导出适配器

在 `server/src/lib/dns/providers/index.ts` 中添加：

```typescript
export { MyProviderAdapter } from './myprovider';
```

## Cloudflare 特殊字段

DNS 记录仍保留通用 `line` 字段以兼容历史逻辑。对于 Cloudflare，请使用请求/响应中的服务商专用字段：

- `cloudflare.proxied`: 代理开关（`true` = 代理，`false` = 仅 DNS）
- `cloudflare.proxiable`: 当前记录类型是否支持代理

### 创建/更新优先级

1. 如果提供 `cloudflare.proxied`，则优先使用
2. 否则回退到 `line`（`'1'` = 代理，`'0'` = 仅 DNS）

## WHOIS 查询调度器（v1.3.2+）

**文件位置**: `server/src/service/whois/scheduler.ts`

**职责**: 统一管理 DNS 提供商的 WHOIS 查询能力，支持注册商模式

### 核心接口

```typescript
interface WhoisScheduler {
  readonly type: string;
  queryWhois(config: any, domain: string): Promise<WhoisResult | null>;
}
```

### 查询策略

WHOIS 服务支持两种查询策略：

#### 1. 顶域查询策略（默认）

```
顶域 RDAP/WHOIS → DNS 提供商 WHOIS → 第三方查询
```

#### 2. 子域查询策略

```
DNS 提供商 WHOIS → 子域/顶域并行查询 → 第三方查询
```

### 禁用父域查询选项

对于公开 RDAP 接口（`/api/rdap`），可以禁用父域 fallback 查询：

```typescript
const result = await whoisService.query('xxx.baidu.com', {
  skipParentFallback: true  // 仅查询子域，不查询 baidu.com
});
```

**查询顺序**：
```
子域 RDAP/WHOIS → 平级查询 → 第三方查询（仅子域）→ 放弃
```

### DNSHE WHOIS 调度器实现

**文件位置**: `server/src/lib/dns/providers/dnshe/whoisScheduler.ts`

DNSHE 提供商实现了 WHOIS 调度器接口，通过 DNSHE API 查询域名信息。

## 域名续期调度器（v1.3.2+）

**文件位置**: `server/src/service/renewalScheduler.ts`

**职责**: 统一管理 DNS 提供商的域名续期能力，支持注册商模式

### 核心接口

```typescript
interface RenewalScheduler {
  readonly type: string;
  listRenewableDomains(config: any): Promise<RenewableDomain[]>;
  renewDomain(config: any, domainId: number | string): Promise<RenewalResult | null>;
}
```

### DNSHE 续期调度器实现

**文件位置**: `server/src/lib/dns/providers/dnshe/scheduler.ts`

DNSHE 提供商实现了续期调度器接口：

- **listRenewableDomains**: 调用 DNSHE API 获取可续期的子域名列表
- **renewDomain**: 调用 DNSHE API 续期指定子域名

**注意**: DNSHE API 的 `listSubdomains` 不返回 `expires_at` 字段，因此对所有子域名都会尝试续期，由 API 服务端判断是否已过期。

## DNS 提供商模块化架构

### 提供商目录结构
```
providers/
├── registry.ts          # 服务商注册表（核心）
├── index.ts             # 统一导出
├── common.ts            # 公共工具函数
├── http.ts              # HTTP 请求封装
├── internal.ts          # 内部模块依赖集中管理（导入转发）
├── stubs.ts             # Stub 适配器
├── _example/            # 示例模板
│   ├── adapter.ts       # 适配器实现示例
│   ├── scheduler.ts     # 调度器实现示例（可选）
│   └── whoisScheduler.ts # WHOIS 调度器示例（可选）
├── aliyun/              # 阿里云
│   ├── adapter.ts
│   └── ...
└── ...
```

### 注册表机制
- **providerDefinitions**: 集中定义所有服务商
- **capabilities**: 声明服务商能力（remark, status, redirect, log, weight, line, cnameFlattening）
- **configFields**: 定义配置字段（text/password/select）
- **adapterFactory**: 工厂函数创建适配器实例

### 添加新提供商步骤
1. 在 `providers/myprovider/` 创建适配器目录（参考 `_example/` 模板）
2. 在 `registry.ts` 注册服务商定义
3. 在 `index.ts` 导出适配器（添加一行 `export { MyProviderAdapter } from './myprovider';`）
4. （可选）实现 WHOIS/续期调度器

## 跨服务商复用腾讯云鉴权（EdgeOne 源站组）

腾讯云各产品的鉴权是**账号级**的：DNSPod 与 EdgeOne（TEO）用的是同一对
`SecretId` / `SecretKey`，只是调用不同域名。因此已经配置了 DNSPod 账号的用户，
不必再登记一个 EdgeOne 账号才能管理源站组。

实现位置：`providers/tencenteo/teo-ops.ts` 的 `teoOpsForDomain(domainId)`，
能力层（`ext.tencenteo.originGroup.*`）与编辑器候选源（`originGroups`）共用这一份解析。

### 依赖方向：提供商不碰 BAL 与服务层

`providers/**` 只该懂「怎么调厂商 API」。凭据存在哪张表、从哪个 service 取适配器实例，
都是上层的事。提供商直接 import BAL 会让依赖方向倒挂，并且把「谁有资格读凭据」的判断
散落到每个提供商里 —— 那正是跨提供商凭据复用被单方面决定的温床。

因此新增 DNS 模块子功能 **`lib/dns/account-context.ts`**，集中承担三件事：

| 函数 | 职责 |
| --- | --- |
| `resolveDomainAccount(domainId)` | 域名行 → accountId / thirdId |
| `resolveAccount(accountId)` | 账号行 → 类型 + 解析后的配置 |
| `resolveAccountContext(domainId)` | 上面两者 + 适配器实例 |

依赖方向由此变成：

```
providers/**  ←  lib/dns/account-context.ts  →  db/bal（BAL）/ service
```

凭据复用的判定本身（`origin-group-broker.ts`）与站点级授权（`origin-group-authorize.ts`）
也随之从 `providers/tencenteo/` 上提到 `lib/dns/`，提供商目录里只剩适配器与能力声明。

这条规则由 `providers/__tests__/layer-dependency.test.ts` 强制：扫描 `providers/**` 的
全部源码，出现 `db/bal/` 或 `service/dns-provider-service` 即失败。

> 提供商里仍有对 `service/renewalScheduler` 与 `service/whois` 的 import，
> 那是「提供商提供调度器子类」的既有模式，与凭据路径无关，本守卫不覆盖。

### 凭据复用必须两端相互声明

复用别人的凭据是**跨提供商的授权**，不能由消费方单方面决定。否则任何提供商实现
（包括第三方注入的）只要写一句"我可以复用 X 的凭据"，就能拿到 X 的 SecretId / SecretKey。

因此声明分成两侧，两边都命中才放行（`providers/credential-sharing.ts`）：

| 侧 | 含义 | 当前条目 |
| --- | --- | --- |
| `CREDENTIAL_EXPORTS` | 导出方声明「允许谁复用我的凭据」 | `dnspod: ['tencenteo']` |
| `CREDENTIAL_IMPORTS` | 消费方声明「我要复用谁的凭据」 | `tencenteo: ['dnspod']` |

判定是 `imports[consumer].includes(source) && exports[source].includes(consumer)`。
只有一边声明 = 不放行，错误码 `CREDENTIAL_REUSE_NOT_DECLARED`。

注册表在模块加载时校验这张表（`validateCredentialSharing`）：

- 任一单边条目 → **启动即失败**
- 声明里出现不存在的提供商类型 → 启动即失败

这样注入一个恶意提供商，必须同时改到别人的声明文件才能生效，单点注入无法成立。

### 两条解析路径

| 账号类型 | ZoneId 来源 | 站点类型来源 | 凭据来源标记 |
| --- | --- | --- | --- |
| `tencenteo` | `domains.third_id` 直接就是 ZoneId | 复用账号配置里的 `site_type`，**不需要额外声明** | `tencenteo` |
| `dnspod` | **工作流动作的 `zoneId` 参数**，必须显式传 | **工作流动作的 `siteType` 参数**，必须显式传 | `dnspod` |

### DNSPod 凭据不涉及 DNSPod 注册的域名

这是最容易搞错的一点：复用 DNSPod 凭据时，**DNSPod 注册的域名与 EdgeOne 站点没有对应关系**。

那对 `SecretId` / `SecretKey` 只是在腾讯云账号层级通用，用它发 EO 请求时，
`domains.third_id`（DNSPod 的域名 ID，如 `41234567`）既不是 EO 的 ZoneId（形如
`zone-3mr62gje0l1m`），也不应该拿去 EO 侧按域名反查——那等于把"域名看起来一样"
当成了"就是同一个站点"，一旦用户的 EO 站点用了别的名字，就会静默落空。

所以代码不走任何域名推导：**ZoneId 由调用方显式给出**。

取值途径是候选源 `edgeoneZones`——用这对凭据先列出可见站点，让用户选一个：

```
ext.tencenteo.originGroup.list
  domainId : 7            # 只用于定位"用哪个账号的密钥"
  siteType : mainland     # 调国内站还是国际站
  zoneId   : zone-xxxx    # 要操作的 EdgeOne 站点
```

### 站点类型：EdgeOne 账号不用声明，DNSPod 账号必须显式声明

EdgeOne 的国内站与国际站是**两个不同的调用域名**，数据互不通用：

| 站点类型 | 调用域名 |
| --- | --- |
| `mainland` | `teo.tencentcloudapi.com` |
| `intl` | `teo.intl.tencentcloudapi.com` |

- **EdgeOne 账号**：账号创建时就填了 `site_type`，直接复用，源站组动作不需要再传。
- **DNSPod 账号**：账号里没有这个信息，必须在**工作流动作**里显式传 `siteType`。

为什么写在动作而不是账号配置：同一对密钥可能管理多个站点、落在不同站点类型上，
账号级配置表达不了这种差异，而且把 EdgeOne 的概念塞进 DNSPod 账号配置也不合理。

猜错方向的后果不是报错而是**看起来像没数据**：拿国内站域名去查国际站账号，
返回的是空列表。所以宁可让用户显式声明。

### 失败语义

| 情况 | 错误码 |
| --- | --- |
| 账号既不是 `tencenteo` 也不是 `dnspod` | `PROVIDER_MISMATCH` |
| DNSPod 账号缺少 SecretId / SecretKey | `CREDENTIAL_MISSING` |
| DNSPod 账号未传 `siteType` | `SITE_TYPE_REQUIRED` |
| `siteType` 不是 mainland / intl | `SITE_TYPE_INVALID` |
| DNSPod 账号未传 `zoneId` | `ZONE_ID_REQUIRED` |

以上都发生在**发出任何请求之前**。密钥没有 EdgeOne 权限时，TEO 的
`AuthFailure` 会原样透出，不再包装成自定义错误码——避免把"没权限"和"没找到"混为一谈。

`ext.tencenteo.originGroup.plan` / `replace` 的返回值里带 `credentialSource`、
`zoneId` 与 `siteType`，用于追溯这次操作到底是哪一类账号的凭据、打的是哪个端点、碰的是哪个站点。

### 编辑器下拉的依赖

`zoneId` 的候选源是 `edgeoneZones`，只依赖 `domainId`；
`siteType` 声明为**可选**依赖（`sourceOptionalParams`），有值就带上。

`groupId` 的依赖是 `sourceParams: ['domainId']` + `sourceOptionalParams: ['siteType', 'zoneId']`。
之所以把后两者做成可选，是因为 **EdgeOne 账号根本不需要它们**——放进 `sourceParams`
会把这类账号的下拉一并禁用。

前端经 `ProviderMetaContext.params` 把这些参数透传给解析层，核心不解释其语义。

## 权限与作用域：两个平台是正交糅合，工作流是管理员专属

### 为什么叫"正交糅合"

EdgeOne 与 DNSPod 是**两个方向不同的解析平台**，但共用腾讯云统一鉴权：

| 维度 | DNSPod | EdgeOne |
| --- | --- | --- |
| 鉴权 | 同一对 `SecretId` / `SecretKey` | 同一对 `SecretId` / `SecretKey` |
| 作用域 | 域名（`domains.third_id` = DNSPod 域名 ID） | 站点 ZoneId（`zone-xxx`） |
| 资源 | 解析记录 | 加速站点 / 源站组 |

两条作用域链**不能互相推导**：DNSPod 的域名 ID 不是 EO 的 ZoneId，域名同名也不代表是同一个站点。
所以复用凭据时只能"正交地"各管各的——用同一对密钥，分别指向各自的作用域。

这也是为什么 `teoOpsForDomain` 对 DNSPod 路径要求显式 `siteType` 与 `zoneId`：
任何"猜"都会在两个正交维度之间制造一条不存在的对应关系。

### 工作流是管理员专属

工作流能跨域名、跨账号地串联写操作，一旦对普通用户开放，等于绕过了域名级授权。
因此它被限定为**管理员能力**，三条口径同时生效：

| 口径 | 实现 |
| --- | --- |
| 不能管理 | `/api/workflows` 的增删改查全部挂 `adminOnly` |
| 不能操作 | 创建 / 更新 / 删除 / 手动运行 / 试运行同样挂 `adminOnly` + `requireJwtAuth('workflows')` |
| 不能展示 | 客户端路由包在 `AdminRoute` 内，侧边栏条目只在 `isAdmin` 时渲染 |

守卫不靠"界面上藏起来"：路由级 `adminOnly` 是硬约束，知道 URL 也进不去。
这条不变量由 `server/src/routes/__tests__/workflows-admin-guard.test.ts` 直接检查
Express 路由表来保证——新增路由漏挂守卫会立刻失败。

### 源站组按站点授权，不按域名授权

`ext.*` 动作缺省的授权是 `assertExtDomainAllowed(principal, args.domainId, actionClass)`，
即"你有没有这个**域名**的权限"。这对源站组是错的：源站组属于 EdgeOne 的**站点**，
不是域名。用域名权限约束它，两个方向都会出错：

- **越权**：有域名写权限 ≠ 有该站点权限
- **误伤**：没有该域名写权限 ≠ 不能管理这个站点（站点可能根本没在 HiDNS 登记域名）

因此 `ProviderExtraCapability` 增加了 `authorize` 钩子，能力声明后即取代缺省的域名校验：

```ts
export type ProviderAuthorize = (
  principal: ExtraAuthorizePrincipal,
  args: Record<string, unknown>,
  actionClass: ActionClass,
) => Promise<void>;
```

未声明钩子的提供商行为完全不变。EdgeOne 源站组（`providers/tencenteo/authorize.ts`）
的判定分两步，任一步无法确定即拒绝：

| 步骤 | 判定 |
| --- | --- |
| 1. 账号归属 | 用户能否访问提供凭据的 DNS 账号：超管 / 账号所有者 / 账号所属团队成员 |
| 2. 站点归属 | 该站点是否在此账号凭据的可见范围内 |

第 2 步对 EdgeOne 账号天然成立（zoneId 取自该域名的 `third_id`，本就是该账号下的站点）；
复用 DNSPod 凭据时必须核验，否则用户可以传任意 `zoneId` 让系统去操作别人的站点。
核验结果按 `账号:站点类型:站点` 缓存 60 秒，避免每个动作都打一次 `DescribeZones`。

### 实时推送：广播必须按收件人定向

`wsService.broadcast` 是全局广播。任何携带域名标识（名称、到期时间、解析值、监控归属）
的 payload 一旦走全局广播，就等于推给所有在线客户端 —— 跨用户外泄。

收件人口径必须与 HTTP 读权限完全一致，基准是 `routes/domains.ts` 的 `resolveDomainAccess`：

| 顺序 | 规则 |
| --- | --- |
| A | 账号不存在或 `enabled = 0` → **全员拒绝，含超管** |
| B | 超管（`role_level >= 3`）→ 放行 |
| C | 账号创建者且 `role >= admin` → 放行 |
| D | `domain_permissions` 有规则时，按用户行与团队授权成员判定 |
| E | 没有规则 → 拒绝（残留权限行不生效） |

实现落在 `service/realtime-audience.ts`：`getDomainAudienceUserIds(domainId)` 按上表产出收件人集合，
`wsService.broadcastToUsers` 负责去重与投递。特权用户名单 60 秒缓存，避免每次事件全表扫用户。
`routes/audience.ts` 再承载两类跨文件口径（`getAdminAudienceUserIds`、`getAccountAudienceUserIds`），
供 domains / users / settings / accounts / tunnels 共用，避免每个文件各写一份特权判定。

口径漂移的两个方向都要防：**多算**是外泄，**少算**是用户看得到却收不到实时更新。

### 收口范围与现状

`server/src/routes` 下 **35 处全局广播已全部收口**（9 个文件、9 个提交），`grep 'wsService.broadcast('`
在 routes 下为 0 命中。逐文件口径：

| 文件 | 收件人 | HTTP 依据 |
| --- | --- | --- |
| records.ts | `getDomainAudienceUserIds(access.domain.id)` | GET /domains/:domainId/records 的 `canRead` |
| ns-monitor.ts | `[userId]`（仅本人） | GET /:id 走 `getById(id, userId)`，带 user_id 过滤 |
| domains.ts | 域名口径；续期事件→管理员 | GET /domains/:id；GET /renewable-domains 仅 role≥admin |
| accounts.ts | 超管 + 创建者 + 团队成员 | `canReadAccount()` |
| servicemonitor.ts | 所有者 + 超管 | GET /:id 的 `monitor.userId === user \|\| isSuper` |
| teams.ts | 团队成员 + 超管 | GET /teams/:id 的 `isSuper \|\| isMember` |
| users.ts | 管理员 + 超管 | GET /users 挂 `adminOnly` |
| settings.ts | 管理员 + 超管 | GET/PUT /settings/* 全部 `adminOnly` |
| tunnels.ts | 所属账号可读者 | `getAccessibleCloudflareAccounts()` |

三处**顺序敏感**的点必须特别注意，否则收件人恒为空集：

- `domain_deleted` / `account_deleted` / `team_deleted`：收件人在删除**之前**计算
- `team_member_added`：在 addMember **之后**计算（新成员当次即收到）
- `team_member_removed`：在 removeMember **之前**计算（被移除者需要知道自己已离开）

所有调用点统一 fail-closed：收件人为空（资源已删、账号被禁用、查询失败）时
`log.warn` 跳过投递，**绝不回退成全局广播**——回退等于把刚堵上的口子重新打开。

两处经核实保留原样：

- `service/resource/job.ts` 的 `resource:snapshot` 全员广播：HTTP 侧 `GET /api/resource-monitor/current`
  只有 `authMiddleware`、无 `adminOnly`，口径一致。
- `service/audit.ts` 的 `broadcastToRole('3')`：只推超管，而 `/api/audit/logs` 是 `adminOnly`（role≥2 可读），
  方向是"少算"，fail-closed，无外泄。

### 工作流触发的域名边界

引擎在匹配到工作流之后、执行动作之前，用 `canAccessEventDomain` 判定工作流 owner
是否有权访问事件域名：

```ts
if (domain.id > 0) return access.ids.includes(domain.id);   // id 是权威主键，未命中直接拒绝
return Boolean(domain.name) && access.names.includes(domain.name); // 仅 id=0 时按名称兜底
```

**id > 0 时不得回落到名称比较** —— 同一个 zone 挂到两个账号（同名域名）时，
名称回落会让工作流在他人域名上触发。

被跳过的运行记录会落成 `skipped / no-domain-access`，但其 `triggerEvent` **落库前必须脱敏**：
`listRuns` 是 `SELECT *`，原样保存会让 owner 从 `/runs` 读到他人域名名与解析值。
