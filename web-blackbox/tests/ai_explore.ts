/**
 * ai_explore.ts —— AI 口语建用例二期：计划探索验证器（ian 2026-11）
 *
 * 由平台 celery 任务（scenarios.tasks.run_ai_explore）调起：
 *   npx tsx tests/ai_explore.ts <plan.json 绝对路径>
 *
 * 职责：把 AI 规划的步骤计划在真实站点上按序实走一遍（确定性执行，不用 playwright test runner，
 * 逐步 try/catch 收集证据而非失败即停），逐步产出：
 *   { id, action, side, ok, url, error, note, shot, fix?, recipe? }
 *
 * 输出：<plan 同目录>/result.json + shots/<id>.png。平台侧读取 result.json 渲染探索报告，
 * 失败证据可再喂给 AI 重规划（replan）。
 *
 * 原语语义与 docflow.ts / doc_actions.parse_step 严格对齐：
 *   register / login / open_home / search / open_first_product / add_cart / check_cart / goto_path / check_text
 *   register（2026-11-04 ian）：随机邮箱真实注册并自动登录；其后 login 自动用新注册账号
 *   unknown → 启发式点击尝试（候选配方沉淀，供人工审核并入原语库）
 * WAP 步骤：动作库尚未适配（三期），直接标注跳过。
 */
import { chromium } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { pcUrl, site } from './helpers/site';
import { login, openHome, searchPickAndOpen, waitDetailRendered, addCartAndVerify,
         openCartAndCheck, expectText, exploreAccount, register, hasRegisteredCred,
         fillForm, clickByText, expectSubmitOk, hoverText, expectUrl, scrollToText } from './helpers/docflow';
import { wapLogin, wapOpenHome, wapOpenPath, wapExpectText } from './helpers/wapflow';
import { dismissOverlays } from './helpers/overlay';

const WAP_READY = new Set(['wap_login', 'wap_open_home', 'wap_goto_path', 'wap_check_text']);

type Step = { id: string; side?: string; action: string; params?: Record<string, string>; name?: string; expect?: string };
type Plan = { run_id: string; code?: string; site_code?: string; steps: Step[] };
type StepResult = {
  id: string; action: string; side: string; ok: boolean;
  name?: string; expect?: string; params?: Record<string, string>;
  url?: string; error?: string; note: string; shot?: string; ms: number;
  recipe?: { intent: string; clicked_text?: string; url_before?: string; url_after?: string; toast?: string };
};

const planPath = process.argv[2];
if (!planPath) { console.error('usage: tsx tests/ai_explore.ts <plan.json>'); process.exit(2); }
const plan: Plan = JSON.parse(readFileSync(planPath, 'utf-8'));
const OUT_DIR = dirname(planPath);
const SHOTS = join(OUT_DIR, 'shots');
mkdirSync(SHOTS, { recursive: true });

const STEP_TIMEOUT_MS = 150_000;   // 单步上限（docflow 内部 goto 45s/detail 30s，留足余量）
const TOTAL_BUDGET_MS = 18 * 60_000;
const t_start = Date.now();

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what} 超过 ${Math.round(ms / 1000)}s 未完成`)), ms)),
  ]);
}

async function bodyText(page: Page): Promise<string> {
  try { return await page.evaluate('document.body.innerText'); } catch { return ''; }
}

/** unknown 动作启发式：在当前页面找名称/预期里关键词命中的可点击元素尝试点击，记录前后 URL 与 toast */
async function heuristicClick(page: Page, st: Step, logs: string[]): Promise<StepResult['recipe']> {
  const kw = (st.name || '') + ' ' + (st.expect || '');
  const m = /[\u4e00-\u9fffA-Za-z]{2,12}/.exec(kw.replace(/验证|检查|点击|打开|进入|页面|成功|按钮/g, '')) ;
  const text = (st.params?.text || m?.[0] || '').trim();
  if (!text) return { intent: st.name || 'unknown' };
  const urlBefore = page.url();
  const loc = page.locator(`button:has-text("${text}"), a:has-text("${text}"), [role="button"]:has-text("${text}")`).first();
  if (!(await loc.count())) {
    logs.push(`未找到含「${text}」的可点击元素`);
    return { intent: st.name || 'unknown', clicked_text: '' };
  }
  const clicked = (await loc.textContent() || '').trim().slice(0, 30);
  await loc.click({ timeout: 10_000 }).catch((e) => { logs.push(`点击失败: ${String(e).slice(0, 120)}`); });
  await page.waitForTimeout(4_000);
  const urlAfter = page.url();
  let toast = '';
  try { toast = await page.evaluate(`(document.querySelector('.toast,.el-message,[class*="toast"],[class*="message"]')||{}).textContent||''`); } catch {}
  return { intent: st.name || 'unknown', clicked_text: clicked, url_before: urlBefore, url_after: urlAfter, toast: (toast || '').trim().slice(0, 80) };
}

(async () => {
  const results: StepResult[] = [];
  const logs: string[] = [];
  let page: Page | null = null;
  let browser: Browser | null = null;
  let picked: { url: string; title: string; keyword: string } | null = null;

  const finish = (code: number) => {
    const out = {
      run_id: plan.run_id, code: plan.code || '', site: site.id,
      finished_at: new Date().toISOString(), elapsed_s: Math.round((Date.now() - t_start) / 1000),
      ok_count: results.filter(r => r.ok).length, total: results.length,
      logs: logs.slice(-80), steps: results,
    };
    writeFileSync(join(OUT_DIR, 'result.json'), JSON.stringify(out, null, 2), 'utf-8');
    console.log(`[ai-explore] 完成: ${out.ok_count}/${out.total} ok → result.json`);
    process.exit(code);
  };

  try {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  } catch (e) {
    logs.push(`浏览器启动失败: ${String(e).slice(0, 200)}`);
    for (const st of plan.steps) results.push({ id: st.id, action: st.action, side: st.side || 'pc', ok: false, note: '浏览器启动失败，全部步骤未执行', ms: 0 });
    finish(1);
  }

  // WAP 视口懒创建（三期：WAP 步骤用手机尺寸页面；探索独立账号同 PC）
  let wapPage: Page | null = null;
  async function pageFor(side: string): Promise<Page> {
    if (side !== 'wap') return page!;
    if (!wapPage) wapPage = await browser!.newPage({ viewport: { width: 390, height: 844 } });
    return wapPage;
  }

  for (const st of plan.steps) {
    const t0 = Date.now();
    const side = (st.side || 'pc').toLowerCase();
    const r: StepResult = { id: st.id, action: st.action, side, ok: false,
                            name: st.name || '', expect: st.expect || '', params: st.params || {},
                            note: '', ms: 0 };
    const pg = await pageFor(side).catch(() => page!); // WAP 步骤用手机视口页（懒创建）
    try {
      if (side === 'wap' && !WAP_READY.has(st.action)) {
        r.note = 'WAP 端该动作尚未适配（三期仅 wap_login/wap_open_home/wap_goto_path/wap_check_text 可真实执行），跳过';
      } else if (Date.now() - t_start > TOTAL_BUDGET_MS) {
        r.note = '探索总时长超预算，本步未执行';
      } else {
        await withTimeout((async () => {
          if (side === 'wap') {
            // ---- WAP 原语（三期 2026-11，wapflow.ts 实测交互）----
            switch (st.action) {
              case 'wap_login':
                await wapLogin(pg, logs, exploreAccount());
                r.ok = true; r.note = 'WAP 登录成功'; r.url = pg.url();
                break;
              case 'wap_open_home':
                await wapOpenHome(pg, logs);
                r.ok = true; r.note = 'WAP 首页打开且渲染正常'; r.url = pg.url();
                break;
              case 'wap_goto_path': {
                const wp = st.params?.path || '';
                if (!wp) throw new Error('path 参数缺失（/ 开头路径或档案 key 如 cart）');
                await wapOpenPath(pg, logs, wp);
                r.ok = true; r.note = `WAP 已打开 ${wp}`; r.url = pg.url();
                break;
              }
              case 'wap_check_text': {
                const tx = st.params?.text || '';
                if (!tx) throw new Error('text 参数缺失');
                await wapExpectText(pg, logs, tx);
                r.ok = true; r.note = `WAP 页面出现文本「${tx}」`; r.url = pg.url();
                break;
              }
            }
            return;
          }
          switch (st.action) {
            case 'register': {
              // 2026-11-04 ian：注册原语（随机邮箱真实注册即自动登录）；成功后本探索后续 login 自动用新账号
              const cred = await register(page!, logs);
              r.ok = true; r.note = `已注册新账号并自动登录：${cred.account}（后续登录将使用该账号）`; r.url = page!.url();
              break;
            }
            case 'login': {
              // 本用例注册过新账号 → 不传探索账号，docflow.login 自动优先新注册凭证
              const ea = hasRegisteredCred() ? undefined : exploreAccount();
              await login(page!, logs, ea);
              r.ok = true; r.note = hasRegisteredCred() ? '登录成功（本用例注册的新账号）' : '登录成功'; r.url = page!.url();
              break;
            }
            case 'open_home':
              await openHome(page!, logs);
              r.ok = true; r.note = '首页打开且关键元素渲染'; r.url = page!.url();
              break;
            case 'search': {
              const kw = st.params?.keyword || undefined;
              picked = await searchPickAndOpen(page!, logs, kw);
              r.ok = true; r.note = `搜索「${picked.keyword}」并进入结果页（探索顺带打开了首个商品）`;
              r.url = page!.url();
              break;
            }
            case 'open_first_product': {
              // 前置 search 已在探索流中打开详情：验证渲染即可；无 picked 时自走前置链
              if (!picked) {
                await openHome(page!, logs);
                picked = await searchPickAndOpen(page!, logs, undefined);
                logs.push('open_first_product 无前置搜索产物，自动补 首页+随机搜索');
              }
              const okRender = await waitDetailRendered(page!);
              if (!okRender) throw new Error('详情页 30s 未渲染出「立即购买」+价格（改版或加载失败）');
              r.ok = true; r.note = `详情页渲染正常：${(picked!.title || '').slice(0, 24)}`; r.url = page!.url();
              break;
            }
            case 'add_cart':
              if (!picked) throw new Error('前置搜索/商品未就绪（上一步 search/open_first_product 未成功）');
              await addCartAndVerify(page!, logs);
              r.ok = true; r.note = '加购成功（接口 code=1 + 徽标变化 双证据）'; r.url = page!.url();
              break;
            case 'check_cart': {
              const key = (picked?.title || '').replace(/\s+/g, '').slice(0, 8);
              await openCartAndCheck(page!, logs, key || undefined);
              r.ok = true; r.note = `购物车页含刚加购商品${key ? `「${key}」` : ''}`; r.url = page!.url();
              break;
            }
            case 'goto_path': {
              const p = st.params?.path || '';
              if (!/^\/[\w\-./]*$/.test(p)) throw new Error(`path 参数缺失或非法：${p}`);
              const resp = await page!.goto(new URL(p, pcUrl('home')).toString(), { waitUntil: 'domcontentloaded', timeout: 45_000 });
              await page!.waitForTimeout(3_000);
              await dismissOverlays(page!, logs);
              r.url = page!.url();
              const status = resp ? resp.status() : 0;
              // 404 判定（2026-11 收紧）：仅看 title 与错误提示块，避免正文表格数据撞「404」字样误报
              const title = await page!.title();
              const looksTitle = /404|not\s*found|页面不存在|找不到页面/i.test(title || '');
              const block = await page!.evaluate(`(() => { const el = document.querySelector('h1,h2,[class*="error"],[class*="not-found"],[class*="404"]'); return el ? el.innerText.slice(0,120) : ''; })()`);
              const looksBlock = !!block && /页面不存在|404|not\s*found|找不到页面/i.test(block) && block.length < 120;
              if (status >= 400 || looksTitle || looksBlock) {
                const why = status >= 400 ? `HTTP ${status}` : (looksTitle ? `title 含 404 语义「${title.slice(0, 40)}」` : `错误提示块「${block.slice(0, 60)}」`);
                throw new Error(`路径不可达（${why}）→ ${r.url}`);
              }
              r.ok = true; r.note = `路径可达（HTTP ${status}）`;
              break;
            }
            case 'check_text': {
              const tx = st.params?.text || '';
              if (!tx) throw new Error('text 参数缺失');
              await expectText(page!, logs, tx);
              r.ok = true; r.note = `页面出现文本「${tx}」`; r.url = page!.url();
              break;
            }
            case 'fill_form': {
              if (st.params?.path) {
                await page!.goto(new URL(String(st.params.path), pcUrl('home')).toString(), { waitUntil: 'domcontentloaded', timeout: 45_000 });
                await page!.waitForTimeout(2_500);
                logs.push(`fill_form 前置导航 → ${st.params.path}`);
              }
              // 2026-11-04 ian：表单填写原语（留言/联系/反馈表单），fields 支持「定位=值; 定位=值」
              const spec = String(st.params?.fields || st.params?.text || '');
              const out = await fillForm(page!, logs, spec);
              r.ok = true;
              r.note = `表单已填写 ${out.filled} 项${out.failed.length ? `（${out.failed.length} 项未定位）` : ''}：${out.summary.slice(0, 4).join('；')}`;
              r.url = page!.url();
              break;
            }
            case 'expect_submit_ok': {
              await expectSubmitOk(page!, logs);
              r.ok = true; r.note = '提交成功（接口 2xx 或成功文案证据）'; r.url = page!.url();
              break;
            }
            case 'click_text': {
              if (st.params?.path) {
                await page!.goto(new URL(String(st.params.path), pcUrl('home')).toString(), { waitUntil: 'domcontentloaded', timeout: 45_000 });
                await page!.waitForTimeout(2_500);
                logs.push(`click_text 前置导航 → ${st.params.path}`);
              }
              // 2026-11-04 ian：按可见文本点击（提交/发送留言等）
              const tx = String(st.params?.text || '');
              const label = await clickByText(page!, logs, tx);
              await page!.waitForTimeout(3_000);
              r.ok = true; r.note = `已点击「${label}」`; r.url = page!.url();
              break;
            }
            case 'hover_text': {
              const tx = String(st.params?.text || '');
              const label = await hoverText(page!, logs, tx);
              r.ok = true; r.note = `已悬停「${label}」并展开下拉`; r.url = page!.url();
              break;
            }
            case 'expect_url': {
              await expectUrl(page!, logs, String(st.params?.substr || st.params?.text || ''));
              r.ok = true; r.note = 'URL 断言通过'; r.url = page!.url();
              break;
            }
            case 'scroll_to_text': {
              await scrollToText(page!, logs, String(st.params?.text || ''));
              r.ok = true; r.note = '滚动定位成功（懒加载已触发）'; r.url = page!.url();
              break;
            }
            case 'unknown': {
              r.recipe = await heuristicClick(page!, st, logs);
              const rc = r.recipe;
              if (rc?.clicked_text && rc.url_after !== rc.url_before) {
                r.ok = true; r.note = `启发式点击「${rc.clicked_text}」引发页面跳转（候选配方，需人工确认语义）`;
              } else if (rc?.clicked_text) {
                r.ok = false; r.note = `点击「${rc.clicked_text}」后无页面变化（候选配方证据已记录）`;
              } else {
                r.note = `未找到可尝试的元素（意图：${st.name}）`;
              }
              r.url = page!.url();
              break;
            }
            default:
              r.note = `未知动作 ${st.action}`;
          }
        })(), STEP_TIMEOUT_MS, `步骤 ${st.id}(${st.action})`);
      }
    } catch (e) {
      r.ok = false;
      r.error = String(e?.message || e).slice(0, 300).replace(/\n/g, ' ');
      r.url = safeUrl(page);
      // 2026-11-04 ian：失败页可见链接摘要（≤30 条）——喂给 AI 修正器做「页面感知 replan」：
      // 模型能看到页面里实际有哪些入口（文本→路径），据此改选动作/参数，而非凭空猜。
      try {
        const links = await page!.evaluate(`(() => {
          const out = [];
          for (const a of document.querySelectorAll('a')) {
            const t = (a.innerText || '').trim().replace(/\\s+/g, '');
            const h = a.getAttribute('href') || '';
            if (t && t.length <= 16 && h && h !== '#' && out.length < 30 && !out.some(x => x[0] === t && x[1] === h)) out.push([t, h.slice(0, 60)]);
          }
          return out;
        })()`);
        if (Array.isArray(links) && links.length) {
          r.page_links = links.map((x: any) => `${x[0]}→${x[1]}`).join('；');
        }
      } catch { /* 页面已销毁等场景忽略 */ }
    }
    r.ms = Date.now() - t0;
    try {
      r.shot = `${st.id}.png`;
      await pg.screenshot({ path: join(SHOTS, r.shot), timeout: 8_000 });
    } catch { r.shot = undefined; }
    console.log(`[ai-explore] ${st.id} ${r.ok ? 'ok' : 'FAIL'} ${st.action} (${r.ms}ms) ${r.error || r.note}`);
    results.push(r);
  }
  try { await browser!.close(); } catch {}
  finish(0);
})().catch((e) => { console.error('[ai-explore] fatal:', e); process.exit(1); });

function safeUrl(page: Page | null): string | undefined {
  try { return page ? page.url() : undefined; } catch { return undefined; }
}
