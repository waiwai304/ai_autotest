/**
 * lulukitty.com 前台登录探针（2026-10-14，JOB-000097 F1 卡登录排查）
 * 复现 frontLogin 加固版逻辑（settle 3s + 原生 setter 同步 React state + 3 次尝试），不下单不进 F2。
 * 运行：
 *   cd /mnt500/www/wwwroot/onebuy_ceshi/web-blackbox
 *   env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u all_proxy \
 *     TEST_SITE_ID=onebuy-v2026 SITE_PC_BASE_URL=https://lulukitty.com/ \
 *     SITE_FRONT_ACCOUNT=<账号> SITE_FRONT_PASSWORD=<密码> \
 *     npx playwright test tests/probe-lulu-login.spec.ts --project=onebuy-desktop
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { pcUrl } from './helpers/site';

const envTxt = readFileSync('.env', 'utf-8');
const ACCOUNT = process.env.SITE_FRONT_ACCOUNT || /^ONEBUY_TEST_ACCOUNT=(.*)$/m.exec(envTxt)?.[1]?.trim() || '';
const PASSWORD = process.env.SITE_FRONT_PASSWORD || /^ONEBUY_TEST_PASSWORD=(.*)$/m.exec(envTxt)?.[1]?.trim() || '';
test.skip(!ACCOUNT || !PASSWORD, '未配置测试账号（SITE_FRONT_ACCOUNT/SITE_FRONT_PASSWORD）');

async function hardenedLogin(page: Page2): Promise<{ ok: boolean; tries: number; lastErr: string }> {
  let lastErr = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.goto(`${pcUrl('login')}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3000); // SPA settle：React 挂载（lulukitty 首次冷渲染慢）
    await page.locator('input[name="email"]').fill(ACCOUNT);
    await page.locator('input[name="password"]').fill(PASSWORD);
    const sync = (sel: string, v: string) => page.evaluate(`((s, v) => {
      const el = document.querySelector(s);
      if (el) { const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); }
    })(${JSON.stringify(sel)}, ${JSON.stringify(v)})`).catch(() => {});
    await sync('input[name="email"]', ACCOUNT);
    await sync('input[name="password"]', PASSWORD);
    await page.getByRole('button', { name: '登录', exact: true }).first().click().catch(async () => {
      await page.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent || '').trim() === '登录'); if (b) b.click(); })()`);
    });
    for (let i = 0; i < 8 && /login/.test(page.url()); i++) await page.waitForTimeout(2000);
    if (!/\/login/.test(page.url())) return { ok: true, tries: attempt, lastErr: '' };
    lastErr = await page.evaluate(`(() => { const m = ((document.body.innerText || '').match(/请输入.{0,24}|无效.{0,24}|密码错误.{0,24}/)); return m ? m[0] : '(无校验提示)'; })()`).catch(() => '(页面不可读)');
    console.log(`[probe] 第 ${attempt} 次未离开登录页，表单提示: ${lastErr}`);
  }
  return { ok: false, tries: 3, lastErr };
}

type Page2 = import('playwright').Page;

for (const tag of ['冷启动', '二次会话']) {
  test(`lulukitty 登录加固验证（${tag}）`, async ({ browser }) => {
    const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const r = await hardenedLogin(page);
    console.log(`[probe][${tag}] result=`, JSON.stringify(r), '| url:', page.url().slice(0, 90));
    expect(r.ok, `3 次尝试均未离开登录页（最后表单提示: ${r.lastErr}）`).toBeTruthy();
    if (r.ok) {
      await page.evaluate(`(() => { try { localStorage.setItem('selectedCurrency', 'CNY'); } catch (e) {} })()`).catch(() => {});
      await page.waitForTimeout(3000);
      const bodyLen = await page.evaluate(`(() => (document.body.innerText || '').length)()`).catch(() => 0);
      console.log(`[probe][${tag}] 登录后落地页 bodyLen=${bodyLen} url=${page.url().slice(0, 80)} 尝试次数=${r.tries}`);
      expect(bodyLen > 200, `登录后落地页疑似空壳 bodyLen=${bodyLen}`).toBeTruthy();
    }
    await ctx.close();
  });
}
