import { test, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';

/**
 * Authentication API E2E
 *
 * 注意：服务端用 **Cookie** 鉴权（登录时 setAuthCookie），响应体里没有 token 字段。
 * 因此这里用同一个 APIRequestContext 承载会话，而不是往 Authorization 头里塞 token。
 * 账号密码由 E2E_USERNAME / E2E_PASSWORD 提供，默认取初始化时创建的测试账号。
 */

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const USERNAME = process.env.E2E_USERNAME || 'admin';
const PASSWORD = process.env.E2E_PASSWORD || 'admin';

test.describe('Authentication API', () => {
  test('should reject login with invalid credentials', async ({ request }) => {
    const response = await request.post(`${BASE_URL}/api/auth/login`, {
      data: { username: 'invalid_user', password: 'wrong_password' },
    });
    expect(response.status()).toBe(401);
    const body = await response.json();
    expect(body.code).toBe(401);
    expect(String(body.msg)).toContain('Invalid username/email or password');
  });

  test('should reject login without credentials', async ({ request }) => {
    const response = await request.post(`${BASE_URL}/api/auth/login`, { data: {} });
    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.code).toBe(400);
    expect(String(body.msg)).toContain('required');
  });

  test('should reject request without authorization', async ({ request }) => {
    const response = await request.get(`${BASE_URL}/api/auth/me`);
    expect(response.status()).toBe(401);
    const body = await response.json();
    expect(body.code).toBe(-1);
    expect(String(body.msg)).toContain('Unauthorized');
  });

  test('should reject request with invalid token', async ({ request }) => {
    const response = await request.get(`${BASE_URL}/api/auth/me`, {
      headers: { Authorization: 'Bearer invalid_token' },
    });
    expect(response.status()).toBe(401);
    const body = await response.json();
    expect(body.code).toBe(-1);
    expect(String(body.msg)).toMatch(/Invalid or expired token/i);
  });

  test('should get current user with a cookie session', async () => {
    const api: APIRequestContext = await playwrightRequest.newContext({ baseURL: BASE_URL });
    try {
      const login = await api.post('/api/auth/login', { data: { username: USERNAME, password: PASSWORD } });
      test.skip(login.status() !== 200, `login failed (${login.status()})，请用 E2E_USERNAME/E2E_PASSWORD 指定可用账号`);

      const me = await api.get('/api/auth/me');
      expect(me.status()).toBe(200);
      const meBody = await me.json();
      expect(meBody.code).toBe(0);
      expect(meBody.data.username).toBe(USERNAME);
    } finally {
      await api.dispose();
    }
  });

  test('should logout and invalidate the session', async () => {
    const api: APIRequestContext = await playwrightRequest.newContext({ baseURL: BASE_URL });
    try {
      const login = await api.post('/api/auth/login', { data: { username: USERNAME, password: PASSWORD } });
      test.skip(login.status() !== 200, 'login failed');

      const out = await api.post('/api/auth/logout');
      expect([200, 204]).toContain(out.status());

      const me = await api.get('/api/auth/me');
      expect(me.status()).toBe(401);
    } finally {
      await api.dispose();
    }
  });
});
