import { test, expect } from '@playwright/test';

/**
 * 手动运行 → 运行记录 的完整链路。
 * 运行详情那几列（状态标签、耗时、触发事件摘要）此前只在单测里验证过，
 * 这里跑真实浏览器确认它们真的渲染。
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('locale', 'zh-CN'));
});

test('手动运行后，运行记录显示可读的状态、耗时与触发事件', async ({ page }) => {
  const name = `e2e-run-${Date.now()}`;
  const created = await page.request.post('/api/workflows', {
    data: {
      name,
      enabled: true,
      triggerType: 'record.changed',
      triggerConfig: { recordTypes: ['A'] },
      actions: [{ kind: 'call', action: 'dns.domain.list', args: {} }],
    },
  });
  expect(created.ok()).toBeTruthy();
  const id = (await created.json()).data.id as number;

  try {
    await page.goto('/dash/workflows');
    const row = page.locator('tr', { hasText: name });
    await expect(row).toBeVisible();

    // 手动运行
    await row.getByText('手动运行').click();
    // 页面上同时挂着多个 Dialog（隐藏的也在 DOM 里），必须取可见的那个
    const dialog = page.locator('.t-dialog:visible');
    await dialog.locator('.t-select').first().click();
    const domainOption = page.locator('.t-popup').getByText(/test-example\.com/).last();
    // 缺 id 时这里会渲染成 (#undefined)，属于真实缺陷，顺带断言住
    await expect(domainOption).not.toContainText('#undefined');
    await domainOption.click();

    // 记录字段是必填的，不填会卡在校验上
    await dialog.locator('.t-form__item', { hasText: '主机记录' }).locator('input').fill('www');
    await dialog.locator('.t-form__item', { hasText: '记录类型' }).locator('.t-select').click();
    await page.locator('.t-popup').getByText('A', { exact: true }).last().click();
    await dialog.locator('.t-form__item', { hasText: '新记录值' }).locator('input').fill('1.2.3.4');
    await dialog.getByRole('button', { name: '手动运行' }).click();

    // 打开运行记录
    await row.getByText('运行记录').click();
    const runsDialog = page.locator('.t-dialog:visible');
    // 状态是可读标签而不是 success/failed 原文
    await expect(runsDialog.getByText('成功').first()).toBeVisible();
    await expect(runsDialog.getByText('耗时')).toBeVisible();
    await expect(runsDialog.getByText('触发事件')).toBeVisible();
    // 触发事件被解析成摘要，不是原始 JSON
    await expect(runsDialog.getByText(/解析记录变更/).first()).toBeVisible();
    await expect(runsDialog.getByText('success')).toHaveCount(0);
  } finally {
    await page.request.delete(`/api/workflows/${id}`);
  }
});
