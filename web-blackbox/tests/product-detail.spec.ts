import { expect, test } from '../src/fixtures';
import { sites } from '../src/config';

// 桌面端用例仅在 Chromium(桌面 project) 运行；移动端由 tests/wap.spec.ts 覆盖
test.skip(({ browserName }) => browserName !== 'chromium', '桌面端用例不在移动端(WebKit)运行');
import { openReady } from '../src/pages/shop.page';

for (const site of sites.filter((item) => item.features.productMarket)) {
  test.describe(`${site.name} - 供应链商品详情`, () => {
    test.use({ baseURL: site.baseURL });

    test('可以解析有效的 供应链商品', async ({ page }) => {
      const encoded = encodeURIComponent(site.testData.validMarketProductUrl);
      await page.goto(`/${site.defaultLocale}/detail/market?url=${encoded}`, {
        waitUntil: 'domcontentloaded',
      });
      await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});

      // 前置诊断：若被分流到 WAP 站，直接给出明确结论而不是晦涩的超时
      if (/\/wap/i.test(page.url())) {
        throw new Error(
          `【分流说明】移动端 UA 访问商品详情被重定向到 WAP 站：${page.url()}\n` +
            'WAP 站使用独立的 hash 路由结构，桌面端商品详情断言不适用。\n' +
            '这不是商品解析功能故障；如需验证移动端商品页，请为 /wap 站点编写专用用例。',
        );
      }

      const productContent = page.locator('main');
      await expect(productContent, '商品详情主区域为空（可能解析失败或页面结构变化）').not.toBeEmpty({
        timeout: site.productLoadTimeoutMs,
      });

      await expect(
        page.getByText(/loading|加载中/i),
        '商品详情长时间停留在加载状态',
      ).toBeHidden({ timeout: site.productLoadTimeoutMs });

      const body = await productContent.innerText();
      expect(body.trim().length, '商品详情内容为空').toBeGreaterThan(20);
    });
  });
}
