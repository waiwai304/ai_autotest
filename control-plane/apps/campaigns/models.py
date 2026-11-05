from django.conf import settings
from django.db import models

class Campaign(models.Model):
    class Status(models.TextChoices):
        CREATED = 'created', '已创建'
        QUEUED = 'queued', '排队中'
        RUNNING = 'running', '运行中'
        COMPLETED = 'completed', '已完成'
        CANCELLED = 'cancelled', '已取消'

    name = models.CharField(max_length=200)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.CREATED)
    plan = models.JSONField(default=dict)
    total_jobs = models.PositiveIntegerField(default=0)
    finished_jobs = models.PositiveIntegerField(default=0)
    passed_jobs = models.PositiveIntegerField(default=0)
    failed_jobs = models.PositiveIntegerField(default=0)
    report_built = models.BooleanField(default=False)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['-created_at']

class TestJob(models.Model):
    class Status(models.TextChoices):
        CREATED = 'created', '已创建'
        QUEUED = 'queued', '排队中'
        RUNNING = 'running', '运行中'
        CANCEL_REQUESTED = 'cancel_requested', '取消中'
        PASSED = 'passed', '通过'
        FAILED = 'failed', '失败'
        LOST = 'lost', '失联'
        CANCELLED = 'cancelled', '已取消'

    campaign = models.ForeignKey(Campaign, on_delete=models.PROTECT, related_name='jobs')
    seq = models.PositiveIntegerField(default=0)
    idempotency_key = models.CharField(max_length=128, unique=True)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.CREATED)
    site_code = models.CharField(max_length=100, default='')
    scenario_code = models.CharField(max_length=100, default='')
    device = models.CharField(max_length=50, default='desktop-chrome')
    locale = models.CharField(max_length=20, default='en')
    run_manifest = models.JSONField(default=dict)
    result_summary = models.JSONField(default=dict)
    runner_log = models.TextField(blank=True)
    progress = models.JSONField(default=dict, blank=True,
                                help_text='执行进度：{done,total,current,eta_sec,steps:[{id,status,ms,at}]}')
    attempt_count = models.PositiveSmallIntegerField(default=0)
    heartbeat_at = models.DateTimeField(null=True, blank=True)
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)
    celery_task_id = models.CharField(max_length=64, blank=True)

    class Meta:
        ordering = ['campaign', 'seq']


class AssetLibrary(models.Model):
    """测试用例库（ian 2026-10-08：搜索关键词/图片/链接素材池）。
    发起 Campaign 时可勾选指定条目（plan.library.<kind>=[ids]），
    未勾选则 runner 从启用条目中随机抽取（注入 env LIB_KEYWORDS/LIB_IMAGES/LIB_LINKS）。"""
    class Kind(models.TextChoices):
        KEYWORD = 'keyword', '搜索关键词'
        IMAGE = 'image', '搜索图片'
        LINK = 'link', '搜索链接'

    kind = models.CharField(max_length=20, choices=Kind.choices)
    value = models.TextField(help_text='关键词文本 / 图片 URL / 商品链接（每条目一个值）')
    note = models.CharField(max_length=200, blank=True, default='', help_text='备注（来源/用途）')
    site = models.ForeignKey('sites.Site', null=True, blank=True, on_delete=models.SET_NULL,
                             related_name='library_items', help_text='可选绑定站点；空=全站通用')
    enabled = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['kind', '-created_at']
        verbose_name_plural = '测试用例库'


class NotifyChannel(models.Model):
    """完成通知渠道（2026-10-21 ian：默认 webhook、每个测试任务出结果即推送——任务 ID+结果+HTML 报告）。
    通用 POST webhook：自定义 headers（JSON）+ body 模板（{{CONTENT_JSON}}=JSON 安全替换 /
    {{content}}=裸文本替换）；events 控制触发粒度：
    job_all=每个 Job 出结果即推（默认）/ job_failed=仅失败 Job 即推 / campaign=仅 Campaign 汇总。"""
    class Events(models.TextChoices):
        JOB_ALL = 'job_all', '每任务出结果即推'
        JOB_FAILED = 'job_failed', '仅失败任务即推'
        CAMPAIGN = 'campaign', '仅 Campaign 汇总'

    name = models.CharField(max_length=100, help_text='渠道名称（如：飞书/xiaofan）')
    url = models.URLField(help_text='Webhook 地址（POST）')
    headers_json = models.TextField(
        blank=True, default='{"Content-Type": "application/json"}',
        help_text='请求头 JSON（如 {"X-Webhook-Token": "..."}）')
    body_template = models.TextField(
        blank=True, default='{"content": {{CONTENT_JSON}}}',
        help_text='请求体模板：{{CONTENT_JSON}}=内容按 JSON 字符串安全替换（推荐）；{{content}}=裸文本替换')
    events = models.CharField(max_length=12, choices=Events.choices, default=Events.JOB_ALL)
    enabled = models.BooleanField(default=True)
    last_status = models.CharField(max_length=200, blank=True, default='')
    last_sent_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-enabled', 'id']
        verbose_name_plural = '通知渠道'

    def __str__(self):
        return f'{self.name}({self.url})'


class NotifySetting(models.Model):
    """通知全局设置（2026-11-02 ian：推送本站域名）。
    推送消息里「HTML 报告 / 任务详情」链接前缀：优先取本配置，留空回退 PLATFORM_BASE_URL 环境变量。
    背景：平台部署在本机，127.0.0.1:3008 其他人无法访问，需在页面填实际可访问地址。"""
    base_url = models.CharField(
        max_length=300, blank=True, default='',
        help_text='推送本站域名（如 https://autotest.example.com 或 http://192.168.1.10:3008）；留空回退 PLATFORM_BASE_URL 环境变量')
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name_plural = '通知全局设置'

    def __str__(self):
        return f'base_url={self.base_url or "(回退 env)"}'

    @classmethod
    def get_base_url(cls) -> str:
        """推送链接前缀：DB 配置优先，空则回退 settings.PLATFORM_BASE_URL"""
        from django.conf import settings
        obj = cls.objects.first()
        u = (obj.base_url or '').strip().rstrip('/') if obj else ''
        return u or settings.PLATFORM_BASE_URL


class TradeRecord(models.Model):
    """测试数据台账（2026-10-21 ian：真实交易单据留痕——订单/快递/包裹单号 + 归属账号，
    台账页可按单号秒查归属；配套 2026-10-19 测试数据安全铁律，误操作时快速定位波及范围）。
    数据源：full-chain / wap-fullchain result json 顶层 tradeLedger（spec 侧 fcCtx/state 生成）。"""
    class Kind(models.TextChoices):
        ORDER = 'order', '订单'
        EXPRESS = 'express', '快递单'
        PACKAGE = 'package', '包裹'

    job = models.ForeignKey('TestJob', on_delete=models.CASCADE, related_name='trade_records')
    campaign = models.ForeignKey('Campaign', on_delete=models.CASCADE, related_name='trade_records')
    site_code = models.CharField(max_length=100, default='', db_index=True)
    scenario_code = models.CharField(max_length=100, default='')
    device = models.CharField(max_length=50, default='')
    kind = models.CharField(max_length=20, choices=Kind.choices)
    sn = models.CharField(max_length=64, db_index=True, help_text='单号（订单/快递/包裹）')
    account = models.CharField(max_length=200, blank=True, default='', help_text='归属前台测试账号')
    amount = models.CharField(max_length=50, blank=True, default='', help_text='实付金额原文（含币种符号）')
    note = models.CharField(max_length=200, blank=True, default='')
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ['-created_at']
        constraints = [models.UniqueConstraint(fields=['job', 'sn'], name='uniq_trade_job_sn')]
        verbose_name_plural = '测试数据台账'

    def __str__(self):
        return f'{self.get_kind_display()} {self.sn}'
