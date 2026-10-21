import { test, expect } from '@playwright/test';

/**
 * 记录类型必须至少选一个：全不选时工作流能保存却永远不触发，界面上看不出异常。
 * 这里验证界面上直接拦住。
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('locale', 'zh-CN'));
});

test.setTimeout(60_000);

test('一个记录类型都不选时不允许保存', async ({ page }) => {
  await page.goto('/dash/workflows');
  await page.getByText('新建工作流').click();
  await page.locator('.t-form__item', { hasText: '名称' }).first().locator('input').first().fill('e2e-rt-guard');
  await page.locator('.t-form__item', { hasText: '触发器' }).first().locator('.t-select').click();
  await page.locator('.t-popup').getByText('解析记录变更').last().click();

  // 默认 A / AAAA 都选中，全部取消
  const recordTypes = page.locator('.t-form__item', { hasText: '记录类型' });
  // 点 label 文本不一定触发 TDesign 的勾选，直接操作 checkbox
  const boxes = recordTypes.locator('input[type="checkbox"]');
  await boxes.nth(0).uncheck({ force: true });
  await boxes.nth(1).uncheck({ force: true });
  await expect(boxes.nth(0)).not.toBeChecked();

  await page.locator('.t-dialog').getByRole('button', { name: '保存', exact: true }).click();
  await page.waitForTimeout(1500);

  // 提示是瞬时 toast，断言持久行为更稳：对话框没关 + 接口里没创建出这条工作流
  await expect(page.locator('.t-dialog')).toBeVisible();
  const list = await page.request.get('/api/workflows');
  const items = (await list.json()).data.items as Array<{ name: string }>;
  expect(items.some((item) => item.name === 'e2e-rt-guard')).toBe(false);
});
