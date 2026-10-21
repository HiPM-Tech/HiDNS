import { test, expect } from '@playwright/test';

/**
 * 条件编辑器的端到端验证：在 UI 里配条件 → 保存 → 触发运行 → 运行记录按条件跳过。
 *
 * 运行通过 API 触发而不是点运行对话框：对话框交互上一轮已单独覆盖，
 * 这里要验证的是「界面配出来的条件」是否真的进了 DSL 并被引擎执行。
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('locale', 'zh-CN'));
});

test.setTimeout(90_000);

test('在界面上配的取反条件会真的让运行被跳过', async ({ page }) => {
  const name = `e2e-cond-${Date.now()}`;
  await page.goto('/dash/workflows');
  await page.getByText('新建工作流').click();

  await page.locator('.t-form__item', { hasText: '名称' }).first().locator('input').first().fill(name);

  // 触发器：解析记录变更
  await page.locator('.t-form__item', { hasText: '触发器' }).first().locator('.t-select').click();
  await page.locator('.t-popup').getByText('解析记录变更').last().click();

  // 动作：列出域名
  await page.locator('.workflow-action-row .t-select').first().click();
  await page.locator('.t-popup').getByText('列出域名').last().click();

  // 条件：记录类型 == A，并取反 → 运行事件是 A 时应被跳过
  const conditionItem = page.locator('.t-form__item', { hasText: '执行条件' });
  await conditionItem.getByRole('switch').click();
  await conditionItem.locator('.t-select').first().click();
  await page.locator('.t-popup').getByText('记录类型').last().click();
  await conditionItem.locator('.workflow-condition-row input').last().fill('A');
  const negateLabel = conditionItem.getByText('取反（条件不满足时才触发）');
  await negateLabel.scrollIntoViewIfNeeded();
  await negateLabel.click();

  await page.locator('.t-dialog').getByRole('button', { name: '保存', exact: true }).click();
  const row = page.locator('tr', { hasText: name });
  await expect(row).toBeVisible();

  try {
    // 先确认界面配出来的条件确实进了 DSL（取反 = 外层 logic/not）
    const list = await page.request.get('/api/workflows');
    const items = (await list.json()).data.items as Array<{ id: number; name: string; condition?: { kind: string; op?: string } }>;
    const created = items.find((item) => item.name === name)!;
    expect(created.condition?.kind).toBe('logic');
    expect(created.condition?.op).toBe('not');

    // 用事件类型 A 触发：内层条件为真 → 取反为假 → 运行应被跳过
    const run = await page.request.post(`/api/workflows/${created.id}/run`, {
      // 合成事件要同时给域名名：只给 domainId 时服务端拼不出 event.domain.name
      data: { domainId: 1, domainName: 'test-example.com', record: { name: 'www', type: 'A', value: '1.2.3.4', oldValue: '5.6.7.8' } },
    });
    const runBody = await run.text();
    expect(run.ok(), `run 接口返回: ${runBody}`).toBeTruthy();
    // 运行记录里应显示成可读的「已跳过」（运行记录弹窗本身在另一条用例里覆盖）
    expect(JSON.parse(runBody).data.status).toBe('skipped');
  } finally {
    const list = await page.request.get('/api/workflows');
    const items = (await list.json()).data.items as Array<{ id: number; name: string }>;
    const created = items.find((item) => item.name === name);
    if (created) await page.request.delete(`/api/workflows/${created.id}`);
  }
});
