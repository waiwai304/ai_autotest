import { test, expect } from '@playwright/test';

/**
 * 通用网站冒烟（2026-11-04 ian）
 * 适用：任意官网 / 企业站 / 非 OneBuy 结构的站点（站点档案 generic-web）。
 * 不依赖 OneBuy 的商品、导航、接口约定，只做「能打开、有内容、无严重前端错误」的基础可用性校验。
 * 站点域名来自平台注入：SITE_PC_BASE_URL > BASE_URL > playwright.config baseURL。
 */

const RAW = (process.env.SITE_PC_BASE_URL || process.env.BASE_URL || '').trim();
const HOME = process.env.GENERIC_HOME_PATH || '/';

function homeUrl(base: string): string {
  const b = (base || '').replace(/\/+$/, '');
  const p = HOME.startsWith('/') ? HOME : `/${HOME}`;
  return p === '/' ? `${b}/` : `${b}${p}`;
}

test.describe('通用网站冒烟', () => {
  test('首页可访问且有内容', async ({ page, baseURL }) => {
    const base = RAW || baseURL || '';
    expect(base, '未拿到站点域名（SITE_PC_BASE_URL / BASE_URL / playwright baseURL 均为空）').toBeTruthy();
    const url = homeUrl(base);

    const t0 = Date.now();
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const ms = Date.now() - t0;
    expect(resp, `${url} 未产生主文档响应（域名/DNS/证书问题）`).not.toBeNull();
    console.log(`[G1] ok 首页打开 ${url} HTTP=${resp!.status()} ${ms}ms`);

    expect(resp!.status(), `首页 HTTP 状态异常 ${resp!.status()}（5xx=服务端错误，403=WAF/防盗链，404=路径不对）`).toBeLessThan(400);
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });

    const info = await page.evaluate(`(() => {
      const body = (document.body && document.body.innerText) || '';
      const links = Array.from(document.querySelectorAll('a[href]')).filter(a => (a.getAttribute('href') || '').trim().length > 0);
      const imgs = Array.from(document.images);
      return JSON.stringify({
        title: document.title || '',
        bodyLen: body.length,
        bodyHead: body.slice(0, 200),
        links: links.length,
        imgs: imgs.length,
        brokenImgs: imgs.filter(i => i.complete && i.naturalWidth === 0).length,
        lang: document.documentElement.lang || '',
      });
    })()`).catch(() => '{}');
    const d: any = JSON.parse(String(info) || '{}');
    console.log(`[G2] ok 页面内容 title="${String(d.title).slice(0, 60)}" bodyLen=${d.bodyLen} links=${d.links} imgs=${d.imgs} brokenImgs=${d.brokenImgs}`);

    expect(String(d.title || '').trim().length, '页面 title 为空（模板异常/首页是空壳）').toBeGreaterThan(0);
    expect(Number(d.bodyLen || 0), `首页正文过短 bodyLen=${d.bodyLen}（白屏/骨架屏/被拦截），开头：${String(d.bodyHead).slice(0, 120)}`).toBeGreaterThan(80);
    expect(Number(d.links || 0), '首页没有任何可点击链接（渲染失败或纯图片页）').toBeGreaterThan(0);
  });

  test('关键静态资源可加载且无严重前端错误', async ({ page, baseURL }) => {
    const base = RAW || baseURL || '';
    const url = homeUrl(base);
    const failed: string[] = [];
    const errors: string[] = [];
    const badResponses: string[] = [];

    page.on('requestfailed', (r) => {
      const u = r.url();
      if (/\.(png|jpe?g|gif|svg|webp|css|js|woff2?)(\?|$)/i.test(u)) failed.push(`${u.slice(0, 120)} (${r.failure()?.errorText || ''})`);
    });
    page.on('response', (r) => {
      const u = r.url();
      if (r.status() >= 400 && /\.(png|jpe?g|gif|svg|webp|css|js|woff2?)(\?|$)/i.test(u)) badResponses.push(`${r.status()} ${u.slice(0, 120)}`);
    });
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(5000);

    const ignored = [/favicon/i, /third[- ]party cookie/i, /ERR_BLOCKED_BY_CLIENT/i, /net::ERR_ABORTED/i];
    const uniq = (arr: string[]) => Array.from(new Set(arr));
    // 2026-11-04 ian：区分「真实 JS 错误」与「第三方资源 403/404」——后者浏览器只给一句
    // "Failed to load resource: 403" 不带 URL，重复几十条会误杀（aiyueju.cn 15 条实录），
    // 资源层失败已由 requestfailed / response 监听带 URL 单独统计。
    const isResErr = (m: string) => /Failed to load resource/i.test(m);
    const seriousErrors = uniq(errors.filter((m) => !ignored.some((p) => p.test(m)) && !isResErr(m)));
    const resConsoleErrors = uniq(errors.filter((m) => !ignored.some((p) => p.test(m)) && isResErr(m)));
    const seriousFailed = uniq(failed.filter((m) => !ignored.some((p) => p.test(m)) && !/favicon/i.test(m)));
    const badResponsesU = uniq(badResponses);

    console.log(`[G3] 资源失败=${seriousFailed.length} 4xx/5xx=${badResponsesU.length} JS错误=${seriousErrors.length} 资源403/404=${resConsoleErrors.length}`);
    if (seriousFailed.length) console.log(`[G3] 失败资源样例: ${seriousFailed.slice(0, 3).join(' | ')}`);
    if (badResponsesU.length) console.log(`[G3] 异常响应样例: ${badResponsesU.slice(0, 3).join(' | ')}`);
    if (seriousErrors.length) console.log(`[G3] JS错误样例: ${seriousErrors.slice(0, 3).join(' | ')}`);

    // 阈值：①关键资源请求失败 ≤5 ②JS/页面致命错误 ≤5 ③第三方资源 403/404 提示 ≤20（噪音，不计致命）
    expect(seriousFailed.length, `关键资源加载失败 ${seriousFailed.length} 条（样例：${seriousFailed.slice(0, 3).join(' | ')}）`).toBeLessThan(6);
    expect(seriousErrors.length, `页面/控制台致命错误 ${seriousErrors.length} 条（样例：${seriousErrors.slice(0, 3).join(' | ')}）`).toBeLessThan(6);
    expect(resConsoleErrors.length, `资源 4xx/5xx 过多 ${resConsoleErrors.length} 条（多为第三方统计/图片防盗链，需人工确认）`).toBeLessThan(21);
  });
});
