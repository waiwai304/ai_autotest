import { expect, test } from '../src/fixtures';
import { sites } from '../src/config';

// 桌面端用例仅在 Chromium(桌面 project) 运行；移动端由 tests/wap.spec.ts 覆盖
test.skip(({ browserName }) => browserName !== 'chromium', '桌面端用例不在移动端(WebKit)运行');
import { openReady } from '../src/pages/onebuy.page';

for (const site of sites) {
  test.describe(`${site.name} - 登录注册`, () => {
    test.use({ baseURL: site.baseURL });

    test('登录页字段完整', async ({ page }) => {
      await openReady(page, '/login', site.defaultLocale);

      await expect(page.getByRole('heading', { name: 'Login' })).toBeVisible();
      await expect(page.getByPlaceholder('Enter your email')).toBeVisible();
      await expect(page.getByPlaceholder('Enter your password')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Login' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Forgot password' })).toBeVisible();
    });

    test('未登录访问购物车不会进入用户数据页', async ({ page }) => {
      await openReady(page, '/dashboard/cart', site.defaultLocale);
      await expect(page).toHaveURL(/login|auth|dashboard\/cart/);

      const hasLogin = await page
        .getByRole('button', { name: /login/i })
        .isVisible()
        .catch(() => false);
      const hasEmptyCart = await page
        .getByText(/empty cart|购物车为空/i)
        .isVisible()
        .catch(() => false);

      expect(hasLogin || hasEmptyCart, '未登录购物车没有安全登录提示或空状态').toBeTruthy();
    });

    test('空表单不能提交登录', async ({ page }) => {
      await openReady(page, '/login', site.defaultLocale);
      await page.getByRole('button', { name: 'Login' }).click();
      await expect(page).toHaveURL(new RegExp(`/${site.defaultLocale}/login`));
    });
  });
}
