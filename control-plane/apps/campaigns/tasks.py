import json, os
from datetime import timedelta
from django.conf import settings
from django.db import transaction
from django.utils import timezone
from celery import shared_task, group
from .models import Campaign, TestJob
from .manifest import build_manifest, ManifestError
from .runner import run as run_playwright, RunnerFailure

@shared_task(name='campaigns.tasks.expand_campaign')
def expand_campaign(campaign_id: int):
    campaign = Campaign.objects.get(pk=campaign_id)
    plan = campaign.plan or {}
    site_ids = plan.get('site_ids', [])
    scenario_ids = plan.get('scenario_ids', [])
    # 双端：plan.ends 决定本轮跑哪些端（pc/wap），实际按用例 supported_ends 取交集
    # 2026-10-16 ian：默认只选 PC（发起页 wap 不再默认勾选）
    ends = [e for e in (plan.get('ends') or ['pc']) if e in ('pc', 'wap')] or ['pc']
    locales = plan.get('locales', ['zh-cn'])
    scenario_settings = plan.get('scenario_settings') or {}
    from apps.sites.models import Site
    from apps.scenarios.models import ScenarioVersion
    jobs = []
    seq = 0
    for sid in site_ids:
        site = Site.objects.get(pk=sid)
        for scid in scenario_ids:
            sv = ScenarioVersion.objects.filter(scenario_id=scid, status='published').order_by('-version').first()
            if sv is None:
                continue
            job_ends = [e for e in ends if e in sv.supported_ends()] or sv.supported_ends()[:1]
            vars_ = sv.merged_settings(scenario_settings.get(sv.scenario.code))
            dataset = {'vars': vars_}
            for end in job_ends:
                for loc in locales:
                    seq += 1
                    key = f"camp{campaign_id}-s{sid}-sc{scid}-{end}-{loc}"
                    job, _ = TestJob.objects.get_or_create(
                        idempotency_key=key,
                        defaults=dict(campaign=campaign, seq=seq, site_code=site.code,
                                      scenario_code=sv.scenario.code, device=end, locale=loc),
                    )
                    try:
                        job.run_manifest = build_manifest(job, site, sv, dataset, end=end)
                        job.status = TestJob.Status.QUEUED
                        job.save(update_fields=['run_manifest', 'status'])
                        jobs.append(job.pk)
                    except ManifestError as e:
                        job.status = TestJob.Status.FAILED
                        job.result_summary = {'error': f'Manifest 校验失败: {e}'}
                        job.save(update_fields=['result_summary', 'status'])
    Campaign.objects.filter(pk=campaign.pk).update(
        status=Campaign.Status.QUEUED, total_jobs=len(jobs), started_at=timezone.now())
    if jobs:
        group(run_browser_job.si(j) for j in jobs).apply_async()
    return f'expanded {len(jobs)} jobs'

def _site_lock(site_code: str):
    """站点级执行锁（2026-10-16 ian：多任务并行改造——不同站点并行、同站点串行）。
    同站点任务共享测试账号/订单/购物车数据，并发会互踩（订单号串、后台误操作），
    故用 redis 锁按 site_code 互斥；锁 TTL 取任务 hard time limit + 余量，防 worker 崩溃后死锁。
    broker 即 redis，复用 CELERY_BROKER_URL 连接（db 与 celery 共用无冲突，key 前缀隔离）。"""
    import redis as _redis
    client = _redis.Redis.from_url(settings.CELERY_BROKER_URL, socket_timeout=5)
    return client.lock(f'job-site-lock:{site_code}', timeout=46 * 60)


@shared_task(bind=True, name='campaigns.tasks.run_browser_job',
             # 2026-10-16 ian：并行化改造——去掉 autoretry_for（其重试为无效重试：失败终态后重入即 skip），
             # 站点锁等待改用 self.retry 延迟重探（不占 worker 进程、不耗 soft time limit 预算）。
             soft_time_limit=40 * 60, time_limit=45 * 60, acks_late=True)
def run_browser_job(self, job_id: int):
    job = TestJob.objects.get(pk=job_id)
    if job.status == TestJob.Status.CANCEL_REQUESTED:
        # 排队期间被取消（等站点锁 retry 重入场景）：直接终态并收敛 Campaign 计数
        TestJob.objects.filter(pk=job.pk).update(status=TestJob.Status.CANCELLED,
                                                 heartbeat_at=timezone.now(), finished_at=timezone.now())
        _campaign_tick(job.campaign_id)
        return 'skip: cancelled while queued'
    if job.status not in (TestJob.Status.CREATED, TestJob.Status.QUEUED):
        return f'skip: status={job.status}'
    # ── 站点锁：拿不到 → 保持 QUEUED 并注明等待原因，30s 后重探（最多约 2h） ──
    lock = _site_lock(job.site_code)
    if not lock.acquire(blocking=False):
        waited = self.request.retries + 1
        TestJob.objects.filter(pk=job.pk).update(result_summary={
            'note': f'站点 {job.site_code} 有任务执行中，排队等待站点锁（已探测 {waited} 次）'})
        raise self.retry(countdown=30, max_retries=240)
    try:
        TestJob.objects.filter(pk=job.pk).update(
            status=TestJob.Status.RUNNING, attempt_count=job.attempt_count + 1,
            heartbeat_at=timezone.now(), started_at=timezone.now(), celery_task_id=self.request.id)
        Campaign.objects.filter(pk=job.campaign_id, status=Campaign.Status.QUEUED).update(status=Campaign.Status.RUNNING)
        try:
            result = run_playwright(job)
            summary = result['summary']
            if summary.get('status') == 'cancelled':
                # 用户取消（2026-10-21）：终态 CANCELLED，不判失败、不触发重试语义
                _finish_job(job, TestJob.Status.CANCELLED, summary, result['log'], result)
                return summary
            passed = summary['status'] == 'passed'
            _finish_job(job, TestJob.Status.PASSED if passed else TestJob.Status.FAILED, summary, result['log'], result)
            return summary
        except RunnerFailure as e:
            _finish_job(job, TestJob.Status.FAILED, {'error': e.message, 'kind': e.kind}, e.log, None)
            raise
        except Exception as e:
            _finish_job(job, TestJob.Status.FAILED, {'error': str(e)[:500], 'kind': 'infra'}, '', None)
            raise
    finally:
        try:
            lock.release()
        except Exception:
            pass  # 锁已过期/未持有（worker 重启后 TTL 兜底自动释放）

def _artifact_dir(job) -> str:
    d = Path(settings.ARTIFACT_ROOT) / f"JOB-{job.pk:06d}"
    d.mkdir(parents=True, exist_ok=True)
    return d

from pathlib import Path

def _finish_job(job, status, summary, log, runner_result):
    d = Path(_artifact_dir(job))
    (d / 'result.json').write_text(json.dumps({
        'job_id': job.pk, 'status': status, 'summary': summary,
        'manifest': job.run_manifest, 'finished_at': timezone.now().isoformat(),
    }, ensure_ascii=False, indent=2, default=str))
    (d / 'runner.log').write_text(log or '', encoding='utf-8')
    # 收集 web-blackbox 本轮产物（截图/报告）链接清单
    if runner_result:
        ro = Path(runner_result['runner_out'])
        extra = {}
        for sub in ('junit.xml',):
            if (ro / sub).exists():
                shutil.copy(ro / sub, d / sub) if (shutil := __import__('shutil')) else None
        shots_dir = Path(settings.RUNNER_ROOT) / 'output' / 'html-report' / runner_result['run_id'] / 'screenshots'
        if shots_dir.exists():
            extra['screenshots_dir'] = str(shots_dir)
            extra['screenshot_files'] = sorted(p.name for p in shots_dir.glob('*.png'))[:100]
        summary['artifacts'] = {'dir': str(d), **extra}
    TestJob.objects.filter(pk=job.pk).update(
        status=status, result_summary=summary, runner_log=(log or '')[-20000:],
        heartbeat_at=timezone.now(), finished_at=timezone.now())
    _campaign_tick(job.campaign_id)
    # Job 级即时通知（2026-10-21 ian：任务出结果就推 webhook——任务 ID/结果/HTML 报告）
    try:
        notify_job_finished.delay(job.pk)
    except Exception as e:
        print(f'[notify:job] 通知任务派发失败（不影响执行结果）: {e}')

def _campaign_tick(campaign_id):
    with transaction.atomic():
        c = Campaign.objects.select_for_update().get(pk=campaign_id)
        # 2026-10-21 改真实计数（原 finished+1 累加）：任何路径置终态（含直接取消/失联兜底）
        # 均自然收敛，杜绝「取消排队 Job 不 tick → Campaign 永远到不了 total 卡 RUNNING」
        final_states = [TestJob.Status.PASSED, TestJob.Status.FAILED,
                        TestJob.Status.LOST, TestJob.Status.CANCELLED]
        c.finished_jobs = TestJob.objects.filter(campaign=c, status__in=final_states).count()
        c.passed_jobs = TestJob.objects.filter(campaign=c, status=TestJob.Status.PASSED).count()
        c.failed_jobs = TestJob.objects.filter(campaign=c, status=TestJob.Status.FAILED).count()
        if c.finished_jobs >= c.total_jobs and not c.report_built and c.total_jobs > 0:
            c.report_built = True
            if c.status != Campaign.Status.CANCELLED:
                c.status = Campaign.Status.COMPLETED
            c.finished_at = timezone.now()
            build = True
        else:
            build = False
        c.save()
    if build:
        from apps.reports.tasks import build_campaign_report
        build_campaign_report.delay(campaign_id)

def _send_channel(ch, content: str) -> str:
    """向单个渠道 POST 通知；返回状态描述（ok:200 / error:...）。禁用代理防容器坏代理劫持。"""
    import json as _json
    import urllib.request
    body_raw = (ch.body_template or '').strip() or '{"content": {{CONTENT_JSON}}}'
    body = body_raw.replace('{{CONTENT_JSON}}', _json.dumps(content, ensure_ascii=False))
    body = body.replace('{{content}}', content)
    headers = {'Content-Type': 'application/json'}
    try:
        headers.update(_json.loads(ch.headers_json or '{}'))
    except Exception:
        pass
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # 直连，不走代理
        req = urllib.request.Request(ch.url, data=body.encode('utf-8'), headers=headers, method='POST')
        with opener.open(req, timeout=10) as resp:
            raw = resp.read(600).decode('utf-8', 'replace')
            # 2026-10-21 ian 排障：微信系 API（企业微信/公众号）HTTP 200 不代表成功——
            # 响应体 errcode≠0 时判定失败并把 errmsg 记入 last_status（防假 200 假成功）
            try:
                rj = json.loads(raw)
                if isinstance(rj, dict) and rj.get('errcode') not in (None, 0):
                    return f"error:errcode={rj.get('errcode')} {str(rj.get('errmsg'))[:120]}"
            except Exception:
                pass
            return f'ok:{resp.status}'
    except Exception as e:
        return f'error:{str(e)[:160]}'


def _notify_base_url() -> str:
    """推送链接前缀（2026-11-02 ian）：通知设置「推送本站域名」优先，留空回退 PLATFORM_BASE_URL env"""
    from .models import NotifySetting
    return NotifySetting.get_base_url()


def _notify_content(campaign) -> str:
    """组装 Campaign 终态通知文本（含通过/失败/取消统计、失败明细、报告链接）。"""
    from django.conf import settings as _s
    jobs = list(campaign.jobs.all().order_by('seq'))
    n_cancel = sum(1 for j in jobs if j.status == TestJob.Status.CANCELLED)
    n_lost = sum(1 for j in jobs if j.status == TestJob.Status.LOST)
    elapsed = ''
    if campaign.started_at and campaign.finished_at:
        elapsed = f"｜耗时 {int((campaign.finished_at - campaign.started_at).total_seconds())}s"
    sites = sorted({j.site_code for j in jobs if j.site_code})
    lines = [f"[自动化测试平台] Campaign #{campaign.pk}「{campaign.name}」{campaign.get_status_display()}",
             f"任务 {campaign.total_jobs} 个：通过 {campaign.passed_jobs} / 失败 {campaign.failed_jobs}"
             + (f" / 取消 {n_cancel}" if n_cancel else '') + (f" / 失联 {n_lost}" if n_lost else '')
             + (f"｜站点 {'、'.join(sites)}" if sites else '') + elapsed]
    fails = [j for j in jobs if j.status == TestJob.Status.FAILED]
    if fails:
        lines.append('失败明细：')
        for j in fails[:8]:
            err = ((j.result_summary or {}).get('error') or '原因待查（看日志）')[:120]
            lines.append(f"· JOB-{j.pk:06d}-{j.device.upper()} {j.scenario_code}@{j.site_code}：{err}")
    lines.append(f"详情：{_notify_base_url()}/campaigns/{campaign.pk}/")
    rep = ((fails[0].result_summary or {}).get('report') or {}).get('url') if fails else ''
    if rep:
        lines.append(f"失败报告：{_notify_base_url()}{rep}")
    return '\n'.join(lines)


@shared_task(name='campaigns.tasks.notify_campaign_finished')
def notify_campaign_finished(campaign_id: int):
    """Campaign 汇总通知（2026-10-21 ian：仅 events=campaign 的渠道；默认渠道已改为 Job 级即时推送）。
    发送失败不抛错（记 last_status 供管理页排查）。"""
    from .models import NotifyChannel
    from django.utils import timezone as _tz
    c = Campaign.objects.filter(pk=campaign_id).first()
    if c is None:
        return 'skip: campaign gone'
    content = _notify_content(c)
    has_fail = c.failed_jobs > 0
    sent = []
    for ch in NotifyChannel.objects.filter(enabled=True, events=NotifyChannel.Events.CAMPAIGN):
        if not has_fail and not c.passed_jobs:
            continue  # 空汇总不推
        status = _send_channel(ch, content)
        NotifyChannel.objects.filter(pk=ch.pk).update(last_status=status, last_sent_at=_tz.now())
        sent.append(f'{ch.name}:{status}')
        print(f'[notify] {ch.name} → {status}')
    return f'notified {len(sent)} channel(s): {"; ".join(sent)}'


def _job_notify_content(job) -> str:
    """Job 级通知文本（2026-10-21 ian：任务 ID + 结果 + HTML 报告链接，任务一出结果即推）。"""
    from django.conf import settings as _s
    s = job.result_summary or {}
    run_id = s.get('run_id') or f"JOB-{job.pk:06d}-{(job.device or 'pc').upper()}"
    status_map = {'passed': '通过', 'failed': '失败', 'cancelled': '已取消', 'lost': '失联'}
    lines = [f"[自动化测试平台] {run_id} · {job.scenario_code} @ {job.site_code}",
             f"结果：{status_map.get(job.status, job.status)}"]
    prog = job.progress or {}
    if prog.get('total'):
        lines[1] += f"（步骤 {prog.get('done')}/{prog.get('total')}）"
    if s.get('elapsed_sec'):
        lines[1] += f" · 耗时 {s['elapsed_sec']}s"
    err = (s.get('error') or '').strip()
    if err:
        lines.append(f"原因：{err[:160]}")
    rep = (s.get('report') or {}).get('url') or ''
    if rep:
        lines.append(f"HTML 报告：{_notify_base_url()}{rep}")
    else:
        lines.append("HTML 报告：未生成（无步骤数据，看任务日志定位原因）")
    lines.append(f"任务详情：{_notify_base_url()}/campaigns/{job.campaign_id}/jobs/{job.pk}/")
    return '\n'.join(lines)


@shared_task(name='campaigns.tasks.notify_job_finished')
def notify_job_finished(job_id: int):
    """Job 级即时通知（2026-10-21 ian：每个测试任务出结果就推 webhook，带上任务 ID/结果/HTML 报告）。
    job_all=成败都推；job_failed=仅失败推。发送失败不抛错（记 last_status）。"""
    from .models import NotifyChannel
    from django.utils import timezone as _tz
    job = TestJob.objects.filter(pk=job_id).first()
    if job is None:
        return 'skip: job gone'
    if job.status not in (TestJob.Status.PASSED, TestJob.Status.FAILED,
                          TestJob.Status.CANCELLED, TestJob.Status.LOST):
        return f'skip: not final ({job.status})'
    content = _job_notify_content(job)
    is_fail = job.status in (TestJob.Status.FAILED, TestJob.Status.LOST)
    sent = []
    for ch in NotifyChannel.objects.filter(enabled=True):
        if ch.events == NotifyChannel.Events.CAMPAIGN:
            continue  # 汇总渠道不参与 Job 级推送
        if ch.events == NotifyChannel.Events.JOB_FAILED and not is_fail:
            continue
        status = _send_channel(ch, content)
        NotifyChannel.objects.filter(pk=ch.pk).update(last_status=status, last_sent_at=_tz.now())
        sent.append(f'{ch.name}:{status}')
        print(f'[notify:job] {job.pk} {ch.name} → {status}')
    return f'notified {len(sent)} channel(s): {"; ".join(sent)}'


@shared_task(name='campaigns.tasks.check_lost_jobs')
def check_lost_jobs():
    # 阈值必须大于单 Job 最长执行时间（soft limit 25min）：全链用例运行 15 分钟+ 属正常，
    # 心跳只在任务结束时刷新，短阈值会误杀长任务（2026-09-23 事故）
    limit = timezone.now() - timedelta(seconds=int(os.environ.get('LOST_THRESHOLD_SECONDS', '2450')))
    for j in TestJob.objects.filter(status=TestJob.Status.RUNNING, heartbeat_at__lt=limit):
        TestJob.objects.filter(pk=j.pk).update(status=TestJob.Status.LOST)
        _campaign_tick(j.campaign_id)
        try:
            notify_job_finished.delay(j.pk)
        except Exception:
            pass
    # 2026-10-21 兜底：cancel_requested 但心跳已停（runner 死于取消前）→ 直接置 CANCELLED 收敛
    for j in TestJob.objects.filter(status=TestJob.Status.CANCEL_REQUESTED, heartbeat_at__lt=limit):
        TestJob.objects.filter(pk=j.pk).update(status=TestJob.Status.CANCELLED,
                                               finished_at=timezone.now())
        _campaign_tick(j.campaign_id)
    return 'checked'


@shared_task(name='campaigns.tasks.purge_run_dirs')
def purge_run_dirs(run_ids=None):
    """清理 playwright 原始产物目录 RUNNER_ROOT/output/<RUN_ID>/（results.json/过程截图/curl 记录等）。

    2026-10-27 ian：执行中心/执行记录/报告中心勾选删除后需连带清理本地目录。
    该目录仅 browser-worker 挂载 web-blackbox 可写（web 容器未挂载），故路由 browser 队列。
    尽力而为：名称严格校验 JOB-\\d+-(PC|WAP)，目录不存在/删除失败均吞错，不影响任何主流程。
    """
    import re as _re
    import shutil
    from pathlib import Path
    root = Path(settings.RUNNER_ROOT) / 'output'
    pat = _re.compile(r'^JOB-\d{4,10}-(PC|WAP)$')
    removed = []
    for rid in run_ids or []:
        name = str(rid or '').strip()
        if not pat.match(name):
            continue
        d = root / name
        try:
            if d.is_dir():
                shutil.rmtree(d, ignore_errors=True)
                if not d.exists():
                    removed.append(name)
        except Exception:
            pass
    return f'purged {len(removed)}: {",".join(removed[:20])}'
