import { expect, test } from '../src/fixtures';
import { sites } from '../src/config';
import type { Page } from '@playwright/test';
import { captureGetItem, standardSkuFlow } from './helpers/sku-standard';
import { site, wapEntry, wapRoute, wapSiteBase, offerMarket } from './helpers/site';

/**
 * WAP 登录态功能测试（串行执行）
 * 覆盖：登录、搜索、商品详情、加购、下单(到支付通道为止，不真实支付)、用户资料修改与还原
 * 账号来自 .env：TEST_TEST_ACCOUNT / TEST_TEST_PASSWORD
 */

const ACCOUNT = process.env.SITE_FRONT_ACCOUNT || process.env.TEST_TEST_ACCOUNT || '';
const PASSWORD = process.env.SITE_FRONT_PASSWORD || process.env.TEST_TEST_PASSWORD || '';
const SEARCH_KEYWORD = process.env.WAP_SEARCH_KEYWORD || site.testData.searchKeywordWap || 'phone case';
const DETAIL_IID = site.testData.numIidWapDetail || '';
// 保持原双重编码语义（站点解析兼容）
const DETAIL_HASH = DETAIL_IID
  ? `${wapRoute('itemdc')}?num_iid=${DETAIL_IID}&url=${encodeURIComponent(encodeURIComponent(offerMarket(DETAIL_IID)))}&tp=market`
  : '';
// 加购专用商品（站点方指定长期在架）：SKU 弹层每行规格自带数量步进器，MOQ 由页面提示给出
const CART_ITEM_IID = site.testData.numIidWapCart || '';
const CART_ITEM_HASH = `${wapRoute('itemdc')}?num_iid=${CART_ITEM_IID}&url=${encodeURIComponent(offerMarket(CART_ITEM_IID))}&tp=market`;

test.skip(({ browserName }) => browserName !== 'webkit', 'WAP 登录态用例仅在移动端(WebKit)运行');
test.skip(!ACCOUNT || !PASSWORD, '未配置测试账号 TEST_TEST_ACCOUNT/PASSWORD，跳过登录态测试');
test.skip(!DETAIL_IID || !CART_ITEM_IID, 'config/sites.json 缺少 testData.numIidWapDetail/numIidWapCart，跳过');

async function openWap(page: Page, route: string, baseURL: string, settleMs = 3000) {
  // 站点间歇性 TLS 重置，导航失败时退避重试
  let lastErr: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      await page.goto(`${baseURL}${wapEntry}${route}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      await page.waitForTimeout(5000 * (i + 1));
    }
  }
  if (lastErr) throw lastErr;
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(settleMs);
}

// 每个用例独立浏览器上下文，不共享登录态；需要登录态的用例须先调用此函数
async function loginWap(page: Page, baseURL: string) {
  await openWap(page, wapRoute('login'), baseURL);
  await page.locator('input[type="text"]').first().fill(ACCOUNT);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.getByText('Sign in', { exact: true }).first().click();
  await page.waitForTimeout(5000);
}

for (const site of sites) {
  test.describe.serial(`${site.name} - WAP 登录态功能`, () => {
    test.slow(); // 登录+页面稳定等待多，60s 基础超时不够，放宽 3 倍
    test.use({ baseURL: wapSiteBase });

    test('01 登录成功进入用户中心', async ({ page }) => {
      await openWap(page, wapRoute('login'), wapSiteBase);

      await page.locator('input[type="text"]').first().fill(ACCOUNT);
      await page.locator('input[type="password"]').first().fill(PASSWORD);
      await page.getByText('Sign in', { exact: true }).first().click();
      await page.waitForTimeout(6000);

      expect(page.url(), '登录后未跳转用户中心').toContain(wapRoute('userCenter'));
      await expect(
        page.getByText(ACCOUNT).first(),
        '用户中心未显示账号邮箱',
      ).toBeVisible();
      // Points 区块可能在首屏外，用页面文本验证
      const body = await page.locator('body').innerText();
      expect(body.includes('Points'), '用户中心积分区块缺失').toBeTruthy();
    });

    test('02 搜索商品返回有效结果', async ({ page }) => {
      // 复用登录态：先登录
      await openWap(page, wapRoute('login'), wapSiteBase);
      await page.locator('input[type="text"]').first().fill(ACCOUNT);
      await page.locator('input[type="password"]').first().fill(PASSWORD);
      await page.getByText('Sign in', { exact: true }).first().click();
      await page.waitForTimeout(5000);

      await openWap(page, '/', wapSiteBase, 6000);
      // 首页可能因站点间歇故障未渲染搜索框，未出现则重载一次
      let searchVisible = await page
        .locator('input[type="search"]')
        .first()
        .isVisible({ timeout: 20_000 })
        .catch(() => false);
      if (!searchVisible) {
        await openWap(page, '/', wapSiteBase, 8000);
        searchVisible = await page
          .locator('input[type="search"]')
          .first()
          .isVisible({ timeout: 20_000 })
          .catch(() => false);
        expect(searchVisible, '首页搜索框两次加载均未出现').toBeTruthy();
      }
      const search = page.locator('input[type="search"]').first();
      // 登录后 hash 切回首页时组件可能重挂载导致 fill 被重置；WebKit 下输入框可能被覆盖层挡住导致 fill 超时
      for (let i = 0; i < 3; i++) {
        try {
          await search.fill(SEARCH_KEYWORD, { timeout: 8000 });
        } catch {
          // JS 兜底：直接改值并派发 input 事件（Vue/uni-app v-model 可识别）
          await search.evaluate((el, v) => {
            const setter = Object.getOwnPropertyDescriptor(
              window.HTMLInputElement.prototype, 'value',
            )!.set!;
            setter.call(el, v);
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }, SEARCH_KEYWORD);
        }
        await page.waitForTimeout(800);
        if ((await search.inputValue()) === SEARCH_KEYWORD) break;
      }
      // uni-app u-search：Enter/按钮均不稳定（按钮被图标层拦截），点击联想词最可靠
      const suggestion = page.locator(`text=/^${SEARCH_KEYWORD}$/i`).first();
      const searchBtn = page.locator('text=/^(搜索|Search)$/i').first();
      if (await suggestion.isVisible({ timeout: 8000 }).catch(() => false)) {
        await suggestion.click({ force: true });
      } else if (await searchBtn.isVisible().catch(() => false)) {
        await searchBtn.click({ force: true });
      } else {
        await search.press('Enter');
      }
      await page.waitForTimeout(8000);

      expect(page.url(), '搜索后未进入结果页').toContain(wapRoute('shopdc'));
      // 结果页出现商品卡片即视为搜索有效；价格受懒加载/HTTP2 间歇错误影响，放宽匹配并加长等待
      const priceLocator = page.locator('text=/[$USD]{1,4}\\s*\\d|US\\$\\s*\\d/i').first();
      const hasPrice = await priceLocator
        .isVisible({ timeout: 40_000 })
        .catch(() => false);
      if (!hasPrice) {
        const body = await page.locator('body').innerText();
        expect(
          /\d+\s*(results|items)|\$\s*\d|USD/i.test(body),
          `搜索「${SEARCH_KEYWORD}」48秒内既无价格也无结果统计`,
        ).toBeTruthy();
      }
    });

    test('03 商品详情完整加载', async ({ page }) => {
      await loginWap(page, wapSiteBase);
      await openWap(page, DETAIL_HASH, wapSiteBase, 8000);

      await expect
        .poll(
          async () => (await page.locator('body').innerText()),
          { timeout: 30_000, intervals: [2000] },
        )
        .toMatch(/Body|Goods Details/i);
      // 价格接口晚于骨架渲染，轮询等待美元价格出现
      await expect
        .poll(
          async () => /\$\s*\d/.test(await page.locator('body').innerText()),
          { timeout: 30_000, intervals: [2000], message: '详情页无美元价格' },
        )
        .toBeTruthy();
      const body = await page.locator('body').innerText();
      expect(body.includes('Goods Details'), '详情页标题缺失').toBeTruthy();
      expect(/Total sold/i.test(body), '详情页无销量信息').toBeTruthy();
      await expect(
        page.locator('.fixed-btn.btn-primary').first(),
        'Add to Cart 按钮缺失',
      ).toBeVisible();
      await expect(page.locator('.fixed-btn.btn-buy').first(), 'Buy Now 按钮缺失').toBeVisible();
    });

    let addedToCart = false;

    test('04 加入购物车', async ({ page }) => {
      await loginWap(page, wapSiteBase);
      await openWap(page, CART_ITEM_HASH, wapSiteBase, 8000);
      await expect
        .poll(async () => /\$\s*\d/.test(await page.locator('body').innerText()), {
          timeout: 30_000,
          intervals: [2000],
          message: '详情页未出现价格',
        })
        .toBeTruthy();

      // 打开 SKU 弹层 → 首行规格填 MOQ 数量 → 原生点击加购
      await page.locator('.fixed-btn.btn-primary').first().click({ force: true });
      await page.waitForTimeout(3000);
      const specInput = page.locator('.skuSpec .flex input').first();
      await expect(specInput, 'SKU 弹层规格数量输入框缺失').toBeVisible();
      const moqText = await page.locator('.sku-content .sell-num').innerText().catch(() => '');
      const moq = Number(moqText.match(/(\d+)/)?.[1] || '1');
      await specInput.fill(String(moq), { force: true });
      await page.waitForTimeout(1500);
      await page.evaluate(() => {
        const b = document.querySelector('.btns uni-button.btn-primary') as HTMLElement | null;
        b?.click();
      });
      // 成功弹窗 → Confirm
      await expect(
        page.locator('.uni-modal'),
        '加购后未出现成功弹窗',
      ).toContainText(/added to cart/i, { timeout: 15_000 });
      await page.locator('.uni-modal__btn_primary').first().click({ force: true });
      await page.waitForTimeout(2000);

      // 打开购物车验证（站点偶发加载失败显示空态，重载最多 3 次）
      let hasItem = false;
      for (let i = 0; i < 3 && !hasItem; i++) {
        await openWap(page, wapRoute('cart'), wapSiteBase, 4000);
        const cartBody = await page.locator('body').innerText();
        hasItem = !/currently empty/i.test(cartBody);
        if (!hasItem) await page.waitForTimeout(3000);
      }
      expect(hasItem, '加购成功后购物车仍为空').toBeTruthy();
    });

    test('05 立即购买进入下单流程（数据驱动标准打法，不真实支付）', async ({ page }) => {
      // 2026-09-22 重写：旧版"点 Buy Now 不选规格+找 uni-modal 兜底"是 9/15 误报根因，已废弃。
      // 标准打法：getItem 数据驱动选有库存 SKU → el.click 盲点 → 弹层内 Buy Now → 以 cart/add 成功+跳转 carttoorder 为判定
      const getItem = captureGetItem(page);
      await loginWap(page, wapSiteBase);
      await openWap(page, DETAIL_HASH, wapSiteBase, 8000);

      // 详情页价格接口晚于骨架渲染，轮询到价格出现
      await expect
        .poll(async () => /\$\s*\d/.test(await page.locator('body').innerText()), {
          timeout: 30_000,
          intervals: [2000],
          message: '详情页未出现价格',
        })
        .toBeTruthy();

      const r = await standardSkuFlow(page, { getItem, action: 'buynow', qty: 1 });

      // 上游 obapi/getItem 间歇性 item-not-found（BUG-20260921-02）：无数据时跳过本轮防误报，不定性为站点缺陷
      test.skip(r.noItemData && !r.jumped, 'getItem 间歇性无数据（BUG-20260921-02），本轮跳过待下轮复测');

      expect(
        r.cartAddSeen || r.jumped,
        `标准打法下单未成功：${r.logs.join(' | ')}（cart/add 未成功且未跳转）`,
      ).toBeTruthy();
      expect(
        r.jumped,
        `cart/add 已成功但未跳转订单确认页：${page.url().slice(0, 100)}`,
      ).toBeTruthy();
      // 安全红线：不点击任何真实支付按钮，仅验证流程可达
    });

    test('06 用户资料修改并还原', async ({ page }) => {
      // 登录
      await openWap(page, wapRoute('login'), wapSiteBase);
      await page.locator('input[type="text"]').first().fill(ACCOUNT);
      await page.locator('input[type="password"]').first().fill(PASSWORD);
      await page.getByText('Sign in', { exact: true }).first().click();
      await page.waitForTimeout(5000);

      await openWap(page, wapRoute('profile'), wapSiteBase, 3500);

      // Username 输入框：Profile 页第一个 text 输入
      const usernameInput = page.locator('input[type="text"]').first();
      await expect(usernameInput, '资料页用户名输入框缺失').toBeVisible();

      const original = (await usernameInput.inputValue()) || '';
      const tempName = `AutoTest${Date.now().toString().slice(-6)}`;

      // 修改为临时昵称
      await usernameInput.fill(tempName);
      await page.getByText('Save', { exact: true }).first().click();
      await page.waitForTimeout(3000);

      // 重新进入验证
      await openWap(page, wapRoute('profile'), wapSiteBase, 3500);
      const savedName = await page.locator('input[type="text"]').first().inputValue();
      expect(savedName, `保存后昵称为「${savedName}」，与提交值「${tempName}」不一致`).toBe(tempName);

      // 还原
      await page.locator('input[type="text"]').first().fill(original);
      await page.getByText('Save', { exact: true }).first().click();
      await page.waitForTimeout(3000);
      await openWap(page, wapRoute('profile'), wapSiteBase, 3500);
      const restored = await page.locator('input[type="text"]').first().inputValue();
      expect(restored, `还原失败：当前「${restored}」，原值「${original}」`).toBe(original);
    });

    test('99 清理：移除测试加购商品', async ({ page }) => {
      test.skip(!addedToCart, '本轮未成功加购，无需清理');
      // 登录
      await openWap(page, wapRoute('login'), wapSiteBase);
      await page.locator('input[type="text"]').first().fill(ACCOUNT);
      await page.locator('input[type="password"]').first().fill(PASSWORD);
      await page.getByText('Sign in', { exact: true }).first().click();
      await page.waitForTimeout(5000);

      await openWap(page, wapRoute('cart'), wapSiteBase, 4000);
      // 尝试 Edit → 全选/删除；结构不确定时尽力而为，失败不阻断
      const edit = page.getByText('Edit', { exact: true }).first();
      if (await edit.isVisible().catch(() => false)) {
        await edit.click();
        await page.waitForTimeout(1500);
        for (const label of ['Delete', 'Remove', 'All']) {
          const el = page.getByText(label, { exact: true }).first();
          if (await el.isVisible().catch(() => false)) {
            await el.click().catch(() => {});
            await page.waitForTimeout(1500);
          }
        }
      }
      // 清理为尽力而为，不做硬断言
    });
  });
}
