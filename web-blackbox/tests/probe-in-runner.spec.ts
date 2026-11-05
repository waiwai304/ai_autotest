import { test, expect, Browser } from '@playwright/test';
import * as fs from 'fs';

/** runner 内复现探针（2026-10-12 终极对照）：与 full-chain F1+F2 完全同构
 *  若本 spec 复现 1463 比价页形态 → 差异在 runner 环境，再二分；
 *  若本 spec 成功 → 差异在 full-chain spec 内部剩余代码。
 */

const SITE = process.env.SITE_PC_BASE_URL || 'https://demo.example.com';
const IID = '982345010398';
const DETAIL = `${SITE}/zh-cn/detail/1688?url=` + encodeURIComponent(`https://detail.1688.com/offer/${IID}.html`);

test.describe.configure({ mode: 'serial', retries: 0 });

test('runner 内 F2 复现探针', async ({ browser }: { browser: Browser }) => {
  test.setTimeout(240000);
  const userCtx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
  const user = await userCtx.newPage();
  // A/B 开关：BOSSCTX=1 启用双 context，默认单 context
  if (process.env.PROBE_BOSSCTX === '1') {
    const bossCtx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1600, height: 900 } });
    const boss = await bossCtx.newPage();
    boss.on('response', async (r) => { const u = r.request().url(); if (u.includes('/api/')) { /* boss wireCapture 同构 */ } });
  }

  // wireCapture 同构
  user.on('response', async (r) => {
    const req = r.request();
    const url = req.url();
    if (!url.includes('/api/') && !/carttoorder|toorder|pay|order/i.test(url)) return;
    if (/\.(png|jpg|jpeg|css|js|woff2?|gif|svg|ico)(\?|$)/.test(url)) return;
  });
  // onGetItem 同构
  const onGetItem = async (r: any) => {
    if (!/obapi\/getItem(?!list)/.test(r.url()) || r.request().method() !== 'POST') return;
    try { await r.json(); } catch { /* ignore */ }
  };
  user.on('response', onGetItem);

  const envTxt = fs.readFileSync('.env', 'utf-8');
  const ACCOUNT = process.env.SITE_FRONT_ACCOUNT || /^ONEBUY_TEST_ACCOUNT=(.*)$/m.exec(envTxt)?.[1]?.trim() || '';
  const PASSWORD = process.env.SITE_FRONT_PASSWORD || /^ONEBUY_TEST_PASSWORD=(.*)$/m.exec(envTxt)?.[1]?.trim() || '';

  // F1 同构
  await user.goto(`${SITE}/zh-cn/login`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await user.locator('input[name="email"]').fill(ACCOUNT);
  await user.locator('input[name="password"]').fill(PASSWORD);
  await user.getByRole('button', { name: '登录', exact: true }).first().click();
  for (let i = 0; i < 8 && /login/.test(user.url()); i++) await user.waitForTimeout(2000);
  expect(!/login/.test(user.url())).toBeTruthy();
  await user.evaluate(`(() => { try { localStorage.setItem('selectedCurrency', 'CNY'); } catch (e) {} })()`).catch(() => {});
  console.log('F1 登录 OK:', user.url());

  // F2 同构：goto 直达 + 轮询
  await user.goto(DETAIL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  let info: any = {};
  let ok = false;
  for (let pi = 0; pi < 45; pi++) { // 90s 长轮询：验证主商品价格是否只是渲染慢
    await user.waitForTimeout(2000);
    const st = await user.evaluate(`(() => {
      const body = document.body.innerText;
      const symPrice = (body.match(/[\\p{Sc}]\\s*\\d[\\d.]*/u) || [''])[0];
      const buyBtn = Array.from(document.querySelectorAll('button')).find(b => /立即购买/.test(b.textContent || ''));
      return JSON.stringify({ symPrice, hasBtn: !!buyBtn, bodyLen: body.length });
    })()`).catch(() => '{}');
    try { info = JSON.parse(st); } catch { /* ignore */ }
    if (info.symPrice && info.hasBtn) { ok = true; break; }
  }
  console.log(`轮询结果: rendered=${ok}`, JSON.stringify(info));
  const bodyHead = await user.evaluate('document.body.innerText.replace(/\\s+/g, " ").slice(0, 200)').catch(() => '');
  console.log('bodyHead:', bodyHead);
  const ua = await user.evaluate('navigator.userAgent');
  console.log('UA:', ua.slice(0, 100));
  await user.screenshot({ path: 'output/probe-runner-f2.png' }).catch(() => {});
  expect(ok, `runner 内复现失败: ${JSON.stringify(info)}`).toBeTruthy();
  await userCtx.close();
});
