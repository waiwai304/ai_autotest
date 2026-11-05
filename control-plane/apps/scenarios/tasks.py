# -*- coding: utf-8 -*-
"""测试用例 spec 生成任务（2026-09-26 ian：cases 页面新增用例入口；2026-09-27 二期：可执行+有截图）
在 browser-worker 执行（挂载 RUNNER_ROOT=web-blackbox），按用例 doc_steps 生成
Playwright spec：每步真实执行「打开对应端首页 + 截图留证 + annotate 标注动作/预期」，
报告即有每步截图与反馈；补全动作/断言后即完整测试。文件名 tests/doc-<code>.spec.ts。
注意：模板含 TS 大括号，禁用 f-string 拼接（会被当表达式求值），统一用 __PLACEHOLDER__ 替换。
"""
import json
import logging
from datetime import datetime
from pathlib import Path

from celery import shared_task
from django.conf import settings

log = logging.getLogger(__name__)

HEAD_TMPL = r"""/**
 * ⚙️ 自动生成用例（OneBuy 测试平台 /scenarios/cases/create/）
 * 用例：__CODE__ · __NAME__
 * 说明：__DESC__
 * 端：__ENDS__ ｜ 需要登录：__AUTH__ ｜ 含写操作：__MUT__
 * 生成时间：__GEN_AT__
 *
 * 当前为「骨架执行」模式（2026-09-30 升级）：
 *   - 每步执行「打开对应端首页 + 截图留证 + API 捕获（wireCapture）+ worker 分片步骤落盘」，
 *     报告有图、有反馈、有每步捕获 API；
 *   - 步骤末尾 test.skip 标记「骨架·待实现」→ 平台判定不计通过（防假阳性）；
 *   - 补全步骤：在 TODO 处写入真实操作与 expect 断言，删除 test.skip 行即真实测试
 *     （参考 tests/doc-favorite-check.spec.ts 的 recordStep/断言写法）。
 */
import { test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'fs';
import type { Page } from '@playwright/test';
import { pcHome, wapHome } from './helpers/site';

// ---------- 步骤记录 + 请求捕获脚手架（对齐 doc-favorite-check.spec.ts） ----------
const RUN_DIR = process.env.FULLCHAIN_RUN_DIR || 'DOC___CODE__';
const SPEC_FILE = 'tests/doc-__CODE__.spec.ts';
const SHOTS = `output/html-report/${RUN_DIR}/screenshots`;
const DATA = `output/${RUN_DIR}`;
mkdirSync(SHOTS, { recursive: true });
mkdirSync(DATA, { recursive: true });

type CapturedReq = { side: string; method: string; url: string; status: number; curl: string };
type StepRec = { id: string; name: string; side: string; status: 'ok' | 'fail' | 'warn'; logs: string[]; shot: string; startedAt: string; ms: number; curls?: CapturedReq[] };
const steps: StepRec[] = [];
const captured: CapturedReq[] = [];
const recent: CapturedReq[] = [];

function toCurl(req: { method(): string; url(): string; headers(): Record<string, string>; postData(): string | null }): string {
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

function wireCapture(page: Page) {
  page.on('response', (r) => {
    const req = r.request();
    const url = req.url();
    if (!url.includes('/api/')) return;
    if (/\.(png|jpg|jpeg|css|js|woff2?|gif|svg|ico)(\?|$)/.test(url)) return;
    try {
      recent.push({ side: '前台', method: req.method(), url, status: r.status(), curl: toCurl(req) });
      if (recent.length > 400) recent.shift();
    } catch { /* 忽略 */ }
  });
}

async function recordStep(id: string, name: string, page: Page, status: 'ok' | 'fail' | 'warn', logs: string[], t0: number): Promise<void> {
  const shot = `doc-${id}.png`;
  await page.screenshot({ path: `${SHOTS}/${shot}` }).catch(() => {});
  const stepCurls = recent.splice(0, recent.length);
  captured.push(...stepCurls);
  const idx = steps.findIndex((s) => s.id === id);
  if (idx >= 0) steps.splice(idx, 1);
  steps.push({ id, name, side: '前台', status, logs, shot, startedAt: new Date(t0).toISOString(), ms: Date.now() - t0, curls: stepCurls });
  // worker 分片写入（并行安全，gen-platform-report.py 自动合并）
  writeFileSync(`${DATA}/fullchain-result.w${test.info().workerIndex}.json`, JSON.stringify({
    runTag: RUN_DIR, time: new Date().toISOString(), spec: SPEC_FILE,
    passed: steps.filter((s) => s.status === 'ok').length, total: steps.length,
    steps, capturedCount: captured.length,
  }, null, 2));
  console.log(`[${id}] ${status} ${name} (${Date.now() - t0}ms)`);
}

test.describe(__CODE_JS__, () => {
"""

STEP_TMPL = r"""
  test(__TITLE__, async ({ page }) => {
    // 动作：__SNAME__
    // 预期：__EXPECT__
    wireCapture(page);
    const t0 = Date.now();
    const logs: string[] = ['[骨架·待实现] 动作：__SNAME__ ｜ 预期：__EXPECT__'];
    // 骨架执行：打开__TARGET_DESC__首页截图留证（真实动作补全后替换下方 goto 占位块）
    await page.goto(__TARGET__, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(3_000);
    // TODO(实现本步骤): 写入真实操作与 expect 断言（参考 tests/doc-favorite-check.spec.ts），
    // 并把 recordStep 的 'warn' 改为按实际执行结果传 'ok' | 'fail'，随后删除下方 test.skip 行
    await recordStep(__SID__, __SNAME__, page, 'warn', logs, t0);
    test.skip(true, '骨架·动作待实现：本步骤仅首页可达性+截图+API 捕获留证，不计通过');
  });"""


# ==================== 真实执行模式（2026-10-05 ian：口语化用例自动扩充为可直接执行的测试） ====================
# doc_actions.py 把口语步骤映射为动作原语，本模板渲染为调用 tests/helpers/docflow.ts 的真实 Playwright test。
# 未识别/WAP/未适配动作的步骤自动降级为上方骨架占位（warn + skip，防假绿）。
REAL_HEAD_TMPL = r"""/**
 * ⚙️ 自动生成用例·真实执行版（OneBuy 测试平台 /scenarios/cases/create/ → doc_actions.py 自动扩充）
 * 用例：__CODE__ · __NAME__
 * 说明：__DESC__
 * 端：__ENDS__ ｜ 需要登录：__AUTH__ ｜ 含写操作：__MUT__
 * 生成时间：__GEN_AT__ ｜ 实现模式：auto-v1（口语步骤 → 动作原语 → helpers/docflow.ts 真实执行）
 *
 * 本文件由程序根据口语化步骤自动编写，可直接执行：
 *   - 动作库：tests/helpers/docflow.ts（站点改版只需更新该文件，所有自动用例同步生效）
 *   - 每步自包含前置链（登录→搜索→打开商品等）；串行执行（serial）——前序失败后续 skip，
 *     不在缺失前置数据的情况下硬跑（尤其「注册新账号」链：注册失败不再回退站点测试账号）
 *   - 每步真实断言 + API 捕获（curl）+ 截图留证，worker 分片写入报告自动合并
 *
 * 步骤实现清单：
__ACTION_SUMMARY__
 */
import { test, expect } from '@playwright/test';
import { pcHome, wapHome, pcUrl } from './helpers/site';
import { makeRecorder, login, register, searchPickAndOpen, waitDetailRendered, addCartAndVerify, openCartAndCheck, openHome, expectText, fillForm, clickByText, expectSubmitOk, hoverText, expectUrl, scrollToText } from './helpers/docflow';
import { wapLogin, wapOpenHome, wapOpenPath, wapExpectText } from './helpers/wapflow';

const { wireCapture, recordStep } = makeRecorder('tests/doc-__CODE__.spec.ts', 'doc');

// 2026-11-04 ian：链式用例串行执行——前序步骤失败（如 S1 注册失败）时后续步骤 skip，
// 不再各自独立硬跑并静默回退站点测试账号（避免语义假通过，报告如实显示 skip 原因）。
test.describe.configure({ mode: 'serial' });

test.describe(__CODE_JS__, () => {
"""

STEP_REAL_TMPL = r"""
  test(__TITLE__, async ({ page }) => {
    test.setTimeout(6 * 60_000);
    // 口语步骤：__SNAME__
    // 预期：__EXPECT__
    // 自动实现：__NOTE__ ｜ 前置链：__PREREQ__
    wireCapture(page, '前台');
    const t0 = Date.now();
    const logs: string[] = [];
    let status: 'ok' | 'fail' = 'ok';
    try {
__BODY__
    } catch (e: any) {
      status = 'fail';
      logs.push(`异常: ${String(e.message || e).slice(0, 300)}`);
    }
    await recordStep(__SID__, __SNAME__, page, status, logs, t0);
    expect(status, `__SID_RAW__ 失败: ${logs.join(' | ')}`).toBe('ok');
  });"""


def _ts_str(s: str) -> str:
    """Python str → 安全 TS 字符串字面量（JSON 双引号串可直接用作 TS 字面量）"""
    return json.dumps(str(s or ''), ensure_ascii=False)


def _spec_content_real(code: str, name: str, desc: str, ends: list, requires_auth: bool,
                       mutating: bool, steps: list, settings: list) -> tuple[str, list]:
    """真实执行模式：doc_actions 解析口语步骤 → 动作原语 → 真实 Playwright test。
    未识别步骤内嵌骨架占位块（warn+skip）。返回 (spec 内容, 步骤实现清单)。
    """
    from . import doc_actions
    side_hint = 'PC' if 'pc' in ends else 'WAP'
    # 用例级关键词：第一个提取到关键词的步骤（通常是 S1 搜索步），全用例共享
    case_kw = ''
    for s in (steps or []):
        p = doc_actions.parse_step(s, requires_auth, settings, side_hint)
        if p.get('kw'):
            case_kw = p['kw']
            break
    body, summary = [], []
    # 2026-11-04 ian：首个显式登录步骤之前的步骤保持未登录语义（前置链不自动补登录）；
    # register 也算登录边界（注册即自动登录），其后步骤的 login 前置由 docflow 运行时自动改用新注册凭证
    _parsed_list = [doc_actions.parse_step(s, requires_auth, settings, side_hint) for s in (steps or [])]
    _first_login_idx = next((i for i, p in enumerate(_parsed_list)
                             if p['ok'] and p.get('action') in ('login', 'wap_login', 'register')), None)

    # ---- 前序通用步骤重放链（2026-11-04 ian：探索→用例落地自包含）----
    # 探索器一个 page 连续走；spec 每步独立空白 page。通用原语步骤（无直达 path）需要
    # 先重放 open_home→click_text→fill_form 前序动作铺页面，否则 about:blank 上 0 候选。
    _GENERIC_REPLAY = ('open_home', 'goto_path', 'click_text', 'fill_form', 'hover_text', 'scroll_to_text')
    _REPLAY_FOLLOW = ('click_text', 'fill_form', 'expect_submit_ok', 'check_text', 'expect_url')

    def _build_replay(idx: int) -> str:
        acts = [(p['action'], p.get('body_ts') or '') for p in _parsed_list[:idx]
                if p.get('ok') and p.get('action') in _GENERIC_REPLAY]
        if not acts:
            return ''
        # 最后一次直达导航（open_home/goto_path）之前的动作无需重放（页面被直接重置）
        last_nav = max((i for i, (a, _) in enumerate(acts) if a in ('open_home', 'goto_path')), default=None)
        if last_nav is None:
            acts = [('open_home', doc_actions.TS_OPEN_HOME)] + acts
        else:
            acts = acts[last_nav:]
        # 每个重放动作包独立 { } 块：const __navPath / watch 等声明互不冲突
        return '\n      '.join('{\n        ' + ts + '\n      }' for _, ts in acts if ts)

    for i, s in enumerate(steps or [], 1):
        sid = s.get('id') or f'S{i}'
        side = (s.get('side') or '').upper()
        step_name = f"{sid}{' [' + side + ']' if side else ''} {s.get('name', '')}"
        expect = s.get('expect') or '待补充预期'
        parsed = _parsed_list[i - 1]
        before_login = _first_login_idx is not None and (i - 1) < _first_login_idx
        if parsed['ok']:
            _need_replay = (parsed['action'] in _REPLAY_FOLLOW and not parsed.get('path'))
            ts_body = doc_actions.step_body(s, parsed, requires_auth, i, kw_default=case_kw, before_login=before_login,
                                            replay_ts=_build_replay(i - 1) if _need_replay else '')
            prereq_note = ' → '.join(doc_actions.expand_prereq(parsed['action'], requires_auth, before_login)) or '无'
            body.append((STEP_REAL_TMPL
                         .replace('__TITLE__', _ts_str(step_name))
                         .replace('__SNAME__', _ts_str(s.get('name', '')))
                         .replace('__EXPECT__', _ts_str(expect))
                         .replace('__NOTE__', (parsed['note'] or '').replace('\n', ' '))
                         .replace('__PREREQ__', prereq_note)
                         .replace('__SID_RAW__', sid)
                         .replace('__SID__', _ts_str(sid))
                         .replace('__BODY__', '\n      ' + ts_body)))
            summary.append(f" *   {sid} ✅ {parsed['action']}：{parsed['note']}")
        else:
            reason = (parsed.get('note') or '未识别').replace('\n', ' ')
            is_wap = side == 'WAP' or (not side and side_hint == 'WAP')
            fallback = (STEP_TMPL
                        .replace('__TITLE__', _ts_str(step_name))
                        .replace('__SNAME__', _ts_str(s.get('name', '')))
                        .replace('__EXPECT__', _ts_str(expect))
                        .replace('__TARGET_DESC__', 'WAP 端' if is_wap else 'PC 端')
                        .replace('__TARGET__', 'wapHome' if is_wap else 'pcHome')
                        .replace('__SID__', _ts_str(sid)))
            fallback = fallback.replace('// TODO(实现本步骤)',
                                        f'// 未自动实现原因：{reason}\n    // TODO(实现本步骤)')
            body.append(fallback)
            summary.append(f" *   {sid} ⏸ 占位：{reason}")
    head = (REAL_HEAD_TMPL
            .replace('__CODE__', code)
            .replace('__CODE_JS__', _ts_str(f'{code} · {name}'))
            .replace('__NAME__', name)
            .replace('__DESC__', desc or '-')
            .replace('__ENDS__', '+'.join(ends))
            .replace('__AUTH__', '是' if requires_auth else '否')
            .replace('__MUT__', '是（真实数据）' if mutating else '否')
            .replace('__GEN_AT__', datetime.now().strftime('%Y-%m-%d %H:%M'))
            .replace('__ACTION_SUMMARY__', '\n'.join(summary)))
    return head + '\n'.join(body) + '\n});\n', summary


def _spec_content(code: str, name: str, desc: str, ends: list, requires_auth: bool,
                  mutating: bool, steps: list) -> str:
    head = (HEAD_TMPL
            .replace('__CODE__', code)
            .replace('__CODE_JS__', _ts_str(f'{code} · {name}'))
            .replace('__NAME__', name)
            .replace('__DESC__', desc or '-')
            .replace('__ENDS__', '+'.join(ends))
            .replace('__AUTH__', '是' if requires_auth else '否')
            .replace('__MUT__', '是（真实数据）' if mutating else '否')
            .replace('__GEN_AT__', datetime.now().strftime('%Y-%m-%d %H:%M')))
    body = []
    for i, s in enumerate(steps or [], 1):
        sid = s.get('id') or f'S{i}'
        side = (s.get('side') or '').upper()
        is_wap = side == 'WAP'
        step_name = f"{sid}{' [' + side + ']' if side else ''} {s.get('name', '')}"
        expect = s.get('expect') or '待补充预期'
        body.append((STEP_TMPL
                     .replace('__TITLE__', _ts_str(step_name))
                     .replace('__SID__', _ts_str(sid))
                     .replace('__SNAME__', _ts_str(s.get('name', '')))
                     .replace('__EXPECT__', _ts_str(expect))
                     .replace('__TARGET_DESC__', 'WAP 端' if is_wap else 'PC 端')
                     .replace('__TARGET__', 'wapHome' if is_wap else 'pcHome')))
    return head + '\n'.join(body) + '\n});\n'


@shared_task(name='scenarios.tasks.generate_doc_spec')
def generate_doc_spec(scenario_pk: int) -> str:
    from .models import Scenario, ScenarioVersion
    sc = Scenario.objects.get(pk=scenario_pk)
    sv = sc.versions.order_by('-version').first()
    if sv is None:
        return f'skip: scenario {sc.code} 无版本'
    d = sv.definition
    if not d.get('doc_created'):
        return f'skip: {sc.code} 非 doc_created 用例'
    # 手工实现的用例（doc_impl=manual）不自动覆盖
    if d.get('doc_impl') == 'manual':
        return f'skip: {sc.code} 为手工实现用例（doc_impl=manual），不自动覆盖'
    ends = [e for e in sv.supported_ends()]
    spec_rel = f'tests/doc-{sc.code}.spec.ts'
    steps = d.get('doc_steps') or d.get('steps') or []
    # ---- 真实执行模式优先（2026-10-05：口语步骤 → 动作原语自动扩充） ----
    from . import doc_actions as _da
    side_hint = 'PC' if 'pc' in ends else 'WAP'
    parsed_all = [_da.parse_step(s, bool(d.get('requires_auth')), d.get('settings') or [], side_hint)
                  for s in steps]
    real_count = sum(1 for p in parsed_all if p.get('ok'))
    if real_count:
        content, summary = _spec_content_real(
            sc.code, sc.name, d.get('description', ''), ends,
            bool(d.get('requires_auth')), bool(d.get('mutating')), steps, d.get('settings') or [])
        impl = 'auto-v1'
        d['doc_actions'] = {steps[i].get('id') or f'S{i+1}': {
            'action': p['action'], 'ok': p['ok'], 'note': p.get('note', '')}
            for i, p in enumerate(parsed_all)}
        log.info('doc spec 真实模式生成: %s real=%d/%d', sc.code, real_count, len(steps))
    else:
        content = _spec_content(sc.code, sc.name, d.get('description', ''), ends,
                                bool(d.get('requires_auth')), bool(d.get('mutating')), steps)
        impl = 'skeleton'
        d.pop('doc_actions', None)
    d['doc_impl'] = impl
    out = Path(settings.RUNNER_ROOT) / spec_rel
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(content, encoding='utf-8')
    # definition 回填入口（双端同一文件：Playwright project 决定浏览器）
    ends_map = {e: spec_rel for e in ends}
    changed = (d.get('ends') != ends_map or d.get('runner_spec') != spec_rel or impl == 'auto-v1')
    d['ends'] = ends_map
    d['runner_spec'] = spec_rel
    sv.save(update_fields=['definition'])
    log.info('doc spec 生成: %s (%s)', out, f'{len(content)}B')
    return f'ok: {spec_rel} ({len(content)}B, steps={len(steps)}, real={real_count}, impl={impl})'


AUTO_MAX_ROUNDS = 2          # 自动闭环：失败后 AI 修正再探索的最大轮次（首轮 + 2 轮修正 = 最多 3 轮探索）
EXPLORE_RUN_TIMEOUT = 20 * 60   # 单轮探索子进程上限（与 ai_explore.ts TOTAL_BUDGET 匹配）


def _auto_create_scenario(er, created_by_id: int) -> dict:
    """自动闭环收尾（2026-11-05 ian）：探索通过的最终计划自动建用例并发布。
    code 取 code_suggest 清洗，冲突自动加序号后缀；返回 {pk, code, version, steps} 或抛异常。"""
    import re as _re
    from .models import Scenario, ScenarioVersion
    from . import action_registry as ar
    plan = er.plan or {}
    steps = plan.get('steps') or []
    base = _re.sub(r'[^a-z0-9-]', '', str(plan.get('code_suggest') or '').strip().lower()) \
        or ('ai-' + __import__('datetime').datetime.now().strftime('%m%d-%H%M').lower())
    code, n = base, 1
    while Scenario.objects.filter(code=code).exists():
        n += 1
        code = f'{base}-{n}'
    ends = plan.get('ends') or ['pc']
    spec_rel = f'tests/doc-{code}.spec.ts'
    definition = {
        'ends': {e: spec_rel for e in ends},
        'actions': ['__legacy_spec__'],
        'mutating': any(s.get('action') in ar.MUTATING_ACTIONS for s in steps),
        'settings': [],
        'description': str(plan.get('description') or '')[:300],
        'runner_spec': spec_rel,
        'requires_auth': bool(plan.get('requires_auth')),
        'doc_created': True,
        'doc_steps': steps,
        'doc_source_text': plan.get('case_text') or '',
        'ai_created': True,
        'ai_auto_pilot': True,
        'ai_model': plan.get('ai_model') or '',
    }
    from django.contrib.auth import get_user_model
    user = get_user_model().objects.filter(pk=created_by_id).first()
    sc = Scenario.objects.create(code=code, name=str(plan.get('name') or 'AI 自动用例')[:80])
    ScenarioVersion.objects.create(scenario=sc, version=1, status=ScenarioVersion.Status.PUBLISHED,
                                   definition=definition, created_by=user)
    generate_doc_spec.delay(sc.pk)
    return {'pk': sc.pk, 'code': sc.code, 'version': 1, 'steps': len(steps)}


@shared_task(name='scenarios.tasks.run_ai_explore', soft_time_limit=64 * 60, time_limit=67 * 60)
def run_ai_explore(explorer_pk: int) -> str:
    """AI 计划探索验证（2026-11 二期；2026-11-05 ian 升级自动闭环）：
    browser-worker 内 npx tsx tests/ai_explore.ts 实走站点。
    plan/结果经 ExploreRun 模型传递；截图复制到 html-report/EXPLORE-<pk>/screenshots/ 供平台鉴权浏览。
    站点锁与 run_browser_job 同款（探索与真实 Job 共享测试账号/购物车，必须互斥）。

    自动闭环（plan.auto_pilot=true）：探索 → 失败步喂 AI 修正（页面感知 replan）→ 自动再探索
    （最多 AUTO_MAX_ROUNDS 轮修正）→ 通过或轮次耗尽后自动创建并发布用例（plan.auto_create），
    全程人工零介入；轮次与建用例结果记录在 result.auto。"""
    import os as _os
    import json as _json
    import shutil
    import subprocess
    import redis as _redis
    from django.utils import timezone
    from .models import ExploreRun

    er = ExploreRun.objects.select_related('site').get(pk=explorer_pk)
    rid = f'EXPLORE-{er.pk:06d}'
    er.status = 'running'
    er.save(update_fields=['status'])

    lock = _redis.Redis.from_url(settings.CELERY_BROKER_URL, socket_timeout=5).lock(
        f'job-site-lock:{er.site.code}', timeout=66 * 60)
    if not lock.acquire(blocking=False):
        er.status, er.error = 'error', f'站点 {er.site.code} 有任务执行中，探索已跳过（稍后重试）'
        er.finished_at = timezone.now()
        er.save(update_fields=['status', 'error', 'finished_at'])
        return f'skip: site {er.site.code} busy'
    try:
        root = Path(settings.RUNNER_ROOT)
        work = root / 'output' / 'ai-explore' / rid
        work.mkdir(parents=True, exist_ok=True)

        # 站点执行环境（与 runner._build_env 同语义：档案 id / 域名覆盖 / 前台账密；账密仅注入 env 不落盘）
        env = _os.environ.copy()
        for k in ('http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'all_proxy'):
            env.pop(k, None)  # 禁代理（容器坏代理劫持防护，与 runner 一致）
        site = er.site
        env.update({
            'TEST_SITE_ID': site.profile_key or site.code,
            'HEADLESS': 'true', 'CI': '1',
        })
        if site.pc_base_url:
            env['SITE_PC_BASE_URL'] = site.pc_base_url
        if site.wap_base_url:
            env['SITE_WAP_BASE_URL'] = site.wap_base_url
        if site.front_account:
            env['SITE_FRONT_ACCOUNT'] = site.front_account
        if site.front_password:
            env['SITE_FRONT_PASSWORD'] = site.front_password
        # 三期（2026-11 ian）：探索独立账号——配了则探索器用独立账号登录（与真实 Job 数据隔离）
        if site.explore_account:
            env['SITE_EXPLORE_ACCOUNT'] = site.explore_account
        if site.explore_password:
            env['SITE_EXPLORE_PASSWORD'] = site.explore_password

        # ---- 自动闭环（2026-11-05 ian）：探索 → 失败 AI 修正 → 再探索（≤AUTO_MAX_ROUNDS 轮修正）----
        auto = bool((er.plan or {}).get('auto_pilot'))
        auto_create = auto and (er.plan or {}).get('auto_create', True)
        auto_info = {'rounds': [], 'created': None, 'stop': ''}
        rounds_done = 0
        res = None
        while True:
            rounds_done += 1
            plan_payload = {
                'run_id': rid, 'code': er.code,
                'site_code': er.site.code,
                'name': (er.plan or {}).get('name', ''),
                'steps': (er.plan or {}).get('steps') or [],
            }
            plan_file = work / 'plan.json'
            plan_file.write_text(_json.dumps(plan_payload, ensure_ascii=False, indent=2), encoding='utf-8')

            cmd = ['npx', 'tsx', 'tests/ai_explore.ts', str(plan_file)]
            log = ''
            code = -1
            try:
                proc = subprocess.run(cmd, cwd=str(root), env=env, timeout=EXPLORE_RUN_TIMEOUT,
                                      capture_output=True, text=True, errors='replace')
                code = proc.returncode
                log = (proc.stdout or '') + '\n' + (proc.stderr or '')
            except subprocess.TimeoutExpired as e:
                out = e.stdout or ''
                err = e.stderr or ''
                if isinstance(out, bytes):
                    out = out.decode('utf-8', 'replace')
                if isinstance(err, bytes):
                    err = err.decode('utf-8', 'replace')
                log = out + '\n' + err + '\n[timeout] 本轮探索超过 20 分钟被终止'
                er.status, er.error = 'error', f'探索超时（第 {rounds_done} 轮，20 分钟）'
                auto_info['stop'] = 'timeout'
                break

            result_file = work / 'result.json'
            res = None
            if result_file.exists():
                try:
                    res = _json.loads(result_file.read_text(encoding='utf-8'))
                    er.result, er.status, er.error = res, 'done', ''
                except Exception as e:
                    er.status, er.error = 'error', f'result.json 解析失败：{e}'
                    auto_info['stop'] = 'result-parse'
            else:
                tail = log[-300:].replace('\n', ' ')
                er.status, er.error = 'error', f'ai_explore.ts 未产出 result.json（exit={code}） {tail}'
                auto_info['stop'] = 'no-result'

            # 截图复制到 html-report（web 侧经 /reports/view/ 鉴权浏览；每轮覆盖同名截图）
            shots_src = work / 'shots'
            if shots_src.exists():
                dst = root / 'output' / 'html-report' / rid / 'screenshots'
                dst.mkdir(parents=True, exist_ok=True)
                for f in shots_src.glob('*.png'):
                    shutil.copy(f, dst / f.name)
            (work / f'runner-round{rounds_done}.log').write_text(log[-20000:], encoding='utf-8', errors='replace')
            if res is None:
                break

            failed = [s for s in (res.get('steps') or []) if not s.get('ok')]
            if not auto or not failed or (rounds_done - 1) >= AUTO_MAX_ROUNDS:
                if auto and failed and (rounds_done - 1) >= AUTO_MAX_ROUNDS:
                    auto_info['stop'] = 'max-rounds'
                break
            # ---- 失败证据喂 AI 修正（页面感知 replan），修正后自动再探索 ----
            from .models import AiConfig
            if not AiConfig.get_solo().ready:
                auto_info['stop'] = 'ai-disabled'
                break
            plan_steps = {s.get('id'): s for s in (er.plan or {}).get('steps') or []}
            evidence = []
            for s in res.get('steps') or []:
                ps = plan_steps.get(s.get('id')) or {}
                evidence.append({k: s.get(k) or ps.get(k) or ''
                                 for k in ('id', 'action', 'name', 'expect', 'ok', 'error', 'note', 'url',
                                           'page_links')})
            from . import ai_planner
            try:
                new_plan = ai_planner.replan(er.plan or {}, evidence, er.site)
            except Exception as e:   # AiClientError 等——保留本轮结果，停止闭环
                auto_info['stop'] = f'replan-failed: {str(e)[:200]}'
                break
            for k in ('auto_pilot', 'auto_create', 'code_suggest', 'case_text'):
                new_plan[k] = (er.plan or {}).get(k)
            er.plan = new_plan
            er.save(update_fields=['plan'])
            auto_info['rounds'].append({'round': rounds_done, 'ok': res.get('ok_count', 0),
                                        'total': res.get('total', 0), 'replanned_failed': len(failed)})

        # ---- 自动闭环收尾：自动创建并发布用例（通过则建；轮次耗尽也建——保留 unknown 步待人工）----
        if auto and auto_create and er.created_by_id and (er.plan or {}).get('steps'):
            try:
                auto_info['created'] = _auto_create_scenario(er, er.created_by_id)
                r_ = er.result or {}
                auto_info['created_all_passed'] = bool(
                    r_.get('ok_count', 0) >= r_.get('total', 0) > 0)
            except Exception as e:
                auto_info['create_error'] = str(e)[:300]
        if auto and er.result is not None:
            res = dict(er.result or {})
            res['auto'] = auto_info
            er.result = res

        if er.status != 'error':
            er.status = 'done'
        er.finished_at = timezone.now()
        er.save(update_fields=['status', 'result', 'error', 'finished_at'])
        ok = er.ok_count if er.result else 0
        total = er.total_steps if er.result else 0
        created_code = (auto_info.get('created') or {}).get('code')
        return (f'{er.status}: {rid} ok={ok}/{total} exit={code} rounds={rounds_done}'
                + (f' created={created_code}' if created_code else ''))
    finally:
        try:
            lock.release()
        except Exception:
            pass  # 锁过期/未持有（worker 重启 TTL 兜底）
