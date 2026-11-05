// 探针：二期通用原语真跑（onebound 官网，非商城结构）
// hover_text → click_text 子项 → expect_url → scroll_to_text
import { chromium } from '@playwright/test';

const b = await chromium.launch();
const page = await b.newPage();
const logs = [];
const out = (name, ok, detail = '') => console.log(`[${ok ? 'ok' : 'FAIL'}] ${name}${detail ? ' ' + detail : ''}`);
try {
  // S1 首页
  await page.goto('https://onebound.cn/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3000);
  out('S1 openHome', true, page.url().slice(0, 50));

  // S2 hover 产品与服务（下拉导航）
  const nav = page.locator('a, button, li, span').filter({ hasText: '产品与服务' }).first();
  if (!await nav.count()) throw new Error('S2 找不到「产品与服务」');
  await nav.hover({ timeout: 8000 });
  await page.waitForTimeout(1200);
  out('S2 hover_text', true, '已悬停「产品与服务」');

  // S3 点击下拉子项「青舰海淘代购系统」
  const sub = page.locator('a:visible', { hasText: '青舰海淘代购系统' }).first();
  await sub.click({ timeout: 8000 });
  await page.waitForTimeout(2500);
  out('S3 click_text 子项', true, page.url().slice(0, 60));

  // S4 URL 断言
  const url = page.url();
  if (!url.includes('daigou')) throw new Error(`URL 不含 daigou: ${url}`);
  out('S4 expect_url', true, url.slice(0, 60));

  // S5 回首页滚动定位懒加载文本
  await page.goto('https://onebound.cn/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const loc = page.locator('text=我们的使命').first();
  let seen = await loc.isVisible().catch(() => false);
  for (let i = 0; i < 10 && !seen; i++) { await page.mouse.wheel(0, 900); await page.waitForTimeout(600); seen = await loc.isVisible().catch(() => false); }
  if (!seen) throw new Error('滚动后未见「我们的使命」');
  out('S5 scroll_to_text', true, '已滚动定位');
  process.exitCode = 0;
} catch (e) {
  out('FAIL', false, String(e.message || e).slice(0, 200));
  process.exitCode = 1;
} finally {
  await b.close();
}
