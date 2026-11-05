import type { Page } from '@playwright/test';

/**
 * Shop WAP SKU 标准打法（2026-09-21 四轮修正最终结论的用例化封装）
 *
 * 铁律（来源：output/2026-09-21_1441 复验 + 2026-09-22 回归）：
 * 1. tglobal 源商品 SKU 弹层存在渲染层 bug（BUG-20260921-01）：
 *    选中态 class / 金额区 .totalInfo / 数量框均不刷新，但组件内部选择状态完全生效。
 *    —— 严禁以视觉状态（class select / totalInfo / input 可见）判定成功或失败。
 * 2. 唯一可信判定 = cart/add 接口成功发出 + URL 跳转 carttoorder。
 * 3. 未选规格直接 Buy Now = 静默失败（9/15「18/18 不可购买」误报的真正根因）。
 * 4. 上游 obapi/getItem 存在间歇性 item-not-found（BUG-20260921-02）：
 *    无数据时调用方应 test.skip 并注明，勿定性为站点缺陷。
 * 5. tsx/转译环境下 page.evaluate 统一传字符串表达式，禁止传函数。
 *
 * 弹层结构：sitem[0..24]=颜色组（文本常为空），sitem[25..35]=尺码组（带文本）；
 * 数据源：getItem → data.props_list{1627207:*=颜色,20549:*=尺码} + data.skus.sku[]（quantity>0 有库存）。
 */

export type GetItemGetter = () => any;
export type SkuAction = 'buynow' | 'addcart';

export interface StandardSkuResult {
  jumped: boolean;        // 是否跳转订单确认页（buynow 模式的最终成功标准）
  cartAddSeen: boolean;   // 是否观测到 cart/add 成功（数据层成功标准）
  cartAdded: boolean;     // addcart 模式：是否出现「added to cart」成功弹窗
  picked: { name: string; quantity: number } | null;
  noItemData: boolean;    // true = getItem 无数据（间歇性故障或 供应链源无 props），调用方据此 skip
  mode: 'data-driven' | 'default-spec'; // tglobal=数据驱动；供应链源=默认规格直接操作
  logs: string[];
}

/** 在【页面导航前】调用：注册 getItem 响应捕获，返回读取器 */
export function captureGetItem(page: Page): GetItemGetter {
  let itemData: any = null;
  page.on('response', async (r) => {
    if (/obapi\/getItem(\?|$)/.test(r.url())) {
      try { itemData = await r.json(); } catch { /* 忽略解析失败 */ }
    }
  });
  return () => itemData;
}

/** 打开详情页 SKU 弹层（底部按钮：buy=立即购买，primary=加入购物车） */
export async function openSkuPopup(page: Page, action: SkuAction): Promise<void> {
  if (action === 'buynow') {
    await page.evaluate(`(() => {
      const t = Array.from(document.querySelectorAll('.fixed-btn')).find((b) => /buy/i.test(b.textContent || ''));
      if (t) t.click();
    })()`);
  } else {
    // wap-shopping-flow 原实现：.fixed-btn.btn-primary = 加入购物车
    await page.evaluate(`(() => {
      const t = document.querySelector('.fixed-btn.btn-primary') ||
        Array.from(document.querySelectorAll('.fixed-btn')).find((b) => /add|cart/i.test(b.textContent || ''));
      if (t) t.click();
    })()`);
  }
  await page.waitForTimeout(3500);
}

/** 数据驱动选有库存 SKU（tglobal）：随机挑一个 quantity>0 的 SKU，颜色按下标、尺码按文本定位 sitem 并点击 */
export async function selectStockedSku(
  page: Page,
  getItem: GetItemGetter,
  logs: string[],
): Promise<{ picked: { name: string; quantity: number } | null; noItemData: boolean }> {
  const itemData = getItem();
  const data = itemData && itemData.data ? itemData.data : null;
  const propsList = data && data.props_list ? data.props_list : null;
  const skus = data && data.skus && Array.isArray(data.skus.sku) ? data.skus.sku : [];

  // 无 getItem 数据（间歇故障或结构不符）→ 交由调用方决定 skip/降级
  if (!propsList || skus.length === 0) {
    logs.push(`getItem 无 props_list/skus（error=${JSON.stringify((itemData || {}).data || null).slice(0, 80)}）`);
    return { picked: null, noItemData: true };
  }

  const colorKeys = Object.keys(propsList).filter((k) => k.startsWith('1627207:'));
  const sizeKeys = Object.keys(propsList).filter((k) => k.startsWith('20549:'));
  const inStock = skus.filter((s: any) => Number(s.quantity) > 0);
  if (inStock.length === 0) {
    logs.push('getItem 全部 SKU quantity=0（无库存）');
    return { picked: null, noItemData: true };
  }
  const pick = inStock[Math.floor(Math.random() * inStock.length)];
  const parts = String(pick.properties || '').split(';');
  const colorIdx = colorKeys.indexOf(parts[0]);
  const targetSizeName = ((propsList[parts[1]] || '').split(':').pop() || '').trim();
  logs.push(`数据驱动选 SKU: ${pick.properties_name} (库存${pick.quantity}) colorIdx=${colorIdx} 尺码'${targetSizeName}'`);

  // UI 下标：sitem[0..24]=颜色，sitem[25..]=尺码；尺码优先文本精确匹配，回退枚举下标
  const uiItems: Array<{ i: number; text: string }> = await page.evaluate(
    `(() => Array.from(document.querySelectorAll('.skuSpec .sitem')).map((e, i) => ({ i, text: (e.textContent || '').trim() })))()`,
  );
  const sizeUiPos = uiItems.slice(25).findIndex((s) => s.text === targetSizeName);
  const sizeSelIdx = sizeUiPos >= 0 ? 25 + sizeUiPos : 25 + sizeKeys.indexOf(parts[1]);

  // 三通道点击（mouse → touch → 原生 el.click）。渲染层 class 不刷新是已知现象，故不做 class 判定，三通道全打保证内部状态生效
  const trySelect = async (globalIdx: number): Promise<void> => {
    if (globalIdx < 0) return;
    const box = await page.evaluate(
      `(() => { const e = document.querySelectorAll('.skuSpec .sitem')[${globalIdx}]; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    );
    if (!box) return;
    try { await page.mouse.click(box.x, box.y); } catch { /* 忽略 */ }
    await page.waitForTimeout(1200);
    try { await page.touchscreen.tap(box.x, box.y); } catch { /* 忽略 */ }
    await page.waitForTimeout(1200);
    await page.evaluate(`(() => { const e = document.querySelectorAll('.skuSpec .sitem')[${globalIdx}]; if (e) e.click(); })()`);
    await page.waitForTimeout(1200);
  };
  await trySelect(colorIdx);
  await trySelect(sizeSelIdx);
  return { picked: { name: pick.properties_name, quantity: pick.quantity }, noItemData: false };
}

/** 填数量：优先读弹层 MOQ 提示（Minimum Batch Quantity: N，仅 供应链源）；tglobal 源默认 1 */
export async function fillQty(page: Page, qty?: number): Promise<number> {
  let n = qty && qty > 0 ? qty : 0;
  if (!n) {
    const sellNum = (await page.evaluate(
      `(() => (((document.querySelector('.sku-content .sell-num') || {}).textContent) || '').trim())()`,
    )) as string;
    n = /minimum/i.test(sellNum) ? Number(sellNum.match(/(\d+)/)?.[1] || '1') : 1;
  }
  const qtyExists = await page.evaluate(`(() => !!document.querySelector('.skuSpec input, .sku-content input'))()`);
  if (qtyExists) {
    await page.locator('.skuSpec input, .sku-content input').first().fill(String(n), { force: true }).catch(() => {});
    await page.waitForTimeout(1200);
  }
  return n;
}

/** 点击弹层内确认按钮（uni-button 合成 click 无效，必须原生 click） */
export async function clickPopupConfirm(page: Page, action: SkuAction): Promise<void> {
  await page.evaluate(`(() => {
    const btns = Array.from(document.querySelectorAll('.btns uni-button'));
    const t = ${action === 'buynow'
      ? `btns.find((x) => /buy/i.test(x.textContent || ''))`
      : `btns.find((x) => /add|cart/i.test(x.textContent || '')) || btns.find((x) => /btn-primary/.test(x.className))`};
    if (t) t.click();
  })()`);
}

/**
 * 标准打法完整流程（弹层未打开状态调用）：
 * 打开弹层 → (tglobal)数据驱动选有库存 SKU / (market)默认规格 → 填数量 → 点确认 → 等跳转/成功弹窗
 */
export async function standardSkuFlow(
  page: Page,
  opts: { getItem: GetItemGetter; action: SkuAction; qty?: number },
): Promise<StandardSkuResult> {
  const { getItem, action } = opts;
  const logs: string[] = [];
  const ret: StandardSkuResult = {
    jumped: false, cartAddSeen: false, cartAdded: false,
    picked: null, noItemData: false, mode: 'default-spec', logs,
  };

  // cart/add 成功监听（数据层唯一可信证据）
  let cartAddOk = false;
  page.on('response', async (r) => {
    if (/cart\/add(\?|$)/.test(r.url()) && r.status() >= 200 && r.status() < 300) {
      try {
        const j = await r.json();
        if (!j || j.code === 0 || j.code === undefined) cartAddOk = true;
      } catch { cartAddOk = true; }
    }
  });

  await openSkuPopup(page, action);

  const sel = await selectStockedSku(page, getItem, logs);
  ret.noItemData = sel.noItemData;
  ret.picked = sel.picked;
  ret.mode = sel.noItemData ? 'default-spec' : 'data-driven';
  if (sel.noItemData) logs.push('降级 default-spec 模式（供应链源默认选中规格场景）');

  const qtyFilled = await fillQty(page, opts.qty);
  logs.push(`数量=${qtyFilled}`);

  await clickPopupConfirm(page, action);

  // buynow：等跳转订单确认页（carttoorder）；addcart：等成功弹窗
  if (action === 'buynow') {
    for (let w = 0; w < 5; w++) {
      await page.waitForTimeout(2000);
      if (/toorder|confirm/.test(page.url())) { ret.jumped = true; break; }
    }
  } else {
    try {
      await page.locator('.uni-modal').first().waitFor({ state: 'visible', timeout: 15_000 });
      const modalText = (await page.locator('.uni-modal').first().innerText().catch(() => '')) || '';
      ret.cartAdded = /added to cart/i.test(modalText);
      if (ret.cartAdded) {
        await page.locator('.uni-modal__btn_primary').first().click({ force: true });
        await page.waitForTimeout(2000);
      }
    } catch { /* 弹窗未出现 */ }
  }
  ret.cartAddSeen = cartAddOk;
  logs.push(`cart/add 成功=${cartAddOk} 跳转=${ret.jumped} 加购弹窗=${ret.cartAdded}`);
  return ret;
}
