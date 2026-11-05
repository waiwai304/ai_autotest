import { expect, test } from '../src/fixtures';
import { sites } from '../src/config';

// 桌面端用例仅在 Chromium(桌面 project) 运行；移动端由 tests/wap.spec.ts 覆盖
test.skip(({ browserName }) => browserName !== 'chromium', '桌面端用例不在移动端(WebKit)运行');
import { openReady } from '../src/pages/onebuy.page';

const publicEnglishRoutes = ['/', '/estimate', '/help', '/login', '/register'];
const knownChineseText = [
  '返回首页',
  '注册',
  '邮箱',
  '密码',
  '输入邀请码',
  '我已阅读并同意',
  '隐私政策',
  '服务条款',
  '免责声明',
  '请输入关键词',
];

for (const site of sites) {
  test.describe(`${site.name} - 国际化`, () => {
    test.use({ baseURL: site.baseURL });

    for (const route of publicEnglishRoutes) {
      test(`/en${route === '/' ? '' : route} 不应混入已知中文界面文案`, async ({ page }) => {
        await openReady(page, route, site.defaultLocale, 1000);
        const body = await page.locator('body').innerText();
        const found = knownChineseText.filter((text) => body.includes(text));
        expect(found, `发现中文界面文案：${found.join('、')}`).toEqual([]);
      });
    }
  });
}
