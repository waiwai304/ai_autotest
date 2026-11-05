# -*- coding: utf-8 -*-
"""测试用例规范文本解析器（2026-09-26 ian：cases 页面新增用例入口）
解析《测试用例编写规范》（docs/测试用例编写规范.md）定义的文本格式：
  字段行：`字段名：值`（支持：用例名称/用例标识/用例说明/测试端/需要登录/含写操作/自定义设置，别名兼容口语写法）
  段标记：`步骤：` / `自定义设置：`（支持同行直接跟第一条内容）
  步骤行：`编号 | 端 | 动作 | 预期`（2~4 段竖线分隔）
返回 (data, errors)：data 为可直接落库的 dict，errors 为面向用户的错误列表。
"""
import re

SLUG_RE = re.compile(r'^[a-z0-9]+(?:-[a-z0-9]+)*$')
END_MAP = {
    'pc': ['pc'], '电脑': ['pc'], '电脑端': ['pc'], '桌面': ['pc'], '桌面端': ['pc'],
    'wap': ['wap'], '手机': ['wap'], '手机端': ['wap'], '移动端': ['wap'], 'h5': ['wap'],
    'pc+wap': ['pc', 'wap'], 'wap+pc': ['pc', 'wap'], '双端': ['pc', 'wap'],
    'both': ['pc', 'wap'], '全端': ['pc', 'wap'],
}
BOOL_MAP = {'是': True, '需要': True, '有': True, 'y': True, 'yes': True, 'true': True, '1': True,
            '否': False, '不需要': False, '无': False, 'n': False, 'no': False, 'false': False, '0': False}

# 字段名 → 规范 key（别名兼容口语写法）
FIELD_ALIASES = {
    '用例名称': 'name', '名称': 'name', '用例名': 'name', '标题': 'name',
    '用例标识': 'code', '标识': 'code', '用例编码': 'code', '编码': 'code',
    '用例说明': 'desc', '说明': 'desc', '描述': 'desc', '用例描述': 'desc', '用例目的': 'desc',
    '测试端': 'ends', '端': 'ends', '执行端': 'ends', '平台': 'ends',
    '需要登录': 'requires_auth', '登录': 'requires_auth', '需要授权': 'requires_auth',
    '含写操作': 'mutating', '写操作': 'mutating', '是否写操作': 'mutating',
    '自定义设置': 'settings_raw', '设置': 'settings_raw',
}
STEP_MARKER_RE = re.compile(r'^(步骤清单|步骤列表|测试步骤|步骤)\s*[：:]\s*(.*)$')
SETTINGS_LINE_RE = re.compile(r'^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^（(]*?)\s*(?:[（(]([^）)]*)[）)])?$')


def _norm(s: str) -> str:
    return (s or '').strip().strip('：:').strip()


def parse_case_text(text: str) -> tuple[dict, list]:
    """解析规范文本 → (data, errors)。data 字段：name/code/desc/ends/requires_auth/mutating/settings/steps"""
    errors, data = [], {'settings': [], 'steps': []}
    lines = (text or '').replace('\r\n', '\n').split('\n')
    in_settings, in_steps = False, False

    def eat_step(content: str, ln: int):
        """解析一条步骤行 `编号 | 端 | 动作 | 预期`（2~4 段）"""
        parts = [p.strip() for p in content.split('|')]
        if not (2 <= len(parts) <= 4):
            errors.append(f'第{ln}行：步骤格式应为 `编号|动作|预期`（2~4 段竖线分隔），收到 `{content}`')
            return
        sid = parts[0]
        if len(parts) == 4:                        # 编号|端|动作|预期
            side, name, expect = parts[1].upper(), parts[2], parts[3]
            if side not in ('PC', 'WAP'):
                errors.append(f'第{ln}行：4 段步骤的第 2 段必须是 PC 或 WAP，收到 `{parts[1]}`')
                return
        elif len(parts) == 3:
            if parts[1].upper() in ('PC', 'WAP'):  # 编号|端|动作
                side, name, expect = parts[1].upper(), parts[2], ''
            else:                                  # 编号|动作|预期
                side, name, expect = '', parts[1], parts[2]
        else:                                      # 编号|动作
            side, name, expect = '', parts[1], ''
        if not sid or not name:
            errors.append(f'第{ln}行：步骤编号与操作动作不能为空')
            return
        data['steps'].append({'id': sid, 'side': side, 'name': name, 'expect': expect})

    def eat_setting(content: str, ln: int):
        """解析一条自定义设置 `参数名=默认值（说明）`"""
        sm = SETTINGS_LINE_RE.match(content)
        if sm:
            data['settings'].append({'key': sm.group(1), 'type': 'text',
                                     'label': _norm(sm.group(3) or sm.group(1)),
                                     'default': _norm(sm.group(2))})
        else:
            errors.append(f'第{ln}行：自定义设置格式应为 `参数名=默认值（说明）`，收到 `{content}`')

    for ln, raw in enumerate(lines, 1):
        line = (raw or '').strip()
        if not line:
            continue

        # ---- 段标记行 `步骤：` / `步骤：S1 | ...`（支持同行第一条） ----
        sm = STEP_MARKER_RE.match(line)
        if sm:
            in_settings, in_steps = False, True
            if sm.group(2).strip():
                eat_step(sm.group(2).strip(), ln)
            continue

        # ---- 字段行 `字段：值` ----
        m = re.match(r'^([^：:|]+)\s*[：:]\s*(.*)$', line)
        if m:
            fname_raw = _norm(m.group(1))
            fname = fname_raw.lower()
            key = FIELD_ALIASES.get(fname) or FIELD_ALIASES.get(m.group(1))
            if key:
                in_settings = (key == 'settings_raw')
                in_steps = False
                rest = m.group(2).strip()
                if key == 'settings_raw':
                    if rest:  # 同行直接跟设置项：`自定义设置：keyword=数据线`
                        eat_setting(rest, ln)
                    continue
                _assign(data, key, rest, ln, errors, fname_raw)
                continue

        # ---- 自定义设置行 `k=默认值（说明）` ----
        if in_settings:
            eat_setting(line, ln)
            continue

        # ---- 步骤行 `编号 | 端 | 动作 | 预期`（2~4 段） ----
        if in_steps:
            eat_step(line, ln)
            continue

        errors.append(f'第{ln}行：无法识别的内容（字段行需 `字段：值`，步骤需在 `步骤：` 之后）')

    # ---- 必填校验 ----
    if not data.get('name'):
        errors.insert(0, '缺少必填字段：用例名称')
    if not data.get('code'):
        errors.insert(0, '缺少必填字段：用例标识')
    elif not SLUG_RE.match(data['code']):
        errors.insert(0, f'用例标识 `{data["code"]}` 不合法：只允许小写字母/数字/连字符（如 favorite-check）')
    if not data.get('desc'):
        errors.insert(0, '缺少必填字段：用例说明')
    if not data.get('ends'):
        errors.insert(0, '缺少必填字段：测试端（PC / WAP / PC+WAP）')
    if data.get('requires_auth') is None:
        errors.insert(0, '缺少必填字段：需要登录（是/否）')
    if data.get('mutating') is None:
        errors.insert(0, '缺少必填字段：含写操作（是/否）')
    if not data['steps']:
        errors.insert(0, '缺少步骤：请在 `步骤：` 之后按 `编号|动作|预期` 每步一行填写')

    # ---- 步骤编号唯一性 ----
    ids = [s['id'] for s in data['steps']]
    dup = {i for i in ids if ids.count(i) > 1}
    if dup:
        errors.append(f'步骤编号重复：{", ".join(sorted(dup))}')

    if errors:
        return {}, errors
    return data, []


def _assign(data: dict, key: str, value: str, ln: int, errors: list, fname: str = ''):
    v = _norm(value)
    if key == 'ends':
        ends = END_MAP.get(v.lower())
        if not ends:
            errors.append(f'第{ln}行：测试端必须是 PC / WAP / PC+WAP（双端），收到 `{v}`')
        else:
            data['ends'] = ends
    elif key in ('requires_auth', 'mutating'):
        b = BOOL_MAP.get(v.lower())
        if b is None:
            errors.append(f'第{ln}行：`{fname}` 只允许 是/否，收到 `{v}`')
        else:
            data[key] = b
    else:
        data[key] = v
