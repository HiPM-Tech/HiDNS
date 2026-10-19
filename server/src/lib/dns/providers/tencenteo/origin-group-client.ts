import { OriginGroup, OriginRecord, OriginRecordType } from './origin-group';

/**
 * EdgeOne 源站组 API 客户端（裸原语）。
 * 设计依据：docs/WORKFLOW_ENGINE_DESIGN.md §3.7.3 / §3.7.4
 *
 * `call` 由适配器注入（TencentCloudAdapter.call），本文件不自行发请求，便于以假 call 做单测。
 */

export type TeoCall = (action: string, payload?: Record<string, unknown>) => Promise<Record<string, unknown>>;

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function mapRecord(raw: Record<string, unknown>): OriginRecord {
  const weight = raw.Weight;
  return {
    recordId: typeof raw.RecordId === 'string' ? raw.RecordId : undefined,
    record: String(raw.Record ?? ''),
    type: (raw.Type === 'AWS_S3' ? 'AWS_S3' : 'IP_DOMAIN') as OriginRecordType,
    weight: typeof weight === 'number' ? weight : undefined,
    private: raw.Private === true ? true : undefined,
    privateParameters:
      raw.PrivateParameters && typeof raw.PrivateParameters === 'object'
        ? (raw.PrivateParameters as Record<string, string>)
        : undefined,
  };
}

function mapGroup(raw: Record<string, unknown>): OriginGroup {
  return {
    groupId: String(raw.GroupId ?? raw.OriginGroupId ?? ''),
    name: String(raw.Name ?? ''),
    type: raw.Type === 'HTTP' ? 'HTTP' : 'GENERAL',
    hostHeader: typeof raw.HostHeader === 'string' ? raw.HostHeader : undefined,
    records: asArray<Record<string, unknown>>(raw.Records).map(mapRecord),
    references: asArray<Record<string, unknown>>(raw.References).map((ref) => ({
      type: String(ref.Type ?? ''),
      id: String(ref.Id ?? ''),
      name: typeof ref.Name === 'string' ? ref.Name : undefined,
    })),
  };
}

export class OriginGroupClient {
  constructor(
    private readonly call: TeoCall,
    private readonly scopeId: string,
  ) {}

  async list(opts: { offset?: number; limit?: number } = {}): Promise<OriginGroup[]> {
    const data = await this.call('DescribeOriginGroup', {
      ZoneId: this.scopeId,
      Offset: opts.offset ?? 0,
      Limit: Math.min(opts.limit ?? 20, 1000),
    });
    return asArray<Record<string, unknown>>(data.OriginGroups).map(mapGroup);
  }

  /**
   * 按**源站组 ID** 定位，由 API 拉取（§3.7.3 的 `Filters: origin-group-id`）。
   * 不使用"全量列出再本地查找"：源站组数量无上限，全量拉取既慢又可能截断。
   * 服务端若不认该 filter，仍以返回结果中的 GroupId 精确比对，避免误取。
   */
  async get(groupId: string): Promise<OriginGroup | null> {
    if (!groupId) return null;
    const data = await this.call('DescribeOriginGroup', {
      ZoneId: this.scopeId,
      Offset: 0,
      Limit: 20,
      Filters: [{ Name: 'origin-group-id', Values: [groupId] }],
    });
    const groups = asArray<Record<string, unknown>>(data.OriginGroups).map(mapGroup);
    return groups.find((group) => group.groupId === groupId) ?? null;
  }

  /** 整组覆盖（裸原语）：传入什么就写什么，不做任何保护 */
  async replace(groupId: string, records: OriginRecord[]): Promise<void> {
    await this.call('ModifyOriginGroup', {
      ZoneId: this.scopeId,
      GroupId: groupId,
      Records: records.map((record) => ({
        Record: record.record,
        Type: record.type,
        ...(record.weight === undefined ? {} : { Weight: record.weight }),
        ...(record.recordId ? { RecordId: record.recordId } : {}),
        ...(record.privateParameters ? { PrivateParameters: record.privateParameters } : {}),
      })),
    });
  }
}