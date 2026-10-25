# DDNS-Go / Certd 的 HiDNS 适配兼容性核对（2.3.1）

> 核对方式：拉取上游源码仓库后逐文件比对（非猜测）：
> - `jeessy2/ddns-go` @ `7aad574`，实现文件 `dns/hipmdnsmgr.go`
> - `certd/certd` @ `b99e78f`，实现目录 `packages/ui/certd-server/src/plugins/plugin-hipmdnsmgr/`（`dns-provider` + `access`）

## 1. 两者使用的 HiDNS API

| 用途 | DDNS-Go | Certd | 本仓库 2.3.1 现状 |
| --- | --- | --- | --- |
| 查域名 ID | `GET /domains?page&pageSize&keyword`（兼容数组与 `{list}`） | 同左（优先 keyword，回退列表匹配） | Token 会话返回数组；会话 Cookie 返回 `{list,total,page...}` |
| 查记录 | `GET /domains/:id/records?page&pageSize&subdomain&type` | 同左（另支持 `value`） | 支持 `page/pageSize/subdomain/type/value`，返回 `{total,list}` |
| 建记录 | `POST /domains/:id/records`，body `{name,type,value,ttl,line:"0"}`（MX 另带 `mx:10`） | 同左，body `{name,type,value,ttl:600,line:"0"}` | 已兼容；`line:"0"` 按「未指定」落到该提供商 `defaultLine` |
| 改记录 | `PUT /domains/:id/records/:recordId`（同样带 `line:"0"`） | — | 已兼容；华为云等「线路不可改」提供商忽略 `line` |
| 删记录 | — | `DELETE /domains/:id/records/:recordId` | 已兼容 |
| 建记录返回值 | 只校验 `code === 0` | 读 `res.id` 继续删除 | `POST` 返回 `{ id }` |
| 记录字段 | `id/name/type/value/line/ttl/mx/weight/status/remark/updated_at/proxiable/cloudflare` | 同左（删除只用 `id`） | `toApiRecord()` 输出同名字段，`cloudflare.proxied` 与 `proxiable` 均有 |
| 重定向 | **不发送** `redirect` | **不发送** `redirect` | 未声明 `capabilities.redirect` 的提供商直接忽略 `redirect`，两者无影响 |

## 2. 2.3.1 的语义变更对两者的影响

1. **`line: "0"`**：2.3.1 起视为「未指定线路」，由提供商 `defaultLine` 决定。
   - 默认线路就是 `0` 的提供商（阿里云 / 百度 / 宝塔 / DNSPod 等）行为不变；
   - 华为云等默认非 `0` 的提供商会落到 `default_view` —— 这是修正（此前 `0` 不在华为线路空间内）。
2. **代理状态**：两者都不传 `proxied`，按 2.3.1「未指定 = 不代理」处理；Cloudflare 记录不会被意外开橙云。
3. **重定向**：两者都不传 `redirect`；即使未来传入，未声明能力的提供商也会忽略，不会 400。
4. **响应形状**：两者都兼容「数组」与「`{list}`」两种域名列表；Certd 的**回退路径**按 `item.domain` 匹配（本仓库字段是 `name`），但主路径 `item.name` 已命中，回退仅在上游 keyword 失败时才会触发。

## 3. 结论

- **建/改/删记录、查域名、查记录、字段读取全部兼容**；无需为两者保留旧接口或兼容开关。
- 唯一需要注意的行为变化是「`line:"0"` 在默认非 `0` 的提供商上会落到该提供商默认线路」，属于修正而非破坏。
- 若后续给某提供商真正实现记录级重定向（`setRecordRedirect`），需要同步告知 DDNS-Go / Certd（它们当前不会传 `redirect`，影响为零）。

## 4. 复现

```bash
git clone --depth 1 https://github.com/jeessy2/ddns-go.git
git clone --depth 1 https://github.com/certd/certd.git
grep -n 'domains/\|line\|redirect' ddns-go/dns/hipmdnsmgr.go
grep -rn 'line:\|records' certd/packages/ui/certd-server/src/plugins/plugin-hipmdnsmgr
```
