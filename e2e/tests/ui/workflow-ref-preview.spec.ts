import { test, expect } from '@playwright/test';

/**
 * 设计 §10：`(...)` 预览必须渲染真实值，而不是只显示字段名。
 * 编辑已有工作流时用最近一次运行事件里的值。
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('locale', 'zh-CN'));
});

test.setTimeout(90_000);

test('引用参数显示最近一次事件里的真实值', async ({ page }) => {
  const name = `e2e-refval-${Date.now()}`;
  const created = await page.request.post('/api/workflows', {
    data: {
      name,
      enabled: true,
      triggerType: 'record.changed',
      triggerConfig: { recordTypes: ['A'] },
      actions: [
        {
          kind: 'call',
          action: 'dns.record.update',
          args: {
            domain: { kind: 'literal', value: 'test-example.com' },
            recordId: { kind: 'literal', value: '1' },
            value: { kind: 'ref', path: 'event.record.value' },
          },
        },
      ],
    },
  });
  expect(created.ok()).toBeTruthy();
  const id = (await created.json()).data.id as number;

  try {
    // 跑一次，产生带 trigger_event 的运行记录
    await page.request.post(`/api/workflows/${id}/run`, {
      data: { domainId: 1, domainName: 'test-example.com', record: { name: 'www', type: 'A', value: '9.9.9.9' } },
    });

    await page.goto('/dash/workflows');
    const row = page.locator('tr', { hasText: name });
    await row.getByText('编辑').click();

    // 记录值参数是 ref(event.record.value)，应显示为「记录值 · 9.9.9.9」
    const valueParam = page.locator('.workflow-param', { hasText: '记录值' });
    await expect(valueParam.getByText(/9\.9\.9\.9/)).toBeVisible();
  } finally {
    await page.request.delete(`/api/workflows/${id}`);
  }
});
