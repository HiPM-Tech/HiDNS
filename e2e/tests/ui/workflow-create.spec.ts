import { test, expect } from '@playwright/test';

/**
 * 完整用户旅程：在真实浏览器里建一条工作流并保存，
 * 验证 UI → API → 列表渲染 这一整条链路（此前各层都是分开测的）。
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('locale', 'zh-CN'));
});

test('新建工作流并保存后，列表显示可读的动作链路', async ({ page }) => {
  const name = `e2e-ui-${Date.now()}`;
  await page.goto('/dash/workflows');
  await page.getByText('新建工作流').click();

  // 名称
  await page.locator('.t-form__item', { hasText: '名称' }).first().locator('input').first().fill(name);

  // 触发器：record.changed
  // 注意必须限定在下拉浮层里取选项——列表表格的「触发器」列也有同名文本，直接 getByText 会点错地方。
  await page.locator('.t-form__item', { hasText: '触发器' }).first().locator('.t-select').click();
  await page.locator('.t-popup').getByText('解析记录变更').last().click();

  // 动作：列出域名（同样限定在浮层内）
  await page.locator('.workflow-action-row .t-select').first().click();
  await page.locator('.t-popup').getByText('列出域名').last().click();

  // 把结果存进变量
  await page.locator('.workflow-param', { hasText: '保存结果到变量' }).locator('input').fill('domains');

  // 「保存」也会命中 DSL 区块里的「查看将要保存的 DSL」，限定在对话框内的按钮
  await page.locator('.t-dialog').getByRole('button', { name: '保存', exact: true }).click();

  // 列表里应出现这条工作流，并且动作列是可读名称而不是机器标识符
  await expect(page.getByText(name)).toBeVisible();
  const row = page.locator('tr', { hasText: name });
  await expect(row.getByText('列出域名')).toBeVisible();
  await expect(row.getByText('dns.domain.list')).toHaveCount(0);

  // 清理
  const cleanup = await page.request.get('/api/workflows');
  const items = (await cleanup.json()).data.items as Array<{ id: number; name: string }>;
  const created = items.find((item) => item.name === name);
  if (created) await page.request.delete(`/api/workflows/${created.id}`);
});
