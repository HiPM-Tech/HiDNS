import { test, expect } from '@playwright/test';

/**
 * plan → replace 链路的关键一环：前一步「保存结果到变量」后，
 * 后面步骤的「使用事件字段」下拉里必须能选到这个变量。
 * 这条链路此前只在映射层面有单测，没在浏览器里验证过。
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('locale', 'zh-CN'));
});

test.setTimeout(90_000);

test('前一步存的变量会出现在后续步骤的引用下拉里', async ({ page }) => {
  const name = `e2e-var-${Date.now()}`;
  await page.goto('/dash/workflows');
  await page.getByText('新建工作流').click();

  await page.locator('.t-form__item', { hasText: '名称' }).first().locator('input').first().fill(name);
  await page.locator('.t-form__item', { hasText: '触发器' }).first().locator('.t-select').click();
  await page.locator('.t-popup').getByText('解析记录变更').last().click();

  // 第一步：列出域名，结果存进变量 domains
  await page.locator('.workflow-action-row .t-select').first().click();
  await page.locator('.t-popup').getByText('列出域名').last().click();
  await page.locator('.workflow-param', { hasText: '保存结果到变量' }).locator('input').fill('domains');

  // 第二步：发送通知
  await page.getByText('添加动作').click();
  const secondRow = page.locator('.workflow-action-row').nth(1);
  await secondRow.locator('.t-select').first().click();
  await page.locator('.t-popup').getByText('发送通知').last().click();

  // 第二步的 message 参数：打开「使用事件字段」下拉，应能看到上一步的变量
  const messageParam = secondRow.locator('.workflow-param', { hasText: '消息内容' });
  await messageParam.locator('.t-select').first().click();
  await expect(page.locator('.t-popup').getByText('变量 domains').last()).toBeVisible();
  await page.locator('.t-popup').getByText('变量 domains').last().click();

  await page.locator('.t-dialog').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('tr', { hasText: name })).toBeVisible();

  try {
    // 落库的 DSL 应该是一条 assign 引用一条 vars.* 的 ref
    const list = await page.request.get('/api/workflows');
    const items = (await list.json()).data.items as Array<{ id: number; name: string; actions: Array<{ kind: string; key?: string; value?: { kind: string; action?: string }; args?: Record<string, { kind: string; path?: string }> }> }>;
    const created = items.find((item) => item.name === name)!;
    expect(created).toBeTruthy();
    expect(created.actions[0].kind).toBe('assign');
    expect(created.actions[0].key).toBe('domains');
    expect(created.actions[0].value?.kind).toBe('call');
    expect(created.actions[1].args?.message).toEqual({ kind: 'ref', path: 'vars.domains' });
  } finally {
    const list = await page.request.get('/api/workflows');
    const items = (await list.json()).data.items as Array<{ id: number; name: string }>;
    const created = items.find((item) => item.name === name);
    if (created) await page.request.delete(`/api/workflows/${created.id}`);
  }
});
