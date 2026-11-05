/**
 * overlay.ts —— 通用开屏广告/弹窗关闭守卫（2026-10-16 ian）
 * 背景：有的站点（如 spanbuy.tmp.dev.1buyo.com）首页有开屏广告弹窗，遮挡搜索框/按钮导致
 *       测试「卡在首页」（JOB-000105-PC）。要求：打开网站遇到开屏广告直接关闭再继续测试。
 *
 * 定位：全站通用的 best-effort 守卫 —— 不依赖具体站点选择器，基于「关闭元素通用特征池」：
 *   1. 精确文本按钮：× ✕ x X 关闭 跳过 跳过广告 我知道了 知道了 不再提醒 close Skip Skip Ad
 *   2. class/aria 特征：[class*=close i] / [aria-label*=close i] / [aria-label*=关闭]（限小尺寸可点元素）
 *   3. ESC 键兜底（多数组件库弹窗支持）
 * 防误伤：
 *   - 排除含 登录/注册/购买/加入/提交/确认/领取/去领 等业务动词的元素（不是关闭按钮）
 *   - 不点击 mask/遮罩（部分电商广告点遮罩=跳活动页，风险大于收益）
 *   - 守卫全程 try/catch，任何异常静默吞掉——守卫自身绝不阻断测试
 *
 * 接入点（页面 goto 后、首个业务交互前）：
 *   docflow.ts: login / openHome / searchPickAndOpen / waitDetailRendered / addCartAndVerify / openCartAndCheck
 *   full-chain.spec.ts: PC 前台各页 goto 后
 */
import type { Page } from '@playwright/test';

/** 精确匹配的关闭按钮文本（trim 后全等；中英文常见写法） */
const CLOSE_TEXTS = ['×', '✕', 'x', 'X', '关闭', '跳过', '跳过广告', '我知道了', '知道了', '不再提醒', '不再弹出', 'close', 'Close', 'Skip', 'Skip Ad', 'skip'];

/** 出现这些业务动词的元素绝不是关闭按钮（防误点下单/领券跳转） */
const DANGER_WORDS = /登录|注册|购买|加入|提交|确认|领取|去领|支付|订阅|开通|立即|马上|下载|咨询|客服/;

/** 候选关闭元素定位器（在可见弹窗容器外的也尝试——只要可见+小尺寸+命中特征） */
function closeCandidates(page: Page) {
  const textSel = CLOSE_TEXTS.map((t) => `button:visible:text-is("${t}")`).join(', ')
    + `, [role="button"]:visible:text-is("×"), [role="button"]:visible:text-is("关闭"), [role="button"]:visible:text-is("跳过")`
    + `, a:visible:text-is("×"), span:visible:text-is("×")`;
  const clsSel = [
    '[class*="close" i]:visible',
    '[aria-label*="close" i]:visible',
    '[aria-label*="关闭"]:visible',
    '[class*="popup"] [class*="shut" i]:visible',
    '[class*="dialog"] [class*="shut" i]:visible',
  ].join(', ');
  return { textSel, clsSel };
}

/** 单个候选是否安全可点（可见 + 小尺寸关闭按钮特征 + 不含业务动词） */
async function safeToClick(el: import('@playwright/test').Locator): Promise<boolean> {
  try {
    if (!(await el.isVisible())) return false;
    const box = await el.boundingBox();
    if (!box) return false;
    // 关闭按钮尺寸特征：宽高均 < 90px（超大的是内容区块/广告图，不是关闭按钮）
    if (box.width > 90 || box.height > 90) return false;
    const txt = ((await el.textContent()) || '').trim();
    if (txt && DANGER_WORDS.test(txt)) return false;
    const aria = (await el.getAttribute('aria-label')) || '';
    if (aria && DANGER_WORDS.test(aria)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * 关闭页面上的开屏广告/弹窗。多轮循环（新弹窗可能叠加出现），返回关闭记录（供 logs/报告留痕）。
 * 用法：await dismissOverlays(page, logs)  —— logs 可省略。
 */
export async function dismissOverlays(page: Page, logs?: string[]): Promise<string[]> {
  const closed: string[] = [];
  const { textSel, clsSel } = closeCandidates(page);
  try {
    for (let round = 1; round <= 5; round++) {
      let acted = 0;
      // 1) 文本精确匹配的关闭按钮（最可靠，优先）
      for (const el of await page.locator(textSel).all().catch(() => [])) {
        if (acted >= 3) break; // 每轮至多点 3 个，防误伤扩散
        if (!(await safeToClick(el))) continue;
        const desc = await describe(el);
        await el.click({ timeout: 3_000, force: false }).then(
          () => { closed.push(desc); acted++; },
          () => {},
        );
        await page.waitForTimeout(350);
      }
      // 2) class/aria 特征关闭元素（次优）
      if (acted === 0) {
        for (const el of await page.locator(clsSel).all().catch(() => [])) {
          if (acted >= 3) break;
          if (!(await safeToClick(el))) continue;
          const desc = await describe(el);
          await el.click({ timeout: 3_000, force: false }).then(
            () => { closed.push(desc); acted++; },
            () => {},
          );
          await page.waitForTimeout(350);
        }
      }
      // 3) ESC 兜底（本轮没点掉任何按钮时尝试，很多弹窗监听 ESC）
      if (acted === 0) {
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(300);
      }
      // 收敛判定：本轮无文本命中且无 class 命中 → 结束
      const remain = await page.locator(textSel).count().catch(() => 0);
      if (acted === 0 && remain === 0) break;
      if (round === 5 && closed.length) logs?.push(`[overlay] 达到最大轮次，已关闭 ${closed.length} 个弹窗`);
    }
  } catch {
    /* 守卫绝不抛错 */
  }
  if (closed.length && logs) {
    logs.push(`[overlay] 开屏广告/弹窗守卫已关闭 ${closed.length} 个: ${closed.slice(0, 5).join(' ; ')}`);
  }
  return closed;
}

async function describe(el: import('@playwright/test').Locator): Promise<string> {
  try {
    const tag = await el.evaluate<(n: HTMLElement) => string>((n) => {
      const cls = (n.className && typeof n.className === 'string') ? `.${n.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
      return `${n.tagName.toLowerCase()}${cls}`;
    });
    const txt = ((await el.textContent()) || '').trim().slice(0, 12);
    return txt ? `${tag}「${txt}」` : tag;
  } catch {
    return 'unknown';
  }
}

/** 打开页面 + 守卫组合（goto → 等待 → dismissOverlays），PC 前台页面统一入口 */
export async function gotoWithGuard(page: Page, url: string, logs?: string[], settleMs = 2_500): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(settleMs);
  await dismissOverlays(page, logs);
}
