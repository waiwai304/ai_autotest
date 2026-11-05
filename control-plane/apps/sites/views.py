from django.contrib import messages
from django.contrib.auth.decorators import login_required
from django.shortcuts import render, get_object_or_404, redirect
from django.db import transaction
from urllib.parse import urlparse
from .models import Site, SiteVersion

_FIELDS = ('name', 'code', 'pc_base_url', 'wap_base_url', 'boss_base_url', 'profile_key',
           'adapter_key', 'max_concurrency', 'requests_per_minute', 'enabled', 'currency', 'weight',
           'front_account', 'front_password', 'boss_account', 'boss_password',
           'explore_account', 'explore_password')
_PWD_FIELDS = ('front_password', 'boss_password', 'explore_password')  # 编辑时留空 = 保留原值


def _available_profiles() -> list:
    """config/sites.json 中 enabled 的档案 id 列表（web 容器挂载 /data/runner-config）"""
    return [p[0] for p in _profile_options()]


def _profile_options() -> list:
    """可用站点档案 [(id, 名称, adapter)]；2026-11-04 ian：除 OneBuy 档案外增加 generic-web（任意官网）"""
    import json as _json
    for p in ('/data/runner-config/sites.json', '/workspace/runner/config/sites.json'):
        try:
            with open(p) as f:
                sites = (_json.load(f) or {}).get('sites', [])
            return [(str(s.get('id')), str(s.get('name') or s.get('id')), str(s.get('adapter') or ''))
                    for s in sites if s.get('enabled', True)]
        except Exception:
            continue
    return []


def _validate(payload: dict) -> dict:
    """表单校验：返回 {field: error}；payload 为清洗后的字段字典"""
    errors = {}
    if not payload.get('name'):
        errors['name'] = '必填'
    if not payload.get('code'):
        errors['code'] = '必填'
    if not payload.get('pc_base_url'):
        errors['pc_base_url'] = '必填（PC 前台域名，用于基线 base_url 与白名单推导）'
    for f in ('pc_base_url', 'wap_base_url', 'boss_base_url'):
        v = (payload.get(f) or '').strip()
        if v and not v.startswith(('http://', 'https://')):
            errors[f] = '必须以 http(s):// 开头'
    # 2026-10-14 ian（JOB-96 根因）：profile_key 必须是 sites.json 已启用的档案 id，
    # 否则 runner 注入 TEST_SITE_ID 后用例加载即失败「没有找到已启用的测试站点」且无报告。
    pk = (payload.get('profile_key') or '').strip()
    if pk:
        opts = _profile_options()
        avail = [o[0] for o in opts]
        if avail and pk not in avail:
            hint = '；'.join(f'{i}（{n}）' for i, n, _ in opts)
            errors['profile_key'] = (f'档案 id「{pk}」不存在或未启用。可选：{hint}。'
                                     'OneBuy 商城类站点填 onebuy-v2026；官网/企业站等非商城站点填 generic-web。')
    return errors


def _payload_from_post(request) -> dict:
    p = {}
    for f in _FIELDS:
        v = request.POST.get(f, '').strip()
        p[f] = v
    p['max_concurrency'] = int(p['max_concurrency'] or 2)
    p['requests_per_minute'] = int(p['requests_per_minute'] or 30)
    # 2026-11-04 ian：展示权重（非负整数，0=未设置）
    try:
        p['weight'] = max(0, min(9999, int((p.get('weight') or '0').strip() or 0)))
    except (TypeError, ValueError):
        p['weight'] = 0
    p['enabled'] = request.POST.get('enabled') == 'on'
    return p


def _apply_and_save(site: Site, payload: dict, request):
    """写 Site 并自动派生 base_url/allowed_host/locales/devices；SiteVersion 留痕"""
    for f in _FIELDS:
        if f in payload:
            if f in _PWD_FIELDS and not payload[f] and site.pk:  # 编辑留空密码 → 保留旧值
                continue
            setattr(site, f, payload[f])
    host = urlparse(payload['pc_base_url']).hostname or ''
    # 2026-11-04 ian：档案留空时按 adapter 自动落默认档案（官网类→generic-web，避免误用 OneBuy 路径表）
    if not (site.profile_key or '').strip():
        site.profile_key = 'onebuy-v2026' if (site.adapter_key or 'onebuy') == 'onebuy' else 'generic-web'
    site.base_url = payload['pc_base_url']
    site.allowed_host = host
    if not site.locales:
        site.locales = ['zh-cn']
    if not site.devices:
        site.devices = ['pc', 'wap']
    with transaction.atomic():
        site.save()
        SiteVersion.objects.create(
            site=site,
            version=(site.versions.count() or 0) + 1,
            config={'endpoints': site.endpoints(), 'profile': site.profile_key,
                    'base_url': site.base_url, 'allowed_host': site.allowed_host,
                    'creds': {'front': bool(site.front_account), 'boss': bool(site.boss_account)}},
            sha256='', created_by=request.user,
        )


@login_required
def site_list(request):
    # 2026-11-04 ian：与执行中心同序（权重降序 → 创建时间旧→新），列表与入口顺序一致
    return render(request, 'sites/list.html', {'objects': Site.objects.all().order_by('-weight', 'created_at')})


@login_required
def site_weight(request, pk):
    """快捷设置网站权重（2026-11-04 ian：执行中心网站顺序；0=未设置）"""
    site = get_object_or_404(Site, pk=pk)
    if request.method == 'POST':
        raw = (request.POST.get('weight') or '').strip()
        try:
            w = max(0, min(9999, int(raw or 0)))
        except (TypeError, ValueError):
            messages.error(request, '权重必须是 0~9999 的整数')
            return redirect('site_list')
        old = site.weight
        site.weight = w
        site.save(update_fields=['weight', 'updated_at'])
        messages.success(request, f'{site.name} 权重 {old} → {w}'
                                  + ('（已取消权重，按创建时间排）' if w == 0 else '（数值越大越靠前）'))
    return redirect('site_list')


@login_required
def site_detail(request, pk):
    return render(request, 'sites/detail.html', {'obj': get_object_or_404(Site, pk=pk),
                                                 'versions': SiteVersion.objects.filter(site_id=pk).order_by('-version')[:5]})


@login_required
def site_new(request):
    if request.method == 'POST':
        payload = _payload_from_post(request)
        errors = _validate(payload)
        if Site.objects.filter(code=payload['code']).exists():
            errors['code'] = '编码已存在'
        if errors:
            messages.error(request, '保存失败：' + '；'.join(f'{k}: {v}' for k, v in errors.items()))
            return render(request, 'sites/form.html', {'form': payload, 'mode': 'new', 'errors': errors, 'profiles': _profile_options(), 'profile_ids': _available_profiles()})
        site = Site()
        _apply_and_save(site, payload, request)
        messages.success(request, f'网站 {site.name}（{site.code}）已创建，发起测试时可直接勾选。')
        return redirect('site_detail', pk=site.pk)
    return render(request, 'sites/form.html', {'form': {}, 'mode': 'new', 'errors': {}, 'profiles': _profile_options(), 'profile_ids': _available_profiles()})


@login_required
def site_edit(request, pk):
    site = get_object_or_404(Site, pk=pk)
    if request.method == 'POST':
        payload = _payload_from_post(request)
        errors = _validate(payload)
        if Site.objects.filter(code=payload['code']).exclude(pk=site.pk).exists():
            errors['code'] = '编码已被其他网站占用'
        if errors:
            messages.error(request, '保存失败：' + '；'.join(f'{k}: {v}' for k, v in errors.items()))
            return render(request, 'sites/form.html', {'form': payload, 'mode': 'edit', 'pk': pk, 'errors': errors, 'profiles': _profile_options(), 'profile_ids': _available_profiles()})
        _apply_and_save(site, payload, request)
        messages.success(request, f'网站 {site.name} 已更新。')
        return redirect('site_detail', pk=site.pk)
    initial = {f: getattr(site, f) for f in _FIELDS}
    initial['enabled'] = site.enabled
    for f in _PWD_FIELDS:  # 密码不回显：留空 = 保留原值
        initial[f] = ''
    return render(request, 'sites/form.html', {'form': initial, 'mode': 'edit', 'pk': pk, 'errors': {},
                                                'has_front_pwd': bool(site.front_password),
                                                'has_boss_pwd': bool(site.boss_password),
                                                'has_explore_pwd': bool(site.explore_password), 'profiles': _profile_options(), 'profile_ids': _available_profiles()})


@login_required
def site_toggle(request, pk):
    """启用/停用开关（不做硬删：Site 被 Campaign/Job 外键保护）"""
    site = get_object_or_404(Site, pk=pk)
    if request.method == 'POST':
        site.enabled = not site.enabled
        site.save(update_fields=['enabled', 'updated_at'])
        messages.success(request, f'{site.name} 已{"启用" if site.enabled else "停用"}。')
    return redirect('site_list')
