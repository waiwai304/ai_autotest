# -*- coding: utf-8 -*-
"""动作原语注册表（2026-10-30 ian：AI 口语建用例一期）。

这是 AI 规划器的「词汇表」：模型只能从本注册表选动作 + 填参数。
每条与 web-blackbox/tests/helpers/docflow.ts 的实现一一对应——
执行层只跑已实测验证的原语，这是口语建用例完成率的根本保障。

status:
  ready       = 已实现可真实执行（PC 端）
  placeholder = 未实现，显式降级占位（test.skip 待实现，绝不假绿）

前置链（prereq）与 doc_actions.PREREQ 保持一致：生成 spec 时自动展开，
prompt 里告知模型「无需输出前置步骤」，避免冗余登录/搜索步骤。

扩容路径（二期）：探索验证器实走网站成功的新动作 → 在此登记 → 规划词汇自动变宽。
"""

# 参数 schema：key → (说明, 是否必填)。参数名与 doc_actions.parse_step 消费侧对齐：
#   keyword → search 的搜索词；path → goto_path 的页面路径；text → check_text 的断言文本
REGISTRY = [
    {
        'action': 'register',
        'label': '注册新账号并自动登录（随机邮箱）',
        'params': {},
        'examples': ['注册新账号', '注册并登录', '新用户注册', '先注册一个账号'],
        'prereq': [],
        'status': 'ready',
        'note': '随机邮箱真实注册并自动登录；本用例后续登录自动改用新注册账号（不用站点测试账号）',
    },
    {
        'action': 'login',
        'label': '登录前台（测试账号）',
        'params': {},
        'examples': ['登录测试账号', '先登录网站'],
        'prereq': [],
        'status': 'ready',
        'note': '用站点档案配置的测试账号登录，登录后自动校验实际身份',
    },
    {
        'action': 'open_home',
        'label': '打开首页',
        'params': {},
        'examples': ['打开首页', '访问网站首页', '首页正常打开'],
        'prereq': [],
        'status': 'ready',
        'note': '打开 PC 首页并校验关键元素渲染（含弹窗广告自动关闭守卫）',
    },
    {
        'action': 'search',
        'label': '搜索商品并进入结果页',
        'params': {'keyword': ('搜索关键词，留空=自动随机测试关键词', False)},
        'examples': ['搜索蓝牙耳机', '搜索「手机壳」', '输入连衣裙并搜索'],
        'prereq': ['login'],
        'status': 'ready',
        'note': '关键词来自步骤参数；结果页会校验出现商品链接',
    },
    {
        'action': 'open_first_product',
        'label': '打开搜索结果中的商品进详情页',
        'params': {},
        'examples': ['进第一个商品', '点击商品进详情页', '打开任一商品'],
        'prereq': ['search'],
        'status': 'ready',
        'note': '依赖上一步搜索（前置自动补）；详情页就绪以价格区+立即购买按钮双标志判定',
    },
    {
        'action': 'add_cart',
        'label': '加入购物车',
        'params': {},
        'examples': ['加入购物车', '加购', '把商品加入购物车'],
        'prereq': ['open_first_product'],
        'status': 'ready',
        'note': '真实写操作：接口 code=1 + 购物车徽标 +1 双证据校验',
    },
    {
        'action': 'check_cart',
        'label': '打开购物车页并验证刚加购商品',
        'params': {},
        'examples': ['去购物车验证', '打开购物车页面检查商品'],
        'prereq': ['add_cart'],
        'status': 'ready',
        'note': '断言购物车页含刚加购商品的标题关键字',
    },
    {
        'action': 'goto_path',
        'label': '直达指定页面路径',
        'params': {'path': ('页面路径，/ 开头，如 /zh-cn/my/address', True)},
        'examples': ['打开 /zh-cn/my/address', '进入个人中心 /zh-cn/my'],
        'prereq': ['login'],
        'status': 'ready',
        'note': '适合口语里给出明确路径的跳转；路径会先过站点档案校验',
    },
    {
        'action': 'check_text',
        'label': '断言页面出现指定文本',
        'params': {'text': ('期望出现的文本（≤40字）', True)},
        'examples': ['验证页面显示「收藏成功」', '检查出现 Payment Successful'],
        'prereq': [],
        'status': 'ready',
        'note': '对当前页面做文本包含断言，常作为收尾验证步骤',
    },
    # ---- 通用表单/点击原语（2026-11-04 ian：官网留言表单链路 S3/S4 卡 unknown 的根因修复）----
    {
        'action': 'fill_form',
        'label': '填写表单（按字段定位填值）',
        'params': {'fields': ('字段与值，格式「定位=值」多组用 ; 分隔（定位可为 label 文本 / placeholder / name / CSS 选择器）；留空=按顺序自动填可见输入框',
                              False),
                   'path': ('可选：先导航到的页面路径（/ 开头），如 /contact；不填=在当前页填', False)},
        'examples': ['在留言区块填写测试信息', '填写联系人姓名和留言内容', '把表单填好'],
        'prereq': [],
        'status': 'ready',
        'note': 'PC 端通用表单填写：逐项定位输入框/文本域并回读校验；适合留言板、联系我们、反馈、报名等表单',
    },
    {
        'action': 'click_text',
        'label': '按文本点击按钮/链接',
        'params': {'text': ('要点击的元素文本，如 提交 / 发送留言 / 立即发送', True),
                   'path': ('可选：先导航到的页面路径（/ 开头），如 /contact', False)},
        'examples': ['点击提交', '点击发送留言按钮', '点一下确认'],
        'prereq': [],
        'status': 'ready',
        'note': '按可见文本点击 button/a/[role=button]/input[type=submit]，精确→包含→表单内提交兜底三级匹配',
    },
    {
        'action': 'expect_submit_ok',
        'label': '断言提交成功（接口证据优先）',
        'params': {},
        'examples': ['确认提交成功', '验证留言已发送', '检查表单提交结果'],
        'prereq': [],
        'status': 'ready',
        'note': '取上一步点击触发的提交请求：2xx=成功（含表单已清空证据）；无接口证据时兜底识别「提交成功/感谢/已收到」等文案。适合无提示文案的静默提交站点',
    },
    {
        'action': 'hover_text',
        'label': '悬停展开下拉菜单（不点击）',
        'params': {'text': ('要悬停的菜单项文本，如「产品与服务」', True)},
        'examples': ['悬停顶部菜单「产品与服务」展开下拉', '鼠标移到导航「解决方案」上'],
        'prereq': [],
        'status': 'ready',
        'note': '官网常见 hover 下拉导航：悬停后下拉里的子项才出现在 DOM，后续 click_text 即可点子项（2026-11-04 二期）',
    },
    {
        'action': 'expect_url',
        'label': '断言当前 URL 包含指定片段',
        'params': {'substr': ('URL 应包含的片段，多候选用 | 分隔，如 contact|lianxi', True)},
        'examples': ['验证跳转到了联系我们页面', '确认 URL 进入 /contact'],
        'prereq': [],
        'status': 'ready',
        'note': '比文本断言更稳的跳转校验：点击导航后断言 URL 含 contact 等（2026-11-04 二期）',
    },
    {
        'action': 'scroll_to_text',
        'label': '滚动页面直到目标文本可见（触发懒加载）',
        'params': {'text': ('要滚动定位到的文本', True)},
        'examples': ['滚动到页面底部', '滚动找到「合作案例」区块'],
        'prereq': [],
        'status': 'ready',
        'note': '长滚动官网/懒加载列表专用：逐屏滚动最多 10 屏直至文本可见（2026-11-04 二期）',
    },
    {
        'action': 'favorite',
        'label': '收藏/取消收藏商品',
        'params': {},
        'examples': ['收藏这个商品', '取消收藏'],
        'prereq': ['open_first_product'],
        'status': 'placeholder',
        'note': '收藏按钮为新版前台的纯图标按钮（无文本），动作库待 DOM diff 探针适配；'
                '选择将生成「待实现」占位步骤，不假绿',
    },
    # ---- WAP 端原语（三期 2026-11 ian：交互抽取自 wap-shopping-flow.spec.ts 实测代码）----
    {
        'action': 'wap_login',
        'label': 'WAP 端登录前台（测试账号）',
        'params': {},
        'examples': ['在手机端登录', 'WAP 端登录测试账号'],
        'prereq': [],
        'status': 'ready',
        'note': '打开 WAP 登录页填写账密登录（实测交互；支持站点独立探索账号）',
    },
    {
        'action': 'wap_open_home',
        'label': '打开 WAP 首页',
        'params': {},
        'examples': ['手机端打开首页', 'WAP 首页正常打开'],
        'prereq': [],
        'status': 'ready',
        'note': '打开 WAP 首页并校验渲染（防 SPA 空壳假绿；含弹窗守卫）',
    },
    {
        'action': 'wap_goto_path',
        'label': 'WAP 端直达指定页面路径',
        'params': {'path': ('WAP 页面路径，/ 开头，如 /pages/user/index（档案 key 亦可：cart/userCenter）', True)},
        'examples': ['手机端打开 /pages/user/index', 'WAP 进入购物车页 cart'],
        'prereq': ['wap_login'],
        'status': 'ready',
        'note': '按 WAP hash 路由直达页面；常用 key：cart=购物车 userCenter=个人中心 profile=资料',
    },
    {
        'action': 'wap_check_text',
        'label': 'WAP 端断言页面出现指定文本',
        'params': {'text': ('期望出现的文本（≤40字）', True)},
        'examples': ['手机端验证页面显示「Total」', 'WAP 检查出现 Sign in'],
        'prereq': [],
        'status': 'ready',
        'note': '对当前 WAP 页面做文本包含断言',
    },
    {
        'action': 'wap_search',
        'label': 'WAP 端搜索商品（暂未适配）',
        'params': {'keyword': ('搜索关键词', False)},
        'examples': ['手机端搜索蓝牙耳机'],
        'prereq': ['wap_login'],
        'status': 'placeholder',
        'note': 'WAP 搜索框/结果列表交互尚未实测探针，动作库待适配；'
                '选择将生成「待实现」占位步骤，不假绿',
    },
    {
        'action': 'wap_open_first_product',
        'label': 'WAP 端打开商品详情（暂未适配）',
        'params': {},
        'examples': ['手机端进第一个商品'],
        'prereq': ['wap_search'],
        'status': 'placeholder',
        'note': 'WAP 详情/SKU 弹层交互未封装为通用原语（需指定商品），待适配；占位不假绿',
    },
    {
        'action': 'wap_add_cart',
        'label': 'WAP 端加入购物车（暂未适配）',
        'params': {},
        'examples': ['手机端加购'],
        'prereq': ['wap_open_first_product'],
        'status': 'placeholder',
        'note': 'WAP SKU 弹层加购已实测（wap-shopping-flow）但强依赖指定商品与 getItem 捕获，通用化待适配',
    },
    {
        'action': 'wap_check_cart',
        'label': 'WAP 端打开购物车页（暂未适配）',
        'params': {},
        'examples': ['手机端去购物车验证'],
        'prereq': ['wap_add_cart'],
        'status': 'placeholder',
        'note': '购物车全选/Total 断言已实测但通用化待适配；占位不假绿',
    },
]

BY_ACTION = {r['action']: r for r in REGISTRY}

# AI 规划输出允许的动作白名单 = 注册表全部 action + unknown（显式未识别）
ALLOWED_ACTIONS = set(BY_ACTION.keys()) | {'unknown'}

# 生成 spec 时真实执行的动作（= doc_actions.parse_step 已实现部分，favorite/unknown 降级占位）
EXECUTABLE_ACTIONS = {r['action'] for r in REGISTRY if r['status'] == 'ready'}

MUTATING_ACTIONS = {'add_cart'}  # 真实数据写操作 → definition.mutating=True


def param_spec(action: str) -> dict:
    """动作的参数 schema：{key: (说明, 必填)}；unknown/配方 动作动态查（配方无参数）"""
    r = by_action_all().get(action)
    return dict(r['params']) if r else {}


def normalize_params(action: str, params: dict) -> dict:
    """按注册表 schema 清洗参数：只保留声明的 key，字符串截断（防注入长文本）"""
    spec = param_spec(action)
    out = {}
    for key, (_desc, required) in spec.items():
        val = str((params or {}).get(key) or '').strip()
        if val:
            out[key] = val[:80]
    return out


def render_for_prompt() -> str:
    """渲染进规划 system prompt 的原语清单（紧凑表格；含 approved 配方动态并入）"""
    lines = []
    for r in all_registry():
        ps = '；'.join(f'{k}（{"必填" if req else "可选"}：{d}）' for k, (d, req) in r['params'].items()) or '无参数'
        flag = '' if r['status'] == 'ready' else '【暂不可自动执行→标 unknown】'
        lines.append(f"- {r['action']}：{r['label']}。参数：{ps}。{r['note']}{flag}")
    return '\n'.join(lines)


# ============ 三期（2026-11 ian）：approved 配方动态并入注册表 ============
# 配方执行语义 = 登录后直达核准时固化的目标路径（goto_path 等价），无需改 docflow.ts。
# 探索 heuristicClick 的 url_after 即「该意图在真实站点上的可达终点」，核准即视为语义确认。

def recipe_items() -> list:
    """approved 配方 → registry dict 列表。DB 不可用/迁移未跑时返回空（不阻断静态注册表）。"""
    try:
        from .models import ActionRecipe
        qs = ActionRecipe.objects.filter(status=ActionRecipe.Status.APPROVED)
    except Exception:
        return []
    items = []
    for rec in qs:
        path = str((rec.evidence or {}).get('path') or '').strip()
        if not path.startswith('/'):
            continue
        items.append({
            'action': rec.action_name,
            'label': f'配方·{(rec.intent or rec.action_name)[:36]}',
            'params': {},
            'examples': [(rec.intent or rec.action_name)[:60]],
            'prereq': ['login'],
            'status': 'ready',
            'note': f'探索沉淀+人工核准配方：登录后直达 {path}（goto_path 等价执行）',
            'path': path,
            'is_recipe': True,
        })
    return items


def all_registry() -> list:
    """静态注册表 + approved 配方（动态）。"""
    return list(REGISTRY) + recipe_items()


def by_action_all() -> dict:
    """action → 定义（静态优先，配方 setdefault 不覆盖静态原语）。"""
    out = dict(BY_ACTION)
    for it in recipe_items():
        out.setdefault(it['action'], it)
    return out


def allowed_actions_all() -> set:
    """AI 规划输出允许的动作全集 = 静态 + 配方 + unknown。"""
    return set(by_action_all().keys()) | {'unknown'}


def executable_actions_all() -> set:
    """可真实执行动作全集（生成 spec 不降级占位）。"""
    return {r['action'] for r in all_registry() if r['status'] == 'ready'}


def recipe_paths() -> dict:
    """action_name → 固化目标路径（doc_actions 按 goto_path 等价生成真实代码）。"""
    return {it['action']: it['path'] for it in recipe_items()}
