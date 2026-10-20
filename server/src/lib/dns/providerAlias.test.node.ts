import test from 'node:test';
import assert from 'node:assert/strict';
import { getProviderAliases, normalizeProviderType, providerAliasMap } from './providerAlias';

test('normalizes common lego aliases to internal provider types', () => {
  assert.equal(normalizeProviderType('alidns'), 'aliyun');
  assert.equal(normalizeProviderType('aliesa'), 'aliyunesa');
  assert.equal(normalizeProviderType('baiducloud'), 'baidu');
  assert.equal(normalizeProviderType('huaweicloud'), 'huawei');
  assert.equal(normalizeProviderType('volcengine'), 'huoshan');
  assert.equal(normalizeProviderType('westcn'), 'west');
  assert.equal(normalizeProviderType('pdns'), 'powerdns');
  assert.equal(normalizeProviderType('edgeone'), 'tencenteo');
  assert.equal(normalizeProviderType('tencentcloud'), 'dnspod');
});

test('normalization is case-insensitive and trims spaces', () => {
  assert.equal(normalizeProviderType('  ALIDNS  '), 'aliyun');
  assert.equal(normalizeProviderType('  ALIESA  '), 'aliyunesa');
  assert.equal(normalizeProviderType('  TeNcEnTcLoUd  '), 'dnspod');
  assert.equal(normalizeProviderType('  VOLCENGINE  '), 'huoshan');
});

test('returns normalized original type when alias is unknown', () => {
  assert.equal(normalizeProviderType('Cloudflare'), 'cloudflare');
  assert.equal(normalizeProviderType('custom-provider'), 'custom-provider');
});

test('exposes reverse aliases for import compatibility', () => {
  assert.deepEqual(getProviderAliases('aliyun').sort(), ['alidns', 'aliyun']);
  assert.deepEqual(getProviderAliases('aliyunesa').sort(), ['aliesa']);
  assert.deepEqual(getProviderAliases('baidu').sort(), ['baiducloud']);
  assert.deepEqual(getProviderAliases('huawei').sort(), ['huaweicloud']);
  assert.deepEqual(getProviderAliases('huoshan').sort(), ['huoshan', 'volcengine']);
  assert.deepEqual(getProviderAliases('west').sort(), ['westcn']);
  assert.deepEqual(getProviderAliases('powerdns').sort(), ['pdns', 'powerdns']);
  assert.deepEqual(getProviderAliases('tencenteo').sort(), ['edgeone', 'tencenteo']);
  assert.deepEqual(getProviderAliases('dnspod').sort(), ['dnspod', 'tencentcloud']);
});

test('alias map keeps two-way data', () => {
  assert.equal(providerAliasMap.legoToInternal.alidns, 'aliyun');
  assert.ok(providerAliasMap.internalToAliases.aliyun.includes('alidns'));
});
