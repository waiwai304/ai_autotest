import { test, expect, Browser } from '@playwright/test';
import * as fs from 'fs';

const SITE = process.env.SITE_PC_BASE_URL || 'https://demo.example.com';
const IID = '982345010398';
const DETAIL = `${SITE}/zh-cn/detail/1688?url=` + encodeURIComponent(`https://detail.1688.com/offer/${IID}.html`);

type PhaseResult = {
  phase: string; ok: boolean; n: number; symPrice: string; bodyLen: number;
  currencyLabel: string; getItem: { fired: boolean; status: number; bodyHead: string };
  consoleErrors: string[]; pageErrors: string[];
};

async function probeDetail(page: any, phase: string): Promise<PhaseResult> {
  const res: PhaseResult = {
    phase, ok: false, n: 0, symPrice: '', bodyLen: 0, currencyLabel: '',
    getItem: { fired: false, status: 0, bodyHead: '' },
    consoleErrors: [], pageErrors: [],
  };
  page.on('console', (m: any) => { if (m.type() === 'error') res.consoleErrors.push((m.text() || '').slice(0, 200)); });
  page.on('pageerror', (e: any) => res.pageErrors.push(String(e).slice(0, 200)));
  page.on('response', async (r: any) => {
    if (/obapi\/getItem/.test(r.url())) {
      res.getItem.fired = true;
      res.getItem.status = r.status();
      try { res.getItem.bodyHead = (await r.text()).slice(0, 150); } catch { /* ignore */ }
    }
  });
  await page.goto(DETAIL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  let info: any = {};
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(2000);
    res.n = i + 1;
    const st = await page.evaluate(`(() => {
      const body = document.body.innerText;
      const symPrice = (body.match(/[\\p{Sc}]\\s*\\d[\\d.]*/u) || [''])[0];
      const buyBtn = Array.from(document.querySelectorAll('button')).find(b => /立即购买/.test(b.textContent || ''));
      const curLabel = (Array.from(document.querySelectorAll('*')).find(el => el.children.length === 0 && /zh-cn\\s*\\/\\s*[A-Z]{3}/.test(el.textContent || '')) || {textContent:''}).textContent;
      return JSON.stringify({ symPrice, hasBtn: !!buyBtn, bodyLen: body.length, curLabel: (curLabel||'').trim() });
    })()`).catch(() => '{}');
    try { info = JSON.parse(st); } catch { /* ignore */ }
    res.symPrice = info.symPrice || ''; res.bodyLen = info.bodyLen || 0; res.currencyLabel = info.curLabel || '';
    if (res.symPrice && info.hasBtn) { res.ok = true; break; }
  }
  return res;
}

test.describe.configure({ mode: 'serial', retries: 0 });

test('币种注入 A/B 同会话对照（runner 环境）', async ({ browser }: { browser: Browser }) => {
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
  console.log('登录完成:', page.url());

  // B 相位先行：不注入币种（随机会话币种），作为同会话基线
  const bRes = await probeDetail(page, 'B-无注入');
  console.log(`B 无注入: ok=${bRes.ok} 第${bRes.n}次 sym=${bRes.symPrice} bodyLen=${bRes.bodyLen} 币种=${bRes.currencyLabel} getItem=${bRes.getItem.fired}/${bRes.getItem.status}`);
  if (bRes.getItem.bodyHead) console.log('  getItem body:', bRes.getItem.bodyHead.slice(0, 100));
  if (bRes.consoleErrors.length) console.log('  console errors:', JSON.stringify(bRes.consoleErrors.slice(0, 5)));
  if (bRes.pageErrors.length) console.log('  pageerrors:', JSON.stringify(bRes.pageErrors.slice(0, 3)));

  // A 相位：完整复刻 full-chain F1 的 CNY 注入（仅 selectedCurrency 一项）
  await page.evaluate(`(() => { localStorage.setItem('selectedCurrency', 'CNY'); })()`);
  const aRes = await probeDetail(page, 'A-注入CNY');
  console.log(`A 注入CNY: ok=${aRes.ok} 第${aRes.n}次 sym=${aRes.symPrice} bodyLen=${aRes.bodyLen} 币种=${aRes.currencyLabel} getItem=${aRes.getItem.fired}/${aRes.getItem.status}`);
  if (aRes.getItem.bodyHead) console.log('  getItem body:', aRes.getItem.bodyHead.slice(0, 100));
  if (aRes.consoleErrors.length) console.log('  console errors:', JSON.stringify(aRes.consoleErrors.slice(0, 5)));
  if (aRes.pageErrors.length) console.log('  pageerrors:', JSON.stringify(aRes.pageErrors.slice(0, 3)));

  // C 相位：同会话撤销注入，验证可恢复性
  await page.evaluate(`(() => { localStorage.removeItem('selectedCurrency'); })()`);
  const cRes = await probeDetail(page, 'C-撤销注入');
  console.log(`C 撤销注入: ok=${cRes.ok} 第${cRes.n}次 sym=${cRes.symPrice} bodyLen=${cRes.bodyLen} 币种=${cRes.currencyLabel} getItem=${cRes.getItem.fired}/${cRes.getItem.status}`);

  console.log(`汇总: B=${bRes.ok} A=${aRes.ok} C=${cRes.ok}`);
  expect(bRes.ok, `B 基线应渲染（否则为坏窗口/环境问题）`).toBeTruthy();
}, );
