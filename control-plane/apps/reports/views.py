import json, re, shutil
from datetime import datetime, timedelta
from pathlib import Path
from django.conf import settings
from django.contrib import messages
from django.contrib.auth.decorators import login_required, user_passes_test
from django.core.paginator import Paginator
from django.http import HttpResponse, FileResponse, Http404
from django.shortcuts import render, redirect

PAGE_SIZE = 15

NAME_RE = re.compile(r'^[\w.\-\u4e00-\u9fff]+$')

def _dir_mtime(p: Path) -> float:
    try:
        return p.stat().st_mtime
    except OSError:
        return 0.0

def _parse_date(s: str, end_of_day: bool = False):
    """'YYYY-MM-DD' → datetime；end_of_day=True 返回当天 23:59:59；非法返回 None"""
    try:
        d = datetime.strptime(s, '%Y-%m-%d')
        return d + timedelta(days=1, seconds=-1) if end_of_day else d
    except ValueError:
        return None

@login_required
def report_center(request):
    """报告中心：扫描 html-report 全部报告目录（含历史轮次），PHP 版 index.php 同款卡片浏览。
    JOB-xxxxxxx-PC/WAP 命名的目录自动关联平台 Job（端标识/用例/状态）。
    支持关键字搜索（RUN_ID/关联用例）、生成时间范围筛选、分页。"""
    from apps.campaigns.models import TestJob
    root = Path(settings.HTML_REPORT_ROOT)
    cards = []
    if root.exists():
        for d in sorted(root.iterdir(), reverse=True):
            if not d.is_dir() or d.name.startswith('.'):
                continue
            m = re.match(r'^JOB-(\d{6,})-(PC|WAP)$', d.name)
            job = TestJob.objects.filter(pk=int(m.group(1))).first() if m else None
            mt = _dir_mtime(d)
            cards.append({
                'name': d.name,
                'mtime': mt,
                'mtime_str': datetime.fromtimestamp(mt).strftime('%Y-%m-%d %H:%M') if mt else '-',
                'nshots': len(list((d / 'screenshots').glob('*.png'))) if (d / 'screenshots').exists() else 0,
                'has_index': (d / 'index.html').exists(),
                'has_md': (d / '测试结果报告.md').exists(),
                'end': m.group(2).lower() if m else '',
                'job': job,
            })
    cards.sort(key=lambda x: x['mtime'], reverse=True)

    # 下拉选项基于筛选前的全部报告生成（避免选了某类别后其余选项消失）
    from apps.scenarios.models import Scenario
    from apps.sites.models import Site
    seen_sc, seen_site = [], []
    for c in cards:
        j = c.get('job')
        if not j:
            continue
        if j.scenario_code and j.scenario_code not in seen_sc:
            seen_sc.append(j.scenario_code)
        if j.site_code and j.site_code not in seen_site:
            seen_site.append(j.site_code)
    sc_names = {s.code: s.name for s in Scenario.objects.filter(code__in=seen_sc)}
    site_names = {s.code: s.name for s in Site.objects.filter(code__in=seen_site)}
    scenario_opts = [(c, f'{sc_names.get(c, c)}（{c}）') for c in sorted(seen_sc)]
    site_opts = [(c, f'{site_names.get(c, c)}（{c}）') for c in sorted(seen_site)]

    # ---- 筛选：关键字（RUN_ID / 关联用例名） + 类别（用例） + 站点 + 生成时间范围 ----
    # 2026-11-05 ian：新增按类别（scenario_code）与网站站点（site_code）筛选（基于关联 TestJob）
    q = (request.GET.get('q') or '').strip()
    f_scenario = (request.GET.get('scenario') or '').strip()
    f_site = (request.GET.get('site') or '').strip()
    date_from = (request.GET.get('date_from') or '').strip()
    date_to = (request.GET.get('date_to') or '').strip()
    n_total = len(cards)
    if q:
        ql = q.lower()
        cards = [c for c in cards if ql in c['name'].lower()
                 or (c['job'] is not None and ql in str(c['job'].scenario_code or '').lower())]
    if f_scenario:
        cards = [c for c in cards if c['job'] is not None and c['job'].scenario_code == f_scenario]
    if f_site:
        cards = [c for c in cards if c['job'] is not None and c['job'].site_code == f_site]
    t0 = _parse_date(date_from)
    if t0:
        cards = [c for c in cards if c['mtime'] >= t0.timestamp()]
    t1 = _parse_date(date_to, end_of_day=True)
    if t1:
        cards = [c for c in cards if c['mtime'] <= t1.timestamp()]
    n_filtered = len(cards)

    # ---- 分页（每页 PAGE_SIZE 条）----
    paginator = Paginator(cards, PAGE_SIZE)
    page_obj = paginator.get_page(request.GET.get('page'))

    # 翻页/导出链接保留当前筛选参数
    params = request.GET.copy()
    params.pop('page', None)
    urlquery = params.urlencode()

    # Campaign 汇总报告（平台自动生成）
    camp_items = []
    croot = Path(settings.REPORT_ROOT)
    if croot.exists():
        for d in sorted(croot.iterdir(), reverse=True):
            if d.is_dir() and (d / 'campaign-report.json').exists():
                try:
                    camp_items.append(json.loads((d / 'campaign-report.json').read_text()))
                except Exception:
                    pass
    # 下拉选项：从实际有 Job 的报告中取出现过的 类别/站点（去重，时间倒序语义），配显示名
    return render(request, 'reports/center.html', {
        'cards': page_obj.object_list,
        'page_obj': page_obj,
        'urlquery': urlquery,
        'q': q, 'date_from': date_from, 'date_to': date_to,
        'f_scenario': f_scenario, 'f_site': f_site,
        'scenario_opts': scenario_opts, 'site_opts': site_opts,
        'n_total': n_total, 'n_filtered': n_filtered,
        'items': camp_items,
    })

@login_required
@user_passes_test(lambda u: u.is_superuser, login_url='/login/')
def report_delete(request):
    """删除选中的报告目录（物理删除，含 Campaign 汇总报告目录）。仅管理员。"""
    if request.method != 'POST':
        return redirect('report_center')
    names = request.POST.getlist('names')
    camps = request.POST.getlist('camp_dirs')
    root = Path(settings.HTML_REPORT_ROOT).resolve()
    croot = Path(settings.REPORT_ROOT).resolve()
    deleted, skipped = [], []
    for n in names:
        if not NAME_RE.match(n):
            skipped.append(n)
            continue
        p = (root / n).resolve()
        # 防路径穿越：必须仍在 root 下一层
        if p.parent == root and p.is_dir():
            try:
                shutil.rmtree(p)
                deleted.append(n)
            except OSError:
                # 目录内有不可删文件（如 root 属主文件）→ 跳过并提示，不中断请求
                skipped.append(n)
        else:
            skipped.append(n)
    cdeleted = []
    for n in camps:
        if not re.match(r'^CAMPAIGN-\d{6,}$', n):
            skipped.append(n)
            continue
        p = (croot / n).resolve()
        if p.parent == croot and p.is_dir():
            try:
                shutil.rmtree(p)
                cdeleted.append(n)
            except OSError:
                skipped.append(n)
        else:
            skipped.append(n)
    # 2026-10-27 连带清理 playwright 原始产物目录 output/<RUN_ID>/（仅 browser-worker 可写，异步清理；
    # purge_run_dirs 内部严格校验 JOB-xxx-(PC|WAP) 命名，非 Job 报告名自动跳过）
    try:
        if deleted:
            from apps.campaigns.tasks import purge_run_dirs
            purge_run_dirs.delay(run_ids=deleted)
    except Exception:
        pass
    if deleted or cdeleted:
        msg = f'已删除 {len(deleted)} 份测试报告' + (f'、{len(cdeleted)} 份 Campaign 汇总报告' if cdeleted else '')
        messages.success(request, msg + '：' + '、'.join((deleted + cdeleted)[:8]) + ('…' if len(deleted) + len(cdeleted) > 8 else ''))
    if skipped:
        messages.warning(request, f'{len(skipped)} 项未删除（不存在或非法名称）：' + '、'.join(skipped[:8]))
    return redirect('report_center')


def _safe_report_path(name: str, rest: str) -> Path:
    if not NAME_RE.match(name) or '..' in rest or rest.startswith('/') or rest.endswith('.php'):
        raise Http404
    p = Path(settings.HTML_REPORT_ROOT) / name / rest
    if not p.is_file():
        raise Http404
    return p

@login_required
def report_view(request, name, rest='index.html'):
    """鉴权访问报告静态文件（nginx X-Accel-Redirect 内部跳转），支持 index.html + screenshots/* + 伴随 md。
    ⚠ X-Accel-Redirect 规范：上游显式设置 Content-Type 时 nginx 沿用不猜——所以必须按扩展名
    给全 Content-Type，否则 HttpResponse() 默认 text/html 会让截图在浏览器渲染成乱码（2026-11-02 ian）。"""
    _safe_report_path(name, rest)
    from urllib.parse import quote
    ct = {
        '.html': 'text/html; charset=utf-8',
        '.md': 'text/markdown; charset=utf-8',
        '.png': 'image/png',
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
        '.json': 'application/json',
        '.txt': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8',
    }.get(Path(rest).suffix.lower(), 'application/octet-stream')
    resp = HttpResponse(content_type=ct)
    # 中文文件名（测试结果报告.md）必须 percent-encode，否则 nginx internal redirect 404
    resp['X-Accel-Redirect'] = f"/protected-html/{quote(name)}/{quote(rest)}"
    return resp

@login_required
def campaign_report_file(request, campaign_id, name):
    p = Path(settings.REPORT_ROOT) / f"CAMPAIGN-{campaign_id:06d}" / name
    if not p.exists() or '..' in name:
        raise Http404
    if name.endswith('.md'):
        return HttpResponse(p.read_text(encoding='utf-8'), content_type='text/plain; charset=utf-8')
    return FileResponse(p.open('rb'))
