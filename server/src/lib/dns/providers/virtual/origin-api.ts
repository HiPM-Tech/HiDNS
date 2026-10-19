import { randomUUID } from 'node:crypto';
import type { VirtualStore, VirtualOriginGroup } from './store';

/**
 * 虚拟 EdgeOne API 传输层。
 *
 * 把 `DescribeOriginGroup` / `ModifyOriginGroup` 映射到本地状态，
 * 使 `OriginGroupClient` 的映射、校验与分页逻辑可以**原样复用**。
 * 这样虚拟环境跑的是真实代码路径，而不是另一套实现。
 */

export type TeoCall = (action: string, payload?: Record<string, unknown>) => Promise<Record<string, unknown>>;

function requestId(): string {
  return 'virtual-' + randomUUID();
}

function asNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function cloneGroup(group: VirtualOriginGroup): VirtualOriginGroup {
  return JSON.parse(JSON.stringify(group)) as VirtualOriginGroup;
}

export function createVirtualTeoCall(store: VirtualStore): TeoCall {
  return async (action: string, payload: Record<string, unknown> = {}) => {
    const zoneId = String(payload.ZoneId ?? '');
    const zone = store.zone(zoneId);
    if (!zone) throw new Error(`虚拟站点不存在: ${zoneId || '(空)'}`);

    if (action === 'DescribeZones') {
      return {
        RequestId: requestId(),
        TotalCount: store.data.zones.length,
        Zones: store.data.zones.map((z) => ({
          ZoneId: z.ZoneId,
          ZoneName: z.ZoneName,
          ActiveStatus: 'active',
          Status: 'finished',
          Paused: false,
        })),
      };
    }

    if (action === 'DescribeOriginGroup') {
      let groups = zone.OriginGroups;
      const filters = Array.isArray(payload.Filters) ? (payload.Filters as Array<Record<string, unknown>>) : [];
      for (const filter of filters) {
        if (filter?.Name === 'origin-group-id') {
          const values = Array.isArray(filter.Values) ? (filter.Values as unknown[]).map(String) : [];
          groups = groups.filter((g) => values.includes(g.GroupId));
        }
      }
      const offset = Math.max(asNumber(payload.Offset, 0), 0);
      const limit = Math.max(asNumber(payload.Limit, 20), 1);
      const page = groups.slice(offset, offset + limit);
      return {
        RequestId: requestId(),
        TotalCount: groups.length,
        OriginGroups: page.map(cloneGroup),
      };
    }

    if (action === 'ModifyOriginGroup') {
      const groupId = String(payload.GroupId ?? '');
      const target = zone.OriginGroups.find((g) => g.GroupId === groupId);
      if (!target) throw new Error(`虚拟源站组不存在: ${groupId}`);
      const records = payload.Records;
      if (!Array.isArray(records) || records.length === 0) {
        throw new Error('ModifyOriginGroup 至少需要一条源站记录');
      }
      const now = new Date().toISOString();
      target.Records = (records as Array<Record<string, unknown>>).map((record, index) => ({
        RecordId: typeof record.RecordId === 'string' && record.RecordId ? record.RecordId : `ogr-${groupId}-${index}-${randomUUID().slice(0, 8)}`,
        Record: String(record.Record ?? ''),
        Type: String(record.Type ?? 'IP_DOMAIN'),
        Weight: typeof record.Weight === 'number' ? record.Weight : 100,
        Private: record.Private === true,
        PrivateParameters: record.PrivateParameters ?? [],
        Proto: 'HTTP',
        Port: 0,
        Area: [],
      }));
      target.UpdateTime = now;
      store.save();
      return { RequestId: requestId() };
    }

    throw new Error(`虚拟提供商未实现的动作: ${action}`);
  };
}
