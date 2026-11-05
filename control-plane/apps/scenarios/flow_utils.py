"""流程环节链式补全（2026-10-23 ian：测试流程每个路径做成流程板块，板块与前一步骤衔接，可直观看到上一步/下一步的用例与页面路径）"""


def _brief(st):
    """上一步/下一步摘要：编号 · 名称 · 端 · 页面路径列表"""
    if not st:
        return None
    paths = []
    for p in (st.get('pages') or []):
        if isinstance(p, dict):
            v = (p.get('path') or '').strip()
            if v:
                paths.append(v)
    return {
        'seq': st.get('seq'),
        'id': st.get('id') or '-',
        'name': st.get('name') or '',
        'side': st.get('side') or '',
        'paths': paths[:3],
        'path_count': len(paths),
    }


def chain_steps(steps):
    """为环节列表补 seq/total/prev/next（就地补全并返回），供时间线板块模板渲染"""
    steps = list(steps or [])
    total = len(steps)
    for i, st in enumerate(steps):
        st['seq'] = i + 1
        st['total'] = total
    for i, st in enumerate(steps):
        st['prev'] = _brief(steps[i - 1] if i > 0 else None)
        st['next'] = _brief(steps[i + 1] if i + 1 < total else None)
    return steps
