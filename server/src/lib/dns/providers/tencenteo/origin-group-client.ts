import { OriginGroup, OriginRecord, OriginRecordType } from './origin-group';

/**
 * EdgeOne 源站组 API 客户端（裸原语）。
 * 设计依据：docs/WORKFLOW_ENGINE_DESIGN.md §3.7.3 / §3.7.4
 *
 * `call` 由适配器注入（TencentCloudAdapter.call），本文件不自行发请求，便于以假 call 做单测。
 *
 * 字段名以 DescribeOriginGroup 的真实响应为准（2022-09-01）：
 *   - 组对象同时返回 GroupId/OriginGroupId、Name/OriginGroupName，两套并存且值相同
 *   - 引用元素的实际键是 InstanceId / InstanceName / InstanceType / ZoneId / ZoneName，
 *     **不是** Id / Name / Type（早期按后者读取，导致所有引用被映射成空壳）
 *   - Records[].PrivateParameters 恒为**数组**（空数组表示无私有参数），不能直接当作
 *     Record<string,string> 使用，否则 Boolean([]) === true 会让"不可重建"判断恒为真
 */

export type TeoCall = (action: string, payload?: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** 单次调用的分页上限保护：源站组数量理论无上限，避免异常响应导致死循环 */
const MAX_PAGES = 10;

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * 私有参数只在"非数组、非空、且至少含一个字符串值"时才算存在。
 * 真实响应里无私有参数时返回 `[]`，必须与"有参数"区分开。
 */
function mapPrivateParameters(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string') out[key] = raw;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function mapRecord(raw: Record<string, unknown>): OriginRecord {
  const weight = raw.Weight;
  const privateParameters = mapPrivateParameters(raw.PrivateParameters);
  return {
    recordId: typeof raw.RecordId === 'string' && raw.RecordId ? raw.RecordId : undefined,
    record: String(raw.Record ?? ''),
    type: (raw.Type === 'AWS_S3' ? 'AWS_S3' : 'IP_DOMAIN') as OriginRecordType,
    weight: typeof weight === 'number' && Number.isFinite(weight) ? weight : undefined,
    private: raw.Private === true ? true : undefined,
    privateParameters,
  };
}

/** 引用方：真实键名为 Instance*，同时兼容 Id/Name/Type 形态（旧响应/桩数据） */
function mapReference(raw: Record<string, unknown>): OriginGroup['references'][number] {
  const type = String(raw.InstanceType ?? raw.Type ?? '');
  const id = String(raw.InstanceId ?? raw.Id ?? '');
  const nameValue = raw.InstanceName ?? raw.Name;
  const zoneId = typeof raw.ZoneId === 'string' && raw.ZoneId ? raw.ZoneId : undefined;
  const zoneName = typeof raw.ZoneName === 'string' && raw.ZoneName ? raw.ZoneName : undefined;
  return {
    type,
    id,
    name: typeof nameValue === 'string' && nameValue ? nameValue : undefined,
    ...(zoneId ? { zoneId } : {}),
    ...(zoneName ? { zoneName } : {}),
  };
}

function mapGroup(raw: Record<string, unknown>): OriginGroup {
  const hostHeader = raw.HostHeader;
  return {
    groupId: String(raw.GroupId ?? raw.OriginGroupId ?? ''),
    name: String(raw.Name ?? raw.OriginGroupName ?? ''),
    type: raw.Type === 'HTTP' ? 'HTTP' : 'GENERAL',
    hostHeader: typeof hostHeader === 'string' && hostHeader ? hostHeader : undefined,
    records: asArray<Record<string, unknown>>(raw.Records).map(mapRecord),
    references: asArray<Record<string, unknown>>(raw.References).map(mapReference),
  };
}

export interface ReplaceResult {
  /** 服务端回执 ID，用于审计与工单追溯 */
  requestId?: string;
}

export class OriginGroupClient {
  constructor(
    private readonly call: TeoCall,
    private readonly scopeId: string,
  ) {}

  /**
   * 全量列出（自动翻页）。
   * 旧实现只取一页：源站组超过 Limit 时静默截断，用户看不到后面的组，
   * 而"组不存在"与"组在第二页"在调用方看来无法区分。
   */
  async list(opts: { offset?: number; limit?: number } = {}): Promise<OriginGroup[]> {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 1000);
    let offset = Math.max(opts.offset ?? 0, 0);
    const collected: OriginGroup[] = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const data = await this.call('DescribeOriginGroup', {
        ZoneId: this.scopeId,
        Offset: offset,
        Limit: limit,
      });
      const batch = asArray<Record<string, unknown>>(data.OriginGroups).map(mapGroup);
      collected.push(...batch);
      const totalCount = typeof data.TotalCount === 'number' ? data.TotalCount : collected.length;
      if (batch.length === 0 || batch.length < limit || collected.length >= totalCount) break;
      offset += batch.length;
    }
    return collected;
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

  /**
   * 整组覆盖（裸原语）：传入什么就写什么，不做任何保护。
   * 回执里的 RequestId 必须回传：整组覆盖是不可逆写入，没有回执就无法追溯到底改了哪次。
   */
  async replace(groupId: string, records: OriginRecord[]): Promise<ReplaceResult> {
    const data = await this.call('ModifyOriginGroup', {
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
    const requestId = typeof data?.RequestId === 'string' && data.RequestId ? data.RequestId : undefined;
    return { requestId };
  }
}
