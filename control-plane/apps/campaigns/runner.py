"""PlaywrightRunnerService：调用现有 web-blackbox Playwright 项目执行测试（产物落 web-blackbox）
双端版（2026-09-23）：按 job.device(pc/wap) 选择 project/脚本；RUN_ID 带 -PC/-WAP 后缀；
跑完自动调用 gen-platform-report.py 生成全链三件套（仅全链类用例存在 result json 时）。
"""
import json, os, re, subprocess, threading, time
from pathlib import Path
from django.conf import settings

EXIT_MAP = {0: 'passed', 10: 'failed', 20: 'failed', 30: 'failed', 40: 'failed', 50: 'cancelled'}
PROXY_KEYS = ('http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'all_proxy')
# 用例自定义 vars → 环境变量别名（其余一律 TV_<KEY>）
VAR_ENV_ALIAS = {'keyword': 'WAP_KEYWORD', 'wap_keyword': 'WAP_KEYWORD'}
# 断点续跑（2026-10-13）：白名单 key 不加 TV_ 前缀、原样注入 env（spec 直接读 process.env.FC_RESUME_FROM）
VAR_ENV_PASSTHROUGH = {'FC_RESUME_FROM', 'FC_CURRENCY', 'FC_POLL_SEC'}
# 宿主 web-blackbox 根 → runner 容器内挂载路径（值若是宿主路径，注入前翻译为容器路径，双保险）
VAR_PATH_HOST_PREFIX = '/opt/ai_autotest/web-blackbox'
VAR_PATH_CONTAINER_PREFIX = '/workspace/runner'
# 步骤总数预估（scenario_code × end → 预计步骤数；未知则进度只显示已进行步数不显示百分比）
STEP_TOTAL_HINT = {
    ('full-chain', 'pc'): 15,
    ('full-chain', 'wap'): 16,
    ('favorite-check', 'pc'): 3,
    ('wap-shopping', 'wap'): 6,
    ('public-smoke', 'pc'): 5, ('public-smoke', 'wap'): 5,
    ('product-search', 'pc'): 3, ('estimate-page', 'pc'): 3,
    ('auth-public', 'pc'): 4, ('auth-public', 'wap'): 4,
    ('i18n-check', 'pc'): 3,
}
# 进度行：PC `[F1] ok 名称 (123ms)` / WAP `[✅] W-F1 名称 (12.3s, 5 req)`
STEP_LINE = re.compile(r'^\[([A-Za-z][\w-]*|✅|❌)\]\s*')
STEP_ID_WAP = re.compile(r'^\[(?:✅|❌)\]\s+([\w-]+)\s')
STEP_MS = re.compile(r'\(([\d.]+)(ms|s)[,)]')

class RunnerFailure(Exception):
    def __init__(self, kind, message, exit_code=None, log=''):
        self.kind = kind  # assertion | infra
        self.message = message
        self.exit_code = exit_code
        self.log = log
        super().__init__(message)

def _build_env(job, m, run_id, end) -> dict:
    site = m.get('site', {})
    env = os.environ.copy()
    env.update({
        'RUN_ID': run_id,
        'TEST_SITE_ID': site.get('id', ''),
        'TEST_SITE_IDS': site.get('id', ''),
        'BASE_URL': site.get('base_url', ''),
        'WORKERS': '1',
        'RETRIES': '2',
        'HEADLESS': 'true',
        'CI': '1',
        'FULLCHAIN_RUN_DIR': run_id,
        'WAPFC_RUN_ID': run_id,
    })
    # 域名注入优先级：Campaign 手动覆盖 > 站点档案 endpoints（/sites/ 配置）> sites.json 原值
    ov = (job.campaign.plan or {}).get('url_overrides') or {}
    eps = (site.get('endpoints') or {})
    if ov.get('pc'):
        env['SITE_PC_BASE_URL'] = ov['pc']
    if ov.get('wap'):
        env['SITE_WAP_BASE_URL'] = ov['wap']
    if ov.get('boss'):
        base, entry = _split_boss(ov['boss'])
        env['SITE_BOSS_BASE_URL'] = base
        if entry:
            env['SITE_BOSS_ENTRY'] = entry
    if not ov.get('pc') and eps.get('pc'):
        env['SITE_PC_BASE_URL'] = eps['pc']
    if not ov.get('wap') and eps.get('wap'):
        env['SITE_WAP_BASE_URL'] = eps['wap']
    if not ov.get('boss') and eps.get('boss'):
        base, entry = _split_boss(eps['boss'])
        env['SITE_BOSS_BASE_URL'] = base
        if entry:
            env['SITE_BOSS_ENTRY'] = entry
    # 同结构站点复用档案路径表（shop-v2 等：code ≠ 档案 id 时以 profile 为准）
    if site.get('profile'):
        env['TEST_SITE_ID'] = site['profile']
        env['TEST_SITE_IDS'] = site['profile']
    # 环节地址临时覆盖（ian 2026-10-20：发起页点进用例环节修改的地址 → SITE_PATH_OVERRIDES JSON，
    # 仅本 Campaign 的 Job 生效；档案默认值不变，长期生效需改流程档案/站点档案）。注入失败不阻断执行。
    try:
        pov = (job.campaign.plan or {}).get('path_overrides') or {}
        pov = {k: {kk: (vv or '').strip() for kk, vv in v.items() if isinstance(vv, str) and vv.strip()}
               for k, v in pov.items() if isinstance(v, dict)}
        pov = {k: v for k, v in pov.items() if v}
        if pov:
            env['SITE_PATH_OVERRIDES'] = json.dumps(pov, ensure_ascii=False)
            flat = ', '.join(f'{s}.{k}={v}' for s, m in pov.items() for k, v in m.items())
            print(f"[path-override] Job {job.pk} 环节地址覆盖（仅当次生效，共 {sum(len(m) for m in pov.values())} 项）: {flat}", flush=True)
    except Exception as e:
        print(f"[path-override] 环节地址覆盖注入失败（按档案默认执行）: {e}", flush=True)
    # 技能包注入（2026-11-04 ian）：manifest.skill_packs → env SKILL_PACKS（JSON），
    # 执行侧据此判定「注册流程是否需邮箱验证码」并留痕到日志/报告；注入失败不阻断执行。
    try:
        packs = m.get('skill_packs') or []
        if packs:
            env['SKILL_PACKS'] = json.dumps(packs, ensure_ascii=False)
            print(f"[skill-packs] Job {job.pk} 生效技能包: "
                  + ', '.join(f"{p.get('code')}@v{p.get('version')}" for p in packs), flush=True)
    except Exception as e:
        print(f"[skill-packs] 技能包注入失败（按默认行为执行）: {e}", flush=True)
    # 站点测试账号注入（2026-09-24 ian：测试过程遇到登录使用站点配置的账密；不进 manifest，仅 env 通道）
    try:
        from apps.sites.models import Site as _Site
        _s = _Site.objects.filter(code=m.get('site', {}).get('id', job.site_code)).first()
        if _s:
            if _s.front_account:
                env['SITE_FRONT_ACCOUNT'] = _s.front_account
            if _s.front_password:
                env['SITE_FRONT_PASSWORD'] = _s.front_password
            if _s.boss_account:
                env['SITE_BOSS_ACCOUNT'] = _s.boss_account
            if _s.boss_password:
                env['SITE_BOSS_PASSWORD'] = _s.boss_password
    except Exception:
        pass  # 账号注入失败不阻断执行（回退 .env 全局账号）
    # 测试用例库注入（2026-10-08 ian：Campaign 勾选的素材条目优先；未勾=从启用条目随机抽 3）
    # 注入 env：LIB_KEYWORDS / LIB_IMAGES / LIB_LINKS（'|' 分隔）；用例侧优先于站点档案默认值。
    import random as _random
    from apps.campaigns.models import AssetLibrary as _AL
    lib_sel = (job.campaign.plan or {}).get('library') or {}

    def _pick_lib(kind: str) -> tuple[list, str]:
        """返回 (vals, mode)：勾选优先，否则启用条目随机抽 3"""
        picked_ids = lib_sel.get(kind) or []
        qs = _AL.objects.filter(kind=kind, enabled=True)
        if picked_ids:
            return [a.value for a in qs.filter(pk__in=picked_ids)], 'picked'
        pool = [a.value for a in qs]
        return (_random.sample(pool, min(3, len(pool))) if pool else []), 'random'

    try:
        for _kind, _envkey in (('keyword', 'LIB_KEYWORDS'), ('image', 'LIB_IMAGES'), ('link', 'LIB_LINKS')):
            vals, mode = _pick_lib(_kind)
            vals = [v.strip() for v in vals if v and v.strip()]
            if vals:
                env[_envkey] = '|'.join(vals)
                env[f'{_envkey}_MODE'] = mode  # picked=发起时勾选 / random=随机抽取
    except Exception:
        pass  # 库注入失败不阻断执行（用例回退站点档案默认素材）
    # 全链选品方向（2026-10-09 ian：关键词/链接/图片三方向，来源=用例库/手动填写）
    # spec 侧读 FC_PICK_MODE + FC_PICK_ITEMS 驱动 F2 选品；未配置=旧供应链编号直连（兼容存量 Job 重跑）
    try:
        pick = (job.campaign.plan or {}).get('pick') or {}
        if pick.get('mode') in ('keyword', 'link', 'image'):
            env['FC_PICK_MODE'] = pick['mode']
            env['FC_PICK_SOURCE'] = pick.get('source') or 'library'
            if pick.get('source') == 'manual':
                vals = [v.strip() for v in (pick.get('manual') or '').replace('\r', '').split('\n')
                        if v.strip()][:20]
                if vals:
                    env['FC_PICK_ITEMS'] = '|'.join(vals)
                    env['FC_PICK_ITEMS_MODE'] = 'manual'
            else:
                vals, mode = _pick_lib(pick['mode'])
                vals = [v.strip() for v in vals if v and v.strip()]
                if vals:
                    env['FC_PICK_ITEMS'] = '|'.join(vals)
                    env['FC_PICK_ITEMS_MODE'] = mode  # picked=发起时勾选 / random=随机抽取
    except Exception:
        pass  # 方向注入失败回退 spec 内置素材池，不阻断执行
    # Policy 安全基线注入（2026-10-15 ian：规则包生效于测试流程）
    # plan.policies（发起时勾选 + locked 强制并入）→ env：POLICY_PACKS（'|' 分隔 code）+
    # POLICY_RULES（'规则id[severity] 规则文案' 以 '||' 分隔，spec/报告可读）；Job 日志记录遵循清单
    try:
        codes = [c for c in ((job.campaign.plan or {}).get('policies') or []) if c]
        from apps.policies.models import PolicyPackVersion as _PPV
        packs = _PPV.objects.filter(code__in=codes)
        if packs:
            env['POLICY_PACKS'] = '|'.join(p.code for p in packs)
            import yaml as _yaml
            rule_lines = []
            for p in packs:
                try:
                    rules = (_yaml.safe_load(p.content) or {}).get('rules') or []
                except Exception:
                    rules = []
                rule_lines += [f"{p.code}:{r.get('id', '?')}[{r.get('severity', '?')}] {r.get('text', '')}".strip()
                               for r in rules if isinstance(r, dict)]
            if rule_lines:
                env['POLICY_RULES'] = '||'.join(rule_lines)
                env['POLICY_RULES_COUNT'] = str(len(rule_lines))
            print(f"[policy] Job {job.pk} 遵循安全基线: {env['POLICY_PACKS']}（{len(rule_lines)} 条规则，"
                  f"详情见 POLICY_RULES）", flush=True)
    except Exception as e:
        print(f"[policy] 安全基线注入失败（不阻断执行）: {e}", flush=True)
    # 用例自定义设置 → env
    for k, v in ((m.get('dataset') or {}).get('vars') or {}).items():
        if v is None or v == '':
            continue
        key = str(k)
        val = '1' if v is True else '0' if v is False else str(v)
        if key.upper() in VAR_ENV_PASSTHROUGH:
            # 断点续跑白名单：原样 key + 宿主路径翻译为 runner 容器内路径
            env[key.upper()] = val.replace(VAR_PATH_HOST_PREFIX, VAR_PATH_CONTAINER_PREFIX)
        else:
            env[VAR_ENV_ALIAS.get(key.lower(), f'TV_{key.upper()}')] = val
    for k in PROXY_KEYS:
        env.pop(k, None)
    return env

def _split_boss(url: str):
    """boss 完整入口拆 (base, entry)：https://boss.x.com/xDDQtbeo → ('https://boss.x.com', '/xDDQtbeo')"""
    from urllib.parse import urlparse
    u = urlparse((url or '').strip())
    if not u.scheme:
        return '', ''
    base = f'{u.scheme}://{u.netloc}'
    path = (u.path or '').rstrip('/')
    return base, (path if len(path) > 1 else '')

def _build_cmd(spec, end) -> list:
    """scripts/ 开头 = tsx 脚本（如 WAP 全链），tests/ 开头 = playwright spec 按端选 project"""
    if spec.startswith('scripts/'):
        return ['npx', 'tsx', spec]
    project = 'web-mobile' if end == 'wap' else 'web-desktop'
    return ['npx', 'playwright', 'test', spec, f'--project={project}']

def _require_html(run_id: str, kind: str, gen_log: str) -> tuple[str | None, str]:
    """2026-10-14 ian（JOB-96 报告 404 根因）：生成器可能正常退出但没产出 index.html
    （如用例加载期失败 → 无 result json → 生成器打印「跳过」sys.exit(0)）。
    产物不存在时返回 None —— runner 不再往 summary 写 report.url，UI 不出现死链。"""
    html_out = Path(settings.RUNNER_ROOT) / 'output' / 'html-report' / run_id / 'index.html'
    if html_out.exists():
        return kind, gen_log
    return None, gen_log + '\n[runner] 报告未生成：index.html 不存在（用例未产出任何步骤数据，常见于加载期失败/No tests found，看上方日志定位原因）'


def _gen_report(run_id: str, env: dict, job=None) -> tuple[str | None, str]:
    """检测本轮 result json 并生成三件套；返回 (end|None, 生成日志)
    2026-09-27 ian：无 fullchain/wapchain 数据时走通用模式（gen-platform-report.py 内部
    自动从 playwright results.json 合成步骤+截图报告），所有用例都有步骤级报告。"""
    runner_out = Path(settings.RUNNER_ROOT) / 'output' / run_id
    kind = None
    for rf, kd in (('wapchain-result.json', 'wap'), ('fullchain-result.json', 'pc')):
        # 分片文件（fullchain-result.w*.json，workers>1 并行写入）也算命中，走 fullchain 渲染路径
        if (runner_out / rf).exists() or list(runner_out.glob(rf.replace('.json', '.w*.json'))):
            kind = kd
            break
    genv = dict(env or {})
    if job is not None:
        # 通用模式元信息：用例 spec/名称/站点（报告头部展示）
        genv.setdefault('SITE_CODE', getattr(job, 'site_code', '') or '')
        m = getattr(job, 'run_manifest', None) or {}
        genv.setdefault('DOC_SPEC', (m.get('scenario') or {}).get('runner_spec', ''))
        genv.setdefault('DOC_CASE_NAME', (m.get('scenario') or {}).get('id', ''))
    if not kind:
        if not (runner_out / 'results.json').exists():
            return None, ''
        kind = 'wap' if str((getattr(job, 'device', '') or '')).lower() == 'wap' else 'pc'
        g = subprocess.run(['python3', 'scripts/gen-platform-report.py', run_id, kind],
                           cwd=settings.RUNNER_ROOT, env=genv, capture_output=True, text=True, timeout=180)
        return _require_html(run_id, kind, '[generic] ' + (g.stdout + g.stderr)[-2000:])
    g = subprocess.run(['python3', 'scripts/gen-platform-report.py', run_id, kind],
                       cwd=settings.RUNNER_ROOT, env=genv, capture_output=True, text=True, timeout=180)
    return _require_html(run_id, kind, (g.stdout + g.stderr)[-2000:])

def _cancel_watch(job_pk: int, proc, cancelled: dict, poll_sec: float = 3.0):
    """取消监测线程（2026-10-21 ian：运行中终止）：周期查 DB 取消标志，
    命中即 SIGTERM 测试进程（8s 不退升级 SIGKILL）。runner 主循环读 stdout 可能长时间
    无输出阻塞（候选磨轮询），故取消检测必须在独立线程进行。"""
    from .models import TestJob
    while proc.poll() is None:
        try:
            if TestJob.objects.filter(pk=job_pk, status='cancel_requested').exists():
                print('[runner] 收到取消请求，正在终止测试进程...', flush=True)
                cancelled['flag'] = True
                try:
                    proc.terminate()
                except Exception:
                    pass
                for _ in range(8):
                    if proc.poll() is not None:
                        return
                    time.sleep(1)
                try:
                    proc.kill()
                except Exception:
                    pass
                return
        except Exception:
            pass
        time.sleep(poll_sec)


def run(job) -> dict:
    m = job.run_manifest
    spec = m['scenario']['runner_spec']
    end = (m.get('runtime') or {}).get('end') or job.device or 'pc'
    end = 'wap' if str(end).lower() in ('wap', 'mobile') else 'pc'
    run_id = f"JOB-{job.pk:06d}-{'WAP' if end == 'wap' else 'PC'}"
    env = _build_env(job, m, run_id, end)
    cmd = _build_cmd(spec, end)
    t0 = time.time()
    # 流式执行（2026-09-24 ian：执行进展实时可见）——逐行读 stdout 解析步骤进度并回写 DB
    total_hint = STEP_TOTAL_HINT.get((job.scenario_code, end)) or 0
    proc = subprocess.Popen(cmd, cwd=settings.RUNNER_ROOT, env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
    cancelled = {'flag': False}
    _t_cancel = threading.Thread(target=_cancel_watch, args=(job.pk, proc, cancelled), daemon=True)
    _t_cancel.start()
    stderr_buf = []
    _t_err = threading.Thread(target=lambda: stderr_buf.append(proc.stderr.read()), daemon=True)
    _t_err.start()
    stdout_lines = []
    steps = []
    try:
        for raw in proc.stdout:
            line = raw.rstrip()
            stdout_lines.append(line)
            _track_progress(job, line, steps, t0, total_hint)
        proc.wait(timeout=28 * 60)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        stdout_lines.append('[runner] 超时（28min）被终止')
    _t_err.join(timeout=5)
    stdout = '\n'.join(stdout_lines)
    stderr = (stderr_buf[0] if stderr_buf else '')
    elapsed = round(time.time() - t0, 1)
    log = (stdout[-8000:] + '\n--- stderr ---\n' + stderr[-4000:])
    _final_progress(job, steps, total_hint)
    status = EXIT_MAP.get(proc.returncode, 'failed')
    if cancelled['flag']:
        # 用户取消：无论进程退出码如何一律按取消终态处理（不触发 infra 重试语义）
        status = 'cancelled'
        log += '\n[runner] 已按取消请求终止（用户手动取消，本轮不判失败）'
    # 全链类用例：无论成败先生成三件套报告（best-effort；取消亦生成，保留已完成步骤的截图与证据）
    gen_kind, gen_log = _gen_report(run_id, env, job)
    if gen_log:
        log += f'\n--- report-gen({gen_kind}) ---\n' + gen_log
    if proc.returncode < 0 and not cancelled['flag']:
        # 被信号杀死（超时硬杀/OOM）才算 infra，才触发自动重试；真实交易链路禁止自动重试（防重复下单）
        raise RunnerFailure('infra', f'Runner 被信号终止 ({proc.returncode})', proc.returncode, log)
    # 汇总 results.json（playwright json reporter 落在 output/<RUN_ID>/results.json）
    runner_out = Path(settings.RUNNER_ROOT) / 'output' / run_id
    summary = {'exit_code': proc.returncode, 'elapsed_sec': elapsed, 'spec': spec, 'run_id': run_id,
               'end': end, 'cmd': ' '.join(cmd)}
    # 2026-10-14 ian：失败原因一眼可见——提取首个 Error 行进 summary.error（加载期失败/断言失败均覆盖）
    if status != 'passed':
        for _ln in ((stdout or '') + '\n' + (stderr or '')).splitlines():
            _t = _ln.strip()
            if _t.startswith('Error:') and len(_t) > 10:
                summary['error'] = _t[:240]
                break
    rj = runner_out / 'results.json'
    if rj.exists():
        try:
            data = json.loads(rj.read_text())
            stats = data.get('stats', {})
            summary.update({'stats': stats, 'suites': [
                {'title': x.get('title'), 'ok': x.get('ok')} for x in data.get('suites', [])[:50]
            ]})
            # 2026-09-30 ian：骨架用例治理（方案A）——全部步骤 skipped（test.skip 待实现）时
            # 不算通过：判 failed 并显式注明，防止「骨架只开首页截图却显示通过」的假阳性
            if (status == 'passed' and (stats.get('skipped') or 0) > 0
                    and not (stats.get('expected') or 0) and not (stats.get('unexpected') or 0)):
                status = 'failed'
                summary['skeleton'] = True
                summary['error'] = '骨架用例未实现真实动作（全部步骤 test.skip「待实现」），本轮不计通过'
        except Exception as e:
            summary['parse_error'] = str(e)
    if gen_kind:
        summary['report'] = {'run_id': run_id, 'end': end,
                             'html': f'output/html-report/{run_id}/index.html',
                             'url': f'/reports/view/{run_id}/'}
    # 测试数据台账（2026-10-21 ian）：从 result json（含 .w*/.r* 分片）提取 tradeLedger 入库
    try:
        _collect_trade_records(job, run_id, runner_out)
    except Exception as e:
        print(f'[ledger] 台账收集失败（不影响执行结果）: {e}', flush=True)
    summary['status'] = status
    return {'summary': summary, 'log': log, 'runner_out': str(runner_out), 'run_id': run_id}


def _collect_trade_records(job, run_id: str, runner_out: Path):
    """从本轮 result json（主文件 + .w*/.r* 分片）提取 tradeLedger 合并入库（按 sn 去重，job+sn 唯一约束幂等）。"""
    from .models import TradeRecord
    files = [runner_out / 'wapchain-result.json', runner_out / 'fullchain-result.json']
    files += sorted(runner_out.glob('fullchain-result.[wr]*.json')) + sorted(runner_out.glob('wapchain-result.[wr]*.json'))
    merged: dict = {}
    for f in files:
        try:
            data = json.loads(f.read_text(encoding='utf-8'))
        except Exception:
            continue
        for it in (data.get('tradeLedger') or []):
            sn = str((it or {}).get('sn') or '').strip()
            if sn and sn not in merged:
                merged[sn] = it
    n = 0
    for sn, it in merged.items():
        kind = it.get('kind') if it.get('kind') in ('order', 'express', 'package') else 'order'
        _, created = TradeRecord.objects.get_or_create(
            job=job, sn=sn[:64],
            defaults=dict(campaign=job.campaign, site_code=job.site_code, scenario_code=job.scenario_code,
                          device=job.device, kind=kind,
                          account=str(it.get('account') or '')[:200],
                          amount=str(it.get('amount') or '')[:50],
                          note=str(it.get('note') or '')[:200]))
        n += 1 if created else 0
    if merged:
        print(f'[ledger] 台账入库 {len(merged)} 条（新增 {n}）：' +
              ', '.join(f"{v.get('kind')}:{k}" for k, v in list(merged.items())[:8]), flush=True)


def _parse_step(line: str):
    """解析一行用例输出 → (step_id, status, ms)；非步骤行返回 None
    PC:  [F1] ok 登录 (1234ms)   |   WAP: [✅] W-F1 登录 (12.3s, 5 req)
    """
    mt = STEP_LINE.match(line)
    if not mt:
        return None
    head = mt.group(1)
    if head in ('✅', '❌'):
        mw = STEP_ID_WAP.match(line)
        if not mw:
            return None
        sid, st = mw.group(1), ('ok' if head == '✅' else 'fail')
    else:
        sid = head
        rest = line[mt.end():]
        st = 'fail' if rest.startswith('fail') else ('ok' if rest.startswith('ok') else 'run')
    mm = STEP_MS.search(line)
    ms = int(float(mm.group(1)) * (1 if mm.group(2) == 'ms' else 1000)) if mm else 0
    return sid, st, ms


def _track_progress(job, line: str, steps: list, t0: float, total_hint: int):
    """逐步回写 TestJob.progress + 心跳（执行中心实时进度/ETA 数据源）"""
    from .models import TestJob
    from django.utils import timezone
    parsed = _parse_step(line)
    if parsed:
        sid, st, ms = parsed
        steps.append({'id': sid, 'status': st, 'ms': ms, 'at': round(time.time() - t0, 1)})
    elif not steps:
        return  # 首个步骤完成前不刷 DB
    done = len([s for s in steps if s['status'] != 'run'])
    elapsed = time.time() - t0
    eta = round(elapsed / done * (total_hint - done)) if (total_hint and done and done < total_hint) else None
    TestJob.objects.filter(pk=job.pk).update(
        progress={'done': done, 'total': total_hint or None,
                  'current': (steps[-1]['id'] if steps else ''),
                  'eta_sec': eta, 'steps': steps[-40:]},
        heartbeat_at=timezone.now())


def _final_progress(job, steps, total_hint):
    from .models import TestJob
    from django.utils import timezone
    done = len(steps)
    total = max(total_hint, done) if (total_hint or done) else None
    TestJob.objects.filter(pk=job.pk).update(
        progress={'done': done, 'total': total, 'finished': True, 'eta_sec': 0, 'steps': steps[-40:]},
        heartbeat_at=timezone.now())
