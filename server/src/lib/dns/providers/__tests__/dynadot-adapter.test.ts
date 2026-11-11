import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ dynadotRequest: vi.fn() }));

vi.mock('../dynadot/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../dynadot/auth')>();
  return { ...actual, dynadotRequest: mocks.dynadotRequest };
});

import { buildSignature, buildStringToSign, resolveDynadotConfig } from '../dynadot/auth';
import { DynadotAdapter } from '../dynadot/adapter';

/**
 * 文档 §X-Signature 给出的构造规则：
 *   stringToSign = apiKey + "\n" + fullPathAndQuery + "\n" + (xRequestId 或空) + "\n" + (请求体 或空)
 *   X-Signature  = Base64(HMAC-SHA256(secret, stringToSign))
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

  it('相同输入稳定，改动请求体会变', () => {
    const a = buildSignature('k', 's', '/restful/v2/domains', '{"a":1}', 'r');
    const b = buildSignature('k', 's', '/restful/v2/domains', '{"a":1}', 'r');
    const c = buildSignature('k', 's', '/restful/v2/domains', '{"a":2}', 'r');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('配置兼容历史写法并把字符串布尔归一', () => {
    expect(resolveDynadotConfig({ apiKey: 'a', apiSecret: 'b' })).toMatchObject({ apiKey: 'a', apiSecret: 'b' });
    expect(resolveDynadotConfig({ apikey: 'a', apisecret: 'b' })).toMatchObject({ apiKey: 'a', apiSecret: 'b' });
    expect(resolveDynadotConfig({ useProxy: 'false' }).useProxy).toBe(false);
    expect(resolveDynadotConfig({ useProxy: 'true' }).useProxy).toBe(true);
  });
});

describe('Dynadot 适配器解析', () => {
  beforeEach(() => mocks.dynadotRequest.mockReset());

  function makeAdapter() {
    return new DynadotAdapter({ apiKey: 'k', apiSecret: 's', domain: 'example.com' }) as any;
  }

  it('域名列表兼容 { domains: [...] } 与数组两种形态', async () => {
    const adapter = makeAdapter();
    mocks.dynadotRequest.mockResolvedValueOnce({ domains: [{ domain: 'example.com' }, { domain: 'acme.net' }] });
    const page = await adapter.getDomainList();
    expect(page.list.map((item: any) => item.Domain)).toEqual(['example.com', 'acme.net']);

    mocks.dynadotRequest.mockResolvedValueOnce([{ domain: 'a.com' }]);
    const page2 = await adapter.getDomainList();
    expect(page2.list.map((item: any) => item.Domain)).toEqual(['a.com']);
  });

  it('DNS 记录映射为统一结构，RecordId 为 type|name|value|mx', async () => {
    const adapter = makeAdapter();
    mocks.dynadotRequest.mockResolvedValueOnce({
      records: [{ type: 'MX', name: '@', value: 'mail.example.com', priority: 10, ttl: 3600 }],
    });
    const page = await adapter.getDomainRecords();
    expect(page.list).toHaveLength(1);
    expect(page.list[0]).toMatchObject({
      RecordId: 'MX|@|mail.example.com|10',
      Type: 'MX',
      Value: 'mail.example.com',
      MX: 10,
      TTL: 3600,
    });
  });

  it('添加记录走 POST，body 为单条记录（官方不支持批量）', async () => {
    const adapter = makeAdapter();
    mocks.dynadotRequest.mockResolvedValueOnce({});
    const id = await adapter.addDomainRecord('www', 'A', '1.1.1.1', undefined, 600, 1);
    expect(id).toBe('A|www|1.1.1.1|1');
    const [config, method, path, options] = mocks.dynadotRequest.mock.calls[0];
    expect(config.apiKey).toBe('k');
    expect(method).toBe('POST');
    expect(path).toBe('/domains/example.com/dns');
    expect(options.body).toMatchObject({ name: 'www', type: 'A', value: '1.1.1.1', ttl: 600 });
  });

  it('删除记录走 DELETE 并携带定位信息', async () => {
    const adapter = makeAdapter();
    mocks.dynadotRequest.mockResolvedValueOnce({});
    const ok = await adapter.deleteDomainRecord('A|www|1.1.1.1|0');
    expect(ok).toBe(true);
    const [, method, path, options] = mocks.dynadotRequest.mock.calls[0];
    expect(method).toBe('DELETE');
    expect(path).toBe('/domains/example.com/dns');
    expect(options.body).toMatchObject({ name: 'www', type: 'A', value: '1.1.1.1' });
  });

  it('接口报错时设置 error 并返回失败', async () => {
    const adapter = makeAdapter();
    mocks.dynadotRequest.mockRejectedValueOnce(new Error('Dynadot 请求失败（HTTP 401）：unauthorized'));
    const ok = await adapter.deleteDomainRecord('A|www|1.1.1.1|0');
    expect(ok).toBe(false);
    expect(adapter.error).toContain('401');
  });
});
