# 团 B 全量评审（认证、前端、构建、安全）· 2026-11-26

> 成员：`review-safety`（安全与越权）、`reviewer-code`（前端与构建）。
> 范围同上。与团 A 独立出结论，未合并。

## 结论

有条件发布。抓到团 A 未覆盖的三个 P1：**API 令牌可管理通行密钥**、**`/login` 错误透传**、
**修复对存量库不可达**（团 A 以 P2 记录，团 B 判为 P1）。

## P1（已修）

| 问题 | 证据 | 处理 |
|---|---|---|
| `/webauthn/*` 四个端点没有 `noTokenAuth` → 一枚 DNS 用途令牌可添加/删除通行密钥；删掉唯一第二因子则 2FA 归零 | `webauthn.ts:34,69,114,119`；对照 `security.ts:349` | 四处全部加 `noTokenAuth('passkeys')` |
| `/login` 外层 catch 回传 `error.message`（未认证端点，泄露库结构） | `auth.ts:797-798` 及同类 16 处 | 新增 `sendInternalError()`，批量收敛 16 处 |
| 唯一约束创建挂在一次性迁移，2.3.10/2.3.11 已把失败记为成功 | `data-migration-runner.ts:51-55`、`:92` | 拆成 `ensureEmailUniqueness`，每次启动执行 |

## P2（已修）

- 未分类厂商错误的原文（RequestId / 内部端点）经 `data.hint` 直出终端用户 → 只进服务端日志，提示改为「把时间点提供给管理员」。
- 注册路径 `webauthn.ts` 仍回传 `error.message` → 固定文案 + 日志。
- `requireUserVerification: false` 没有策略开关 → 改为读 `WEBAUTHN_REQUIRE_UV === '1'`，高安全部署可开启。

## 两团冲突点

| 议题 | 团 A | 团 B | 采信 |
|---|---|---|---|
| 一次性迁移不可达 | 判 P2 | 判 P1 | **按 P1 处理**（已核实 2.3.10/2.3.11 均含该迁移） |
| `PRESERVED_COLUMNS` 副作用 | P1（备份回路） | P1（同） | 成立，已修 |

## 遗留（未修，需产品决策）

- 通行密钥定位：「第二因子（UV 可选）」还是「用户在场证明」？当前按前者实现，`WEBAUTHN_REQUIRE_UV=1` 可切回后者。
- `data.hint` 是否对管理员返回厂商原文（当前统一不返回）。
- `uk_email` 是否纳入 schema DSL（当前靠白名单保留）。
