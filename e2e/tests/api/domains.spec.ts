import { test, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';

/**
 * Domains API E2E
 *
 * 鉴权方式：Cookie 会话（服务端 setAuthCookie），响应体不含 token。
 * 读路径默认执行；写路径需要可用的真实提供商账号，用 E2E_MUTATION=1 显式开启。
 */

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const USERNAME = process.env.E2E_USERNAME || 'admin';
const PASSWORD = process.env.E2E_PASSWORD || 'admin';
const MUTATION = process.env.E2E_MUTATION === '1';

test.describe('Domains API', () => {
  let api: APIRequestContext;
  let loggedIn = false;
  let firstDomainId: number | undefined;

  test.beforeAll(async () => {
    api = await playwrightRequest.newContext({ baseURL: BASE_URL });
    const login = await api.post('/api/auth/login', { data: { username: USERNAME, password: PASSWORD } });
    loggedIn = login.status() === 200;
  });

  test.afterAll(async () => {
    await api?.dispose();
  });

  test('should require authentication', async ({ request }) => {
    const response = await request.get(`${BASE_URL}/api/domains`);
    expect(response.status()).toBe(401);
  });

  test('should list domains', async () => {
    test.skip(!loggedIn, `login failed，请用 E2E_USERNAME/E2E_PASSWORD 指定可用账号`);

    const response = await api.get('/api/domains');
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.code).toBe(0);
    expect(Array.isArray(body.data.list ?? body.data)).toBe(true);

    const list = body.data.list ?? body.data;
    if (list.length > 0) firstDomainId = list[0].id;
  });

  test('should get domain by id', async () => {
    test.skip(!loggedIn, 'login failed');
    test.skip(firstDomainId === undefined, '没有可用的域名可查（先跑 should list domains 或先 seed）');

    const response = await api.get(`/api/domains/${firstDomainId}`);
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.code).toBe(0);
    expect(body.data.id ?? body.data.domain?.id).toBe(firstDomainId);
  });

  test('should reject unknown domain id', async () => {
    test.skip(!loggedIn, 'login failed');

    const response = await api.get('/api/domains/999999');
    // 本项目约定：业务错误用 HTTP 200 + body.code 表达（sendError 默认 statusCode=200），
    // 所以这里断言的是 code 而非 HTTP 状态码。
    const body = await response.json().catch(() => ({}));
    expect(body.code).not.toBe(0);
    expect(body.data ?? null).toBeNull();
  });

  // 写路径：需要真实的提供商账号（虚拟/真实都能满足），默认不开，避免污染环境
  test('should create a new domain', async () => {
    test.skip(!MUTATION, '需要可用的提供商账号，设置 E2E_MUTATION=1 开启');

    const response = await api.post('/api/domains', {
      data: { name: 'e2e-created.example', accountId: Number(process.env.E2E_ACCOUNT_ID || 1) },
    });
    expect([200, 201]).toContain(response.status());
  });

  test('should update domain', async () => {
    test.skip(!MUTATION, '需要可用的提供商账号，设置 E2E_MUTATION=1 开启');
    test.skip(firstDomainId === undefined, '没有可用的域名');

    const response = await api.put(`/api/domains/${firstDomainId}`, { data: { remark: 'e2e' } });
    expect(response.status()).toBe(200);
  });

  test('should delete domain', async () => {
    test.skip(!MUTATION, '需要可用的提供商账号，设置 E2E_MUTATION=1 开启');
    test.skip(firstDomainId === undefined, '没有可用的域名');

    const response = await api.delete(`/api/domains/${firstDomainId}`);
    expect([200, 204]).toContain(response.status());
  });
});
