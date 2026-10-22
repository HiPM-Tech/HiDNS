import { test, expect } from '@playwright/test';

/**
 * 双栈 DDNS 的语义陷阱：整组覆盖只保留一条源站，A 与 AAAA 各自触发会把对方覆盖掉。
 * 这里验证编辑器在「记录类型含 A+AAAA」且「目标源站引用 event.record.value」时给出提示。
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('locale', 'zh-CN'));
});

test.setTimeout(90_000);

test('双栈记录类型 + 覆盖源站组 → 提示互相覆盖；改成单栈后消失', async ({ page }) => {
  await page.goto('/dash/workflows');
  await page.getByText('新建工作流').click();
  // 默认记录类型是 A + AAAA
  await page.locator('.workflow-action-row .t-select').first().click();
  await page.locator('.t-popup .t-select-option', { hasText: '更新源站组源站' }).first().click();
  await page.waitForTimeout(600);

  // 目标源站改为「使用事件字段 → 记录值」
  const target = page.locator('.workflow-param').filter({ hasText: '目标源站' }).first();
  await target.locator('.t-select').last().click();
  await page.waitForTimeout(600);
  await page.locator('.t-popup:visible .t-select-option', { hasText: '记录值' }).first().click();
  await page.waitForTimeout(800);

  const warn = page.getByText('双栈 DDNS 会互相覆盖');
  await expect(warn).toBeVisible();
  console.log('WARN_WITH_DUAL=true');
  await page.screenshot({ path: '/tmp/teo/dual-warn.png', fullPage: true });

  // 取消 A（第一个复选框），记录类型只剩 AAAA → 提示应消失
  await page.locator('.t-form__item', { hasText: '记录类型' }).locator('.t-checkbox').first().click();
  await page.waitForTimeout(600);
  // 用 DSL 预览确认记录类型真的变了（复选框状态读不准）
  await page.getByRole('button', { name: /DSL/ }).first().click();
  await page.waitForTimeout(400);
  const dsl = await page.locator('.workflow-dsl-preview').innerText();
  const types = (JSON.parse(dsl) as { triggerConfig: { recordTypes: string[] } }).triggerConfig.recordTypes;
  console.log('RECORD_TYPES=' + JSON.stringify(types));
  expect(types).toHaveLength(1);
  await expect(warn).toHaveCount(0);
});

