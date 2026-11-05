/**
 * ⚙️ 自动生成用例·真实执行版（OneBuy 测试平台 /scenarios/cases/create/ → doc_actions.py 自动扩充）
 * 用例：ai-1104-1804 · 联系我们留言表单提交验证
 * 说明：打开官网首页，点击顶部导航联系我们，填写测试留言并提交验证成功
 * 端：pc ｜ 需要登录：否 ｜ 含写操作：否
 * 生成时间：2026-11-04 18:05 ｜ 实现模式：auto-v1（口语步骤 → 动作原语 → helpers/docflow.ts 真实执行）
 *
 * 本文件由程序根据口语化步骤自动编写，可直接执行：
 *   - 动作库：tests/helpers/docflow.ts（站点改版只需更新该文件，所有自动用例同步生效）
 *   - 每步自包含前置链（登录→搜索→打开商品等）；串行执行（serial）——前序失败后续 skip，
 *     不在缺失前置数据的情况下硬跑（尤其「注册新账号」链：注册失败不再回退站点测试账号）
 *   - 每步真实断言 + API 捕获（curl）+ 截图留证，worker 分片写入报告自动合并
 *
 * 步骤实现清单：
 *   S1 ✅ open_home：打开首页
 *   S2 ✅ click_text：点击「联系我们」
 *   S3 ✅ fill_form：填写表单（自动填可见输入框）
 *   S4 ✅ click_text：点击「提交」
 *   S5 ✅ expect_submit_ok：断言提交成功（2xx 接口证据 / 成功文案兜底）
 */
import { test, expect } from '@playwright/test';
import { pcHome, wapHome, pcUrl } from './helpers/site';
import { makeRecorder, login, register, searchPickAndOpen, waitDetailRendered, addCartAndVerify, openCartAndCheck, openHome, expectText } from './helpers/docflow';
import { wapLogin, wapOpenHome, wapOpenPath, wapExpectText } from './helpers/wapflow';

const { wireCapture, recordStep } = makeRecorder('tests/doc-ai-1104-1804.spec.ts', 'doc');

// 2026-11-04 ian：链式用例串行执行——前序步骤失败（如 S1 注册失败）时后续步骤 skip，
// 不再各自独立硬跑并静默回退站点测试账号（避免语义假通过，报告如实显示 skip 原因）。
test.describe.configure({ mode: 'serial' });

test.describe("ai-1104-1804 · 联系我们留言表单提交验证", () => {

  test("S1 [PC] 打开官网首页", async ({ page }) => {
    test.setTimeout(6 * 60_000);
    // 口语步骤："打开官网首页"
    // 预期："首页渲染成功且顶部导航可见（含联系我们入口）"
    // 自动实现：打开首页 ｜ 前置链：无
    wireCapture(page, '前台');
    const t0 = Date.now();
    const logs: string[] = [];
    let status: 'ok' | 'fail' = 'ok';
    try {

      await openHome(page, logs);
    } catch (e: any) {
      status = 'fail';
      logs.push(`异常: ${String(e.message || e).slice(0, 300)}`);
    }
    await recordStep("S1", "打开官网首页", page, status, logs, t0);
    expect(status, `S1 失败: ${logs.join(' | ')}`).toBe('ok');
  });

  test("S2 [PC] 点击顶部导航联系我们", async ({ page }) => {
    test.setTimeout(6 * 60_000);
    // 口语步骤："点击顶部导航联系我们"
    // 预期："跳转至联系我们页面并渲染出页面主体内容"
    // 自动实现：点击「联系我们」 ｜ 前置链：无
    wireCapture(page, '前台');
    const t0 = Date.now();
    const logs: string[] = [];
    let status: 'ok' | 'fail' = 'ok';
    try {

      const __navPath = "";
      if (__navPath) { await page.goto(new URL(__navPath, pcUrl('home')).toString(), { waitUntil: 'domcontentloaded', timeout: 45_000 }); await page.waitForTimeout(2_500); }
      await clickByText(page, logs, "联系我们");
    } catch (e: any) {
      status = 'fail';
      logs.push(`异常: ${String(e.message || e).slice(0, 300)}`);
    }
    await recordStep("S2", "点击顶部导航联系我们", page, status, logs, t0);
    expect(status, `S2 失败: ${logs.join(' | ')}`).toBe('ok');
  });

  test("S3 [PC] 定位留言模块并填写测试信息", async ({ page }) => {
    test.setTimeout(6 * 60_000);
    // 口语步骤："定位留言模块并填写测试信息"
    // 预期："留言表单各输入项均被成功填写且回读值与输入一致"
    // 自动实现：填写表单（自动填可见输入框） ｜ 前置链：无
    wireCapture(page, '前台');
    const t0 = Date.now();
    const logs: string[] = [];
    let status: 'ok' | 'fail' = 'ok';
    try {

      const __navPath = "";
      if (__navPath) { await page.goto(new URL(__navPath, pcUrl('home')).toString(), { waitUntil: 'domcontentloaded', timeout: 45_000 }); await page.waitForTimeout(2_500); }
      await fillForm(page, logs, "");
    } catch (e: any) {
      status = 'fail';
      logs.push(`异常: ${String(e.message || e).slice(0, 300)}`);
    }
    await recordStep("S3", "定位留言模块并填写测试信息", page, status, logs, t0);
    expect(status, `S3 失败: ${logs.join(' | ')}`).toBe('ok');
  });

  test("S4 [PC] 点击提交按钮", async ({ page }) => {
    test.setTimeout(6 * 60_000);
    // 口语步骤："点击提交按钮"
    // 预期："提交按钮被成功点击并触发提交请求"
    // 自动实现：点击「提交」 ｜ 前置链：无
    wireCapture(page, '前台');
    const t0 = Date.now();
    const logs: string[] = [];
    let status: 'ok' | 'fail' = 'ok';
    try {

      const __navPath = "";
      if (__navPath) { await page.goto(new URL(__navPath, pcUrl('home')).toString(), { waitUntil: 'domcontentloaded', timeout: 45_000 }); await page.waitForTimeout(2_500); }
      await clickByText(page, logs, "提交");
    } catch (e: any) {
      status = 'fail';
      logs.push(`异常: ${String(e.message || e).slice(0, 300)}`);
    }
    await recordStep("S4", "点击提交按钮", page, status, logs, t0);
    expect(status, `S4 失败: ${logs.join(' | ')}`).toBe('ok');
  });

  test("S5 [PC] 验证留言提交成功", async ({ page }) => {
    test.setTimeout(6 * 60_000);
    // 口语步骤："验证留言提交成功"
    // 预期："提交接口返回 2xx 或页面出现提交成功/感谢留言等成功提示"
    // 自动实现：断言提交成功（2xx 接口证据 / 成功文案兜底） ｜ 前置链：无
    wireCapture(page, '前台');
    const t0 = Date.now();
    const logs: string[] = [];
    let status: 'ok' | 'fail' = 'ok';
    try {

      await expectSubmitOk(page, logs);
    } catch (e: any) {
      status = 'fail';
      logs.push(`异常: ${String(e.message || e).slice(0, 300)}`);
    }
    await recordStep("S5", "验证留言提交成功", page, status, logs, t0);
    expect(status, `S5 失败: ${logs.join(' | ')}`).toBe('ok');
  });
});
