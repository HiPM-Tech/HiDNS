/**
 * 记录值拼装（纯函数，独立文件：组件文件只导出组件，才能保持 react-refresh 语义）。
 *
 * `mx` 有独立提交字段，不能拼进 value；SRV 的 priority/weight/port 仍拼在 value 前，
 * 由服务端按「priority weight port target」四段校验。
 */
export function composeRecordValue(
  extraFields: Array<{ key: string }>,
  extras: Record<string, string>,
  value: string,
): string {
  // 只有 mx 有独立的提交字段；weight 在 SRV 里属于 value 的一部分（服务端按 "priority weight port target" 校验）
  const dedicated = new Set(['mx']);
  const prefix = extraFields
    .filter((field) => !dedicated.has(field.key))
    .map((field) => (extras[field.key] ?? '').trim());
  const main = value.trim();
  return prefix.length > 0 ? [...prefix, main].filter(Boolean).join(' ') : main;
}
