import { test, expect } from '@playwright/test';

/**
 * 运行详情里的逐步记录（设计 §3.6）：点「查看步骤」后能看到每一步的动作、状态、耗时与参数。
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('locale', 'zh-CN'));
});

test.setTimeout(90_000);

test('运行记录里能查看每一步的动作与耗时', async ({ page }) => {
  const name = `e2e-steps-${Date.now()}`;
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
    await page.request.post(`/api/workflows/${id}/run`, {
      data: { domainId: 1, domainName: 'test-example.com', record: { name: 'www', type: 'A', value: '1.2.3.4' } },
    });

    await page.goto('/dash/workflows');
    const row = page.locator('tr', { hasText: name });
    await row.getByText('运行记录').click();

    const runsDialog = page.locator('.t-dialog:visible');
    await runsDialog.getByRole('button', { name: '查看步骤' }).first().click();

    // 步骤里应出现可读的动作名与耗时
    await expect(runsDialog.getByText('这次运行的每一步')).toBeVisible();
    await expect(runsDialog.getByText('列出域名')).toBeVisible();
    await expect(runsDialog.getByText(/ms$/).first()).toBeVisible();
  } finally {
    await page.request.delete(`/api/workflows/${id}`);
  }
});
