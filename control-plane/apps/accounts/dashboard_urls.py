from django.urls import path
from django.contrib.auth.decorators import login_required, user_passes_test
from django.shortcuts import render

@login_required
def dashboard(request):
    from apps.campaigns.models import Campaign, TestJob
    from apps.sites.models import Site
    from apps.scenarios.models import Scenario, ScenarioVersion
    # 最近测试用例（含支持端 + 最近三次运行记录）
    scenarios = []
    for sc in Scenario.objects.order_by('code'):
        ver = (ScenarioVersion.objects.filter(scenario=sc, status='published')
               .order_by('-version').first())
        scenarios.append({
            'sc': sc,
            'ver': ver,
            'ends': ver.supported_ends() if ver else [],
            'spec': (ver.end_spec('pc') if ver and 'pc' in ver.supported_ends()
                     else (ver.end_spec('wap') if ver else '')),
            'settings_n': len(ver.settings_schema) if ver else 0,
            'latest': list(TestJob.objects.filter(scenario_code=sc.code)
                           .select_related('campaign').order_by('-pk')[:3]),
        })
    ctx = {
        'site_count': Site.objects.count(),
        'scenario_count': Scenario.objects.count(),
        'campaign_count': Campaign.objects.count(),
        'job_total': TestJob.objects.count(),
        'job_passed': TestJob.objects.filter(status=TestJob.Status.PASSED).count(),
        'job_failed': TestJob.objects.filter(status=TestJob.Status.FAILED).count(),
        'job_running': TestJob.objects.filter(status=TestJob.Status.RUNNING).count(),
        'recent_campaigns': Campaign.objects.all()[:8],
        'recent_jobs': (TestJob.objects.select_related('campaign')
                        .order_by('-pk')[:12]),
        'scenarios': scenarios,
    }
    return render(request, 'dashboard.html', ctx)

urlpatterns = [path('', dashboard, name='dashboard')]


@login_required
@user_passes_test(lambda u: u.is_staff, login_url='/login/')
def admin_frame(request):
    """Django Admin 框架内嵌页（2026-09-29 ian：管理后台沿用平台布局，不再独立跳页）"""
    return render(request, 'admin_frame.html')

urlpatterns += [path('admin-frame/', admin_frame, name='admin_frame')]
