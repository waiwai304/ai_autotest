/**
 * ⚙️ 自动生成用例·真实执行版（OneBuy 测试平台 /scenarios/cases/create/ → doc_actions.py 自动扩充）
 * 用例：verify-form · 验证
 * 说明：d
 * 端：pc ｜ 需要登录：否 ｜ 含写操作：是（真实数据）
 * 生成时间：2026-11-04 17:50 ｜ 实现模式：auto-v1（口语步骤 → 动作原语 → helpers/docflow.ts 真实执行）
 *
 * 本文件由程序根据口语化步骤自动编写，可直接执行：
 *   - 动作库：tests/helpers/docflow.ts（站点改版只需更新该文件，所有自动用例同步生效）
 *   - 每步自包含前置链（登录→搜索→打开商品等）；串行执行（serial）——前序失败后续 skip，
 *     不在缺失前置数据的情况下硬跑（尤其「注册新账号」链：注册失败不再回退站点测试账号）
 *   - 每步真实断言 + API 捕获（curl）+ 截图留证，worker 分片写入报告自动合并
 *
 * 步骤实现清单：
 *   S1 ✅ open_home：打开首页
 *   S2 ✅ goto_path：跳转 /contact
 *   S3 ✅ fill_form：填写表单（姓名=测试用户;邮箱=test@example.com;手机=13800138000;主题=自动化测试;留言=这是一条自动化测试留言，请忽略）
 *   S4 ✅ click_text：点击「留言」
 *   S5 ✅ expect_submit_ok：断言提交成功（2xx 接口证据 / 成功文案兜底）
 */
import { test, expect } from '@playwright/test';
import { pcHome, wapHome, pcUrl } from './helpers/site';
import { makeRecorder, login, register, searchPickAndOpen, waitDetailRendered, addCartAndVerify, openCartAndCheck, openHome, expectText, fillForm, clickByText, expectSubmitOk } from './helpers/docflow';
import { wapLogin, wapOpenHome, wapOpenPath, wapExpectText } from './helpers/wapflow';

const { wireCapture, recordStep } = makeRecorder('tests/doc-verify-form.spec.ts', 'doc');

// 2026-11-04 ian：链式用例串行执行——前序步骤失败（如 S1 注册失败）时后续步骤 skip，
// 不再各自独立硬跑并静默回退站点测试账号（避免语义假通过，报告如实显示 skip 原因）。
test.describe.configure({ mode: 'serial' });

test.describe("verify-form · 验证", () => {

  test("S1 [PC] 打开官网首页", async ({ page }) => {
    test.setTimeout(6 * 60_000);
    // 口语步骤："打开官网首页"
    // 预期："首页正常"
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

  test("S2 [PC] 打开联系我们页面", async ({ page }) => {
    test.setTimeout(6 * 60_000);
    // 口语步骤："打开联系我们页面"
    // 预期："含留言区块"
    // 自动实现：跳转 /contact ｜ 前置链：无
    wireCapture(page, '前台');
    const t0 = Date.now();
    const logs: string[] = [];
    let status: 'ok' | 'fail' = 'ok';
    try {

      await page.goto(new URL("/contact", pcUrl('home')).toString(), { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.waitForTimeout(3_000);
      logs.push(`已打开 "/contact"`);
    } catch (e: any) {
      status = 'fail';
      logs.push(`异常: ${String(e.message || e).slice(0, 300)}`);
    }
    await recordStep("S2", "打开联系我们页面", page, status, logs, t0);
    expect(status, `S2 失败: ${logs.join(' | ')}`).toBe('ok');
  });

  test("S3 [PC] 填写留言表单", async ({ page }) => {
    test.setTimeout(6 * 60_000);
    // 口语步骤："填写留言表单"
    // 预期："可填写"
    // 自动实现：填写表单（姓名=测试用户;邮箱=test@example.com;手机=13800138000;主题=自动化测试;留言=这是一条自动化测试留言，请忽略） ｜ 前置链：无
    wireCapture(page, '前台');
    const t0 = Date.now();
    const logs: string[] = [];
    let status: 'ok' | 'fail' = 'ok';
    try {

      const __navPath = "/contact";
      if (__navPath) { await page.goto(new URL(__navPath, pcUrl('home')).toString(), { waitUntil: 'domcontentloaded', timeout: 45_000 }); await page.waitForTimeout(2_500); }
      await fillForm(page, logs, "姓名=测试用户;邮箱=test@example.com;手机=13800138000;主题=自动化测试;留言=这是一条自动化测试留言，请忽略");
    } catch (e: any) {
      status = 'fail';
      logs.push(`异常: ${String(e.message || e).slice(0, 300)}`);
    }
    await recordStep("S3", "填写留言表单", page, status, logs, t0);
    expect(status, `S3 失败: ${logs.join(' | ')}`).toBe('ok');
  });

  test("S4 [PC] 点击提交", async ({ page }) => {
    test.setTimeout(6 * 60_000);
    // 口语步骤："点击提交"
    // 预期："提交成功"
    // 自动实现：点击「留言」 ｜ 前置链：无
    wireCapture(page, '前台');
    const t0 = Date.now();
    const logs: string[] = [];
    let status: 'ok' | 'fail' = 'ok';
    try {

      const __navPath = "/contact";
      if (__navPath) { await page.goto(new URL(__navPath, pcUrl('home')).toString(), { waitUntil: 'domcontentloaded', timeout: 45_000 }); await page.waitForTimeout(2_500); }
      await clickByText(page, logs, "留言");
    } catch (e: any) {
      status = 'fail';
      logs.push(`异常: ${String(e.message || e).slice(0, 300)}`);
    }
    await recordStep("S4", "点击提交", page, status, logs, t0);
    expect(status, `S4 失败: ${logs.join(' | ')}`).toBe('ok');
  });

  test("S5 [PC] 校验结果", async ({ page }) => {
    test.setTimeout(6 * 60_000);
    // 口语步骤："校验结果"
    // 预期："接口 2xx"
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
    await recordStep("S5", "校验结果", page, status, logs, t0);
    expect(status, `S5 失败: ${logs.join(' | ')}`).toBe('ok');
  });
});
