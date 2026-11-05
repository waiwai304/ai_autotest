# -*- coding: utf-8 -*-
"""AI 口语 → 结构化测试计划（2026-10-30 ian：AI 口语建用例一期）。

链路：AiConfig + action_registry + 站点摘要 → prompt → ai_client.chat_json → 严格校验。

校验铁律（完成率的来源）：
- action 必须在注册表白名单内，否则归一为 unknown（显式标注待人工，绝不硬猜）
- 参数按注册表 schema 清洗（只保留声明 key、截断长度）
- steps 非空、side 归一 pc/wap、id 重排 S1..Sn

安全：prompt 只含页面结构与口语描述，绝不含测试账号密码（Policy: no-secret-to-ai）。
"""
import json

from django.urls import reverse

from . import action_registry as ar
from .ai_client import AiClientError, chat_json_ex

SITES_JSON_CANDIDATES = ('/data/runner-config/sites.json', '/workspace/runner/config/sites.json')

VALID_SIDES = ('pc', 'wap')


def load_profile(profile_key: str) -> dict:
    """读站点档案（同 sites/views._available_profiles 的挂载路径）"""
    import json as _json
    for p in SITES_JSON_CANDIDATES:
        try:
            with open(p) as f:
                sites = (_json.load(f) or {}).get('sites', [])
            for s in sites:
                if str(s.get('id')) == profile_key:
                    return s
        except Exception:
            continue
    return {}


def site_brief(site) -> str:
    """站点摘要（进 prompt）：名称/域名/档案页面路径表。不含任何账密。"""
    prof = load_profile(getattr(site, 'profile_key', '') or '')
    pc_paths = (prof.get('pc') or {}).get('paths', {}) or {}
    lines = [f"- 站点名称：{site.name}（code={site.code}）"]
    if site.pc_base_url:
        lines.append(f'- PC 前台：{site.pc_base_url}')
    if site.wap_base_url:
        lines.append(f'- WAP 前台：{site.wap_base_url}')
    if pc_paths:
        mapping = '；'.join(f'{k}={v}' for k, v in list(pc_paths.items())[:24])
        lines.append(f'- PC 已知页面路径表（goto_path 时优先使用）：{mapping}')
    return '\n'.join(lines)


SYSTEM_TMPL = """你是电商网站自动化测试用例规划器。把用户的口语描述转成结构化测试计划 JSON。

【可用动作原语（白名单，action 只能从中选择）】
{registry}

【硬性规则】
1. 只能使用白名单中的 action。白名单没有、或你不确定的动作 → action 填 "unknown"，把原始意图写进步骤 name，便于人工后续实现。
2. 不要输出"铺垫性"步骤：登录/搜索等前置依赖系统会自动补齐——除非用户明确要验证该步本身（如「验证登录成功」）。
3. 每一步都必须给 name（做什么，简洁）和 expect（怎样算成功，可验证的表述）。
4. 对页面结果/文案的验证用 check_text（参数 text=期望出现的文本）。
5. side 只能是 pc 或 wap；用户没说端就默认 pc。wap 端已支持原语：wap_login / wap_open_home / wap_goto_path / wap_check_text（可直接使用）；wap 搜索/详情/加购类尚未适配，涉及这些意图时 action 标 unknown 并说明，系统会自动占位。
6. params 只填白名单声明的参数 key，不要发明新参数。
7. 只输出一个 JSON 对象，禁止输出任何解释文字。格式：
{{"name":"用例名称","description":"一句话说明","requires_auth":true,
"steps":[{{"id":"S1","side":"pc","action":"login","params":{{}},"name":"登录前台","expect":"登录成功跳转首页"}}]}}

【深度与完整度要求（2026-11-05 ian：一次口语产出最大化可用用例）】
A. 计划要覆盖用户意图的每一个可验证环节，宁细勿粗：建议 6~15 步，复杂流程可到 20 步。
B. 关键写操作（加购/提交表单/点击按钮）之后，紧跟一步验证（check_cart / check_text / expect_submit_ok / expect_url），形成「操作→断言」配对，不要只操作不验证。
C. 用户描述含糊时主动做合理展开：给出具体搜索关键词、具体期望文案、具体路径断言；展开要贴合电商站点通用结构（搜索/详情/购物车/留言/contact 等路径见站点路径表）。
D. 涉及账号时优先考虑独立账号安全：描述提到"注册/新用户"→ 第一步用 register；需要登录的写操作场景也可建议 register（独立新账号，不污染测试数据）。
E. 页面可达性检查（goto_path + check_text 组合）可用于补齐覆盖面：描述提到的每个页面尽量都有对应步骤。
F. 用户没写的"收尾验证"（如回到首页确认状态）可以加，但每步都必须真的可验证，禁止凑数步骤。

【示例】口语「先登录，搜索蓝牙耳机进第一个商品，加购后去购物车验证」→
{{"name":"蓝牙耳机加购购物车验证","description":"搜索选品加购并在购物车校验","requires_auth":true,
"steps":[
{{"id":"S1","side":"pc","action":"login","params":{{}},"name":"登录前台","expect":"登录成功进入首页"}},
{{"id":"S2","side":"pc","action":"search","params":{{"keyword":"蓝牙耳机"}},"name":"搜索蓝牙耳机","expect":"结果页出现商品列表"}},
{{"id":"S3","side":"pc","action":"open_first_product","params":{{}},"name":"打开商品详情","expect":"详情页渲染出价格与立即购买按钮"}},
{{"id":"S4","side":"pc","action":"add_cart","params":{{}},"name":"加入购物车","expect":"加购接口成功且购物车徽标+1"}},
{{"id":"S5","side":"pc","action":"check_cart","params":{{}},"name":"购物车校验","expect":"购物车页含刚加购的商品"}}]}}"""


def normalize_plan(data: dict, case_text: str) -> dict:
    """校验/归一模型输出。返回 {name,description,requires_auth,ends,steps,unknown,mutating}
    步骤结构 = doc_steps 兼容格式：{id,side,name,expect,action,params,source}；不合法字段静默修正。"""
    name = str(data.get('name') or '').strip()[:80] or 'AI 口语用例'
    description = str(data.get('description') or '').strip()[:300] or case_text.strip()[:200]
    requires_auth = bool(data.get('requires_auth', True))

    raw_steps = data.get('steps') or []
    if not isinstance(raw_steps, list) or not raw_steps:
        raise AiClientError('模型输出中没有步骤（steps 为空），请换一种描述重试')

    steps, unknown = [], 0
    for i, s in enumerate(raw_steps, 1):
        if not isinstance(s, dict):
            continue
        side = str(s.get('side') or 'pc').strip().lower()
        if side not in VALID_SIDES:
            side = 'pc'
        action_raw = str(s.get('action') or '').strip()
        action = action_raw if action_raw in ar.by_action_all() else 'unknown'
        if action == 'unknown':
            unknown += 1
        params = ar.normalize_params(action if action != 'unknown' else '', s.get('params'))
        st = {
            'id': f'S{i}',
            'side': side,
            'action': action,
            'params': params,
            'name': str(s.get('name') or '').strip()[:120] or f'步骤 {i}',
            'expect': str(s.get('expect') or '').strip()[:200],
        }
        if action == 'unknown' and action_raw:
            st['ai_action_raw'] = action_raw[:40]
        steps.append(st)

    if not steps:
        raise AiClientError('模型输出步骤全部无法解析，请重试')

    ends = []
    for e in ('pc', 'wap'):
        if any(st['side'] == e for st in steps):
            ends.append(e)
    mutating = any(st['action'] in ar.MUTATING_ACTIONS for st in steps)
    return {'name': name, 'description': description, 'requires_auth': requires_auth,
            'ends': ends or ['pc'], 'steps': steps, 'unknown': unknown, 'mutating': mutating}


def plan(case_text: str, site) -> dict:
    """主入口：口语 + 站点 → 计划 dict。AI 调用失败抛 AiClientError。"""
    from .models import AiConfig
    cfg = AiConfig.get_solo()
    if not cfg.ready:
        raise AiClientError('Agent 未接入或未启用：请先在「AI 接入设置」完成配置')
    system = SYSTEM_TMPL.format(registry=ar.render_for_prompt())
    user = f'【目标站点】\n{site_brief(site)}\n\n【口语描述】\n{case_text.strip()}'
    # 2026-11-05 ian：规划 token 预算上调（深度计划 6~20 步，reasoning 模型思考+正文需要更大额度）
    data, err, stats = chat_json_ex(cfg, system, user, max_tokens=max(8000, int(cfg.max_tokens or 0)))
    if err:
        raise AiClientError(err)
    if not isinstance(data, dict):
        raise AiClientError('模型返回的 JSON 不是对象，请重试')
    out = normalize_plan(data, case_text)
    out['case_text'] = case_text.strip()
    out['ai_stats'] = stats
    return out


def plan_stream(case_text: str, site):
    """流式版 plan（2026-11-04 ian：AI 建用例页面实时输出）。
    生成器 yield 事件 tuple (type, payload)：
      ('reasoning', '思考增量')          —— reasoning 模型思考过程（可无）
      ('delta', '正文增量')              —— 模型输出的计划 JSON 文本
      ('stats', {...})                   —— 用量统计（网关未返回时 elapsed 仍在）
      ('done', plan_dict)                —— 校验通过的最终计划（与 plan() 同构）
      ('error', '面向用户的消息')        —— 任一环节失败
    校验逻辑与 plan() 完全一致（extract_json 容错 + normalize_plan）。"""
    import time as _time
    from .models import AiConfig
    from .ai_client import chat_stream, extract_json
    cfg = AiConfig.get_solo()
    if not cfg.ready:
        yield 'error', 'Agent 未接入或未启用：请先在「AI 接入设置」完成配置并启用'
        return
    system = SYSTEM_TMPL.format(registry=ar.render_for_prompt())
    user = f'【目标站点】\n{site_brief(site)}\n\n【口语描述】\n{case_text.strip()}'
    t0 = _time.monotonic()
    content, usage = [], {}
    try:
        for ev in chat_stream(cfg, system, user):
            if ev['type'] == 'usage':
                usage = ev['usage'] or {}
            elif ev['type'] == 'reasoning':
                yield 'reasoning', ev['text']
            elif ev['type'] == 'delta':
                content.append(ev['text'])
                yield 'delta', ev['text']
    except AiClientError as e:
        yield 'error', str(e)
        return
    full = ''.join(content).strip()
    stats = {
        'elapsed_ms': int((_time.monotonic() - t0) * 1000),
        'prompt_tokens': usage.get('prompt_tokens'),
        'completion_tokens': usage.get('completion_tokens'),
        'total_tokens': usage.get('total_tokens'),
    }
    yield 'stats', stats
    data = extract_json(full)
    if data is None:
        yield 'error', '模型未返回可解析的 JSON（已尝试容错提取），请重试或调整描述'
        return
    if not isinstance(data, dict):
        yield 'error', '模型返回的 JSON 不是对象，请重试'
        return
    out = normalize_plan(data, case_text)
    out['case_text'] = case_text.strip()
    out['ai_stats'] = stats
    yield 'done', out


REPLAN_TMPL = """你是自动化测试用例修正器。下面的测试计划在真实网站探索/执行中部分步骤失败，请根据失败证据输出修正后的完整计划 JSON。

【可用动作原语（白名单，action 只能从中选择）】
{registry}

【修正规则】
1. 输出必须包含计划中的全部步骤（含成功步骤，可保留原样；只修正失败/有问题的步骤）。
2. 失败原因若是参数问题（路径不存在、关键词无结果、断言文本不出现）→ 优先修参数（用证据里的实际 URL/文本）。
3. 失败原因若是该流程在站点上走不通 → 把该步 action 改为 "unknown" 并在 name 里说明实际障碍，便于人工处理。
4. 白名单外的意图仍然标 unknown，禁止发明动作。
5. 证据里的「实际 URL」往往是正确路径，goto_path 修正时优先采用。
6. 只输出一个 JSON 对象，格式与原计划相同：
{{"name":"...","description":"...","requires_auth":true,"steps":[{{"id":"S1","side":"pc","action":"...","params":{{}},"name":"...","expect":"..."}}]}}"""


def replan(plan: dict, evidence: list, site) -> dict:
    """基于探索/干跑失败证据重规划。evidence: [{'id','action','name','expect','ok','error','note','url'}]。
    返回与 plan() 同构的新计划（失败步骤被修正）。AI 失败抛 AiClientError。"""
    from .models import AiConfig
    cfg = AiConfig.get_solo()
    if not cfg.ready:
        raise AiClientError('Agent 未接入或未启用：请先在「AI 接入设置」完成配置')

    def _clean_steps(steps):
        out = []
        for s in steps or []:
            if isinstance(s, dict):
                out.append({k: s.get(k) for k in ('id', 'side', 'action', 'params', 'name', 'expect') if k in s})
        return out

    ev_lines = []
    for e in evidence or []:
        mark = 'OK' if e.get('ok') else 'FAIL'
        ev_lines.append('- [' + mark + '] ' + str(e.get('id')) + ' ' + str(e.get('action'))
                        + '「' + str(e.get('name')) + '」预期:' + str(e.get('expect'))
                        + '｜结果:' + str(e.get('note') or e.get('error'))
                        + '｜实际URL:' + str(e.get('url') or '-'))
        # 2026-11-04 ian：页面感知 replan——失败步骤附「失败页可见链接摘要」，
        # 模型能看到页面真实入口（文本→路径），据此精确改选 goto_path/click_text 参数。
        pl = str(e.get('page_links') or '').strip()
        if not e.get('ok') and pl:
            ev_lines.append('  ↳ 失败页可见链接: ' + pl[:800])
    system = REPLAN_TMPL.format(registry=ar.render_for_prompt())
    plan_clean = json.dumps({'name': plan.get('name'), 'description': plan.get('description'),
                             'requires_auth': plan.get('requires_auth'),
                             'steps': _clean_steps(plan.get('steps'))}, ensure_ascii=False)
    user = ('【原计划（JSON）】\n' + plan_clean
            + '\n\n【逐步执行证据】\n' + ('\n'.join(ev_lines) or '（无逐步证据，仅整体失败）'))
    data, err, stats = chat_json_ex(cfg, system, user)
    if err:
        raise AiClientError(err)
    if not isinstance(data, dict):
        raise AiClientError('模型返回的 JSON 不是对象，请重试')
    out = normalize_plan(data, plan.get('case_text') or plan.get('description') or '')
    # 修正器必须保留全部步骤：丢步会被 id 重排掩盖（vN+1 必须覆盖原计划所有步骤）。
    # 2026-11-04 ian：但「模型把一步拆成两步 / 合并两步」很常见（EXPLORE-000016 实录：4 步→5 步），
    # 旧逻辑直接抛错 → 页面静默重定向，用户以为「点 AI 修正没反应」。
    # 改为按 id 归并：原计划每个 id 用模型返回的同 id 覆盖；模型新增的步骤追加在尾部并重新编号；
    # 模型漏掉的 id 保留原步骤，保证零丢步。
    orig_steps = plan.get('steps') or []
    if orig_steps:
        got = {str(s.get('id') or '').upper(): s for s in out['steps']}
        merged, extra = [], []
        for s in orig_steps:
            sid = str(s.get('id') or '').upper()
            merged.append(got.pop(sid, s))
        for s in out['steps']:
            if str(s.get('id') or '').upper() in {str(x.get('id') or '').upper() for x in orig_steps}:
                continue
            extra.append(s)
        # 追加的步骤重新编号，避免 id 冲突
        nxt = len(merged) + 1
        for s in extra:
            s = dict(s)
            s['id'] = f'S{nxt}'
            nxt += 1
            merged.append(s)
        out['steps'] = merged
        if len(merged) != len(orig_steps):
            out['replan_note'] = f'模型输出 {len(out["steps"])} 步 / 原计划 {len(orig_steps)} 步，已按 id 归并（新增步骤追加为 S{len(orig_steps)+1} 起）'
    out['case_text'] = plan.get('case_text') or ''
    out['ai_stats'] = stats
    return out
