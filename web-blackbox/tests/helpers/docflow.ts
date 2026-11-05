/**
 * docflow.ts —— 自动生成用例（tests/doc-*.spec.ts）共用业务动作库
 * （2026-10-05 ian：口语化用例自动扩充为可直接执行的测试）
 * 由 apps/scenarios/doc_actions.py 识别口语步骤 → 生成 spec 时 import 本库。
 * 站点再改版只需更新本文件，所有自动生成用例同步生效。
 *
 * 适配 demo.example.com 前台（2026-09-30 探针实锤，Tailwind 改版版）：
 *  - 搜索框 input[placeholder*="商品名称"]（nth(1) 可见；nth(0) 常为折叠态 hidden）
 *  - 详情 CTA 行 = [立即购买(文本)][加购(纯图标)][收藏(纯图标)]，加购 = 立即购买.nextElementSibling
 *  - 加购接口 POST /api/*cart* code=1；页头购物车徽标 a[href*="/dashboard/cart"]
 */
import { test, expect } from '@playwright/test';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import type { Page } from '@playwright/test';
import { pcUrl, site, libPool } from './site';
import { dismissOverlays } from './overlay';
// 2026-11-04 ian：临时邮箱取码（nimail 免费 API）——注册/登录遇到「邮箱验证码」自动收信提码
import { applyMailbox, applyMailboxFor, newMailboxAddress, waitForCode, listMails } from './tempmail';
// 2026-10-16 ian：开屏广告/弹窗守卫（overlay.ts）接入本库全部页面入口——
// 打开网站遇开屏广告先关闭再继续测试，所有自动生成用例（doc-*.spec.ts）同步生效。

// ---------- 请求转 curl ----------
export function toCurl(req: { method(): string; url(): string; headers(): Record<string, string>; postData(): string | null }): string {
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

// ---------- 步骤记录器（worker 分片写入，gen-platform-report.py 自动合并） ----------
export type CapturedReq = { side: string; method: string; url: string; status: number; curl: string };
export type StepRec = { id: string; name: string; side: string; status: 'ok' | 'fail' | 'warn'; logs: string[]; shot: string; startedAt: string; ms: number; curls?: CapturedReq[] };

export function makeRecorder(specFile: string, shotPrefix: string) {
  const RUN_DIR = process.env.FULLCHAIN_RUN_DIR || 'DOC_MANUAL';
  const SHOTS = `output/html-report/${RUN_DIR}/screenshots`;
  const DATA = `output/${RUN_DIR}`;
  mkdirSync(SHOTS, { recursive: true });
  mkdirSync(DATA, { recursive: true });
  const steps: StepRec[] = [];
  let captured: CapturedReq[] = [];
  const recent: CapturedReq[] = [];

function wireCapture(page: Page, side: string) {
  page.on('response', (r) => {
    const req = r.request();
    const url = req.url();
    if (!url.includes('/api/')) return;
    if (/\.(png|jpg|jpeg|css|js|woff2?|gif|svg|ico)(\?|$)/.test(url)) return;
    try {
      recent.push({ side, method: req.method(), url, status: r.status(), curl: toCurl(req) });
      if (recent.length > 400) recent.shift();
    } catch { /* 忽略 */ }
  });
}

/** 步骤落盘：截图 + recent 请求内嵌 + worker 分片 result json（成功失败都写，报告生成器直读合并） */
async function recordStep(id: string, name: string, page: Page, status: 'ok' | 'fail', logs: string[], t0: number): Promise<void> {
  const shot = `${shotPrefix}-${id}.png`;
  await page.screenshot({ path: `${SHOTS}/${shot}` }).catch(() => {});
  const stepCurls = recent.splice(0, recent.length);
  captured.push(...stepCurls);
  const idx = steps.findIndex((s) => s.id === id);
  if (idx >= 0) steps.splice(idx, 1);
  steps.push({ id, name, side: '前台', status, logs, shot, startedAt: new Date(t0).toISOString(), ms: Date.now() - t0, curls: stepCurls });
  const sliceFile = `${DATA}/fullchain-result.w${test.info().workerIndex}.json`;
  writeFileSync(sliceFile, JSON.stringify({
    runTag: RUN_DIR, time: new Date().toISOString(), spec: specFile,
    passed: steps.filter((s) => s.status === 'ok').length, total: steps.length,
    steps, capturedCount: captured.length,
  }, null, 2));
  console.log(`[${id}] ${status} ${name} (${Date.now() - t0}ms)`);
}

  return { RUN_DIR, steps, wireCapture, recordStep };
}

export function frontAccount(): { account: string; password: string } {
  const envTxt = readFileSync('.env', 'utf-8');
  return {
    account: process.env.SITE_FRONT_ACCOUNT || /^ONEBUY_TEST_ACCOUNT=(.*)$/m.exec(envTxt)?.[1]?.trim() || '',
    password: process.env.SITE_FRONT_PASSWORD || /^ONEBUY_TEST_PASSWORD=(.*)$/m.exec(envTxt)?.[1]?.trim() || '',
  };
}

/** 三期（2026-11 ian）：AI 探索独立账号——SITE_EXPLORE_ACCOUNT 有值时返回，否则 undefined 回退默认 */
export function exploreAccount(): { account: string; password: string } | undefined {
  const account = (process.env.SITE_EXPLORE_ACCOUNT || '').trim();
  if (!account) return undefined;
  return { account, password: (process.env.SITE_EXPLORE_PASSWORD || '').trim() };
}

export type Cred = { account: string; password: string; mailbox?: string };

/** 平台注入的技能包（manifest.skill_packs → env SKILL_PACKS） */
export type ActiveSkillPack = { code: string; version?: number; name?: string };
export function activeSkillPacks(): ActiveSkillPack[] {
  try {
    const raw = JSON.parse(process.env.SKILL_PACKS || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}
export function hasSkillPack(code: string): boolean {
  return activeSkillPacks().some((p) => p.code === code);
}

/**
 * 站点是否要求邮箱验证码（无副作用预判）。
 * 2026-11-04 ian 实测 OneBuy 系站点 `/api/v1/other/configList` 直接暴露开关：
 *   user_register_captcha=1 → 注册要邮箱验证码；user_login_captcha=1 → 登录要；user_channel_captcha=email → 渠道为邮箱
 *   对照：v2026 双 0（注册即登录，无需验证码）、vtest2026 双 1（注册/登录均要验证码）。
 * 配置接口不可用时返回 null，交由页面/提交后探测兜底。
 */
export type EmailCaptchaConfig = { register: boolean; login: boolean; channel: string; raw: Record<string, string> };

export async function probeEmailCaptchaConfig(page: Page): Promise<EmailCaptchaConfig | null> {
  try {
    const origin = new URL(pcUrl('home')).origin;
    const res = await page.request.post(`${origin}/api/v1/other/configList`, {
      data: {},
      timeout: 15_000,
      headers: { clienttype: 'pc', 'Content-Type': 'application/json' },
    });
    if (!res.ok()) return null;
    const j: any = await res.json().catch(() => null);
    const all = j?.data?.site || j?.data?.all;
    if (!all || typeof all !== 'object') return null;
    const f = (k: string) => String((all as any)[k] ?? '');
    return {
      register: f('user_register_captcha') === '1',
      login: f('user_login_captcha') === '1',
      channel: f('user_channel_captcha') || 'unknown',
      raw: {
        user_register_captcha: f('user_register_captcha'),
        user_login_captcha: f('user_login_captcha'),
        user_channel_captcha: f('user_channel_captcha'),
        mail_verify_type: f('mail_verify_type'),
      },
    };
  } catch {
    return null;
  }
}

/** 确保某个临时邮箱地址已开通收信窗口（按需开通，避免浪费共享额度） */
export async function ensureMailbox(address: string, logs: string[]): Promise<string> {
  if (!address) return '';
  try {
    await applyMailboxFor(address);
    logs.push(`已开通临时邮箱收信窗口：${address}（10 分钟有效）`);
    return address;
  } catch (e: any) {
    logs.push(`临时邮箱开通失败（${address}）：${String(e?.message || e).slice(0, 120)}`);
    throw e;
  }
}

export async function login(page: Page, logs: string[], acc?: Cred): Promise<void> {
  // 2026-11-04 ian：凭证优先级 = 显式传入（探索账号）> 本用例注册的新账号 > 站点测试账号。
  // 用例含「注册新账号并登录」语义时，注册之后的登录自动使用新注册凭证，不再回退测试账号。
  const cred = acc || registeredCred;
  const { account, password } = cred || frontAccount();
  expect(account, '未配置前台测试账号').toBeTruthy();
  await page.goto(pcUrl('login'), { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(3_000);
  await dismissOverlays(page, logs); // 开屏广告守卫：弹窗可能遮挡账号输入框
  await page.locator('input[name="email"]').fill(account);
  await page.locator('input[name="password"]').fill(password);
  const emsLogin = watchEmsSend(page);
  await page.getByRole('button', { name: '登录', exact: true }).first().click();
  await page.waitForTimeout(6_000);

  // 2026-11-04 ian：部分站点登录要求「邮箱验证码」（vtest2026 返回 code=100000「请完成邮箱验证」，弹验证码层）。
  // 临时邮箱注册的账号可自动收码；站点测试账号无邮箱则明确报错，不静默失败。
  if (await hasEmailCodeField(page)) {
    const cfgLogin = await probeEmailCaptchaConfig(page);
    logs.push(
      `登录要求邮箱验证码${cfgLogin ? `（user_login_captcha=${cfgLogin.raw.user_login_captcha}，渠道=${cfgLogin.channel}）` : ''}` +
        `→ 技能包 temp-mail-verification-code 生效`,
    );
    let mb = cred?.mailbox || registeredCred?.mailbox || '';
    if (!mb && /@nimail\.cn$/i.test(account)) mb = await ensureMailbox(account, logs);
    await handleEmailCodeModal(page, mb, logs, 150_000, emsLogin);
  }

  expect(!/login/.test(page.url()), `登录失败，仍停留 ${page.url()}`);
  logs.push(acc
    ? `PC 前台登录成功（AI 探索独立账号 ${account}）`
    : registeredCred
      ? `PC 前台登录成功（本用例注册的新账号 ${registeredCred.account}）`
      : `PC 前台登录成功（站点测试账号 ${account}）`);
}

/** 本用例注册的新账号凭证（模块级：同一 spec 文件内步骤顺序执行共享；register 成功后 login 自动优先使用） */
let registeredCred: { account: string; password: string; mailbox?: string } | null = null;

/** 2026-11-04 ian：探索器（ai_explore.ts）用——本用例是否已注册新账号；有则 login 不再传探索账号，让位新注册凭证 */
export function hasRegisteredCred(): boolean {
  return registeredCred !== null;
}

/**
 * 页面上是否出现「邮箱验证码」输入框（登录/注册二次验证弹层）。
 * 2026-11-04 ian 踩坑：注册页「邀请码」输入框 maxlength=6，用 maxlength 兜底会误判 →
 *  必须靠 placeholder/name 语义判定，且排除 invitation/invite/coupon/promo 等业务码字段。
 */
const CODE_INPUT_SEL = [
  'input[placeholder*="验证码"]',
  'input[placeholder*="校验码"]',
  'input[placeholder*="verification code" i]',
  'input[name*="verify" i]',
  'input[name*="vcode" i]',
  'input[name*="captcha" i]',
  'input[id*="verify" i]',
].join(', ');

function notBusinessCode(sel: string): string {
  // 排除邀请码/优惠码/推广码（这些不是邮箱验证码）
  return `${sel}:not([name*="invi" i]):not([id*="invi" i]):not([placeholder*="邀请" i]):not([name*="coupon" i]):not([name*="promo" i])`;
}

export async function hasEmailCodeField(page: Page): Promise<boolean> {
  const sel = notBusinessCode(CODE_INPUT_SEL);
  const el = page.locator(sel);
  const n = await el.count().catch(() => 0);
  if (!n) return false;
  for (let i = 0; i < Math.min(n, 3); i++) {
    if (await el.nth(i).isVisible({ timeout: 1_500 }).catch(() => false)) return true;
  }
  return false;
}

/** 站点发信额度记账（按站点+日期），用于「当日额度已用尽」快速失败 */

const QUOTA_DIR = process.env.REGISTER_QUOTA_DIR || 'output/.register-quota';

function quotaFile(host: string, day = new Date().toISOString().slice(0, 10)): string {
  return `${QUOTA_DIR}/${host.replace(/[^a-z0-9.-]/gi, '_')}-${day}.json`;
}

/** 当日是否已被站点限流（有记账则快速失败，避免每个用例白等 3-5 分钟） */
export function registerQuotaExhausted(page: Page): { exhausted: boolean; reason?: string; until?: string; kind?: string } {
  try {
    if (process.env.REGISTER_QUOTA_IGNORE === '1') return { exhausted: false };
    const host = new URL(pcUrl('home')).hostname;
    const f = quotaFile(host);
    if (!existsSync(f)) return { exhausted: false };
    const j = JSON.parse(readFileSync(f, 'utf-8'));
    const until = Date.parse(String(j?.until || 0));
    if (!until || Date.now() > until) return { exhausted: false }; // 冷却已结束
    return { exhausted: true, reason: String(j?.msg || '站点注册/发信被限流'), until: new Date(until).toISOString(), kind: String(j?.kind || '') };
  } catch {
    return { exhausted: false };
  }
}

/**
 * 记录限流状态（kind: 'daily' = 按自然日 / 'cooldown' = 短时冷却 10 分钟）
 * 2026-11-04 ian：站点按 IP 限流注册与发信，连续跑多个注册用例会互相连坐，
 *   记账后同站后续用例直接快速失败，避免每个用例白等 3~5 分钟。
 */
function markQuotaExhausted(page: Page, msg: string, kind: 'daily' | 'cooldown' = 'cooldown'): void {
  try {
    const host = new URL(pcUrl('home')).hostname;
    mkdirSync(QUOTA_DIR, { recursive: true });
    const until = kind === 'daily' ? Date.now() + 12 * 3600_000 : Date.now() + 10 * 60_000;
    writeFileSync(
      quotaFile(host),
      JSON.stringify({ host, msg, kind, until: new Date(until).toISOString(), at: new Date().toISOString() }, null, 2),
    );
  } catch { /* 记账失败不影响主流程 */ }
}

/** 站点发信状态（/ems/send 响应）——用于识别「限流 429 操作过于频繁」 */
export type EmsState = { status?: number; code?: number; msg?: string; at: number };
export function watchEmsSend(page: Page): () => EmsState {
  let st: EmsState = { at: 0 };
  page.on('response', async (r) => {
    if (!/ems\/send/i.test(r.url())) return;
    const status = r.status();
    let code: number | undefined;
    let msg = '';
    try {
      const j: any = await r.json();
      code = Number(j?.code ?? 0);
      msg = String(j?.msg || '');
    } catch {
      // 限流时上游常直接返回 HTTP 429 无 JSON
      if (status === 429) msg = 'Too many requests';
    }
    if (status === 429) code = 429; // HTTP 429 一律按限流处理
    st = { status, code, msg, at: Date.now() };
  });
  return () => st;
}

/** 点击验证码弹层里的提交按钮（文本常为「登 录」/「确 定」，字间带空格 → 用 \s* 兼容） */
async function clickDialogSubmit(page: Page, logs: string[]): Promise<void> {
  const btn = page.locator('button:visible').filter({ hasText: /登\s*录|确\s*定|确\s*认|提\s*交|验\s*证|绑\s*定|完\s*成/ });
  const n = await btn.count().catch(() => 0);
  if (n) {
    await btn.nth(n - 1).click({ timeout: 5_000 }).catch(() => {});
    return;
  }
  logs.push('验证码弹层未找到提交按钮，改为回车提交');
  await page.locator('input[placeholder*="验证码"]').first().press('Enter').catch(() => {});
}

/**
 * 处理「邮箱验证码」弹层：临时邮箱自动收码 → 填码 → 提交（最多 2 轮）。
 * 2026-11-04 ian 实测 vtest2026：登录返回 code=100000「请完成邮箱验证」，弹层提示「验证码已发送至: xxx」，
 * 验证码为 4 位、写在邮件主题（「登录验证码：3691」）。站点测试账号无邮箱 → 明确报错。
 */
export async function handleEmailCodeModal(
  page: Page,
  mailbox: string,
  logs: string[],
  timeoutMs = 150_000,
  ems?: () => EmsState,
): Promise<void> {
  if (!(await hasEmailCodeField(page))) return;
  const body = await page.evaluate('document.body.innerText');
  if (!mailbox) {
    throw new Error(
      `站点要求邮箱验证码（提示「${(body.match(/验证码[^\n]{0,40}/) || ['验证码'])[0].trim()}」），` +
        `但当前账号没有可收信邮箱（站点测试账号无法收码）；请改用「注册新账号」类用例（自动申请临时邮箱收码）`,
    );
  }
  const tipMail = (body.match(/验证码已发送至[:：]\s*([^\s，,。；;]+@[^\s，,。；;]+)/) || [])[1];
  if (tipMail && tipMail !== mailbox) {
    logs.push(`注意：页面提示验证码发往 ${tipMail}，与用例邮箱 ${mailbox} 不一致，仍按用例邮箱取码`);
  }
  const codeInput = page.locator(notBusinessCode(CODE_INPUT_SEL)).first();
  const sendBtn = page.locator('button:visible').filter({ hasText: /发送验证码|获取验证码|重新获取|重新发送|send\s*code/i });
  const deadline = Date.now() + timeoutMs;

  for (let attempt = 1; attempt <= 3; attempt++) {
    // 站点发信限流守卫：/ems/send 返回 429「操作过于频繁」时根本没发信，硬等只会白等
    const st = ems?.();
    if (st?.code === 429) {
      if (/tomorrow|明天|daily|今日/i.test(st.msg || '')) {
        markQuotaExhausted(page, st.msg || '', 'daily');
        throw new Error(
          `站点当日发信额度已用尽（${st.msg}）：该限流按 IP+自然日计算，本机今天已注册过多测试账号，` +
            `额度明日恢复；已记入 output/.register-quota/ 供后续用例快速失败，无需重试`,
        );
      }
      const waitMs = attempt === 1 ? 45_000 : 30_000;
      logs.push(`站点发信限流（${st.msg || '429 操作过于频繁'}）→ 等待 ${Math.round(waitMs / 1000)}s 后重试发码`);
      await page.waitForTimeout(waitMs);
    }
    if (attempt > 1 && (await sendBtn.count().catch(() => 0))) {
      logs.push(`第 ${attempt} 轮：点击「发送验证码」重新发码`);
      await sendBtn.first().click({ timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(1_500);
    }
    const before = new Set((await listMails(mailbox)).map((m) => m.id));
    let code = '';
    try {
      // 只认本轮的「新到」邮件：旧的验证码可能已失效，回退复用只会浪费一轮
      const r = await waitForCode(mailbox, {
        timeoutMs: Math.max(25_000, Math.min(70_000, deadline - Date.now())),
        ignoreIds: before,
        logs,
        onTick: async (i) => {
          // 站点有时不自动发码（频控）→ 首轮尽早主动点一次「发送验证码」（按钮倒计时中则自动无效）
          const hasSend = await sendBtn.count().catch(() => 0);
          if (!hasSend) return;
          // 2026-11-04 ian：站点按 IP+自然日限流发信，别一上来就补发（会白耗额度）——
          // 页面若已自动发码，40s 内必然到达；只有 40s 仍无新邮件才补点一次。
          if (attempt === 1 && i === 10) {
            const enabled = await sendBtn.first().isEnabled().catch(() => false);
            if (enabled) {
              logs.push('等待 40s 未见新邮件，点击「发送验证码」补发一次');
              await sendBtn.first().click({ timeout: 5_000 }).catch(() => {});
            }
          }
        },
      });
      code = r.code;
    } catch (e: any) {
      logs.push(`第 ${attempt} 轮取码失败：${String(e?.message || e).slice(0, 120)}`);
      continue;
    }
    await codeInput.fill(code);
    await page.waitForTimeout(400);
    await clickDialogSubmit(page, logs);
    await page.waitForTimeout(7_000);
    const still = await page.evaluate('document.body.innerText');
    if (!/验证码/.test(still)) {
      logs.push(`邮箱验证码 ${code} 校验通过（临时邮箱 ${mailbox} 自动收码，第 ${attempt} 轮）`);
      return;
    }
    logs.push(`验证码 ${code} 未被站点接受（弹层仍在），进入第 ${attempt + 1} 轮`);
  }
  const stFinal = ems?.();
  throw new Error(
    `邮箱验证码校验失败（临时邮箱 ${mailbox}）：3 轮取码均未被站点接受` +
      (stFinal?.code === 429
        ? `；站点发信接口返回 429「${stFinal.msg}」——短时间内重复注册触发站点限流，请降低注册频率或稍后重试`
        : ''),
  );
}

/**
 * 注册新账号并登录（2026-11-04 ian：「注册新账号并登录」原语）。
 *
 * 2026-11-04 ian 重写：注册邮箱改用 **临时邮箱（nimail 免费 API）**，使「注册/登录需邮箱验证码」的站点可自动收码，
 * 不再用随机 @qq.com 假邮箱（收不到码 → 注册后无法登录 → 后续步骤被误判）。
 * 流程：申请临时邮箱 → 填注册表（email/password/confirm/同意条款，若有验证码字段则取码）→ 提交 →
 *   站点若不自动登录则用新账号登录（遇邮箱验证码自动收码）→ 断言登录态。
 * 环境变量：TEMPMAIL_ENABLED=0 关闭临时邮箱（回退随机 @qq.com）；TEMPMAIL_DOMAIN 覆盖邮箱域名。
 */
export async function register(page: Page, logs: string[]): Promise<{ account: string; password: string; mailbox?: string }> {
  const ts = Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
  let account = `aitest_${ts}@qq.com`;
  let mailbox = '';
  // 站点密码规则（实测 2026-11-04）：6-16 位，须含大小写字母和数字 —— 「Aa1!」前缀 + 时间戳共 ~14 位，合规
  const password = 'Aa1!' + Date.now().toString(36).slice(-6) + 'Xz';

  await page.goto(pcUrl('register'), { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(3_000);
  await dismissOverlays(page, logs);

  // ---- 技能包 + 邮箱验证码预判（2026-11-04 ian）----
  const quota = registerQuotaExhausted(page);
  if (quota.exhausted) {
    throw new Error(
      `站点注册被限流（${quota.reason}，${quota.kind === 'daily' ? '按自然日' : '短时冷却'}）` +
        `→ 预计 ${quota.until} 后恢复；同站其他注册用例已跳过，避免连坐等待。` +
        `如需强行重试，设置 REGISTER_QUOTA_IGNORE=1 或删除 output/.register-quota/ 下对应文件`,
    );
  }
  const packs = activeSkillPacks();
  if (packs.length) {
    logs.push(`生效技能包：${packs.map((p) => `${p.code}${p.version ? `@v${p.version}` : ''}`).join('、')}`);
  }
  const cfg = await probeEmailCaptchaConfig(page);
  const tempOn = process.env.TEMPMAIL_ENABLED !== '0';
  if (cfg) {
    logs.push(
      `站点验证码配置：注册${cfg.register ? '需要' : '不需要'}邮箱验证码、登录${cfg.login ? '需要' : '不需要'}、渠道=${cfg.channel}` +
        `（user_register_captcha=${cfg.raw.user_register_captcha} / user_login_captcha=${cfg.raw.user_login_captcha}）`,
    );
  } else {
    logs.push('站点验证码配置接口不可读（或非 OneBuy 系站点），改由页面/提交后探测兜底');
  }
  if (tempOn) {
    try {
      if (cfg && !cfg.register && !cfg.login) {
        // 注册/登录都不要验证码：用临时邮箱地址注册但不申请收信窗口（省 nimail 共享额度）
        account = newMailboxAddress();
        logs.push(`站点无需邮箱验证码 → 直接注册，地址 ${account}（不占用临时邮箱收信额度）`);
      } else {
        const box = await applyMailbox();
        account = box.address;
        mailbox = box.address;
        logs.push(
          cfg?.register
            ? `站点要求注册邮箱验证码 → 技能包 temp-mail-verification-code 生效，已申请临时邮箱 ${account}（10 分钟有效）`
            : `站点注册/登录可能要求邮箱验证码 → 已申请临时邮箱 ${account} 备用（10 分钟有效）`,
        );
      }
    } catch (e: any) {
      logs.push(`临时邮箱申请失败，回退随机邮箱 ${account}：${String(e?.message || e).slice(0, 100)}`);
    }
  }

  await page.locator('input[name="email"]').fill(account);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('input[name="confirm-password"]').fill(password);
  const agree = page.locator('input[name="agree-terms"]');
  if (await agree.count()) await agree.first().check({ force: true }).catch(() => {});

  // 少数站点在注册表单内就要邮箱验证码（先点「获取验证码」再取码）
  if (await hasEmailCodeField(page)) {
    if (!mailbox && /@nimail\.cn$/i.test(account)) {
      mailbox = await ensureMailbox(account, logs);
      logs.push('注册表单要求邮箱验证码 → 按需开通临时邮箱（技能包 temp-mail-verification-code）');
    }
    const getBtn = page.locator('button:visible').filter({ hasText: /获取验证码|发送验证码|获取邮箱验证码/ });
    if (await getBtn.count().catch(() => 0)) await getBtn.first().click().catch(() => {});
    await handleEmailCodeModal(page, mailbox, logs);
  }

  const ems = watchEmsSend(page); // 监听 /ems/send，识别站点发信限流 429
  await page.getByRole('button', { name: '注册', exact: true }).first().click();
  await page.waitForTimeout(8_000);

  // 2026-11-04 ian：部分站点把「邮箱验证码」放在提交之后（点注册 → 站点发码 → 填码再提交）。
  // 若停留在注册页且出现验证码字段，则走临时邮箱取码 → 再提交一次。
  if (/register/.test(page.url())) {
    const bodyAfter = await page.evaluate('document.body.innerText');
    // 限流（HTTP 429 / 操作过于频繁 / 明日恢复）：站点根本没发信，重试无意义 → 记账并快速失败
    const rl = bodyAfter.match(/(操作过于频繁[^\n]{0,20}|请求过于频繁[^\n]{0,20}|too many requests[^\n]{0,40}|请稍后再试[^\n]{0,10})/i);
    if (rl) {
      const msg = rl[0].trim();
      const daily = /tomorrow|明天|今日|daily/i.test(msg);
      markQuotaExhausted(page, msg, daily ? 'daily' : 'cooldown');
      throw new Error(
        daily
          ? `站点当日注册/发信额度已用尽（${msg}）：按 IP+自然日限流，需次日恢复或换出口 IP；已记账供后续用例快速失败`
          : `站点注册请求被限流（${msg}）：短时间内重复注册触发，请降低频率后重试`,
      );
    }
    if (/发送验证码失败|验证码发送失败|邮件发送失败/.test(bodyAfter)) {
      throw new Error(
        `站点注册要求邮箱验证，但站点自身发信服务报错（页面提示「${(bodyAfter.match(/(发送验证码失败|验证码发送失败|邮件发送失败)[^\n]{0,20}/) || [''])[0].trim()}」）` +
          `——实测其 /api/v1/ems/send(event=register) 返回 500，与临时邮箱无关（换普通邮箱同样失败），属站点故障，请站点方修复后重试`,
      );
    }
    if (await hasEmailCodeField(page)) {
      logs.push('注册提交后站点要求邮箱验证码（注册页内验证）→ 临时邮箱取码');
      const resend = page.locator('button:visible').filter({ hasText: /发送验证码|获取验证码|重新发送/ });
      if (await resend.count().catch(() => 0)) await resend.first().click().catch(() => {});
      await handleEmailCodeModal(page, mailbox, logs, 150_000, ems);
      await page.getByRole('button', { name: '注册', exact: true }).first().click().catch(() => {});
      await page.waitForTimeout(8_000);
    }
  }
  expect(!/register/.test(page.url()), `注册未成功，仍停留 ${page.url()}`).toBeTruthy();

  // 2026-11-04 ian：站点注册后行为有两类——
  //   A. 注册即自动登录（demo.example.com，跳 dashboard，页面出现新邮箱）
  //   B. 注册成功但跳登录页，需再登录（vtest2026.example.com；且登录强制邮箱验证码 → 临时邮箱自动收码）
  if (/login/.test(page.url())) {
    logs.push(`注册成功（站点跳转登录页，未自动登录）：${account}，使用新账号主动登录…`);
    await dismissOverlays(page, logs);
    await page.locator('input[name="email"]').fill(account);
    await page.locator('input[name="password"]').fill(password);
    const loginBtn = page.getByRole('button', { name: '登录', exact: true });
    if (await loginBtn.count()) await loginBtn.first().click();
    else await page.locator('button[type="submit"]').first().click();
    await page.waitForTimeout(6_000);

    if (await hasEmailCodeField(page)) {
      if (!mailbox && /@nimail\.cn$/i.test(account)) mailbox = await ensureMailbox(account, logs);
      logs.push('注册后站点要求邮箱验证 → 调用技能包 temp-mail-verification-code 自动收码');
      await handleEmailCodeModal(page, mailbox, logs, 150_000, ems);
    }
    if (/login/.test(page.url())) {
      const body = await page.evaluate('document.body.innerText');
      throw new Error(
        `新注册账号 ${account} 登录失败，仍停留 ${page.url()}` +
          (/验证码/.test(body) ? '（页面仍要求邮箱验证码，取码未通过）' : ''),
      );
    }
    registeredCred = { account, password, mailbox };
    logs.push(`已注册新账号并登录：${account}（站点无自动登录，已主动登录${mailbox ? '并完成邮箱验证码' : ''}；本用例后续登录将使用该新账号）`);
    return registeredCred;
  }

  const body = await page.evaluate('document.body.innerText');
  expect(body.toLowerCase(), '注册后页面未见新账号邮箱（未自动登录）').toContain(account.toLowerCase());
  registeredCred = { account, password, mailbox };
  logs.push(`已注册新账号并自动登录：${account}（本用例后续登录将使用该新账号，而非站点测试账号）`);
  return registeredCred;
}

/** 详情页渲染等待（CSP 禁 waitForFunction，轮询 evaluate）；新版渲染标志 =「立即购买」+ 价格（$¥￥₽） */
export async function waitDetailRendered(page: Page, timeoutMs = 30_000): Promise<boolean> {
  await dismissOverlays(page); // 详情页优惠券/活动弹窗守卫（不影响渲染判断，纯清理遮挡）
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await page.evaluate(`/立即购买/.test(document.body.innerText) && /[$¥￥₽€£]\\s*\\d|\\d[\\d,.]*\\s*[$¥￥₽]/.test(document.body.innerText)`);
    if (ok) return true;
    await page.waitForTimeout(1_000);
  }
  return false;
}

export async function searchPickAndOpen(page: Page, logs: string[], kw?: string): Promise<{ url: string; title: string; keyword: string }> {
  // 关键词优先级（2026-11-04 ian修正）：发起时勾选（LIB_KEYWORDS_MODE=picked）> 用例明确写的词（kw 参数）
  // > 测试用例库随机抽取 > 站点档案 > 默认。随机抽取不再覆盖用例里明确写的搜索词（如「苹果耳机」）。
  const libKws = libPool('KEYWORDS', []);
  const picked = process.env.LIB_KEYWORDS_MODE === 'picked';
  let kws: string[]; let src: string;
  if (picked && libKws.length) {
    kws = libKws; src = `3008测试用例库（发起时勾选）: ${libKws.join(' / ')}`;
  } else if (kw && kw.trim()) {
    kws = [kw.trim()]; src = `用例指定关键词: ${kw.trim()}`;
  } else if (libKws.length) {
    kws = libKws; src = `3008测试用例库（随机抽取）: ${libKws.join(' / ')}`;
  } else if (site.testData.searchKeywords && site.testData.searchKeywords.length) {
    kws = site.testData.searchKeywords; src = '站点档案';
  } else {
    kws = ['phone case']; src = '默认';
  }
  logs.push(`关键词来源: ${src}`);
  const keyword = kws[Math.floor(Math.random() * kws.length)];

  await dismissOverlays(page, logs); // 开屏广告守卫：首页弹窗遮挡搜索框是「卡首页」主因（JOB-000105）
  let input = page.locator('input[placeholder*="商品名称"]').nth(1);
  if (!(await input.isVisible({ timeout: 8_000 }).catch(() => false))) {
    // 兜底：goto 首页重试（登录后停留页偶发未挂载）
    await page.goto(pcUrl('home'), { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(5_000);
    await dismissOverlays(page, logs); // 重开首页后广告弹窗会再次出现，再关一轮
    input = page.locator('input[placeholder*="商品名称"]').nth(1);
    if (!(await input.isVisible({ timeout: 8_000 }).catch(() => false))) {
      input = page.locator('input[placeholder*="商品名称"]').first();
      expect(await input.isVisible(), '新版搜索框 input[placeholder*="商品名称"] 未渲染').toBeTruthy();
    }
  }

  await input.fill(keyword);
  await page.waitForTimeout(800);
  await input.press('Enter');
  await page.waitForTimeout(8_000);
  expect(/\/search|\/detail/.test(page.url()), `搜索后未进入结果页: ${page.url().slice(0, 90)}`).toBeTruthy();
  logs.push(`关键词「${keyword}」搜索完成 → ${page.url().split('?')[0].split('/').pop()}页`);

  let hrefs: string[] = [];
  for (let i = 0; i < 10 && hrefs.length === 0; i++) {
    hrefs = await page.evaluate(`(() => {
      const seen = new Set(), out = [];
      document.querySelectorAll('a[href*="/detail"]').forEach((a) => {
        const h = a.getAttribute('href');
        if (h && !seen.has(h)) { seen.add(h); out.push(h); }
      });
      return out;
    })()`);
    if (hrefs.length === 0) await page.waitForTimeout(2_000);
  }
  expect(hrefs.length, `搜索结果页未取到 /detail/ 商品链接（关键词「${keyword}」）`).toBeGreaterThan(0);
  logs.push(`搜索结果候选商品 ${hrefs.length} 个`);

  const candidates = hrefs.sort(() => Math.random() - 0.5).slice(0, 3);
  let lastErr = '';
  for (let i = 0; i < candidates.length; i++) {
    const href = candidates[i];
    const abs = href.startsWith('http') ? href : new URL(href, page.url()).toString();
    await page.goto(abs, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    if (await waitDetailRendered(page)) {
      await page.waitForTimeout(2_000);
      const title = await page.evaluate(`(() => {
        const h = document.querySelector('h1, [class*="title"] h1, [class*="pd__name"]');
        return h ? h.textContent.trim().slice(0, 40) : document.title.slice(0, 40);
      })()`);
      logs.push(`打开第 ${i + 1} 个候选商品详情渲染成功: ${title}`);
      return { url: page.url(), title, keyword };
    }
    lastErr = `候选 ${i + 1} 详情 30s 未渲染`;
    logs.push(`${lastErr}，换下一个商品`);
  }
  throw new Error(`3 个候选商品详情均未渲染：${lastErr}`);
}

/** CTA 行按钮：[立即购买(文本)][加购(图标)][收藏(图标)]——新版加购无文本，取「立即购买」的 nextElementSibling */
export async function clickAddCartButton(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    const buy = Array.from(document.querySelectorAll('button')).find((x) => /立即购买/.test((x.textContent || '').trim()));
    if (!buy) throw new Error('未找到「立即购买」按钮（无法定位 CTA 行）');
    const add = buy.nextElementSibling;
    if (!add || add.tagName !== 'BUTTON') throw new Error('「立即购买」旁未找到加购图标按钮');
    add.click();
  })()`);
}

/** 捕获加购接口响应（POST /api/*cart*），返回 {code,msg,url} */

/** 捕获加购接口响应（POST /api/*cart*），返回 {code,msg,url} */
export function captureCartApi(page: Page): Promise<{ code: number; msg: string; url: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('15s 内未捕获加购接口响应')), 15_000);
    const handler = (res: import('@playwright/test').Response) => {
      if (/\/api\/[^?]*cart/i.test(res.url()) && res.request().method() === 'POST') {
        clearTimeout(timer);
        page.off('response', handler);
        res.text().then((t) => {
          try { const j = JSON.parse(t); resolve({ code: j.code, msg: j.msg ?? '', url: res.url() }); }
          catch { reject(new Error(`加购接口响应解析失败: ${t.slice(0, 120)}`)); }
        }).catch(reject);
      }
    };
    page.on('response', handler);
  });
}

/** 页头购物车徽标数字（加购成功 UI 证据；无徽标返回 -1） */
export async function cartBadge(page: Page): Promise<number> {
  return page.evaluate(`(() => {
    const a = document.querySelector('a[href*="/dashboard/cart"], a[href*="cart"]');
    if (!a) return -1;
    const m = (a.textContent || '').match(/\\d+/);
    return m ? parseInt(m[0], 10) : -1;
  })()`);
}

/** 收集页面 toast 文本（辅助证据） */
export async function toastText(page: Page): Promise<string> {
  return page.evaluate(`(() => Array.from(document.querySelectorAll('[class*="message"], [class*="toast"], [class*="notice"], [role="alert"]'))
    .map((x) => (x.textContent || '').trim()).filter((t) => t && t.length < 80).join('；').slice(0, 200))()`);
}

/** 加购并双证据校验（S2/S3 共用）：接口 code=1 ｜ 徽标 +1 */
export async function addCartAndVerify(page: Page, logs: string[]): Promise<void> {
  const badgeBefore = await cartBadge(page);
  const p = captureCartApi(page);
  await dismissOverlays(page, logs); // CTA 上弹出的优惠券/咨询浮层守卫，防挡加购按钮
  await clickAddCartButton(page);
  await page.waitForTimeout(3_000);
  const toast = await toastText(page);
  if (toast) logs.push(`页面提示: ${toast}`);

  let apiOk = false;
  try {
    const r = await p;
    logs.push(`加购接口 ${r.url.split('?')[0].split('/').slice(-2).join('/')}: code=${r.code}${r.msg ? `（${r.msg}）` : ''}`);
    expect(r.code, `加购接口返回异常: code=${r.code} msg=${r.msg}`).toBe(1);
    apiOk = true;
  } catch (e: any) {
    // 补点一次（React handler 未绑完首次点击可能静默失效）
    logs.push(`首次点击未捕获加购接口（${String(e.message).slice(0, 60)}），补点一次`);
    const p2 = captureCartApi(page);
    await clickAddCartButton(page);
    await page.waitForTimeout(3_000);
    try {
      const r = await p2;
      logs.push(`加购接口(补点): code=${r.code}（${r.msg}）`);
      expect(r.code).toBe(1);
      apiOk = true;
    } catch (e2: any) {
      logs.push(`接口捕获失败: ${String(e2.message).slice(0, 100)}`);
    }
  }

  // UI 证据：徽标数字增加
  await page.waitForTimeout(2_000);
  const badgeAfter = await cartBadge(page);
  if (badgeBefore >= 0 && badgeAfter >= 0) {
    logs.push(`购物车徽标: ${badgeBefore} → ${badgeAfter}`);
    if (badgeAfter > badgeBefore) return; // UI 证据成立
  }
  expect(apiOk, '加购失败：接口未返回 code=1 且购物车徽标未增加').toBeTruthy();
}

/** 打开购物车页并断言渲染；nameKey 提供时断言包含刚加购商品（check_cart 动作） */
export async function openCartAndCheck(page: Page, logs: string[], nameKey?: string): Promise<void> {
  await page.goto(pcUrl('cart'), { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await dismissOverlays(page, logs); // 购物车页营销弹窗守卫
  let cartText = '';
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(2_000);
    cartText = await page.evaluate('document.body.innerText');
    if (/删除|全选|合计|去结算|批量/.test(cartText) && cartText.length > 100) break;
  }
  expect(/dashboard\/cart|购物车/.test(page.url() + cartText), `购物车页未渲染: ${page.url().slice(0, 80)}`).toBeTruthy();
  const flat = cartText.replace(/\s+/g, '');
  if (nameKey) {
    expect(flat.includes(nameKey), `购物车列表未见刚加购商品「${nameKey}」`).toBeTruthy();
    logs.push(`购物车列表包含刚加购商品「${nameKey}」✓`);
  } else {
    expect(flat.length > 150, '购物车列表为空').toBeTruthy();
    logs.push('购物车列表非空 ✓');
  }
}

/** 打开 PC 首页（open_home 动作） */
export async function openHome(page: Page, logs: string[]): Promise<void> {
  // 2026-11-04 ian：官网类站点首屏渲染偶发慢（flaky），goto+校验整体重试一次
  let ok = false;
  let lastErr: unknown = null;
  for (let i = 0; i < 2 && !ok; i++) {
    await page.goto(pcUrl('home'), { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(i === 0 ? 3_000 : 6_000);
    await dismissOverlays(page, logs); // 开屏广告守卫：打开首页→先关广告弹窗
    try {
      ok = (await page.evaluate('document.body.innerText')).length > 100;
    } catch (e) { lastErr = e; ok = false; }
  }
  if (!ok) throw new Error(`首页未渲染${lastErr ? `（${String(lastErr).slice(0, 120)}）` : ''}`);
  logs.push(`首页已打开: ${page.url().slice(0, 80)}`);
}

/** 页面包含指定文本断言（check_text 动作） */
export async function expectText(page: Page, logs: string[], text: string): Promise<void> {
  await page.waitForTimeout(2_000);
  const bt = await page.evaluate('document.body.innerText');
  expect(bt, `页面未出现「${text}」`).toContain(text);
  logs.push(`页面文本断言通过：「${text}」`);
}


// ============ 通用交互原语（2026-11-04 ian：AI 探索/用例库补齐表单填写与按文本点击）============
// 背景：onebound.cn 留言表单类意图原先无原语可映射（AI 只能输出 unknown），探索卡在 S3/S4。
// 语义：fillForm 按「定位=值」逐项填写并回读校验；clickByText 按可见文本点击按钮/链接。
// 两者的定位都支持 label 文本 / placeholder / name / CSS 选择器，覆盖绝大多数官网表单。

type FieldSpec = { by: string; value: string };

/** 解析 "姓名=测试用户; 13800138000; 留言=测试内容" → FieldSpec[]（无 = 的项视为自动填充占位） */
// ============ 通用网站原语二期（2026-11-04 ian：任意网站口语建测，非商城结构）============
// hover_text 悬停展开下拉导航；expect_url 断言跳转地址；scroll_to_text 触发懒加载后定位文本。
// 另：clickByText 增加按 href 语义兜底（官网导航「联系我们」href 常为 /contact）。

/** 中文导航词 → href 常见英文片段（clickByText 文本未命中时的 URL 语义兜底） */
const NAV_URL_ALIAS: Record<string, string[]> = {
  联系我们: ['contact', 'lianxi', 'contactus'], 联系: ['contact'],
  关于我们: ['about', 'guanyu', 'aboutus'], 关于: ['about'],
  首页: ['home', 'index'], 产品: ['product', 'goods'], 案例: ['case', 'anli'],
  新闻: ['news', 'xinwen'], 资讯: ['news', 'zixun', 'article'], 博客: ['blog'],
  服务: ['service', 'fuwu'], 解决方案: ['solution', 'fangan'], 下载: ['download'],
  登录: ['login', 'signin'], 注册: ['register', 'signup'], 招聘: ['job', 'careers', 'zhaopin'],
  搜索: ['search', 'so'],
};

export async function hoverText(page: Page, logs: string[], text: string): Promise<string> {
  const tx = String(text || '').trim();
  if (!tx) throw new Error('hover_text 缺少 text 参数（要悬停的菜单文本）');
  const cands = page.locator('a, button, [role="button"], li, span').filter({ hasText: tx }).first();
  const cnt = await cands.count().catch(() => 0);
  if (!cnt) throw new Error(`未找到可悬停的「${tx}」元素`);
  await cands.scrollIntoViewIfNeeded().catch(() => {});
  await cands.hover({ timeout: 8_000 });
  await page.waitForTimeout(1_200); // 下拉渲染
  const label = ((await cands.innerText().catch(() => '')) || '').trim().slice(0, 30);
  logs.push(`已悬停「${label || tx}」（下拉/浮层应已展开）`);
  return label || tx;
}

export async function expectUrl(page: Page, logs: string[], substr: string): Promise<void> {
  const want = String(substr || '').trim();
  if (!want) throw new Error('expect_url 缺少 substr 参数（URL 应包含的片段，多候选用 | 分隔）');
  await page.waitForTimeout(1_500);
  const url = page.url();
  const alts = want.split('|').map((x) => x.trim()).filter(Boolean);
  if (!alts.some((a) => url.includes(a))) {
    throw new Error(`当前 URL「${url.slice(0, 120)}」不含「${want}」`);
  }
  logs.push(`URL 断言通过：${url.slice(0, 100)} 含「${want}」`);
}

export async function scrollToText(page: Page, logs: string[], text: string): Promise<void> {
  const tx = String(text || '').trim();
  if (!tx) throw new Error('scroll_to_text 缺少 text 参数');
  const loc = page.locator(`text=${tx}`).first();
  let seen = await loc.isVisible().catch(() => false);
  if (!seen) {
    // 懒加载：逐屏滚动直至可见（最多 10 屏）
    for (let i = 0; i < 10 && !seen; i++) {
      await page.mouse.wheel(0, 900);
      await page.waitForTimeout(600);
      seen = await loc.isVisible().catch(() => false);
    }
  }
  if (!seen) throw new Error(`滚动后仍未见到文本「${tx}」`);
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  logs.push(`已滚动定位到「${tx}」`);
}

export function parseFieldSpec(spec: string): FieldSpec[] {
  return String(spec || '')
    .split(/[;；\n]/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((item) => {
      const idx = item.indexOf('=');
      if (idx <= 0) return { by: '', value: item };
      return { by: item.slice(0, idx).trim(), value: item.slice(idx + 1).trim() };
    });
}

/** 中文字段名 → 常见英文 name/placeholder 同义词（官网表单实测：名字/邮箱/手机号码/主题/留言） */
const FIELD_ALIAS: Record<string, string[]> = {
  姓名: ['name', '名字', 'username', '联系人'], 名字: ['name', '姓名'], 联系人: ['name', '联系人'],
  电话: ['phone', 'tel', 'mobile', '手机'], 手机: ['phone', 'tel', 'mobile', '手机号码'], 手机号: ['phone', 'tel', 'mobile', '手机号码'], 联系方式: ['phone', 'tel', 'mobile'],
  邮箱: ['email', 'mail', '邮箱地址'], 邮件: ['email', 'mail'], 邮件地址: ['email'],
  主题: ['subject', 'title', '标题'], 标题: ['subject', 'title'],
  留言: ['message', 'content', 'remark', '留言内容', '咨询'], 内容: ['message', 'content', 'remark', 'textarea'],
  公司: ['company', 'corp'], 地址: ['address', 'addr'],
};

/** 按 label/placeholder/name/CSS 定位表单控件（返回首个可见可编辑元素） */
async function resolveField(page: Page, by: string) {
  const sel = (by || '').trim();
  const cssLike = /^[#.[]|^[a-z]+\[|^[a-z]+#|\.|\[.*\]/.test(sel) && /[#.\[\]]/.test(sel);
  if (sel && cssLike) {
    const loc = page.locator(sel).first();
    if (await loc.count().catch(() => 0)) return loc;
  }
  const cores: any[] = [
    page.getByLabel(sel, { exact: false }),
    page.getByPlaceholder(sel, { exact: false }),
    page.locator(`input[name*="${sel}" i], textarea[name*="${sel}" i]`),
    page.locator(`input[id*="${sel}" i], textarea[id*="${sel}" i]`),
  ];
  for (const loc of cores) {
    const first = loc.first();
    if (await first.count().catch(() => 0)) {
      if (await first.isVisible().catch(() => false)) return first;
    }
  }
  return null;
}

/**
 * 填写表单。spec："定位=值; 定位=值"，定位留空则按顺序自动填充可见输入框。
 * 返回 { filled, failed, summary }，并断言至少填成功一个（除非表单本来就没有输入框）。
 */
export async function fillForm(page: Page, logs: string[], spec: string): Promise<{ filled: number; failed: string[]; summary: string[] }> {
  const items = parseFieldSpec(spec);
  const AUTO_VALUES = ['测试用户', '13800138000', 'test@example.com', '这是一条自动化测试留言，请忽略。'];
  const inputs = page.locator('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([type=file]):not([disabled]), textarea:not([disabled])');
  const n = await inputs.count().catch(() => 0);
  let autoIdx = 0;
  const filledList: string[] = [];
  const failed: string[] = [];

  const targets = items.length ? items : Array.from({ length: n }, () => ({ by: '', value: '' }));
  for (const it of targets) {
    let loc: any = null;
    if (it.by) {
    // ① 原样定位 ② 中英文同义词定位 ③ 仍未命中且是「留言/内容」类 → 取可见 textarea
    loc = await resolveField(page, it.by);
    if (!loc) {
      for (const alias of FIELD_ALIAS[it.by] || []) {
        loc = await resolveField(page, alias);
        if (loc) break;
      }
    }
    if (!loc && /留言|内容|反馈|咨询|remark|message/i.test(it.by)) {
      const ta = page.locator('textarea:not([disabled])').first();
      if (await ta.count().catch(() => 0)) loc = ta;
    }
  }
    if (!loc) {
      // 未命中定位 → 按顺序占用下一个空输入框
      while (autoIdx < n) {
        const cand = inputs.nth(autoIdx);
        autoIdx += 1;
        const val = await cand.inputValue().catch(() => 'x');
        if (!val) { loc = cand; break; }
      }
    } else {
      autoIdx += 1;
    }
    if (!loc) { failed.push(it.by || '(自动填充)'); continue; }
    const value = it.value || AUTO_VALUES[filledList.length % AUTO_VALUES.length];
    try {
      await loc.scrollIntoViewIfNeeded().catch(() => { });
      await loc.click({ timeout: 5000 }).catch(() => { });
      await loc.fill(value, { timeout: 8000 });
      const back = await loc.inputValue().catch(() => '');
      if (back !== value) throw new Error(`回读不一致「${back}」`);
      filledList.push(`${it.by || '字段' + (filledList.length + 1)}=${value.slice(0, 18)}`);
    } catch (e) {
      failed.push(`${it.by || '(自动)'}: ${String(e).slice(0, 60)}`);
    }
  }
  logs.push(`表单填写：成功 ${filledList.length} 项${failed.length ? `，失败 ${failed.length} 项（${failed.slice(0, 2).join(' | ')}）` : ''}`);
  if (filledList.length) logs.push(`已填：${filledList.join('；')}`);
  if (!filledList.length && n > 0) throw new Error(`表单填写全部失败（表单可见输入框 ${n} 个）：${failed.slice(0, 3).join(' | ')}`);
  if (n === 0) throw new Error('当前页面未发现可见输入框（不在表单页或表单为懒加载）：请给该步骤配置 path 参数先导航到表单页');
  return { filled: filledList.length, failed, summary: filledList };
}

/** 点击前布网：捕获 POST/PUT 等写请求的状态码 + 提交后表单是否被清空 */
export function watchSubmit(page: Page) {
  const hits: { url: string; status: number; method: string }[] = [];
  const onRes = (r: any) => {
    try {
      const m = r.request().method();
      if (m === 'GET' || m === 'OPTIONS' || m === 'HEAD') return;
      hits.push({ url: r.url(), status: r.status(), method: m });
    } catch { /* ignore */ }
  };
  page.on('response', onRes);
  return {
    async finish(pg: Page) {
      await pg.waitForTimeout(4000).catch(() => { });
      pg.off('response', onRes);
      const ok = hits.find((h) => h.status >= 200 && h.status < 400) || null;
      const cleared = await pg.evaluate(`(() => {
        const els = Array.from(document.querySelectorAll('form input:not([type=hidden]), form textarea')).filter(e => e.offsetParent !== null);
        return els.length > 0 && els.every(e => !(e.value || '').trim());
      })()`).catch(() => false);
      lastSubmit = ok ? { ok: true, status: ok.status, url: ok.method + ' ' + ok.url, formCleared: !!cleared, at: Date.now() }
                      : (hits.length ? { ok: false, status: hits[0].status, url: hits[0].method + ' ' + hits[0].url, formCleared: !!cleared, at: Date.now() } : null);
      return lastSubmit;
    },
  };
}

// 最近一次「按文本点击」触发的提交证据（静默提交站点：无 toast，只有 POST 200 + 表单清空）
let lastSubmit: { ok: boolean; status: number; url: string; formCleared: boolean; at: number } | null = null;
export function getLastSubmit() { return lastSubmit; }

/** 断言提交成功：优先用接口证据（2xx），兜底识别页面成功文案 */
export async function expectSubmitOk(page: Page, logs: string[]): Promise<void> {
  const ev = lastSubmit;
  if (ev && ev.ok) {
    logs.push(`提交证据：${ev.url.slice(0, 100)} → HTTP ${ev.status}${ev.formCleared ? '，表单已清空' : ''}`);
    return;
  }
  const body = await page.evaluate(`(document.body && document.body.innerText) || ''`).catch(() => '');
  const m = String(body).match(/提交成功|留言成功|发送成功|感谢[^。\n]{0,10}|已收到|success/i);
  if (m) {
    logs.push(`提交成功文案「${m[0].slice(0, 20)}」`);
    return;
  }
  throw new Error(`未捕获提交成功证据（最近提交：${ev ? `${ev.url.slice(0, 80)} HTTP ${ev.status}` : '无请求'}；页面也无成功文案）`);
}

/** 按可见文本点击：button/a/[role=button]/input[type=submit]，三级匹配（精确→包含→模糊） */
export async function clickByText(page: Page, logs: string[], text: string): Promise<string> {
  const tx = String(text || '').trim();
  if (!tx) throw new Error('click_text 缺少 text 参数（要点击的按钮文本）');
  const cands = page.locator('button, a, [role="button"], input[type="submit"], input[type="button"], .btn, [class*="btn"]');
  const total = await cands.count().catch(() => 0);
  const scored: { i: number; score: number; label: string }[] = [];
  for (let i = 0; i < total; i++) {
    const el = cands.nth(i);
    const label = ((await el.innerText().catch(() => '')) || (await el.getAttribute('value').catch(() => '')) || '').trim().replace(/\s+/g, '');
    if (!label || label.length > 40) continue;
    if (!(await el.isVisible().catch(() => false))) continue;
    if (label === tx.replace(/\s+/g, '')) scored.push({ i, score: 100, label });
    else if (label.includes(tx.replace(/\s+/g, ''))) scored.push({ i, score: 60, label });
    else if (tx.length >= 2 && tx.includes(label)) scored.push({ i, score: 30, label });
  }
  if (!scored.length) {
    // 2026-11-04 ian：href 语义兜底——官网导航「联系我们」文本可能藏在下拉/图标里，
    // 但链接 href 常见 contact/about/news 等英文片段；按同义词表命中即点击。
    const urlKeys = NAV_URL_ALIAS[tx.replace(/\s+/g, '')] || [];
    for (const key of urlKeys) {
      const link = page.locator(`a[href*="${key}"]:visible`).first();
      if (await link.count().catch(() => 0)) {
        const href = await link.getAttribute('href').catch(() => '');
        await link.scrollIntoViewIfNeeded().catch(() => {});
        const watchH = watchSubmit(page);
        await link.click({ timeout: 8_000 });
        await watchH.finish(page);
        logs.push(`按文本「${tx}」未命中 → 按 href 含「${key}」点击 ${href || '(空 href)'}`);
        return `${tx}(href:${key})`;
      }
    }
    // 兜底：表单内最后一个可见提交按钮（留言/联系类表单常见「提交/发送」文案差异）
    const submitBtn = page.locator('form button, form input[type="submit"], form [type="submit"]').last();
    if (await submitBtn.count().catch(() => 0)) {
      const label = ((await submitBtn.innerText().catch(() => '')) || '').trim();
      await submitBtn.scrollIntoViewIfNeeded().catch(() => { });
      const w2 = watchSubmit(page);
      await submitBtn.click({ timeout: 8000 });
      await w2.finish(page);
      logs.push(`按文本「${tx}」未命中 → 点击表单内提交按钮「${label || '(无文案)'}」`);
      return label || '(form submit)';
    }
    throw new Error(`未找到文本包含「${tx}」的可点击按钮/链接（共检查 ${total} 个候选）`);
  }
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  const el = cands.nth(best.i);
  await el.scrollIntoViewIfNeeded().catch(() => { });
  const watch = watchSubmit(page);
  await el.click({ timeout: 8000 });
  await watch.finish(page);
  logs.push(`点击「${best.label}」（匹配度 ${best.score}${scored.length > 1 ? `，候选 ${scored.length} 个取最优` : ''}）`);
  return best.label;
}
