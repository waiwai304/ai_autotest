"""失败热点聚合页（2026-10-21 ian：哪一步最容易挂、哪个站点/用例失败最多——步骤级聚合统计）。"""
from datetime import timedelta
from django.contrib.auth.decorators import login_required
from django.db.models import Count, Q
from django.shortcuts import render
from django.utils import timezone
from .models import TestJob


@login_required
def insights(request):
    try:
        days = max(1, min(365, int(request.GET.get('days') or 30)))
    except ValueError:
        days = 30
    since = timezone.now() - timedelta(days=days)
    jobs = list(TestJob.objects.filter(started_at__gte=since).exclude(
        status__in=(TestJob.Status.QUEUED, TestJob.Status.CREATED, TestJob.Status.CANCEL_REQUESTED)))

    total = len(jobs)
    n_passed = sum(1 for j in jobs if j.status == TestJob.Status.PASSED)
    n_failed = sum(1 for j in jobs if j.status == TestJob.Status.FAILED)

    # 步骤级聚合：(scenario, step_id) → fail/出现次数/最近错误样本
    step_stats = {}
    for j in jobs:
        for s in ((j.progress or {}).get('steps') or []):
            key = (j.scenario_code, s.get('id') or '?')
            d = step_stats.setdefault(key, {'fail': 0, 'hit': 0, 'last_error': '', 'last_job': None,
                                            'last_site': '', 'last_at': None})
            if s.get('status') == 'fail':
                d['fail'] += 1
                d['hit'] += 1
                err = ((j.result_summary or {}).get('error') or '').strip()
                if err:
                    d['last_error'] = err
                d['last_job'] = j.pk
                d['last_site'] = j.site_code
                d['last_at'] = j.started_at
            elif s.get('status') == 'ok':
                d['hit'] += 1
    hot_steps = sorted(({'scenario': k[0], 'step': k[1], **v} for k, v in step_stats.items()
                        if v['fail'] > 0), key=lambda x: -x['fail'])[:20]

    # 站点 / 用例维度（失败 Job 计数）
    by_site = (TestJob.objects.filter(started_at__gte=since)
               .values('site_code').annotate(total=Count('id'),
               failed=Count('id', filter=Q(status=TestJob.Status.FAILED)),
               passed=Count('id', filter=Q(status=TestJob.Status.PASSED))).order_by('-failed'))
    by_scenario = (TestJob.objects.filter(started_at__gte=since)
                   .values('scenario_code', 'device').annotate(total=Count('id'),
                   failed=Count('id', filter=Q(status=TestJob.Status.FAILED)),
                   passed=Count('id', filter=Q(status=TestJob.Status.PASSED))).order_by('-failed'))

    # 用例完成率（三期 2026-11 ian）：按用例聚合 通过率 / 步骤完成度 / 平均耗时 / 最近结果
    case_stats = {}
    for j in jobs:
        d = case_stats.setdefault(j.scenario_code, {
            'total': 0, 'passed': 0, 'failed': 0, 'sum_sec': 0, 'sum_dur': 0,
            'step_ok': 0, 'step_hit': 0, 'last_status': '', 'last_at': None,
            'last_job': None, 'last_site': ''})
        d['total'] += 1
        if j.status == TestJob.Status.PASSED:
            d['passed'] += 1
        elif j.status == TestJob.Status.FAILED:
            d['failed'] += 1
        st, fi = j.started_at, j.finished_at
        if st and fi and fi >= st:
            d['sum_sec'] += int((fi - st).total_seconds())
            d['sum_dur'] += 1
        for s in ((j.progress or {}).get('steps') or []):
            d['step_hit'] += 1
            if s.get('status') == 'ok':
                d['step_ok'] += 1
        if d['last_at'] is None or (j.started_at and j.started_at > d['last_at']):
            d['last_status'] = j.status
            d['last_at'] = j.started_at
            d['last_job'] = j.pk
            d['last_site'] = j.site_code
    case_rates = []
    for code, v in case_stats.items():
        v['scenario'] = code
        v['pass_rate'] = round(v['passed'] * 100 / v['total'], 1) if v['total'] else None
        v['avg_sec'] = round(v['sum_sec'] / v['sum_dur']) if v['sum_dur'] else None
        v['step_rate'] = round(v['step_ok'] * 100 / v['step_hit'], 1) if v['step_hit'] else None
        case_rates.append(v)
    case_rates.sort(key=lambda x: (-(x['pass_rate'] if x['pass_rate'] is not None else -1), x['scenario']))

    return render(request, 'campaigns/insights.html', {
        'days': days, 'total': total, 'n_passed': n_passed, 'n_failed': n_failed,
        'pass_rate': round(n_passed * 100 / total, 1) if total else None,
        'hot_steps': hot_steps, 'by_site': by_site, 'by_scenario': by_scenario,
        'case_rates': case_rates,
    })
