import re

from django.contrib import messages
from django.contrib.auth.decorators import login_required
from django.shortcuts import render, get_object_or_404, redirect
from django.urls import reverse
from django.utils import timezone
from .models import Scenario, ScenarioVersion

# ---- 流程库筛选标签（2026-11-04 ian）：购物链路 / 后台环节 ----
_SHOP_RE = re.compile(r'购物车|加购|下单|订单|支付|付款|收银台|结算|购买|选品|cart|order|pay', re.I)
_BACKEND_RE = re.compile(r'后台|采购|入库|称重|发货|物流|快递|admin|boss|weigh|purchase|shipment', re.I)


def _back_to_cases(code=None):
    """2026-11-04 ian：流程管理操作（改名/权重/停用/删除）完成后留在流程库卡片页（/scenarios/cases/），
    带 ?stay=1#case-<code> 锚点回到所操作的卡片但不自动弹详情窗；不再跳转旧表格列表页。"""
    url = reverse('scenario_cases')
    if code:
        url += '?stay=1#case-' + code
    return redirect(url)


@login_required
def scenario_list(request):
    """流程库（2026-10-15 ian：详细讲述每个流程 + 说明引用了哪些测试用例）
    每个流程卡片 = 流程详述（步骤明细）+ 引用测试用例区块：
      - 内置流程 → 引用源码扫描用例（case_docs.json 同 code 条目）
      - 页面创建流程 → 引用「规范文本创建」的测试用例（自身 definition）
    """
    import json
    from pathlib import Path
    from apps.scenarios.flow_utils import chain_steps
    f = Path(__file__).resolve().parent / 'fixtures' / 'case_docs.json'
    try:
        docs = json.loads(f.read_text())
    except Exception:
        docs = {'cases': [], 'generated_at': '-', 'site_id': '-'}
    scan_cases = {c['code']: c for c in docs.get('cases', [])}

    flows = []
    # 2026-11-04 ian：设了权重(weight>0)的按权重降序排前；未设权重的按创建时间新→旧排后
    for sc in Scenario.objects.order_by('-weight', '-created_at'):
        v = sc.versions.order_by('-version').first()
        d = v.definition if v else {}
        is_doc = bool(d.get('doc_created'))
        ends = v.supported_ends() if v else ['pc']
        spec = d.get('runner_spec', '') or next(iter((d.get('ends') or {}).values()), '')

        steps, ref_cases, pages, reusable = [], [], {}, None
        if is_doc:
            # 页面创建流程：引用的测试用例 = 通过「规范文本」创建的用例自身
            steps = d.get('steps') or d.get('doc_steps') or []
            ref_cases.append({
                'code': sc.code, 'name': sc.name, 'source': '页面创建',
                'impl': d.get('doc_impl') or ('auto-v1 自动执行' if d.get('doc_actions') else 'skeleton 骨架'),
                'step_count': len(steps), 'desc': d.get('description', ''),
                'spec': spec, 'settings': d.get('settings', []),
            })
        else:
            # 内置流程：引用源码扫描生成的测试用例说明
            c = scan_cases.get(sc.code)
            if c:
                steps = c.get('steps') or []
                pages = c.get('pages') or {}
                reusable = ((c.get('checks') or {}).get('reusable'))
                entries = c.get('entries') or {}
                ref_cases.append({
                    'code': c['code'], 'name': c['name'], 'source': '源码扫描',
                    'impl': 'spec 源码实现',
                    'step_count': len(steps), 'desc': c.get('desc', ''),
                    'spec': entries.get('pc') or entries.get('wap') or '',
                    'settings': [],
                })
        steps = chain_steps(steps)  # 2026-10-23 ian：步骤板块上下衔接（seq/total/prev/next）
        flows.append({
            'pk': sc.pk, 'code': sc.code, 'name': sc.name, 'ends': ends,
            'desc': d.get('description') or sc.description or sc.name,
            'enabled': sc.enabled, 'version': v.version if v else 0,
            'weight': sc.weight, 'created_at': sc.created_at,
            'status': v.get_status_display() if v else '-', 'is_doc': is_doc,
            'steps': steps, 'ref_cases': ref_cases, 'spec': spec,
            'pages': pages, 'reusable': reusable,
            'mutating': d.get('mutating'), 'requires_auth': d.get('requires_auth'),
        })
    meta = {'generated_at': docs.get('generated_at', '-'), 'site_id': docs.get('site_id', '-'),
            'total': len(flows), 'built_in': sum(1 for x in flows if not x['is_doc']),
            'doc': sum(1 for x in flows if x['is_doc']),
            'step_total': sum(len(x['steps']) for x in flows)}
    for f in flows:  # 2026-11-02 ian：流程总览精简（列表一行一流程，点行弹窗看详情）
        f['brief'] = _flow_brief(f['steps'])
    return render(request, 'scenarios/list.html', {'flows': flows, 'meta': meta})


# ---- 流程库管理：改名 / 启停 / 删除（2026-11-02 ian）----
@login_required
def scenario_rename(request, pk):
    sc = get_object_or_404(Scenario, pk=pk)
    if request.method == 'POST':
        name = (request.POST.get('name') or '').strip()
        if not name:
            messages.error(request, '流程名称不能为空。')
        elif len(name) > 200:
            messages.error(request, '流程名称最长 200 字。')
        else:
            old = sc.name
            sc.name = name
            sc.updated_at = timezone.now()
            sc.save(update_fields=['name', 'updated_at'])
            messages.success(request, f'流程「{sc.code}」名称已修改：{old} → {name}')
    return _back_to_cases(sc.code)


@login_required
def scenario_weight(request, pk):
    """2026-11-04 ian：流程展示权重设置。0/空 = 未设置（按创建时间倒序）；>0 数值越大越靠前。"""
    sc = get_object_or_404(Scenario, pk=pk)
    if request.method == 'POST':
        raw = (request.POST.get('weight') or '').strip()
        try:
            w = int(raw) if raw else 0
        except ValueError:
            w = -1
        if w < 0 or w > 9999:
            messages.error(request, '权重须为 0~9999 的整数（0 或留空 = 不设权重，按创建时间倒序排列）。')
        else:
            old = sc.weight
            sc.weight = w
            sc.updated_at = timezone.now()
            sc.save(update_fields=['weight', 'updated_at'])
            if w:
                messages.success(request, f'流程「{sc.code}」权重已设置为 {w}（原 {old}）——权重数值越大越靠前。')
            else:
                messages.success(request, f'流程「{sc.code}」权重已取消（原 {old}）——恢复按创建时间倒序排列。')
    return _back_to_cases(sc.code)


@login_required
def scenario_toggle(request, pk):
    sc = get_object_or_404(Scenario, pk=pk)
    sc.enabled = not sc.enabled
    sc.updated_at = timezone.now()
    sc.save(update_fields=['enabled', 'updated_at'])
    if sc.enabled:
        messages.success(request, f'流程「{sc.code}」已启用——发起测试页恢复可见、可发起。')
    else:
        messages.warning(request, f'流程「{sc.code}」已停用——发起测试页不再显示该流程（历史记录不受影响）。')
    return _back_to_cases(sc.code)


@login_required
def scenario_delete(request, pk):
    sc = get_object_or_404(Scenario, pk=pk)
    code = sc.code
    ver_count = sc.versions.count()
    sc.versions.all().delete()  # ScenarioVersion FK 为 PROTECT，需先删版本
    sc.delete()
    messages.warning(request, f'流程「{code}」已删除（含 {ver_count} 个历史版本，不可恢复）。历史测试记录中的流程编码保留为文本。')
    return _back_to_cases()


# ---- 流程总览精简（2026-11-02 ian）----
_BRIEF_RULES = [
    ('进入详情', r'详情|detail'),
    ('搜索', r'搜索|检索|关键词|search'),
    ('登录', r'登录|登陆|login'),
    ('打开首页', r'首页|home'),
    ('加入购物车', r'加购|加入购物车|add.{0,3}cart'),
    ('查看购物车', r'购物车|cart'),
    ('收藏商品', r'收藏|favorite'),
    ('选品下单', r'选品|下单|确认订单|提交订单|place.{0,3}order'),
    ('支付', r'支付|付款|pay'),
    ('后台采购', r'采购|purchase'),
    ('入库称重', r'称重|入库|weigh|goods.{0,3}check'),
    ('发货物流', r'发货|物流|快递|express|shipment'),
    ('查看订单', r'订单'),
    ('文本断言', r'断言|文本|出现|包含'),
    ('页面跳转', r'跳转|goto|路径'),
    ('后台管理', r'后台|boss|admin'),
]


def _brief_step(name: str) -> str:
    """单步 name → ≤6 字短词（意图词典优先，兜底截前 6 字）"""
    n = name or ''
    for label, pat in _BRIEF_RULES:
        if re.search(pat, n, re.I):
            if label == '搜索':  # 搜索尽量带上关键词：「搜索鞋子」
                m = (re.search(r'[“"「]([^”"」]{1,12})[”"」]', n)
                     or re.search(r'输入([^,。,,\s]{1,12}?)(?:并|后|点击|，|$)', n))
                return '搜索' + (m.group(1) if m else '')
            return label
    return (n.replace('点击', '').replace('打开', '')[:6] or n[:6] or '步骤')


def _flow_brief(steps: list) -> str:
    """全流程精简总览：短词 → 连接，相邻去重，超 4 步截断。"""
    out = []
    for s in steps:
        b = _brief_step(s.get('name'))
        if not out or out[-1] != b:
            out.append(b)
    if not out:
        return ''
    if len(out) > 4:
        return ' → '.join(out[:4]) + f' … 共{len(steps)}步'
    return ' → '.join(out)

@login_required
def scenario_detail(request, pk):
    """用例详情（二期增强）：ai_created 用例显示 AI 干跑入口 + 最近干跑 Campaign + 最近失败现场 + 探索记录。"""
    from apps.sites.models import Site
    from .models import ExploreRun
    obj = get_object_or_404(Scenario, pk=pk)
    sv = obj.versions.order_by('-version').first()
    is_ai = bool(sv and sv.definition.get('ai_created'))
    dry_runs, fail_jobs, explore_runs = [], [], []
    if is_ai:
        from apps.campaigns.models import Campaign, TestJob
        dry_runs = Campaign.objects.filter(plan__ai_dry_run=True, name__endswith=f'·{obj.code}').order_by('-id')[:5]
        fail_jobs = list(TestJob.objects.filter(scenario_code=obj.code,
                                                status=TestJob.Status.FAILED).order_by('-id')[:2])
        explore_runs = ExploreRun.objects.filter(code=obj.code)[:5]
    return render(request, 'scenarios/detail.html', {
        'obj': obj, 'versions': obj.versions.order_by('-version'),
        'is_ai': is_ai, 'sites': Site.objects.filter(enabled=True).order_by('id'),
        'dry_runs': dry_runs, 'fail_jobs': fail_jobs, 'explore_runs': explore_runs,
        'fail_evidence': _job_step_evidence(obj.code) if is_ai else [],
    })


def _job_step_evidence(scenario_code: str, limit: int = 2) -> list:
    """提取该用例最近失败 Job 的逐步失败现场（junit.xml failure message + runner_log 尾部）。
   JUnit testcase name 即步骤标题（如「S1 [PC] 登录前台」），failure message 含断言差异/超时详情。"""
    import xml.etree.ElementTree as ET
    from pathlib import Path
    from django.conf import settings
    from apps.campaigns.models import TestJob
    ev = []
    for j in TestJob.objects.filter(scenario_code=scenario_code, status=TestJob.Status.FAILED).order_by('-id')[:limit]:
        junit = Path(settings.ARTIFACT_ROOT) / f'JOB-{j.pk:06d}' / 'junit.xml'
        n_step = 0
        if junit.exists():
            try:
                root = ET.parse(junit).getroot()
                for tc in root.iter('testcase'):
                    f = tc.find('failure')
                    if f is None:
                        continue
                    name = (tc.get('name') or '').strip()
                    msg = ((f.get('message') or '') + ' ' + (f.text or '')).strip()
                    ev.append({'job': j.pk, 'id': name.split(' ')[0] if name else '-',
                               'action': '', 'name': name, 'expect': '', 'ok': False,
                               'error': msg[:280], 'note': '', 'url': ''})
                    n_step += 1
            except Exception:
                pass
        tail = (j.runner_log or '')[-500:]
        ev.append({'job': j.pk, 'id': 'LOG', 'action': '', 'name': f'Job #{j.pk} runner_log 尾部',
                   'expect': '', 'ok': False, 'error': tail, 'note': f'步骤级失败 {n_step} 条', 'url': ''})
    return ev[:12]


@login_required
def scenario_replan(request, pk):
    """基于干跑失败现场 AI 修正用例计划（二期干跑闭环第二步）→ 渲染可编辑预览（rescue 模式：确认后生成 vN+1）。"""
    from apps.sites.models import Site
    from .models import AiConfig
    from . import action_registry as ar
    from .ai_client import AiClientError
    from . import ai_planner
    sc = get_object_or_404(Scenario, pk=pk)
    sv = sc.versions.order_by('-version').first()
    if sv is None:
        messages.error(request, '该用例没有版本')
        return redirect('scenario_detail', pk=pk)
    if not AiConfig.get_solo().ready:
        messages.error(request, 'Agent 未启用，无法 AI 修正')
        return redirect('scenario_detail', pk=pk)
    site = Site.objects.filter(pk=request.POST.get('site_pk') or 0, enabled=True).first()         or Site.objects.filter(enabled=True).first()
    d = sv.definition
    plan = {'name': sc.name, 'description': d.get('description', ''),
            'requires_auth': bool(d.get('requires_auth')),
            'case_text': d.get('doc_source_text', ''),
            'steps': d.get('doc_steps') or d.get('steps') or []}
    evidence = _job_step_evidence(sc.code)
    try:
        new_plan = ai_planner.replan(plan, evidence, site)
    except AiClientError as e:
        messages.error(request, f'AI 修正失败：{e}')
        return redirect('scenario_detail', pk=pk)
    new_plan['code_suggest'] = sc.code
    reg_map = {r['action']: r for r in ar.REGISTRY}
    return render(request, 'scenarios/ai_create.html', {
        'cfg': AiConfig.get_solo(),
        'sites': Site.objects.filter(enabled=True).order_by('id'),
        'actions': ar.REGISTRY, 'reg_map': reg_map,
        'case_text': new_plan.get('case_text', ''),
        'site_pk': str(site.pk) if site else '',
        'plan': new_plan, 'site': site,
        'rescue_pk': sc.pk, 'rescue_code': sc.code,
    })


@login_required
def case_docs(request):
    """用例说明页：每用例步骤/页面明细 + 完整性/多网站复用性检查（数据源 tools/gen_case_docs.py 生成的 fixtures/case_docs.json）"""
    import json
    from pathlib import Path
    f = Path(__file__).resolve().parent / 'fixtures' / 'case_docs.json'
    docs = json.loads(f.read_text()) if f.exists() else None

    # 合并「页面创建」的用例（2026-09-26 ian：新增用例入口，创建后即时展示）
    # 2026-10-15 ian：宫格卡片布局 + 详情弹窗数据（创建文案原文 / 自动生成规则与步骤）
    doc_cases = []
    # 2026-11-04 ian：流程管理操作（发起/改名/停用/删除）迁移到本页卡片——补 pk/enabled/version
    sc_map = {sc.code: sc for sc in Scenario.objects.prefetch_related('versions')}
    for sc in Scenario.objects.order_by('-weight', '-created_at'):
        sv = sc.versions.order_by('-version').first()
        if not sv or not sv.definition.get('doc_created'):
            continue
        d = sv.definition
        steps_raw = d.get('steps') or d.get('doc_steps') or []
        # 2026-11-04 ian：筛选标签（购物/后台）+ 时间戳（创建/更新）——用于流程库筛选与排序
        flow_text = ' '.join(filter(None, [
            d.get('description', ''), sc.name,
            *(f"{s.get('name', '')} {s.get('expect', '')}" for s in steps_raw)]))
        doc_cases.append({
            'pk': sc.pk,
            'enabled': sc.enabled, 'version': sv.version, 'weight': sc.weight,
            'code': sc.code, 'name': sc.name, 'desc': d.get('description', ''),
            'ends': sv.supported_ends(), 'entries': d.get('ends') or {}, 'pages': {},
            'spec': d.get('runner_spec', ''),
            'impl': d.get('doc_impl') or ('auto-v1' if d.get('doc_actions') else 'skeleton'),
            'source_text': d.get('doc_source_text', ''),
            'source_rebuilt': bool(d.get('doc_source_rebuilt')),
            'actions': d.get('doc_actions') or {},
            'shop': bool(_SHOP_RE.search(flow_text)),
            'backend': bool(_BACKEND_RE.search(flow_text)),
            'auth': bool(d.get('requires_auth')),
            'created_ts': int(sc.created_at.timestamp()),
            'updated_ts': int((sc.updated_at or sc.created_at).timestamp()),
            'created_at': sc.created_at, 'updated_at': sc.updated_at or sc.created_at,
            # 步骤 + 自动识别动作原语合并（2026-10-15：详情弹窗单层渲染）
            'steps': [
                {'id': s.get('id', '-'), 'name': s.get('name', ''),
                 'side': s.get('side', ''), 'expect': s.get('expect', ''),
                 'action': ((d.get('doc_actions') or {}).get(s.get('id', '-')) or {}).get('action', ''),
                 'ok': ((d.get('doc_actions') or {}).get(s.get('id', '-')) or {}).get('ok'),
                 'note': ((d.get('doc_actions') or {}).get(s.get('id', '-')) or {}).get('note', '')}
                for s in (d.get('steps') or d.get('doc_steps') or [])],
            'checks': {'doc_created': True, 'reusable': None,
                       'mutating': d.get('mutating'), 'requires_auth': d.get('requires_auth'),
                       'settings': d.get('settings', [])},
        })
    if docs is None:
        docs = {'site_id': '-', 'generated_at': '-', 'cases': []}
    # 源码扫描用例：关联 DB 流程（无对应 Scenario 的 spec 不显示管理按钮）
    for c in docs.get('cases', []):
        sc = sc_map.get(c.get('code'))
        if sc:
            vv = [x for x in sc.versions.all()]
            c['pk'] = sc.pk
            c['enabled'] = sc.enabled
            c['weight'] = sc.weight
            c['version'] = max((x.version for x in vv), default=0)
            c['created_ts'] = int(sc.created_at.timestamp())
            c['updated_ts'] = int((sc.updated_at or sc.created_at).timestamp())
            c['created_at'] = sc.created_at
            c['updated_at'] = sc.updated_at or sc.created_at
        else:
            c['pk'] = None
            c['created_ts'] = 0
            c['updated_ts'] = 0
        # 2026-11-04 ian：筛选标签（端/登录/购物/后台）——文本匹配步骤与描述
        scan_text = ' '.join(filter(None, [
            c.get('desc', ''), c.get('name', ''),
            *(f"{s.get('name', '')} {s.get('expect', '')}" for s in (c.get('steps') or []))]))
        c['ends'] = c.get('ends') or ['pc']
        c['auth'] = bool((c.get('checks') or {}).get('requires_auth'))
        c['shop'] = bool(_SHOP_RE.search(scan_text))
        c['backend'] = bool(_BACKEND_RE.search(scan_text))

    # 2026-11-04 ian：全局合并排序——源码扫描 + 页面创建统一按（权重降序, 创建时间降序）排列，
    # 修复此前两组卡片分开渲染导致权重只在组内生效的问题（w=999 在 scan 组、w=100 在 doc 组互相看不见）
    def _card_key(item):
        c = item['c']
        return (-(c.get('weight') or 0), -(c.get('created_ts') or 0))
    all_cards = ([{'c': c, 'src': 'scan'} for c in docs.get('cases', [])]
                 + [{'c': c, 'src': 'doc'} for c in doc_cases])
    all_cards.sort(key=_card_key)
    docs['all_cards'] = all_cards
    docs['doc_cases'] = doc_cases
    docs['total_count'] = len(all_cards)
    return render(request, 'scenarios/cases.html', {'docs': docs})


@login_required
def case_create(request):
    """按规范文本自动创建测试用例（2026-09-26 ian）：GET 展示规范+输入框，POST 解析并保存草稿版本"""
    from .case_parser import parse_case_text
    if request.method == 'POST':
        text = request.POST.get('case_text', '')
        data, errors = parse_case_text(text)
        if errors:
            return render(request, 'scenarios/case_form.html',
                          {'errors': errors, 'case_text': text}, status=400)
        if Scenario.objects.filter(code=data['code']).exists():
            return render(request, 'scenarios/case_form.html',
                          {'errors': [f'用例标识 `{data["code"]}` 已被占用，请换一个'], 'case_text': text},
                          status=400)
        sc = Scenario.objects.create(code=data['code'], name=data['name'])
        spec_rel = f"tests/doc-{data['code']}.spec.ts"
        definition = {
            # 入口指向自动生成的 spec 骨架（每步 test.skip 待实现：有截图+API 捕获留证但不计通过，补全后即真实执行）
            'ends': {e: spec_rel for e in data['ends']},
            'actions': ['__legacy_spec__'],
            'mutating': data['mutating'],
            'settings': data['settings'],
            'description': data['desc'],
            'runner_spec': spec_rel,
            'requires_auth': data['requires_auth'],
            'doc_created': True,
            'doc_steps': data['steps'],
            # 2026-10-15 ian：保存创建时的原始规范文案（用例说明页详情弹窗展示）
            'doc_source_text': text.strip(),
        }
        # 创建即发布（ian 2026-09-27：页面创建的用例要能直接在发起测试中勾选执行）
        ScenarioVersion.objects.create(scenario=sc, version=1,
                                       status=ScenarioVersion.Status.PUBLISHED,
                                       definition=definition, created_by=request.user)
        # 生成 spec 骨架文件（browser-worker 写入 web-blackbox/tests/）
        from .tasks import generate_doc_spec
        generate_doc_spec.delay(sc.pk)
        ends_txt = '+'.join(e.upper() for e in data['ends'])
        messages.success(request,
                         f'测试用例 `{sc.code}` 已创建并发布（v1，{len(data["steps"])} 步，{ends_txt}）——'
                         f'可在「发起测试」勾选执行；骨架步骤仅首页可达性留证并标记 skipped（未补全前执行将计为失败·骨架未实现），补全实现后即真实测试')
        return redirect('scenario_detail', pk=sc.pk)
    return render(request, 'scenarios/case_form.html', {})



@login_required
def ai_case_create(request):
    """AI 口语建用例（2026-10-30 ian 一期）：站点+口语 → Agent 规划 → 预览编辑 → 创建发布。
    action=parse 调 AI 规划；action=create 从预览表单重组步骤创建（不再调 AI）。
    完成率设计：规划 action 过注册表白名单，白名单外显式 unknown 降级占位（不假绿）。"""
    import re as _re
    from datetime import datetime
    from .models import AiConfig
    from . import action_registry as ar
    from .ai_client import AiClientError
    from . import ai_planner
    from apps.sites.models import Site

    cfg = AiConfig.get_solo()
    sites = Site.objects.filter(enabled=True).order_by('id')
    reg_map = {r['action']: r for r in ar.all_registry()}

    if request.method == 'GET':
        return render(request, 'scenarios/ai_create.html', {
            'cfg': cfg, 'sites': sites, 'actions': ar.all_registry(), 'reg_map': reg_map,
        })

    action = request.POST.get('action', '')
    site_pk = request.POST.get('site_pk', '')
    case_text = request.POST.get('case_text', '').strip()

    def _ctx(extra=None):
        base = {'cfg': cfg, 'sites': sites, 'actions': ar.all_registry(), 'reg_map': reg_map,
                'case_text': case_text, 'site_pk': site_pk}
        base.update(extra or {})
        return base

    if action == 'parse':
        site = sites.filter(pk=site_pk).first() if site_pk else None
        if site is None:
            messages.error(request, '请选择目标站点')
            return render(request, 'scenarios/ai_create.html', _ctx(), status=400)
        if not case_text:
            messages.error(request, '请输入口语描述')
            return render(request, 'scenarios/ai_create.html', _ctx(), status=400)
        if not cfg.ready:
            messages.error(request, 'Agent 未接入或未启用：请先在「AI 接入设置」完成配置并启用')
            return render(request, 'scenarios/ai_create.html', _ctx(), status=400)
        try:
            plan = ai_planner.plan(case_text, site)
        except AiClientError as e:
            messages.error(request, f'AI 规划失败：{e}')
            return render(request, 'scenarios/ai_create.html', _ctx(), status=502)
        plan['code_suggest'] = 'ai-' + datetime.now().strftime('%m%d-%H%M')
        return render(request, 'scenarios/ai_create.html', _ctx({'plan': plan, 'site': site}))
    if action == 'autopilot':
        """一键自动闭环（2026-11-05 ian）：站点+口语 → AI 规划 → 自动探索 → 失败自动 AI 修正再探索
        （最多 2 轮修正）→ 自动创建并发布用例。人工零介入，跳过预览表单。"""
        site = sites.filter(pk=site_pk).first() if site_pk else None
        if site is None:
            messages.error(request, '请选择目标站点')
            return render(request, 'scenarios/ai_create.html', _ctx(), status=400)
        if not case_text:
            messages.error(request, '请输入口语描述')
            return render(request, 'scenarios/ai_create.html', _ctx(), status=400)
        if not cfg.ready:
            messages.error(request, 'Agent 未接入或未启用：请先在「AI 接入设置」完成配置并启用')
            return render(request, 'scenarios/ai_create.html', _ctx(), status=400)
        try:
            plan = ai_planner.plan(case_text, site)
        except AiClientError as e:
            messages.error(request, f'AI 规划失败：{e}')
            return render(request, 'scenarios/ai_create.html', _ctx(), status=502)
        plan['code_suggest'] = 'ai-' + datetime.now().strftime('%m%d-%H%M')
        plan['auto_pilot'] = True       # 失败自动 replan + 再探索
        plan['auto_create'] = True      # 收尾自动创建并发布用例
        plan['ai_model'] = cfg.model
        from .models import ExploreRun
        from .tasks import run_ai_explore
        er = ExploreRun.objects.create(
            site=site, code=plan['code_suggest'][:60], plan=plan, created_by=request.user)
        run_ai_explore.delay(er.pk)
        messages.success(
            request,
            f'自动闭环 {er.report_dir} 已启动：AI 规划 {len(plan["steps"])} 步 → 自动实走 {site.code} → '
            f'失败自动修正再探索（最多 2 轮）→ 自动建用例发布。全程无需人工介入，本页每 5 秒自动刷新进度。')
        return redirect('scenario_explore_detail', pk=er.pk)

    if action == 'explore':
        """预览页发起探索验证：把计划交给 browser-worker 实走真实站点取证。"""
        site = sites.filter(pk=site_pk).first() if site_pk else None
        if site is None or not case_text:
            messages.error(request, '请先选择站点并填写口语描述')
            return redirect('scenario_case_ai_create')
        steps = _collect_steps_from_form(request.POST, ar)
        if not steps:
            messages.error(request, '没有可探索的步骤')
            return redirect('scenario_case_ai_create')
        from .models import ExploreRun
        from .tasks import run_ai_explore
        er = ExploreRun.objects.create(
            site=site, code=request.POST.get('code', '').strip()[:60],
            plan={'name': request.POST.get('name', '').strip()[:80],
                  'description': request.POST.get('description', '').strip()[:300],
                  'requires_auth': request.POST.get('requires_auth') == 'on',
                  'ends': [e for e in ('pc', 'wap') if request.POST.get(f'end_{e}') == 'on'] or ['pc'],
                  'case_text': case_text,
                  'code_suggest': request.POST.get('code', '').strip()[:60],
                  'steps': steps},
            created_by=request.user)
        run_ai_explore.delay(er.pk)
        messages.success(request, f'探索 {er.report_dir} 已发起：browser-worker 将实走 {site.code} 验证 {len(steps)} 步')
        return redirect('scenario_explore_detail', pk=er.pk)

    if action == 'create':
        site = sites.filter(pk=site_pk).first() if site_pk else None
        name = request.POST.get('name', '').strip()[:80] or 'AI 口语用例'
        code = _re.sub(r'[^a-z0-9-]', '', request.POST.get('code', '').strip().lower())
        errors = []
        if site is None:
            errors.append('请选择目标站点')
        if not _re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', code or ''):
            errors.append('用例标识必须为小写字母/数字/连字符')
        elif Scenario.objects.filter(code=code).exclude(pk=request.POST.get('rescue_pk', '').strip() or None).exists():
            errors.append(f'用例标识 `{code}` 已被占用（修正模式下应保持原标识不变）')
        ends = [e for e in ('pc', 'wap') if request.POST.get(f'end_{e}') == 'on'] or ['pc']
        # 重组步骤行（与预览表单 st_<i>_* 字段一一对应，与 explore 共用）
        steps = _collect_steps_from_form(request.POST, ar)
        if not steps:
            errors.append('没有可保存的步骤（请先「AI 解析」生成步骤）')
        if errors:
            for e in errors:
                messages.error(request, e)
            return redirect('scenario_case_ai_create')

        rescue_pk = request.POST.get('rescue_pk', '').strip()
        if rescue_pk:
            # 修正模式：升级既有用例为新版本（vN+1，published），不新建用例
            from django.db.models import Max
            rsc = Scenario.objects.filter(pk=rescue_pk).first()
            if rsc is None:
                messages.error(request, f'修正目标用例不存在（pk={rescue_pk}）')
                return redirect('scenario_case_ai_create')
            next_ver = (rsc.versions.aggregate(m=Max('version'))['m'] or 0) + 1
            spec_rel = f'tests/doc-{rsc.code}.spec.ts'
            definition = {
                'ends': {e: spec_rel for e in ends},
                'actions': ['__legacy_spec__'],
                'mutating': any(s['action'] in ar.MUTATING_ACTIONS for s in steps),
                'settings': [],
                'description': request.POST.get('description', '').strip()[:300],
                'runner_spec': spec_rel,
                'requires_auth': request.POST.get('requires_auth') == 'on',
                'doc_created': True,
                'doc_steps': steps,
                'doc_source_text': case_text,
                'ai_created': True,
                'ai_model': cfg.model,
            }
            ScenarioVersion.objects.create(scenario=rsc, version=next_ver,
                                           status=ScenarioVersion.Status.PUBLISHED,
                                           definition=definition, created_by=request.user)
            if name and name != rsc.name:
                rsc.name = name
                rsc.save(update_fields=['name'])
            from .tasks import generate_doc_spec
            generate_doc_spec.delay(rsc.pk)
            n_real = sum(1 for s in steps if s['action'] in ar.executable_actions_all())
            messages.success(request,
                             f'用例 `{rsc.code}` 已按 AI 修正升级为 v{next_ver}（{len(steps)} 步：真实可执行 {n_real} / 待实现 {len(steps) - n_real}）——spec 后台重新生成，可再次「AI 干跑」验证')
            return redirect('scenario_detail', pk=rsc.pk)
        spec_rel = f'tests/doc-{code}.spec.ts'
        definition = {
            'ends': {e: spec_rel for e in ends},
            'actions': ['__legacy_spec__'],
            'mutating': any(s['action'] in ar.MUTATING_ACTIONS for s in steps),
            'settings': [],
            'description': request.POST.get('description', '').strip()[:300],
            'runner_spec': spec_rel,
            'requires_auth': request.POST.get('requires_auth') == 'on',
            'doc_created': True,
            'doc_steps': steps,
            'doc_source_text': case_text,
            'ai_created': True,
            'ai_model': cfg.model,
        }
        sc = Scenario.objects.create(code=code, name=name)
        ScenarioVersion.objects.create(scenario=sc, version=1,
                                       status=ScenarioVersion.Status.PUBLISHED,
                                       definition=definition, created_by=request.user)
        from .tasks import generate_doc_spec
        generate_doc_spec.delay(sc.pk)
        n_real = sum(1 for s in steps if s['action'] in ar.executable_actions_all())
        ends_txt = '+'.join(e.upper() for e in ends)
        messages.success(
            request,
            f'AI 用例 `{sc.code}` 已创建并发布（v1，{len(steps)} 步：真实可执行 {n_real} / 待实现 {len(steps) - n_real}，{ends_txt}）'
            f'——spec 正在后台生成，可在「发起测试」勾选执行')
        return redirect('scenario_detail', pk=sc.pk)

    return redirect('scenario_case_ai_create')


@login_required
def ai_create_stream(request):
    """AI 建用例流式解析（2026-11-04 ian）：SSE 逐 token 推送模型输出到页面输出区。
    POST 参数同 parse（site_pk + case_text）。事件流：
      event:reasoning/delta → 增量文本；event:stats → 用量；
      event:done → {html: 服务端渲染的预览编辑态整块 HTML, steps: 步数}（前端整体替换）；
      event:error → 面向用户的错误消息。
    校验规则与 parse 分支一致；校验失败返回 400 JSON（前端在输出区显示）。"""
    import json as _json
    from datetime import datetime
    from django.http import StreamingHttpResponse, JsonResponse
    from django.template.loader import render_to_string
    from .models import AiConfig
    from . import action_registry as ar
    from . import ai_planner
    from apps.sites.models import Site

    if request.method != 'POST':
        return JsonResponse({'error': '仅支持 POST'}, status=405)

    def _bad(msg, status=400):
        return JsonResponse({'error': msg}, status=status)

    site_pk = request.POST.get('site_pk', '')
    case_text = (request.POST.get('case_text') or '').strip()
    site = Site.objects.filter(enabled=True, pk=site_pk).first() if site_pk else None
    if site is None:
        return _bad('请选择目标站点')
    if not case_text:
        return _bad('请输入口语描述')
    if not AiConfig.get_solo().ready:
        return _bad('Agent 未接入或未启用：请先在「AI 接入设置」完成配置并启用')

    def _sse(etype, payload):
        # 统一 JSON 编码（含 str payload）：换行/特殊字符被转义，保证 SSE 帧单行安全
        data = _json.dumps(payload, ensure_ascii=False)
        return f'event: {etype}\ndata: {data}\n\n'

    def _gen():
        try:
            for etype, payload in ai_planner.plan_stream(case_text, site):
                if etype == 'done':
                    plan = payload
                    plan['code_suggest'] = 'ai-' + datetime.now().strftime('%m%d-%H%M')
                    ctx = {
                        'plan': plan, 'site': site,
                        'sites': Site.objects.filter(enabled=True).order_by('id'),
                        'actions': ar.all_registry(),
                        'reg_map': {r['action']: r for r in ar.all_registry()},
                        'case_text': case_text, 'site_pk': site_pk,
                    }
                    html = render_to_string('scenarios/_ai_plan_form.html', ctx, request=request)
                    yield _sse('done', {'html': html, 'steps': len(plan.get('steps') or []),
                                        'plan_name': plan.get('name', '')})
                else:
                    yield _sse(etype, payload)
        except Exception as e:   # 未预见异常兜底：流不至于静默断掉
            yield _sse('error', f'AI 解析异常：{e}')

    resp = StreamingHttpResponse(_gen(), content_type='text/event-stream')
    resp['Cache-Control'] = 'no-cache'
    resp['X-Accel-Buffering'] = 'no'   # nginx 代理不缓冲，保证 token 级实时
    return resp


@login_required
def ai_config(request):
    """AI 接入设置（2026-10-30 ian）：OpenAI 兼容协议（DeepSeek 同款），key 不回显留空保留。
    action=test 用表单当前值做连通性探测（未保存也能测）。"""
    from django.utils import timezone
    from .models import AiConfig
    from .ai_client import test_connection

    cfg = AiConfig.get_solo()
    if request.method == 'POST':
        act = request.POST.get('action', 'save')
        # 表单 → 临时配置对象（key 留空 = 沿用已存值）
        probe = AiConfig(
            base_url=request.POST.get('base_url', cfg.base_url).strip() or cfg.base_url,
            api_key=request.POST.get('api_key', '').strip() or cfg.api_key,
            model=request.POST.get('model', cfg.model).strip() or cfg.model,
            temperature=float(request.POST.get('temperature') or cfg.temperature),
            timeout_sec=int(request.POST.get('timeout_sec') or cfg.timeout_sec),
            max_tokens=int(request.POST.get('max_tokens') or cfg.max_tokens),
        )
        if act == 'test':
            ok, msg = test_connection(probe)
            cfg.last_test_ok, cfg.last_test_msg = ok, msg[:290]
            cfg.last_test_at = timezone.now()
            cfg.save(update_fields=['last_test_ok', 'last_test_msg', 'last_test_at'])
            (messages.success if ok else messages.error)(request, f'连接测试：{msg}')
            return redirect('scenario_ai_config')
        # save
        cfg.base_url, cfg.model = probe.base_url, probe.model
        if request.POST.get('api_key', '').strip():
            cfg.api_key = probe.api_key
        cfg.temperature, cfg.timeout_sec, cfg.max_tokens = probe.temperature, probe.timeout_sec, probe.max_tokens
        cfg.enabled = request.POST.get('enabled') == 'on'
        cfg.save()
        messages.success(request, f'AI 接入配置已保存（{"已启用" if cfg.enabled else "未启用"}，key{"已更新" if request.POST.get("api_key", "").strip() else "保持不变"}）')
        return redirect('scenario_ai_config')
    return render(request, 'scenarios/ai_config.html', {'cfg': cfg, 'has_key': bool(cfg.api_key)})


# ============ AI 口语建用例二期（2026-11 ian）：探索验证 / 干跑闭环 / 配方沉淀 ============

def _collect_steps_from_form(post, registry) -> list:
    """从 ai-create 预览表单重组 doc_steps（create 与 explore 共用）。"""
    steps, i = [], 1
    while post.get(f'st_{i}_exists') == '1':
        a = post.get(f'st_{i}_action', '').strip()
        st = {
            'id': f'S{i}',
            'side': 'WAP' if post.get(f'st_{i}_side') == 'wap' else 'PC',
            'action': a if a in registry.by_action_all() else 'unknown',
            'params': {},
            'name': post.get(f'st_{i}_name', '').strip()[:120] or f'步骤 {i}',
            'expect': post.get(f'st_{i}_expect', '').strip()[:200],
        }
        if st['action'] != 'unknown':
            for k in registry.param_spec(st['action']):
                v = post.get(f'st_{i}_p_{k}', '').strip()
                if v:
                    st['params'][k] = v[:80]
        else:
            st['ai_action_raw'] = post.get(f'st_{i}_raw', '').strip()[:40] or st['name'][:40]
        steps.append(st)
        i += 1
    return steps


@login_required
def scenario_explore_detail(request, pk):
    """探索运行详情：轮询状态 → 结果逐步回显（ok/error/url/截图）→ AI 修正计划 / 沉淀配方 / 重跑。"""
    from datetime import datetime
    from .models import AiConfig, ExploreRun, ActionRecipe
    from . import action_registry as ar
    from . import ai_planner
    from .ai_client import AiClientError

    er = get_object_or_404(ExploreRun, pk=pk)
    if request.method == 'POST':
        act = request.POST.get('action', '')
        if act == 'rerun':
            er.status, er.result, er.error, er.finished_at = 'created', None, '', None
            er.save(update_fields=['status', 'result', 'error', 'finished_at'])
            from .tasks import run_ai_explore
            run_ai_explore.delay(er.pk)
            messages.success(request, f'探索 {er.report_dir} 已重新发起')
            return redirect('scenario_explore_detail', pk=er.pk)
        if act == 'recipe':
            n = 0
            for s in (er.result or {}).get('steps') or []:
                rc = s.get('recipe') or {}
                if rc.get('clicked_text'):
                    intent = f"{s.get('name', '')}（{s.get('expect', '')}）"[:190] or rc.get('intent', '')[:190]
                    ActionRecipe.objects.create(
                        action_name=f"pending-{er.pk:06d}-{s.get('id', 'x').lower()}",
                        intent=intent,
                        evidence={'step': s.get('id'), **rc, 'shot': s.get('shot', '')},
                        explore=er)
                    n += 1
            (messages.success if n else messages.warning)(
                request, f'已沉淀 {n} 条候选配方' if n else '没有可沉淀的候选配方（仅启发式点击成功的步骤可沉淀）')
            return redirect('scenario_explore_detail', pk=er.pk)
        if act == 'manual':
            # 2026-11-04 ian：人工修正入口——不调 AI，直接把当前计划放进可编辑预览页，
            # 由人补/改动作与参数（如 fill_form 的字段值、click_text 的按钮文本）后再探索/建用例。
            plan = dict(er.plan or {})
            plan['code_suggest'] = plan.get('code_suggest') or ('ai-' + datetime.now().strftime('%m%d-%H%M'))
            reg_map = {r['action']: r for r in ar.all_registry()}
            return render(request, 'scenarios/ai_create.html', {
                'cfg': AiConfig.get_solo(),
                'sites': __import__('apps.sites.models', fromlist=['Site']).Site.objects.filter(enabled=True).order_by('id'),
                'actions': ar.all_registry(), 'reg_map': reg_map,
                'case_text': plan.get('case_text', ''),
                'site_pk': str(er.site.pk),
                'plan': plan, 'site': er.site,
                'from_explore': er.pk, 'manual_fix': True,
            })
        if act == 'replan':
            if not AiConfig.get_solo().ready:
                messages.error(request, 'Agent 未启用，无法 AI 修正')
                return redirect('scenario_explore_detail', pk=er.pk)
            steps = (er.result or {}).get('steps') or []
            plan_steps = {s.get('id'): s for s in (er.plan or {}).get('steps') or []}
            evidence = []
            for s in steps:
                ps = plan_steps.get(s.get('id')) or {}
                evidence.append({k: s.get(k) or ps.get(k) or ''
                                 for k in ('id', 'action', 'name', 'expect', 'ok', 'error', 'note', 'url',
                                           'page_links')})
            try:
                plan = ai_planner.replan(er.plan or {}, evidence, er.site)
            except AiClientError as e:
                messages.error(request, f'AI 修正失败：{e}')
                return redirect('scenario_explore_detail', pk=er.pk)
            plan['code_suggest'] = ((er.plan or {}).get('code_suggest') or 'ai-' + datetime.now().strftime('%m%d-%H%M'))
            reg_map = {r['action']: r for r in ar.all_registry()}
            return render(request, 'scenarios/ai_create.html', {
                'cfg': AiConfig.get_solo(),
                'sites': __import__('apps.sites.models', fromlist=['Site']).Site.objects.filter(enabled=True).order_by('id'),
                'actions': ar.all_registry(), 'reg_map': reg_map,
                'case_text': plan.get('case_text', ''),
                'site_pk': str(er.site.pk),
                'plan': plan, 'site': er.site,
                'from_explore': er.pk,
            })
    steps = (er.result or {}).get('steps') or []
    return render(request, 'scenarios/explore_detail.html', {'er': er, 'steps': steps})


@login_required
def action_recipes(request):
    """动作配方库：探索沉淀的候选 → 人工核准（填正式原语名）/弃用。
    三期（2026-11 ian）：核准即生效——url_after 固化为相对路径，动态并入注册表，
    AI 规划词汇表变宽、spec 按 goto_path 等价真实执行，无需改 docflow.ts。"""
    from urllib.parse import urlparse
    from .models import ActionRecipe
    from . import action_registry as ar
    if request.method == 'POST':
        rid = request.POST.get('rid', '')
        rec = ActionRecipe.objects.filter(pk=rid).first()
        if rec:
            act = request.POST.get('do', '')
            if act == 'approve':
                import re as _re
                name = _re.sub(r'[^a-z0-9_]', '', request.POST.get('action_name', '').strip().lower())
                ev = dict(rec.evidence or {})
                # 从 url_after 提取相对路径（含 query，页面可能靠参数渲染）；仅接受同站路径
                ua = str(ev.get('url_after') or '')
                p = urlparse(ua)
                path = ((p.path or '') + (('?' + p.query) if p.query else '')).strip()
                if not name:
                    messages.error(request, '核准必须填写正式原语名（小写字母/数字/下划线）')
                elif not path.startswith('/'):
                    messages.error(request, f'证据缺少可固化的目标路径（url_after={ua or "无"}），无法核准为可执行原语')
                elif name in ar.BY_ACTION or (ActionRecipe.objects.exclude(pk=rec.pk)
                                              .filter(status=ActionRecipe.Status.APPROVED, action_name=name).exists()):
                    messages.error(request, f'原语名 `{name}` 与现有原语/配方冲突，请换一个名字')
                else:
                    ev['path'] = path
                    rec.action_name, rec.status, rec.evidence = name, ActionRecipe.Status.APPROVED, ev
                    rec.save(update_fields=['action_name', 'status', 'evidence', 'updated_at'])
                    messages.success(request,
                                     f'配方 {rec.pk} 已核准为 `{name}`（目标页 {path}）——'
                                     f'已即时进入 AI 规划词汇表，生成的 spec 按「登录后直达该页」真实执行')
            elif act == 'reject':
                rec.status = ActionRecipe.Status.REJECTED
                rec.save(update_fields=['status', 'updated_at'])
                messages.info(request, f'配方 {rec.pk} 已弃用')
    approved_count = ActionRecipe.objects.filter(status=ActionRecipe.Status.APPROVED).count()
    return render(request, 'scenarios/recipes.html',
                  {'recipes': ActionRecipe.objects.all()[:200], 'approved_count': approved_count})


@login_required
def scenario_dry_run(request, pk):
    """AI 干跑（2026-11 二期）：单用例快速发起一次真实执行（单站点单端 Campaign），跑完回本页看结果做重规划。"""
    from apps.sites.models import Site
    from apps.campaigns.models import Campaign
    from apps.campaigns.tasks import expand_campaign
    sc = get_object_or_404(Scenario, pk=pk)
    sv = sc.versions.order_by('-version').first()
    if sv is None or sv.status != ScenarioVersion.Status.PUBLISHED:
        messages.error(request, '该用例没有已发布版本，无法干跑')
        return redirect('scenario_detail', pk=pk)
    site = Site.objects.filter(pk=request.POST.get('site_pk') or 0, enabled=True).first() \
        or Site.objects.filter(enabled=True).first()
    if site is None:
        messages.error(request, '没有可用站点')
        return redirect('scenario_detail', pk=pk)
    c = Campaign.objects.create(
        name=f'AI干跑·{sc.code}·{site.code}',
        created_by=request.user,
        plan={'site_ids': [site.pk], 'scenario_ids': [sc.pk], 'ends': ['pc'], 'locales': ['zh-cn'],
              'ai_dry_run': True})
    expand_campaign.delay(c.pk)
    messages.success(request, f'AI 干跑已发起：Campaign #{c.pk}（{site.code}·PC，真实执行含写操作）——完成后回本页「AI 修正」')
    return redirect('campaign_detail', pk=c.pk)
