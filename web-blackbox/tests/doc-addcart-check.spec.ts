/**
 * ⚙️ 自动生成用例·真实执行版（自动化测试平台 /scenarios/cases/create/ → doc_actions.py 自动扩充）
 * 用例：addcart-check · 商品加购功能检查
 * 说明：检查商品详情页加购功能是否正常
 * 端：pc ｜ 需要登录：是 ｜ 含写操作：否
 * 生成时间：2026-10-05 08:40 ｜ 实现模式：auto-v1（口语步骤 → 动作原语 → helpers/docflow.ts 真实执行）
 *
 * 本文件由程序根据口语化步骤自动编写，可直接执行：
 *   - 动作库：tests/helpers/docflow.ts（站点改版只需更新该文件，所有自动用例同步生效）
 *   - 每步自包含前置链（登录→搜索→打开商品等），失败步骤不影响其他步骤独立判定
 *   - 每步真实断言 + API 捕获（curl）+ 截图留证，worker 分片写入报告自动合并
 *
 * 步骤实现清单：
 *   S1 ✅ search：搜索「鞋子」并进入结果页
 *   S2 ✅ open_first_product：点击搜索结果第一个商品进入详情页
 *   S3 ✅ add_cart：点击加购按钮并做接口+徽标双证据校验
 *   S4 ✅ check_cart：跳转购物车页并断言含刚加购商品
 */
import { test, expect } from '@playwright/test';
import { pcHome, wapHome, pcUrl } from './helpers/site';
import { makeRecorder, login, searchPickAndOpen, waitDetailRendered, addCartAndVerify, openCartAndCheck, openHome, expectText } from './helpers/docflow';

const { wireCapture, recordStep } = makeRecorder('tests/doc-addcart-check.spec.ts', 'doc');

test.describe("addcart-check · 商品加购功能检查", () => {

  test("S1 [PC] 打开首页点击搜索框，输入鞋子并点击搜索", async ({ page }) => {
    test.setTimeout(6 * 60_000);
    // 口语步骤："打开首页点击搜索框，输入鞋子并点击搜索"
    // 预期："页面正常加载，商品列表页正常加载"
    // 自动实现：搜索「鞋子」并进入结果页 ｜ 前置链：login
    wireCapture(page, '前台');
    const t0 = Date.now();
    const logs: string[] = [];
    let status: 'ok' | 'fail' = 'ok';
    try {

      await login(page, logs);
      const picked = await searchPickAndOpen(page, logs, "鞋子");
    } catch (e: any) {
      status = 'fail';
      logs.push(`异常: ${String(e.message || e).slice(0, 300)}`);
    }
    await recordStep("S1", "打开首页点击搜索框，输入鞋子并点击搜索", page, status, logs, t0);
    expect(status, `S1 失败: ${logs.join(' | ')}`).toBe('ok');
  });

  test("S2 [PC] 商品列表页点击第一个商品，跳转商品详情页面", async ({ page }) => {
    test.setTimeout(6 * 60_000);
    // 口语步骤："商品列表页点击第一个商品，跳转商品详情页面"
    // 预期："商品详情页正常加载"
    // 自动实现：点击搜索结果第一个商品进入详情页 ｜ 前置链：login → search
    wireCapture(page, '前台');
    const t0 = Date.now();
    const logs: string[] = [];
    let status: 'ok' | 'fail' = 'ok';
    try {

      await login(page, logs);
      const picked = await searchPickAndOpen(page, logs, "鞋子");
      expect(await waitDetailRendered(page), '商品详情页未渲染（30s）').toBeTruthy();
      const btDetail = await page.evaluate('document.body.innerText');
      expect(btDetail, '详情页缺少「立即购买」按钮').toContain('立即购买');
      logs.push(`商品详情已打开: ${picked.title}`);
    } catch (e: any) {
      status = 'fail';
      logs.push(`异常: ${String(e.message || e).slice(0, 300)}`);
    }
    await recordStep("S2", "商品列表页点击第一个商品，跳转商品详情页面", page, status, logs, t0);
    expect(status, `S2 失败: ${logs.join(' | ')}`).toBe('ok');
  });

  test("S3 [PC] 点击商品详情页的加购按钮", async ({ page }) => {
    test.setTimeout(6 * 60_000);
    // 口语步骤："点击商品详情页的加购按钮"
    // 预期："出现成功加入购物车提示"
    // 自动实现：点击加购按钮并做接口+徽标双证据校验 ｜ 前置链：login → search → open_first_product
    wireCapture(page, '前台');
    const t0 = Date.now();
    const logs: string[] = [];
    let status: 'ok' | 'fail' = 'ok';
    try {

      await login(page, logs);
      const picked = await searchPickAndOpen(page, logs, "鞋子");
      expect(await waitDetailRendered(page), '商品详情页未渲染（30s）').toBeTruthy();
      const btPre = await page.evaluate('document.body.innerText');
      expect(btPre, '详情页缺少「立即购买」按钮').toContain('立即购买');
      logs.push(`商品详情已打开: ${picked.title}`);
      await addCartAndVerify(page, logs);
      logs.push(`商品「${picked.title}」加购成功（接口 code=1 / 购物车徽标 双证据）`);
    } catch (e: any) {
      status = 'fail';
      logs.push(`异常: ${String(e.message || e).slice(0, 300)}`);
    }
    await recordStep("S3", "点击商品详情页的加购按钮", page, status, logs, t0);
    expect(status, `S3 失败: ${logs.join(' | ')}`).toBe('ok');
  });

  test("S4 [PC] 跳转网址到 /zh-cn/dashboard/cart购物车页面", async ({ page }) => {
    test.setTimeout(6 * 60_000);
    // 口语步骤："跳转网址到 /zh-cn/dashboard/cart购物车页面"
    // 预期："购物车页面有刚才加购的商品"
    // 自动实现：跳转购物车页并断言含刚加购商品 ｜ 前置链：login → search → open_first_product → add_cart
    wireCapture(page, '前台');
    const t0 = Date.now();
    const logs: string[] = [];
    let status: 'ok' | 'fail' = 'ok';
    try {

      await login(page, logs);
      const picked = await searchPickAndOpen(page, logs, "鞋子");
      expect(await waitDetailRendered(page), '商品详情页未渲染（30s）').toBeTruthy();
      const btPre = await page.evaluate('document.body.innerText');
      expect(btPre, '详情页缺少「立即购买」按钮').toContain('立即购买');
      logs.push(`商品详情已打开: ${picked.title}`);
      await addCartAndVerify(page, logs);
      logs.push(`商品「${picked.title}」加购成功（接口 code=1 / 购物车徽标 双证据）`);
      await openCartAndCheck(page, logs, (picked.title || '').replace(/\s+/g, '').slice(0, 8));
    } catch (e: any) {
      status = 'fail';
      logs.push(`异常: ${String(e.message || e).slice(0, 300)}`);
    }
    await recordStep("S4", "跳转网址到 /zh-cn/dashboard/cart购物车页面", page, status, logs, t0);
    expect(status, `S4 失败: ${logs.join(' | ')}`).toBe('ok');
  });
});
