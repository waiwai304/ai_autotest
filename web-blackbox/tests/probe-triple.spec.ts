import { test, expect, Browser } from '@playwright/test';
import * as fs from 'fs';

const SITE = process.env.SITE_PC_BASE_URL || 'https://demo.example.com';
const IID = '982345010398';
const DETAIL = `${SITE}/zh-cn/detail/1688?url=` + encodeURIComponent(`https://detail.1688.com/offer/${IID}.html`);

async function poll(page: any, n = 45) {
  let info: any = {};
  for (let i = 0; i < n; i++) {
    await page.waitForTimeout(2000);
    const st = await page.evaluate(`(() => {
      const body = document.body.innerText;
      const symPrice = (body.match(/[\\p{Sc}]\\s*\\d[\\d.]*/u) || [''])[0];
      const buyBtn = Array.from(document.querySelectorAll('button')).find(b => /立即购买/.test(b.textContent || ''));
      return JSON.stringify({ symPrice, hasBtn: !!buyBtn, bodyLen: body.length });
    })()`).catch(() => '{}');
    try { info = JSON.parse(st); } catch { /* ignore */ }
    if (info.symPrice && info.hasBtn) return { ok: true, n: i + 1, info };
  }
  return { ok: false, n, info };
}

test.describe.configure({ mode: 'serial', retries: 0 });

test('三连同分钟对照', async ({ browser }: { browser: Browser }) => {
  test.setTimeout(600000);
  const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${SITE}/zh-cn/login`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  const envTxt = fs.readFileSync('.env', 'utf-8');
  const acc = process.env.SITE_FRONT_ACCOUNT || /^ONEBUY_TEST_ACCOUNT=(.*)$/m.exec(envTxt)?.[1]?.trim() || '';
  const pwd = process.env.SITE_FRONT_PASSWORD || /^ONEBUY_TEST_PASSWORD=(.*)$/m.exec(envTxt)?.[1]?.trim() || '';
  await page.locator('input[name="email"]').fill(acc);
  await page.locator('input[name="password"]').fill(pwd);
  await page.getByRole('button', { name: '登录', exact: true }).first().click();
  for (let i = 0; i < 8 && /login/.test(page.url()); i++) await page.waitForTimeout(2000);
  console.log('登录完成，开始三连（同分钟）');

  // 1) 会话首次进入
  await page.goto(DETAIL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  const r1 = await poll(page);
  console.log(`R1 首次进入: ok=${r1.ok} 第${r1.n}次`, JSON.stringify(r1.info));

  // 2) 同会话二次进入（reload）
  await page.goto(DETAIL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  const r2 = await poll(page);
  console.log(`R2 二次进入: ok=${r2.ok} 第${r2.n}次`, JSON.stringify(r2.info));

  await ctx.close();

  // 3) 全新会话
  const ctx2 = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
  const page2 = await ctx2.newPage();
  await page2.goto(`${SITE}/zh-cn/login`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page2.locator('input[name="email"]').fill(acc);
  await page2.locator('input[name="password"]').fill(pwd);
  await page2.getByRole('button', { name: '登录', exact: true }).first().click();
  for (let i = 0; i < 8 && /login/.test(page2.url()); i++) await page2.waitForTimeout(2000);
  await page2.goto(DETAIL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  const r3 = await poll(page2);
  console.log(`R3 新会话: ok=${r3.ok} 第${r3.n}次`, JSON.stringify(r3.info));
  await ctx2.close();
  console.log(`汇总: R1=${r1.ok} R2=${r2.ok} R3=${r3.ok}`);
});
