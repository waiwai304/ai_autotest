import hashlib, json
from django.conf import settings
from django.db import models
from django.db.models.signals import post_save
from django.dispatch import receiver
from django.utils import timezone

class Scenario(models.Model):
    name = models.CharField(max_length=200)
    code = models.SlugField(unique=True)
    description = models.TextField(blank=True)
    enabled = models.BooleanField(default=True)
    weight = models.PositiveSmallIntegerField(default=0)  # 2026-11-04 ian：展示权重，0=未设置（按创建时间倒序）
    created_at = models.DateTimeField(auto_now_add=True)
    # 2026-11-04 ian：最近更新时间（发布新版本/改名/权重/启停时刷新），用于流程库"更新时间"排序筛选
    updated_at = models.DateTimeField(null=True, blank=True)

    def __str__(self):
        return f'{self.code}'

class ScenarioVersion(models.Model):
    class Status(models.TextChoices):
        DRAFT = 'draft', '草稿'
        REVIEW = 'review', '审核中'
        PUBLISHED = 'published', '已发布'
        RETIRED = 'retired', '已停用'

    scenario = models.ForeignKey(Scenario, on_delete=models.PROTECT, related_name='versions')
    version = models.PositiveIntegerField()
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.DRAFT)
    definition = models.JSONField()
    sha256 = models.CharField(max_length=64)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['scenario', 'version'], name='unique_scenario_version')]

    def save(self, *args, **kwargs):
        if not self.sha256:
            raw = json.dumps(self.definition, sort_keys=True, ensure_ascii=False)
            self.sha256 = hashlib.sha256(raw.encode()).hexdigest()
        super().save(*args, **kwargs)

    @property
    def runner_spec(self):
        return self.definition.get('runner_spec', '')

    @property
    def actions(self):
        return self.definition.get('actions', [])

    # ---- 双端（PC/WAP）与用例自定义设置（2026-09-23 平台化） ----
    def supported_ends(self):
        """本版本支持的测试端：definition.ends 有映射用映射，否则视为仅 PC"""
        ends = self.definition.get('ends') or {}
        if ends:
            return [e for e in ('pc', 'wap') if e in ends]
        return ['pc']

    def end_spec(self, end: str) -> str:
        """指定端的执行入口：tests/ 开头 = playwright spec，scripts/ 开头 = tsx 脚本"""
        ends = self.definition.get('ends') or {}
        return ends.get(end) or self.runner_spec

    @property
    def settings_schema(self):
        """用例自定义设置字段定义：[{key,label,type,default,help}]"""
        return self.definition.get('settings', []) or []

    def merged_settings(self, override: dict | None = None) -> dict:
        """默认值 + 页面覆盖值 合并成最终 vars"""
        out = {}
        for f in self.settings_schema:
            out[f['key']] = (override or {}).get(f['key'], f.get('default'))
        for k, v in (override or {}).items():
            out.setdefault(k, v)
        return out


class AiConfig(models.Model):
    """Agent 接入配置（2026-10-30 ian：AI 口语建用例）。
    OpenAI 兼容协议（DeepSeek 同款）：自定义 base_url + api_key + model。
    单条记录（get_solo），管理页 /scenarios/ai-config/ 可编辑；api_key 不回显（留空=保留）。"""
    base_url = models.CharField(max_length=300, default='https://api.deepseek.com/v1',
                                help_text='OpenAI 兼容接口地址，如 https://api.deepseek.com/v1')
    api_key = models.CharField(max_length=200, blank=True, default='')
    model = models.CharField(max_length=120, blank=True, default='deepseek-chat',
                             help_text='模型名须与服务端完全一致（部分网关要求全小写）')
    enabled = models.BooleanField(default=False)
    temperature = models.FloatField(default=0.2)
    timeout_sec = models.PositiveIntegerField(default=120)
    max_tokens = models.PositiveIntegerField(default=6000,
                                            help_text='reasoning 模型思考也计入，规划类建议 ≥4000')
    last_test_ok = models.BooleanField(null=True, blank=True, default=None)
    last_test_at = models.DateTimeField(null=True, blank=True)
    last_test_msg = models.CharField(max_length=300, blank=True, default='')
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = 'Agent 接入配置'

    def __str__(self):
        return f'AiConfig({self.model or "?"} @ {self.base_url})'

    @classmethod
    def get_solo(cls) -> 'AiConfig':
        obj = cls.objects.first()
        return obj if obj is not None else cls.objects.create()

    @property
    def ready(self) -> bool:
        return bool(self.enabled and self.base_url.strip() and self.api_key.strip() and self.model.strip())


class ExploreRun(models.Model):
    """AI 计划探索验证运行（2026-11 二期）：把 AI 规划的步骤在真实站点按序实走，逐步取证。
    执行通道：scenarios.tasks.run_ai_explore → browser 队列 → web-blackbox npx tsx tests/ai_explore.ts。
    截图复制到 html-report/EXPLORE-<pk>/screenshots/（复用 /reports/view/ 鉴权浏览通道）。"""
    class Status(models.TextChoices):
        CREATED = 'created', '待执行'
        RUNNING = 'running', '探索中'
        DONE = 'done', '已完成'
        ERROR = 'error', '执行失败'

    site = models.ForeignKey('sites.Site', on_delete=models.CASCADE, related_name='explore_runs')
    code = models.CharField(max_length=60, blank=True, default='', help_text='关联用例标识（预览阶段可空）')
    plan = models.JSONField(help_text='探索的计划：steps(doc_steps 同构) + name/description/case_text')
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.CREATED)
    result = models.JSONField(null=True, blank=True, help_text='ai_explore.ts 产出的 result.json 内容')
    error = models.CharField(max_length=500, blank=True, default='')
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)
    finished_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['-id']
        verbose_name = 'AI 探索验证'

    def __str__(self):
        return f'EXPLORE-{self.pk:06d}({self.status})'

    @property
    def report_dir(self) -> str:
        """截图所在 html-report 目录名（供 /reports/view/ 鉴权访问）"""
        return f'EXPLORE-{self.pk:06d}'

    @property
    def ok_count(self) -> int:
        return sum(1 for s in ((self.result or {}).get('steps') or []) if s.get('ok'))

    @property
    def total_steps(self) -> int:
        return len((self.result or {}).get('steps') or [])


class ActionRecipe(models.Model):
    """动作配方沉淀（2026-11 二期）：探索器对 unknown 意图启发式点击的候选证据，人工审核后
    并入 action_registry + docflow.ts 实现（三期原语库扩容的原料）。"""
    class Status(models.TextChoices):
        CANDIDATE = 'candidate', '候选'
        APPROVED = 'approved', '已核准'
        REJECTED = 'rejected', '已弃用'

    action_name = models.CharField(max_length=60, help_text='建议原语名（小写下划线），人工命名')
    intent = models.CharField(max_length=200, help_text='口语意图（来自步骤 name/expect）')
    evidence = models.JSONField(default=dict, help_text='探索证据：clicked_text/url_before/url_after/toast/截图')
    explore = models.ForeignKey(ExploreRun, on_delete=models.SET_NULL, null=True, blank=True, related_name='recipes')
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.CANDIDATE)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-id']
        verbose_name = '动作配方'

    def __str__(self):
        return f'{self.action_name}({self.status})'


# ---- 流程库"更新时间"维护（2026-11-04 ian）----
# 任一新版本落库（页面创建/AI 创建/重规划/再生成）即视为流程有更新
@receiver(post_save, sender=ScenarioVersion)
def _touch_scenario_on_version(sender, instance, **kwargs):
    Scenario.objects.filter(pk=instance.scenario_id).update(updated_at=timezone.now())
