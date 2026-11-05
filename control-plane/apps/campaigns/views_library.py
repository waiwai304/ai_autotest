"""测试用例库视图（ian 2026-10-08：搜索关键词/图片/链接素材池管理）"""
from django.contrib.admin.views.decorators import staff_member_required
from django.contrib import messages
from django.shortcuts import render, redirect, get_object_or_404
from django.db import transaction

from .models import AssetLibrary

_KINDS = ('keyword', 'image', 'link')
_KIND_LABEL = dict(AssetLibrary.Kind.choices)


def _groups(site_id=None):
    """按类型分组返回条目（供管理页与发起页复用）"""
    qs = AssetLibrary.objects.all().order_by('-created_at')
    if site_id:
        qs = qs.filter(site_id=site_id)
    out = {}
    for k in _KINDS:
        out[k] = list(qs.filter(kind=k))
    return out


@staff_member_required
def library_list(request):
    from apps.sites.models import Site
    groups = _groups()
    sites = list(Site.objects.all())
    return render(request, 'campaigns/library.html', {
        'groups': groups,
        'sites': sites,
        'kind_labels': _KIND_LABEL,
        'counts': {k: len(v) for k, v in groups.items()},
        'counts_enabled': {k: len([x for x in v if x.enabled]) for k, v in groups.items()},
    })


@staff_member_required
def library_add(request):
    if request.method == 'POST':
        kind = request.POST.get('kind', '')
        if kind not in _KINDS:
            messages.error(request, '类型非法')
            return redirect('library_list')
        site_id = request.POST.get('site') or None
        note = (request.POST.get('note') or '').strip()[:200]
        # 支持批量：textarea 每行一条（ian 要求可批量填充）
        raw = request.POST.get('value') or ''
        values = [v.strip() for v in raw.replace('\r', '').split('\n') if v.strip()]
        if not values:
            messages.error(request, '请填写内容（每行一条）')
            return redirect('library_list')
        with transaction.atomic():
            for v in values[:200]:
                AssetLibrary.objects.create(kind=kind, value=v[:2000], note=note,
                                            site_id=site_id, enabled=True)
        messages.success(request, f'已添加 {min(len(values), 200)} 条「{_KIND_LABEL[kind]}」')
    return redirect('library_list')


@staff_member_required
def library_edit(request, pk):
    item = get_object_or_404(AssetLibrary, pk=pk)
    if request.method == 'POST':
        item.value = (request.POST.get('value') or '').strip()[:2000]
        item.note = (request.POST.get('note') or '').strip()[:200]
        site_id = request.POST.get('site') or None
        item.site_id = site_id
        item.save()
        messages.success(request, f'条目 #{pk} 已更新')
    return redirect('library_list')


@staff_member_required
def library_toggle(request, pk):
    item = get_object_or_404(AssetLibrary, pk=pk)
    item.enabled = not item.enabled
    item.save(update_fields=['enabled'])
    messages.success(request, f'条目 #{pk} 已{"启用" if item.enabled else "停用"}')
    return redirect('library_list')


@staff_member_required
def library_delete(request, pk):
    item = get_object_or_404(AssetLibrary, pk=pk)
    item.delete()
    messages.success(request, f'条目 #{pk} 已删除')
    return redirect('library_list')
