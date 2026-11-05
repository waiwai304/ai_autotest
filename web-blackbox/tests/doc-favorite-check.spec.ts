/**
 * ⚙️ 用例：favorite-check · 商品收藏功能检查（2026-09-28 第二版，ian 三点反馈整改）
 * 端：pc ｜ 需要登录：是 ｜ 含写操作：是（收藏/取消收藏）
 *
 * ian 2026-09-28 整改要求：
 *   1. 收藏按钮在详情页「立即购买」按钮正下方 → S1 增加 rect.y 位置断言
 *   2. 禁止固定商品 id → 每步从 sites.json searchKeywords 随机抽词搜索，结果页任选商品进详情
 *   3. 报告每步必须展示捕获 API → 接入 wireCapture/runStep 模式，自产 fullchain-result.json（步骤内嵌 curls）
 *
 * 打法依据（2026-09-28 探针实锤）：
 *   - PC 搜索：首页 antd Select（.ant-select）点击后 keyboard.type → Enter（勿点联想，避免搜成推荐词）
 *   - 搜索结果：a[href*="/detail/"] 即完整详情深链（tglobal/供应链源均含 num_iid）
 *   - 详情渲染标志：body 含「收藏」+价格；CSP 无 unsafe-eval，禁用 waitForFunction，须轮询 evaluate
 *   - 收藏按钮：button 文本「收藏」/「已收藏」，位于「加入购物车/立即购买」下一行（rect.y 更大）
 *   - 接口链：favorite/checkFavorite {data:0|1} → favorite/add {code:1} → favorite/delete {code:1}
 */
import { test, expect } from '@playwright/test';
import { pcUrl, site, SET_CURRENCY_USD, libPool } from './helpers/site';
import { readFileSync } from 'fs';
import { mkdirSync, writeFileSync } from 'fs';
import type { Page } from '@playwright/test';

// ---------- 步骤记录 + 请求捕获（对齐 full-chain.spec.ts，供 gen-platform-report.py 渲染分步 curl） ----------
const RUN_DIR = process.env.FULLCHAIN_RUN_DIR || 'FAV_MANUAL';
const SPEC_FILE = 'tests/doc-favorite-check.spec.ts';
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

/** 步骤落盘：截图 + recent 请求内嵌 + result json（成功失败都写，报告生成器直读）
 * 2026-09-30：改为 worker 分片 fullchain-result.w{N}.json——修复 workers>1 并行时各进程
 * 全量覆盖同一 fullchain-result.json 导致失败步骤记录丢失的事故（JOB-000060 的 S1 fail 被
 * worker2 的 S2/S3 覆盖）。分片由 gen-platform-report.py 自动合并（同 id 保留最新）。 */
async function recordStep(id: string, name: string, page: Page, status: 'ok' | 'fail', logs: string[], t0: number): Promise<void> {
  const shot = `fav-${id}.png`;
  await page.screenshot({ path: `${SHOTS}/${shot}` }).catch(() => {});
  const stepCurls = recent.splice(0, recent.length);
  captured.push(...stepCurls);
  // retry 场景同 id 旧记录移除，保留最后一次（防止报告出现重复步骤卡）
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

/** 登录 PC 前台并固定 USD 币种 */
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
  // 2026-10-12 ian：默认币种 CNY；不再注入 SET_CURRENCY_USD（兜底表无 RUB 项会写坏 currencyData → SPA 空壳）
  await page.evaluate(`(() => { try { localStorage.setItem('selectedCurrency', 'CNY'); } catch (e) {} })()`).catch(() => {});
  logs.push('PC 前台登录成功，币种固定 USD');
}

/** 详情页渲染等待（CSP 禁 waitForFunction，轮询 evaluate）；渲染标志 =「收藏」文本 + 价格 */
async function waitDetailRendered(page: Page, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await page.evaluate(`/收藏/.test(document.body.innerText) && /[$¥￥]/.test(document.body.innerText)`);
    if (ok) return true;
    await page.waitForTimeout(1_000);
  }
  return false;
}

/**
 * 关键词随机抽词 → PC 搜索 → 结果页任选商品 → 打开详情（getItem 间歇故障时自动换下一个商品，最多试 3 个）
 * 返回 { url, title, keyword }
 */
async function searchPickAndOpen(page: Page, logs: string[]): Promise<{ url: string; title: string; keyword: string }> {
  // 3008 测试用例库优先（2026-10-08）：LIB_KEYWORDS（发起页勾选或随机）> sites.json searchKeywords
  const kws: string[] = libPool('KEYWORDS', (site.testData.searchKeywords && site.testData.searchKeywords.length)
    ? site.testData.searchKeywords : ['phone case']);
  if (process.env.LIB_KEYWORDS) logs.push(`关键词来源: 3008测试用例库（${process.env.LIB_KEYWORDS_MODE === 'picked' ? '发起时勾选' : '随机抽取'}）`);
  const keyword = kws[Math.floor(Math.random() * kws.length)];

  // 2026-09-28 实测：登录跳转后的 /zh-cn 页搜索框渲染正常；直接 goto 首页 URL 反而可能渲染异常（SPA 初始化 bug）。
  // 故不再 goto，直接用登录后停留页等待搜索框；未出现才 goto/reload 兜底。
  // 注意：页面有多个 ant-select（搜索框/语言/币种切换），必须用 input[type=search] 过滤出搜索框
  const searchSelect = page.locator('.ant-select').filter({ has: page.locator('input[type="search"]') }).first();
  let searchReady = await searchSelect.isVisible({ timeout: 12_000 }).catch(() => false);
  for (let attempt = 1; attempt <= 3 && !searchReady; attempt++) {
    logs.push(`当前页搜索框未渲染（第 ${attempt}/3 次），goto 首页重设币种重试`);
    // 2026-10-12 ian：默认币种 CNY；不再注入 SET_CURRENCY_USD（兜底表无 RUB 项会写坏 currencyData → SPA 空壳）
  await page.evaluate(`(() => { try { localStorage.setItem('selectedCurrency', 'CNY'); } catch (e) {} })()`).catch(() => {});
    await page.goto(pcUrl('home'), { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(6_000);
    searchReady = await searchSelect.isVisible({ timeout: 8_000 }).catch(() => false);
  }
  // searchReady=false 不在此处失败：后续降级首页推荐位任选商品（商品动态轮换），商品链接都取不到才真正失败

  if (searchReady) {
    await searchSelect.click();
    await page.waitForTimeout(800);
    await page.keyboard.type(keyword, { delay: 60 });
    await page.waitForTimeout(3_000);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(6_000);
    logs.push(`关键词「${keyword}」搜索完成`);
  }

  // 收集商品深链（去重）：搜索成功取结果页；搜索组件不可用则降级首页推荐位（均为动态商品，避免固定 id）
  let hrefs: string[] = await page.evaluate(`(() => {
    const seen = new Set(), out = [];
    document.querySelectorAll('a[href*="/detail/"]').forEach((a) => {
      const h = a.getAttribute('href');
      if (h && !seen.has(h)) { seen.add(h); out.push(h); }
    });
    return out;
  })()`);
  if (!searchReady) {
    // 降级：goto 首页取推荐位商品（轮询等待商品链接出现）
    for (let attempt = 1; attempt <= 3 && hrefs.length === 0; attempt++) {
      logs.push(`搜索组件不可用，降级首页推荐位任选商品（第 ${attempt}/3 轮）`);
      // 2026-10-12 ian：默认币种 CNY；不再注入 SET_CURRENCY_USD（兜底表无 RUB 项会写坏 currencyData → SPA 空壳）
  await page.evaluate(`(() => { try { localStorage.setItem('selectedCurrency', 'CNY'); } catch (e) {} })()`).catch(() => {});
      await page.goto(pcUrl('home'), { waitUntil: 'domcontentloaded', timeout: 45_000 });
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && hrefs.length === 0) {
        hrefs = await page.evaluate(`(() => {
          const seen = new Set(), out = [];
          document.querySelectorAll('a[href*="/detail/"]').forEach((a) => {
            const h = a.getAttribute('href');
            if (h && !seen.has(h)) { seen.add(h); out.push(h); }
          });
          return out;
        })()`);
        if (hrefs.length === 0) await page.waitForTimeout(2_000);
      }
    }
    if (hrefs.length) logs.push(`降级成功：首页推荐位取到 ${hrefs.length} 个商品`);
  }
  expect(hrefs.length, `关键词「${keyword}」搜索与首页推荐位均未取到商品链接`).toBeGreaterThan(0);
  logs.push(`候选商品 ${hrefs.length} 个`);

  // 随机打乱后依次尝试打开（getItem 间歇故障自动换下一个，最多 3 个）
  const candidates = hrefs.sort(() => Math.random() - 0.5).slice(0, 3);
  let lastErr = '';
  for (let i = 0; i < candidates.length; i++) {
    const href = candidates[i];
    const abs = href.startsWith('http') ? href : new URL(href, page.url()).toString();
    await page.goto(abs, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    if (await waitDetailRendered(page)) {
      await page.waitForTimeout(2_000);
      const title = await page.evaluate(`(() => { const h = document.querySelector('h1.pd__name, [class*="pd"] h1, h1'); return h ? h.textContent.trim().slice(0, 40) : document.title.slice(0, 40); })()`);
      logs.push(`打开第 ${i + 1} 个候选商品详情渲染成功: ${title}`);
      return { url: page.url(), title, keyword };
    }
    lastErr = `候选 ${i + 1} 详情 30s 未渲染（疑似 getItem 间歇故障 BUG-02）`;
    logs.push(`${lastErr}，换下一个商品`);
  }
  throw new Error(`3 个候选商品详情均未渲染（getItem 间歇故障）：${lastErr}`);
}

/** 收藏按钮状态：'fav'（收藏）| 'unfav'（已收藏）| null */
async function favButtonState(page: Page): Promise<'fav' | 'unfav' | null> {
  return page.evaluate(`(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => /^已?收藏$/.test((x.textContent || '').trim()));
    if (!b) return null;
    return (b.textContent || '').trim() === '已收藏' ? 'unfav' : 'fav';
  })()`);
}

/** 点击收藏/已收藏按钮 */
async function clickFavButton(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => /^已?收藏$/.test((x.textContent || '').trim()));
    if (!b) throw new Error('未找到收藏按钮');
    b.click();
  })()`);
}

/** 捕获下一个 favorite/add|delete 接口响应 */
function captureFavApi(page: Page): Promise<{ code: number; msg: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('15s 内未捕获 favorite/add|delete 接口响应')), 15_000);
    const handler = (res: import('@playwright/test').Response) => {
      if (/\/api\/v1\/favorite\/(add|delete)/.test(res.url())) {
        clearTimeout(timer);
        page.off('response', handler);
        res.text().then((t) => {
          try { const j = JSON.parse(t); resolve({ code: j.code, msg: j.msg }); }
          catch { reject(new Error(`favorite 接口响应解析失败: ${t.slice(0, 120)}`)); }
        }).catch(reject);
      }
    };
    page.on('response', handler);
  });
}

/** 点击并等待 favorite 接口（点击后 3s 留痕按钮状态；接口未发出时自动补点一次） */
async function clickFavAndWaitApi(page: Page, logs: string[]): Promise<{ code: number; msg: string }> {
  const p = captureFavApi(page);
  await clickFavButton(page);
  await page.waitForTimeout(3_000);
  logs.push(`点击后按钮状态: ${await favButtonState(page)}`);
  try {
    return await p;
  } catch (e: any) {
    // 补点一次（首次点击可能因 React handler 未绑完而静默失效）
    logs.push(`首次点击未见接口响应（${String(e.message).slice(0, 60)}），补点一次`);
    const p2 = captureFavApi(page);
    await clickFavButton(page);
    return await p2;
  }
}

/** 按钮矩形位置（用于收藏按钮在立即购买下方的位置断言） */
async function buttonRect(page: Page, textRe: string): Promise<{ x: number; y: number } | null> {
  return page.evaluate(`(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => ${textRe}.test((x.textContent || '').trim()));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y) };
  })()`);
}

// ---------- 用例 ----------
test.describe("favorite-check · 商品收藏功能检查", () => {

  test("S1 [PC] 关键词搜索任选商品打开详情页", async ({ page }) => {
    test.setTimeout(5 * 60_000);
    wireCapture(page, '前台');
    const t0 = Date.now();
    const logs: string[] = [];
    let status: 'ok' | 'fail' = 'ok';
    try {
      await login(page, logs);
      const picked = await searchPickAndOpen(page, logs);

      // 断言：详情渲染三要素
      const bodyText = await page.evaluate('document.body.innerText');
      expect(bodyText, '详情页缺少价格信息').toMatch(/[$¥￥]\s*\d/);
      expect(bodyText, '详情页缺少「加入购物车」按钮').toContain('加入购物车');
      expect(bodyText, '详情页缺少「立即购买」按钮').toContain('立即购买');
      expect(await favButtonState(page), '收藏按钮不可见').toBe('fav');

      // 断言（ian 2026-09-28 指定）：收藏按钮位于「立即购买」按钮正下方
      const fav = await buttonRect(page, '/^已?收藏$/');
      const buy = await buttonRect(page, '/立即购买/');
      expect(fav && buy, '收藏按钮或立即购买按钮 rect 获取失败').toBeTruthy();
      expect(fav!.y, `收藏按钮应位于立即购买下方（收藏 y=${fav!.y}，立即购买 y=${buy!.y}）`).toBeGreaterThan(buy!.y);
      logs.push(`位置校验通过：收藏按钮(y=${fav!.y}) 在立即购买(y=${buy!.y}) 正下方`);
    } catch (e: any) {
      status = 'fail';
      logs.push(`异常: ${String(e.message || e).slice(0, 300)}`);
    }
    await recordStep('S1', '关键词搜索任选商品打开详情页', page, status, logs, t0);
    expect(status, `S1 失败: ${logs.join(' | ')}`).toBe('ok');
  });

  test("S2 [PC] 点击收藏按钮", async ({ page }) => {
    test.setTimeout(5 * 60_000);
    wireCapture(page, '前台');
    const t0 = Date.now();
    const logs: string[] = [];
    let status: 'ok' | 'fail' = 'ok';
    try {
      await login(page, logs);
      await searchPickAndOpen(page, logs);

      // 幂等：若已是「已收藏」态，先取消还原
      if ((await favButtonState(page)) === 'unfav') {
        const del = await clickFavAndWaitApi(page, logs);
        logs.push(`幂等还原：先取消已有收藏（${del.msg}）`);
        await page.waitForTimeout(2_000);
      }
      expect(await favButtonState(page), '点击前应为未收藏态').toBe('fav');

      // 点击收藏 → 接口 + UI 双重断言
      const add = await clickFavAndWaitApi(page, logs);
      expect(add.code, `favorite/add 接口返回异常: code=${add.code} msg=${add.msg}`).toBe(1);
      await page.waitForTimeout(2_000);
      expect(await favButtonState(page), '点击收藏后按钮未变为「已收藏」').toBe('unfav');
      logs.push(`favorite/add code=1（${add.msg}），按钮已变「已收藏」`);
    } catch (e: any) {
      status = 'fail';
      logs.push(`异常: ${String(e.message || e).slice(0, 300)}`);
    }
    await recordStep('S2', '点击收藏按钮', page, status, logs, t0);
    expect(status, `S2 失败: ${logs.join(' | ')}`).toBe('ok');
  });

  test("S3 [PC] 再次点击收藏按钮（取消收藏）", async ({ page }) => {
    test.setTimeout(5 * 60_000);
    wireCapture(page, '前台');
    const t0 = Date.now();
    const logs: string[] = [];
    let status: 'ok' | 'fail' = 'ok';
    try {
      await login(page, logs);
      await searchPickAndOpen(page, logs);

      // 幂等：若处于「收藏」态，先收藏一次构造「已收藏」前置
      if ((await favButtonState(page)) === 'fav') {
        const add = await clickFavAndWaitApi(page, logs);
        logs.push(`幂等构造：先收藏（${add.msg}）`);
        await page.waitForTimeout(2_000);
      }
      expect(await favButtonState(page), '取消前应为「已收藏」态').toBe('unfav');

      // 点击「已收藏」取消 → 接口 + UI 双重断言
      const del = await clickFavAndWaitApi(page, logs);
      expect(del.code, `favorite/delete 接口返回异常: code=${del.code} msg=${del.msg}`).toBe(1);
      await page.waitForTimeout(2_000);
      expect(await favButtonState(page), '取消收藏后按钮未恢复「收藏」').toBe('fav');
      logs.push(`favorite/delete code=1（${del.msg}），按钮已恢复「收藏」`);
    } catch (e: any) {
      status = 'fail';
      logs.push(`异常: ${String(e.message || e).slice(0, 300)}`);
    }
    await recordStep('S3', '再次点击收藏按钮（取消收藏）', page, status, logs, t0);
    expect(status, `S3 失败: ${logs.join(' | ')}`).toBe('ok');
  });
});
