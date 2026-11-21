import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// setup.ts 全局 mock 了 fetchWithFallback 且只提供 json()；这里覆盖成完全可控的版本
const proxyMock = vi.hoisted(() => ({ fetchWithFallback: vi.fn() }));
vi.mock('../internal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../internal')>();
  return { ...actual, fetchWithFallback: proxyMock.fetchWithFallback };
});

import { PowerdnsAdapter } from '../powerdns/adapter';

/**
 * #56 的回归用例：
 *   1. PATCH 成功返回 204 空体，不能报「Unexpected end of JSON input」；
 *   2. 同名同类型的第二条记录必须追加，不能覆盖已有 rrset；
 *   3. 删除单条后保留同 rrset 的其它记录；
 *   4. 新 adapter 实例（实例缓存为空）也要能写 —— 先按需拉 zone 再写。
 */
const ZONE = 'example.com';

function makeAdapter() {
  return new PowerdnsAdapter({
    serverUrl: 'http://pdns.local',
    apiKey: 'k',
    serverId: 'localhost',
    domain: ZONE,
    domainId: ZONE,
  } as never) as any;
}

interface FetchCall { url: string; method: string; body: any }

function installFetch(zones: unknown[], rrsets: unknown[]) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (input: any, init: any) => {
    const url = String(input);
    const method = String(init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });
    if (method === 'PATCH' || method === 'DELETE') return new Response(null, { status: 204 });
    // /zones（列表）返回数组；/zones/{id}（详情）返回 { rrsets }
    if (/\/zones$/.test(url)) return new Response(JSON.stringify(zones), { status: 200 });
    return new Response(JSON.stringify({ rrsets }), { status: 200 });
  });
  proxyMock.fetchWithFallback.mockImplementation(fn as never);
  return { calls, patches: () => calls.filter((call) => call.method === 'PATCH') };
}

const zoneList = [{ id: ZONE, name: `${ZONE}.` }];

describe('PowerDNS 写路径（#56）', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('PATCH 返回 204 空体不报错，且新实例会先按需拉取 zone', async () => {
    const { calls, patches } = installFetch(zoneList, [{
      name: `www.${ZONE}`, type: 'A', ttl: 600,
      records: [{ content: '1.1.1.1', disabled: false }],
    }]);

    const adapter = makeAdapter();
    const id = await adapter.addDomainRecord('www', 'A', '1.1.1.1');

    expect(adapter.error).toBeFalsy();
    expect(patches()).toHaveLength(1);
    // 写之前确实先读了一次 zone 详情（实例缓存为 null 的自愈路径）
    expect(calls.some((call) => call.method === 'GET' && call.url.endsWith(`/zones/${ZONE}`))).toBe(true);
    expect(id).not.toBeNull();
  });

  it('同名同类型的第二条 TXT 追加而不是覆盖', async () => {
    const { patches } = installFetch(zoneList, [{
      name: `_acme-challenge.${ZONE}`, type: 'TXT', ttl: 300,
      records: [{ content: '"first-value"', disabled: false }],
    }]);

    const adapter = makeAdapter();
    await adapter.addDomainRecord('_acme-challenge', 'TXT', 'second-value');

    expect(patches()).toHaveLength(1);
    expect(patches()[0].body.rrsets[0].records).toEqual([
      { content: '"first-value"', disabled: false },
      { content: '"second-value"', disabled: false },
    ]);
  });

  it('删除单条后保留同 rrset 的其它记录', async () => {
    const { patches } = installFetch(zoneList, [{
      name: `_acme-challenge.${ZONE}`, type: 'TXT', ttl: 300,
      records: [{ content: '"first-value"', disabled: false }, { content: '"second-value"', disabled: false }],
    }]);

    const adapter = makeAdapter();
    const page = await adapter.getDomainRecords();
    expect(page.total).toBe(2);

    const target = (page.list[1] as any).RecordId as string;
    const ok = await adapter.deleteDomainRecord(target);

    expect(ok).toBe(true);
    expect(
      patches().at(-1)?.body.rrsets[0].records.map((record: any) => ({ content: record.content, disabled: record.disabled })),
    ).toEqual([{ content: '"first-value"', disabled: false }]);
  });
});