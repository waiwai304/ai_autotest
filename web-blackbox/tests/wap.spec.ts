import { expect, test } from '../src/fixtures';
import { sites } from '../src/config';
import { wapEntry, wapRoute, wapSiteBase } from './helpers/site';

/**
 * WAP 移动站专用用例（/wap#/ uni-app 架构）
 * 仅在移动端 project 运行；深链路由可直接访问。
 */

/** 打开 WAP 深链并等待渲染完成（uni-app 异步渲染需要稳定窗口） */
async function openWap(page: import('@playwright/test').Page, route: string, baseURL: string) {
  await page.goto(`${baseURL}${wapEntry}${route}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(2500);
}

for (const site of sites) {
  // 桌面 project 不重复跑 WAP 用例
  test.skip(({ browserName }) => browserName !== 'webkit', 'WAP 用例仅在移动端(WebKit)运行');

  test.describe(`${site.name} - WAP 移动站`, () => {
    test.use({ baseURL: wapSiteBase });

    test('WAP 首页可以打开并渲染核心内容', async ({ page }) => {
      await openWap(page, '/', wapSiteBase);

      await expect(
        page.getByText('Paste a link or enter a product name').first(),
        '首页搜索引导文案缺失',
      ).toBeVisible();
      await expect(page.locator('input[type="search"]').first(), '搜索框缺失').toBeVisible();
      // 核心入口标签
      for (const label of ['Shipping', 'Transfer', 'Guide']) {
        await expect(page.getByText(label, { exact: true }).first(), `导航入口「${label}」缺失`).toBeVisible();
      }
    });

    test('WAP 首页展示商品区块', async ({ page }) => {
      await openWap(page, '/', wapSiteBase);

      const body = await page.locator('body').innerText();
      expect(
        body.includes('FLASH SALE') || body.includes('Hot Picks') || body.includes('Shopping Feed'),
        '首页未发现任何商品区块（FLASH SALE / Hot Picks / Shopping Feed 均缺失）',
      ).toBeTruthy();
    });

    test('WAP 登录页字段完整', async ({ page }) => {
      await openWap(page, wapRoute('login'), wapSiteBase);

      await expect(page.getByText('Enter your email').first(), '邮箱输入缺失').toBeVisible();
      await expect(page.getByText('Enter your password').first(), '密码输入缺失').toBeVisible();
      await expect(page.getByText('Forgot password?').first(), '忘记密码链接缺失').toBeVisible();
      await expect(page.getByText('Sign in', { exact: true }).first(), '登录按钮缺失').toBeVisible();
      await expect(page.getByText('Go Register').first(), '注册入口缺失').toBeVisible();
    });

    test('WAP 登录页空表单不能提交', async ({ page }) => {
      await openWap(page, wapRoute('login'), wapSiteBase);

      await page.getByText('Sign in', { exact: true }).first().click();
      await page.waitForTimeout(2000);
      expect(page.url(), '空表单提交后离开了登录页').toContain(wapRoute('login'));
    });

    test('WAP 注册页字段完整', async ({ page }) => {
      await openWap(page, wapRoute('register'), wapSiteBase);

      for (const label of ['Email *', 'Password *', 'Confirm Password *']) {
        await expect(page.getByText(label, { exact: true }).first(), `注册字段「${label}」缺失`).toBeVisible();
      }
      await expect(page.getByText('User Agreement').first(), '用户协议缺失').toBeVisible();
      await expect(page.getByText('Privacy Policy').first(), '隐私政策缺失').toBeVisible();
    });

    test('WAP 估算页结构完整且单位一致', async ({ page }) => {
      await openWap(page, wapRoute('estimate'), wapSiteBase);

      const body = await page.locator('body').innerText();
      expect(body.includes('Shipping Estimate'), '估算页标题缺失').toBeTruthy();
      expect(body.includes('Weight (g)'), '重量字段（g 单位）缺失').toBeTruthy();
      // 单位一致性：标题为 Weight (g)，不允许同时出现 Weight (kg) 混用
      expect(body.includes('Weight (kg)'), '重量单位混用：同时出现 g 与 kg').toBeFalsy();
      // 5 个数字输入（重量/体积/长/宽/高）
      const numberInputs = await page.locator('input[type="number"]').count();
      expect(numberInputs, '估算表单数字输入框不足（应为重量+体积+长宽高共5个）').toBeGreaterThanOrEqual(5);
    });

    test('WAP 未登录访问受保护页面安全跳转登录', async ({ page }) => {
      await openWap(page, wapRoute('shipforme'), wapSiteBase);

      expect(page.url(), '未登录访问受保护页面未跳转登录').toContain(wapRoute('login'));
      await expect(page.getByText('Enter your email').first(), '跳转后登录表单未渲染').toBeVisible();
    });

    test('WAP 购物车空状态展示', async ({ page }) => {
      await openWap(page, wapRoute('cart'), wapSiteBase);

      await expect(
        page.getByText(/shopping cart is currently empty/i).first(),
        '空购物车提示缺失',
      ).toBeVisible();
      // 底部标签栏
      for (const tab of ['Home', 'Cart', 'Order', 'Mine']) {
        await expect(page.getByText(tab, { exact: true }).first(), `底部标签「${tab}」缺失`).toBeVisible();
      }
    });

    test('WAP 帮助文章内容加载', async ({ page }) => {
      await openWap(page, wapRoute('helpInfo'), wapSiteBase);

      await expect(
        page.getByText(/Beginner/i).first(),
        '帮助文章标题未加载',
      ).toBeVisible();
      const body = await page.locator('body').innerText();
      expect(body.trim().length, '帮助文章内容为空').toBeGreaterThan(200);
    });
  });
}
