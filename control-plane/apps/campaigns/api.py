from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from django.http import JsonResponse
from .models import Campaign, TestJob, NotifySetting

@api_view(['GET'])
@permission_classes([IsAuthenticated])
def campaign_get(request, pk):
    c = Campaign.objects.filter(pk=pk).first()
    if not c:
        return JsonResponse({'error': 'not found'}, status=404)
    return Response({'id': c.pk, 'name': c.name, 'status': c.status, 'total_jobs': c.total_jobs,
                     'finished_jobs': c.finished_jobs, 'passed_jobs': c.passed_jobs, 'failed_jobs': c.failed_jobs})

@api_view(['GET'])
@permission_classes([IsAuthenticated])
def actions_list(request):
    from .manifest import ALLOWED_ACTIONS
    return Response({'actions': sorted(ALLOWED_ACTIONS)})

@api_view(['GET'])
@permission_classes([IsAuthenticated])
def job_artifacts(request, pk):
    job = TestJob.objects.filter(pk=pk).first()
    if not job:
        return JsonResponse({'error': 'not found'}, status=404)
    return Response({'job': job.pk, 'status': job.status, 'summary': job.result_summary})


@api_view(['POST'])
@permission_classes([])
def campaign_trigger(request):
    """外部触发发起 Campaign（2026-10-21 ian：飞书/Hermes/CI 集成）。
    Header: X-Api-Token（= settings.API_TRIGGER_TOKEN；未配置令牌=功能禁用）
    Body JSON: {"name"?: str, "site_codes": ["shop-v2"], "scenario_codes": ["public-smoke"],
                "ends"?: ["pc"], "pick_mode"?: "keyword|link|image", "pick_source"?: "library|manual",
                "pick_manual"?: str, "policy_codes"?: [...]}
    返回 {"campaign_id", "total_jobs"}。"""
    from django.conf import settings as dj_settings
    from django.utils import timezone
    from apps.sites.models import Site
    from apps.scenarios.models import Scenario, ScenarioVersion
    from .tasks import expand_campaign
    from django.contrib.auth import get_user_model
    token = (request.headers.get('X-Api-Token') or '').strip()
    if not dj_settings.API_TRIGGER_TOKEN:
        return JsonResponse({'error': 'API_TRIGGER_TOKEN 未配置，外部触发已禁用'}, status=403)
    if token != dj_settings.API_TRIGGER_TOKEN:
        return JsonResponse({'error': 'invalid token'}, status=401)
    body = request.data or {}
    site_codes = [str(x).strip() for x in (body.get('site_codes') or []) if str(x).strip()]
    sc_codes = [str(x).strip() for x in (body.get('scenario_codes') or []) if str(x).strip()]
    ends = [e for e in (body.get('ends') or ['pc']) if e in ('pc', 'wap')] or ['pc']
    if not site_codes or not sc_codes:
        return JsonResponse({'error': 'site_codes 与 scenario_codes 必填（非空数组）'}, status=400)
    site_ids = list(Site.objects.filter(code__in=site_codes, enabled=True).values_list('pk', flat=True))
    scenario_ids = []
    for code in sc_codes:
        sc = Scenario.objects.filter(code=code).first()
        if sc and ScenarioVersion.objects.filter(scenario=sc, status='published').exists():
            scenario_ids.append(sc.pk)
    if not site_ids or not scenario_ids:
        return JsonResponse({'error': f'有效站点 {len(site_ids)}/{len(site_codes)}，有效已发布用例 '
                                       f'{len(scenario_ids)}/{len(sc_codes)}（核对 code 与启用/发布状态）'}, status=400)
    pick = {}
    if body.get('pick_mode') in ('keyword', 'link', 'image'):
        pick = {'mode': body['pick_mode'], 'source': body.get('pick_source') or 'library',
                'manual': str(body.get('pick_manual') or '')[:4000]}
    u = get_user_model().objects.filter(is_superuser=True).order_by('pk').first()
    plan = {'site_ids': site_ids, 'scenario_ids': scenario_ids, 'ends': ends,
            'scenario_settings': {}, 'library': {}, 'policies': list(body.get('policy_codes') or []),
            'locales': ['zh-cn']}
    if pick:
        plan['pick'] = pick
    c = Campaign.objects.create(
        name=str(body.get('name') or f'API 触发 {timezone.now():%Y-%m-%d %H:%M}').strip()[:200],
        plan=plan, created_by=u)
    expand_campaign.delay(c.pk)
    return Response({'campaign_id': c.pk, 'total_jobs': c.total_jobs,
                     'detail_url': f"{NotifySetting.get_base_url()}/campaigns/{c.pk}/"}, status=201)
