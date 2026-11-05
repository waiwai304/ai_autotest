import hashlib, re
from datetime import datetime, timezone
from pathlib import Path

import yaml
from django.contrib import messages
from django.contrib.auth.decorators import login_required
from django.shortcuts import render, get_object_or_404, redirect
from django.views.decorators.http import require_POST

from .models import PolicyPackVersion

# 2026-10-15 ian：Policy 查看/编辑/新建 + 测试流程生效
# 源文件 policy-packs/<code>/policy.yaml（compose 挂载容器 /opt/policy-packs）为单一数据源。
POLICY_ROOT = Path('/opt/policy-packs')
SLUG_RE = re.compile(r'^[a-z0-9]+(?:-[a-z0-9]+)*$')
SEVERITIES = ('critical', 'high', 'medium', 'low')


def _file_for(code: str):
    if not code or not SLUG_RE.match(code):
        return None
    return POLICY_ROOT / code / 'policy.yaml'


def _read_src(code: str) -> str:
    f = _file_for(code)
    return f.read_text(encoding='utf-8') if (f and f.exists()) else ''


def _parse(content: str):
    """YAML → (data, errors)。rules 必须是 [{id, severity, text}] 结构"""
    errors = []
    try:
        data = yaml.safe_load(content) or {}
    except yaml.YAMLError as e:
        return {}, [f'YAML 解析失败：{str(e).splitlines()[0]}']
    if not isinstance(data, dict):
        return {}, ['顶层必须是 YAML 映射（id/name/version/locked/rules）']
    rules = data.get('rules')
    if not isinstance(rules, list) or not rules:
        errors.append('rules 必须是非空列表（每条含 id / severity / text）')
    else:
        for i, r in enumerate(rules, 1):
            if not isinstance(r, dict) or not all(r.get(k) for k in ('id', 'severity', 'text')):
                errors.append(f'第 {i} 条规则缺少 id / severity / text 字段')
                break
            if r['severity'] not in SEVERITIES:
                errors.append(f'第 {i} 条规则 severity 必须是 {" / ".join(SEVERITIES)}')
                break
    return data, errors


def _sync_record(code: str, content: str):
    """源文件内容 → 入库（就地 version+1，code 唯一约束下唯一可行）"""
    sha = hashlib.sha256(content.encode()).hexdigest()
    data, _ = _parse(content)
    obj = PolicyPackVersion.objects.filter(code=code).order_by('-version').first()
    if obj:
        if obj.sha256 == sha:
            return obj, False
        obj.content, obj.sha256 = content, sha
        obj.version = obj.version + 1
    else:
        obj = PolicyPackVersion(code=code, version=1, content=content, sha256=sha)
    obj.name = data.get('name', '') or obj.name
    obj.locked = bool(data.get('locked'))
    obj.published_at = datetime.now(timezone.utc)
    obj.save()
    return obj, True


@login_required
def policy_list(request):
    objects = []
    for o in PolicyPackVersion.objects.all():
        data, errs = _parse(o.content)
        rules = data.get('rules') or []
        src = _read_src(o.code)
        objects.append({
            'o': o, 'rules': rules,
            'has_file': bool(src), 'in_sync': bool(src) and hashlib.sha256(src.encode()).hexdigest() == o.sha256,
        })
    return render(request, 'policies/list.html', {'objects': objects})


@login_required
def policy_detail(request, code):
    obj = get_object_or_404(PolicyPackVersion, code=code)
    data, errs = _parse(obj.content)
    src = _read_src(code)
    src_data, _ = _parse(src) if src else ({}, [])
    return render(request, 'policies/detail.html', {
        'obj': obj, 'data': data, 'rules': data.get('rules') or [], 'parse_errors': errs,
        'severities': SEVERITIES,
        'has_file': bool(src), 'in_sync': bool(src) and hashlib.sha256(src.encode()).hexdigest() == obj.sha256,
        'src_version': (src_data or {}).get('version', '-'),
    })


@login_required
def policy_edit(request, code):
    obj = get_object_or_404(PolicyPackVersion, code=code)
    # locked 安全基线保护：视图层强制拦截（前端按钮禁用只是展示，POST 直发也拒绝）
    if obj.locked:
        return render(request, 'policies/form.html', {
            'obj': obj, 'locked_block': True, 'content': obj.content,
            'errors': [f'规则包 `{code}` 处于锁定状态（安全基线保护），不可编辑——请先在详情页「解锁后编辑」'],
        }, status=403)
    f = _file_for(code)
    if not f or not f.exists():
        return render(request, 'policies/form.html', {
            'obj': obj, 'errors': [f'源文件 {code}/policy.yaml 不存在（容器未挂载或已被删除），无法编辑'],
            'content': obj.content, 'locked_hint': True,
        }, status=400)

    if request.method == 'POST':
        content = request.POST.get('content', '').replace('\r\n', '\n').strip() + '\n'
        data, errors = _parse(content)
        if data.get('id') and str(data['id']) != code:
            errors.append(f'YAML 的 id 必须保持为 `{code}`（不允许改 id；如需新规则包请用「新建规则包」）')
        if not (data.get('name') or '').strip():
            errors.append('name 不能为空')
        if errors:
            return render(request, 'policies/form.html', {'obj': obj, 'errors': errors, 'content': content}, status=400)
        content = re.sub(r'(?m)^version\s*:\s*\d+\s*$', f'version: {obj.version + 1}', content)
        f.write_text(content, encoding='utf-8')
        saved, changed = _sync_record(code, content)
        messages.success(request, f'规则包 `{code}` 已保存（源文件 + 平台入库 v{saved.version}' +
                         ('，内容有变更' if changed else '，内容未变化（hash 相同）') + '）——新发起的测试将按新版本注入')
        return redirect('policy_detail', code=code)

    return render(request, 'policies/form.html', {'obj': obj, 'content': f.read_text(encoding='utf-8')})


@login_required
def policy_create(request):
    if request.method == 'POST':
        code = (request.POST.get('code') or '').strip()
        content = request.POST.get('content', '').replace('\r\n', '\n').strip() + '\n'
        errors = []
        if not SLUG_RE.match(code):
            errors.append('编码必须为小写字母/数字/连字符，如 staging-rules')
        if PolicyPackVersion.objects.filter(code=code).exists() or (_file_for(code) and _file_for(code).exists()):
            errors.append(f'编码 `{code}` 已存在（平台或源目录）')
        data, perr = _parse(content)
        errors += perr
        if data.get('id') and str(data['id']) != code:
            errors.append(f'YAML 的 id 必须与编码一致（`{code}`）')
        if errors:
            return render(request, 'policies/form.html', {'create': True, 'errors': errors,
                                                          'content': content, 'code': code}, status=400)
        f = _file_for(code)
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(content, encoding='utf-8')
        obj, _ = _sync_record(code, content)
        messages.success(request, f'规则包 `{code}` 已创建（源文件 + 平台入库 v{obj.version}）')
        return redirect('policy_detail', code=code)

    demo = ('id: 新规则包编码\nname: 规则包名称（中文）\nversion: 1\nlocked: false\n\n'
            'rules:\n  - id: rule-1\n    severity: critical\n    text: 第一条红线规则文案。\n'
            '  - id: rule-2\n    severity: high\n    text: 第二条规则文案。')
    return render(request, 'policies/form.html', {'create': True, 'content': demo, 'code': ''})


@login_required
@require_POST
def policy_lock_toggle(request, code):
    """锁定/解锁切换：locked 的规则包禁止页面编辑（安全基线保护），解锁为显式操作；状态同步写源文件+DB"""
    obj = get_object_or_404(PolicyPackVersion, code=code)
    f = _file_for(code)
    new_locked = not obj.locked
    if f and f.exists():
        src = f.read_text(encoding='utf-8')
        src2 = re.sub(r'(?m)^locked\s*:\s*(true|false)\s*$', f'locked: {str(new_locked).lower()}', src)
        if src2 != src:
            f.write_text(src2, encoding='utf-8')
            obj.content = src2
            obj.sha256 = hashlib.sha256(src2.encode()).hexdigest()
    obj.locked = new_locked
    obj.published_at = datetime.now(timezone.utc)
    obj.save()
    action_txt = '锁定' if new_locked else '解锁'
    extra = '（安全基线保护：编辑入口关闭）' if new_locked else '——请谨慎修改基线规则'
    messages.success(request, f'规则包 `{code}` 已{action_txt}{extra}')
    return redirect('policy_detail', code=code)
