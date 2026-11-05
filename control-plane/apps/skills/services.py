"""技能包解析服务（2026-11-04 ian）

背景：平台「规范技能」页的技能包此前只做**展示**（skill_packs 恒为空数组），生成用例时不参与。
本次改造：按用例内容（动作/文本/步骤说明）自动识别需要生效的技能包，写入 RunManifest，
并在执行时注入 runner 环境变量 SKILL_PACKS，供执行侧（docflow 原语）判定与留痕。

首条规则：用例含「注册」流程 → 挂载 temp-mail-verification-code
  （注册时校验站点是否要求邮箱验证码，需要则调用临时邮箱接口收码完成注册）
"""
import json
import re

from .models import SkillPackVersion

# (技能包 code, 触发正则, 触发说明)
RULES = [
    (
        'temp-mail-verification-code',
        r'注册|register|sign\s*up|邮箱验证|验证码|临时邮箱',
        '用例含注册/邮箱验证流程 → 校验站点是否要求邮箱验证码，需要则用临时邮箱收码',
    ),
    ('popup-ad-guard', r'开屏广告|弹窗|广告', '用例涉及开屏广告/弹窗拦截'),
    ('production-safety', r'生产|真实下单|真实支付|下单', '用例涉及生产安全边界'),
]


def _text_of(sv, extra_text: str = '') -> str:
    """汇总用于规则匹配的文本：动作列表 + runner_spec + 用例说明/步骤名 + 额外文本"""
    parts = []
    d = getattr(sv, 'definition', None) or {}
    for key in ('code', 'name', 'desc', 'description'):
        v = d.get(key)
        if isinstance(v, str):
            parts.append(v)
    parts.extend(str(a) for a in (d.get('actions') or []))
    parts.extend(str(s) for s in (d.get('steps') or [])[:0] or [])
    for st in (d.get('steps') or []):
        if isinstance(st, dict):
            parts.extend(str(st.get(k, '')) for k in ('name', 'action', 'expect', 'note'))
        else:
            parts.append(str(st))
    spec = getattr(sv, 'runner_spec', '') or ''
    parts.append(spec)
    if extra_text:
        parts.append(str(extra_text))
    try:
        parts.append(sv.scenario.name or '')
        parts.append(sv.scenario.code or '')
    except Exception:
        pass
    return '\n'.join(parts)


def resolve_codes(sv, extra_text: str = '') -> list[str]:
    """按规则返回命中的技能包 code（按 RULES 顺序、去重）"""
    text = _text_of(sv, extra_text)
    out: list[str] = []
    for code, pattern, _reason in RULES:
        if re.search(pattern, text, re.I) and code not in out:
            out.append(code)
    return out


def packs_payload(codes: list[str]) -> list[dict]:
    """code → 实际入库的最新版本信息（含 sha256，便于运行留痕精确到版本）"""
    out = []
    for code in codes:
        obj = SkillPackVersion.objects.filter(code=code).order_by('-version').first()
        if not obj:
            continue
        out.append({'code': obj.code, 'version': obj.version, 'name': obj.name or '', 'sha256': obj.sha256 or ''})
    return out


def resolve_for_version(sv, extra_text: str = '') -> list[dict]:
    """用例版本 → 需要生效的技能包列表（manifest.skill_packs 用）"""
    return packs_payload(resolve_codes(sv, extra_text))


def summarize(packs: list[dict]) -> str:
    """一行摘要（日志/报告展示）"""
    if not packs:
        return ''
    return '、'.join(f"{p['code']}@v{p['version']}" for p in packs)


def rules_for_codes(codes: list[str]) -> list[str]:
    """返回命中规则的说明文案（供用例说明/报告展示）"""
    out = []
    for code, pattern, reason in RULES:
        if code in codes:
            out.append(reason)
    return out


def packs_json(packs: list[dict]) -> str:
    return json.dumps(packs, ensure_ascii=False)
