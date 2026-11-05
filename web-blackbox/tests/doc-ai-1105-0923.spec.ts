/**
 * ⚙️ 自动生成用例·真实执行版（OneBuy 测试平台 /scenarios/cases/create/ → doc_actions.py 自动扩充）
 * 用例：ai-1105-0923 · 联系我们页面留言提交验证
 * 说明：首页导航点击联系我们进入联系页，滚动到留言区块填写测试信息并提交校验
 * 端：pc ｜ 需要登录：否 ｜ 含写操作：否
 * 生成时间：2026-11-05 09:23 ｜ 实现模式：auto-v1（口语步骤 → 动作原语 → helpers/docflow.ts 真实执行）
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
 *   S3 ✅ expect_url：断言 URL 片段
 *   S4 ✅ scroll_to_text：滚动定位到「留言」
 *   S5 ✅ check_text：断言页面文本「留言」
 *   S6 ✅ fill_form：填写表单（姓名=测试用户;邮箱=test@example.com;留言=这是一条自动化测试留言，请忽略）
 *   S7 ✅ click_text：点击「提交」
 *   S8 ✅ expect_submit_ok：断言提交成功（2xx 接口证据 / 成功文案兜底）
 */
import { test, expect } from '@playwright/test';
import { pcHome, wapHome, pcUrl } from './helpers/site';
import { makeRecorder, login, register, searchPickAndOpen, waitDetailRendered, addCartAndVerify, openCartAndCheck, openHome, expectText, fillForm, clickByText, expectSubmitOk, hoverText, expectUrl, scrollToText } from './helpers/docflow';
import { wapLogin, wapOpenHome, wapOpenPath, wapExpectText } from './helpers/wapflow';

const { wireCapture, recordStep } = makeRecorder('tests/doc-ai-1105-0923.spec.ts', 'doc');

// 2026-11-04 ian：链式用例串行执行——前序步骤失败（如 S1 注册失败）时后续步骤 skip，
// 不再各自独立硬跑并静默回退站点测试账号（避免语义假通过，报告如实显示 skip 原因）。
test.describe.configure({ mode: 'serial' });

test.describe("ai-1105-0923 · 联系我们页面留言提交验证", () => {

  test("S1 [PC] 打开官网首页", async ({ page }) => {
    test.setTimeout(6 * 60_000);
    // 口语步骤："打开官网首页"
    // 预期："首页渲染成功，顶部导航可见"
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

  test("S2 [PC] 点击顶部导航「联系我们」", async ({ page }) => {
    test.setTimeout(6 * 60_000);
    // 口语步骤："点击顶部导航「联系我们」"
    // 预期："触发跳转，进入联系我们页面"
    // 自动实现：点击「联系我们」 ｜ 前置链：无
    wireCapture(page, '前台');
    const t0 = Date.now();
    const logs: string[] = [];
    let status: 'ok' | 'fail' = 'ok';
    try {

      {
        await openHome(page, logs);
      }
      const __navPath = "";
      if (__navPath) { await page.goto(new URL(__navPath, pcUrl('home')).toString(), { waitUntil: 'domcontentloaded', timeout: 45_000 }); await page.waitForTimeout(2_500); }
      await clickByText(page, logs, "联系我们");
    } catch (e: any) {
      status = 'fail';
      logs.push(`异常: ${String(e.message || e).slice(0, 300)}`);
    }
    await recordStep("S2", "点击顶部导航「联系我们」", page, status, logs, t0);
    expect(status, `S2 失败: ${logs.join(' | ')}`).toBe('ok');
  });

  test("S3 [PC] 断言跳转到联系页 URL", async ({ page }) => {
    test.setTimeout(6 * 60_000);
    // 口语步骤："断言跳转到联系页 URL"
    // 预期："URL 含 contact 或 lianxi 等联系页片段"
    // 自动实现：断言 URL 片段 ｜ 前置链：无
    wireCapture(page, '前台');
    const t0 = Date.now();
    const logs: string[] = [];
    let status: 'ok' | 'fail' = 'ok';
    try {

      {
        await openHome(page, logs);
      }
      {
        const __navPath = "";
      if (__navPath) { await page.goto(new URL(__navPath, pcUrl('home')).toString(), { waitUntil: 'domcontentloaded', timeout: 45_000 }); await page.waitForTimeout(2_500); }
      await clickByText(page, logs, "联系我们");
      }
      await expectUrl(page, logs, "contact|lianxi|about");
    } catch (e: any) {
      status = 'fail';
      logs.push(`异常: ${String(e.message || e).slice(0, 300)}`);
    }
    await recordStep("S3", "断言跳转到联系页 URL", page, status, logs, t0);
    expect(status, `S3 失败: ${logs.join(' | ')}`).toBe('ok');
  });

  test("S4 [PC] 向下滚动定位留言区块", async ({ page }) => {
    test.setTimeout(6 * 60_000);
    // 口语步骤："向下滚动定位留言区块"
    // 预期："页面滚动后「留言」区块可见"
    // 自动实现：滚动定位到「留言」 ｜ 前置链：无
    wireCapture(page, '前台');
    const t0 = Date.now();
    const logs: string[] = [];
    let status: 'ok' | 'fail' = 'ok';
    try {

      await scrollToText(page, logs, "留言");
    } catch (e: any) {
      status = 'fail';
      logs.push(`异常: ${String(e.message || e).slice(0, 300)}`);
    }
    await recordStep("S4", "向下滚动定位留言区块", page, status, logs, t0);
    expect(status, `S4 失败: ${logs.join(' | ')}`).toBe('ok');
  });

  test("S5 [PC] 确认留言区块已呈现", async ({ page }) => {
    test.setTimeout(6 * 60_000);
    // 口语步骤："确认留言区块已呈现"
    // 预期："联系页出现留言相关文案，表单区域就绪"
    // 自动实现：断言页面文本「留言」 ｜ 前置链：无
    wireCapture(page, '前台');
    const t0 = Date.now();
    const logs: string[] = [];
    let status: 'ok' | 'fail' = 'ok';
    try {

      {
        await openHome(page, logs);
      }
      {
        const __navPath = "";
      if (__navPath) { await page.goto(new URL(__navPath, pcUrl('home')).toString(), { waitUntil: 'domcontentloaded', timeout: 45_000 }); await page.waitForTimeout(2_500); }
      await clickByText(page, logs, "联系我们");
      }
      {
        await scrollToText(page, logs, "留言");
      }
      await expectText(page, logs, "留言");
    } catch (e: any) {
      status = 'fail';
      logs.push(`异常: ${String(e.message || e).slice(0, 300)}`);
    }
    await recordStep("S5", "确认留言区块已呈现", page, status, logs, t0);
    expect(status, `S5 失败: ${logs.join(' | ')}`).toBe('ok');
  });

  test("S6 [PC] 填写留言表单（姓名/邮箱/留言内容）", async ({ page }) => {
    test.setTimeout(6 * 60_000);
    // 口语步骤："填写留言表单（姓名/邮箱/留言内容）"
    // 预期："各输入框成功写入并回读校验一致"
    // 自动实现：填写表单（姓名=测试用户;邮箱=test@example.com;留言=这是一条自动化测试留言，请忽略） ｜ 前置链：无
    wireCapture(page, '前台');
    const t0 = Date.now();
    const logs: string[] = [];
    let status: 'ok' | 'fail' = 'ok';
    try {

      {
        await openHome(page, logs);
      }
      {
        const __navPath = "";
      if (__navPath) { await page.goto(new URL(__navPath, pcUrl('home')).toString(), { waitUntil: 'domcontentloaded', timeout: 45_000 }); await page.waitForTimeout(2_500); }
      await clickByText(page, logs, "联系我们");
      }
      {
        await scrollToText(page, logs, "留言");
      }
      const __navPath = "";
      if (__navPath) { await page.goto(new URL(__navPath, pcUrl('home')).toString(), { waitUntil: 'domcontentloaded', timeout: 45_000 }); await page.waitForTimeout(2_500); }
      await fillForm(page, logs, "姓名=测试用户;邮箱=test@example.com;留言=这是一条自动化测试留言，请忽略");
    } catch (e: any) {
      status = 'fail';
      logs.push(`异常: ${String(e.message || e).slice(0, 300)}`);
    }
    await recordStep("S6", "填写留言表单（姓名/邮箱/留言内容）", page, status, logs, t0);
    expect(status, `S6 失败: ${logs.join(' | ')}`).toBe('ok');
  });

  test("S7 [PC] 点击提交留言按钮", async ({ page }) => {
    test.setTimeout(6 * 60_000);
    // 口语步骤："点击提交留言按钮"
    // 预期："提交按钮被点击并触发提交请求"
    // 自动实现：点击「提交」 ｜ 前置链：无
    wireCapture(page, '前台');
    const t0 = Date.now();
    const logs: string[] = [];
    let status: 'ok' | 'fail' = 'ok';
    try {

      {
        await openHome(page, logs);
      }
      {
        const __navPath = "";
      if (__navPath) { await page.goto(new URL(__navPath, pcUrl('home')).toString(), { waitUntil: 'domcontentloaded', timeout: 45_000 }); await page.waitForTimeout(2_500); }
      await clickByText(page, logs, "联系我们");
      }
      {
        await scrollToText(page, logs, "留言");
      }
      {
        const __navPath = "";
      if (__navPath) { await page.goto(new URL(__navPath, pcUrl('home')).toString(), { waitUntil: 'domcontentloaded', timeout: 45_000 }); await page.waitForTimeout(2_500); }
      await fillForm(page, logs, "姓名=测试用户;邮箱=test@example.com;留言=这是一条自动化测试留言，请忽略");
      }
      const __navPath = "";
      if (__navPath) { await page.goto(new URL(__navPath, pcUrl('home')).toString(), { waitUntil: 'domcontentloaded', timeout: 45_000 }); await page.waitForTimeout(2_500); }
      await clickByText(page, logs, "提交");
    } catch (e: any) {
      status = 'fail';
      logs.push(`异常: ${String(e.message || e).slice(0, 300)}`);
    }
    await recordStep("S7", "点击提交留言按钮", page, status, logs, t0);
    expect(status, `S7 失败: ${logs.join(' | ')}`).toBe('ok');
  });

  test("S8 [PC] 断言留言提交成功", async ({ page }) => {
    test.setTimeout(6 * 60_000);
    // 口语步骤："断言留言提交成功"
    // 预期："提交请求 2xx 或表单清空或出现成功提示文案"
    // 自动实现：断言提交成功（2xx 接口证据 / 成功文案兜底） ｜ 前置链：无
    wireCapture(page, '前台');
    const t0 = Date.now();
    const logs: string[] = [];
    let status: 'ok' | 'fail' = 'ok';
    try {

      {
        await openHome(page, logs);
      }
      {
        const __navPath = "";
      if (__navPath) { await page.goto(new URL(__navPath, pcUrl('home')).toString(), { waitUntil: 'domcontentloaded', timeout: 45_000 }); await page.waitForTimeout(2_500); }
      await clickByText(page, logs, "联系我们");
      }
      {
        await scrollToText(page, logs, "留言");
      }
      {
        const __navPath = "";
      if (__navPath) { await page.goto(new URL(__navPath, pcUrl('home')).toString(), { waitUntil: 'domcontentloaded', timeout: 45_000 }); await page.waitForTimeout(2_500); }
      await fillForm(page, logs, "姓名=测试用户;邮箱=test@example.com;留言=这是一条自动化测试留言，请忽略");
      }
      {
        const __navPath = "";
      if (__navPath) { await page.goto(new URL(__navPath, pcUrl('home')).toString(), { waitUntil: 'domcontentloaded', timeout: 45_000 }); await page.waitForTimeout(2_500); }
      await clickByText(page, logs, "提交");
      }
      await expectSubmitOk(page, logs);
    } catch (e: any) {
      status = 'fail';
      logs.push(`异常: ${String(e.message || e).slice(0, 300)}`);
    }
    await recordStep("S8", "断言留言提交成功", page, status, logs, t0);
    expect(status, `S8 失败: ${logs.join(' | ')}`).toBe('ok');
  });
});
