# 第三方组件与数据声明

## 公共后缀列表（Public Suffix List）

- 来源：https://publicsuffix.org/list/public_suffix_list.dat
- 许可：Mozilla Public License 2.0（MPL-2.0）
- 形态：内嵌快照 `server/src/data/public-suffix-list.dat`（仅用于首次播种与离线兜底），运行时真值在 DB 表 `public_suffixes`，由 `service/publicSuffixJob.ts` 定期从上游刷新。
- 修改说明：解析时会把 Unicode 形式的 IDN 后缀转换为 Punycode；`!` 例外规则被跳过（见 `service/public-suffix.ts` 注释）。
