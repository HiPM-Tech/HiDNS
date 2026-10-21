import { test, expect } from '@playwright/test';

/**
 * 设计 §788：服务端会拒绝内网/回环源站，前端应提前提示。
 * 这里验证选到源站组动作、在 target 里填内网地址时，界面上立刻出现警告。
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('locale', 'zh-CN'));
});

test.setTimeout(60_000);

test('target 填内网地址时立即提示会被服务端拒绝', async ({ page }) => {
  await page.goto('/dash/workflows');
  await page.getByText('新建工作流').click();
  await page.locator('.t-form__item', { hasText: '触发器' }).first().locator('.t-select').click();
  await page.locator('.t-popup').getByText('解析记录变更').last().click();

  await page.locator('.workflow-action-row .t-select').first().click();
  await page.locator('.t-popup').getByText('预览源站组收敛').last().click();

  const targetParam = page.locator('.workflow-param', { hasText: '目标源站' });
  const input = targetParam.locator('input').first();

  // 公网地址：不应提示
  await input.fill('8.8.8.8');
  await expect(page.getByText('这是内网/回环/本地地址')).toHaveCount(0);

  // 内网地址：应立刻提示
  await input.fill('10.0.0.5');
  await expect(page.getByText('这是内网/回环/本地地址')).toBeVisible();

  // 回退成公网后提示消失
  await input.fill('1.1.1.1');
  await expect(page.getByText('这是内网/回环/本地地址')).toHaveCount(0);
});
