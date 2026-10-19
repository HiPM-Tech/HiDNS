import type { DnsAdapter, DnsRecord } from './DnsInterface';

/**
 * 读取记录元数据（发布事件时需要 type/value）。
 *
 * 单条查询失败不等于「记录不存在」：部分提供商不支持按 id 反查，
 * 或瞬时失败。此前调用方把失败一律当作 null，导致「写入成功但事件永不发布」。
 * 这里补一次列表兜底，仍失败才返回 null。
 */
export async function findRecordMeta(adapter: DnsAdapter, recordId: string): Promise<DnsRecord | null> {
  try {
    const record = await adapter.getDomainRecordInfo(recordId);
    if (record) return record;
  } catch {
    // 落到列表兜底
  }

  try {
    const page = await adapter.getDomainRecords(1, 1000);
    return page.list.find((item) => String(item.RecordId) === String(recordId)) ?? null;
  } catch {
    return null;
  }
}