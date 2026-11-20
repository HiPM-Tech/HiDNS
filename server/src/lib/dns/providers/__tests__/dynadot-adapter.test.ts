import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ dynadotRequest: vi.fn(), setDns2: vi.fn() }));

vi.mock('../dynadot/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../dynadot/auth')>();
  return { ...actual, dynadotRequest: mocks.dynadotRequest };
});

import { buildSignature, buildStringToSign, resolveDynadotConfig } from '../dynadot/auth';
import { DynadotAdapter, buildSetDns2Params } from '../dynadot/adapter';

/**
 * 结构均取自真实 API 响应（已用真实凭据实测）：
 *   GET /restful/v2/domains                → { code:200, data:{ domain_info_list:[{ domain_name }] } }
 *   GET /restful/v2/domains/{d}/records    → { code:200, data:{ glue_info:{ glue_type:'DNS', dns_sub_list:[{sub_host,record_type,record_value1}], ttl:'300' } } }
 *   POST/DELETE /restful/v2/domains/{d}/records → body { dns_sub_list:[...] }（v2 没有 PUT）
 * 所有请求都必须带 X-Signature（只带 Bearer 会被拒）。
 */
describe('Dynadot 请求签名', () => {
  it('按文档示例拼接 stringToSign', () => {
    expect(buildStringToSign('your_api_key', '/restful/v2/some/endpoint?param=value', '{"key":"value"}', 'unique-request-id'))
      .toBe('your_api_key\n/restful/v2/some/endpoint?param=value\nunique-request-id\n{"key":"value"}');
  });

  it('没有请求体时用空字符串占位', () => {
    expect(buildStringToSign('k', '/restful/v2/domains')).toBe('k\n/restful/v2/domains\n\n');
  });

  it('签名是 Base64（不是 hex）', () => {
    const sig = buildSignature('k', 'secret', '/restful/v2/domains', '', 'rid');
    expect(sig).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(Buffer.from(sig, 'base64').length).toBe(32);
  });

  it('配置兼容历史写法并把字符串布尔归一', () => {
    expect(resolveDynadotConfig({ apiKey: 'a', apiSecret: 'b' })).toMatchObject({ apiKey: 'a', apiSecret: 'b' });
    expect(resolveDynadotConfig({ apikey: 'a', apisecret: 'b' })).toMatchObject({ apiKey: 'a', apiSecret: 'b' });
    expect(resolveDynadotConfig({ useProxy: 'false' }).useProxy).toBe(false);
  });
});

describe('Dynadot 适配器解析（真实响应结构）', () => {
  beforeEach(() => mocks.dynadotRequest.mockReset());

  function makeAdapter(domain?: string) {
    return new DynadotAdapter({ apiKey: 'k', apiSecret: 's', ...(domain ? { domain } : {}) }) as any;
  }

  it('域名列表取 data.domain_info_list[].domain_name', async () => {
    const adapter = makeAdapter();
    mocks.dynadotRequest.mockResolvedValueOnce({
      code: 200,
      data: { domain_info_list: [{ domain_name: 'xin.onl' }, { domain_name: 'ddos.name' }] },
    });
    const page = await adapter.getDomainList();
    expect(page.list.map((item: any) => item.Domain)).toEqual(['xin.onl', 'ddos.name']);
  });

  it('记录取 data.glue_info.dns_sub_list，TTL 在 glue_info 层级', async () => {
    const adapter = makeAdapter('ddos.name');
    mocks.dynadotRequest.mockResolvedValueOnce({
      code: 200,
      data: {
        glue_info: {
          glue_type: 'DNS',
          dns_sub_list: [{ sub_host: 'a', record_type: 'a', record_value1: '87.239.135.130' }],
          ttl: '300',
        },
      },
    });
    const page = await adapter.getDomainRecords();
    expect(page.list).toHaveLength(1);
    expect(page.list[0]).toMatchObject({ Name: 'a', Type: 'A', Value: '87.239.135.130', TTL: 300 });
    expect(page.list[0].RecordId).toBe('A|a|87.239.135.130|0');
  });

  it('域名未托管在 Dynadot DNS 上时返回空列表（glue_type 不是 DNS）', async () => {
    const adapter = makeAdapter('xin.onl');
    mocks.dynadotRequest.mockResolvedValueOnce({
      code: 200,
      data: { glue_info: { glue_type: 'NAME_SERVERS', nameserver_list: [] } },
    });
    const page = await adapter.getDomainRecords();
    expect(page).toEqual({ total: 0, list: [] });
  });

  it('set_dns2 参数：子记录用 subdomain*/sub_record*，顺序与输入一致', () => {
    const params = buildSetDns2Params('k', 'ddos.name', [
      { name: 'a', type: 'A', value: '1.1.1.1' },
      { name: 'www', type: 'A', value: '9.9.9.9' },
    ]);
    expect(params.get('command')).toBe('set_dns2');
    expect(params.get('domain')).toBe('ddos.name');
    expect(params.get('subdomain0')).toBe('a');
    expect(params.get('sub_record0')).toBe('1.1.1.1');
    expect(params.get('subdomain1')).toBe('www');
    expect(params.get('sub_record1')).toBe('9.9.9.9');
  });

  it('set_dns2 参数：根记录用 main_record*，MX 带优先级', () => {
    const params = buildSetDns2Params('k', 'xin.onl', [
      { name: '@', type: 'MX', value: 'mail.xin.onl', mx: 10 },
    ]);
    expect(params.get('main_record_type0')).toBe('mx');
    expect(params.get('main_record0')).toBe('mail.xin.onl');
    expect(params.get('main_recordx0')).toBe('10');
  });

  it('读失败时绝不写回（一次网络抖动不能清空整域记录）', async () => {
    const adapter = makeAdapter('ddos.name');
    adapter.setDns2Request = mocks.setDns2;
    mocks.dynadotRequest.mockRejectedValueOnce(new Error('network down'));

    const id = await adapter.addDomainRecord('www', 'A', '1.1.1.1');

    expect(id).toBeNull();
    expect(mocks.setDns2).not.toHaveBeenCalled();
    expect(adapter.error).toContain('network down');
  });

  it('结构异常时绝不写回', async () => {
    const adapter = makeAdapter('ddos.name');
    adapter.setDns2Request = mocks.setDns2;
    mocks.dynadotRequest.mockResolvedValueOnce({ code: 200, data: { glue_info: { glue_type: 'DNS' } } });

    const id = await adapter.addDomainRecord('www', 'A', '1.1.1.1');

    expect(id).toBeNull();
    expect(mocks.setDns2).not.toHaveBeenCalled();
  });

  it('120 条记录全量写回，不截断，并带回 zone TTL', async () => {
    const adapter = makeAdapter('ddos.name');
    adapter.setDns2Request = mocks.setDns2;
    const list = Array.from({ length: 120 }, (_, i) => ({ sub_host: `h${i}`, record_type: 'a', record_value1: `10.0.0.${i}` }));
    mocks.dynadotRequest.mockResolvedValueOnce({ code: 200, data: { glue_info: { glue_type: 'DNS', dns_sub_list: list, ttl: '300' } } });

    await adapter.addDomainRecord('newrec', 'A', '1.1.1.1');

    const params = mocks.setDns2.mock.calls[0][0] as URLSearchParams;
    expect(params.get('subdomain119')).toBe('h119');
    expect(params.get('subdomain120')).toBe('newrec');
    expect(params.get('ttl')).toBe('300');
  });

  it('MX 优先级：读 record_value2，写 sub_recordx', async () => {
    const adapter = makeAdapter('ddos.name');
    adapter.setDns2Request = mocks.setDns2;
    mocks.dynadotRequest.mockResolvedValue({
      code: 200,
      data: { glue_info: { glue_type: 'DNS', dns_sub_list: [
        { sub_host: 'mxprobe', record_type: 'mx', record_value1: 'mail.ddos.name', record_value2: '10' },
        { sub_host: 'a', record_type: 'a', record_value1: '1.1.1.1' },
      ], ttl: '300' } },
    });

    const page = await adapter.getDomainRecords();
    expect(page.list.find((r: any) => r.Type === 'MX')?.MX).toBe(10);

    await adapter.deleteDomainRecord('A|a|1.1.1.1|0');
    const params = mocks.setDns2.mock.calls[0][0] as URLSearchParams;
    expect(params.get('sub_recordx0')).toBe('10');
    expect(params.get('sub_record0')).toBe('mail.ddos.name');
  });

  it('接口报错时设置 error 并返回失败', async () => {
    const adapter = makeAdapter('ddos.name');
    mocks.dynadotRequest.mockRejectedValueOnce(new Error('Dynadot 请求失败（code 400）：invalid'));
    const ok = await adapter.deleteDomainRecord('A|a|1.1.1.1|0');
    expect(ok).toBe(false);
    expect(adapter.error).toBeTruthy();
  });
});