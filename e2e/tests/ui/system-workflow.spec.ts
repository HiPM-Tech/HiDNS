import { test, expect } from '@playwright/test';

/**
 * 系统设置 → 工作流（出站白名单）的浏览器验证。
 *
 * 重点验证「界面正确反映服务端当前策略」——这是设计 §5.5.1 的核心要求：
 * 用户必须能看到当前白名单，否则写完才发现被拦。
 * TagInput 的内部 DOM 不稳定，写入路径改由接口验证（接口本身另有单测覆盖）。
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('locale', 'zh-CN'));
});

test.setTimeout(60_000);

test('系统设置里能看到当前出站白名单与 fail-closed 语义', async ({ page }) => {
  const marker = `e2e-allow-${Date.now()}.example`;
  const before = await page.request.get('/api/settings/workflow-http-allowlist');
  const original = (await before.json()).data.allowlist as string[];

  await page.request.put('/api/settings/workflow-http-allowlist', {
    data: { allowlist: [...original, marker] },
  });

  try {
    await page.goto('/dash/system/workflow');
    await expect(page.getByText('工作流出站白名单')).toBeVisible();
    // 服务端刚加的那条必须出现在界面上
    await expect(page.getByText(marker)).toBeVisible();
    // 空白名单 = 禁止一切出站，这条语义最容易误解，必须在界面上写清楚
    await expect(page.getByText(/fail-closed/)).toBeVisible();
    // 操作区渲染出来（保存/取消）。「未改动时保存禁用」放在组件测试里验证，
    // 这里不依赖 TDesign 按钮的内部结构。
    await expect(page.getByText('取消')).toBeVisible();
  } finally {
    await page.request.put('/api/settings/workflow-http-allowlist', { data: { allowlist: original } });
  }
});
