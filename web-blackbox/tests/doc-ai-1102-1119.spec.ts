/**
 * ⚙️ 自动生成用例·真实执行版（OneBuy 测试平台 /scenarios/cases/create/ → doc_actions.py 自动扩充）
 * 用例：ai-1102-1119 · 注册新账号并登录后搜索保温杯加入购物车
 * 说明：注册新账号（随机邮箱自动注册并登录）→ 用新账号登录 → 搜索保温杯 → 打开第一个商品详情 → 加入购物车。2026-11-04：注册原语已实现（register），登录自动改用新注册账号，不再回退站点测试账号。
 * 端：pc ｜ 需要登录：是 ｜ 含写操作：是（真实数据）
 * 生成时间：2026-11-04 15:02 ｜ 实现模式：auto-v1（口语步骤 → 动作原语 → helpers/docflow.ts 真实执行）
 *
 * 本文件由程序根据口语化步骤自动编写，可直接执行：
 *   - 动作库：tests/helpers/docflow.ts（站点改版只需更新该文件，所有自动用例同步生效）
 *   - 每步自包含前置链（登录→搜索→打开商品等）；串行执行（serial）——前序失败后续 skip，
 *     不在缺失前置数据的情况下硬跑（尤其「注册新账号」链：注册失败不再回退站点测试账号）
 *   - 每步真实断言 + API 捕获（curl）+ 截图留证，worker 分片写入报告自动合并
 *
 * 步骤实现清单：
 *   S1 ✅ register：随机邮箱注册新账号并自动登录（后续登录自动用新账号）
 *   S2 ✅ login：登录前台
 *   S3 ✅ search：搜索「保温杯」并进入结果页
 *   S4 ✅ open_first_product：点击搜索结果第一个商品进入详情页
 *   S5 ✅ add_cart：点击加购按钮并做接口+徽标双证据校验
 */
import { test, expect } from '@playwright/test';
import { pcHome, wapHome, pcUrl } from './helpers/site';
import { makeRecorder, login, register, searchPickAndOpen, waitDetailRendered, addCartAndVerify, openCartAndCheck, openHome, expectText } from './helpers/docflow';
import { wapLogin, wapOpenHome, wapOpenPath, wapExpectText } from './helpers/wapflow';

const { wireCapture, recordStep } = makeRecorder('tests/doc-ai-1102-1119.spec.ts', 'doc');

// 2026-11-04 ian：链式用例串行执行——前序步骤失败（如 S1 注册失败）时后续步骤 skip，
// 不再各自独立硬跑并静默回退站点测试账号（避免语义假通过，报告如实显示 skip 原因）。
test.describe.configure({ mode: 'serial' });

test.describe("ai-1102-1119 · 注册新账号并登录后搜索保温杯加入购物车", () => {

  test("S1 [PC] 注册新账号（随机邮箱）并自动登录", async ({ page }) => {
    test.setTimeout(6 * 60_000);
    // 口语步骤："注册新账号（随机邮箱）并自动登录"
    // 预期："注册成功并自动登录：页面跳转会员中心且显示新注册账号邮箱"
    // 自动实现：随机邮箱注册新账号并自动登录（后续登录自动用新账号） ｜ 前置链：无
    wireCapture(page, '前台');
    const t0 = Date.now();
    const logs: string[] = [];
    let status: 'ok' | 'fail' = 'ok';
    try {

      await register(page, logs);
    } catch (e: any) {
      status = 'fail';
      logs.push(`异常: ${String(e.message || e).slice(0, 300)}`);
    }
    await recordStep("S1", "注册新账号（随机邮箱）并自动登录", page, status, logs, t0);
    expect(status, `S1 失败: ${logs.join(' | ')}`).toBe('ok');
  });

  test("S2 [PC] 登录（使用 S1 新注册的账号）", async ({ page }) => {
    test.setTimeout(6 * 60_000);
    // 口语步骤："登录（使用 S1 新注册的账号）"
    // 预期："登录成功进入首页，登录身份为本用例新注册的账号（非站点测试账号）"
    // 自动实现：登录前台 ｜ 前置链：无
    wireCapture(page, '前台');
    const t0 = Date.now();
    const logs: string[] = [];
    let status: 'ok' | 'fail' = 'ok';
    try {

      await login(page, logs);
    } catch (e: any) {
      status = 'fail';
      logs.push(`异常: ${String(e.message || e).slice(0, 300)}`);
    }
    await recordStep("S2", "登录（使用 S1 新注册的账号）", page, status, logs, t0);
    expect(status, `S2 失败: ${logs.join(' | ')}`).toBe('ok');
  });

  test("S3 [PC] 搜索保温杯", async ({ page }) => {
    test.setTimeout(6 * 60_000);
    // 口语步骤："搜索保温杯"
    // 预期："结果页出现保温杯相关商品链接"
    // 自动实现：搜索「保温杯」并进入结果页 ｜ 前置链：login
    wireCapture(page, '前台');
    const t0 = Date.now();
    const logs: string[] = [];
    let status: 'ok' | 'fail' = 'ok';
    try {

      await login(page, logs);
      const picked = await searchPickAndOpen(page, logs, "保温杯");
    } catch (e: any) {
      status = 'fail';
      logs.push(`异常: ${String(e.message || e).slice(0, 300)}`);
    }
    await recordStep("S3", "搜索保温杯", page, status, logs, t0);
    expect(status, `S3 失败: ${logs.join(' | ')}`).toBe('ok');
  });

  test("S4 [PC] 打开第一个保温杯商品详情", async ({ page }) => {
    test.setTimeout(6 * 60_000);
    // 口语步骤："打开第一个保温杯商品详情"
    // 预期："详情页渲染出价格区与立即购买按钮"
    // 自动实现：点击搜索结果第一个商品进入详情页 ｜ 前置链：login → search
    wireCapture(page, '前台');
    const t0 = Date.now();
    const logs: string[] = [];
    let status: 'ok' | 'fail' = 'ok';
    try {

      await login(page, logs);
      const picked = await searchPickAndOpen(page, logs, "保温杯");
      expect(await waitDetailRendered(page), '商品详情页未渲染（30s）').toBeTruthy();
      const btDetail = await page.evaluate('document.body.innerText');
      expect(btDetail, '详情页缺少「立即购买」按钮').toContain('立即购买');
      logs.push(`商品详情已打开: ${picked.title}`);
    } catch (e: any) {
      status = 'fail';
      logs.push(`异常: ${String(e.message || e).slice(0, 300)}`);
    }
    await recordStep("S4", "打开第一个保温杯商品详情", page, status, logs, t0);
    expect(status, `S4 失败: ${logs.join(' | ')}`).toBe('ok');
  });

  test("S5 [PC] 加入购物车", async ({ page }) => {
    test.setTimeout(6 * 60_000);
    // 口语步骤："加入购物车"
    // 预期："加购接口 code=1 成功且购物车徽标数量 +1"
    // 自动实现：点击加购按钮并做接口+徽标双证据校验 ｜ 前置链：login → search → open_first_product
    wireCapture(page, '前台');
    const t0 = Date.now();
    const logs: string[] = [];
    let status: 'ok' | 'fail' = 'ok';
    try {

      await login(page, logs);
      const picked = await searchPickAndOpen(page, logs, "保温杯");
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
    await recordStep("S5", "加入购物车", page, status, logs, t0);
    expect(status, `S5 失败: ${logs.join(' | ')}`).toBe('ok');
  });
});
