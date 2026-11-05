import { expect, Page } from '@playwright/test';

/** 等待页面资源与语言包完全加载后再断言（功能测试统一入口） */
export async function openReady(page: Page, route: string, locale = 'en', settleMs = 2000) {
  await page.goto(`/${locale}${route === '/' ? '' : route}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  // 语言稳定检测：等待已知中文界面文案消失（i18n 注入完成标志）
  const knownChinese = ['返回首页', '注册', '密码', '隐私政策', '服务条款', '请输入关键词'];
  await page
    .waitForFunction(
      (markers) => {
        const text = document.body.innerText;
        return !markers.some((m) => text.includes(m));
      },
      knownChinese,
      { timeout: 15_000 },
    )
    .catch(() => {
      /* 超时说明确实存在中文文案（真实缺陷），继续执行断言记录缺陷 */
    });
  await page.waitForTimeout(settleMs);
}

export class ShopPage {
  constructor(private readonly page: Page) {}

  async openHome(locale = 'en') {
    await this.page.goto(`/${locale}`, { waitUntil: 'domcontentloaded' });
  }

  searchInput() {
    // 页面同时渲染桌面/移动两套搜索框，仅取当前可见的那个
    return this.page.locator('input[placeholder="Enter product name/link"]:visible').first();
  }

  searchButton() {
    return this.page.getByRole('button', { name: 'Search', exact: true }).first();
  }

  loginLink() {
    return this.page.getByRole('link', { name: 'Login', exact: true });
  }

  registerLink() {
    return this.page.getByRole('link', { name: 'Register', exact: true });
  }

  async assertHomeReady() {
    await expect(
      this.page.getByRole('heading', {
        name: 'Global Access to Chinese Products at Affordable Prices',
      }),
    ).toBeVisible();
    await expect(this.searchInput()).toBeVisible();
    await expect(this.searchButton()).toBeEnabled();
  }

  async openEstimate(locale = 'en') {
    await this.page.goto(`/${locale}/estimate`, {
      waitUntil: 'domcontentloaded',
    });
  }

  async openLogin(locale = 'en') {
    await this.page.goto(`/${locale}/login`, {
      waitUntil: 'domcontentloaded',
    });
  }

  async openRegister(locale = 'en') {
    await this.page.goto(`/${locale}/register`, {
      waitUntil: 'domcontentloaded',
    });
  }
}
