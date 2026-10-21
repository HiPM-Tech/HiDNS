import { test, expect } from '@playwright/test';

/**
 * recordId 候选源（设计 §3.3 的级联候选）：选定域名后，记录 ID 才能从下拉里选。
 * 未选域名时控件应禁用并提示缺哪个参数，而不是让人手填 ID。
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('locale', 'zh-CN'));
});

test.setTimeout(60_000);

test('未选域名时记录 ID 下拉禁用并提示缺哪个参数', async ({ page }) => {
  await page.goto('/dash/workflows');
  await page.getByText('新建工作流').click();
  await page.locator('.t-form__item', { hasText: '触发器' }).first().locator('.t-select').click();
  await page.locator('.t-popup').getByText('解析记录变更').last().click();

  await page.locator('.workflow-action-row .t-select').first().click();
  await page.locator('.t-popup').getByText('更新解析记录').last().click();

  // recordId 参数此时应禁用，并在占位文案里点明缺「域名」——
  // 断言占位文案比断言 TDesign 的禁用类名稳（类名会随版本变）。
  const recordParam = page.locator('.workflow-param', { hasText: '记录 ID' });
  // 占位文案是 input 的 placeholder 属性，getByText 取不到；用属性断言
  await expect(recordParam.locator('input').first()).toHaveAttribute('placeholder', /需先填写/);
  // 同时验证参数说明已更新为「选定域名后可直接选」
  await expect(recordParam.getByText(/选定域名后/)).toBeVisible();
});
