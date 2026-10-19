/**
 * 工作流页面的真实浏览器验证（Playwright + Chromium）。
 *
 * 前置条件：
 *   1. 已构建前端产物：pnpm --filter dnsmgr-client run build
 *   2. 服务端已启动并托管 dist：pnpm --filter dnsmgr-server run dev（或 ts-node src/app.ts）
 *   3. 系统已初始化，且存在可登录的管理员账号
 *   4. 已安装 Chromium：npx playwright install chromium（以及 npx playwright install-deps chromium）
 *
 * 运行：
 *   BASE=http://127.0.0.1:3000 ADMIN_USER=admin ADMIN_PASS=*** node client/e2e/workflows-browser.mjs
 *   可用 CHROME 指定 Chromium 可执行文件路径。
 *
 * 说明：本脚本只做「能点、能提交、有反馈」的验证；
 *       「对人类友好」属主观判断，仍需人工看一眼。
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:3992';
const USER = process.env.ADMIN_USER || 'admin';
const PASS = process.env.ADMIN_PASS || '';
const CHROME = process.env.CHROME || undefined;

if (!PASS) {
  console.error('缺少 ADMIN_PASS');
  process.exit(2);
}

let pass = 0;
let fail = 0;
const chk = (name, ok) => {
  if (ok) { console.log('  PASS ' + name); pass += 1; } else { console.log('  FAIL ' + name); fail += 1; }
};

const login = await fetch(BASE + '/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: USER, password: PASS }),
});
const token = /token=([^;]+)/.exec((login.headers.getSetCookie?.() ?? []).join('; '));
if (!token) {
  console.error('登录失败，无法取得 token');
  process.exit(2);
}

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
await context.addInitScript(() => { try { localStorage.setItem('locale', 'zh-CN'); } catch { /* ignore */ } });
await context.addCookies([{ name: 'token', value: token[1], domain: '127.0.0.1', path: '/' }]);
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(BASE + '/dash/workflows', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
const initial = await page.textContent('body');
chk('页面加载且为中文', initial.includes('自动化工作流'));
chk('出站白名单条目可见', initial.includes('api.ipify.org'));

await page.getByText('预览 (…)').first().click();
await page.waitForTimeout(800);
const preview = await page.textContent('body');
chk('预览弹窗有内容（等待提示或事件数据）', preview.includes('尚无真实事件') || preview.includes('oldValue'));
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

await page.getByText('运行记录').first().click();
await page.waitForTimeout(800);
const runs = await page.textContent('body');
chk('运行记录弹窗打开', runs.includes('追踪 ID') || runs.includes('状态'));
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

await page.getByText('编辑').first().click();
await page.waitForTimeout(800);
chk('编辑弹窗出现（含执行条件）', (await page.textContent('body')).includes('执行条件'));
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

const before = await page.locator('tbody tr').count();
await page.getByText('删除').first().click();
await page.waitForTimeout(600);
chk('删除出现二次确认', (await page.textContent('body')).includes('确定删除该工作流'));
const confirms = page.getByText('删除');
await confirms.nth((await confirms.count()) - 1).click();
await page.waitForTimeout(1500);
chk('确认后行数减少', (await page.locator('tbody tr').count()) === before - 1);

chk('无页面运行时错误', errors.length === 0);
if (errors.length) console.log('  错误: ' + errors.slice(0, 3).join(' | '));

console.log('\nRESULT pass=' + pass + ' fail=' + fail);
await browser.close();
process.exit(fail > 0 ? 1 : 0);