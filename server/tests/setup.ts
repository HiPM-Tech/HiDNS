/**
 * 测试环境设置
 * 配置MOCK和测试环境
 */

import { vi } from 'vitest';

// MOCK环境变量
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-key-for-testing-only';
process.env.MOCK_DNS_PROVIDERS = 'true';
process.env.MOCK_EMAIL_SERVICE = 'true';
process.env.MOCK_EXTERNAL_API = 'true';
process.env.DB_TYPE = 'sqlite';
process.env.DB_PATH = './data/test.db';
// 虚拟提供商是开发工具，默认不注册；测试需要它，故在此显式打开。
// 生产环境即使设了这个变量也会被 NODE_ENV 硬关闭。
process.env.HIDNS_ENABLE_VIRTUAL_PROVIDER = '1';

// MOCK DNS提供商
vi.mock('../src/lib/dns/providers/cloudflare', () => ({
  CloudflareAdapter: vi.fn().mockImplementation(() => ({
    check: vi.fn().mockResolvedValue(true),
    getDomainList: vi.fn().mockResolvedValue({ total: 2, list: [
      { Domain: 'test1.com', ThirdId: 'zone1', RecordCount: 5 },
      { Domain: 'test2.com', ThirdId: 'zone2', RecordCount: 3 }
    ]}),
    getDomainRecords: vi.fn().mockResolvedValue({ total: 5, list: [
      { RecordId: 'rec1', Name: '@', Type: 'A', Value: '192.168.1.1', TTL: 600 },
      { RecordId: 'rec2', Name: 'www', Type: 'A', Value: '192.168.1.2', TTL: 600 }
    ]}),
    addDomainRecord: vi.fn().mockResolvedValue('new-record-id'),
    updateDomainRecord: vi.fn().mockResolvedValue(true),
    deleteDomainRecord: vi.fn().mockResolvedValue(true),
  }))
}));

// MOCK邮件服务
vi.mock('../src/lib/mailer', () => ({
  sendMail: vi.fn().mockResolvedValue({ messageId: 'test-message-id' }),
  sendAlert: vi.fn().mockResolvedValue(true),
}));

// MOCK外部API调用
vi.mock('../src/lib/proxy-http', () => ({
  fetchWithFallback: vi.fn().mockImplementation(async (url, options, useProxy, providerName) => {
    // 返回模拟的Response对象
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Map(),
      json: vi.fn().mockResolvedValue({ success: true, data: {} }),
      text: vi.fn().mockResolvedValue('{"success": true}'),
    } as unknown as Response;
  }),
  getProxyConfig: vi.fn().mockResolvedValue(null),
}));

// 全局测试超时
vi.setConfig({ testTimeout: 30000 });

// 测试生命周期钩子
beforeAll(async () => {
  console.log('Setting up test environment...');
});

afterAll(async () => {
  console.log('Cleaning up test environment...');
});

beforeEach(async () => {
  // 每个测试前的清理
});

afterEach(async () => {
  // 每个测试后的清理
  vi.clearAllMocks();
});
