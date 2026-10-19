import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * 虚拟 DNS 提供商的持久化状态。
 *
 * 目标：不交出任何真实解析凭证，也能完整演练工作流。
 * 因此这里保存的是"一个 DNS 提供商应有的全部状态"：
 * 站点、解析记录、以及绑定在站点上的源站组。
 *
 * 源站组刻意以**腾讯云 EdgeOne 的原始响应形态**存储，
 * 这样 `OriginGroupClient` 的映射代码可以原样复用 ——
 * 虚拟环境验的必须是真实代码路径，否则这个提供商没有测试价值。
 */

export interface VirtualDnsRecord {
  RecordId: string;
  Name: string;
  Type: string;
  Value: string;
  TTL: number;
  Line: string;
  MX: number;
  Status: number;
  Weight?: number;
  Remark?: string;
}

/** EdgeOne 源站组原始形态（字段名与真实 API 对齐） */
export interface VirtualOriginGroup {
  GroupId: string;
  OriginGroupId: string;
  Name: string;
  OriginGroupName: string;
  Type: 'GENERAL' | 'HTTP';
  HostHeader: string;
  OriginType: string;
  ConfigurationType: string;
  ZoneId: string;
  ZoneName: string;
  Records: Array<Record<string, unknown>>;
  References: Array<{
    InstanceId: string;
    InstanceName: string;
    InstanceType: string;
    ZoneId: string;
    ZoneName: string;
  }>;
  CreateTime?: string;
  UpdateTime?: string;
}

export interface VirtualZone {
  ZoneId: string;
  ZoneName: string;
  Records: VirtualDnsRecord[];
  OriginGroups: VirtualOriginGroup[];
}

export interface VirtualState {
  version: 1;
  tenant: string;
  zones: VirtualZone[];
}

export interface VirtualStoreOptions {
  /** 状态文件路径；memory 模式下忽略 */
  filePath?: string;
  /** 是否落盘；false 时状态只存在于进程内 */
  persistent?: boolean;
  /** 首次创建时的种子数据 */
  seed?: 'demo' | 'empty';
}

const DEMO_ZONE = 'example.test';
const V4 = '203.0.113.10';
const V6 = '2001:db8::10';

/**
 * 演示种子刻意构造出目标场景：
 * - 同一个域名被两个源站组引用（一个域名变动多个源站组）
 * - 其中一个组同时持有 IPv4 与 IPv6 源站（A/AAAA 同时更新）
 * - 另一个组混有域名型源站，用来验证"只同步地址、不改拓扑"
 */
function buildDemoState(tenant: string): VirtualState {
  const zoneId = 'virtual-zone-1';
  const now = new Date().toISOString();
  const ref = (instanceId: string, name: string) => ({
    InstanceId: instanceId,
    InstanceName: name,
    InstanceType: 'acceleration-domain',
    ZoneId: zoneId,
    ZoneName: DEMO_ZONE,
  });
  return {
    version: 1,
    tenant,
    zones: [
      {
        ZoneId: zoneId,
        ZoneName: DEMO_ZONE,
        Records: [
          { RecordId: 'vr-a', Name: '@', Type: 'A', Value: V4, TTL: 60, Line: 'default', MX: 0, Status: 1 },
          { RecordId: 'vr-aaaa', Name: '@', Type: 'AAAA', Value: V6, TTL: 60, Line: 'default', MX: 0, Status: 1 },
          { RecordId: 'vr-www', Name: 'www', Type: 'A', Value: V4, TTL: 60, Line: 'default', MX: 0, Status: 1 },
        ],
        OriginGroups: [
          {
            GroupId: 'og-demo-dual',
            OriginGroupId: 'og-demo-dual',
            Name: 'DEMO-DUAL',
            OriginGroupName: 'DEMO-DUAL',
            Type: 'HTTP',
            HostHeader: '',
            OriginType: 'self',
            ConfigurationType: 'weight',
            ZoneId: zoneId,
            ZoneName: DEMO_ZONE,
            Records: [
              { RecordId: 'ogr-dual-v4', Record: V4, Type: 'IP_DOMAIN', Weight: 100, Private: false, PrivateParameters: [], Proto: 'HTTP', Port: 0, Area: [] },
              { RecordId: 'ogr-dual-v6', Record: V6, Type: 'IP_DOMAIN', Weight: 100, Private: false, PrivateParameters: [], Proto: 'HTTP', Port: 0, Area: [] },
            ],
            References: [ref('vd-1', DEMO_ZONE), ref('vd-2', 'www.' + DEMO_ZONE)],
            CreateTime: now,
            UpdateTime: now,
          },
          {
            GroupId: 'og-demo-v4only',
            OriginGroupId: 'og-demo-v4only',
            Name: 'DEMO-V4ONLY',
            OriginGroupName: 'DEMO-V4ONLY',
            Type: 'HTTP',
            HostHeader: '',
            OriginType: 'self',
            ConfigurationType: 'weight',
            ZoneId: zoneId,
            ZoneName: DEMO_ZONE,
            Records: [
              { RecordId: 'ogr-v4only-v4', Record: V4, Type: 'IP_DOMAIN', Weight: 100, Private: false, PrivateParameters: [], Proto: 'HTTP', Port: 0, Area: [] },
            ],
            References: [ref('vd-3', DEMO_ZONE)],
            CreateTime: now,
            UpdateTime: now,
          },
          {
            GroupId: 'og-demo-mixed',
            OriginGroupId: 'og-demo-mixed',
            Name: 'DEMO-MIXED',
            OriginGroupName: 'DEMO-MIXED',
            Type: 'GENERAL',
            HostHeader: '',
            OriginType: 'self',
            ConfigurationType: 'weight',
            ZoneId: zoneId,
            ZoneName: DEMO_ZONE,
            Records: [
              { RecordId: 'ogr-mixed-v4', Record: V4, Type: 'IP_DOMAIN', Weight: 50, Private: false, PrivateParameters: [], Proto: 'HTTP', Port: 0, Area: [] },
              { RecordId: 'ogr-mixed-domain', Record: 'origin.' + DEMO_ZONE, Type: 'IP_DOMAIN', Weight: 50, Private: false, PrivateParameters: [], Proto: 'HTTP', Port: 0, Area: [] },
            ],
            References: [],
            CreateTime: now,
            UpdateTime: now,
          },
        ],
      },
    ],
  };
}

function emptyState(tenant: string): VirtualState {
  return { version: 1, tenant, zones: [] };
}

/** 进程内缓存：适配器每次调用都会新建，必须共用同一份状态 */
const cache = new Map<string, VirtualState>();

export function resolveDefaultStateDir(): string {
  return process.env.HIDNS_VIRTUAL_STATE_DIR
    ? resolve(process.env.HIDNS_VIRTUAL_STATE_DIR)
    : resolve(process.cwd(), 'data', 'virtual');
}

export class VirtualStore {
  private readonly state: VirtualState;
  private readonly filePath: string | null;
  private dirty = false;

  constructor(tenant: string, options: VirtualStoreOptions = {}) {
    const persistent = options.persistent !== false;
    const filePath = persistent
      ? resolve(options.filePath ?? resolve(resolveDefaultStateDir(), `${tenant}.json`))
      : null;
    const key = filePath ?? `memory:${tenant}:${options.seed ?? 'demo'}`;

    const cached = cache.get(key);
    if (cached) {
      this.state = cached;
      this.filePath = filePath;
      return;
    }

    let state: VirtualState | null = null;
    if (filePath && existsSync(filePath)) {
      try {
        const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as VirtualState;
        if (parsed && parsed.version === 1 && Array.isArray(parsed.zones)) state = parsed;
      } catch {
        state = null; // 损坏状态按空库重建，不阻塞使用
      }
    }
    if (!state) {
      state = (options.seed ?? 'demo') === 'demo' ? buildDemoState(tenant) : emptyState(tenant);
      cache.set(key, state);
      this.state = state;
      this.filePath = filePath;
      this.dirty = true;
      this.flush();
      return;
    }
    cache.set(key, state);
    this.state = state;
    this.filePath = filePath;
  }

  static resetMemoryCache(): void {
    cache.clear();
  }

  get data(): VirtualState {
    return this.state;
  }

  zone(zoneIdOrName: string): VirtualZone | null {
    const key = String(zoneIdOrName ?? '');
    if (!key) return null;
    return this.state.zones.find((z) => z.ZoneId === key || z.ZoneName === key) ?? null;
  }

  zoneByName(name: string): VirtualZone | null {
    const key = String(name ?? '').trim().toLowerCase();
    if (!key) return null;
    return this.state.zones.find((z) => z.ZoneName.toLowerCase() === key) ?? null;
  }

  addZone(name: string): VirtualZone {
    const existing = this.zoneByName(name);
    if (existing) return existing;
    const zone: VirtualZone = {
      ZoneId: 'virtual-zone-' + (this.state.zones.length + 1),
      ZoneName: String(name).trim(),
      Records: [],
      OriginGroups: [],
    };
    this.state.zones.push(zone);
    this.save();
    return zone;
  }

  group(zoneId: string, groupId: string): VirtualOriginGroup | null {
    const zone = this.zone(zoneId);
    if (!zone) return null;
    return zone.OriginGroups.find((g) => g.GroupId === groupId) ?? null;
  }

  save(): void {
    this.dirty = true;
    this.flush();
  }

  private flush(): void {
    if (!this.dirty || !this.filePath) {
      this.dirty = false;
      return;
    }
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
    renameSync(tmp, this.filePath);
    this.dirty = false;
  }
}
