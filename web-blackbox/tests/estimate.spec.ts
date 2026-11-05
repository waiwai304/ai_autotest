import { expect, test } from '../src/fixtures';
import { sites } from '../src/config';

// 桌面端用例仅在 Chromium(桌面 project) 运行；移动端由 tests/wap.spec.ts 覆盖
test.skip(({ browserName }) => browserName !== 'chromium', '桌面端用例不在移动端(WebKit)运行');
import { openReady } from '../src/pages/onebuy.page';

for (const site of sites.filter((item) => item.features.estimate)) {
  test.describe(`${site.name} - 运费估算`, () => {
    test.use({ baseURL: site.baseURL });

    test('估算页面结构完整', async ({ page }) => {
      await openReady(page, '/estimate', site.defaultLocale);

      await expect(
        page.getByRole('heading', { name: 'Shipping Estimate' }),
      ).toBeVisible();
      await expect(page.getByText('Destination *', { exact: true })).toBeVisible();
      await expect(page.getByText('Product type *', { exact: true })).toBeVisible();
      await expect(page.getByText('Weight *', { exact: true }).first()).toBeVisible();
      // 未填写必填项时，计算按钮应处于禁用状态
      await expect(page.getByRole('button', { name: /calculate/i }).first()).toBeDisabled();
    });

    test('重量字段与单位选择器一致', async ({ page }) => {
      await openReady(page, '/estimate', site.defaultLocale);
      const body = await page.locator('body').innerText();

      // 重量标题标注 kg 时，单位选择器不能是 g（历史缺陷回归检测）
      const titleSaysKg = /Weight\s*\(kg\)/i.test(body);
      const unitShowsGram = /Weight\s*\*[\s\S]{0,100}\bg\b/.test(body);
      expect(
        titleSaysKg && unitShowsGram,
        '重量标题标注 kg，但单位选择器为 g，单位不一致',
      ).toBeFalsy();
      // 当前页面应为 Weight * + g 单位选择器（自身一致）
      expect(/Weight\s*\*/.test(body), '未找到重量字段').toBeTruthy();
    });
  });
}
