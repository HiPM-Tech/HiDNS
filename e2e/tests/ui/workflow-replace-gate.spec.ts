import { test, expect } from '@playwright/test';

/**
 * 前端展示验证 + 生产流程验证（审核要求）。
 *
 * 1. 展示：勾上「确认整组替换」后，DSL 预览里的 collapse 必须是真布尔 true；
 *    只做界面勾选、不依赖填满所有参数，避免被控件交互干扰。
 * 2. 流程：带真布尔保存后手动运行，不能再被 collapse 闸门拒绝。
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('locale', 'zh-CN'));
});

test.setTimeout(90_000);

test('勾选确认后 DSL 里是真布尔', async ({ page }) => {
  await page.goto('/dash/workflows');
  await page.getByText('新建工作流').click();
  await page.locator('.workflow-action-row .t-select').first().click();
  await page.locator('.t-popup .t-select-option', { hasText: '更新源站组源站' }).first().click();
  await page.waitForTimeout(500);

  const collapseParam = page.locator('.workflow-param').filter({ hasText: '确认整组替换' }).first();
  await expect(collapseParam).toHaveCount(1);
  await collapseParam.locator('.t-switch').click();
  await page.waitForTimeout(300);

  await page.getByRole('button', { name: /DSL/ }).first().click();
  await page.waitForTimeout(500);
  const dsl = await page.locator('.workflow-dsl-preview').innerText();
  console.log('DSL_SNIPPET=' + JSON.stringify(dsl.replace(/\s+/g, ' ').slice(0, 400)));
  // DSL 的形状是 { kind: 'literal', value: <值> }，直接断言**类型**比匹配字符串可靠
  const parsed = JSON.parse(dsl) as { actions: Array<{ args: Record<string, { value: unknown }> }> };
  const collapse = parsed.actions[0].args.collapse;
  expect(collapse.value).toBe(true);
  expect(typeof collapse.value).toBe('boolean');
});

test('带真布尔保存后运行不再被 collapse 闸门拒绝', async ({ page }) => {
  const name = `replace-${Date.now()}`;
  const created = await page.request.post('/api/workflows', {
    data: {
      name,
      enabled: true,
      triggerType: 'record.changed',
      triggerConfig: { recordTypes: ['A'] },
      actions: [
        {
          kind: 'call',
          action: 'ext.tencenteo.originGroup.replace',
          args: {
            accountId: { kind: 'literal', value: 1 },
            scopeId: { kind: 'literal', value: 'zone-x' },
            groupId: { kind: 'literal', value: 'og-x' },
            target: { kind: 'literal', value: '1.2.3.4' },
            diffDigest: { kind: 'literal', value: 'digest-x' },
            collapse: { kind: 'literal', value: true },
          },
        },
      ],
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const id = (await created.json()).data.id as number;
  try {
    const run = await page.request.post(`/api/workflows/${id}/run`, {
      data: { domainId: 1, domainName: 'test-example.com', record: { name: 'www', type: 'A', value: '9.9.9.9' } },
    });
    const body = (await run.json()).data as { status: string; error?: string };
    console.log('RUN_RESULT=' + JSON.stringify(body));
    expect(body.error ?? '').not.toContain('collapse');
  } finally {
    await page.request.delete(`/api/workflows/${id}`);
  }
});
