# -*- coding: utf-8 -*-
"""口语化测试用例步骤 → 可执行动作 映射引擎（2026-10-05 ian：口语输入后程序自动扩充为可直接执行的用例）

输入：case_parser.py 解析出的 doc_steps（每步 {id, side, name, expect}，name/expect 为口语中文）
输出：每步的动作原语 {action, args, prereq, note, body_ts}，body_ts 为可直接嵌入
     Playwright test 的真实 TypeScript 代码（调用 tests/helpers/docflow.ts 动作库）。

设计要点：
- 动作原语与前置链：每个 Playwright test 独立 browser context，因此每步必须自包含——
  按前置链自动补齐「登录→搜索→打开商品」等前置动作（对齐 tests/doc-buycart-check.spec.ts 实战写法）。
- 未识别步骤：降级为骨架占位（warn + test.skip），不会假绿；spec 其余真实步骤照常执行。
- WAP 端动作库尚未探针适配（2026-09-30 仅 PC 适配），WAP 步骤一律降级占位并标注。
- 模板含 TS 大括号，禁 f-string，统一 __PH__ 占位替换。
"""
import json
import re

from . import action_registry as _ar

# ---------------- 动作识别（按优先级） ----------------
# 每条：(action, [触发正则...])；name+expect 拼接后整体匹配
ACTION_RULES = [
    # check_cart 必须先于 add_cart：S4「跳转…购物车页面」含"购物车"但不是加购动作
    ('check_cart', [r'(打开|进入|访问|跳转|查看|检查|验证)[^。]{0,12}购物车(页|页面|列表)',
                    r'dashboard/cart|/cart']),
    ('add_cart',   [r'加购|加入购物车|添加到购物车|放到购物车|放入购物车']),
    ('favorite',   [r'收藏|关注商品']),
    ('click_text', [r'(点击|点一下|按一下|按下)[^。]{0,10}(提交|发送|留言|确认|保存|发送留言)']),
    ('expect_submit_ok', [r'(确认|验证|检查)[^。]{0,8}(提交|留言|发送)[^。]{0,6}(成功|已完成|结果)']),
    ('fill_form',  [r'(填写|填入|输入|填好|录入)[^。]{0,20}(信息|内容|留言|表单|姓名|联系方式|邮箱|电话)',
                    r'留言(区块|框|表单)|表单(填写|输入)']),
    ('open_first_product', [r'(?<![点按])(第[一个首]+|首个|任意|随便|某个|一个)(可?点击的?)?商品',
                            r'(点击|打开|进入|选择|跳转)[^。]{0,16}商品[^。]{0,0}',
                            r'商品(列表|详情)[^。]{0,10}(点击|打开|进入|跳转|查看)',
                            r'跳转商品详情|商品详情页']),
    ('search',     [r'搜索|检索|(输入|键入)[^。]{0,30}(并|后)[^。]{0,8}(搜索|回车|点|查询)|关键词']),
    # register 必须排在裸 login 之前：「注册并登录」类文本同时含两个词，注册语义优先。
    # 但「使用/用/以…(新)注册账号…登录」句式里"注册"仅是定语，动作是登录 → 定语 login 规则置顶抢先。
    ('login',      [r'(使用|用|以|拿).{0,16}(注册|新|测试)[的好的]{0,3}(账号|用户|身份).{0,8}(登录|登陆)']),
    ('register',   [r'注册|register']),
    ('login',      [r'登录|登陆']),
    ('open_home',  [r'(打开|访问|进入|回到)[^。]{0,6}(网站)?首页|首页(加载|正常|打开|展示)']),
]

# 前置链：action -> 依赖链（有序去重展开）；'__auth__' 占位 = requires_auth 时插入 login
PREREQ = {
    'search': ['__auth__'],
    'open_first_product': ['search'],
    'add_cart': ['open_first_product'],
    'check_cart': ['add_cart'],
    'favorite': ['open_first_product'],
    'goto_path': ['__auth__'],
    'check_text': [],
    'fill_form': [],
    'click_text': [],
    'expect_submit_ok': [],
    'hover_text': [],
    'expect_url': [],
    'scroll_to_text': [],
    'open_home': [],
    'login': [],
    'register': [],   # 2026-11-04 ian：注册无前置（未登录状态直接注册）；注册本身即登录边界
    'open_first_product_alias': [],
    # WAP（三期 2026-11）
    'wap_login': [],
    'wap_open_home': [],
    'wap_goto_path': ['wap_login'],
    'wap_check_text': [],
}

# ---------------- 参数提取 ----------------
KW_PATTERNS = [
    r'[“"\'「『]([^”"\'」』\s，。]{1,24})[”"\'」』]',
    r'(?:输入|键入)[：:\s]*([^\s，。；;：:]{1,24}?)(?=并|后|点击|按|，|,|。|\s|$)',
    r'(?:搜索|检索|查找)([^\s，。；;]{1,24}?)(?=按钮|框|并|后|点击|，|,|。|\s|$)',
    r'关键词[：:\s是为]*([^\s，。；;]{1,24})',
]
PATH_RE = re.compile(r'(/[A-Za-z0-9_\-/.]+)')
QUOTED_TEXT_RE = re.compile(r'[“"\'「『]([^”"\'」』]{1,40})[”"\'」』]')


def _extract_kw(name: str, expect: str, settings: list):
    """提取搜索关键词：自定义设置 keyword 默认值 > 口语提取 > 空（空=docflow 随机测试关键词）"""
    for s in settings or []:
        if s.get('key') == 'keyword' and s.get('default'):
            return str(s['default']).strip()
    text = f'{name} {expect}'
    for pat in KW_PATTERNS:
        for m in re.finditer(pat, text):
            g = (m.group(1) or '').strip()
            if g and not re.fullmatch(r'(框|框里|搜索框|输入框|页面|按钮|图标|商品名称|链接|关键词)', g):
                kw = g.strip('的')
                if kw:
                    return kw
    return ''


def _extract_path(name: str):
    m = PATH_RE.search(name or '')
    return m.group(1).rstrip('/') if m else ''


def _quoted_expect(expect: str):
    m = QUOTED_TEXT_RE.search(expect or '')
    return m.group(1).strip() if m else ''


def _ts_str(s) -> str:
    import json
    return json.dumps(str(s or ''), ensure_ascii=False)


# ---------------- 动作 → 真实 TS 代码（全部 __PH__ 占位，禁 f-string） ----------------
TS_SEARCH = """const picked = await searchPickAndOpen(page, logs, __KW__);"""
TS_LOGIN = """await login(page, logs);"""
TS_REGISTER = """await register(page, logs); // 技能包 temp-mail-verification-code：注册前校验站点是否要求邮箱验证码，需要则调用临时邮箱接口收码"""
TS_OPEN_HOME = """await openHome(page, logs);"""
TS_OPEN_FIRST = """expect(await waitDetailRendered(page), '商品详情页未渲染（30s）').toBeTruthy();
      const __BT_VAR__ = await page.evaluate('document.body.innerText');
      expect(__BT_VAR__, '详情页缺少「立即购买」按钮').toContain('立即购买');
      logs.push(`商品详情已打开: __PICKED_TITLE__`);"""
TS_ADD_CART = """await addCartAndVerify(page, logs);
      logs.push(`商品「__PICKED_TITLE__」加购成功（接口 code=1 / 购物车徽标 双证据）`);"""
TS_CHECK_CART = """await openCartAndCheck(page, logs, (picked.title || '').replace(/\\s+/g, '').slice(0, 8));"""
TS_GOTO = """await page.goto(new URL(__PATH__, pcUrl('home')).toString(), { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.waitForTimeout(3_000);
      logs.push(`已打开 __PATH__`);"""
TS_CHECK_TEXT = """await expectText(page, logs, __TEXT__);"""
# 2026-11-04 ian：通用交互原语（表单填写 / 按文本点击）——官网留言类用例的真实执行体
TS_NAV_PREFIX = """const __navPath = __PATH__;
      if (__navPath) { await page.goto(new URL(__navPath, pcUrl('home')).toString(), { waitUntil: 'domcontentloaded', timeout: 45_000 }); await page.waitForTimeout(2_500); }"""
TS_FILL_FORM = """await fillForm(page, logs, __FIELDS__);"""
TS_CLICK_TEXT = """await clickByText(page, logs, __TEXT__);"""
TS_EXPECT_SUBMIT = """await expectSubmitOk(page, logs);"""
# 2026-11-04 ian：通用网站原语二期（hover / URL 断言 / 滚动懒加载）——任意网站口语建测
TS_HOVER_TEXT = """await hoverText(page, logs, __TEXT__);"""
TS_EXPECT_URL = """await expectUrl(page, logs, __SUBSTR__);"""
TS_SCROLL_TO = """await scrollToText(page, logs, __TEXT__);"""

# ---- WAP 端模板（三期 2026-11：交互抽取自 wap-shopping-flow.spec.ts 实测代码）----
TS_WAP_LOGIN = """await wapLogin(page, logs);"""
TS_WAP_OPEN_HOME = """await wapOpenHome(page, logs);"""
TS_WAP_GOTO = """await wapOpenPath(page, logs, __PATH__);"""
TS_WAP_CHECK_TEXT = """await wapExpectText(page, logs, __TEXT__);"""

# WAP 可真实执行原语（= registry wap_* ready 子集）
WAP_READY_ACTIONS = ('wap_login', 'wap_open_home', 'wap_goto_path', 'wap_check_text')


def parse_step(step: dict, requires_auth: bool, settings: list, side_hint: str = '') -> dict:
    """解析单条口语步骤 → 动作原语。返回：
    {action, ok, note, body_ts, kw, path, text}  ok=False 表示未识别（降级骨架占位）
    """
    name = (step.get('name') or '').strip()
    expect = (step.get('expect') or '').strip()
    side = (step.get('side') or side_hint or 'PC').upper()
    text = f'{name}。{expect}'

    if side == 'WAP':
        preset_now = str(step.get('action') or '').strip()
        _p = step.get('params') or {}
        if preset_now in WAP_READY_ACTIONS:
            # ---- WAP 真实执行原语（三期 2026-11）：wapflow.ts 实测交互 ----
            if preset_now == 'wap_login':
                return {'action': preset_now, 'ok': True, 'note': 'WAP 登录前台（实测交互）',
                        'body_ts': TS_WAP_LOGIN, 'kw': '', 'path': '', 'text': ''}
            if preset_now == 'wap_open_home':
                return {'action': preset_now, 'ok': True, 'note': '打开 WAP 首页并校验渲染',
                        'body_ts': TS_WAP_OPEN_HOME, 'kw': '', 'path': '', 'text': ''}
            if preset_now == 'wap_goto_path':
                wp = str(_p.get('path') or '').strip()
                if not wp:
                    return {'action': 'fallback', 'ok': False, 'note': 'WAP 跳转未提供 path 参数（/ 开头路径或档案 key 如 cart）',
                            'body_ts': '', 'kw': '', 'path': '', 'text': ''}
                return {'action': preset_now, 'ok': True, 'note': f'WAP 直达 {wp}',
                        'body_ts': TS_WAP_GOTO.replace('__PATH__', _ts_str(wp)), 'kw': '', 'path': wp, 'text': ''}
            qt_w = str(_p.get('text') or '').strip()[:40]
            if not qt_w:
                return {'action': 'fallback', 'ok': False, 'note': 'WAP 文本断言未提供 text 参数',
                        'body_ts': '', 'kw': '', 'path': '', 'text': ''}
            return {'action': preset_now, 'ok': True, 'note': f'WAP 断言页面文本「{qt_w}」',
                    'body_ts': TS_WAP_CHECK_TEXT.replace('__TEXT__', _ts_str(qt_w)), 'kw': '', 'path': '', 'text': qt_w}
        return {'action': 'fallback', 'ok': False,
                'note': ('WAP 端该动作动作库尚未适配（搜索/详情/加购类原语为 placeholder），降级占位不假绿'
                         if preset_now.startswith('wap_') else
                         'WAP 端动作库仅支持 wap_login/wap_open_home/wap_goto_path/wap_check_text（三期），其余降级占位'),
                'body_ts': '', 'kw': '', 'path': '', 'text': ''}

    preset = str(step.get('action') or '').strip()
    # ---- unknown 改判兜底（2026-11-04 ian）----
    # AI 规划期白名单若缺原语，步骤会被标 unknown（name 写原始意图）。
    # 升级原语库后无需重新走 AI：unknown 视同"未标注"，落入 ACTION_RULES 正则识别，
    # name/expect 含"注册/登录/搜索…"等关键词即可自动改判为对应原语。
    if preset == 'unknown':
        preset = ''
    _params = step.get('params') or {}
    if preset:
        # ---- AI 标注动作（2026-10-30 ian：AI 口语建用例）----
        # 规划器输出已过注册表白名单校验；此处再兜底一次防脏数据。
        # 直接采用标注动作与参数（跳过正则猜词）——这是 AI 用例完成率的来源。
        static_actions = ('login', 'open_home', 'search', 'open_first_product',
                          'add_cart', 'check_cart', 'goto_path', 'check_text', 'register',
                          'fill_form', 'click_text', 'expect_submit_ok',
                          'hover_text', 'expect_url', 'scroll_to_text')
        action = preset if preset in static_actions else None
        kw = str(_params.get('keyword') or _params.get('kw') or '').strip()[:80]
        path = str(_params.get('path') or '').strip()
        qt = str(_params.get('text') or '').strip()[:40]
        fld = str(_params.get('fields') or '').strip()[:400]
        if action is None and preset in _ar.recipe_paths():
            # ---- 配方原语（三期 2026-11）：探索沉淀+人工核准，goto_path 等价执行 ----
            rpath = _ar.recipe_paths()[preset]
            return {'action': preset, 'ok': True,
                    'note': f'配方原语「{preset}」：登录后直达核准固化的目标页 {rpath}',
                    'body_ts': TS_GOTO.replace('__PATH__', _ts_str(rpath)),
                    'kw': '', 'path': rpath, 'text': ''}
        if action is None:
            raw = str(step.get('ai_action_raw') or preset)[:40]
            return {'action': 'fallback', 'ok': False,
                    'note': f'AI 规划动作「{raw}」不在原语白名单内，需人工实现（或升级原语库后重新生成）',
                    'body_ts': '', 'kw': kw, 'path': path, 'text': qt}
    else:
        action = None
        for act, pats in ACTION_RULES:
            for p in pats:
                if re.search(p, text):
                    action = act
                    break
            if action:
                break

        if action is None:
            # 兜底：纯跳转（含 /path）或纯文本断言
            path = _extract_path(name)
            qt = _quoted_expect(expect) or _quoted_expect(name)
            if path:
                action = 'goto_path'
            elif qt and re.search(r'验证|检查|确认|应该|应当|显示|出现', text):
                action = 'check_text'
            else:
                return {'action': 'fallback', 'ok': False,
                        'note': '未匹配任何动作原语（支持：搜索/打开商品/加购/购物车验证/收藏/登录/首页/跳转/文本断言）',
                        'body_ts': '', 'kw': '', 'path': '', 'text': ''}

        kw = _extract_kw(name, expect, settings)
        path = _extract_path(name)
        qt = _quoted_expect(expect)

    if action == 'favorite':
        # favorite-check 手工用例尚未适配新站（skill 备忘），自动生成同样降级，避免假绿
        return {'action': 'fallback', 'ok': False,
                'note': '收藏动作库未适配新版前台（收藏图标按钮无文本，需 DOM diff 探针），降级占位',
                'body_ts': '', 'kw': '', 'path': '', 'text': ''}

    if action == 'search':
        body = TS_SEARCH.replace('__KW__', _ts_str(kw))
    elif action == 'login':
        body = TS_LOGIN
    elif action == 'register':
        body = TS_REGISTER
    elif action == 'open_home':
        body = TS_OPEN_HOME
    elif action == 'open_first_product':
        body = TS_OPEN_FIRST.replace('__BT_VAR__', 'btDetail')
    elif action == 'add_cart':
        body = TS_ADD_CART
    elif action == 'check_cart':
        body = TS_CHECK_CART
    elif action == 'goto_path':
        if not path:
            return {'action': 'fallback', 'ok': False, 'note': '跳转动作未提取到 / 开头的路径',
                    'body_ts': '', 'kw': '', 'path': '', 'text': ''}
        body = TS_GOTO.replace('__PATH__', _ts_str(path))
    elif action == 'fill_form':
        # fields 参数缺省 → 按字段同义词/顺序自动填充；path 可先导航到表单页（自包含）
        body = (TS_NAV_PREFIX.replace('__PATH__', _ts_str(path)) + '\n      '
                + TS_FILL_FORM.replace('__FIELDS__', _ts_str(fld)))
    elif action == 'click_text':
        if not qt:
            return {'action': 'fallback', 'ok': False, 'note': '按文本点击未提取到按钮文本（text 参数）',
                    'body_ts': '', 'kw': '', 'path': '', 'text': ''}
        body = (TS_NAV_PREFIX.replace('__PATH__', _ts_str(path)) + '\n      '
                + TS_CLICK_TEXT.replace('__TEXT__', _ts_str(qt)))
    elif action == 'expect_submit_ok':
        body = TS_EXPECT_SUBMIT  # 不导航：断言的是上一步点击留下的提交证据
    elif action == 'hover_text':
        if not qt:
            return {'action': 'fallback', 'ok': False, 'note': '悬停动作未提取到菜单文本（text 参数）',
                    'body_ts': '', 'kw': '', 'path': '', 'text': ''}
        body = (TS_NAV_PREFIX.replace('__PATH__', _ts_str(path)) + '\n      '
                + TS_HOVER_TEXT.replace('__TEXT__', _ts_str(qt)))
    elif action == 'expect_url':
        sub = str(_params.get('substr') or _params.get('text') or '').strip()[:80]
        if action == 'expect_url' and not preset:
            sub = qt  # 正则路径：引号内文本兜底
        if not sub:
            return {'action': 'fallback', 'ok': False, 'note': 'URL 断言未提取到片段（substr 参数）',
                    'body_ts': '', 'kw': '', 'path': '', 'text': ''}
        body = TS_EXPECT_URL.replace('__SUBSTR__', _ts_str(sub))
    elif action == 'scroll_to_text':
        if not qt:
            return {'action': 'fallback', 'ok': False, 'note': '滚动定位未提取到目标文本（text 参数）',
                    'body_ts': '', 'kw': '', 'path': '', 'text': ''}
        body = TS_SCROLL_TO.replace('__TEXT__', _ts_str(qt))
    elif action == 'check_text':
        if not qt:
            return {'action': 'fallback', 'ok': False, 'note': '文本断言未提取到引号内文本',
                    'body_ts': '', 'kw': '', 'path': '', 'text': ''}
        body = TS_CHECK_TEXT.replace('__TEXT__', _ts_str(qt))
    else:
        return {'action': 'fallback', 'ok': False, 'note': f'动作 {action} 未实现', 'body_ts': '', 'kw': '', 'path': '', 'text': ''}

    note = {'search': f'搜索{"「" + kw + "」" if kw else "（随机测试关键词）"}并进入结果页',
            'open_first_product': '点击搜索结果第一个商品进入详情页',
            'add_cart': '点击加购按钮并做接口+徽标双证据校验',
            'check_cart': '跳转购物车页并断言含刚加购商品',
            'goto_path': f'跳转 {path}',
            'check_text': f'断言页面文本「{qt}」',
            'fill_form': f'填写表单（{fld or "自动填可见输入框"}）',
            'click_text': f'点击「{qt}」',
            'expect_submit_ok': '断言提交成功（2xx 接口证据 / 成功文案兜底）',
            'hover_text': f'悬停「{qt}」展开下拉',
            'expect_url': '断言 URL 片段',
            'scroll_to_text': f'滚动定位到「{qt}」',
            'login': '登录前台',
            'register': '注册新账号并登录（技能包 temp-mail-verification-code：站点要求邮箱验证码时自动用临时邮箱收码）',
            'open_home': '打开首页'}.get(action, action)
    return {'action': action, 'ok': True, 'note': note, 'body_ts': body, 'kw': kw, 'path': path, 'text': qt}


def expand_prereq(action: str, requires_auth: bool, before_login: bool = False) -> list:
    """展开前置动作链（有序去重）。返回 ['login','search', ...] 子序列（不含动作自身）。
    配方原语（不在 PREREQ 内）默认前置 __auth__——目标页通常需要登录态。
    before_login=True（2026-11-04 ian）：该步骤位于用例首个显式登录步骤之前——用例作者
    （AI/人工）编排的意图就是未登录执行（如「未登录先搜索→被拦截→注册→登录→再搜索」），
    此时不再自动补登录前置，尊重未登录语义；登录之后的步骤照旧自包含补登录。"""
    skip_auth = {'login', 'wap_login'} if before_login else set()
    out: list = []

    def push(a):
        if a == '__auth__':
            if requires_auth and not before_login and 'login' not in out:
                out.append('login')
            return
        if a in skip_auth:
            return
        for p in PREREQ.get(a, []):
            push(p)
        if a not in out and a != action:
            out.append(a)

    default_pre = ['__auth__'] if action in _ar.recipe_paths() else []
    for pre in PREREQ.get(action, default_pre):
        push(pre)
    return out


# 前置动作 → TS 代码（与动作体不同：前置不重复断言，只铺路）
PREREQ_TS = {
    'login': TS_LOGIN,
    'search': TS_SEARCH,       # 产出 picked 变量（详情/加购/购物车步骤依赖）
    'open_home': TS_OPEN_HOME,
    'open_first_product': TS_OPEN_FIRST.replace('__BT_VAR__', 'btPre'),
    'add_cart': TS_ADD_CART,
    'check_cart': TS_CHECK_CART,
    'wap_login': TS_WAP_LOGIN,
}


def step_body(step: dict, parsed: dict, requires_auth: bool, bt_var_seq: int, kw_default: str = '', before_login: bool = False,
              replay_ts: str = '') -> str:
    """渲染单步 test 的 try 块完整 TS 代码：前置链 + 动作体。
    kw_default：用例级关键词（S1 提取），后续步骤前置搜索共享同一关键词保持用例一致性。
    before_login：位于用例显式登录步骤之前 → 前置链不自动补登录（未登录语义）。
    replay_ts（2026-11-04 ian）：前序通用步骤重放链——探索器全程共用一个 page 连续走，
    但 Playwright spec 每步独立 test/独立空白 page；通用原语（click_text/fill_form/
    expect_submit_ok/check_text 且无直达 path）必须先重放 open_home→click_text→fill_form
    等前序动作把页面铺到本步骤的起点状态，否则会在 about:blank 上找元素（0 候选）。"""
    if not parsed.get('ok'):
        return ''
    kw = parsed.get('kw') or kw_default or ''
    parts = []
    for pre in expand_prereq(parsed['action'], requires_auth, before_login):
        ts = PREREQ_TS.get(pre)
        if ts:
            ts = ts.replace('__KW__', _ts_str(kw))
            parts.append(ts)
    if replay_ts:
        parts.append(replay_ts)
    body = parsed['body_ts'].replace('__KW__', _ts_str(kw))
    parts.append(body)
    # picked.title 内插：TS 模板串
    joined = '\n      '.join(parts)
    joined = joined.replace('__PICKED_TITLE__', '${picked.title}')
    # 前置与动作同为 open_first_product 变量冲突处理：btDetail/btPre 已区分
    return joined
