import { expect, test } from '../src/fixtures';
import { sites } from '../src/config';
import type { Page } from '@playwright/test';
import { captureGetItem, standardSkuFlow } from './helpers/sku-standard';
import { site, wapEntry, wapRoute, wapSiteBase, offer1688, SET_CURRENCY_USD } from './helpers/site';

/**
 * OneBuy WAP 完整购物支付流程（真实交易）
 * 登录 → 商品详情(选SKU+数量) → 加购 → 购物车全选结算 → 确认订单(勾选协议+Submit) → 余额支付 → 支付成功
 *
 * 前提（站点方配合项）：
 * - 测试账号已充值余额（每跑一轮约消耗 $9，订单需人工清理）
 * - 商品 993196755911 在架且有库存（MOQ=3，$0.73/件）
 * - 购物车残留条目会一并结算，Total 以页面实际为准
 *
 * 站点已知特性（用例依赖）：
 * - uni-button 的 Playwright click 不可靠，需原生 el.click()
 * - SKU 弹层每行规格自带数量步进器，填数量即选中；数量必须 ≥ MOQ
 * - 加购成功弹「Successfully added to cart!」需点 Confirm
 * - 协议勾选框在 .agreement .u-checkbox，Submit 前必须勾选
 * - 全程不要求收货地址
 */

const ACCOUNT = process.env.SITE_FRONT_ACCOUNT || process.env.ONEBUY_TEST_ACCOUNT || '';
const PASSWORD = process.env.SITE_FRONT_PASSWORD || process.env.ONEBUY_TEST_PASSWORD || '';
const NUM_IID = process.env.WAP_NUM_IID || site.testData.numIidWapCart || '';
const OFFER_URL = offer1688(NUM_IID);
const DETAIL_HASH = `${wapRoute('itemdc')}?num_iid=${NUM_IID}&url=${encodeURIComponent(OFFER_URL)}&tp=1688`;

test.skip(({ browserName }) => browserName !== 'webkit', 'WAP 完整购物流程仅在移动端(WebKit)运行');
test.skip(!ACCOUNT || !PASSWORD, '未配置测试账号 ONEBUY_TEST_ACCOUNT/PASSWORD，跳过');
test.skip(!NUM_IID, 'config/sites.json 缺少 testData.numIidWapCart，跳过');

async function openWap(page: Page, route: string, baseURL: string, settleMs = 3000) {
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
  // 固定币种 USD（幂等注入：站点新会话默认币种随机 USD/CNY/JPY，支付金额符号随之变化）
  // 2026-10-12 ian：默认币种 CNY；不再注入 SET_CURRENCY_USD（RUB 会话写坏 currencyData → SPA 空壳）
  await page.evaluate(`(() => { try { localStorage.setItem('selectedCurrency', 'CNY'); } catch (e) {} })()`).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(settleMs);
}

async function loginWap(page: Page, baseURL: string) {
  await openWap(page, wapRoute('login'), baseURL);
  await page.locator('input[type="text"]').first().fill(ACCOUNT);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.getByText('Sign in', { exact: true }).first().click();
  await page.waitForTimeout(5000);
}

/** 通过文本找可见元素并原生点击（uni-app 组件对 Playwright 合成 click 响应不稳定） */
async function clickTextNative(page: Page, text: string) {
  const ok = await page.evaluate(([t]) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (n.textContent && n.textContent.trim() === t) {
        let el: Element | null = n.parentElement;
        if (el && el.getBoundingClientRect().width > 0) {
          (el as HTMLElement).click();
          return true;
        }
      }
    }
    return false;
  }, [text]);
  expect(ok, `未找到可点击的「${text}」元素`).toBeTruthy();
}

for (const site of sites) {
  test.describe.serial(`${site.name} - WAP 完整购物支付流程`, () => {
    test.slow(); // 全链路含多次页面稳定等待，放宽超时
    test.use({ baseURL: wapSiteBase });

    test('S1-S6 完整下单并余额支付', async ({ page }) => {
      test.setTimeout(420_000); // 全链路 + 站点偶发故障重试，给足 7 分钟
      // S1 登录 → 商品详情（导航前注册 getItem 捕获，标准打法数据源）
      const getItem = captureGetItem(page);
      await loginWap(page, wapSiteBase);
      await openWap(page, DETAIL_HASH, wapSiteBase, 8000);
      await expect
        .poll(async () => /\$\s*\d/.test(await page.locator('body').innerText()), {
          timeout: 30_000,
          intervals: [2000],
          message: '详情页未出现价格',
        })
        .toBeTruthy();

      // S2 打开 SKU 弹层 → 标准打法选规格+数量 → 加购（2026-09-22 重写）
      // 旧版以视觉断言判定（数量框 toBeVisible / totalInfo 金额 toHaveText）——BUG-20260921-01 渲染层不刷新时必误报，已废弃。
      // 标准打法：1688 源默认规格+自动 MOQ 填数；tglobal 源 getItem 数据驱动选有库存 SKU；成功判定 = cart/add 成功 + added to cart 弹窗
      const addCart = await standardSkuFlow(page, { getItem, action: 'addcart' });
      expect(
        addCart.cartAdded || addCart.cartAddSeen,
        `加购未成功：${addCart.logs.join(' | ')}`,
      ).toBeTruthy();

      // S3 购物车 → 全选 → Checkout
      await openWap(page, wapRoute('cart'), wapSiteBase, 5000);
      await expect(page.locator('.cart-select-all').first()).toBeVisible();
      await page.locator('.cart-select-all').first().click({ force: true });
      await page.waitForTimeout(2000);
      const totalText = (await page.locator('body').innerText()).match(/Total[^\n]*/)?.[0] || '';
      expect(totalText, '全选后 Total 未显示金额').toMatch(/Total[^\d]*\$\d/);
      await clickTextNative(page, 'Checkout');
      await page.waitForTimeout(6000);
      expect(page.url(), '未进入确认订单页').toContain(wapRoute('carttoorder'));

      // S4 确认订单页：金额一致、勾选协议、Submit
      const orderBody = await page.locator('body').innerText();
      expect(orderBody, '确认订单页缺少 Total 金额').toMatch(/Total[^\d]*\$\d/);
      await page.locator('.agreement .u-checkbox').first().click({ force: true });
      await page.waitForTimeout(1000);
      await page.evaluate(() => {
        const b = document.querySelector('.button-content uni-button') as HTMLElement | null;
        b?.click();
      });
      await page.waitForTimeout(6000);
      expect(page.url(), '提交订单后未进入支付页').toContain(wapRoute('pay'));

      // S5 支付页：余额支付 → Pay Now → Confirm
      const payBody = await page.locator('body').innerText();
      // 2026-09-22 修正：支付页无「ODxxxx」单号文本（已知站点特性），订单 ID 在 URL 参数 type=OD&ids=N
      expect(page.url(), '支付页 URL 缺少订单 ID 参数（type=OD&ids=N）').toMatch(/type=OD&ids=\d+/);
      const payAmount = payBody.match(/Payment Amount[^\d]*([$¥￥][\d.]+)/)?.[1] || '';
      expect(payAmount, '支付页未解析到支付金额').toMatch(/^[$¥￥][\d.]+$/);
      expect(payBody, '支付方式中无余额支付').toContain('Balance Payment');

      await page.evaluate(() => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const n = walker.currentNode;
          if (n.textContent && n.textContent.includes('Balance Payment')) {
            let el: Element | null = n.parentElement;
            for (let i = 0; i < 4 && el; i++) {
              const r = (el as HTMLElement).getBoundingClientRect();
              if (r.height > 30 && r.width > 200) {
                (el as HTMLElement).click();
                return;
              }
              el = el.parentElement;
            }
          }
        }
      });
      await page.waitForTimeout(1500);
      await clickTextNative(page, 'Pay Now');
      await page.waitForTimeout(4000);
      await expect(
        page.locator('.uni-modal'),
        '点击 Pay Now 后未出现支付确认弹窗',
      ).toContainText(/confirm payment/i, { timeout: 10_000 });
      await page.locator('.uni-modal__btn_primary').first().click({ force: true });
      await page.waitForTimeout(8000);

      // S6 支付结果
      expect(page.url(), '支付完成后未跳转支付结果页').toContain('payResult');
      await expect(
        page.locator('body'),
        '支付结果页未显示支付成功',
      ).toContainText(/payment successful/i);
      const resultBody = await page.locator('body').innerText();
      const paidAmount = resultBody.match(/Amount Paid[^\d]*(\$[\d.]+)/)?.[1] || '';
      expect(paidAmount, `实付金额「${paidAmount}」与应付「${payAmount}」不一致`).toBe(payAmount);
    });
  });
}
