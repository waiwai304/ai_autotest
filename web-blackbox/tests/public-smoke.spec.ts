import { expect, test } from '../src/fixtures';
import { sites } from '../src/config';

// 桌面端用例仅在 Chromium(桌面 project) 运行；移动端由 tests/wap.spec.ts 覆盖
test.skip(({ browserName }) => browserName !== 'chromium', '桌面端用例不在移动端(WebKit)运行');
import { ShopPage, openReady } from '../src/pages/shop.page';

for (const site of sites) {
  test.describe(`${site.name} - 公共冒烟`, () => {
    test.use({ baseURL: site.baseURL });

    test('首页可以正常打开', async ({ page }) => {
      const app = new ShopPage(page);
      const response = await page.goto(`/${site.defaultLocale}`, {
        waitUntil: 'domcontentloaded',
      });

      expect(response, '首页没有产生主文档响应').not.toBeNull();
      expect(response!.status(), '首页 HTTP 状态异常').toBeLessThan(400);
      await openReady(page, '/', site.defaultLocale);
      await app.assertHomeReady();
    });

    test('首页包含主要导航', async ({ page }) => {
      await openReady(page, '/', site.defaultLocale);

      await expect(page.getByRole('link', { name: 'Home', exact: true }).first()).toBeVisible();
      await expect(page.getByRole('link', { name: 'Estimation', exact: true }).first()).toBeVisible();
      await expect(page.getByRole('link', { name: 'Transport', exact: true }).first()).toBeVisible();
      await expect(page.getByRole('link', { name: 'Help Center', exact: true }).first()).toBeVisible();
    });

    test('首页展示有效商品', async ({ page }) => {
      await openReady(page, '/', site.defaultLocale);

      const productLinks = page.locator(`a[href*="/detail/market"]`);
      await expect(productLinks.first()).toBeVisible({ timeout: site.productLoadTimeoutMs });
      expect(await productLinks.count(), '没有发现 供应链商品').toBeGreaterThan(0);

      const prices = await productLinks.locator('text=/\\$\\s*\\d/').allTextContents();
      expect(prices.length, '商品列表没有发现价格').toBeGreaterThan(0);
    });

    test('公开页面没有严重控制台错误', async ({ page }) => {
      const errors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
      page.on('pageerror', (error) => errors.push(error.message));

      await openReady(page, '/', site.defaultLocale, 0);

      const ignored = [
        /favicon/i,
        /third[- ]party cookie/i,
        /ERR_BLOCKED_BY_CLIENT/i,
      ];
      const serious = errors.filter(
        (message) => !ignored.some((pattern) => pattern.test(message)),
      );
      expect(serious, serious.join('\n')).toEqual([]);
    });
  });
}
