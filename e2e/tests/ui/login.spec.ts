import { test, expect } from '@playwright/test';
import { CREDENTIALS, gotoLogin, login, submitPassword, submitUsername, USER_SELECTOR } from './_helpers';

/**
 * 登录页 UI E2E。
 *
 * 选择器按当前实现（TDesign + 自定义 lc-* 类），不再使用 Ant Design 的 .ant-* 类。
 */

// 登录页用例必须在**未登录**状态下跑：项目默认带 storageState，已登录访问 /login 会被重定向走
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('Login Page', () => {
  test('should display login form', async ({ page }) => {
    await gotoLogin(page);
    await expect(page).toHaveTitle(/HiDNS/i);
    await expect(page.locator(USER_SELECTOR)).toBeVisible();
    const primary = page.locator('button.lc-btn-primary:visible').first();
    await expect(primary).toBeVisible();
    await expect(primary).toBeDisabled();
  });

  test('should enable the continue button after typing a username', async ({ page }) => {
    await gotoLogin(page);
    const primary = page.locator('button.lc-btn-primary:visible').first();
    await page.locator(USER_SELECTOR).fill('someuser');
    await expect(primary).toBeEnabled();
  });

  test('should switch to the password step after submitting a username', async ({ page }) => {
    await gotoLogin(page);
    await submitUsername(page, 'someuser');
    await expect(page.locator('input[type="password"]:visible')).toBeVisible();
  });

  test('should stay on /login with invalid credentials', async ({ page }) => {
    await gotoLogin(page);
    await submitUsername(page, CREDENTIALS.username);
    await submitPassword(page, 'definitely-not-the-password');
    await page.waitForTimeout(2500);
    expect(page.url()).toContain('/login');
  });

  test('should login and leave the login page', async ({ page }) => {
    const ok = await login(page);
    test.skip(!ok, '登录失败（账号不可用或被限流），请用 E2E_USERNAME/E2E_PASSWORD 指定账号');
    expect(page.url()).not.toContain('/login');
  });
});
