"""通知渠道管理（2026-10-21 ian：Campaign 终态 webhook 推送配置页）。"""
import json
from django.contrib import messages
from django.contrib.auth.decorators import login_required
from django.shortcuts import render, get_object_or_404, redirect
from .models import NotifyChannel, NotifySetting
from .tasks import _send_channel


def _validate(request, form) -> dict | None:
    """表单校验：返回 cleaned dict 或 None（错误已写 messages）"""
    name = (form.get('name') or '').strip()
    url = (form.get('url') or '').strip()
    if not name or not url:
        messages.error(request, '渠道名称与 Webhook 地址必填。')
        return None
    if not url.startswith(('http://', 'https://')):
        messages.error(request, 'Webhook 地址必须以 http(s):// 开头。')
        return None
    headers_json = (form.get('headers_json') or '').strip() or '{"Content-Type": "application/json"}'
    try:
        h = json.loads(headers_json)
        if not isinstance(h, dict):
            raise ValueError('headers 必须是 JSON 对象')
        headers_json = json.dumps(h, ensure_ascii=False)
    except Exception as e:
        messages.error(request, f'请求头 JSON 不合法：{e}')
        return None
    body_template = (form.get('body_template') or '').strip() or '{"content": {{CONTENT_JSON}}}'
    if '{{CONTENT_JSON}}' not in body_template and '{{content}}' not in body_template:
        messages.error(request, '请求体模板必须包含 {{CONTENT_JSON}} 或 {{content}} 占位符。')
        return None
    events = form.get('events') or 'job_all'
    if events not in ('job_all', 'job_failed', 'campaign'):
        messages.error(request, '触发事件只支持：job_all（每任务出结果即推）/ job_failed（仅失败任务即推）/ campaign（仅汇总）。')
        return None
    return {'name': name, 'url': url, 'headers_json': headers_json,
            'body_template': body_template, 'events': events}


@login_required
def notify_list(request):
    objs = NotifyChannel.objects.all()
    ns = NotifySetting.objects.first()
    return render(request, 'notify/list.html', {'objects': objs, 'ns': ns})


@login_required
def notify_settings_save(request):
    """推送本站域名（2026-11-02 ian）：推送内报告/详情链接前缀，留空回退 PLATFORM_BASE_URL env"""
    if request.method == 'POST':
        base = (request.POST.get('base_url') or '').strip().rstrip('/')
        if base and not base.startswith(('http://', 'https://')):
            messages.error(request, '推送本站域名必须以 http(s):// 开头（如 https://onebuy.example.com）。')
            return redirect('notify_list')
        obj = NotifySetting.objects.first() or NotifySetting()
        obj.base_url = base
        obj.save()
        messages.success(request, f'推送本站域名已保存：{base or "（空——回退 PLATFORM_BASE_URL 环境变量）"}。后续推送立即生效。')
    return redirect('notify_list')


@login_required
def notify_new(request):
    if request.method == 'POST':
        cleaned = _validate(request, request.POST)
        if cleaned:
            NotifyChannel.objects.create(**cleaned, enabled=True)
            messages.success(request, '通知渠道已创建。')
            return redirect('notify_list')
    return render(request, 'notify/form.html', {'obj': None, 'action': '/notify/new/'})


@login_required
def notify_edit(request, pk):
    obj = get_object_or_404(NotifyChannel, pk=pk)
    if request.method == 'POST':
        cleaned = _validate(request, request.POST)
        if cleaned:
            for k, v in cleaned.items():
                setattr(obj, k, v)
            obj.save()
            messages.success(request, '通知渠道已保存。')
            return redirect('notify_list')
    return render(request, 'notify/form.html', {'obj': obj, 'action': f'/notify/{obj.pk}/edit/'})


@login_required
def notify_toggle(request, pk):
    obj = get_object_or_404(NotifyChannel, pk=pk)
    if request.method == 'POST':
        obj.enabled = not obj.enabled
        obj.save(update_fields=['enabled'])
        messages.success(request, f'渠道「{obj.name}」已{"启用" if obj.enabled else "停用"}。')
    return redirect('notify_list')


@login_required
def notify_delete(request, pk):
    obj = get_object_or_404(NotifyChannel, pk=pk)
    if request.method == 'POST':
        obj.delete()
        messages.success(request, f'渠道「{obj.name}」已删除。')
    return redirect('notify_list')


@login_required
def notify_test(request, pk):
    """同步发送一条测试消息（即时验证渠道配置与网络连通性）。"""
    from django.utils import timezone
    obj = get_object_or_404(NotifyChannel, pk=pk)
    if request.method == 'POST':
        status = _send_channel(obj, '[OneBuy 测试平台] 通知渠道测试：配置正确，本条为手动测试消息。')
        NotifyChannel.objects.filter(pk=obj.pk).update(last_status=status, last_sent_at=timezone.now())
        if status.startswith('ok:'):
            messages.success(request, f'测试消息发送成功（HTTP {status[3:]}）。')
        else:
            messages.error(request, f'测试消息发送失败：{status}')
    return redirect('notify_list')
