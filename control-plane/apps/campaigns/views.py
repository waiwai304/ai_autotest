from django.contrib import messages
from django.contrib.auth.decorators import login_required, user_passes_test
from django.shortcuts import render, get_object_or_404, redirect
from django.utils import timezone
from .models import Campaign, TestJob
from .tasks import expand_campaign, purge_run_dirs

def _first_report(o):
    """Campaign 下第一个 Job HTML 报告 URL（无则 None）"""
    for j in o.jobs.order_by('seq'):
        u = ((j.result_summary or {}).get('report') or {}).get('url')
        if u:
            return u
    return None


@login_required
def job_list(request):
    """全局执行记录列表（2026-09-26 仪表盘数字下钻需求）：status/device/site/scenario 过滤 + 分页"""
    from django.core.paginator import Paginator
    from apps.sites.models import Site
    from apps.scenarios.models import Scenario
    status = request.GET.get('status', '')
    device = request.GET.get('device', '')
    site_code = request.GET.get('site', '')
    scenario_code = request.GET.get('scenario', '')
    page_no = request.GET.get('page', '1')
    qs = TestJob.objects.select_related('campaign').order_by('-pk')
    if status in TestJob.Status.values:
        qs = qs.filter(status=status)
    if device in ('pc', 'wap'):
        qs = qs.filter(device=device)
    if site_code:
        qs = qs.filter(site_code=site_code)
    if scenario_code:
        qs = qs.filter(scenario_code=scenario_code)
    paginator = Paginator(qs, 50)
    page_obj = paginator.get_page(page_no)
    for j in page_obj.object_list:
        j.rep_url = ((j.result_summary or {}).get('report') or {}).get('url')
    counts = {
        'all': TestJob.objects.count(),
        'running': TestJob.objects.filter(status=TestJob.Status.RUNNING).count(),
        'passed': TestJob.objects.filter(status=TestJob.Status.PASSED).count(),
        'failed': TestJob.objects.filter(status=TestJob.Status.FAILED).count(),
    }
    sites = Site.objects.order_by('code')
    scenarios = Scenario.objects.order_by('code')
    return render(request, 'campaigns/jobs.html', {
        'page_obj': page_obj, 'counts': counts,
        'f_status': status, 'f_device': device,
        'f_site': site_code, 'f_scenario': scenario_code,
        'sites': sites, 'scenarios': scenarios,
        'status_choices': [(c.value, c.label) for c in TestJob.Status],
    })


@login_required
@user_passes_test(lambda u: u.is_superuser, login_url='/login/')
def job_delete(request):
    """删除选中的执行记录（仅终态 Job）：DB 记录 + 连带清理报告目录/工件目录，并重算 Campaign 统计。仅管理员。"""
    import shutil
    from pathlib import Path
    from django.conf import settings as dj_settings
    from django.db import transaction

    if request.method != 'POST':
        return redirect('/jobs/')
    ids = [int(x) for x in request.POST.getlist('ids') if x.isdigit()]
    FINAL = (TestJob.Status.PASSED, TestJob.Status.FAILED, TestJob.Status.LOST, TestJob.Status.CANCELLED)
    deleted, skipped = [], []
    hroot = Path(dj_settings.HTML_REPORT_ROOT)
    aroot = Path(dj_settings.ARTIFACT_ROOT)
    camp_ids = set()
    run_ids = set()
    with transaction.atomic():
        for jid in ids:
            j = TestJob.objects.filter(pk=jid).select_related('campaign').first()
            if j is None:
                continue
            if j.status not in FINAL:
                skipped.append(f'JOB-{jid:06d}（{j.get_status_display()}，仅终态可删）')
                continue
            # 连带清理报告目录（PC/WAP/其他 device 命名）+ 工件目录
            for suffix in {('PC' if j.device == 'pc' else 'WAP' if j.device == 'wap' else (str(j.device).upper() or 'PC')), 'PC', 'WAP'}:
                d = hroot / f'JOB-{jid:06d}-{suffix}'
                if d.is_dir():
                    shutil.rmtree(d, ignore_errors=True)
            adir = aroot / f'JOB-{jid:06d}'
            if adir.is_dir():
                shutil.rmtree(adir, ignore_errors=True)
            camp_ids.add(j.campaign_id)
            # 2026-10-27 连带清理 playwright 原始产物目录 output/<RUN_ID>/（browser-worker 执行）
            run_ids.add(f'JOB-{jid:06d}-' + ('WAP' if j.device == 'wap' else 'PC'))
            if ((j.result_summary or {}).get('run_id')):
                run_ids.add(str(j.result_summary['run_id']))
            j.delete()
            deleted.append(jid)
    # 事务提交后派发清理任务（尽力而为，失败不影响 DB 删除结果）
    try:
        if run_ids:
            purge_run_dirs.delay(run_ids=sorted(run_ids))
    except Exception:
        pass
    # 重算受影响 Campaign 的统计（删除后保持数字一致）
    for cid in camp_ids:
        c = Campaign.objects.filter(pk=cid).first()
        if c:
            qs = c.jobs.all()
            c.total_jobs = qs.count()
            c.finished_jobs = qs.filter(status__in=FINAL).count()
            c.passed_jobs = qs.filter(status=TestJob.Status.PASSED).count()
            c.failed_jobs = qs.filter(status=TestJob.Status.FAILED).count()
            c.save(update_fields=['total_jobs', 'finished_jobs', 'passed_jobs', 'failed_jobs'])
    if deleted:
        messages.success(request, f'已删除 {len(deleted)} 条执行记录（连带其报告与工件）：' +
                         '、'.join(f'JOB-{i:06d}' for i in deleted[:8]) + ('…' if len(deleted) > 8 else ''))
    if skipped:
        messages.warning(request, f'{len(skipped)} 条未删除：' + '；'.join(skipped[:5]) + ('…' if len(skipped) > 5 else ''))
    return redirect('/jobs/')


@login_required
@user_passes_test(lambda u: u.is_superuser, login_url='/login/')
def campaign_delete(request):
    """执行中心勾选删除（2026-10-27 ian：三处页面统一支持勾选删除并清理本地目录）。仅管理员。

    删除范围（仅终态 Campaign：排队中/运行中、或其下存在未终态 Job 的一律跳过，防与 Celery 竞态）：
      - DB：Campaign + 其全部 TestJob（先删 Job 再删 Campaign，jobs FK 为 PROTECT）；
        台账 TradeRecord / AI 分析 AiAnalysis 随 FK CASCADE 自动删除。
      - 本地目录：每个 Job 的 HTML 报告目录（html-report/JOB-xxx-{PC,WAP}）与工件目录
        （artifacts/JOB-xxx）即时清理；Campaign 汇总报告目录（reports/CAMPAIGN-xxxxxx）即时清理；
        playwright 原始产物目录（output/JOB-xxx-{PC,WAP}，仅 browser-worker 可写）派发 purge_run_dirs 清理。
    """
    import shutil
    from pathlib import Path
    from django.conf import settings as dj_settings
    from django.db import transaction

    if request.method != 'POST':
        return redirect('/campaigns/')
    ids = [int(x) for x in request.POST.getlist('ids') if x.isdigit()]
    ACTIVE_C = (Campaign.Status.QUEUED, Campaign.Status.RUNNING)
    NOT_FINAL_J = (TestJob.Status.CREATED, TestJob.Status.QUEUED,
                   TestJob.Status.RUNNING, TestJob.Status.CANCEL_REQUESTED)
    deleted, skipped = [], []
    hroot = Path(dj_settings.HTML_REPORT_ROOT)
    aroot = Path(dj_settings.ARTIFACT_ROOT)
    croot = Path(dj_settings.REPORT_ROOT)
    run_ids = set()
    with transaction.atomic():
        for cid in ids:
            c = Campaign.objects.filter(pk=cid).first()
            if c is None:
                continue
            if c.status in ACTIVE_C:
                skipped.append(f'#{cid}（{c.get_status_display()}，仅终态可删）')
                continue
            if c.jobs.filter(status__in=NOT_FINAL_J).exists():
                skipped.append(f'#{cid}（其下仍有排队/运行中的执行记录，请先等其结束或终止）')
                continue
            for j in c.jobs.all():
                dev = 'WAP' if j.device == 'wap' else 'PC'
                # HTML 报告目录：双端命名都清一遍（历史 device 与 RUN_ID 后缀不完全一致的兜底）
                for suffix in {dev, 'PC', 'WAP'}:
                    d = hroot / f'JOB-{j.pk:06d}-{suffix}'
                    if d.is_dir():
                        shutil.rmtree(d, ignore_errors=True)
                adir = aroot / f'JOB-{j.pk:06d}'
                if adir.is_dir():
                    shutil.rmtree(adir, ignore_errors=True)
                run_ids.add(f'JOB-{j.pk:06d}-{dev}')
                if ((j.result_summary or {}).get('run_id')):
                    run_ids.add(str(j.result_summary['run_id']))
                j.delete()
            # Campaign 汇总报告目录
            cdir = croot / f'CAMPAIGN-{cid:06d}'
            if cdir.is_dir():
                shutil.rmtree(cdir, ignore_errors=True)
            c.delete()
            deleted.append(cid)
    try:
        if run_ids:
            purge_run_dirs.delay(run_ids=sorted(run_ids))
    except Exception:
        pass
    if deleted:
        messages.success(request, f'已删除 {len(deleted)} 个执行任务（连带其执行记录、报告与工件）：' +
                         '、'.join(f'#{i}' for i in deleted[:8]) + ('…' if len(deleted) > 8 else ''))
    if skipped:
        messages.warning(request, f'{len(skipped)} 个未删除：' + '；'.join(skipped[:5]) + ('…' if len(skipped) > 5 else ''))
    return redirect('/campaigns/')


@login_required
def campaign_list(request):
    qs = Campaign.objects.all()[:100]
    for o in qs:
        o.first_report_url = _first_report(o)
        o.n_reports = sum(1 for j in o.jobs.all() if ((j.result_summary or {}).get('report') or {}).get('url'))
    has_active = Campaign.objects.filter(status__in=(Campaign.Status.RUNNING, Campaign.Status.QUEUED)).exists()
    return render(request, 'campaigns/list.html', {'objects': qs, 'has_active': has_active})

def _published_versions():
    """每个流程取最新已发布版本（2026-11-02 ian：停用流程不进发起测试列表）"""
    from apps.scenarios.models import ScenarioVersion
    published = (ScenarioVersion.objects.filter(status='published', scenario__enabled=True)
                 .select_related('scenario').order_by('scenario__code', '-version'))
    seen, out = set(), []
    for sv in published:
        if sv.scenario_id not in seen:
            seen.add(sv.scenario_id)
            out.append(sv)
    return out

def _parse_url_override(raw: str) -> str:
    raw = (raw or '').strip().rstrip('/')
    if raw and not raw.startswith(('http://', 'https://')):
        raise ValueError(f'域名覆盖必须是 http(s):// 开头: {raw}')
    return raw

# ---------- 环节地址临时覆盖（2026-10-20 ian：发起页点进用例环节查看/修改地址，仅当次 Campaign 生效） ----------
_PATH_FN_SCOPE = {'pcUrl': 'pc', 'wapUrl': 'wap', 'wapRoute': 'wap', 'bossUrl': 'boss', 'bossApi': 'bossApi'}

def _case_docs_map():
    """case_docs.json 的 code → case 映射（内置用例环节+地址数据源，与流程库/用例说明页同源）"""
    import json as _json
    from pathlib import Path
    f = Path(__file__).resolve().parents[1] / 'scenarios' / 'fixtures' / 'case_docs.json'
    try:
        docs = _json.loads(f.read_text(encoding='utf-8'))
        return {c.get('code'): c for c in docs.get('cases', [])}
    except Exception:
        return {}

def _scenario_steps(sv, docs_map):
    """用例环节列表：内置用例 = 源码扫描（含各环节地址与档案默认值）；页面创建用例 = 规范文本步骤（无固化地址）
    2026-10-23 ian：环节补 seq/total/prev/next，供发起页「流程板块」时间线渲染（板块间上下衔接）。
    """
    from apps.scenarios.flow_utils import chain_steps
    doc = docs_map.get(sv.scenario.code)
    if doc and doc.get('steps'):
        return chain_steps(doc['steps'])
    d = sv.definition or {}
    return chain_steps([{'id': str(s.get('id', '-')), 'name': s.get('name', ''), 'side': s.get('side', ''),
                         'expect': s.get('expect', ''), 'pages': [], 'doc': True}
                        for s in (d.get('doc_steps') or d.get('steps') or [])])

def _path_defaults(docs_map):
    """(fn, key) → 档案默认路径（含步骤级与用例级两处来源；含 '(站点档案未定义)' 的视为空）"""
    import re as _re
    defaults = {}
    for c in docs_map.values():
        for st in c.get('steps') or []:
            for pg in st.get('pages') or []:
                defaults[(pg.get('fn'), pg.get('key'))] = (pg.get('path') or '').strip()
        for call, p in (c.get('pages') or {}).items():
            m = _re.match(r'^(\w+)\(([\w-]+)\)$', call or '')
            if m:
                defaults.setdefault((m.group(1), m.group(2)),
                                    '' if (not p or str(p).startswith('(')) else str(p).strip())
    return defaults

def _collect_path_overrides(post, docs_map, checked_codes):
    """收集环节地址修改：path_<code>__<fn>__<key> → {'boss': {'weighIn': '/warehouse/goods-check'}}
    仅保留与档案默认不同的值（改回默认=不注入）。同一地址多处修改且不一致 → 取首个并提示。返回 (overrides, notes)。"""
    defaults = _path_defaults(docs_map)
    cand, notes = {}, []
    for fld in post:
        if not fld.startswith('path_'):
            continue
        parts = fld.split('__')
        if len(parts) != 4:
            continue
        _, code, fn, key = parts
        scope = _PATH_FN_SCOPE.get(fn)
        if not scope or code not in checked_codes:
            continue
        val = (post.get(fld) or '').strip()
        if not val:
            continue
        if scope == 'bossApi':
            val = val.lstrip('/')
        elif not val.startswith('/'):
            # 2026-10-21 ian 排障（JOB-000167）：手填路径常漏前导 /（如 warehouse/goods-check），
            # 原逻辑静默丢弃 → 覆盖没生效还无任何提示。改为自动补全 + 明确告知。
            val = '/' + val
            notes.append(f'「{key}」已自动补全前导斜杠：{val}')
        if not val or val == defaults.get((fn, key)):
            continue  # 与固化流程默认一致 → 视为未修改
        cand.setdefault((scope, key), []).append(val)
    out = {}
    for (scope, key), vals in cand.items():
        uniq = []
        for v in vals:
            if v not in uniq:
                uniq.append(v)
        out.setdefault(scope, {})[key] = uniq[0]
        if len(uniq) > 1:
            notes.append(f'{scope}.{key} 在多个用例填了不同地址（{"、".join(uniq)}），本次按「{uniq[0]}」执行')
    return out, notes

@login_required
def campaign_new(request):
    if request.method == 'POST':
        from apps.sites.models import Site
        from apps.scenarios.models import Scenario, ScenarioVersion
        site_ids = [int(x) for x in request.POST.getlist('site_ids')]
        scenario_ids = [int(x) for x in request.POST.getlist('scenario_ids')]
        # 非空校验（2026-09-24 修复：缺网站/用例时 Campaign 会展开 0 个 Job，永远卡在排队中）
        if not site_ids:
            messages.error(request, '发起失败：请至少勾选 1 个测试网站（左侧「网站」清单）。')
            return redirect('campaign_new')
        if not scenario_ids:
            messages.error(request, '发起失败：请至少勾选 1 个测试用例。')
            return redirect('campaign_new')
        ends = [e for e in request.POST.getlist('ends') if e in ('pc', 'wap')] or ['pc']
        name = request.POST.get('name') or f"Campaign {timezone.now():%Y-%m-%d %H:%M}"
        # 用例自定义设置：set_<code>_<key>（bool 用 checkbox）
        scenario_settings = {}
        for scid in scenario_ids:
            sc = Scenario.objects.get(pk=scid)
            sv = (ScenarioVersion.objects.filter(scenario=sc, status='published')
                  .order_by('-version').first())
            if sv is None:
                continue
            vals = {}
            for f in sv.settings_schema:
                raw = request.POST.get(f'set_{sc.code}_{f["key"]}')
                if f.get('type') == 'bool':
                    vals[f['key']] = bool(raw)
                elif f.get('type') == 'select':
                    choices = [str(c) for c in (f.get('choices') or [])]
                    v = (raw or f.get('default') or '').strip()
                    if not choices or v in choices:
                        vals[f['key']] = v
                elif f.get('type') == 'number':
                    v = (raw or '').strip() or str(f.get('default') or '')
                    try:
                        vals[f['key']] = str(max(int(float(f.get('min', v) or v)), min(int(float(f.get('max', 1e9) or v)), int(float(v)))))
                    except (ValueError, TypeError):
                        vals[f['key']] = str(f.get('default') or '')
                else:
                    if raw is not None:
                        vals[f['key']] = raw.strip()
            scenario_settings[sc.code] = vals
        try:
            url_overrides = {k: _parse_url_override(request.POST.get(f'override_{k}'))
                             for k in ('pc', 'wap', 'boss')}
            url_overrides = {k: v for k, v in url_overrides.items() if v}
        except ValueError as e:
            messages.error(request, str(e))
            return redirect('campaign_new')
        # 测试用例库选择（2026-10-08 ian：勾选指定素材条目；未勾=该类型随机抽取）
        library_selection = {}
        for k in ('keyword', 'image', 'link'):
            ids = [int(x) for x in request.POST.getlist(f'lib_{k}') if x.isdigit()]
            if ids:
                library_selection[k] = ids
        # 全链选品方向（2026-10-09 ian：关键词/链接/图片三方向；来源=用例库或手动填写）
        pick_mode = request.POST.get('pick_mode', '')
        if pick_mode not in ('keyword', 'link', 'image'):
            pick_mode = ''
        pick_source = 'manual' if request.POST.get('pick_source') == 'manual' else 'library'
        pick_manual = (request.POST.get('pick_manual') or '').strip()[:4000]
        pick_plan = {'mode': pick_mode, 'source': pick_source, 'manual': pick_manual} if pick_mode else {}
        # Policy 安全基线注入（2026-10-15 ian：规则包生效于测试流程）
        # 勾选的包 + 全部 locked 包（强制并入，安全基线不可绕过）→ plan.policies → runner 注入环境变量 + 报告呈现
        from apps.policies.models import PolicyPackVersion
        picked_policies = [c for c in request.POST.getlist('policy_codes') if c]
        locked_policies = list(PolicyPackVersion.objects.filter(locked=True).values_list('code', flat=True))
        policy_codes = sorted(set(picked_policies) | set(locked_policies))
        # 环节地址临时覆盖（2026-10-20 ian：发起页环节里改的地址仅本次 Campaign 生效，档案默认不变）
        docs_map = _case_docs_map()
        checked_codes = {Scenario.objects.get(pk=i).code for i in scenario_ids}
        path_overrides, path_notes = _collect_path_overrides(request.POST, docs_map, checked_codes)
        for n in path_notes:
            messages.warning(request, f'环节地址：{n}')
        c = Campaign.objects.create(
            name=name, created_by=request.user,
            plan={'site_ids': site_ids, 'scenario_ids': scenario_ids,
                  'ends': ends, 'locales': ['zh-cn'],
                  'scenario_settings': scenario_settings,
                  'url_overrides': url_overrides,
                  'library': library_selection,
                  'pick': pick_plan,
                  'policies': policy_codes,
                  'path_overrides': path_overrides})
        expand_campaign.delay(c.pk)
        ends_txt = '+'.join(e.upper() for e in ends)
        pov_txt = f'，环节地址覆盖 {sum(len(v) for v in path_overrides.values())} 项（仅本次生效）' if path_overrides else ''
        messages.success(request, f'Campaign #{c.pk} 已创建（{ends_txt} 双端各一 Job）并投递{pov_txt}')
        return redirect('campaign_detail', pk=c.pk)
    versions = _published_versions()
    docs_map = _case_docs_map()
    scenarios = [{'ver': sv,
                  'ends': sv.supported_ends(),
                  'spec': (sv.end_spec('pc') if 'pc' in sv.supported_ends() else sv.end_spec('wap')),
                  'settings': sv.settings_schema,
                  'steps': _scenario_steps(sv, docs_map)
                 }
                 for sv in versions]
    from apps.sites.models import Site
    from .views_library import _groups, _KIND_LABEL
    from apps.policies.models import PolicyPackVersion
    lib_groups = _groups()
    # 2026-11-04 ian：网站权重降序（权重高=显示靠前）→ 同权重按创建时间旧→新
    sites_qs = Site.objects.filter(enabled=True).order_by('-weight', 'created_at')
    return render(request, 'campaigns/new.html',
                  {'sites': sites_qs, 'scenarios': scenarios,
                   'lib_groups': lib_groups, 'lib_labels': _KIND_LABEL,
                   'lib_counts_enabled': {k: len([x for x in v if x.enabled]) for k, v in lib_groups.items()},
                   'policies': PolicyPackVersion.objects.all()})

@login_required
def campaign_detail(request, pk):
    c = get_object_or_404(Campaign, pk=pk)
    return render(request, 'campaigns/detail.html', {'obj': c, 'jobs': c.jobs.all().order_by('seq'),
                                                     'first_report': _first_report(c)})


@login_required
def campaign_progress(request, pk):
    """执行进展轮询端点（2026-09-24 ian：执行中心实时进度 + 预估剩余时间）"""
    from django.http import JsonResponse
    from django.utils import timezone
    camp = get_object_or_404(Campaign, pk=pk)
    jobs = []
    now = timezone.now()
    for j in TestJob.objects.filter(campaign_id=pk).order_by('seq'):
        p = j.progress or {}
        if j.started_at:
            _delta = ((j.finished_at or now) - j.started_at).total_seconds()
            elapsed = round(_delta, 1)
        else:
            elapsed = None
        jobs.append({'id': j.pk, 'status': j.status, 'device': j.device,
                     'progress': {'done': p.get('done', 0), 'total': p.get('total'),
                                  'current': p.get('current', ''), 'eta_sec': p.get('eta_sec'),
                                  'steps': p.get('steps', [])[-12:]},
                     'elapsed_sec': elapsed,
                     'report': bool((j.result_summary or {}).get('report')),
                     'report_url': ((j.result_summary or {}).get('report') or {}).get('url', ''),
                     'report_path': ((j.result_summary or {}).get('report') or {}).get('html', '')})
    c_elapsed = None
    if camp.started_at:
        c_elapsed = round(((camp.finished_at or now) - camp.started_at).total_seconds(), 1)
    return JsonResponse({'campaign': {'id': camp.pk, 'status': camp.status,
                                      'total': camp.total_jobs, 'finished': camp.finished_jobs,
                                      'passed': camp.passed_jobs, 'failed': camp.failed_jobs,
                                      'report_built': camp.report_built,
                                      'started_at': camp.started_at.strftime('%m-%d %H:%M:%S') if camp.started_at else '',
                                      'finished_at': camp.finished_at.strftime('%m-%d %H:%M:%S') if camp.finished_at else '',
                                      'elapsed_sec': c_elapsed},
                         'jobs': jobs})

@login_required
def job_detail(request, pk, job_id):
    from pathlib import Path
    from django.conf import settings as dj_settings
    job = get_object_or_404(TestJob, pk=job_id)
    art_dir = Path(dj_settings.ARTIFACT_ROOT) / f"JOB-{job.pk:06d}"
    files = sorted(p.name for p in art_dir.glob('*')) if art_dir.exists() else []
    report_url = ((job.result_summary or {}).get('report') or {}).get('url', '')
    error = (job.result_summary or {}).get('error', '')  # 2026-10-14 ian：失败原因一眼可见
    return render(request, 'campaigns/job.html', {'obj': job, 'art_files': files,
                                                  'art_prefix': f'/artifacts/JOB-{job.pk:06d}',
                                                  'report_url': report_url, 'error': error})

def _load_known_errors():
    """已知异常知识库（ian 2026-10-08：日志页对明显异常显示标识+错误解析）。
    数据源 = web-blackbox/scripts/known_errors.json（与报告生成器 gen-platform-report.py 共用）。"""
    import json as _json
    for p in ('/data/runner-scripts/known_errors.json',):
        try:
            return _json.load(open(p, encoding='utf-8')).get('errors', [])
        except Exception:
            continue
    return []


@login_required
def job_log(request, pk, job_id):
    # 完整执行日志（ian 2026-09-24：走了哪个网址、触发了哪一步、失败 URL 一眼可见）
    import re as _re
    job = get_object_or_404(TestJob, pk=job_id)
    raw_log = job.runner_log or ''
    urls = sorted(set(_re.findall(r'https?://[^\s<>]+', raw_log)))
    lines404 = [l.strip() for l in raw_log.split(chr(10)) if '404' in l or 'not found' in l.lower()][:40]
    # 已知异常识别（SSL 证书/网络/代理/服务端/框架类），命中即在页面顶部显示解析卡
    known_hits = []
    for it in _load_known_errors():
        try:
            if _re.search(it.get('pattern', ''), raw_log, _re.I):
                known_hits.append(it)
        except _re.error:
            continue
    return render(request, 'campaigns/job_log.html', {
        'obj': job, 'raw_log': raw_log, 'urls': urls, 'lines404': lines404,
        'steps': (job.progress or {}).get('steps', []),
        'known_hits': known_hits,
    })

@login_required
def job_retry(request, pk, job_id):
    job = get_object_or_404(TestJob, pk=job_id)
    if job.status in (TestJob.Status.FAILED, TestJob.Status.LOST):
        from .tasks import run_browser_job
        # 2026-10-13：清除可能残留的续跑标记——「重新执行」= 整条链路从头跑（会重新真实下单），
        # 与「从失败步骤继续」（job_resume 注入 FC_RESUME_FROM）严格互斥。
        _m = job.run_manifest or {}
        if 'FC_RESUME_FROM' in ((_m.get('dataset') or {}).get('vars') or {}):
            _ds = dict(_m.get('dataset') or {})
            _v2 = dict(_ds.get('vars') or {})
            _v2.pop('FC_RESUME_FROM', None)
            _ds['vars'] = _v2
            _m = dict(_m)
            _m['dataset'] = _ds
            job.run_manifest = _m
            job.save(update_fields=['run_manifest'])
        TestJob.objects.filter(pk=job.pk).update(status=TestJob.Status.QUEUED)
        run_browser_job.delay(job.pk)
        messages.success(request, f'JOB-{job.pk} 已重新投递（整条链路从头执行）')
    return redirect('campaign_job', pk=pk, job_id=job_id)


@login_required
def job_resume(request, pk, job_id):
    """断点续跑（2026-10-13 ian）：失败 Job 从上次失败的步骤继续——已成功步骤跳过（复用上轮
    订单/快递/包裹单据），不再从头重跑（旧「重试」= F2 重新真实下单支付，约 20-35 元/次）。
    ① 定位上轮 fullchain-result.json（web 容器未挂 runner 根，文件不可达时回退 DB progress.steps
    —— runner 每步回写、与 result json 同源）；② 存在且含 ok 步骤才放行；③ FC_RESUME_FROM
    （browser-worker 容器内路径）写入 run_manifest.dataset.vars（关键词/库勾选等原配置全保留）；
    ④ 置 QUEUED 并投递 browser 队列（与 job_retry 同管线）。spec 侧见 full-chain.spec.ts 断点续跑段。"""
    import json as _json
    from pathlib import Path as _Path
    from django.conf import settings as _settings
    job = get_object_or_404(TestJob, pk=job_id)
    back = redirect('campaign_job', pk=pk, job_id=job_id)
    if request.method != 'POST':
        messages.error(request, '续跑需通过页面「从失败步骤继续」按钮 POST 提交')
        return back
    if job.status not in (TestJob.Status.FAILED, TestJob.Status.LOST):
        messages.error(request, f'JOB-{job.pk:06d} 当前状态不支持续跑（仅「失败/失联」终态可续跑）')
        return back
    if job.device != 'pc' or job.scenario_code != 'full-chain':
        messages.error(request, f'JOB-{job.pk:06d} 暂不支持续跑（当前仅 PC 全链用例实现断点续跑），请用「重新执行」')
        return back
    run_id = f"JOB-{job.pk:06d}-{'WAP' if job.device == 'wap' else 'PC'}"
    ok_ids, src = [], ''
    # 候选根：runner 容器视角 /workspace/runner/output（web 容器无此挂载 → 落到宿主前缀，再不可达走 DB 回退）
    for root in (_Path(_settings.RUNNER_ROOT) / 'output',
                 _Path('/mnt500/www/wwwroot/onebuy_ceshi/web-blackbox/output')):
        if not root.is_dir():
            continue
        rf = root / run_id / 'fullchain-result.json'
        if not rf.is_file():
            break  # 根可见但无 result json：首轮未产出（早期即失败），不必再看其他候选
        try:
            data = _json.loads(rf.read_text(encoding='utf-8'))
        except Exception as e:
            messages.error(request, f'JOB-{job.pk:06d} 上轮 result json 解析失败（{e}），请用「重新执行」')
            return back
        ok_ids = [s.get('id') for s in (data.get('steps') or [])
                  if isinstance(s, dict) and s.get('status') == 'ok' and s.get('id')]
        src = str(rf)
        break
    if not src:
        # web 容器两个路径根均不可见 → DB progress.steps 回退（runner _track_progress 每步回写，同源可信）
        ok_ids = [s.get('id') for s in ((job.progress or {}).get('steps') or [])
                  if isinstance(s, dict) and s.get('status') == 'ok' and s.get('id')]
        src = 'DB progress.steps'
    if not ok_ids:
        messages.error(request, f'JOB-{job.pk:06d} 无可续跑步骤：未找到含成功步骤的 fullchain-result.json'
                                 '（上轮可能极早失败未产出单据），请用「重新执行」')
        return back
    m = dict(job.run_manifest or {})
    ds = dict(m.get('dataset') or {})
    vars_ = dict(ds.get('vars') or {})
    # 注入容器内路径：spec 在 browser-worker 执行（web-blackbox 挂载为 /workspace/runner）
    vars_['FC_RESUME_FROM'] = f'/workspace/runner/output/{run_id}/fullchain-result.json'
    ds['vars'] = vars_
    m['dataset'] = ds
    m['resume'] = {'ok_steps': ok_ids, 'src': src, 'at': timezone.now().isoformat(timespec='seconds')}
    job.run_manifest = m
    job.status = TestJob.Status.QUEUED
    job.save(update_fields=['run_manifest', 'status'])
    from .tasks import run_browser_job
    run_browser_job.delay(job.pk)
    messages.success(request, f'JOB-{job.pk:06d} 已从失败步骤续跑（跳过 {len(ok_ids)} 个已成功步骤：'
                              f'{"、".join(str(i) for i in ok_ids)}，复用上轮订单单据，不重复下单）')
    return back

@login_required
def campaign_cancel(request, pk):
    from .models import TestJob
    from .tasks import _campaign_tick
    # 2026-10-21 ian：支持终止运行中任务——未开跑的直接终态；运行中的置 cancel_requested，
    # runner 取消监测线程（3s 轮询）SIGTERM 测试进程，数秒内停止并按「已取消」收尾。
    qs = TestJob.objects.filter(campaign_id=pk)
    qs.filter(status__in=(TestJob.Status.CREATED, TestJob.Status.QUEUED)).update(
        status=TestJob.Status.CANCELLED, finished_at=timezone.now())
    n_run = qs.filter(status=TestJob.Status.RUNNING).update(status=TestJob.Status.CANCEL_REQUESTED)
    has_pending = qs.filter(status__in=(TestJob.Status.CREATED, TestJob.Status.QUEUED,
                                        TestJob.Status.RUNNING, TestJob.Status.CANCEL_REQUESTED)).exists()
    if has_pending:
        # 仍有非终态任务（含取消中）：Campaign 保持当前状态，等全部 Job 终态后由 tick 收尾
        messages.info(request, '终止请求已发出/生效中：运行中任务将在数秒内停止，'
                               'Campaign 将在全部任务停止后自动收尾（已完成步骤的截图/报告保留）。')
    else:
        # 无待终止任务（或全部已终态）：Campaign 直接置 CANCELLED，再 tick（已 CANCELLED 不会被覆盖，仅触发报告）
        Campaign.objects.filter(pk=pk, status__in=(Campaign.Status.CREATED, Campaign.Status.QUEUED,
                                                   Campaign.Status.RUNNING)).update(
            status=Campaign.Status.CANCELLED, finished_at=timezone.now())
        messages.success(request, '任务已全部停止/取消。')
    _campaign_tick(pk)
    return redirect('campaign_detail', pk=pk)

@login_required
def job_cancel(request, pk, job_id):
    """单 Job 终止（2026-10-21 ian：跑错站点/参数无需干等 40min 软限）。"""
    from .models import TestJob
    from .tasks import _campaign_tick
    if request.method != 'POST':
        return redirect('campaign_job', pk=pk, job_id=job_id)
    job = get_object_or_404(TestJob, pk=job_id, campaign_id=pk)
    if job.status in (TestJob.Status.CREATED, TestJob.Status.QUEUED):
        TestJob.objects.filter(pk=job.pk).update(status=TestJob.Status.CANCELLED,
                                                 finished_at=timezone.now())
        _campaign_tick(pk)
        messages.success(request, '任务尚未开跑，已直接取消。')
    elif job.status == TestJob.Status.RUNNING:
        TestJob.objects.filter(pk=job.pk).update(status=TestJob.Status.CANCEL_REQUESTED)
        messages.info(request, '已发出终止请求，测试进程将在数秒内停止（已完成步骤的截图/报告保留）。')
    elif job.status == TestJob.Status.CANCEL_REQUESTED:
        messages.info(request, '终止请求已在执行中，请稍候。')
    else:
        messages.warning(request, f'任务已是终态（{job.get_status_display()}），无需取消。')
    return redirect('campaign_job', pk=pk, job_id=job_id)
