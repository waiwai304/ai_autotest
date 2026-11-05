import { test, expect } from '@playwright/test';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';

/**
 * 探针：确认订单页「提交」点击后到底发生了什么（请求/响应/挂起/前端异常）
 * 目的：定位 JOB-000249-PC F2「提交后未进入支付页」真实原因
 */

const BASE = process.env.PC_BASE_URL || 'https://demo.example.com';
const OFFER = process.env.PROBE_OFFER || '905320890914';

function creds() {
  let acc = process.env.SITE_FRONT_ACCOUNT || process.env.ONEBUY_TEST_ACCOUNT || '';
  let pwd = process.env.SITE_FRONT_PASSWORD || process.env.ONEBUY_TEST_PASSWORD || '';
  if (!acc || !pwd) {
    const f = '/workspace/runner/.env';
    if (existsSync(f)) {
      const t = readFileSync(f, 'utf8');
      acc = acc || (/^ONEBUY_TEST_ACCOUNT=(.*)$/m.exec(t)?.[1] || '').trim();
      pwd = pwd || (/^ONEBUY_TEST_PASSWORD=(.*)$/m.exec(t)?.[1] || '').trim();
    }
  }
  return { acc, pwd };
}

test('probe: confirm submit network', async ({ page }) => {
  const { acc, pwd } = creds();
  test.skip(!acc || !pwd, '无账号');

  const log: string[] = [];
  const net: any[] = [];
  const consoleMsgs: string[] = [];
  const pageErrors: string[] = [];
  const t0 = Date.now();
  const ts = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';

  page.on('console', (m) => {
    if (['error', 'warning'].includes(m.type())) consoleMsgs.push(`[${ts()}] ${m.type()}: ${m.text().slice(0, 300)}`);
  });
  page.on('pageerror', (e) => pageErrors.push(`[${ts()}] ${String(e).slice(0, 300)}`));
  page.on('request', (r) => {
    if (!r.url().includes('/api/')) return;
    net.push({ phase: 'request', at: ts(), method: r.method(), url: r.url().slice(0, 160), body: (r.postData() || '').slice(0, 400), status: null, note: '' });
  });
  page.on('response', async (r) => {
    if (!r.url().includes('/api/')) return;
    const item = net.find((n) => n.phase === 'request' && n.url === r.url().slice(0, 160) && !n.status);
    let body = '';
    try { body = (await r.text()).slice(0, 500); } catch { /* ignore */ }
    if (item) { item.status = r.status(); item.note = body; }
    else net.push({ phase: 'response', at: ts(), method: r.request().method(), url: r.url().slice(0, 160), body: '', status: r.status(), note: body });
  });
  page.on('requestfailed', (r) => {
    if (!r.url().includes('/api/')) return;
    net.push({ phase: 'FAILED', at: ts(), method: r.method(), url: r.url().slice(0, 160), status: null, note: r.failure()?.errorText || '' });
  });

  // ---- login ----
  await page.goto(`${BASE}/zh-cn/login`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3000);
  await page.locator('input[name="email"]').fill(acc);
  await page.locator('input[name="password"]').fill(pwd);
  await page.getByRole('button', { name: '登录', exact: true }).first().click({ timeout: 8000 }).catch(async () => {
    await page.locator('button[type="submit"]').first().click().catch(() => {});
  });
  await page.waitForTimeout(7000);
  log.push(`${ts()} 登录后 URL: ${page.url()}`);

  // ---- detail ----
  await page.goto(`${BASE}/zh-cn/detail/1688?url=${encodeURIComponent(`https://detail.1688.com/offer/${OFFER}.html`)}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  let ready = false;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(2000);
    ready = await page.evaluate(`(() => { const b = document.body.innerText; return /[\\p{Sc}]\\s*\\d/u.test(b) && !!Array.from(document.querySelectorAll('button')).find(x=>/立即购买/.test(x.textContent||'')); })()`);
    if (ready) break;
  }
  log.push(`${ts()} 详情页就绪=${ready} url=${page.url().slice(0, 100)}`);
  if (!ready) { writeFileSync('/workspace/runner/output/probe-confirm.json', JSON.stringify({ log, net, consoleMsgs, pageErrors }, null, 1)); expect(ready, '详情未就绪').toBeTruthy(); }

  await page.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => /立即购买/.test(x.textContent || '')); if (b) b.click(); })()`);
  for (let i = 0; i < 8; i++) { await page.waitForTimeout(2000); if (/\/confirm/.test(page.url())) break; }
  log.push(`${ts()} 确认页 URL: ${page.url().slice(0, 120)}`);
  expect(/\/confirm/.test(page.url()), '未进入确认页').toBeTruthy();
  await page.waitForTimeout(4000);

  // 页面现场基线
  const baseline = await page.evaluate(`(() => {
    const btns = Array.from(document.querySelectorAll('button')).map(b => ({ t: (b.textContent||'').trim().slice(0,20), cls: (b.className||'').toString().slice(0,80), disabled: b.disabled, w: Math.round(b.getBoundingClientRect().width), h: Math.round(b.getBoundingClientRect().height) }));
    return JSON.stringify({ url: location.href.slice(0,120), btns, checkboxes: document.querySelectorAll('input[type=checkbox]').length });
  })()`);
  log.push(`${ts()} 确认页按钮清单: ${baseline}`);

  // 条款勾选
  const n = await page.locator('input[type="checkbox"]').count();
  if (n > 0) await page.locator('input[type="checkbox"]').last().check({ force: true }).catch(() => {});
  await page.waitForTimeout(800);
  const checked = await page.evaluate(`(() => { const c = Array.from(document.querySelectorAll('input[type="checkbox"]')); return c.length ? c[c.length-1].checked : null; })()`);
  log.push(`${ts()} 条款勾选=${checked}`);

  // 清空网络记录，只看提交后
  net.length = 0;
  const mark = Date.now();
  const marker = net.length;

  // 定位「提交」按钮：记录所有候选及其可点性
  const cand = await page.evaluate(`(() => {
    const out = [];
    document.querySelectorAll('button').forEach((b, i) => {
      const t = (b.textContent || '').trim();
      if (/提\\s*交/.test(t)) { const r = b.getBoundingClientRect(); out.push({ i, t: t.slice(0,20), cls: (b.className||'').toString().slice(0,100), disabled: b.disabled, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), vis: r.width>0 && r.height>0 }); }
    });
    return JSON.stringify(out);
  })()`);
  log.push(`${ts()} 「提交」候选按钮: ${cand}`);

  const submit = page.getByRole('button', { name: /提\s*交/ }).last();
  const box = await submit.boundingBox().catch(() => null);
  log.push(`${ts()} 点击目标 bbox=${JSON.stringify(box)}`);
  await submit.click({ timeout: 8000 }).catch((e) => log.push(`${ts()} 点击异常: ${String(e).slice(0, 200)}`));
  log.push(`${ts()} 已点击提交`);

  // 60s 逐秒观察
  const timeline: string[] = [];
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(2000);
    const st = await page.evaluate(`(() => {
      const body = document.body.innerText;
      const tips = Array.from(document.querySelectorAll('.ant-message, .ant-notification, [class*="toast"], .el-message, [class*="modal"], [class*="tip"]'))
        .map(x => (x.textContent || '').trim()).filter(t => t && t.length < 120).slice(0, 3).join(' | ');
      const btns = Array.from(document.querySelectorAll('button')).filter(b => /提\\s*交/.test(b.textContent||'')).map(b => ({ d: b.disabled, l: /load|spin|disab/i.test((b.className||'').toString()) || !!b.querySelector('[class*="load"],[class*="spin"]') }));
      return JSON.stringify({ u: location.href.slice(0, 90), len: body.length, tips, btns, sl: /正在提交|处理中|请稍候/.test(body) });
    })()`).catch(() => '{}');
    timeline.push(`${ts()} ${st}`);
    if (/\/pay/.test(page.url())) { timeline.push('已跳转支付页'); break; }
  }
  log.push('--- 提交后时间线 ---');
  log.push(...timeline);

  const out = {
    offer: OFFER,
    finalUrl: page.url(),
    log,
    netAfterSubmit: net,
    consoleMsgs: consoleMsgs.slice(-40),
    pageErrors,
    elapsedMs: Date.now() - mark,
  };
  writeFileSync('/workspace/runner/output/probe-confirm.json', JSON.stringify(out, null, 1));
  console.log('===PROBE===');
  console.log(JSON.stringify(out, null, 1).slice(0, 12000));
});
