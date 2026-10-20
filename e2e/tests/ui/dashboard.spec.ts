import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 仪表盘 UI E2E。
 *
 * 登录态来自 globalSetup 生成的 storageState，这里不再重复登录。
 */

const AUTH_OK = fs.existsSync(path.join(__dirname, '..', '..', '.auth', 'ok'));

test.describe('Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!AUTH_OK, '全局登录失败（账号不可用或被限流），请用 E2E_USERNAME/E2E_PASSWORD 指定账号');
    await page.goto('/dash', { waitUntil: 'networkidle' });
    test.skip(page.url().includes('/login'), '会话未生效，已跳回登录页');
  });

  test('should land on the dashboard', async ({ page }) => {
    expect(page.url()).toContain('/dash');
    await expect(page.locator('body')).toContainText(/Dashboard|仪表盘/i);
  });

  test('should render the navigation entries', async ({ page }) => {
    const body = page.locator('body');
    await expect(body).toContainText(/Domains|域名/i);
    await expect(body).toContainText(/DNS Accounts|账号/i);
  });

  test('should navigate to the domains page', async ({ page }) => {
    await page.goto('/domains', { waitUntil: 'networkidle' });
    expect(page.url()).not.toContain('/login');
    await expect(page.locator('body')).toContainText(/Domain|域名/i);
  });
});
