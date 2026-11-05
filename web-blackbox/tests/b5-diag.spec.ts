/**
 * B5 入库称重专项诊断（2026-09-23）
 * 背景：平台双端跑 B5 两轮失败，症状=点「提交称重」后 goods_inspection/submit 请求从未发出（code=null 停留初始值），
 *       且日志显示「填写 重量=false 长=false 宽=false 高=false」——按 label 定位输入框全失败。
 * 本诊断：check 后 dump 真实表单结构 → 按 ian 步骤（普货-普货/重量100/长1宽1高1）多策略填写 → 提交抓包 → UI 不发请求则接口直调兜底。
 * 试验对象：at260923053010（Campaign#2 重试轮，已签收未称重）。用例编号 B5-DIAG。
 */
import { test, expect, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { bossUrl, bossApi } from './helpers/site';

const TRACKING = process.env.B5_TRACKING || 'at260923053010';
const DATA_DIR = `output/${process.env.B5_RUN_DIR || '2026-09-23_b5diag'}`;

function toCurl(req: { method(): string; url(): string; headers(): Record<string, string>; postData(): string | null }): string {
  let c = `curl -sk -X ${req.method()} '${req.url()}'`;
  for (const [k, v] of Object.entries(req.headers())) {
    if (['host', 'content-length', 'connection'].includes(k.toLowerCase())) continue;
    c += ` \\\n  -H '${k}: ${v}'`;
  }
  const body = req.postData();
  if (body) c += ` \\\n  --data-raw '${body.slice(0, 2000).replace(/'/g, "'\\''")}'`;
  return c;
}

async function bossLogin(page: Page, logs: string[]): Promise<void> {
  await page.goto(`${bossUrl('login')}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3000);
  const envTxt = readFileSync('.env', 'utf-8');
  const acc = /^ONEBUY_BOSS_ACCOUNT=(.*)$/m.exec(envTxt)?.[1]?.trim() || 'admin';
  const pwd = /^ONEBUY_BOSS_PASSWORD=(.*)$/m.exec(envTxt)?.[1]?.trim() || '';
  for (let attempt = 1; attempt <= 8; attempt++) {
    const b64 = await page.evaluate(`(() => { const img = document.querySelector('.captcha-group img, img[src*="data:image"]'); return img ? img.src : ''; })()`);
    let code = '';
    if (String(b64).startsWith('data:image')) {
      const tmp = `/tmp/boss-captcha-b5diag-${attempt}.png`;
      writeFileSync(tmp, Buffer.from(String(b64).split(',').pop() || '', 'base64'));
      try {
        code = execSync(`python3 -c "import ddddocr;print(ddddocr.DdddOcr(show_ad=False).classification(open('${tmp}','rb').read()))"`).toString().trim().replace(/[^a-zA-Z0-9]/g, '');
      } catch { /* OCR 失败继续 */ }
    }
    await page.locator('input[placeholder="请输入用户名"]').fill(acc);
    await page.locator('input[placeholder="请输入密码"]').fill(pwd);
    await page.locator('input[placeholder="请输入验证码"]').fill(code);
    await page.getByRole('button', { name: /登\s*录/ }).first().click().catch(async () => {
      await page.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => /登/.test(x.textContent || '')); if (b) b.click(); })()`);
    });
    await page.waitForTimeout(4000);
    if (!/\/login/.test(page.url())) {
      logs.push(`后台登录成功（第 ${attempt} 次，验证码 ${code}）`);
      return;
    }
    await page.goto(`${bossUrl('login')}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2500);
  }
  throw new Error('后台登录 8 次均失败');
}

test.describe('B5 称重诊断', () => {
  test('weigh-in 表单结构 dump + 按 ian 步骤提交', async ({ browser }) => {
    test.setTimeout(10 * 60_000);
    const boss = await (await browser.newContext({ locale: 'zh-CN', viewport: { width: 1600, height: 900 } })).newPage();
    const logs: string[] = [];
    const curls: any[] = [];
    let submitCode: number | null = null, submitMsg = '', submitRespRaw = '';
    boss.on('response', (r) => {
      const req = r.request();
      if (/goods_inspection|weigh/i.test(req.url())) {
        const entry: any = { method: req.method(), url: req.url(), status: r.status(), curl: toCurl(req) };
        curls.push(entry);
      }
      if (/goods_inspection\/submit/.test(r.url())) {
        r.text().then((t) => { submitRespRaw = t; try { const j = JSON.parse(t); submitCode = j?.code; submitMsg = j?.msg || ''; } catch { submitCode = -1; } }).catch(() => {});
      }
    });

    await bossLogin(boss, logs);

    // 1) 打开称重页 + check 快递单号
    await boss.goto(`${bossUrl('weighIn')}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await boss.waitForTimeout(5000);
    await boss.locator('input[placeholder*="快递单号"]').first().fill(TRACKING);
    await boss.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.trim() === '确认'); if (b) b.click(); })()`);
    await boss.waitForTimeout(4500);

    // 2) dump 表单结构（check 之后才渲染）
    const dump = await boss.evaluate(`(() => {
      const vis = (el) => !!el && el.offsetParent !== null;
      const inputs = Array.from(document.querySelectorAll('input')).filter(vis).map((ip, i) => ({
        idx: i,
        type: ip.type,
        placeholder: ip.placeholder || '',
        value: ip.value || '',
        cls: (ip.className || '').slice(0, 80),
        readonly: ip.readOnly,
        formLabel: (() => { const f = ip.closest('.el-form-item'); const l = f && f.querySelector('.el-form-item__label'); return l ? l.textContent.trim() : null; })(),
        parentCls: ((ip.parentElement || {}).className || '').slice(0, 60),
      }));
      const formItems = Array.from(document.querySelectorAll('.el-form-item')).map((f) => ({
        label: ((f.querySelector('.el-form-item__label') || {}).textContent || '').trim(),
        placeholders: Array.from(f.querySelectorAll('input')).map((x) => x.placeholder).join('|'),
        isHidden: !vis(f),
      }));
      const cascaders = Array.from(document.querySelectorAll('.el-cascader')).map((c) => ({ visible: vis(c), value: (c.querySelector('input') || {}).value || '' }));
      const buttons = Array.from(document.querySelectorAll('button')).filter(vis).map((b) => b.textContent.trim()).filter((t) => /称重|提交|确认|保存|确定/.test(t));
      const messages = Array.from(document.querySelectorAll('.el-message, .el-message__content')).map((m) => m.textContent.trim());
      return { inputs, formItems, cascaders, buttons, messages, url: location.href };
    })()`);
    writeFileSync(`${DATA_DIR}/b5-dom-dump.json`, JSON.stringify(dump, null, 2));
    logs.push(`DOM dump：可见 input ${dump.inputs.length} 个 / form-item ${dump.formItems.length} 个 / 级联 ${dump.cascaders.length} 个`);
    logs.push(`按钮：${dump.buttons.join(' | ')}`);
    logs.push(`form-items：${JSON.stringify(dump.formItems.filter((f: any) => !f.isHidden))}`);
    logs.push(`inputs：${JSON.stringify(dump.inputs.slice(0, 12))}`);

    // 3) 级联选普货-普货（存在才选）
    const cascVisible = dump.cascaders.some((c: any) => c.visible);
    if (cascVisible) {
      await boss.evaluate(`(() => { const c = document.querySelector('.el-cascader'); const ip = c && c.querySelector('input'); if (ip) ip.click(); })()`);
      await boss.waitForTimeout(1200);
      const p1 = await boss.evaluate(`(() => { const nodes = Array.from(document.querySelectorAll('.el-cascader-menu .el-cascader-node')).filter((n) => n.offsetParent !== null); const t = nodes.find((n) => /^普货$/.test((n.textContent || '').trim())); if (!t) return false; t.click(); return true; })()`);
      await boss.waitForTimeout(1200);
      let p2 = false;
      if (p1) {
        p2 = await boss.evaluate(`(() => { const ms = Array.from(document.querySelectorAll('.el-cascader-menu')).filter((m) => m.offsetParent !== null); const last = ms[ms.length - 1]; const nodes = last ? Array.from(last.querySelectorAll('.el-cascader-node')).filter((n) => n.offsetParent !== null) : []; const t = nodes.find((n) => /^普货$/.test((n.textContent || '').trim())); if (t) { t.click(); return true; } return false; })()`);
        await boss.waitForTimeout(800);
      }
      logs.push(`级联：一级=${p1} 二级=${p2}`);
    } else {
      logs.push('级联：页面无可见 el-cascader（可能默认已带类型）');
    }

    // 4) 按 ian 步骤填数字框：策略A=按 label；策略B=按 placeholder；策略C=可见 number/text 输入框按序
    const setVal = (ip: any, v: string) => {
      const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      s.call(ip, v);
      ip.dispatchEvent(new Event('input', { bubbles: true }));
      ip.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const fillByLabel = await boss.evaluate(`((pairs) => {
      const vis = (el) => !!el && el.offsetParent !== null;
      const out = {};
      for (const [lb, v] of pairs) {
        const it = Array.from(document.querySelectorAll('.el-form-item')).find((f) => vis(f) && ((f.querySelector('.el-form-item__label') || {}).textContent || '').includes(lb));
        const ip = it && it.querySelector('input');
        if (!ip) { out[lb] = false; continue; }
        const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        s.call(ip, v); ip.dispatchEvent(new Event('input', { bubbles: true })); ip.dispatchEvent(new Event('change', { bubbles: true }));
        out[lb] = true;
      }
      return out;
    })(${JSON.stringify([['重量', '100'], ['长', '1'], ['宽', '1'], ['高', '1']])})`);
    logs.push(`策略A(按label)填写结果: ${JSON.stringify(fillByLabel)}`);

    const needB = Object.values(fillByLabel as any).some((x) => !x);
    if (needB) {
      const fillByPh = await boss.evaluate(`((pairs) => {
        const vis = (el) => !!el && el.offsetParent !== null;
        const out = {};
        for (const [ph, v] of pairs) {
          const ip = Array.from(document.querySelectorAll('input')).find((x) => vis(x) && (x.placeholder || '').includes(ph));
          if (!ip) { out[ph] = false; continue; }
          const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          s.call(ip, v); ip.dispatchEvent(new Event('input', { bubbles: true })); ip.dispatchEvent(new Event('change', { bubbles: true }));
          out[ph] = true;
        }
        return out;
      })(${JSON.stringify([['重量', '100'], ['长', '1'], ['宽', '1'], ['高', '1']])})`);
      logs.push(`策略B(按placeholder)填写结果: ${JSON.stringify(fillByPh)}`);
    }

    // 5) 提交称重
    await boss.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => /提交称重/.test(x.textContent || '')); if (b) b.click(); })()`);
    for (let i = 0; i < 8 && submitCode === null; i++) await boss.waitForTimeout(1000);
    logs.push(`UI 提交 submit code=${submitCode} msg=${submitMsg} resp=${submitRespRaw.slice(0, 200)}`);
    // 提交后的 toast（校验错误会在这里）
    await boss.waitForTimeout(1500);
    const toasts = await boss.evaluate(`(() => Array.from(document.querySelectorAll('.el-message, .el-message__content, .el-form-item__error')).map((m) => m.textContent.trim()).filter(Boolean))()`);
    logs.push(`提交后提示/校验错误：${JSON.stringify(toasts)}`);

    // 6) UI 不发请求 → 接口直调兜底（mark_no=快递单号, ogid 从 check 已知商品；长宽高=1）
    if (submitCode === null) {
      logs.push('UI 未发出 submit 请求，尝试接口直调兜底…');
      const token = await boss.evaluate(`(() => localStorage.getItem('admin_token') || '')()`);
      // 找 ogid：从称重列表接口拿（handled:1 里按快递单号）
      const ogid = await boss.evaluate(async (args) => {
        const r = await fetch('/api/admin/v1/warehouse/goods_inspection/check', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-token': args.token },
          body: JSON.stringify({ express_no: args.tracking, merge: 1 }),
        });
        const j = await r.json();
        const row = j?.data && (Array.isArray(j.data) ? j.data[0] : (j.data.list || j.data.goods || [])[0] || j.data);
        const g = row && (row.goods || [])[0] || row || {};
        return { code: j?.code, ogid: g.id || g.order_goods_id || row?.order_goods_id || '', keys: row ? Object.keys(row).slice(0, 15) : [] };
      }, { token, tracking: TRACKING });
      logs.push(`check 复查: code=${(ogid as any).code} ogid=${(ogid as any).ogid} keys=${JSON.stringify((ogid as any).keys)}`);
      if ((ogid as any).ogid) {
        const direct = await boss.evaluate(async (args) => {
          const r = await fetch('/api/admin/v1/warehouse/goods_inspection/submit', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-token': args.token },
            body: JSON.stringify({ express_no: args.tracking, data: [{ order_goods_id: String(args.ogid), mark_no: args.tracking, inspection_status: 1, inspection_goods_type: [69], weight: 100, length: 1, width: 1, height: 1 }] }),
          });
          const t = await r.text();
          return t.slice(0, 400);
        }, { token, tracking: TRACKING, ogid: (ogid as any).ogid });
        logs.push(`接口直调 submit 响应: ${direct}`);
      }
    }

    writeFileSync(`${DATA_DIR}/b5-diag-result.json`, JSON.stringify({ tracking: TRACKING, logs, curls, submitCode, submitMsg }, null, 2));
    console.log('\n===== B5-DIAG 日志 =====');
    logs.forEach((l) => console.log('[B5D]', l));
    expect(true).toBeTruthy();
  });
});
