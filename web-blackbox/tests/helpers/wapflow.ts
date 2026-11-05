/**
 * wapflow.ts —— WAP 端动作库（三期 2026-11 ian：AI 口语建用例 WAP 原语）
 *
 * 交互模式全部抽取自 tests/wap-shopping-flow.spec.ts 实测代码（uni-app 站点特性）：
 * - uni-button 对 Playwright 合成 click 响应不稳定 → goto 用 3 次重试 + settle 等待
 * - 新会话默认币种随机（USD/CNY/JPY）→ localStorage 固定 CNY（RUB 会话写坏 currencyData → SPA 空壳）
 * - WAP 搜索框/结果列表/加购交互尚未实测探针 → 搜索类原语在注册表为 placeholder 显式降级，绝不假绿
 *
 * 原语与 docflow.ts 对齐：wapLogin / wapOpenHome / wapOpenPath / wapExpectText
 */
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { wapHome, wapRoute } from './site';
import { dismissOverlays } from './overlay';
import { frontAccount } from './docflow';

/** 打开 WAP 路径（实测 openWap：3 次重试 + 固定币种 + networkidle + settle；拼接与 wap-shopping-flow 实测严格一致） */
export async function openWapRoute(page: Page, route: string, settleMs = 3000): Promise<void> {
  const base = wapHome.replace(/\/$/, ''); // wapHome=base+entry+'/' → 去尾斜杠得 base+entry（'#' 结尾）
  let lastErr: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      await page.goto(`${base}${route}`, {
        waitUntil: 'domcontentloaded', timeout: 45_000,
      });
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      await page.waitForTimeout(5000 * (i + 1));
    }
  }
  if (lastErr) throw lastErr;
  // 固定币种 CNY（2026-10-12 ian：RUB 会话写坏 currencyData → SPA 空壳）
  await page.evaluate(`(() => { try { localStorage.setItem('selectedCurrency', 'CNY'); } catch (e) {} })()`).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(settleMs);
}

/** WAP 登录（实测 loginWap：input[type=text/password] fill + 文本 Sign in 点击） */
export async function wapLogin(page: Page, logs: string[], acc?: { account: string; password: string }): Promise<void> {
  const { account, password } = acc || frontAccount();
  expect(account, '未配置前台测试账号').toBeTruthy();
  await openWapRoute(page, '/pages/user/login', 3000);
  await dismissOverlays(page, logs);
  await page.locator('input[type="text"]').first().fill(account);
  await page.locator('input[type="password"]').first().fill(password);
  await page.getByText('Sign in', { exact: true }).first().click();
  await page.waitForTimeout(5000);
  expect(!/login/i.test(page.url()), `WAP 登录失败，仍停留 ${page.url()}`).toBeTruthy();
  logs.push('WAP 前台登录成功');
}

/** 打开 WAP 首页并校验渲染（body 有实质文本，防 SPA 空壳假绿） */
export async function wapOpenHome(page: Page, logs: string[]): Promise<void> {
  await openWapRoute(page, '/', 4000);
  await dismissOverlays(page, logs);
  const text = await page.evaluate('document.body.innerText').catch(() => '');
  expect((text || '').trim().length, 'WAP 首页疑似 SPA 空壳（body 无文本）').toBeGreaterThan(30);
  logs.push('WAP 首页打开且渲染正常');
}

/** 打开 WAP 指定页面（path 以 / 开头直接用；否则按站点档案 key 查（cart/userCenter/…）；已含弹窗守卫） */
export async function wapOpenPath(page: Page, logs: string[], path: string): Promise<void> {
  const raw = (path || '').trim();
  const route = /^\//.test(raw) ? raw : wapRoute(raw);
  if (!/^\//.test(route)) throw new Error(`WAP path 非法：${path}`);
  await openWapRoute(page, route, 4000);
  await dismissOverlays(page, logs);
  logs.push(`WAP 已打开 ${route}`);
}

/** WAP 文本断言（body innerText 包含） */
export async function wapExpectText(page: Page, logs: string[], text: string): Promise<void> {
  const body = await page.evaluate('document.body.innerText').catch(() => '');
  expect(body, `WAP 页面未出现文本「${text}」`).toContain(text);
  logs.push(`WAP 页面出现文本「${text}」`);
}
