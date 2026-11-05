import hashlib, re
from datetime import datetime, timezone
from pathlib import Path

from django.contrib import messages
from django.contrib.auth.decorators import login_required
from django.shortcuts import render, get_object_or_404, redirect
from django.utils.safestring import mark_safe
from html import escape

from .models import SkillPackVersion

# 2026-10-15 ian：Skills 页面查看/编辑/新建——宿主机 skill-packs 目录（compose 挂载到容器 /opt/skill-packs）
# 为单一数据源：页面保存直接写源文件 + 入库（version+1），make sync 幂等（hash 相同 skip）。
SKILL_ROOT = Path('/opt/skill-packs')
SLUG_RE = re.compile(r'^[a-z0-9]+(?:-[a-z0-9]+)*$')


def _parse_front(text: str):
    """解析 frontmatter（id/version/name）+ 正文"""
    m = re.match(r'^---\s*\n(.*?)\n---\s*\n?(.*)$', text, re.S)
    meta, body = {}, text
    if m:
        for line in m.group(1).splitlines():
            mm = re.match(r'^(id|version|name)\s*:\s*(.*)$', line.strip())
            if mm:
                meta[mm.group(1)] = mm.group(2).strip()
        body = m.group(2)
    return meta, body


def _file_for(code: str):
    """code → SKILL.md 路径（slug 校验防路径穿越）"""
    if not code or not SLUG_RE.match(code):
        return None
    return SKILL_ROOT / code / 'SKILL.md'


def _count_rules(body: str) -> int:
    """统计正文规则条数（有序/无序列表行）"""
    return sum(1 for ln in body.splitlines() if re.match(r'^\s*(\d+[.、)]|-)\s*\S', ln))


def _render_body(body: str):
    """轻量 markdown 渲染（# 标题 / 有序无序列表 / 段落），文本全部 escape 防 XSS"""
    out, in_list, tag = [], False, None

    def close():
        nonlocal in_list
        if in_list:
            out.append('</ol>' if tag == 'ol' else '</ul>')
            in_list = False

    for line in body.splitlines():
        s = line.strip()
        if not s:
            close(); continue
        if s.startswith('#'):
            close()
            out.append(f'<div class="fw-bold text-muted mt-2 mb-1" style="font-size:13px">{escape(s.lstrip("# ").strip())}</div>')
        elif re.match(r'^\d+\s*[.、)]', s) or s.startswith(('- ', '* ')):
            new_tag = 'ol' if re.match(r'^\d+', s) else 'ul'
            if in_list and tag != new_tag:
                close()
            if not in_list:
                out.append(f'<{new_tag} class="mb-1" style="font-size:13px;padding-left:1.3rem">')
                in_list, tag = True, new_tag
            item = re.sub(r'^(\d+\s*[.、)]|-|\*)\s*', '', s)
            out.append(f'<li>{escape(item)}</li>')
        else:
            close()
            out.append(f'<div style="font-size:13px">{escape(s)}</div>')
    close()
    return mark_safe(''.join(out))


def _sync_record(code: str, content: str):
    """源文件内容 → 入库（就地更新，version+1；code 唯一约束下唯一可行方案）"""
    sha = hashlib.sha256(content.encode()).hexdigest()
    meta, _ = _parse_front(content)
    obj = SkillPackVersion.objects.filter(code=code).order_by('-version').first()
    if obj:
        if obj.sha256 == sha:
            return obj, False
        obj.content, obj.sha256 = content, sha
        obj.version = obj.version + 1
    else:
        obj = SkillPackVersion(code=code, version=1, content=content, sha256=sha)
    obj.name = meta.get('name', '')
    obj.published_at = datetime.now(timezone.utc)
    obj.save()
    return obj, True


@login_required
def skill_list(request):
    objects = []
    for o in SkillPackVersion.objects.all():
        f = _file_for(o.code)
        src = f.read_text(encoding='utf-8') if (f and f.exists()) else ''
        _, body = _parse_front(o.content)
        objects.append({
            'o': o, 'rules': _count_rules(body),
            'has_file': bool(src), 'in_sync': bool(src) and hashlib.sha256(src.encode()).hexdigest() == o.sha256,
        })
    return render(request, 'skills/list.html', {'objects': objects})


@login_required
def skill_detail(request, code):
    obj = get_object_or_404(SkillPackVersion, code=code)
    f = _file_for(code)
    src = f.read_text(encoding='utf-8') if (f and f.exists()) else ''
    meta, body = _parse_front(obj.content)
    src_meta, src_body = _parse_front(src) if src else ({}, '')
    return render(request, 'skills/detail.html', {
        'obj': obj, 'meta': meta, 'body_html': _render_body(body), 'rules': _count_rules(body),
        'has_file': bool(src), 'in_sync': bool(src) and hashlib.sha256(src.encode()).hexdigest() == obj.sha256,
        'src_version': src_meta.get('version', '-'),
    })


@login_required
def skill_edit(request, code):
    obj = get_object_or_404(SkillPackVersion, code=code)
    f = _file_for(code)
    if not f or not f.exists():
        return render(request, 'skills/form.html', {
            'obj': obj, 'errors': [f'源文件 {code}/SKILL.md 不存在（容器未挂载或已被删除），无法编辑'], 'content': obj.content,
        }, status=400)

    if request.method == 'POST':
        content = request.POST.get('content', '').replace('\r\n', '\n').strip() + '\n'
        meta, _ = _parse_front(content)
        errors = []
        if not re.search(r'^---\s*$', content, re.M) or 'id:' not in content:
            errors.append('必须保留 frontmatter 头（--- 之间的 id/version/name）')
        if meta.get('id') and meta['id'] != code:
            errors.append(f'frontmatter 的 id 必须保持为 `{code}`（不允许改 id；如需新技能请用「新建技能包」）')
        if not (meta.get('name') or '').strip():
            errors.append('frontmatter 的 name 不能为空')
        if not _parse_front(content)[1].strip():
            errors.append('正文不能为空（请编写规范条目）')
        if errors:
            return render(request, 'skills/form.html', {'obj': obj, 'errors': errors, 'content': content}, status=400)
        # version 行强制重写为入库新版本，写源文件 → 入库
        content = re.sub(r'(?m)^version\s*:\s*\d+\s*$', f'version: {obj.version + 1}', content)
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(content, encoding='utf-8')
        saved, changed = _sync_record(code, content)
        messages.success(request, f'技能包 `{code}` 已保存（源文件 + 平台入库 v{saved.version}' +
                         ('，内容有变更' if changed else '，内容未变化（hash 相同，版本未升）') + '）')
        return redirect('skill_detail', code=code)

    return render(request, 'skills/form.html', {'obj': obj, 'content': f.read_text(encoding='utf-8')})


@login_required
def skill_create(request):
    if request.method == 'POST':
        code = (request.POST.get('code') or '').strip()
        content = request.POST.get('content', '').replace('\r\n', '\n').strip() + '\n'
        errors = []
        if not SLUG_RE.match(code):
            errors.append('编码必须为小写字母/数字/连字符，如 ecommerce-order')
        if SkillPackVersion.objects.filter(code=code).exists() or (_file_for(code) and _file_for(code).exists()):
            errors.append(f'编码 `{code}` 已存在（平台或源目录）')
        meta, body = _parse_front(content)
        if meta.get('id') and meta['id'] != code:
            errors.append(f'frontmatter 的 id 必须与编码一致（`{code}`）')
        if not (meta.get('name') or '').strip():
            errors.append('frontmatter 的 name 不能为空')
        if not body.strip():
            errors.append('正文不能为空（请编写规范条目）')
        if errors:
            return render(request, 'skills/form.html', {'create': True, 'errors': errors,
                                                        'content': content, 'code': code}, status=400)
        f = _file_for(code)
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(content, encoding='utf-8')
        obj, _ = _sync_record(code, content)
        messages.success(request, f'技能包 `{code}` 已创建（源文件 + 平台入库 v{obj.version}）')
        return redirect('skill_detail', code=code)

    demo = '---\nid: 新技能编码\nversion: 1\nname: 技能包名称（中文）\n---\n\n# 必须检查\n1. 第一条规范。\n2. 第二条规范。\n\n# 判断边界\n- 允许的例外情况。'
    return render(request, 'skills/form.html', {'create': True, 'content': demo, 'code': ''})
