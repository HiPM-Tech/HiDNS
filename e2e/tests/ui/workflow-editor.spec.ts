import { test, expect } from '@playwright/test';

/**
 * 工作流编辑器可读性回归：
 * 这些控件是人工核验后逐个补上的，用真实浏览器确认它们真的渲染出来，
 * 而不是只在被 mock 的组件测试里存在。
 */
test.beforeEach(async ({ page }) => {
  // 默认语言是英文，这里固定成中文，避免选择器随默认语言漂移
  await page.addInitScript(() => localStorage.setItem('locale', 'zh-CN'));
});

test.describe('工作流编辑器可读性', () => {
  test('条件区块暴露多条件与取反入口', async ({ page }) => {
    await page.goto('/dash/workflows');
    await expect(page.getByText('新建工作流')).toBeVisible();
    await page.getByText('新建工作流').click();

    // 打开「执行条件」开关（注意对话框里第一个 switch 是「启用」）
    const conditionItem = page.locator('.t-form__item', { hasText: '执行条件' });
    await conditionItem.getByRole('switch').click();
    await expect(page.getByText('添加条件')).toBeVisible();
    await expect(page.getByText('取反（条件不满足时才触发）')).toBeVisible();
  });

  test('每个动作步骤都能把结果存进变量', async ({ page }) => {
    await page.goto('/dash/workflows');
    await page.getByText('新建工作流').click();
    // plan → replace 这类链路依赖它：replace 需要 plan 产出的 diffDigest
    await expect(page.getByText('保存结果到变量')).toBeVisible();
  });

  test('编辑器提供 DSL 预览入口且默认收起', async ({ page }) => {
    await page.goto('/dash/workflows');
    await page.getByText('新建工作流').click();
    const show = page.getByText('查看将要保存的 DSL');
    await expect(show).toBeVisible();
    await show.click();
    await expect(page.getByText('收起 DSL')).toBeVisible();
  });

  test('列表页展示可读的动作链路而不是数量', async ({ page }) => {
    // 用例自给自足：自己造一条工作流，跑完删掉，不依赖库里已有数据
    const name = `e2e-chain-${Date.now()}`;
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
      await expect(page.getByText(name)).toBeVisible();
      // 动作列应渲染成可读名称，而不是 dns.domain.list
      await expect(page.getByText('列出域名').first()).toBeVisible();
      await expect(page.getByText('dns.domain.list')).toHaveCount(0);
    } finally {
      await page.request.delete(`/api/workflows/${id}`);
    }
  });
});
