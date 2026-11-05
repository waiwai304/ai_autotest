import json
from pathlib import Path
from django.conf import settings
from celery import shared_task
from apps.campaigns.models import Campaign, TestJob

# playwright 状态 → 报告徽章
_ST_MAP = {'expected': '✅ 通过', 'unexpected': '❌ 失败', 'flaky': '⚠️ 不稳定',
           'skipped': '⏭ 跳过', 'interrupted': '⛔ 中断', 'timedOut': '❌ 超时'}


def _job_steps(run_id: str):
    """读取某 Job 的 results.json（playwright json reporter），提取每用例步骤明细（2026-09-27 ian：报告要具体到每步骤+截图）
    截图列表 = html-report/<RUN>/screenshots/ 目录实际文件（gen-platform-report 生成时统一拷贝/落盘）"""
    root = Path(settings.RUNNER_ROOT) / 'output' / run_id
    rj = root / 'results.json'
    shots_dir = Path(settings.HTML_REPORT_ROOT) / run_id / 'screenshots'
    if not shots_dir.exists():
        # report-worker 容器可能未挂 HTML_REPORT_ROOT，回退 RUNNER_ROOT（web-blackbox 挂载必有）
        shots_dir = Path(settings.RUNNER_ROOT) / 'output' / 'html-report' / run_id / 'screenshots'
    shot_files = sorted([p.name for p in shots_dir.glob('*.png')]) if shots_dir.exists() else []
    if not rj.exists():
        return [], shot_files
    try:
        data = json.loads(rj.read_text())
    except Exception:
        return []
    out = []

    def walk(suite):
        for sub in suite.get('suites') or []:
            walk(sub)
        for spec in suite.get('specs') or []:
            t0 = (spec.get('tests') or [{}])[0]
            r0 = (t0.get('results') or [{}])[0]
            status = r0.get('status', t0.get('status', 'unknown'))
            dur = int(r0.get('duration') or 0)
            err = ((r0.get('error') or {}).get('message') or '')
            err = err.replace('\x1b', '').strip()[:300]
            # 截图：gen-platform-report 通用/全链模式都会拷到 html-report/<RUN>/screenshots/
            shots = []
            for att in r0.get('attachments') or []:
                p = (att.get('path') or '').replace('\\', '/').split('/')[-1]
                if p.lower().endswith('.png'):
                    shots.append(p)
            out.append({'title': spec.get('title', ''), 'status': status,
                        'dur': f'{dur / 1000:.1f}s' if dur else '-', 'err': err, 'shots': shots})

    for suite in data.get('suites') or []:
        walk(suite)
    return out, shot_files


def _report_urls(run_id: str):
    """Job HTML 报告与 md 的平台访问 URL（报告中心路由）"""
    return (f'/reports/view/{run_id}/index.html', f'/reports/view/{run_id}/测试结果报告.md')


@shared_task(name='reports.tasks.build_campaign_report')
def build_campaign_report(campaign_id: int):
    c = Campaign.objects.get(pk=campaign_id)
    jobs = TestJob.objects.filter(campaign=c)
    out = Path(settings.REPORT_ROOT) / f"CAMPAIGN-{c.pk:06d}"
    out.mkdir(parents=True, exist_ok=True)
    data = {
        'campaign': c.pk, 'name': c.name, 'status': c.status,
        'total': c.total_jobs, 'finished': c.finished_jobs,
        'passed': c.passed_jobs, 'failed': c.failed_jobs,
        'started_at': str(c.started_at), 'finished_at': str(c.finished_at),
        'jobs': [
            {'id': j.pk, 'seq': j.seq, 'site': j.site_code, 'scenario': j.scenario_code,
             'device': j.device, 'locale': j.locale, 'status': j.status,
             'summary': j.result_summary}
            for j in jobs
        ],
    }
    (out / 'campaign-report.json').write_text(json.dumps(data, ensure_ascii=False, indent=2, default=str))

    # 汇总 md：每 Job 展开「步骤明细表（标题/状态/耗时/错误/截图链接）+ HTML/md 报告入口」
    md = [f"# Campaign 报告 CAMPAIGN-{c.pk:06d}", '',
          f"- **名称**: {c.name}",
          f"- **状态**: {c.get_status_display()}",
          f"- **任务**: {c.finished_jobs}/{c.total_jobs}（通过 {c.passed_jobs} / 失败 {c.failed_jobs}）",
          f"- **时间**: {c.started_at} ~ {c.finished_at}", '',
          '## 一、任务总览', '',
          '| Job | 站点 | 流程 | 设备 | 结果 | 耗时 | 报告 |', '|---|---|---|---|---|---|---|']
    for j in jobs:
        s = j.result_summary or {}
        elapsed = f"{s['elapsed_sec']}s" if s.get('elapsed_sec') else '-'
        run_id = s.get('run_id', f"JOB-{j.pk:06d}-{(j.device or 'pc').upper()}")
        html_url, md_url = _report_urls(run_id)
        md.append(f"| JOB-{j.pk:06d} | {j.site_code} | {j.scenario_code} | {j.device}/{j.locale} "
                  f"| {j.status} | {elapsed} | [HTML]({html_url}) · [MD]({md_url}) |")
    md.append('')

    # 安全基线（2026-10-15 ian：Policy 规则包生效于测试流程——报告呈现本轮遵循的规则清单）
    try:
        import yaml as _yaml
        from apps.policies.models import PolicyPackVersion as _PPV
        pol_codes = (c.plan or {}).get('policies') or []
        pols = _PPV.objects.filter(code__in=pol_codes)
        if pols:
            md += ['## 二、安全基线（本轮测试遵循的 Policy 规则）', '']
            for p in pols:
                try:
                    rules = (_yaml.safe_load(p.content) or {}).get('rules') or []
                except Exception:
                    rules = []
                lock_txt = ' 🔒强制' if p.locked else ''
                md.append(f"**{p.code}** v{p.version}{lock_txt} · {p.name}（{len(rules)} 条）：")
                for r in rules:
                    if isinstance(r, dict):
                        md.append(f"- `[{r.get('severity', '?')}]` {r.get('id', '?')} — {r.get('text', '')}")
                md.append('')
            md.append('> 上述规则已注入每个 Job 执行环境（POLICY_PACKS / POLICY_RULES），执行期间全程遵循。')
            md.append('')
            _sec_no = 3
        else:
            _sec_no = 2
    except Exception:
        _sec_no = 2

    # 二/三、每 Job 步骤明细（ian：要具体每步骤的反馈和截图；有安全基线时章节顺延为三）
    md.append(f"## {'三' if _sec_no == 3 else '二'}、步骤明细（每用例：状态 / 耗时 / 错误反馈 / 截图）")
    any_detail = False
    for j in jobs:
        s = j.result_summary or {}
        run_id = s.get('run_id', f"JOB-{j.pk:06d}-{(j.device or 'pc').upper()}")
        steps, shot_files = _job_steps(run_id)
        md.append('')
        md.append(f"### JOB-{j.pk:06d} · {j.scenario_code}（{j.site_code} / {j.device.upper()}）— {j.get_status_display()}")
        if not steps:
            md.append(f"- （无 results.json 明细；日志见 Job 详情页）")
            continue
        any_detail = True
        stats = s.get('stats') or {}
        md.append(f"- 用例数 {len(steps)} ｜ 通过 {stats.get('expected', 0)} ｜ 失败 {stats.get('unexpected', 0)} "
                  f"｜ 跳过 {stats.get('skipped', 0)} ｜ 耗时 {s.get('elapsed_sec', '-')}s")
        md.append('')
        md.append('| # | 用例步骤 | 结果 | 耗时 | 错误反馈 |')
        md.append('|---|---|---|---|---|')
        for i, sp in enumerate(steps, 1):
            err = sp['err'].replace('|', '\\|').replace('\n', ' ') or '-'
            md.append(f"| {i} | {sp['title']} | {_ST_MAP.get(sp['status'], sp['status'])} "
                      f"| {sp['dur']} | {err} |")
        if shot_files:
            md.append('')
            md.append('**执行截图**（点击查看原图）：')
            md.append('')
            for k, sh in enumerate(shot_files, 1):
                md.append(f"- [截图 {k}: {sh}](/reports/view/{run_id}/screenshots/{sh})")
    if not any_detail:
        md.append('')
        md.append('> 本轮无 steps 级数据（用例无 results.json）。')

    (out / 'campaign-report.md').write_text('\n'.join(md), encoding='utf-8')
    # 2026-10-21 ian：Campaign 终态通知（报告生成完毕后推送，通知内可带报告链接）
    try:
        from apps.campaigns.tasks import notify_campaign_finished
        notify_campaign_finished.delay(campaign_id)
    except Exception as e:
        print(f'[notify] 通知任务派发失败（不影响报告）: {e}')
    return str(out)
