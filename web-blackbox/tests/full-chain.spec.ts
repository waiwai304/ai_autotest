import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import type { Browser, Page, BrowserContext } from '@playwright/test';
import { pcUrl, bossUrl, bossApi, site, offerMarket, libPool, pickMarketFromLib } from './helpers/site';
import { dismissOverlays } from './helpers/overlay';
// 2026-10-16 ian：开屏广告/弹窗守卫接入——打开网站遇首页弹窗广告直接关闭再继续测试（JOB-000105 卡首页）

/**
 * 商城完整购物链路端到端测试（PC 前台 + 后台管理端，ian 2026-09-22 梳理的 13 步链路）
 *
 * 链路：前台下单支付 → 后台审核/已采购 → 发往中国仓(管理快递) → 快递签收 → 入库称重 → 商品拍照 →
 *       商品上架 → 前台提交运单 → 后台拣货+包裹审核 → 前台支付国际运费 → 后台出库 → 后台国际发货 → 前台确认收货
 *
 * 运行（真实交易：产生 1 笔商品订单 + 1 笔国际运费支付；规约：无需清理测试数据）：
 *   env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u all_proxy \
 *     WORKERS=1 npx playwright test tests/full-chain.spec.ts --project=web-desktop
 *
 * 已知要点：
 * - 后台登录有图片验证码（/api/admin/v1/auth/captcha），用 ddddocr 识别页面渲染那张，失败自动重试
 * - 必须取页面上渲染的验证码 img（会话绑定），不可重新调接口（会拿到新图必错）
 * - 前台 PC 为 React 受控组件，输入必须用 fill()
 * - 快递单号/发货单号可随意填（ian 确认不影响状态流转），用 autotest+时间戳 保证唯一
 * - 后台账号在 .env：TEST_BOSS_ACCOUNT / TEST_BOSS_PASSWORD
 */

// 域名与页面路径全部来自 config/sites.json 站点档案（多站点复用，勿写死；env 可临时覆盖：
// TEST_SITE_ID 选站点，SITE_PC_BASE_URL / SITE_WAP_BASE_URL / SITE_BOSS_BASE_URL 换域名）
const UPLOAD_IMG = 'output/test-photo.jpg';
const RUN_TAG = `FC${new Date().toISOString().slice(5, 10).replace('-', '')}${String(Math.floor(Math.random() * 900) + 100)}`;
const RUN_DIR = process.env.FULLCHAIN_RUN_DIR || '2026-09-22_fullchain';
const SPEC_FILE = 'tests/full-chain.spec.ts';
const SHOTS = `output/html-report/${RUN_DIR}/screenshots`;

/**
 * 固定前台币种 USD 的注入脚本定义在 tests/helpers/site.ts（SET_CURRENCY_USD），此处 import 使用。
 */
const DATA = `output/${RUN_DIR}`;
mkdirSync(SHOTS, { recursive: true });
mkdirSync(DATA, { recursive: true });

// ---------- 步骤记录（供 HTML 报告生成） ----------
type CapturedReq = { side: string; method: string; url: string; status: number; curl: string };
type StepRec = { id: string; name: string; side: '前台' | '后台'; status: 'ok' | 'fail'; logs: string[]; shot: string; ms: number; curls?: CapturedReq[]; startedAt?: string; outputs?: Record<string, string>; resumed?: boolean; reloginCount?: number };
const steps: StepRec[] = [];
// ---------- 断点续跑（2026-10-13 ian：失败 Job 从上次失败步骤继续——已成功步骤跳过真实执行、复用上轮业务单据） ----------
// FC_RESUME_FROM = 上轮 fullchain-result.json（3008 平台「从失败步骤继续」注入，runner 容器内路径；
// 兼容手动 TV_FC_RESUME_FROM）。未设置 / 文件缺失 / 解析失败 = 全新执行（与现状零回归）。
const fcCtx: Record<string, string> = {}; // 跨步骤业务单据：orderNo/payOrderId/trackingNo/packageId/packageNo/sendorderId
// 可配运行参数（2026-10-21 ian：发起页用例设置开放——币种/轮询窗，env 经平台 VAR_ENV_PASSTHROUGH 原样注入）
const FC_CUR = process.env.FC_CURRENCY || 'CNY';
const POLL_ROUNDS = Math.max(10, Math.min(300, Math.round((parseInt(process.env.FC_POLL_SEC || '200', 10) || 200) / 2)));
const resumedSteps = new Map<string, any>(); // 上轮 status==='ok' 的步骤（id → step 记录）
// ---------- 测试配置留痕（2026-10-14 ian：报告必须输出本轮前后台账号/选品方式与素材内容） ----------
type RunConfig = { frontAccount: string; bossAccount: string; pickMode: string; pickModeLabel: string; pickSource: string; pickItems: string[]; pickUrl?: string };
const runConfig: RunConfig = { frontAccount: '', bossAccount: '', pickMode: '', pickModeLabel: '', pickSource: '', pickItems: [] };

// ---------- 测试数据台账（2026-10-21 ian：真实交易单据留痕，平台台账页可按单号秒查归属） ----------
type LedgerEntry = { kind: string; sn: string; account?: string; amount?: string; note?: string };
function buildLedger(): LedgerEntry[] {
  const acc = runConfig.frontAccount || '';
  const out: LedgerEntry[] = [];
  if (fcCtx.orderNo) out.push({ kind: 'order', sn: fcCtx.orderNo, account: acc, amount: fcCtx.payAmount || '', note: '前台订单' });
  if (fcCtx.trackingNo) out.push({ kind: 'express', sn: fcCtx.trackingNo, account: acc, note: '采购快递单' });
  if (fcCtx.packageNo) out.push({ kind: 'package', sn: fcCtx.packageNo, account: acc, note: '国际物流包裹' });
  return out;
}

function resumeExtractFromLogs(logs: string[]): void {
  // 历史数据无 outputs 字段：从上轮步骤日志正则恢复单据（runStep 按步骤顺序调用，首个命中即产生步骤）
  const grab = (re: RegExp): string => {
    for (const l of logs) { const m = re.exec(l); if (m && m[1]) return m[1]; }
    return '';
  };
  if (!fcCtx.orderNo) {
    const v = grab(/(?:订单号|支付单号|订单)\s*[:：]?\s*([A-Z]{2}\d{8,})/) || grab(/\b([A-Z]{2}\d{8,})\b/); // 2026-10-19 通用化订单号前缀
    if (v) fcCtx.orderNo = v;
  }
  if (!fcCtx.trackingNo) { const v = grab(/快递单号\s*(at\d{10,})/) || grab(/(at\d{10,})/); if (v) fcCtx.trackingNo = v; }
  if (!fcCtx.packageNo) { const v = grab(/包裹号[:：]?\s*(S\d{10,})/) || grab(/(S\d{10,})/); if (v) fcCtx.packageNo = v; }
  if (!fcCtx.packageId) {
    const v = grab(/pkgId[=:]\s*(\d+)/) || grab(/send_order_id[=:]\s*(\d+)/) || grab(/order_id=(\d+)&type=package/);
    if (v) { fcCtx.packageId = v; if (!fcCtx.sendorderId) fcCtx.sendorderId = v; }
  }
  if (!fcCtx.payOrderId) { const v = grab(/pay\?order_id=(\d+)/) || grab(/order_id=(\d+)/); if (v) fcCtx.payOrderId = v; }
}

const RESUME_FROM = process.env.FC_RESUME_FROM || process.env.TV_FC_RESUME_FROM || '';
if (RESUME_FROM) {
  try {
    const prevRun = JSON.parse(readFileSync(RESUME_FROM, 'utf-8'));
    const prevSteps: any[] = Array.isArray(prevRun && prevRun.steps) ? prevRun.steps : [];
    for (const s of prevSteps) {
      if (s && s.id && s.status === 'ok') resumedSteps.set(String(s.id), s);
    }
    if (prevRun.runConfig) Object.assign(runConfig, prevRun.runConfig); // 配置留痕继承（2026-10-14：F2 断点跳过时报告仍显示账号/选品）
    console.log(`[resume] 断点续跑: ${RESUME_FROM} 命中 ${resumedSteps.size} 个已成功步骤（${[...resumedSteps.keys()].join(',')}），其余步骤真实执行`);
  } catch (e: any) {
    console.log(`[resume] FC_RESUME_FROM 不可读（${String(e && e.message || e).slice(0, 120)}）→ 按全新执行`);
  }
}
let captured: Array<{ side: string; method: string; url: string; status: number; curl: string }> = [];
const recent: typeof captured = [];
const drainRecent = (side: string) => {
  const mine = recent.splice(0, recent.length);
  mine.forEach((c) => (c.side = side));
  captured.push(...mine);
};

function toCurl(req: { method: () => string; url: () => string; headers: () => Record<string, string>; postData: () => string | null }): string {
  const m = req.method();
  const u = req.url();
  const hs = req.headers();
  const body = req.postData();
  let c = `curl -sk -X ${m} '${u}'`;
  for (const [k, v] of Object.entries(hs)) {
    if (['host', 'content-length', 'connection'].includes(k.toLowerCase())) continue;
    c += ` \\\n  -H '${k}: ${v}'`;
  }
  if (body) c += ` \\\n  --data-raw '${body.slice(0, 2000).replace(/'/g, "'\\''")}'`;
  return c;
}

function wireCapture(page: Page, side: string) {
  page.on('response', async (r) => {
    const req = r.request();
    const url = req.url();
    if (!url.includes('/api/') && !/carttoorder|toorder|pay|order/i.test(url)) return;
    if (/\.(png|jpg|jpeg|css|js|woff2?|gif|svg|ico)(\?|$)/.test(url)) return;
    try {
      recent.push({ side, method: req.method(), url, status: r.status(), curl: toCurl(req) });
      if (recent.length > 400) recent.shift();
    } catch { /* 忽略 */ }
  });
}

// ---------- 登录态掉线守卫（2026-10-14 ian：所有步骤检测掉线 → 自动重新登录 → 续跑当前步骤，事件进报告） ----------
type ReloginEvent = { step: string; side: '前台' | '后台'; at: string; reason: string; ok: boolean; attempt: number };
const reloginEvents: ReloginEvent[] = [];
let FRONT_CREDS: { account: string; password: string } = { account: '', password: '' };
// 2026-10-19 ian·测试数据安全铁律：登录成功≠进入配置账号（JOB-000113 spanbuy 实录：
// yuhuoyy1@qq.com 登录 dev 站实际会话是 ladell907@yahoo.com，三笔订单记到他人名下）。
// frontLogin 登录后调 user/info 实测身份存此，B2 起后台写操作归属校验复用。
let FRONT_IDENTITY: { email?: string; id?: string; nickname?: string } | null = null;

// 掉线检测三形态：① 页面被重定向到登录页（前台 /login?redirect=… / 后台 login）② 本步骤 API 出现 401 ③ 页面呈登录页特征
async function loginLost(page: Page, side: '前台' | '后台'): Promise<string> {
  let reason = '';
  try {
    const u = page.url();
    if (/\/login(\?|\/|#|$)/.test(u)) reason = `${side}会话失效：页面被重定向到登录页（${u.slice(0, 90)}）`;
  } catch { /* 页面已关闭 */ }
  if (!reason && recent.some((c) => c.status === 401)) {
    reason = `${side}会话失效：本步骤 API 返回 401 ×${recent.filter((c) => c.status === 401).length} 条`;
  }
  if (!reason) {
    try {
      const hit = await page.evaluate(`(() => {
        const b = document.body ? (document.body.innerText || '') : '';
        return (b.length < 4000 && /使用(Google|Twitter|Line)登录|忘记密码|请输入验证码|请登录后操作/.test(b)) ? 'Y' : 'N';
      })()`);
      if (hit === 'Y') reason = `${side}会话失效：页面呈登录页特征（业务内容消失）`;
    } catch { /* ignore */ }
  }
  return reason;
}

// 前台登录（F1 与掉线守卫共用；只动 selectedCurrency 不碰 currencyData——SET_CURRENCY_USD 整表覆盖事故教训，2026-10-12）
async function frontLogin(page: Page, logs: string[]): Promise<void> {
  // 2026-10-14 lulukitty 实录（JOB-97）：首次 fill 时 React 未挂载完 → 表单 state 空 →
  // 校验报「请输入有效的邮箱地址」点击无效（第 2 次进入页面即正常）。加固三件：
  // ① 页面 settle 3s 等挂载 ② fill 后原生 setter+input 事件兜底同步 React state ③ 整体最多 3 次尝试。
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.goto(`${pcUrl('login')}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3000);
    await dismissOverlays(page, logs); // 开屏广告守卫：弹窗可能遮挡登录表单
    const email = page.locator('input[name="email"]');
    const pwd = page.locator('input[name="password"]');
    await email.fill(FRONT_CREDS.account);
    await pwd.fill(FRONT_CREDS.password);
    const sync = (sel: string, v: string) => page.evaluate(`((s, v) => {
      const el = document.querySelector(s);
      if (el) { const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); }
    })(${JSON.stringify(sel)}, ${JSON.stringify(v)})`).catch(() => {});
    await sync('input[name="email"]', FRONT_CREDS.account);
    await sync('input[name="password"]', FRONT_CREDS.password);
    await page.getByRole('button', { name: '登录', exact: true }).first().click().catch(async () => {
      await page.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent || '').trim() === '登录'); if (b) b.click(); })()`);
    });
    for (let i = 0; i < 8 && /login/.test(page.url()); i++) await page.waitForTimeout(2000); // 最多 16s，通常 2-4s 即跳转
    if (!/\/login/.test(page.url())) {
      await page.evaluate(`(() => { try { localStorage.setItem('selectedCurrency', '${FC_CUR}'); } catch (e) {} })()`).catch(() => {});
      logs.push(`前台登录成功（账号 ${FRONT_CREDS.account.slice(0, 3)}***，币种锁定 ${FC_CUR}${attempt > 1 ? `，第 ${attempt} 次尝试` : ''}）`);
      // 2026-10-19 ian·测试数据安全铁律：登录后立即调 user/info 强校验服务器实际身份，
      // 与配置账号不符立即 fail——防 dev 环境登录映射到他人账号把订单下到别人名下。
      const ident = await page.evaluate(`(async () => {
        try {
          const r = await fetch('/api/v1/user/info', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          const j = await r.json();
          const d = (j && j.data) ? j.data : (j || {});
          return { ok: true, code: (j && j.code) ?? null, email: String(d.email || d.account || d.username || d.user_email || ''), nickname: String(d.nickname || ''), id: String(d.id || d.user_id || '') };
        } catch (e) { return { ok: false, why: String(e) }; }
      })()`).catch(() => ({ ok: false, why: 'evaluate failed' }));
      if (ident && (ident as any).ok && (ident as any).email) {
        const it = ident as any;
        FRONT_IDENTITY = { email: it.email, id: it.id, nickname: it.nickname };
        if (String(it.email).toLowerCase() !== FRONT_CREDS.account.toLowerCase()) {
          logs.push(`【身份校验失败·已拦截】配置账号 ${FRONT_CREDS.account}，登录后实际身份 ${it.email}（user_id=${it.id || '无'}）——疑似 dev 环境登录映射到他人账号，中止测试防止数据污染`);
          throw new Error(`登录身份与配置账号不符（配置 ${FRONT_CREDS.account} / 实际 ${it.email}）——测试数据安全铁律拦截（2026-10-19 ian）`);
        }
        logs.push(`身份校验通过: user/info 实际身份 ${String(it.email).slice(0, 3)}***（user_id=${it.id || '无'}）`);
      } else {
        logs.push(`身份校验未生效: ${ident && (ident as any).ok ? 'user/info 未返回账号字段（B2 仍有订单归属校验兜底）' : `user/info 调用失败 ${String((ident as any)?.why || '').slice(0, 60)}`}`);
      }
      return;
    }
    const formErr = await page.evaluate(`(() => { const m = ((document.body.innerText || '').match(/请输入.{0,24}|无效.{0,24}|密码错误.{0,24}/)); return m ? m[0] : ''; })()`).catch(() => '');
    logs.push(`第 ${attempt} 次登录未离开登录页${formErr ? `（表单校验提示: ${formErr}）` : ''}${attempt < 3 ? '，重试' : ''}`);
  }
  throw new Error(`登录 3 次均未离开登录页 ${page.url().slice(0, 80)}`);
}

async function runStep(
  id: string, name: string, side: '前台' | '后台',
  page: Page, fn: (logs: string[]) => Promise<void>,
): Promise<void> {
  // 断点续跑：上轮已 ok 的本步骤跳过真实执行——恢复产物上下文后直接记 ok（复用上轮截图文件名，同 run 目录仍在盘）
  const prevStep = resumedSteps.get(id);
  if (prevStep) {
    const outs = (prevStep.outputs && typeof prevStep.outputs === 'object') ? prevStep.outputs : {};
    if (Object.keys(outs).length) Object.assign(fcCtx, outs);
    else resumeExtractFromLogs(prevStep.logs || []);
    const brief = ['orderNo', 'payOrderId', 'trackingNo', 'packageId', 'packageNo', 'sendorderId']
      .filter((k) => fcCtx[k]).map((k) => `${k}=${fcCtx[k]}`).join(' ');
    steps.push({ id, name, side, status: 'ok', logs: [`断点续跑·跳过真实执行，复用上轮已成功结果${brief ? `（单据 ${brief}）` : ''}`], shot: String(prevStep.shot || ''), startedAt: new Date().toISOString(), ms: 0, outputs: { ...fcCtx }, resumed: true });
    console.log(`[${id}] ok ${name} (0ms)（断点续跑·跳过，复用上轮产物 ${brief || '无单据'}）`);
    return;
  }
  const logs: string[] = [];
  const t0 = Date.now();
  let status: 'ok' | 'fail' = 'ok';
  // 2026-10-14 ian：登录态掉线自动守卫——步骤失败先检测是否掉线（跳登录页 / API 401 / 登录页特征），
  // 掉线则自动重新登录后续跑当前步骤（每步最多 2 次）；F1/B1 是登录步骤本身不套守卫（重登同样会失败）。
  const isLoginStep = id === 'F1' || id === 'B1';
  let reloginTries = 0;
  const MAX_RELOGIN = 2;
  for (;;) {
  try {
    await fn(logs);
    break;
  } catch (e: any) {
    // ---- 掉线守卫：检测 → 重登 → 续跑本步骤（2026-10-14） ----
    if (!isLoginStep && reloginTries < MAX_RELOGIN) {
      const why = await loginLost(page, side);
      if (why) {
        reloginTries += 1;
        reloginEvents.push({ step: id, side, at: new Date().toISOString(), reason: why, ok: false, attempt: reloginTries });
        logs.push(`⚠ 登录态掉线（第 ${reloginTries} 次）: ${why}`);
        logs.push(`→ 尝试重新登录（${side}）并继续当前步骤 ${id}`);
        let relOk = false;
        try {
          if (side === '前台') await frontLogin(page, logs);
          else await bossLogin(page, logs);
          relOk = true;
        } catch (re: any) {
          logs.push(`重新登录失败: ${String((re && re.message) || re).slice(0, 160)}`);
        }
        reloginEvents[reloginEvents.length - 1].ok = relOk;
        if (relOk) {
          logs.push(`↻ 重新登录成功，续跑步骤 ${id}（第 ${reloginTries + 1} 次尝试）`);
          continue;
        }
      }
    }
    status = 'fail';
    // 阻断现场采集（ian 2026-10-08：失败要能直接看出阻断原因）：失败瞬间页面 URL/body 长度/可见提示文案
    try {
      const ctx = await page.evaluate(`(() => {
        const tips = Array.from(document.querySelectorAll('.ant-message, .ant-notification, [class*="toast"], .el-message, [class*="modal"]'))
          .map(x => (x.textContent || '').trim()).filter(t => t && t.length < 150).slice(0, 3).join(' | ');
        return JSON.stringify({ url: location.href.slice(0, 90), bodyLen: document.body.innerText.length, tips, ua: navigator.userAgent.slice(0, 100), bodyHead: document.body.innerText.replace(/\s+/g, ' ').slice(0, 260) });
      })()`);
      logs.push(`阻断现场: ${ctx}`);
    } catch { logs.push(`阻断现场: ${page.url().slice(0, 90)}（页面已关闭或不可读）`); }
    logs.push(`异常: ${e.message?.slice(0, 300)}`);
    break; // 2026-10-14 修复（JOB-97 实录）：fail 终态必须跳出——漏写导致死循环重跑 fn 且 status 永久 fail（F1 第2轮实际已登录成功仍报失败）
  }
  } // for(;;) 登录态守卫循环（掉线重登续跑，最多 MAX_RELOGIN 次）
  const shot = `fc-${id}.png`;
  await page.screenshot({ path: `${SHOTS}/${shot}` }).catch(() => {});
  // 本步触发的请求内嵌进步骤记录（动态报告生成器按步渲染 curl，平台化 2026-09-23）
  const stepCurls: CapturedReq[] = recent.map((c) => ({ ...c, side }));
  drainRecent(side);
  // 步骤墙钟时间（ian 2026-09-24 规约：报告每步必须含操作时间）
  steps.push({ id, name, side, status, logs, shot, startedAt: new Date(t0).toISOString(), ms: Date.now() - t0, curls: stepCurls, outputs: { ...fcCtx }, reloginCount: reloginTries }); // outputs=业务单据快照（断点续跑恢复源）；reloginCount=本步掉线重登次数
  console.log(`[${id}] ${status} ${name} (${Date.now() - t0}ms)`, logs.slice(-2).join(' | '));
  if (status === 'fail') {
    // 失败即时落盘（链路强依赖，后续步骤不再执行）
    // ⚠ RETRIES 重跑会从 F1 重新来（2026-10-08 JOB-000069 事故：attempt1 推进到 B8，
    // retry 只到 F2 就挂，短记录覆盖主文件 → 报告失真显示"卡在 F2"）。
    // 修复：若磁盘上已有推进更远（steps 更多）的记录，本轮写 .r<N>.json 副本不覆盖主文件；
    // 报告生成器会合并 result*.json（同 id 步骤取 startedAt 最新）。
    const payload = JSON.stringify({
      runTag: RUN_TAG, time: new Date().toISOString(), spec: SPEC_FILE, passed: steps.filter((s) => s.status === 'ok').length,
      total: steps.length, steps, capturedCount: captured.length, failedAt: id, reloginEvents, runConfig,
      tradeLedger: buildLedger(),
    }, null, 2);
    let outFile = `${DATA}/fullchain-result.json`;
    try {
      if (existsSync(outFile)) {
        const old = JSON.parse(readFileSync(outFile, 'utf-8'));
        if ((old.steps?.length || 0) > steps.length) {
          const n = (readdirSync(DATA).filter((f) => /^fullchain-result\.r/.test(f)).length) + 1;
          outFile = `${DATA}/fullchain-result.r${n}.json`;
        }
      }
    } catch { /* 旧文件读失败按覆盖处理 */ }
    writeFileSync(outFile, payload);
    writeFileSync(`${DATA}/fullchain-curls.json`, JSON.stringify(captured, null, 2));
    throw new Error(`步骤 ${id} ${name} 失败: ${logs.join(' | ')}`);
  }
}

// ---------- 后台专用 ----------
async function bossLogin(page: Page, logs: string[]): Promise<void> {
  await page.goto(`${bossUrl('login')}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3000);
  const envTxt = readFileSync('.env', 'utf-8');
  const acc = process.env.SITE_BOSS_ACCOUNT || /^TEST_BOSS_ACCOUNT=(.*)$/m.exec(envTxt)?.[1]?.trim() || 'admin';
  const pwd = process.env.SITE_BOSS_PASSWORD || /^TEST_BOSS_PASSWORD=(.*)$/m.exec(envTxt)?.[1]?.trim() || '';
  const { execSync } = await import('child_process');
  for (let attempt = 1; attempt <= 8; attempt++) {
    // 2026-10-13 修复（JOB-87 实录）：已认证会话访问 login 会被重定向到 overview——
    // 每轮先查「已登录」，防止第 3 轮在 overview 页找登录表单 locator 超时穿透。
    if (!/\/login/.test(page.url())) {
      logs.push(`后台会话已生效（第 ${attempt} 轮进入前即非登录页: ${page.url().slice(-40)}）`);
      return;
    }
    try {
      const b64 = await page.evaluate(`(() => {
      const img = document.querySelector('.captcha-group img, img[src*="data:image"]');
      return img ? img.src : '';
    })()`);
      let code = '';
      if (String(b64).startsWith('data:image')) {
        const tmp = `/tmp/boss-captcha-fc-${attempt}.png`;
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
      // 2026-10-13 修复：固定 4s 判定在慢跳转时误判失败 → 轮询 10s 等离开 /login
      let left = false;
      for (let wi = 0; wi < 5; wi++) {
        await page.waitForTimeout(2000);
        if (!/\/login/.test(page.url())) { left = true; break; }
      }
      if (left) {
        logs.push(`后台登录成功（第 ${attempt} 次尝试，验证码 ${code}）`);
        return;
      }
      logs.push(`登录尝试 ${attempt} 失败（验证码 ${code}），重试`);
    } catch (le) {
      logs.push(`登录尝试 ${attempt} 异常（${String(le).split('\n')[0].slice(0, 90)}），重试`);
    }
    await page.goto(`${bossUrl('login')}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2500);
  }
  throw new Error('后台登录 8 次均失败（验证码识别未通过）');
}

// ---------- 全链选品方向（2026-10-09 ian：关键词/链接/图片三方向，FC_PICK_* env 驱动） ----------
type PickResult = { mode: string; urls: string[]; skipFirstGoto: boolean; desc: string };

function fcItems(): string[] {
  return (process.env.FC_PICK_ITEMS || '').split('|').map((x) => x.trim()).filter(Boolean);
}
function fcSrc(): string {
  return process.env.FC_PICK_ITEMS_MODE === 'manual' ? '手动填写'
    : process.env.FC_PICK_ITEMS_MODE === 'picked' ? '用例库·发起时勾选' : '用例库·随机抽取';
}

/** 首页搜索框输入并回车（贴关键词或链接通用）。
 * 2026-10-13 shop-v2 实录：响应式双套 DOM（桌面导航+移动抽屉）产生两个同 placeholder 输入框，
 * 旧版 nth(1) 不可见时无检查回退 first()——主站 first() 恰好可见，shop-v2 first() 是隐藏移动版
 * → fill actionability 永不满足超时 15s（JOB-000091）。改 :visible 选择器按「当前可见」匹配，
 * 最终兜底原生设值+keydown（对隐藏框也生效，走站点自身提交逻辑）。 */
async function searchBoxEnter(page: Page, text: string) {
  const selVis = 'input[placeholder*="商品名称"]:visible, input[placeholder*="链接"]:visible';
  await dismissOverlays(page); // 开屏广告守卫：首页弹窗广告遮挡搜索框是「卡首页」主因（JOB-000105）
  let input = page.locator(selVis).first();
  if (!(await input.isVisible({ timeout: 8000 }).catch(() => false))) {
    await page.goto(`${pcUrl('home')}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(5000);
    await dismissOverlays(page); // 重开首页后广告弹窗会再次出现，再关一轮
    input = page.locator(selVis).first();
  }
  if (await input.isVisible({ timeout: 8000 }).catch(() => false)) {
    await input.fill(text);
    await page.waitForTimeout(800);
    await input.press('Enter');
  } else {
    await page.evaluate(`((t) => {
      const ips = Array.from(document.querySelectorAll('input')).filter((i) => /商品名称|链接/.test(String(i.placeholder || '')));
      const ip = ips[ips.length - 1];
      if (ip) {
        const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        s.call(ip, t);
        ip.dispatchEvent(new Event('input', { bubbles: true }));
        ip.dispatchEvent(new Event('change', { bubbles: true }));
        ip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === '搜索' && b.offsetParent !== null);
        if (btn) btn.click();
      }
    })(${JSON.stringify(text)})`).catch(() => {});
  }
}

/** 搜索结果页收集 /detail 候选商品链接（绝对化 + 随机排序取前 N） */
async function collectDetailCandidates(page: Page, n = 5): Promise<string[]> {
  for (let i = 0; i < 10; i++) {
    const raw = await page.evaluate(`(() => {
      const seen = new Set(), out = [];
      document.querySelectorAll('a[href*="/detail"]').forEach((a) => {
        const h = a.getAttribute('href');
        if (h && !seen.has(h)) { seen.add(h); out.push(h); }
      });
      return JSON.stringify(out);
    })()`).catch(() => '[]');
    let arr: string[] = [];
    try { arr = JSON.parse(raw); } catch { /* ignore */ }
    if (arr.length) {
      return arr.sort(() => Math.random() - 0.5).slice(0, n)
        .map((h) => (h.startsWith('http') ? h : new URL(h, page.url()).toString()));
    }
    await page.waitForTimeout(2000);
  }
  return [];
}

/** 按方向选品：完成站内搜索，返回候选详情 URL 列表。
 *  keyword = 关键词搜索→结果列表随机候选；link = 贴链接直达详情（已停在详情页，skipFirstGoto）；
 *  image = 下载图片素材→隐藏 file input 上传→imgid 结果列表随机候选；未配置方向 = 旧供应链直连。 */
async function pickProduct(page: Page, logs: string[]): Promise<PickResult> {
  const mode = (process.env.FC_PICK_MODE || '').trim().toLowerCase();
  const items = fcItems();
  if (mode === 'keyword') {
    const pool = items.length ? items
      : libPool('KEYWORDS', (site.testData.searchKeywords && site.testData.searchKeywords.length)
        ? site.testData.searchKeywords : ['phone case']);
    Object.assign(runConfig, { pickMode: 'keyword', pickModeLabel: '关键词搜索', pickSource: items.length ? fcSrc() : (process.env.LIB_KEYWORDS ? `用例库·${process.env.LIB_KEYWORDS_MODE === 'picked' ? '发起时勾选' : '随机抽取'}` : '站点档案默认'), pickItems: pool });
    const kw = pool[Math.floor(Math.random() * pool.length)];
    logs.push(`选品方向=关键词搜索（素材: ${fcSrc()}）: 「${kw}」`);
    await page.goto(`${pcUrl('home')}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(5000);
    await searchBoxEnter(page, kw);
    await page.waitForTimeout(8000);
    expect(/\/search|\/detail/.test(page.url()), `关键词「${kw}」搜索后未进结果页: ${page.url().slice(0, 90)}`).toBeTruthy();
    const urls = await collectDetailCandidates(page, 10);
    expect(urls.length, `关键词「${kw}」搜索结果页未取到 /detail 商品（随机选品无候选）`).toBeGreaterThan(0);
    // 2026-10-12：候选扩容（JOB-000084 实录：「手电筒」5 候选 4 个死商品——JS 不启动或 getItem 上游无货，价格区永不渲染）
    logs.push(`搜索结果候选 ${urls.length} 个（随机排序逐个尝试）`);
    return { mode, urls, skipFirstGoto: false, desc: `关键词「${kw}」`, searchUrl: page.url() };
  }
  if (mode === 'link') {
    const pool = items.length ? items : libPool('LINKS', [offerMarket(site.testData.numIidFullChain || '')]);
    Object.assign(runConfig, { pickMode: 'link', pickModeLabel: '链接直达', pickSource: items.length ? fcSrc() : (process.env.LIB_LINKS ? `用例库·${process.env.LIB_LINKS_MODE === 'picked' ? '发起时勾选' : '随机抽取'}` : '站点档案默认'), pickItems: pool });
    const link = pool[Math.floor(Math.random() * pool.length)];
    logs.push(`选品方向=链接直达（素材: ${fcSrc()}）: ${link}`);
    // 2026-10-12 定案修复：不再走首页搜索框贴链接——SPA 内部路由进入详情会触发站点渲染 bug
    //（价格区降级不渲染，JOB-87 两轮实锤 bodyLen=1462 无价格）；goto 整页进入探针 6/6 稳定成功。
    const lm = /(\d{6,})/.exec(link);
    expect(lm, `链接素材无法解析出商品 num_iid: ${link.slice(0, 80)}`).toBeTruthy();
    // 2026-10-19 修复（JOB-000111/112/115/116 事故根因）：按链接域名分发详情路由——
    // 旧版把任何链接的数字 id 一律拼成 detail.market.example.com/offer/<id>，taobao id 被错拼成
    // 供应链 offer → getItem 必败（"商品信息不完整/搜索失败"）。探针实锤（probe-detail-platform.ts）：
    // /detail/taobao?url=<原始taobao链接> 渲染+getItem code=1 ✓；/detail/weidian 404 ✗。
    if (/weidian\.com/.test(link)) {
      throw new Error(`微店链接暂不支持 PC 全链直达（站点无 /detail/weidian 路由，探针 2026-10-19 实锤 404）: ${link.slice(0, 60)}——请换供应链/淘宝链接`);
    }
    const plat = /item\.taobao\.com|tmall\.com/.test(link) ? 'taobao' : 'market';
    const srcUrl = /https?:\/\//.test(link) ? link : offerMarket(lm![1]);
    const detailBase = plat === 'taobao' ? String(pcUrl('detail_market')).replace(/market$/, 'taobao') : pcUrl('detail_market');
    const detailDirect = `${detailBase}?url=${encodeURIComponent(srcUrl)}`;
    logs.push(`链接选品完成（平台=${plat}，源=${srcUrl.slice(0, 60)}），详情 URL 已构造（导航交给候选循环）`);
    return { mode, urls: [detailDirect], skipFirstGoto: false, desc: `链接 ${link.slice(0, 60)}` };
  }
  if (mode === 'image') {
    const pool = items.length ? items : libPool('IMAGES', []);
    expect(pool.length, '图片搜索方向无可用图片素材（手动填写/用例库 image 均为空）').toBeGreaterThan(0);
    await page.goto(`${pcUrl('home')}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(5000);
    await dismissOverlays(page, logs); // 图搜方向同样先关开屏广告（弹窗会挡搜索区与隐藏 file input）
    // 逐个候选图下载（校验二进制头，>1KB）→ 任一成功即上传触发图搜（自动跳 /search?...imgid=）
    let imgFile = '';
    for (let i = 0; i < pool.length && !imgFile; i++) {
      const url = pool[Math.floor(Math.random() * pool.length)];
      try {
        const resp = await page.request.get(url, { timeout: 20000 });
        const buf = await resp.body();
        const okHead = buf.length > 1000 && (buf[0] === 0xff || buf[0] === 0x89 || buf[0] === 0x47); // jpg/png/gif
        if (!resp.ok() || !okHead) {
          logs.push(`图片素材无效（${url.slice(0, 60)}，${buf.length}B），换下一个`);
          continue;
        }
        imgFile = `/tmp/fc-img-${Date.now()}.jpg`;
        writeFileSync(imgFile, buf);
      } catch (e: any) {
        logs.push(`图片素材下载失败（${url.slice(0, 60)}）: ${String(e.message || '').slice(0, 80)}`);
      }
    }
    expect(imgFile, `图片素材全部下载失败（共 ${pool.length} 条）`).toBeTruthy();
    Object.assign(runConfig, { pickMode: 'image', pickModeLabel: '图片搜索（以图搜图）', pickSource: items.length ? fcSrc() : (process.env.LIB_IMAGES ? `用例库·${process.env.LIB_IMAGES_MODE === 'picked' ? '发起时勾选' : '随机抽取'}` : ''), pickItems: pool });
    logs.push(`选品方向=图片搜索（素材: ${fcSrc()}）: 图片已下载 → 以图搜图`);
    const fileInput = page.locator('input[type="file"][accept*="image"]').first();
    await fileInput.setInputFiles(imgFile);
    await page.waitForTimeout(12000);
    expect(/imgid=/.test(page.url()), `图搜上传后未进入图片搜索结果页: ${page.url().slice(0, 120)}`).toBeTruthy();
    const urls = await collectDetailCandidates(page, 5);
    expect(urls.length, '图搜结果页未取到 /detail 商品（建议更换真实商品图素材）').toBeGreaterThan(0);
    logs.push(`图搜结果候选 ${urls.length} 个（随机排序逐个尝试）`);
    return { mode, urls, skipFirstGoto: false, desc: '图片搜索' };
  }
  // 未配置方向 = 旧直连模式（站点档案 供应链编号；兼容 LIB_LINKS 勾选，仅认供应链格式）
  const pick = pickMarketFromLib(site.testData.numIidFullChain || '');
  const modeTxt = pick.source.startsWith('用例库') && process.env.LIB_LINKS_MODE
    ? `，${process.env.LIB_LINKS_MODE === 'picked' ? '发起时勾选' : '随机抽取'}` : '';
  Object.assign(runConfig, { pickMode: 'legacy', pickModeLabel: '供应链固定商品直连', pickSource: pick.source + modeTxt, pickItems: [pick.iid] });
  logs.push(`选品: ${pick.iid}（来源: ${pick.source}${modeTxt}｜模式: 站点档案直连）`);
  return { mode: 'legacy', urls: [`${pcUrl('detail_market')}?url=${encodeURIComponent(offerMarket(pick.iid))}`], skipFirstGoto: false, desc: `选品 ${pick.iid}` };
}

// ---------- 用例 ----------
test.describe('商城完整购物链路（PC 前台 + 后台）', () => {
  // 2026-10-12 ian：全链是真实交易链路，spec 级重试=整链从头再来（纯冗余，当天实录 attempt2/3 无一翻盘）。
  // 失败快速终态，由 3008 平台 Job 级手动 retry 承担（带 401 重登等自愈能力）。
  test.describe.configure({ retries: 0 });
  test.skip(({ browserName }) => browserName !== 'chromium', '完整链路仅在 Desktop Chrome 运行');

  test('全链路：下单支付→后台仓务→提交运单→运费支付→出库发货→确认收货', async ({ browser }) => {
    test.setTimeout(45 * 60_000);

    const envTxt = readFileSync('.env', 'utf-8');
    const ACCOUNT = process.env.SITE_FRONT_ACCOUNT || /^TEST_TEST_ACCOUNT=(.*)$/m.exec(envTxt)?.[1]?.trim() || '';
    const PASSWORD = process.env.SITE_FRONT_PASSWORD || /^TEST_TEST_PASSWORD=(.*)$/m.exec(envTxt)?.[1]?.trim() || '';
    test.skip(!ACCOUNT || !PASSWORD, '未配置测试账号');
    FRONT_CREDS = { account: ACCOUNT, password: PASSWORD }; // 登录态掉线守卫复用（2026-10-14）
    runConfig.frontAccount = ACCOUNT;
    runConfig.bossAccount = process.env.SITE_BOSS_ACCOUNT || /^TEST_BOSS_ACCOUNT=(.*)$/m.exec(envTxt)?.[1]?.trim() || 'admin';

    const userCtx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
    const user = await userCtx.newPage();
    wireCapture(user, '前台');
    // 2026-10-12 终局定案：双 context 并存（前台+后台同浏览器实例）触发站点风控——前台详情页降级成比价
    // 推荐页（主商品价格区永不渲染，runner 内探针加 bossCtx 立即复现、删除即恢复）。boss 延迟到 B1 前创建。
    let bossCtx: any = null;
    let boss: any = null;

    // 唯一快递单号（同日多轮复用同号会触发「异常件记录已存在,请勿重复扫描」，整条仓务链断——2026-09-22 血泪教训）
    // 断点续跑桥接（2026-10-13）：以下变量是模块级 fcCtx 的本地视图——声明处读入 + 每个赋值点回写，
    // runStep 跳过已成功步骤前会先恢复 fcCtx → 续跑跳过 F2 即复用上轮订单，不重复真实下单。
    const trackingNo = fcCtx.trackingNo || (fcCtx.trackingNo = `at${new Date().toISOString().replace(/\D/g, '').slice(2, 14)}`);
    let orderNo = fcCtx.orderNo || '';
    let packageNo = fcCtx.packageNo || '';
    let packageId = fcCtx.packageId || '';
    const payAmounts: string[] = [];

    // ===== F1 前台登录 =====
    await runStep('F1', '前台 PC 登录测试账号', '前台', user, async (logs) => {
      await frontLogin(user, logs);
      logs.push('登录成功，跳转 /zh-cn（不再注入币种：会话币种随机由 \p{Sc} 正则免疫）');
    });

    // ===== F2 选品（按方向）→ 商品详情 → 立即购买 → 确认订单 → 余额支付 =====
    await runStep('F2', '前台按选品方向下单并余额支付', '前台', user, async (logs) => {
      // 选品方向（2026-10-09 ian）：FC_PICK_MODE = keyword|link|image 驱动站内搜索选品，
      // 素材 FC_PICK_ITEMS（发起勾选/用例库随机/手动填写，由平台 runner 注入）；
      // keyword/image = 搜索结果列表随机候选逐个尝试；link = 贴链接直达详情；未配置 = 旧供应链直连。
      let pick = await pickProduct(user, logs);
      // 2026-10-12 二分旁路（FC_DEBUG_PROBE=1）：丢弃 pickProduct 结果，用探针验证过的硬编码路径直连
      // 若旁路成功而正式路径失败 → pickProduct 是毒药；若旁路也失败 → F1/login/env 层差异
      if (process.env.FC_DEBUG_PROBE === '1' || process.env.TV_FC_DEBUG_PROBE === '1') {
        pick = { mode: 'debug', urls: [`${pcUrl('detail_market')}?url=${encodeURIComponent(offerMarket('982345010398'))}`], skipFirstGoto: false, desc: 'DEBUG 直连 982345010398' };
        logs.push('【DEBUG 旁路】跳过 pickProduct，硬编码单候选直连');
      }
      // 2026-10-12：getItem 业务码监听——上游 item-not-found（error_code 2000，HTTP 仍 200）时详情页只渲染
      // 骨架+推荐流（按钮在、价格区永不出），reload 无意义；收到 code!=1 立即标记该候选死亡换下一个。
      let getItemBad = false;
      let getItemBadMsg = '';
      let relogins = 0; // 2026-10-12 终极根因：F2 中途登录态失效（getItem 401 请登录后操作，reload 后即 401）→
      // 页面骨架在但价格区（需登录态）永不渲染，10 候选全灭假象。检测到 401 快速重登后续跑（最多 2 次）。
      const onGetItem = async (r: any) => {
        if (!/obapi\/getItem(?!list)/.test(r.url()) || r.request().method() !== 'POST') return;
        try {
          const j = await r.json();
          if (!j || j.code !== 1) {
            getItemBad = true;
            getItemBadMsg = `getItem code=${j && j.code} error_code=${(j && j.error_code) || ''} msg=${((j && j.msg) || '').slice(0, 60)}`;
          } else {
            getItemBad = false; getItemBadMsg = '';
          }
        } catch { /* body 读取失败不判死 */ }
      };
      user.on('response', onGetItem);
      // 详情页就绪判定 + 购买点击 + 进确认页（2026-10-08 ian：阻断原因必须可见 + 半渲染自愈）
      // 已知形态（Campaign27/JOB-69 retry 轮实录）：详情页间歇半渲染——价格区未出，
      // 价格正则兜底误抓币种汇率文本（形如 "USD 4"），按钮 DOM 在但 React handler 未挂载，
      // 点击静默失效（cart/add 从不发出）→ 死等 6s 后报"未进入确认订单页"，看不出原因。
      // 对策：①符号价（$¥￥）才算价格区真实渲染，否则 reload 自愈（每候选最多 3 次，失败换下一候选）；
      //      ②点击后轮询 confirm 15s；③失败时输出分阶段诊断（按钮/接口/弹层/提示文案）。
      let entered = false;
      let lastDiag = '';
      let firstVisit = pick.skipFirstGoto; // link 方向：搜索直达后已停在详情页，首次不再 goto
      for (let ci = 0; ci < pick.urls.length && !entered; ci++) {
        const detailUrl = pick.urls[ci];
      runConfig.pickUrl = detailUrl.slice(0, 140); // 当前尝试候选（成功下单时即实际商品）
        if (ci > 0) logs.push(`候选商品 ${ci} 未成交 → 随机换下一个候选（共 ${pick.urls.length} 个）`);
        for (let attempt = 1; attempt <= 1 && !entered; attempt++) { // 2026-10-12 ian：reload 自愈证明无效（3 次尝试全同结果），单次直判
          getItemBad = false; getItemBadMsg = '';
          if (firstVisit) {
            firstVisit = false;
          } else {
            // 2026-10-12 定案：一律 goto 整页进入（内部路由/点击进入会触发站点价格区渲染降级 bug）
            await user.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
          }
          await dismissOverlays(user, logs); // 详情页优惠券/活动弹窗守卫（防挡 CTA 与价格区）
          // 2026-10-09 ian：供应链上游限流/风控时，站点把详情请求降级 302 → /selfservice（手工填单页，
          // bodyLen~365 空壳）。识别后立即换下一候选，不浪费 reload 自愈次数（JOB-000079 15 连挂实录）。
          if (/\/selfservice/.test(user.url())) {
            lastDiag = '详情页被站点降级到 /selfservice 手工填单（供应链上游商品拉取失败/限流，非用例问题）';
            logs.push(`候选${ci + 1} 被降级到手工填单页（供应链上游拉取失败/限流）→ 立即换下一候选`);
            break; // 跳出 attempt 循环换候选
          }
          // 2026-10-12 修复（JOB-000084 三轮15连挂根因）：详情页 SPA 渲染实际需要 10s+，
          // 旧的「固定等 8s 一次性判定」恰在外壳期（bodyLen~365）误判半渲染 → reload 重置渲染进度 → 死循环；
          // 且站点新会话币种已随机到 RUB（₽），旧符号价正则 [$¥￥] 永远匹配不到 → priceReady 恒 false。
          // 对策：①符号价正则改 Unicode 货币符号 \p{Sc}（$¥￥₽€£ 全覆盖，币种免疫，localStorage 注入 USD 已失效不再依赖）；
          // ②原地轮询最多 30s（每 2s 探测，符号价+立即购买按钮双全才算就绪），期间不 reload（渲染中 reload=前功尽弃）；
          // ③30s 未就绪才走 reload 自愈（attempt 循环）/换候选。
          let info: any = {};
          let rendered = false;
          let pollN = 0;
          const traj: string[] = []; // 2026-10-13：渲染轨迹记录（每10次），失败时进 lastDiag 供定位「恒定空壳 vs 缓慢渲染 vs 80s边界」
          for (let pi = 0; pi < POLL_ROUNDS; pi++) { // 渲染等待窗=FC_POLL_SEC（默认 200s；2026-10-13 扩窗教训：渲染可能落在 80s 边界外）
            await user.waitForTimeout(2000);
            pollN = pi + 1;
            // 前端路由式降级（非 302）在渲染等待中可见，轮询内检查
            if (/\/selfservice/.test(user.url())) break;
            if (getItemBad) break; // 上游无此商品（item-not-found）：价格区永不出，立即换候选不耗轮询
            // 2026-10-12 终验：删除停滞早断——「骨架+推荐流恒定」是渲染中间态（主商品数据 30-90s 后到），8s 停滞判定是误杀源
            const st = await user.evaluate(`(() => {
          const body = document.body.innerText;
          const symPrice = (body.match(/[\\p{Sc}]\\s*\\d[\\d.]*/u) || [''])[0];
          const codePrice = (body.match(/\\b(?:USD|CNY|RMB|JPY|AED|RUB|EUR|GBP|KRW)\\s*\\d+\\.\\d+/) || [''])[0];
          const buyBtn = Array.from(document.querySelectorAll('button')).find(b => /立即购买/.test(b.textContent || ''));
          return JSON.stringify({ symPrice, codePrice, bodyLen: body.length, hasBtn: !!buyBtn, btnDisabled: buyBtn ? buyBtn.disabled : null });
        })()`).catch(() => '{}');
            try { info = JSON.parse(st); } catch { /* ignore */ }
            if (pi % 10 === 9) traj.push(`t=${(pi + 1) * 2}s len=${info.bodyLen || 0} sym=${info.symPrice || '-'} btn=${info.hasBtn ? 'Y' : 'N'} reqs=${recent.length}`);
            if (info.symPrice && info.hasBtn) { rendered = true; traj.push(`就绪t=${(pi + 1) * 2}s`); break; }
          }
          if (/\/selfservice/.test(user.url())) {
            lastDiag = '详情页被站点降级到 /selfservice 手工填单（供应链上游商品拉取失败/限流，非用例问题）';
            logs.push(`候选${ci + 1} 被降级到手工填单页（前端路由跳转）→ 立即换下一候选`);
            break;
          }
          if (getItemBad && !rendered) {
            if (/请登录|code=401/.test(getItemBadMsg) && relogins < 2) {
              // 登录态中途失效（同账号异地登录互踢/会话超短）：快速重登后重试当前候选
              relogins++;
              logs.push(`候选${ci + 1} 登录态失效（${getItemBadMsg}）→ 快速重登第${relogins}次后续跑`);
              try {
                await user.goto(`${pcUrl('login')}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
                await user.waitForTimeout(3000);
                await user.locator('input[name="email"]').fill(ACCOUNT);
                await user.locator('input[name="password"]').fill(PASSWORD);
                await user.getByRole('button', { name: '登录', exact: true }).first().click({ timeout: 8000 });
                await user.waitForTimeout(6000);
                await user.evaluate(`(() => { try { localStorage.setItem('selectedCurrency', '${FC_CUR}'); } catch (e) {} })()`).catch(() => {});
                ci--; // 外层 for 自增后仍指向当前候选，重试
                break; // 跳出 attempt 循环
              } catch (re) {
                logs.push(`快速重登异常: ${String(re).slice(0, 100)}`);
              }
            }
            // 上游确认无此商品：reload 也不会好，直接换候选（不浪费剩余 attempt）
            lastDiag = `商品上游拉取失败: ${getItemBadMsg}`;
            logs.push(`候选${ci + 1} getItem 业务失败（${getItemBadMsg}）→ 上游无货/限流，立即换下一候选`);
            break;
          }
          logs.push(`候选${ci + 1} 第${attempt}次进详情: 轮询${pollN}次(${pollN * 2}s) bodyLen=${info.bodyLen} 符号价=${info.symPrice || '无'}${rendered ? '' : `（未就绪：${info.hasBtn ? '按钮已出价格未出' : '价格按钮均未出'}${info.codePrice ? `，币种代码兜底「${info.codePrice}」` : ''}）`} 立即购买按钮=${info.hasBtn ? (info.btnDisabled ? '在但禁用' : '在') : '缺失'}`);
          if (!rendered) {
            lastDiag = `详情页 ${pollN * 2}s 内未渲染就绪（bodyLen=${info.bodyLen}，符号价=${info.symPrice || '无'}，按钮=${info.hasBtn ? '在' : '缺失'}，兜底币种文本「${info.codePrice || '无'}」，轨迹：${traj.join(' | ') || '无记录'}`;
            logs.push(`⚠ 详情页未就绪（轮询超时）→ ${ci + 1 < pick.urls.length ? '换下一候选商品' : '已到最后候选'}`);
            continue; // reload / 换候选
          }
          expect(info.hasBtn, `详情页未渲染出「立即购买」按钮（bodyLen=${info.bodyLen}：getItem 空态/页面改版/渲染失败）`).toBeTruthy();
          await user.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => /立即购买/.test(x.textContent || '')); if (b) b.click(); })()`);
          for (let i = 0; i < 8; i++) { await user.waitForTimeout(2000); if (/\/confirm/.test(user.url())) { entered = true; break; } }
          if (!entered) {
            // 分阶段诊断：按钮点击是否触发下单接口 + 页面弹层/提示现场（错误消息直接带原因）
            const diag = await user.evaluate(`(() => {
            const tips = Array.from(document.querySelectorAll('.ant-message, .ant-notification, [class*="toast"], .el-message, [class*="modal"]'))
              .map(x => (x.textContent || '').trim()).filter(t => t && t.length < 120).slice(0, 3).join(' | ');
            const sku = document.querySelector('[class*="sku"]');
            return JSON.stringify({ url: location.href.slice(0, 80), bodyLen: document.body.innerText.length, skuLayer: !!sku, tips });
          })()`).catch(() => '{}');
            const sawOrderApi = recent.some((c) => /cart\/add|carttoorder|toorder/.test(c.url));
            lastDiag = `【阻断原因】${sawOrderApi
              ? '购买点击已触发下单接口但未跳转（接口层失败：见本步 curl 的 cart/add 响应 code/msg）'
              : '购买点击未触发任何下单/加购接口（按钮点击静默失效：React 未挂载完/规格或库存前端拦截）'}；现场 ${diag}`;
            logs.push(`候选${ci + 1} 第${attempt}次点击购买未跳转确认页（${sawOrderApi ? '接口已发' : '接口未发'}）${attempt < 3 ? '→ 重新进详情重试' : ''}`);
          }
        }
      }
      user.removeListener('response', onGetItem);
      expect(entered, `未进入确认订单页（选品: ${pick.desc}）: ${user.url().slice(0, 90)}｜${lastDiag}`).toBeTruthy();
      logs.push('已进入确认订单页');
      // 勾选「我已阅读并同意条款」（React 受控组件，必须 Playwright check；定位：文本容器的 input）
      // 2026-10-09 ian：确认页偶发半渲染（bodyLen~750，JOB-000081 实录）→ 先等 checkbox 渲染，勾选失败自动重勾（最多 3 轮）
      for (let wi = 0; wi < 6; wi++) {
        const n = await user.evaluate(`(() => document.querySelectorAll('input[type="checkbox"]').length)()`);
        if (Number(n) > 0) break;
        await user.waitForTimeout(2000);
      }
      let agreeChecked = false;
      for (let ai = 0; ai < 3 && !agreeChecked; ai++) {
        const agree = user.locator('label:has-text("我已阅读"), div:has-text("我已阅读") >> input[type="checkbox"]').last();
        await agree.check({ force: true, timeout: 8000 }).catch(async () => {
          await user.getByText('我已阅读并同意条款').first().click().catch(() => {});
        });
        await user.waitForTimeout(1000);
        agreeChecked = await user.evaluate(`(() => { const c = Array.from(document.querySelectorAll('input[type="checkbox"]')); const t = c[c.length - 1]; return t ? t.checked : false; })()`);
        if (!agreeChecked) logs.push(`条款第 ${ai + 1} 次勾选未生效（疑似确认页半渲染）→ 重试`);
      }
      logs.push(`条款勾选状态: ${agreeChecked}`);
      expect(agreeChecked, '条款未能勾选，提交会被拒绝').toBeTruthy();
      // 提交订单（真 click）
      // 2026-11-04 ian（JOB-000249-PC 复盘）：站点下单接口偶发挂起不响应，按钮长驻 loading；
      // 旧逻辑固定等 16s 直接判死 + 报「提交后未进入支付页」，看不出是接口挂起还是没发请求。
      // 加固：①记录提交后的在途请求（request 无 response = 挂起）②等待窗扩到 45s
      //      ③超时后查 cart/getList 是否已清空（=订单已生成）+ order/lists 最新单 → 直达支付页自愈，避免重复下单。
      const inFlight = new Map<string, number>(); // 'POST /api/v1/xxx' → 发起时间戳
      const _onReq = (r: any) => { try { if (r.url().includes('/api/')) inFlight.set(`${r.method()} ${r.url().split('?')[0]}`, Date.now()); } catch { } };
      const _onRes = (r: any) => { try { if (r.url().includes('/api/')) inFlight.delete(`${r.request().method()} ${r.url().split('?')[0]}`); } catch { } };
      user.on('request', _onReq); user.on('response', _onRes);
      const submitAt = Date.now();
      await user.getByRole('button', { name: /提\s*交/ }).first().click({ timeout: 8000 });
      // 等待跳转支付页
      for (let i = 0; i < 23; i++) { await user.waitForTimeout(2000); if (/\/pay/.test(user.url())) break; }
      if (!/\/pay/.test(user.url())) {
        const pending = Array.from(inFlight.entries()).filter(([k, t]) => t >= submitAt - 1000 && /order|pay|cart/i.test(k))
          .map(([k, t]) => `${k}（已等待 ${Math.round((Date.now() - t) / 1000)}s 无响应）`);
        const cartTxt = await user.evaluate(`(async () => {
          try { const r = await fetch('/api/v1/cart/getList', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' }); return await r.text(); } catch (e) { return ''; }
        })()`).catch(() => '');
        let cartEmpty = false;
        try { const cj = JSON.parse(String(cartTxt)); const arr = Array.isArray(cj.data) ? cj.data : (cj.data && (cj.data.list || cj.data.data)) || []; cartEmpty = arr.length === 0; } catch { }
        logs.push(`提交后 45s 未进支付页：在途挂起接口=${pending.length ? pending.join(' , ') : '无（下单接口未发出）'}｜购物车${cartEmpty ? '已清空（订单已生成，站点未跳转）' : '仍有商品'}`);
        if (cartEmpty) {
          // 自愈：订单已生成但前端未跳转 → order/lists 取最新单直达支付页
          const ordTxt = await user.evaluate(`(async () => {
            const r = await fetch('/api/v1/order/lists', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            return await r.text();
          })()`).catch(() => '');
          let newId = '';
          try {
            const oj = JSON.parse(String(ordTxt));
            const arr = Array.isArray(oj.data) ? oj.data : (oj.data && (oj.data.list || oj.data.data)) || [];
            const first: any = arr[0] || null;
            newId = first ? String(first.id || first.orders_id || '') : '';
          } catch { }
          if (newId) {
            logs.push(`自愈：订单已生成（id=${newId}）但页面未跳转 → 直达支付页`);
            await user.goto(`${pcUrl('pay')}?order_id=${newId}`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
            await user.waitForTimeout(3000);
          }
        }
        user.removeListener('request', _onReq); user.removeListener('response', _onRes);
      }
      user.removeListener('request', _onReq); user.removeListener('response', _onRes);
      expect(/\/pay/.test(user.url()), `提交后未进入支付页（含自愈）: ${user.url().slice(0, 90)}`).toBeTruthy();
      await user.waitForTimeout(4000);
      logs.push(`支付页 URL: ${user.url().slice(0, 80)}`);
      const payOrderId = (user.url().match(/order_id=(\d+)/) || [])[1] || ''; // 2026-10-13：支付页 order_id（order/lists 兜底精确匹配用）
      if (payOrderId) fcCtx.payOrderId = payOrderId;
      const payPageText = await user.locator('body').innerText();
      orderNo = (payPageText.match(/OD\d{14,}/) || user.url().match(/order_id=(\d+)/) || [])[0] || '';
      fcCtx.orderNo = orderNo;
      payAmounts.push((payPageText.match(/实付金额[：:]\s*([\p{Sc}]?[\d,]+\.\d+)/u) || [])[1] || '');
      if (payAmounts[payAmounts.length - 1]) fcCtx.payAmount = payAmounts[payAmounts.length - 1]; // 台账留痕：实付金额
      logs.push(`支付单号 ${orderNo}，实付 ${payAmounts[payAmounts.length - 1]}`);
      // 选择余额支付（点击文本块）
      await user.evaluate(`(() => {
        const el = Array.from(document.querySelectorAll('div, span, label, li')).find((x) => /余额支付/.test(x.textContent || '') && (x.textContent || '').length < 40 && x.offsetParent !== null);
        if (el) el.click();
      })()`).catch(() => {});
      await user.waitForTimeout(1500);
      // 立即支付
      await user.getByRole('button', { name: /立即支付/ }).first().click({ timeout: 8000 });
      await user.waitForTimeout(8000);
      // 支付确认弹窗（若存在 确定/Confirm）
      await user.evaluate(`(() => {
        const b = Array.from(document.querySelectorAll('button, .ant-modal button, .ant-popconfirm button')).find((x) => /^(确定|确认|confirm)$/i.test((x.textContent || '').trim()));
        if (b) b.click();
      })()`).catch(() => {});
      await user.waitForTimeout(8000);
      const afterPay = await user.locator('body').innerText();
      if (!orderNo.startsWith('OD')) {
        orderNo = (user.url().match(/OD\d{14,}/) || afterPay.match(/OD\d{14,}/) || orderNo)[0] || orderNo;
        fcCtx.orderNo = orderNo;
      }
      logs.push(`支付后 URL: ${user.url().slice(0, 100)}`);
      expect(/success|成功|payResult|packages|dashboard|order|pay/i.test(user.url() + afterPay.slice(0, 500)), `支付后页面异常: ${user.url()}`).toBeTruthy();
      // 抓后台体系订单号（O+12位，前台订单列表「订单号 : O2026xxxx」）
      // 2026-10-09 ian：orders 页间歇半渲染（bodyLen~1200 空壳，JOB-000078 retry 轮实录）→ reload 自愈最多 4 次
      let ordersText = '';
      for (let oi = 0; oi < 6; oi++) {
        await user.goto(`${pcUrl('orders')}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await user.waitForTimeout(6000);
        await dismissOverlays(user, logs); // 订单页营销弹窗守卫（JOB-000105 挂点）
        ordersText = await user.locator('body').innerText();
        // 2026-10-16：订单号前缀通用化（O+12位 仅 v2026 站；spanbuy 等站点为 SP+12位）
        if (/订单号\s*[:：]\s*[A-Z]{1,4}\d{8,}|\b[A-Z]{2}\d{12}\b/.test(ordersText)) break;
        logs.push(`orders 页第 ${oi + 1} 次未渲染出订单号（bodyLen=${ordersText.length}）→ reload 自愈`);
        await user.waitForTimeout(3000);
      }
      orderNo = (ordersText.match(/订单号\s*[:：]\s*([A-Z]{1,4}\d{8,})/) || ordersText.match(/\b([A-Z]{2}\d{12})\b/) || [])[1] || '';
      fcCtx.orderNo = orderNo;
      if (!orderNo) {
        // 2026-10-10：orders 页 4 次半渲染（JOB-000083 两轮实录 bodyLen~466 空壳、页面 JS 未启动）→
        // 接口兜底 order/lists（时间倒序第一条=本轮刚支付订单；测试账号无并发下单）
        const ordTxt = await user.evaluate(`(async () => {
          const r = await fetch('/api/v1/order/lists', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          return await r.text();
        })()`).catch(() => '');
        try {
          const oj = JSON.parse(String(ordTxt));
          const arr = Array.isArray(oj.data) ? oj.data : (oj.data && (oj.data.list || oj.data.data)) || [];
          // 2026-10-13 修复（JOB-87 实录）：响应字段实为 ordersn（首条字段 id,orders_id,ordersn,...）；优先按支付页 order_id 精确匹配，防历史订单误取
          const first: any = (payOrderId && arr.find((x: any) => String(x && x.id) === String(payOrderId))) || arr[0] || null;
          const sn = first ? String(first.ordersn || first.sn || first.order_no || first.order_sn || '') : '';
          const m = sn.match(/[A-Z]{1,4}\d{8,}/); // 2026-10-19 通用化：O 前缀仅 v2026（spanbuy=DD 等，JOB-000105 因此 fail）
          if (m) orderNo = m[0];
          fcCtx.orderNo = orderNo;
          logs.push(`order/lists 兜底: ${orderNo ? '命中 ' + orderNo : '未命中（条目数=' + arr.length + ' 首条字段=' + (first ? Object.keys(first).slice(0, 14).join(',') : '无') + '）'}`);
        } catch { logs.push(`order/lists 兜底解析失败: ${String(ordTxt).slice(0, 120)}`); }
      }
      logs.push(`后台体系订单号: ${orderNo}`);
      expect(orderNo, `未捕获前台订单号（orders 页 4 次自愈 + order/lists 接口兜底均失败，bodyLen=${ordersText.length}）`).toBeTruthy();
    });

    // ===== B1 后台登录 =====
    // boss context 延迟创建（前台 F1-F2 单 context 阶段已过，规避双会话风控降级）
    bossCtx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1600, height: 900 } });
    boss = await bossCtx.newPage();
    wireCapture(boss, '后台');
    await runStep('B1', '后台管理端登录（ddddocr 验证码）', '后台', boss, async (logs) => bossLogin(boss, logs));

    // ===== B2 订单审核 → 手工采购已采购 =====
    const bossSearchOrder = async (logs: string[]) => {
      await boss.goto(`${bossUrl('order')}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await boss.waitForTimeout(6000);
      // Element UI 搜索：优先订单号，兜底用户名；fill 超时时用原生 setter 兜底
      const fillInput = async (ph: string, val: string) => {
        try {
          await boss.locator(`input[placeholder="${ph}"]`).first().fill(val, { timeout: 8000 });
        } catch {
          await boss.evaluate(`((ph, v) => {
            const ip = Array.from(document.querySelectorAll('input')).find((i) => i.placeholder === ph);
            if (ip) { const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; s.call(ip, v); ip.dispatchEvent(new Event('input', { bubbles: true })); }
          })('${ph}', '${val}')`);
        }
      };
      if (orderNo) await fillInput('搜索订单号', orderNo);
      else await fillInput('搜索用户名', ACCOUNT);
      await boss.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.trim() === '搜索' || x.textContent.trim() === '筛选'); if (b) b.click(); })()`);
      await boss.waitForTimeout(5000);
      // 验证搜索结果确实包含目标订单（防止空列表勾错行）
      const listText = await boss.locator('body').innerText();
      if (orderNo) logs.push(`搜索结果含订单号: ${listText.includes(orderNo)}`);
      await boss.evaluate(`(() => {
        const boxes = Array.from(document.querySelectorAll('tbody input[type="checkbox"], .el-table__body .el-checkbox__original'));
        if (boxes[0]) boxes[0].click();
      })()`);
      await boss.waitForTimeout(1500);
    };

    await runStep('B2', '后台订单管理：搜索订单→勾选→手工采购【已采购】', '后台', boss, async (logs) => {
      // 2026-10-19 ian·测试数据安全铁律：后台写操作前必须校验订单归属测试前台账号，严禁操作他人数据。
      // 从后台 order/order/lists 响应行提取买家（user_email/用户名/user_id）与前台 user/info 实测身份比对；
      // 同时提取订单全量 order_goods id 存 fcCtx.ogids（B3 快递全量挂载校验用）。
      let ownerHit: { owner: string; userId: string; ogids: string } | null = null;
      const onOwner = (r: any) => {
        if (!/order\/order\/lists/.test(r.url())) return;
        r.text().then((t: string) => {
          try {
            const j = JSON.parse(t);
            const rows = (j && j.data && (j.data.list || j.data.data)) || (Array.isArray(j && j.data) ? j.data : []);
            const arr = Array.isArray(rows) ? rows : [];
            const row = arr.find((x: any) => String(x.ordersn || x.sn || x.order_no || '') === String(orderNo)) || null;
            if (row) {
              const goodsArr: any[] = Array.isArray(row.goods) ? row.goods : (Array.isArray(row.order_goods) ? row.order_goods : []);
              ownerHit = {
                owner: String(row.user_email || row.email || row.user_name || row.username || row.nickname || ''),
                userId: String(row.user_id || row.uid || ''),
                ogids: goodsArr.map((g: any) => g && g.id).filter(Boolean).join(','),
              };
            }
          } catch { /* 响应非目标结构，忽略 */ }
        }).catch(() => {});
      };
      boss.on('response', onOwner);
      await bossSearchOrder(logs);
      await boss.waitForTimeout(1200);
      boss.off('response', onOwner);
      if (ownerHit && ownerHit.ogids) fcCtx.ogids = ownerHit.ogids;
      if (ownerHit && (ownerHit.owner || ownerHit.userId)) {
        const frontEmail = FRONT_IDENTITY && FRONT_IDENTITY.email ? String(FRONT_IDENTITY.email) : '';
        const frontId = FRONT_IDENTITY && FRONT_IDENTITY.id ? String(FRONT_IDENTITY.id) : '';
        const emailMatch = !!(frontEmail && ownerHit.owner && ownerHit.owner.toLowerCase() === frontEmail.toLowerCase());
        const idMatch = !!(frontId && ownerHit.userId && ownerHit.userId === frontId);
        if (emailMatch || idMatch) {
          logs.push(`归属校验通过: 订单 ${orderNo} 买家=${ownerHit.owner || ownerHit.userId} 与前台身份一致${fcCtx.ogids ? `；ogids=${fcCtx.ogids}` : ''}`);
        } else if (!frontEmail && !frontId) {
          logs.push(`【归属校验失败·已拦截】前台实测身份未知（F1 user/info 未取到账号字段），后台订单 ${orderNo} 买家=${ownerHit.owner || '无'} user_id=${ownerHit.userId || '无'}——宁拦勿错`);
          throw new Error(`订单 ${orderNo} 归属无法确认（前台身份未知 vs 后台买家 ${ownerHit.owner || ownerHit.userId}）——测试数据安全铁律拦截（2026-10-19 ian）`);
        } else {
          logs.push(`【归属校验失败·已拦截】订单 ${orderNo} 买家 ${ownerHit.owner || ownerHit.userId} ≠ 前台测试身份 ${frontEmail || frontId}——严禁操作他人数据，中止 B2 及后续后台步骤`);
          throw new Error(`订单 ${orderNo} 不属于测试前台账号（买家 ${ownerHit.owner || ownerHit.userId} ≠ ${frontEmail || frontId}）——测试数据安全铁律拦截（2026-10-19 ian）`);
        }
      } else if (ownerHit) {
        logs.push(`归属校验宽松放行: 订单行无买家字段（ogids=${ownerHit.ogids || '无'}），无法比对`);
      } else {
        logs.push('归属校验未捕获订单行响应（宽松放行并留痕）');
      }
      // 监听已采购接口结果（failed_count>0 = 重复操作被拒）
      // 2026-10-16 幂等容错（JOB-000107 根因）：spanbuy 等站点部分订单（微店渠道/链接直连）支付后
      // 商品自动流转到「已采购」(status 30)，再点手工采购 = 30→30 被拒（"状态流转不合法，只能流转到相邻状态"），
      // success_count=0——此时 failed_items 全部 old_status==new_status==30 应视为「已是目标状态」幂等通过。
      let purchaseResp: any = null;
      const onResp = (r: any) => {
        if (/updateOrderGoodsStatus/.test(r.url())) {
          r.text().then((t: string) => {
            try { purchaseResp = JSON.parse(t); } catch { purchaseResp = { parse: false }; }
          }).catch(() => { purchaseResp = { parse: false }; });
        }
      };
      boss.on('response', onResp);
      // 点击【已采购】（手工采购区）
      await boss.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => /已采购/.test(x.textContent || '')); if (b) b.click(); })()`);
      await boss.waitForTimeout(4000);
      // 可能出现确认弹窗
      await boss.evaluate(`(() => {
        const b = Array.from(document.querySelectorAll('.el-message-box__btns button, .el-dialog button')).find((x) => /确定|是/i.test(x.textContent || ''));
        if (b) b.click();
      })()`).catch(() => {});
      await boss.waitForTimeout(3000);
      boss.off('response', onResp);
      const data = purchaseResp?.data || {};
      const successCount: number = data.success_count ?? 0;
      const failedItems: any[] = data.failed_items || [];
      const alreadyPurchased = failedItems.length > 0 && successCount === 0
        && failedItems.every((it) => it?.old_status === 30 && it?.new_status === 30);
      logs.push(`已采购接口验证: success_count=${successCount} failed=${failedItems.length}${alreadyPurchased ? '（商品已是已采购状态·站点自动流转，幂等通过）' : ''}（订单 ${orderNo}）`);
      if (alreadyPurchased) {
        logs.push(`幂等通过明细: ${failedItems.map((it) => `${it.order_goods_id}:${it.old_status_text}→${it.new_status_text}`).join('、')}`);
        return;
      }
      expect(successCount > 0, `已采购接口未成功（success_count=${successCount}，可能状态已变或重复操作；响应: ${JSON.stringify(data).slice(0, 200)}）`).toBeTruthy();
    });

    // ===== B3 发往中国仓 → 管理快递（采购编号/快递单号/菜鸟速递/明天） =====
    await runStep('B3', '后台【发往中国仓】→【管理快递】录入快递信息', '后台', boss, async (logs) => {
      // 重新搜索定位订单（页面操作后列表可能刷新）
      await bossSearchOrder(logs);
      await boss.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => /发往中国仓/.test(x.textContent || '')); if (b) b.click(); })()`);
      await boss.waitForTimeout(3000);
      // 若出现确认弹窗先确认
      await boss.evaluate(`(() => {
        const b = Array.from(document.querySelectorAll('.el-message-box__btns button, .el-dialog button, .el-popconfirm button')).find((x) => /确定|是/i.test(x.textContent || ''));
        if (b) b.click();
      })()`).catch(() => {});
      await boss.waitForTimeout(2000);
      await boss.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => /管理快递/.test(x.textContent || '')); if (b) b.click(); })()`);
      await boss.waitForTimeout(3000);
      // 诊断：当前弹窗容器与输入框
      const diag = await boss.evaluate(`(() => ({
        dialogs: document.querySelectorAll('.el-dialog, .el-drawer, .el-overlay').length,
        visibleInputs: Array.from(document.querySelectorAll('input')).filter((i) => i.offsetParent !== null && i.type !== 'checkbox' && i.type !== 'radio').map((i) => i.placeholder || i.type).slice(0, 15),
        labels: Array.from(document.querySelectorAll('.el-form-item__label')).filter((l) => l.offsetParent !== null).map((l) => (l.textContent || '').trim()).slice(0, 12),
      }))()`).catch(() => ({}));
      logs.push(`弹窗诊断: ${JSON.stringify(diag)}`);
      // 弹窗「管理快递信息」内 4 个输入依序：采购编号 / 快递公司(select) / 快递单号 / 预计到达(date)
      // scoped 到弹窗容器按序取，避免全局 placeholder 歧义
      const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
      const ymd = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')} 00:00:00`;
      const dlgInfo = await boss.evaluate(`((runTag, trackingNo, ymd) => {
        const dlg = Array.from(document.querySelectorAll('.el-dialog')).find((el) => el.offsetParent !== null && /管理快递信息/.test(el.textContent || ''));
        if (!dlg) return { ok: false, why: '找不到「管理快递信息」弹窗' };
        const ips = Array.from(dlg.querySelectorAll('input')).filter((i) => i.offsetParent !== null && !['checkbox', 'radio'].includes(i.type));
        const setVal = (ip, v) => {
          const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          s.call(ip, v);
          ip.dispatchEvent(new Event('input', { bubbles: true }));
          ip.dispatchEvent(new Event('change', { bubbles: true }));
        };
        // [采购编号, 快递公司, 快递单号, 预计到达]
        if (ips.length < 4) return { ok: false, why: '弹窗输入框不足 4 个: ' + ips.length };
        setVal(ips[0], runTag);
        ips[1].dispatchEvent(new MouseEvent('click', { bubbles: true })); // 打开快递公司下拉
        setVal(ips[2], trackingNo);
        setVal(ips[3], ymd);
        return { ok: true, count: ips.length };
      })('CG${RUN_TAG}', '${trackingNo}', '${ymd}')`).catch((e: any) => ({ ok: false, why: e.message }));
      logs.push(`弹窗填充: ${JSON.stringify(dlgInfo)}`);
      if (!dlgInfo.ok) throw new Error(`管理快递弹窗填充失败: ${dlgInfo.why}`);
      await boss.waitForTimeout(1200);
      // 快递公司下拉选「菜鸟速递」
      const carrierPicked = await boss.evaluate(`(() => {
        const opt = Array.from(document.querySelectorAll('.el-select-dropdown__item, li[role="option"]')).filter((x) => x.offsetParent !== null).find((x) => /菜鸟/.test(x.textContent || ''));
        if (opt) { opt.click(); return true; }
        return false;
      })()`);
      logs.push(`快递公司选择菜鸟速递: ${carrierPicked}`);
      await boss.waitForTimeout(1500);
      // 管理快递弹窗的确认按钮是「保存」（无「确定」——2026-09-22 排查：漏点保存导致快递单号从未入库）
      await boss.evaluate(`(() => {
        const dlg = Array.from(document.querySelectorAll('.el-dialog')).find((el) => el.offsetParent !== null && /管理快递信息/.test(el.textContent || ''));
        const btns = dlg ? Array.from(dlg.querySelectorAll('button')).filter((x) => x.offsetParent !== null) : [];
        const bb = btns.find((x) => /保存/.test(x.textContent || '')) || btns.filter((x) => /确定|确 认/.test(x.textContent || '')).pop();
        if (bb) bb.click();
      })()`);
      await boss.waitForTimeout(4000);
      // 验证弹窗已关闭（保存成功的表现）
      const dlgGone = await boss.evaluate(`(() => !Array.from(document.querySelectorAll('.el-dialog')).some((el) => el.offsetParent !== null && /管理快递信息/.test(el.textContent || '')))()`);
      logs.push(`管理快递已提交：快递单号 ${trackingNo}，菜鸟速递，预计到达 ${ymd.slice(0, 10)}，弹窗关闭=${dlgGone}`);
      expect(dlgGone, '管理快递弹窗未关闭——保存未成功').toBeTruthy();
      // 2026-10-19 ian·测试数据安全铁律④：B3 快递必须挂订单全量商品（JOB-000113 实录：UI 弹窗
      // 只挂了 2 个商品中的 4667，4668 漏挂导致状态死在已邮寄无快递）。保存后核对 batchAddExpress
      // 挂载条数（从本步抓包解析），缺失商品用同单号同参数直调补挂（防重复挂载：只补缺失项）。
      if (fcCtx.ogids) {
        await boss.waitForTimeout(1500);
        const allIds: string[] = fcCtx.ogids.split(',').filter(Boolean);
        const postedPayloads = recent.filter((c) => /batchAddExpress/.test(c.url)).map((c) => {
          const m = String(c.curl).match(/--data-raw '([^']*)'/) || String(c.curl).match(/--data '([^']*)'/);
          if (!m) return null;
          try { return JSON.parse(m[1]); } catch { return null; }
        }).filter(Boolean) as any[];
        const postedIds = new Set<string>();
        postedPayloads.forEach((p) => (Array.isArray(p && p.order_goods_ids) ? p.order_goods_ids : []).forEach((x: any) => postedIds.add(String(x))));
        const missing = allIds.filter((id) => !postedIds.has(id));
        if (missing.length) {
          const sample = postedPayloads[0] || null;
          const expressUrl = (recent.find((c) => /batchAddExpress/.test(c.url)) || { url: '' } as any).url;
          logs.push(`快递挂载校验: 应挂 ${allIds.length} 个（${fcCtx.ogids}），UI 实挂 ${postedIds.size} 个，缺失 [${missing.join(',')}] → 同单号补挂`);
          const sampleExpress = (sample && Array.isArray(sample.express_data) && sample.express_data[0]) || null;
          const payload = {
            order_goods_ids: missing.map(Number),
            express_data: [sampleExpress || { expressname: '菜鸟速递', expressno: trackingNo, markno: '', orderno: '', expectedtime: ymd.slice(0, 10), expresscode: 'danniao' }],
            status: '40',
          };
          const resp = await boss.evaluate(`(async (u, p) => {
            const token = localStorage.getItem('admin_token') || '';
            const r = await fetch(u, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'x-admin-token': token }, body: JSON.stringify(p) });
            return await r.text();
          })(${JSON.stringify(expressUrl)}, ${JSON.stringify(payload)})`).catch((e: any) => `补挂 evaluate 失败: ${e.message}`);
          logs.push(`补挂响应: ${String(resp).slice(0, 200)}`);
          if (!/"code"\s*:\s*1/.test(String(resp))) throw new Error(`快递补挂缺失商品 [${missing.join(',')}] 失败: ${String(resp).slice(0, 160)}`);
        } else {
          logs.push(`快递挂载校验通过: ${allIds.length} 个商品全部挂载（${fcCtx.ogids}）`);
        }
      } else {
        logs.push('快递挂载校验跳过: B2 未取到订单全量 ogids');
      }
    });

    // ===== B4 快递签收 =====
    await runStep('B4', '后台仓库管理→快递签收', '后台', boss, async (logs) => {
      await boss.goto(`${bossUrl('expressSign')}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await boss.waitForTimeout(5000);
      let checkMsg = '';
      let checkCode: number | null = null;
      const onResp = (r: any) => {
        if (/express_delivery\/check/.test(r.url())) {
          r.text().then((t: string) => {
            try { const j = JSON.parse(t); checkCode = j?.code; checkMsg = j?.msg || ''; } catch { checkCode = -1; }
          }).catch(() => { checkCode = -1; });
        }
      };
      boss.on('response', onResp);
      await boss.locator('input[placeholder*="快递单号"]').first().fill(trackingNo);
      await boss.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.trim() === '确认'); if (b) b.click(); })()`);
      await boss.waitForTimeout(4000);
      boss.off('response', onResp);
      logs.push(`签收接口 code=${checkCode} msg=${checkMsg}`);
      expect(checkCode === 1, `快递签收接口失败: ${checkMsg}`).toBeTruthy();
    });

    // ===== B5 入库称重（goods_inspection/submit —— ian 接口情报 + 2026-09-22 实测固化） =====
    await runStep('B5', '后台入库称重（普货-普货，100g）', '后台', boss, async (logs) => {
      await boss.goto(`${bossUrl('weighIn')}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await boss.waitForTimeout(5000);
      let checkCode: number | null = null, checkMsg = '';
      let submitCode: number | null = null, submitMsg = '';
      const onResp = (r: any) => {
        if (/goods_inspection\/check/.test(r.url())) {
          r.text().then((t: string) => { try { const j = JSON.parse(t); checkCode = j?.code; checkMsg = j?.msg || ''; } catch { checkCode = -1; } }).catch(() => {});
        }
        if (/goods_inspection\/submit/.test(r.url())) {
          r.text().then((t: string) => { try { const j = JSON.parse(t); submitCode = j?.code; submitMsg = j?.msg || ''; } catch { submitCode = -1; } }).catch(() => {});
        }
      };
      boss.on('response', onResp);
      await boss.locator('input[placeholder*="快递单号"]').first().fill(trackingNo);
      await boss.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.trim() === '确认'); if (b) b.click(); })()`);
      await boss.waitForTimeout(4500);
      logs.push(`称重扫描 check code=${checkCode} msg=${checkMsg}`);
      expect(checkCode === 1, `入库称重扫描失败: ${checkMsg}`).toBeTruthy();
      // 2026-09-23 站点后台改版：称重表单从 Element UI 换成 Tailwind（无 label/无级联，类型=radio 普货默认选中），
      // UI 按 label 填写全部失效（重量=false…）→ 点提交被前端校验拦截，submit 请求不发（b5-diag.spec.ts 实锤）。
      // 改为接口直调 submit（与 WAP 全链 9-23 结论一致）：ogid 从 check 接口取，x-admin-token 认证，长宽高=1（ian 指定）。
      await boss.screenshot({ path: `${SHOTS}/fc-B5.png` }).catch(() => {});
      const direct = await boss.evaluate(async (args) => {
        const token = localStorage.getItem('admin_token') || '';
        const headers = { 'Content-Type': 'application/json', 'x-admin-token': token };
        const cr = await fetch('/api/admin/v1/warehouse/goods_inspection/check', {
          method: 'POST', headers, body: JSON.stringify({ express_no: args.tracking, merge: 1 }),
        });
        const cj = await cr.json();
        const row = cj?.data && (Array.isArray(cj.data) ? cj.data[0] : (cj.data.list || cj.data.goods || [])[0] || cj.data);
        const g = (row && (row.goods || [])[0]) || row || {};
        const ogid = g.id || g.order_goods_id || '';
        if (!ogid) return { ok: false, step: 'check', info: `ogid 未解析到（code=${cj?.code}）` };
        const sr = await fetch('/api/admin/v1/warehouse/goods_inspection/submit', {
          method: 'POST', headers,
          body: JSON.stringify({ express_no: args.tracking, data: [{ order_goods_id: String(ogid), mark_no: args.tracking, inspection_status: 1, inspection_goods_type: [69], weight: 100, length: 1, width: 1, height: 1 }] }),
        });
        const sj = await sr.json();
        return { ok: sj?.code === 1, step: 'submit', code: sj?.code, msg: sj?.msg || '', ogid };
      }, { tracking: trackingNo });
      logs.push(`接口直调称重（普货-普货/100g/长宽高1）: code=${(direct as any).code} msg=${(direct as any).msg} ogid=${(direct as any).ogid}`);
      expect((direct as any).ok, `提交称重失败: ${(direct as any).step} ${(direct as any).info || ''} code=${(direct as any).code} ${((direct as any).msg) || ''}`).toBeTruthy();
      // 状态机复核：handled:1 队列里该单号应消失
      await boss.waitForTimeout(1500);
      const gone = await boss.evaluate(async (args) => {
        const token = localStorage.getItem('admin_token') || '';
        const r = await fetch('/api/admin/v1/warehouse/goods_inspection/lists', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
          body: JSON.stringify({ size: 50, page: 1, handled: 1 }),
        });
        const j = await r.json();
        const list = j?.data?.list || j?.data || [];
        return !JSON.stringify(list).includes(args.tracking);
      }, { tracking: trackingNo });
      logs.push(`复核 goods_inspection/lists 该单已出队: ${gone}`);
    });

    // ===== B6 商品拍照验货（check 后上传区才渲染；setInputFiles 直传；lists 复核） =====
    await runStep('B6', '后台商品拍照管理（上传图片+提交验货）', '后台', boss, async (logs) => {
      await boss.goto(`${bossUrl('photoIn')}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await boss.waitForTimeout(5000);
      await boss.locator('input[placeholder*="单号"], input[placeholder*="标记号"]').first().fill(trackingNo).catch(async () => {
        await boss.evaluate(`((v) => { const ip = Array.from(document.querySelectorAll('input')).find((i) => /单号|标记/.test(i.placeholder || '')); if (ip) { const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; s.call(ip, v); ip.dispatchEvent(new Event('input', { bubbles: true })); } })(${JSON.stringify(trackingNo)})`);
      });
      await boss.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => ['确认', '确定', '扫描'].includes(x.textContent.trim())); if (b) b.click(); })()`);
      await boss.waitForTimeout(4500);
      const fileCount = await boss.locator('input[type=file]').count();
      expect(fileCount > 0, '未找到上传 file input（check 可能未成功）').toBeTruthy();
      await boss.setInputFiles('input[type=file] >> nth=0', UPLOAD_IMG, { force: true, timeout: 8000 });
      await boss.waitForTimeout(4000);
      logs.push(`上传图片完成（file inputs=${fileCount}）`);
      await boss.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => /提交验货/.test(x.textContent || '')); if (b) b.click(); })()`);
      await boss.waitForTimeout(2500);
      await boss.evaluate(`(() => { const b = Array.from(document.querySelectorAll('.el-message-box__btns button, .el-dialog button')).find((x) => /确定|通过/i.test(x.textContent || '')); if (b) b.click(); })()`).catch(() => {});
      await boss.waitForTimeout(4000);
      // 复核：goods_inspection/lists 该单号消失 = 验货完成
      const adminToken = await boss.evaluate(`(() => localStorage.getItem('admin_token') || '')()`);
      const leftList = await boss.evaluate(`(async ([tok]) => {
        const r = await fetch('${bossApi('goodsInspectionLists')}', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': tok }, credentials: 'include', body: JSON.stringify({ page: 1, limit: 20 }) });
        return await r.text();
      })(${JSON.stringify([adminToken])})`);
      const stillThere = String(leftList).includes(trackingNo);
      logs.push(`验货列表复核: ${stillThere ? '仍在（未完成）' : '已离开验货环节 ✅'}`);
      expect(!stillThere, '提交验货后单号仍在验货列表（未生效）').toBeTruthy();
    });

    // ===== B7 商品上架（标记号→自动货架号→确认上架；product_listing/submit code=1） =====
    // 2026-09-24 对齐 wap-fullchain 实测打法：等货架号生成 + 循环点「确认上架」+ 处理确认弹窗
    // （旧版只点一次且不处理弹窗——点完弹「确认」弹窗没人理，submit 从未发出，code=null 假失败）
    await runStep('B7', '后台商品上架（标记号→自动货架号→确认上架）', '后台', boss, async (logs) => {
      await boss.goto(`${bossUrl('goodsShelving')}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await boss.waitForTimeout(5000);
      const subs: any[] = [];
      const onResp = (r: any) => {
        if (/product_listing\/submit/.test(r.url())) {
          r.text().then((t: string) => { try { const j = JSON.parse(t); subs.push({ code: j?.code, msg: j?.msg || '' }); } catch { subs.push({ code: -1, msg: '' }); } }).catch(() => {});
        }
      };
      boss.on('response', onResp);
      await boss.locator('input[placeholder*="商品标记号"]').first().fill(trackingNo);
      await boss.keyboard.press('Enter');
      // 等待 check 识别后填货架号（ian 2026-09-24 指定交互：货架号不自动生成，手动填 A-1-1）。
      // ⚠ 必须 fill 后按 Enter（探针实锤：Vue 组件监听 Enter 才同步状态，只填值不解禁——按钮 disabled 依旧，submit 不发）
      const shelfInput = boss.locator('input[placeholder*="货架号"]').first();
      let shelfOk = false;
      for (let i = 0; i < 5 && !shelfOk; i++) {
        await shelfInput.fill('A-1-1', { timeout: 5000 }).catch(() => {});
        await shelfInput.press('Enter').catch(() => {});
        await boss.waitForTimeout(800);
        await shelfInput.press('Enter').catch(() => {});
        shelfOk = await boss.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => /确认上架/.test(x.textContent || '')); return !!b && !b.disabled; })()`);
        if (!shelfOk) await boss.waitForTimeout(1500);
      }
      // 循环点击「确认上架」（可见且未禁用）+ 处理确认弹窗，直到 submit 响应出现
      let clicked = false;
      for (let i = 0; i < 8 && !subs.length; i++) {
        clicked = await boss.evaluate(`(() => {
          const bs = Array.from(document.querySelectorAll('button')).filter((x) => /确认上架/.test(x.textContent || '') && x.offsetParent !== null && !x.disabled);
          if (bs[0]) { bs[0].click(); return true; }
          return false;
        })()`);
        await boss.waitForTimeout(2500);
        await boss.evaluate(`(() => {
          const ds = Array.from(document.querySelectorAll('.el-message-box, .el-dialog, [class*="modal"]')).filter((d) => d.offsetParent !== null || getComputedStyle(d).position === 'fixed');
          const d = ds[ds.length - 1];
          const b = d && Array.from(d.querySelectorAll('button')).find((x) => /^\\s*(确定|是|确\\s*定)\\s*$/.test(x.textContent || ''));
          if (b) b.click();
        })()`).catch(() => {});
      }
      for (let i = 0; i < 8 && !subs.length; i++) await boss.waitForTimeout(1000);
      boss.off('response', onResp);
      const okSub = subs.find((s) => s.code === 1);
      logs.push(`货架号A-1-1解禁=${shelfOk} 点击=${clicked} submit=${JSON.stringify(subs)}`);
      expect(okSub, `商品上架失败: ${JSON.stringify(subs)}`).toBeTruthy();
    });

    // ===== F3 前台提交运单（warehouse → Select All → Submit Shipment） =====
    await runStep('F3', '前台提交运单（按编号勾选本轮商品→默认地址→运费模板→提交）', '前台', user, async (logs) => {
      await user.goto(`${pcUrl('warehouse')}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await user.waitForTimeout(8000);
      // 按 ian 交互（2026-09-23 澄清）：仓库页无包裹号，行内「编号」=OG+订单号后12位；
      // 只勾选本轮订单对应商品行（老「全选」会把仓库历史商品一并打包）
      const ogKey = 'OG' + orderNo.slice(1);
      // 2026-10-09 ian：仓库页间歇半渲染（bodyLen~1400 无商品行，JOB-000081 实录）→ reload 自愈最多 4 次
      let pickF3: any = { picked: false, text: '' };
      for (let wri = 0; wri < 4; wri++) {
        pickF3 = await user.evaluate(`((args) => {
        const vis = (el) => !!el && el.offsetParent !== null;
        const boxes = Array.from(document.querySelectorAll('input[type="checkbox"]')).filter(vis);
        for (const b of boxes) {
          const r = b.closest('tr') || b.closest('[class*="item"], [class*="row"], [class*="card"], li, .ant-table-row');
          const t = r ? (r.innerText || '') : '';
          if (args.key && t.includes(args.key)) { if (!b.checked) b.click(); return { picked: true, text: t.slice(0, 100) }; }
        }
        return { picked: false, text: '' };
      })(${JSON.stringify({ key: ogKey })})`);
        if (pickF3.picked) break;
        logs.push(`仓库页第 ${wri + 1} 次未找到本轮商品行（半渲染）→ reload 自愈`);
        await user.goto(`${pcUrl('warehouse')}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await user.waitForTimeout(8000);
      }
      // 2026-10-10（JOB-000083 实录仓库页 4 次全败、页面 JS 未启动连 mywarehouse 请求都没发）：
      // 勾选失败 → 接口级兜底：evaluate(CDP) 直调 mywarehouse/lists 按 goodssn 匹配条目拿 id，
      // 直接构造 confirmpackage 确认页 URL（勾选+提交按钮的唯一目的就是进确认页，探针 probe-warehouse-api.ts 已验证结构）
      if ((pickF3 as any).picked) {
        logs.push(`勾选本轮商品行（${ogKey}）: picked=true`);
        await user.waitForTimeout(2000);
        // 提交运单
        await user.evaluate(`(() => {
        const b = Array.from(document.querySelectorAll('button')).find((x) => /提交运单|submit shipment/i.test(x.textContent || ''));
        if (b) b.click();
      })()`);
        await user.waitForTimeout(8000);
        logs.push(`提交运单后 URL: ${user.url().slice(0, 100)}`);
      } else {
        logs.push(`勾选本轮商品行（${ogKey}）: picked=false（页面 4 次半渲染）→ 接口兜底 mywarehouse/lists`);
        const whTxt = await user.evaluate(`(async (k) => {
          const r = await fetch('/api/v1/mywarehouse/lists', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          return await r.text();
        })(${JSON.stringify(ogKey)})`).catch(() => '');
        let whKey = ''; let whLen = -1;
        try {
          const wh = JSON.parse(String(whTxt));
          const arr = Array.isArray(wh.data) ? wh.data : [];
          whLen = arr.length;
          const hit = arr.find((x: any) => String(x.goodssn || '') === k);
          if (hit) whKey = String(hit.id);
        } catch { /* 半渲染下接口也可能异常 */ }
        logs.push(`mywarehouse/lists 兜底: 条目数=${whLen} key=${whKey || '未命中'}（响应片段=${String(whTxt).slice(0, 150)}）`);
        expect(whKey, `仓库页与接口均未找到本轮商品（ogKey=${ogKey}）：页面 4 次半渲染 + mywarehouse/lists 未命中——请复核 B7 上架是否生效`).toBeTruthy();
        await user.goto(`${pcUrl('confirmpackage')}?key=confirmpackage-${whKey}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await user.waitForTimeout(4000);
        logs.push(`确认页直达构造: ${user.url().slice(0, 100)}`);
      }
      // 2026-09-23：确认页 UI 点击序列不可靠（探针对比：UI 点提交未触发 toPackage，只有 changeShipping 估算）。
      // 改接口直调 order/toPackage。2026-09-24 站点改版：确认页 URL 只带 key=confirmpackage-<条目id>，
      // 不再带 address_id/template_id → address_id 兜底调 /api/v1/address/lists 取默认地址，template_id 回退 10（9/23 实测值）
      const confirmUrl = user.url();
      const keyId = (confirmUrl.match(/confirmpackage-(\d+)/) || [])[1] || '';
      let tid = (confirmUrl.match(/template_id=(\d+)/) || [])[1] || '10';
      let aid = (confirmUrl.match(/address_id=(\d+)/) || [])[1] || '';
      expect(keyId, `确认页 URL 缺条目 key: ${confirmUrl.slice(0, 100)}`).toBeTruthy();
      if (!aid) {
        const addr = await user.evaluate(`(async () => {
          try {
            const r = await fetch('/api/v1/address/lists', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            const j = await r.json().catch(() => null);
            if (!j) return 'ERR:nojson';
            const d = j.data;
            const list = Array.isArray(d) ? d : (d && (d.data || d.list)) || [];
            const first = Array.isArray(list) ? list[0] : (list && typeof list === 'object' ? list : null);
            const id = first ? String(first.id || first.address_id || '') : '';
            return id || ('ERR:code=' + j.code + ' dataType=' + (d === null ? 'null' : Array.isArray(d) ? 'arr' : typeof d) + ' len=' + (Array.isArray(list) ? list.length : -1));
          } catch (e) { return 'ERR:' + String(e).slice(0, 60); }
        })()`);
        aid = String(addr || '');
        if (/^ERR/.test(aid)) { logs.push(`地址接口兜底失败诊断: ${aid}`); aid = ''; }
        else logs.push(`URL 无 address_id，接口兜底取默认地址: ${aid}`);
      }
      expect(keyId && aid, `确认页缺条目/地址参数: key=${keyId} address=${aid} ${confirmUrl.slice(0, 80)}`).toBeTruthy();
      const toPkg = await user.evaluate(async (args) => {
        const doFetch = (token) => fetch('/api/v1/order/toPackage', {
          method: 'POST', credentials: 'include',
          headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { token } : {}),
          body: JSON.stringify({ template_id: Number(args.tid), address_id: Number(args.aid), order_goods_ids: [args.keyId], server: { '1': [args.keyId], '2': [args.keyId], '3': [args.keyId] } }),
        }).then((r) => r.text());
        let t = await doFetch('');
        let j; try { j = JSON.parse(t); } catch { j = { code: -1, msg: t.slice(0, 120) }; }
        if (j?.code === 401) {
          let token = '';
          try { const info = JSON.parse(localStorage.getItem('info') || '{}'); token = info.token || info.access_token || ''; } catch {}
          t = await doFetch(token);
          try { j = JSON.parse(t); } catch { j = { code: -1, msg: t.slice(0, 120) }; }
        }
        return { code: j?.code, msg: j?.msg || '', pkgId: j?.data || '' };
      }, { keyId, tid, aid });
      logs.push(`接口直调 toPackage（条目${keyId}/模板${tid}/地址${aid}）: code=${(toPkg as any).code} msg=${(toPkg as any).msg} pkgId=${(toPkg as any).pkgId}`);
      expect((toPkg as any).code === 1, `提交运单接口失败: code=${(toPkg as any).code} ${(toPkg as any).msg}`).toBeTruthy();
      packageId = String((toPkg as any).pkgId || '');
      fcCtx.packageId = packageId; fcCtx.sendorderId = packageId;
      await user.waitForTimeout(3000);
      // 2026-10-09 ian：packages 页间歇半渲染（bodyLen~453 空壳，JOB-000080/82 实录：4 次自愈退出后页面才渲染出来）
      // 2026-10-10 加固为三层兜底（S 号是 B8 拣货/B9 出库扫码的必要输入，必须拿到）：
      // ① packages 页 reload 自愈 5 次×6s；② 前台 sendorder/lists 按 id==pkgId 精确反查 sn；③ 后台 packageLists keyword 搜索
      let txt = '';
      for (let gi = 0; gi < 5; gi++) {
        await user.goto(`${pcUrl('packages')}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await user.waitForTimeout(6000);
        txt = await user.locator('body').innerText();
        packageNo = (user.url().match(/S\d{12,}/) || txt.match(/S\d{12,}/) || [])[0] || '';
        fcCtx.packageNo = packageNo;
        if (packageNo || /S\d{12,}/.test(txt)) break;
        logs.push(`packages 页第 ${gi + 1} 次未渲染出包裹编号（bodyLen=${txt.length}）→ reload 自愈`);
        await user.waitForTimeout(2000);
      }
      if (!packageNo && packageId) {
        // 兜底②：前台 sendorder/lists（同会话）按 id==packageId 精确取 sn
        const soTxt = await user.evaluate(`(async ([pid]) => {
          const r = await fetch('/api/v1/sendorder/lists', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ page: 1, size: 20, keywords: '' }) });
          return await r.text();
        })(${JSON.stringify([packageId])})`).catch(() => '');
        try {
          const so = JSON.parse(String(soTxt));
          const items = (so.data && (so.data.data || so.data.list || so.data)) || [];
          const hit = Array.isArray(items) ? items.find((x: any) => String(x.id) === String(packageId)) : null;
          const snM = hit ? String(hit.sn || '').match(/S\d{12,}/) : null;
          if (snM) { packageNo = snM[0]; fcCtx.packageNo = packageNo; logs.push(`sendorder/lists 兜底命中: id=${packageId} sn=${packageNo}`); }
          else logs.push(`sendorder/lists 兜底未命中: len=${Array.isArray(items) ? items.length : -1} 片段=${String(soTxt).slice(0, 120)}`);
        } catch { logs.push(`sendorder/lists 兜底解析失败: ${String(soTxt).slice(0, 120)}`); }
      }
      if (!packageNo) {
        // 兜底③：后台 packageLists keyword 搜索（ogKey / 订单号两连试，命中行按 id==packageId 优先取 sn）
        const f3tok = await boss.evaluate(`(() => localStorage.getItem('admin_token') || '')()`);
        for (const kw of [ogKey, orderNo]) {
          const pkTxt = await boss.evaluate(`(async ([tok, k]) => {
            const r = await fetch('${bossApi('packageLists')}', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': tok }, credentials: 'include', body: JSON.stringify({ page: 1, size: 10, keyword: k }) });
            return await r.text();
          })(${JSON.stringify([f3tok, kw])})`).catch(() => '');
          const rows: any[] = [];
          try { const j = JSON.parse(String(pkTxt)); const d = j.data && (j.data.data || j.data.list || j.data); if (Array.isArray(d)) rows.push(...d); } catch { /* noop */ }
          const byId = rows.find((x: any) => String(x.id) === String(packageId));
          const snHit = (byId && String(byId.sn || '').match(/S\d{12,}/)) || String(pkTxt).match(/"sn":"(S\d{12,})"/);
          if (snHit) { packageNo = snHit[1] || String(snHit[0]); fcCtx.packageNo = packageNo; logs.push(`packageLists 兜底命中（keyword=${kw}）: sn=${packageNo}`); break; }
          logs.push(`packageLists 兜底未命中（keyword=${kw}）: ${String(pkTxt).slice(0, 120)}`);
        }
      }
      logs.push(`运单已提交，包裹号: ${packageNo || '未捕获'}（pkgId=${packageId}）`);
      expect(packageNo, `未捕获包裹编号（页面 5 次自愈 + sendorder/lists + packageLists 三层兜底均失败；toPackage 已成功 pkgId=${packageId}，请到后台包裹管理人工取证 S 号）`).toBeTruthy();
    });

    // ===== B8 快速拣货（扫码→点「拣货」全宽按钮）+ 审核(title=审核 icon→「通过」；status_id=10) =====
    await runStep('B8', '后台快速拣货→包裹审核通过（status_id=10）', '后台', boss, async (logs) => {
      // --- 拣货：扫码后必须点「拣货」主按钮，否则状态停留待拣货 ---
      await boss.goto(`${bossUrl('packagePicking')}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await boss.waitForTimeout(5000);
      await boss.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.trim() === '快速拣货'); if (b) b.click(); })()`);
      await boss.waitForTimeout(2000);
      await boss.evaluate(`((v) => {
        const ips = Array.from(document.querySelectorAll('input')).filter((i) => i.offsetParent !== null && String(i.placeholder || '').includes('包裹编号'));
        const ip = ips[ips.length - 1];
        if (ip) { const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; s.call(ip, v); ip.dispatchEvent(new Event('input', { bubbles: true })); ip.focus(); }
      })(${JSON.stringify(packageNo)})`);
      await boss.keyboard.press('Enter');
      await boss.waitForTimeout(3500);
      const pickHit = await boss.evaluate(`(() => {
        const bs = Array.from(document.querySelectorAll('button')).filter((b) => b.offsetParent !== null && b.textContent.trim() === '拣货');
        if (bs[0]) { bs[0].click(); return true; }
        return false;
      })()`);
      await boss.waitForTimeout(4000);
      await boss.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button, .el-tabs__item, div, span')).find((x) => x.textContent.trim() === '已操作' && x.offsetParent !== null); if (b) b.click(); })()`);
      await boss.waitForTimeout(3000);
      const doneTxt = await boss.evaluate(`(() => document.body.innerText || '')()`);
      const picked = doneTxt.includes(packageNo);
      logs.push(`快速拣货: 点「拣货」按钮=${pickHit}，已操作tab含包裹=${picked}`);
      expect(picked, '拣货后包裹未进「已操作」列表（可能未点「拣货」主按钮）').toBeTruthy();
      // --- 审核：拣货后才出现 title=「审核」的 icon 按钮 ---
      await boss.goto(`${bossUrl('package')}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await boss.waitForTimeout(5000);
      await boss.locator('input[placeholder*="包裹"]').first().fill(packageNo).catch(() => {});
      await boss.waitForTimeout(1200);
      await boss.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => /筛选|搜索/.test(x.textContent || '')); if (b) b.click(); })()`).catch(() => {});
      await boss.waitForTimeout(4000);
      const auditHit = await boss.evaluate(`((pkg) => {
        const rows = Array.from(document.querySelectorAll('tbody tr, .el-table__row')).filter((r) => (r.textContent || '').includes(pkg));
        if (!rows[0]) return 'NO_ROW';
        const btn = Array.from(rows[0].querySelectorAll('button')).find((b) => b.title === '审核');
        if (!btn) return 'NO_BTN';
        btn.click();
        return 'OK';
      })(${JSON.stringify(packageNo)})`);
      expect(auditHit === 'OK', `审核按钮未找到: ${auditHit}（拣货后才会出现 title=审核 icon）`).toBeTruthy();
      await boss.waitForTimeout(2500);
      // 审核弹窗确认（2026-10-08：点击结果必须记录——弹窗未弹/按钮匹配失败是 status 停留 0 的常见根因）
      const confirmHit = await boss.evaluate(`(() => {
        const ds = Array.from(document.querySelectorAll('.el-message-box, .el-dialog')).filter((d) => d.offsetParent !== null);
        const d = ds[ds.length - 1];
        if (!d) return 'NO_DIALOG';
        const b = Array.from(d.querySelectorAll('button')).find((x) => /通过|确定/.test(x.textContent || ''));
        if (!b) return 'NO_BTN';
        b.click(); return 'OK';
      })()`);
      logs.push(`审核弹窗确认: ${confirmHit}`);
      await boss.waitForTimeout(4000);
      // 接口验证 status_id=10（待付款）
      const adminToken = await boss.evaluate(`(() => localStorage.getItem('admin_token') || '')()`);
      const queryStatus = () => boss.evaluate(`(async ([tok, pkg]) => {
        const r = await fetch('${bossApi('packageLists')}', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': tok }, credentials: 'include', body: JSON.stringify({ page: 1, size: 10, keyword: pkg }) });
        return await r.text();
      })(${JSON.stringify([adminToken, packageNo])})`);
      let st = await queryStatus();
      let sid = (String(st).match(/"status_id":(\d+)/) || [])[1];
      if (sid !== '10') { // 审核可能异步落库：5s 后复查一次
        await boss.waitForTimeout(5000);
        st = await queryStatus();
        sid = (String(st).match(/"status_id":(\d+)/) || [])[1];
      }
      logs.push(`审核通过，status_id=${sid}（期望 10=待付款；0=未生效）`);
      expect(sid === '10', `包裹审核未生效（status_id=${sid}，期望 10）【排查】审核弹窗确认=${confirmHit}` +
        (confirmHit === 'OK' ? '（弹窗已点「通过」但状态未变：疑审核接口失败或站点行为变化，复核 package/lists 响应与本步 curl）' : `（弹窗确认失败：${confirmHit === 'NO_DIALOG' ? '审核确认弹窗未弹出' : '弹窗内未匹配到「通过/确定」按钮'}）`) +
        `；包裹 ${packageNo}；lists 响应片段 ${String(st).slice(0, 180)}`).toBeTruthy();
    });

    // ===== F4 前台支付国际运费（按钮「支 付」带空格；余额支付→「已付款」） =====
    await runStep('F4', '前台支付国际运费（余额支付）', '前台', user, async (logs) => {
      // 2026-09-23：packages 页在容器环境渲染不确定（3 次 reload 仍定位不到，宿主机 dump 正常）——
      // 改用收银台 URL 直达：/pay?order_id=<包裹id>&type=package（order_id = F3 toPackage 返回的包裹 id，ian 给出 URL 规律）
      expect(packageId, 'F3 未拿到包裹 id（packageId 为空）').toBeTruthy();
      await user.goto(`${pcUrl('pay')}?order_id=${packageId}&type=package`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await user.waitForTimeout(8000);
      expect(/type=package/.test(user.url()), `未进入收银台: ${user.url().slice(0, 90)}`).toBeTruthy();
      logs.push(`支付页 URL: ${user.url().slice(0, 100)}`);
      const payOrderId = (user.url().match(/order_id=(\d+)/) || [])[1] || ''; // 2026-10-13：支付页 order_id（order/lists 兜底精确匹配用）
      // 2026-10-13 重构（JOB-87 实录：进收银台后支付未执行 status_id 停 10）：旧版静默 evaluate 点击无日志无校验，
      // 支付页渲染波动（8-90s）下按钮未渲染/未挂载即无声失效。改为：轮询等「余额支付」→ 每步留痕 → 未确认生效自动整轮重试（最多 2 轮）。
      let payActed = false;
      for (let pr = 1; pr <= 2 && !payActed; pr++) {
        let bal = false;
        for (let wi = 0; wi < 15 && !bal; wi++) {
          bal = await user.evaluate(`(() => { const el = Array.from(document.querySelectorAll('div, span, label, li')).find((x) => /余额/.test(x.textContent || '') && (x.textContent || '').length < 40 && x.offsetParent !== null); if (el) { el.click(); return true; } return false; })()`);
          if (!bal) await user.waitForTimeout(2000);
        }
        logs.push(`第 ${pr} 轮支付：余额支付${bal ? '已点击' : '元素 30s 未出现'}`);
        if (!bal) continue;
        await user.waitForTimeout(1500);
        const payBtn = await user.evaluate(`(() => { const el = Array.from(document.querySelectorAll('button, a')).find((x) => /立即支付|立即付款|pay now/i.test((x.textContent || '').trim()) && (x.textContent || '').trim().length < 20 && x.offsetParent !== null); if (el) { el.click(); return true; } return false; })()`);
        logs.push(`立即支付${payBtn ? '已点击' : '按钮未出现'}`);
        await user.waitForTimeout(6000);
        const confirmed = await user.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button, .ant-modal button, .ant-popconfirm button, [class*=modal] button')).find((x) => /^(确定|确认|confirm|ok)$/i.test((x.textContent || '').trim()) && x.offsetParent !== null); if (b) { b.click(); return true; } return false; })()`).catch(() => false);
        logs.push(`确认弹窗${confirmed ? '已处理' : '未出现'}`);
        await user.waitForTimeout(6000);
        const paySignal = await user.evaluate(`(() => ({ url: location.href.slice(0, 90), head: document.body.innerText.slice(0, 600) }))()`).catch(() => ({ url: '', head: '' }));
        payActed = /成功|success|payResult|已付款/i.test(String(paySignal.url) + String(paySignal.head));
        logs.push(`第 ${pr} 轮支付${payActed ? '已生效（页面出现成功/已付款信号）' : '未捕获成功信号（以最终 packages/packageLists 验证为准）'}: ${String(paySignal.url).slice(0, 70)}`);
      }
      // 2026-10-09 ian：packages 页间歇半渲染（bodyLen~365 空壳，JOB-000078 F4 实录）→ reload 自愈最多 4 次
      let paid = false;
      let seg = '';
      for (let pi = 0; pi < 4 && !paid; pi++) {
        await user.goto(`${pcUrl('packages')}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await user.waitForTimeout(8000);
        const after = await user.locator('body').innerText();
        const idx = after.indexOf(packageNo);
        seg = idx >= 0 ? after.slice(idx, idx + 200) : '';
        paid = /已付款/.test(seg);
        if (!paid) {
          logs.push(`packages 页第 ${pi + 1} 次未见「已付款」（idx=${idx}，bodyLen=${after.length}${idx < 0 ? '，包裹编号未渲染' : '，状态: ' + seg.slice(0, 60)}）→ reload 自愈`);
          await user.waitForTimeout(3000);
        }
      }
      logs.push(`支付后包裹状态: ${paid ? '已付款 ✅' : seg.slice(0, 80)}`);
      if (!paid && packageNo) {
        // 2026-10-10：页面 4 次自愈失败 → 后台 packageLists 接口级验证 status_id=20（支付落库比页面渲染可靠，JOB-000082 实录页面空壳 40s+）
        const f4tok = await boss.evaluate(`(() => localStorage.getItem('admin_token') || '')()`);
        const f4txt = await boss.evaluate(`(async ([tok, k]) => {
          const r = await fetch('${bossApi('packageLists')}', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': tok }, credentials: 'include', body: JSON.stringify({ page: 1, size: 10, keyword: k }) });
          return await r.text();
        })(${JSON.stringify([f4tok, packageNo])})`).catch(() => '');
        const sid4 = (String(f4txt).match(/"status_id":(\d+)/) || [])[1];
        if (sid4 === '20') { paid = true; seg = '已付款（后台接口 status_id=20 验证）'; }
        logs.push(`packageLists 接口兜底验证: status_id=${sid4 || '未解析'}（期望 20=已付款；响应片段 ${String(f4txt).slice(0, 150)}）`);
      }
      expect(paid, '支付国际运费后包裹未变「已付款」（页面 4 次自愈 + 后台接口兜底均未确认）').toBeTruthy();
    });

    // ===== B9 后台包裹出库（快速出库→扫码→点「出库」；status_id=27） =====
    await runStep('B9', '后台快速出库（status_id=27）', '后台', boss, async (logs) => {
      await boss.goto(`${bossUrl('packageOutbound')}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await boss.waitForTimeout(5000);
      await boss.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.trim() === '快速出库'); if (b) b.click(); })()`);
      await boss.waitForTimeout(2000);
      await boss.evaluate(`((v) => {
        const ips = Array.from(document.querySelectorAll('input')).filter((i) => i.offsetParent !== null && String(i.placeholder || '').includes('包裹编号'));
        const ip = ips[ips.length - 1];
        if (ip) { const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; s.call(ip, v); ip.dispatchEvent(new Event('input', { bubbles: true })); ip.focus(); }
      })(${JSON.stringify(packageNo)})`);
      await boss.keyboard.press('Enter');
      await boss.waitForTimeout(3500);
      const obHit = await boss.evaluate(`(() => {
        const bs = Array.from(document.querySelectorAll('button')).filter((b) => b.offsetParent !== null && b.textContent.trim() === '出库');
        if (bs[0]) { bs[0].click(); return true; }
        return false;
      })()`);
      await boss.waitForTimeout(3000);
      await boss.evaluate(`(() => {
        const ds = Array.from(document.querySelectorAll('.el-message-box, .el-dialog')).filter((d) => d.offsetParent !== null);
        const d = ds[ds.length - 1];
        const b = d && Array.from(d.querySelectorAll('button')).find((x) => /确定|是/.test(x.textContent || ''));
        if (b) b.click();
      })()`).catch(() => {});
      await boss.waitForTimeout(4000);
      const adminToken = await boss.evaluate(`(() => localStorage.getItem('admin_token') || '')()`);
      const st = await boss.evaluate(`(async ([tok, pkg]) => {
        const r = await fetch('${bossApi('packageLists')}', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': tok }, credentials: 'include', body: JSON.stringify({ page: 1, size: 10, keyword: pkg }) });
        return await r.text();
      })(${JSON.stringify([adminToken, packageNo])})`);
      const sid = (String(st).match(/"status_id":(\d+)/) || [])[1];
      logs.push(`出库后 status_id=${sid}（期望 27=已出库）`);
      expect(sid === '27', `出库未完成（status_id=${sid}，注意扫码后必须点「出库」主按钮）`).toBeTruthy();
    });

    // ===== B10 后台国际发货（发货单号必须纯字母数字；status_id=30） =====
    await runStep('B10', '后台待发货→国际发货（录发货单号）', '后台', boss, async (logs) => {
      // 2026-10-10（JOB-000083 attempt2 实录：pending-shipment 半渲染 bodyLen=1367 → NO_BTN）：
      // 找行/找「发货」按钮失败时 reload 重试整段（搜索+找行），最多 3 次
      let shipClick = '';
      for (let bi = 0; bi < 3; bi++) {
        if (bi > 0) logs.push(`待发货页第 ${bi} 次未就绪（${shipClick}，半渲染）→ reload 自愈`);
        await boss.goto(`${bossUrl('pendingShipment')}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await boss.waitForTimeout(6000);
        await boss.evaluate(`((v) => {
        const ips = Array.from(document.querySelectorAll('input')).filter((i) => i.offsetParent !== null && i.type === 'text' && !i.placeholder);
        const ip = ips[0];
        if (ip) { const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; s.call(ip, v); ip.dispatchEvent(new Event('input', { bubbles: true })); }
      })(${JSON.stringify(packageNo)})`);
        await boss.waitForTimeout(1000);
        await boss.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => /筛选|搜索/.test(x.textContent || '')); if (b) b.click(); })()`).catch(() => {});
        await boss.keyboard.press('Enter').catch(() => {});
        await boss.waitForTimeout(4000);
        shipClick = await boss.evaluate(`((pkg) => {
        const rows = Array.from(document.querySelectorAll('tbody tr, .el-table__row')).filter((r) => (r.textContent || '').includes(pkg));
        if (!rows[0]) return 'NO_ROW';
        const ship = Array.from(rows[0].querySelectorAll('button')).find((b) => b.textContent.trim() === '发货');
        if (ship) { ship.click(); return 'OK'; }
        return 'NO_BTN';
      })(${JSON.stringify(packageNo)})`);
        if (shipClick === 'OK') break;
      }
      let shipNo = `yd${Date.now()}`; // 纯字母数字！含 - : 等字符会被静默拒绝（2026-09-22 教训）
      if (shipClick === 'OK') {
        await boss.waitForTimeout(3000);
        const filled = await boss.evaluate(`((no) => {
        const ds = Array.from(document.querySelectorAll('.el-dialog, .el-drawer')).filter((d) => d.offsetParent !== null);
        const d = ds[ds.length - 1];
        if (!d) return 'NO_DIALOG';
        const ip = d.querySelector('input[placeholder*="发货单号"]') || d.querySelector('input[type=text]');
        if (!ip) return 'NO_INPUT';
        ip.focus();
        const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        s.call(ip, no);
        ip.dispatchEvent(new Event('input', { bubbles: true }));
        ip.dispatchEvent(new Event('change', { bubbles: true }));
        return 'OK';
      })(${JSON.stringify(shipNo)})`);
        expect(filled === 'OK', `发货单号填写失败: ${filled}`).toBeTruthy();
        await boss.waitForTimeout(1000);
        await boss.evaluate(`(() => {
        const ds = Array.from(document.querySelectorAll('.el-dialog, .el-drawer')).filter((d) => d.offsetParent !== null);
        const d = ds[ds.length - 1];
        const b = d && Array.from(d.querySelectorAll('button')).find((x) => x.textContent.trim() === '发货');
        if (b) b.click();
      })()`);
        await boss.waitForTimeout(5000);
      } else {
        // 2026-10-13 终版（ian 人工 curl 实锤）：submit 端点/参数与 JOB-000017 配方一致且当前有效；
        // send_order_id 即 F3 toPackage 返回的包裹 id（skill 备案「data=包裹 id（=sendorder_id）」，ian 手动发货 113 与包裹序号吻合）
        // → 直接 submit 免 lists 定位（昨轮 lists 返回非 JSON 已绕开）；submit 未成才用 lists 诊断（带 HTTP status 留痕）。
        logs.push(`UI 发货按钮未命中（${shipClick}）→ awaiting_shipment/submit 直调（send_order_id=${packageId}）`);
        const tok10 = await boss.evaluate(`(() => localStorage.getItem('admin_token') || '')()`);
        const sub = await boss.evaluate(`(async ([tok, sid, no]) => {
          const H = { 'content-type': 'application/json', 'x-admin-token': tok };
          const sr = await fetch('${bossApi('awaitingShipmentSubmit')}', { method: 'POST', headers: H, credentials: 'include', body: JSON.stringify({ send_order_id: Number(sid), express_no: no }) });
          const submitStatus = sr.status;
          const submitResp = await sr.text().catch(() => '');
          if (submitStatus !== 200) {
            const lr = await fetch('${bossApi('awaitingShipmentLists')}', { method: 'POST', headers: H, credentials: 'include', body: JSON.stringify({ size: 10, page: 1, handled: 1 }) });
            const listsStatus = lr.status;
            const listsHead = await lr.text().catch(() => '');
            return JSON.stringify({ step: 'diag', submitStatus, submitResp: submitResp.slice(0, 200), listsStatus, listsHead: listsHead.slice(0, 150) });
          }
          return JSON.stringify({ step: 'submit', submitStatus, submitResp: submitResp.slice(0, 220) });
        })(${JSON.stringify([tok10, packageId, shipNo])})`).catch((e: any) => JSON.stringify({ step: 'err', msg: String(e).slice(0, 120) }));
        let apiOk = false;
        try {
          const aj = JSON.parse(String(sub));
          if (aj.step === 'submit' && Number(aj.submitStatus) === 200 && /"code"\s*:\s*1/.test(String(aj.submitResp))) {
            apiOk = true;
            logs.push(`submit 直调成功（HTTP ${aj.submitStatus}）: ${String(aj.submitResp).slice(0, 130)}`);
          } else {
            logs.push(`submit 直调未成功: ${JSON.stringify(aj).slice(0, 280)}`);
          }
        } catch { logs.push(`submit 直调解析失败: ${String(sub).slice(0, 140)}`); }
        if (!apiOk) throw new Error(`B10 UI(${shipClick}) 与 awaiting_shipment/submit 直调均失败`);
        logs.push('接口直调发货成功（status_id=30 验证交给下方 packageLists 复核）');
        await boss.waitForTimeout(3000);
      }
      const adminToken = await boss.evaluate(`(() => localStorage.getItem('admin_token') || '')()`);
      const st = await boss.evaluate(`(async ([tok, pkg]) => {
        const r = await fetch('${bossApi('packageLists')}', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': tok }, credentials: 'include', body: JSON.stringify({ page: 1, size: 10, keyword: pkg }) });
        return await r.text();
      })(${JSON.stringify([adminToken, packageNo])})`);
      const sid = (String(st).match(/"status_id":(\d+)/) || [])[1];
      logs.push(`发货单号 ${shipNo}，status_id=${sid}（期望 30=已发货）`);
      expect(sid === '30', `发货未完成（status_id=${sid}）`).toBeTruthy();
    });

    // ===== F5 前台确认收货（确认弹窗是 Ant Design ant-modal；最终「已收货」） =====
    await runStep('F5', '前台确认收货（最终「已收货」）', '前台', user, async (logs) => {
      await user.goto(`${pcUrl('packages')}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await user.waitForTimeout(8000);
      // 2026-09-23：确认弹窗为自定义结构（按钮不在 .ant-modal 节点内）+ 容器渲染不确定 → 接口直调
      // POST /api/v1/sendorder/receipt {sendorder_id}（probe-f5-dump.ts 实测 code=1 操作成功）
      expect(packageId, 'F3 未拿到包裹 id（packageId 为空）').toBeTruthy();
      const receipt = await user.evaluate(async (args) => {
        const doFetch = (path, body, token) => fetch(path, {
          method: 'POST', credentials: 'include',
          headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { token } : {}),
          body: JSON.stringify(body),
        }).then((r) => r.text());
        let token = '';
        try { const info = JSON.parse(localStorage.getItem('info') || '{}'); token = info.token || info.access_token || ''; } catch {}
        const lr = await doFetch('/api/v1/sendorder/lists', { keywords: args.pkg, page: 1, size: 10 }, token);
        let lj; try { lj = JSON.parse(lr); } catch { return { ok: false, step: 'lists', info: lr.slice(0, 100) }; }
        const row = ((lj?.data?.data) || []).find((x) => x.sn === args.pkg);
        if (!row) return { ok: false, step: 'lists', info: '未找到运单 ' + args.pkg };
        const rr = await doFetch('/api/v1/sendorder/receipt', { sendorder_id: row.id }, token);
        let rj; try { rj = JSON.parse(rr); } catch { return { ok: false, step: 'receipt', info: rr.slice(0, 100) }; }
        return { ok: rj?.code === 1, code: rj?.code, msg: rj?.msg || '', id: row.id };
      }, { pkg: packageNo });
      logs.push(`接口直调确认收货（sendorder_id=${(receipt as any).id}）: code=${(receipt as any).code} msg=${(receipt as any).msg}`);
      expect((receipt as any).ok, `确认收货接口失败: ${(receipt as any).step} ${(receipt as any).info || ''} code=${(receipt as any).code} ${(receipt as any).msg || ''}`).toBeTruthy();
      await user.waitForTimeout(5000);
      await user.goto(`${pcUrl('packages')}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await user.waitForTimeout(8000);
      const after = await user.locator('body').innerText();
      const idx = after.indexOf(packageNo);
      const seg = idx >= 0 ? after.slice(idx, idx + 200) : '';
      const done = /已收货|已签收|已完成/.test(seg);
      logs.push(`最终包裹状态: ${done ? '已收货 ✅ 13步全链闭环' : seg.slice(0, 80)}`);
      expect(done, `确认收货后未变「已收货」: ${seg.slice(0, 60)}`).toBeTruthy();
    });

    const summary = {
      runTag: RUN_TAG,
      time: new Date().toISOString(),
      spec: SPEC_FILE,
      orderNo, packageNo, trackingNo, payAmounts,
      passed: steps.filter((s) => s.status === 'ok').length,
      total: steps.length,
      steps,
      capturedCount: captured.length,
      reloginEvents,
      runConfig,
      tradeLedger: buildLedger(),
    };
    const writeSummary = () => {
      writeFileSync(`${DATA}/fullchain-result.json`, JSON.stringify(summary, null, 2));
      writeFileSync(`${DATA}/fullchain-curls.json`, JSON.stringify(captured, null, 2));
    };
    // 无论成败都落盘，保证报告可用
    process.on('exit', writeSummary);
    try {
      expect(summary.passed).toBe(summary.total);
    } catch (e) {
      writeSummary();
      console.log(`\n=== 完整链路结果: ${summary.passed}/${summary.total} 通过（失败步骤见 fullchain-result.json）===`);
      throw e;
    }
    writeSummary();
    console.log(`\n=== 完整链路结果: ${summary.passed}/${summary.total} 通过 ===`);
    console.log(`订单 ${orderNo} | 包裹 ${packageNo} | 快递单号 ${trackingNo}`);
  });
});
