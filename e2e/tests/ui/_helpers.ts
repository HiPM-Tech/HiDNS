import { Page, expect } from '@playwright/test';

/**
 * 登录流程助手。
 *
 * 当前登录页是两步式（先用户名、后密码），输入框只有 className 与 placeholder，
 * 没有 name / data-testid；提交用回车（主按钮会被 .lc-branding 覆盖层拦截点击）。
 */
export const CREDENTIALS = {
  username: process.env.E2E_USERNAME || 'admin',
  password: process.env.E2E_PASSWORD || 'admin',
};

export const USER_SELECTOR = 'input[placeholder*="username"]';
export const PASSWORD_SELECTOR = 'input[type="password"]:visible';

export async function gotoLogin(page: Page): Promise<void> {
  await page.goto('/login', { waitUntil: 'networkidle' });
  await expect(page.locator(USER_SELECTOR)).toBeVisible();
}

export async function submitUsername(page: Page, username: string): Promise<void> {
  const input = page.locator(USER_SELECTOR);
  await input.fill(username);
  await input.press('Enter');
}

export async function submitPassword(page: Page, password: string): Promise<void> {
  const input = page.locator(PASSWORD_SELECTOR);
  await input.fill(password);
  await input.press('Enter');
}

/** 登录并等待离开 /login；返回是否成功 */
export async function login(page: Page, username = CREDENTIALS.username, password = CREDENTIALS.password): Promise<boolean> {
  await gotoLogin(page);
  await submitUsername(page, username);
  await submitPassword(page, password);
  await page.waitForTimeout(2500);
  return !page.url().includes('/login');
}
