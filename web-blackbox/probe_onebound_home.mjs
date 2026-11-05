// 探针：onebound.cn 在 Playwright 真实浏览器里的渲染情况
import { chromium } from '@playwright/test';

const b = await chromium.launch();
const page = await b.newPage();
const jsErrors = [];
page.on('pageerror', (e) => jsErrors.push(String(e).slice(0, 200)));
const failed = [];
page.on('requestfailed', (r) => failed.push(r.url().slice(0, 120) + ' :: ' + (r.failure()?.errorText || '')));

await page.goto('https://onebound.cn/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(4000);
const title = await page.title();
const body = (await page.textContent('body')) || '';
const links = await page.locator('a:visible').allTextContents();
const contact = links.filter((t) => t.includes('联系我们'));
console.log('title=', title);
console.log('bodyLen=', body.trim().length);
console.log('visibleLinks=', links.length, 'first5=', JSON.stringify(links.slice(0, 5)));
console.log('contactLinks=', JSON.stringify(contact));
console.log('jsErrors=', jsErrors.length, jsErrors.slice(0, 3));
console.log('failedReqs=', failed.length, failed.slice(0, 5));
await page.screenshot({ path: 'output/probe-onebound-home.png', fullPage: false });
await b.close();
