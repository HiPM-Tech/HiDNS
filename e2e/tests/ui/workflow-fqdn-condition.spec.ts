import { test, expect } from '@playwright/test';

/**
 * 两条用户反馈的回归：
 *  1. 条件可以直接比「解析全名」（event.record.fqdn）
 *  2. 手动运行提交的必须是域名**名称**与数字 ID，不能把 ID 塞进名称位置
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('locale', 'zh-CN'));
});

test.setTimeout(90_000);

test('条件可用解析全名匹配，手动运行传的是域名名称', async ({ page }) => {
  const name = `fqdn-${Date.now()}`;
  const created = await page.request.post('/api/workflows', {
    data: {
      name,
      enabled: true,
      triggerType: 'record.changed',
      triggerConfig: { recordTypes: ['A'] },
      condition: {
        kind: 'compare',
        op: '==',
        left: { kind: 'ref', path: 'event.record.fqdn' },
        right: { kind: 'literal', value: 'test.ddns.hinswu.top' },
      },
      actions: [{ kind: 'call', action: 'dns.domain.list', args: {} }],
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const id = (await created.json()).data.id as number;

  try {
    // 全名条件成立：record.name=test + domain.name=ddns.hinswu.top → test.ddns.hinswu.top
    const okRun = await page.request.post(`/api/workflows/${id}/run`, {
      data: { domainId: 1, domainName: 'ddns.hinswu.top', record: { name: 'test', type: 'A', value: '1.2.3.4' } },
    });
    expect((await okRun.json()).data.status).toBe('success');

    // 全名不匹配 → 跳过（证明比较的是拼好的全名，不是别的东西）
    const missRun = await page.request.post(`/api/workflows/${id}/run`, {
      data: { domainId: 1, domainName: 'ddns.hinswu.top', record: { name: 'other', type: 'A', value: '1.2.3.4' } },
    });
    expect((await missRun.json()).data.status).toBe('skipped');

    // 手动运行对话框：抓请求体，确认 domainName 是名称、domainId 是数字
    await page.goto('/dash/workflows');
    const row = page.locator('tr', { hasText: name });
    await row.getByText('手动运行').click();
    const dialog = page.locator('.t-dialog:visible');
    await dialog.locator('.t-select').first().click();
    await page.locator('.t-popup:visible .t-select-option').first().click();
    await page.waitForTimeout(500);

    const [request] = await Promise.all([
      page.waitForRequest((req) => req.url().includes(`/api/workflows/${id}/run`) && req.method() === 'POST'),
      dialog.getByRole('button', { name: '运行' }).click(),
    ]);
    const payload = request.postDataJSON() as { domainId: unknown; domainName: unknown };
    console.log('RUN_PAYLOAD=' + JSON.stringify(payload));
    expect(typeof payload.domainId).toBe('number');
    expect(payload.domainId).toBeGreaterThan(0);
    // 关键：domainName 必须是域名名称，不能是 ID
    expect(String(payload.domainName)).toContain('.');
    expect(Number.isNaN(Number(payload.domainName))).toBe(true);
  } finally {
    await page.request.delete(`/api/workflows/${id}`);
  }
});
