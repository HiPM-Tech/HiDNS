import { test, expect } from '@playwright/test';

/**
 * 设计 §1153 的前端义务：域名变动触发器与记录写动作互斥。
 * 服务端保存时会 422 拒绝，但那是「配完才知道」——这里验证界面提前拦住。
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('locale', 'zh-CN'));
});

test.setTimeout(60_000);

async function openEditorWithTrigger(page: import('@playwright/test').Page, triggerLabel: string) {
  await page.goto('/dash/workflows');
  await page.getByText('新建工作流').click();
  await page.locator('.t-form__item', { hasText: '触发器' }).first().locator('.t-select').click();
  await page.locator('.t-popup').getByText(triggerLabel).last().click();
}

test('「域名信息变更」触发器的动作列表里没有记录写动作', async ({ page }) => {
  await openEditorWithTrigger(page, '域名信息变更');
  await page.locator('.workflow-action-row .t-select').first().click();

  const popup = page.locator('.t-popup').last();
  await expect(popup.getByText('列出解析记录').last()).toBeVisible();
  await expect(popup.getByText('新增解析记录')).toHaveCount(0);
  await expect(popup.getByText('更新解析记录')).toHaveCount(0);
});

test('「解析记录变更」触发器的动作列表里有记录写动作', async ({ page }) => {
  await openEditorWithTrigger(page, '解析记录变更');
  await page.locator('.workflow-action-row .t-select').first().click();
  await expect(page.locator('.t-popup').last().getByText('新增解析记录').last()).toBeVisible();
});

test('已选记录写动作时，「域名信息变更」触发器不可选', async ({ page }) => {
  await openEditorWithTrigger(page, '解析记录变更');
  await page.locator('.workflow-action-row .t-select').first().click();
  await page.locator('.t-popup').getByText('新增解析记录').last().click();

  await page.locator('.t-form__item', { hasText: '触发器' }).first().locator('.t-select').click();
  const option = page.locator('.t-popup .t-select-option', { hasText: '域名信息变更' }).last();
  await expect(option).toHaveClass(/is-disabled|t-is-disabled/);
});
