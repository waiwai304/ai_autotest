import { test, expect, Browser } from '@playwright/test';
import * as fs from 'fs';

const SITE = process.env.SITE_PC_BASE_URL || 'https://demo.example.com';
const IID = '982345010398';
const DETAIL = `${SITE}/zh-cn/detail/1688?url=` + encodeURIComponent(`https://detail.1688.com/offer/${IID}.html`);
const REPS = Number(process.env.F2T_REPS || 3);

test.describe.configure({ mode: 'serial', retries: 0 });

test('F2 遥测复现：渲染轨迹 + 请求时间线', async ({ browser }: { browser: Browser }) => {
  test.setTimeout(1200000);
  for (let rep = 1; rep <= REPS; rep++) {
    const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const events: string[] = [];
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const t0mark = { v: 0 };

    page.on('console', (m: any) => { if (m.type() === 'error') consoleErrors.push((m.text() || '').slice(0, 160)); });
    page.on('pageerror', (e: any) => pageErrors.push(String(e).slice(0, 160)));
    page.on('response', (r: any) => {
      const t = ((Date.now() - t0mark.v) / 1000).toFixed(1);
      const p = r.url().replace(SITE, '').slice(0, 70);
      events.push(`  t=${t}s [${r.status()}] ${p}`);
    });

    // 完整复刻 F1：登录 + CNY 注入
    await page.goto(`${SITE}/zh-cn/login`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const envTxt = fs.readFileSync('.env', 'utf-8');
    const acc = process.env.SITE_FRONT_ACCOUNT || /^ONEBUY_TEST_ACCOUNT=(.*)$/m.exec(envTxt)?.[1]?.trim() || '';
    const pwd = process.env.SITE_FRONT_PASSWORD || /^ONEBUY_TEST_PASSWORD=(.*)$/m.exec(envTxt)?.[1]?.trim() || '';
    await page.locator('input[name="email"]').fill(acc);
    await page.locator('input[name="password"]').fill(pwd);
    await page.getByRole('button', { name: '登录', exact: true }).first().click();
    for (let i = 0; i < 8 && /login/.test(page.url()); i++) await page.waitForTimeout(2000);
    await page.evaluate(`(() => { try { localStorage.setItem('selectedCurrency', 'CNY'); } catch (e) {} })()`).catch(() => {});
    console.log(`\n===== 第${rep}轮 登录完成: ${page.url()} =====`);

    // 完整复刻 F2 候选循环：唯一 goto 在这里
    t0mark.v = Date.now();
    events.length = 0;
    await page.goto(DETAIL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    let ok = false; let lastInfo: any = {}; const traj: string[] = [];
    for (let pi = 0; pi < 75; pi++) {
      await page.waitForTimeout(2000);
      const st = await page.evaluate(`(() => {
      const body = document.body.innerText;
      const symPrice = (body.match(/[\\p{Sc}]\\s*\\d[\\d.]*/u) || [''])[0];
      const buyBtn = Array.from(document.querySelectorAll('button')).find(b => /立即购买/.test(b.textContent || ''));
      return JSON.stringify({ symPrice, bodyLen: body.length, hasBtn: !!buyBtn });
    })()`).catch(() => '{}');
      try { lastInfo = JSON.parse(st); } catch { /* ignore */ }
      if (pi % 5 === 0 || (lastInfo.symPrice && lastInfo.hasBtn)) {
        traj.push(`  t=${(pi + 1) * 2}s bodyLen=${lastInfo.bodyLen} sym=${lastInfo.symPrice || '-'} btn=${lastInfo.hasBtn ? 'Y' : 'N'}`);
      }
      if (lastInfo.symPrice && lastInfo.hasBtn) { ok = true; traj.push(`  >>> 就绪 t=${(pi + 1) * 2}s`); break; }
    }
    console.log(`第${rep}轮 结果: ok=${ok}`);
    console.log('渲染轨迹:\n' + traj.join('\n'));
    console.log('请求时间线（前 30 条）:\n' + events.slice(0, 30).join('\n'));
    console.log('请求时间线（后 10 条）:\n' + events.slice(-10).join('\n'));
    if (consoleErrors.length) console.log('console errors:', JSON.stringify(consoleErrors.slice(0, 6)));
    if (pageErrors.length) console.log('pageerrors:', JSON.stringify(pageErrors.slice(0, 4)));
    await ctx.close();
  }
  expect(true).toBeTruthy();
});
