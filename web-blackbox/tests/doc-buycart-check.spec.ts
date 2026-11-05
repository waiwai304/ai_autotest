/**
 * ⚙️ 用例：buycart-check · 商品加购功能检查（2026-09-30 v2 适配前台改版，ian：报告卡首页排查）
 * 端：pc ｜ 需要登录：是 ｜ 含写操作：是（加入购物车）
 *
 * 2026-09-30 站点改版适配（探针实锤，scripts/probe-home-goods.ts）：
 *   - 首页已改版为纯营销页：无 /detail/ 商品链接（购物时报区块纯展示），旧「降级首页推荐位」路径已死
 *   - 搜索框：antd Select → 原生 input[placeholder="输入商品名称/链接"]（第 1 个常 hidden，用 nth(1)）
 *   - 搜索：fill + Enter → /zh-cn/search?q=<kw>&page=1&platform=market → a[href*="/detail"]（20 个）
 *   - 详情页 CTA 行 = [立即购买(文本)][加购(纯图标按钮)][收藏(纯图标按钮)]——加购 = 立即购买的 nextElementSibling
 *   - 购物车页：pcUrl('cart') = /zh-cn/dashboard/cart（页头徽标入口）
 * 加购成功双证据：POST /api/*cart* code=1 ｜ 页头购物车徽标数字增加
 * 步骤记录：recordStep worker 分片 fullchain-result.w{N}.json（并行安全，gen-platform-report.py 自动合并）
 */
import { test, expect } from '@playwright/test';
import { pcUrl, site, libPool } from './helpers/site';
import { readFileSync } from 'fs';
import { mkdirSync, writeFileSync } from 'fs';
import type { Page } from '@playwright/test';

// ---------- 步骤记录 + 请求捕获（对齐 doc-favorite-check.spec.ts） ----------
const RUN_DIR = process.env.FULLCHAIN_RUN_DIR || 'BUYCART_MANUAL';
const SPEC_FILE = 'tests/doc-buycart-check.spec.ts';
const SHOTS = `output/html-report/${RUN_DIR}/screenshots`;
const DATA = `output/${RUN_DIR}`;
mkdirSync(SHOTS, { recursive: true });
mkdirSync(DATA, { recursive: true });

type CapturedReq = { side: string; method: string; url: string; status: number; curl: string };
type StepRec = { id: string; name: string; side: string; status: 'ok' | 'fail'; logs: string[]; shot: string; startedAt: string; ms: number; curls?: CapturedReq[] };
const steps: StepRec[] = [];
let captured: CapturedReq[] = [];
const recent: CapturedReq[] = [];

function toCurl(req: { method(): string; url(): string; headers(): Record<string, string>; postData(): string | null }): string {
  const m = req.method();
  const u = req.url();
  const hs = req.headers();
  const body = req.postData();
  let c = `curl -sk -X ${m} '${u}'`;
  for (const [k, v] of Object.entries(hs)) {
    if (['host', 'content-length', 'connection'].includes(k.toLowerCase())) continue;
    c += ` \\\n  -H '${k}: ${v}'`;
  }
  if (body) c += ` \\\n  --data-raw '${body.slice(0, 2000).replace(/'/g, "'\\''")}'`;
  return c;
}

function wireCapture(page: Page, side: string) {
  page.on('response', (r) => {
    const req = r.request();
    const url = req.url();
    if (!url.includes('/api/')) return;
    if (/\.(png|jpg|jpeg|css|js|woff2?|gif|svg|ico)(\?|$)/.test(url)) return;
    try {
      recent.push({ side, method: req.method(), url, status: r.status(), curl: toCurl(req) });
      if (recent.length > 400) recent.shift();
    } catch { /* 忽略 */ }
  });
}

/** 步骤落盘：截图 + recent 请求内嵌 + worker 分片 result json（成功失败都写，报告生成器直读合并） */
async function recordStep(id: string, name: string, page: Page, status: 'ok' | 'fail', logs: string[], t0: number): Promise<void> {
  const shot = `cart-${id}.png`;
  await page.screenshot({ path: `${SHOTS}/${shot}` }).catch(() => {});
  const stepCurls = recent.splice(0, recent.length);
  captured.push(...stepCurls);
  const idx = steps.findIndex((s) => s.id === id);
  if (idx >= 0) steps.splice(idx, 1);
  steps.push({ id, name, side: '前台', status, logs, shot, startedAt: new Date(t0).toISOString(), ms: Date.now() - t0, curls: stepCurls });
  const sliceFile = `${DATA}/fullchain-result.w${test.info().workerIndex}.json`;
  writeFileSync(sliceFile, JSON.stringify({
    runTag: RUN_DIR, time: new Date().toISOString(), spec: SPEC_FILE,
    passed: steps.filter((s) => s.status === 'ok').length, total: steps.length,
    steps, capturedCount: captured.length,
  }, null, 2));
  console.log(`[${id}] ${status} ${name} (${Date.now() - t0}ms)`, logs.slice(-2).join(' | '));
}

// ---------- 业务 helper ----------
function frontAccount(): { account: string; password: string } {
  const envTxt = readFileSync('.env', 'utf-8');
  return {
    account: process.env.SITE_FRONT_ACCOUNT || /^TEST_TEST_ACCOUNT=(.*)$/m.exec(envTxt)?.[1]?.trim() || '',
    password: process.env.SITE_FRONT_PASSWORD || /^TEST_TEST_PASSWORD=(.*)$/m.exec(envTxt)?.[1]?.trim() || '',
  };
}

/** 登录 PC 前台 */
async function login(page: Page, logs: string[]): Promise<void> {
  const { account, password } = frontAccount();
  expect(account, '未配置前台测试账号').toBeTruthy();
  await page.goto(pcUrl('login'), { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(3_000);
  await page.locator('input[name="email"]').fill(account);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).first().click();
  await page.waitForTimeout(6_000);
  expect(!/login/.test(page.url()), `登录失败，仍停留 ${page.url()}`).toBeTruthy();
  logs.push('PC 前台登录成功');
}

/** 详情页渲染等待（CSP 禁 waitForFunction，轮询 evaluate）；新版渲染标志 =「立即购买」+ 价格（$¥￥₽） */
async function waitDetailRendered(page: Page, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await page.evaluate(`/立即购买/.test(document.body.innerText) && /[$¥￥₽€£]\\s*\\d|\\d[\\d,.]*\\s*[$¥￥₽]/.test(document.body.innerText)`);
    if (ok) return true;
    await page.waitForTimeout(1_000);
  }
  return false;
}

/**
 * 新版搜索取商品（2026-09-30 改版适配）：
 * 原生搜索框 input[placeholder*="商品名称"]（nth(1) 可见；nth(0) 常为折叠态 hidden）
 * → fill 关键词 + Enter → /zh-cn/search?q=… → a[href*="/detail"] 候选（随机取 3 个，渲染失败自动换）
 */
async function searchPickAndOpen(page: Page, logs: string[]): Promise<{ url: string; title: string; keyword: string }> {
  // 3008 测试用例库优先（2026-10-09）：LIB_KEYWORDS（发起页勾选或随机）> sites.json searchKeywords
  const kws: string[] = libPool('KEYWORDS', (site.testData.searchKeywords && site.testData.searchKeywords.length)
    ? site.testData.searchKeywords : ['phone case']);
  if (process.env.LIB_KEYWORDS) logs.push(`关键词来源: 3008测试用例库（${process.env.LIB_KEYWORDS_MODE === 'picked' ? '发起时勾选' : '随机抽取'}）: ${kws.join(' / ')}`);
  const keyword = kws[Math.floor(Math.random() * kws.length)];

  let input = page.locator('input[placeholder*="商品名称"]').nth(1);
  if (!(await input.isVisible({ timeout: 8_000 }).catch(() => false))) {
    // 兜底：goto 首页重试（登录后停留页偶发未挂载）
    await page.goto(pcUrl('home'), { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(5_000);
    input = page.locator('input[placeholder*="商品名称"]').nth(1);
    if (!(await input.isVisible({ timeout: 8_000 }).catch(() => false))) {
      input = page.locator('input[placeholder*="商品名称"]').first();
      expect(await input.isVisible(), '新版搜索框 input[placeholder*="商品名称"] 未渲染').toBeTruthy();
    }
  }

  await input.fill(keyword);
  await page.waitForTimeout(800);
  await input.press('Enter');
  await page.waitForTimeout(8_000);
  expect(/\/search|\/detail/.test(page.url()), `搜索后未进入结果页: ${page.url().slice(0, 90)}`).toBeTruthy();
  logs.push(`关键词「${keyword}」搜索完成 → ${page.url().split('?')[0].split('/').pop()}页`);

  let hrefs: string[] = [];
  for (let i = 0; i < 10 && hrefs.length === 0; i++) {
    hrefs = await page.evaluate(`(() => {
      const seen = new Set(), out = [];
      document.querySelectorAll('a[href*="/detail"]').forEach((a) => {
        const h = a.getAttribute('href');
        if (h && !seen.has(h)) { seen.add(h); out.push(h); }
      });
      return out;
    })()`);
    if (hrefs.length === 0) await page.waitForTimeout(2_000);
  }
  expect(hrefs.length, `搜索结果页未取到 /detail/ 商品链接（关键词「${keyword}」）`).toBeGreaterThan(0);
  logs.push(`搜索结果候选商品 ${hrefs.length} 个`);

  const candidates = hrefs.sort(() => Math.random() - 0.5).slice(0, 3);
  let lastErr = '';
  for (let i = 0; i < candidates.length; i++) {
    const href = candidates[i];
    const abs = href.startsWith('http') ? href : new URL(href, page.url()).toString();
    await page.goto(abs, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    if (await waitDetailRendered(page)) {
      await page.waitForTimeout(2_000);
      const title = await page.evaluate(`(() => {
        const h = document.querySelector('h1, [class*="title"] h1, [class*="pd__name"]');
        return h ? h.textContent.trim().slice(0, 40) : document.title.slice(0, 40);
      })()`);
      logs.push(`打开第 ${i + 1} 个候选商品详情渲染成功: ${title}`);
      return { url: page.url(), title, keyword };
    }
    lastErr = `候选 ${i + 1} 详情 30s 未渲染`;
    logs.push(`${lastErr}，换下一个商品`);
  }
  throw new Error(`3 个候选商品详情均未渲染：${lastErr}`);
}

/** CTA 行按钮：[立即购买(文本)][加购(图标)][收藏(图标)]——新版加购无文本，取「立即购买」的 nextElementSibling */
async function clickAddCartButton(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    const buy = Array.from(document.querySelectorAll('button')).find((x) => /立即购买/.test((x.textContent || '').trim()));
    if (!buy) throw new Error('未找到「立即购买」按钮（无法定位 CTA 行）');
    const add = buy.nextElementSibling;
    if (!add || add.tagName !== 'BUTTON') throw new Error('「立即购买」旁未找到加购图标按钮');
    add.click();
  })()`);
}

/** 捕获加购接口响应（POST /api/*cart*），返回 {code,msg,url} */
function captureCartApi(page: Page): Promise<{ code: number; msg: string; url: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('15s 内未捕获加购接口响应')), 15_000);
    const handler = (res: import('@playwright/test').Response) => {
      if (/\/api\/[^?]*cart/i.test(res.url()) && res.request().method() === 'POST') {
        clearTimeout(timer);
        page.off('response', handler);
        res.text().then((t) => {
          try { const j = JSON.parse(t); resolve({ code: j.code, msg: j.msg ?? '', url: res.url() }); }
          catch { reject(new Error(`加购接口响应解析失败: ${t.slice(0, 120)}`)); }
        }).catch(reject);
      }
    };
    page.on('response', handler);
  });
}

/** 页头购物车徽标数字（加购成功 UI 证据；无徽标返回 -1） */
async function cartBadge(page: Page): Promise<number> {
  return page.evaluate(`(() => {
    const a = document.querySelector('a[href*="/dashboard/cart"], a[href*="cart"]');
    if (!a) return -1;
    const m = (a.textContent || '').match(/\\d+/);
    return m ? parseInt(m[0], 10) : -1;
  })()`);
}

/** 收集页面 toast 文本（辅助证据） */
async function toastText(page: Page): Promise<string> {
  return page.evaluate(`(() => Array.from(document.querySelectorAll('[class*="message"], [class*="toast"], [class*="notice"], [role="alert"]'))
    .map((x) => (x.textContent || '').trim()).filter((t) => t && t.length < 80).join('；').slice(0, 200))()`);
}

/** 加购并双证据校验（S2/S3 共用）：接口 code=1 ｜ 徽标 +1 */
async function addCartAndVerify(page: Page, logs: string[]): Promise<void> {
  const badgeBefore = await cartBadge(page);
  const p = captureCartApi(page);
  await clickAddCartButton(page);
  await page.waitForTimeout(3_000);
  const toast = await toastText(page);
  if (toast) logs.push(`页面提示: ${toast}`);

  let apiOk = false;
  try {
    const r = await p;
    logs.push(`加购接口 ${r.url.split('?')[0].split('/').slice(-2).join('/')}: code=${r.code}${r.msg ? `（${r.msg}）` : ''}`);
    expect(r.code, `加购接口返回异常: code=${r.code} msg=${r.msg}`).toBe(1);
    apiOk = true;
  } catch (e: any) {
    // 补点一次（React handler 未绑完首次点击可能静默失效）
    logs.push(`首次点击未捕获加购接口（${String(e.message).slice(0, 60)}），补点一次`);
    const p2 = captureCartApi(page);
    await clickAddCartButton(page);
    await page.waitForTimeout(3_000);
    try {
      const r = await p2;
      logs.push(`加购接口(补点): code=${r.code}（${r.msg}）`);
      expect(r.code).toBe(1);
      apiOk = true;
    } catch (e2: any) {
      logs.push(`接口捕获失败: ${String(e2.message).slice(0, 100)}`);
    }
  }

  // UI 证据：徽标数字增加
  await page.waitForTimeout(2_000);
  const badgeAfter = await cartBadge(page);
  if (badgeBefore >= 0 && badgeAfter >= 0) {
    logs.push(`购物车徽标: ${badgeBefore} → ${badgeAfter}`);
    if (badgeAfter > badgeBefore) return; // UI 证据成立
  }
  expect(apiOk, '加购失败：接口未返回 code=1 且购物车徽标未增加').toBeTruthy();
}

// ---------- 用例 ----------
test.describe("buycart-check · 商品加购功能检查", () => {

  test("S1 [PC] 打开任意商品详情页", async ({ page }) => {
    test.setTimeout(5 * 60_000);
    wireCapture(page, '前台');
    const t0 = Date.now();
    const logs: string[] = [];
    let status: 'ok' | 'fail' = 'ok';
    try {
      await login(page, logs);
      const picked = await searchPickAndOpen(page, logs);

      const bodyText = await page.evaluate('document.body.innerText');
      expect(bodyText, '详情页缺少「立即购买」按钮').toContain('立即购买');
      expect(bodyText, '详情页缺少价格信息').toMatch(/[$¥￥₽€£]\s*\d|\d[\d,.]*\s*[$¥￥₽]/);
      // 新版加购按钮为纯图标（CTA 行「立即购买」右侧），验证其存在
      const hasAddBtn = await page.evaluate(`(() => {
        const buy = Array.from(document.querySelectorAll('button')).find((x) => /立即购买/.test((x.textContent || '').trim()));
        return !!(buy && buy.nextElementSibling && buy.nextElementSibling.tagName === 'BUTTON');
      })()`);
      expect(hasAddBtn, 'CTA 行「立即购买」旁未找到加购图标按钮').toBeTruthy();
      logs.push(`详情页校验通过（立即购买/价格/加购图标按钮），商品「${picked.title}」`);
    } catch (e: any) {
      status = 'fail';
      logs.push(`异常: ${String(e.message || e).slice(0, 300)}`);
    }
    await recordStep('S1', '打开任意商品详情页', page, status, logs, t0);
    expect(status, `S1 失败: ${logs.join(' | ')}`).toBe('ok');
  });

  test("S2 [PC] 点击加购按钮", async ({ page }) => {
    test.setTimeout(5 * 60_000);
    wireCapture(page, '前台');
    const t0 = Date.now();
    const logs: string[] = [];
    let status: 'ok' | 'fail' = 'ok';
    try {
      await login(page, logs);
      const picked = await searchPickAndOpen(page, logs);
      await addCartAndVerify(page, logs);
      logs.push(`商品「${picked.title}」加入购物车成功`);
    } catch (e: any) {
      status = 'fail';
      logs.push(`异常: ${String(e.message || e).slice(0, 300)}`);
    }
    await recordStep('S2', '点击加购按钮', page, status, logs, t0);
    expect(status, `S2 失败: ${logs.join(' | ')}`).toBe('ok');
  });

  test("S3 [PC] 访问/zh-cn/dashboard/cart页面", async ({ page }) => {
    test.setTimeout(6 * 60_000);
    wireCapture(page, '前台');
    const t0 = Date.now();
    const logs: string[] = [];
    let status: 'ok' | 'fail' = 'ok';
    try {
      await login(page, logs);
      const picked = await searchPickAndOpen(page, logs);

      // 前置：先加购本商品（保证「刚才加购的」成立；已在购物车则徽标不变、接口幂等）
      await addCartAndVerify(page, logs).catch((e) => logs.push(`前置加购跳过: ${String(e.message).slice(0, 80)}`));

      await page.goto(pcUrl('cart'), { waitUntil: 'domcontentloaded', timeout: 45_000 });
      let cartText = '';
      for (let i = 0; i < 15; i++) {
        await page.waitForTimeout(2_000);
        cartText = await page.evaluate('document.body.innerText');
        if (/删除|全选|合计|去结算|批量/.test(cartText) && cartText.length > 100) break;
      }
      expect(/dashboard\/cart|购物车/.test(page.url() + cartText), `购物车页未渲染: ${page.url().slice(0, 80)}`).toBeTruthy();

      const nameKey = (picked.title || '').replace(/\s+/g, '').slice(0, 8);
      const flat = cartText.replace(/\s+/g, '');
      if (nameKey) {
        expect(flat.includes(nameKey), `购物车列表未见刚加购商品「${picked.title}」`).toBeTruthy();
        logs.push(`购物车列表包含刚加购商品「${picked.title}」✓`);
      } else {
        expect(flat.length > 150, '购物车列表为空').toBeTruthy();
        logs.push('购物车列表非空（商品名缺失，仅验证列表渲染）');
      }
    } catch (e: any) {
      status = 'fail';
      logs.push(`异常: ${String(e.message || e).slice(0, 300)}`);
    }
    await recordStep('S3', '访问/zh-cn/dashboard/cart页面', page, status, logs, t0);
    expect(status, `S3 失败: ${logs.join(' | ')}`).toBe('ok');
  });
});
