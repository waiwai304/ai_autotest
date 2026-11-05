import hashlib, json
from django.conf import settings
from django.db import models

class Site(models.Model):
    name = models.CharField(max_length=200)
    code = models.SlugField(unique=True)
    base_url = models.URLField()
    adapter_key = models.CharField(max_length=100, default='shop')
    enabled = models.BooleanField(default=True)
    # 2026-11-04 ian：展示权重，0=未设置（执行中心网站列表按权重降序，同权重按创建时间旧→新/代码）
    weight = models.PositiveSmallIntegerField(default=0, help_text='权重越大，执行中心里越靠前；0=未设置')
    max_concurrency = models.PositiveSmallIntegerField(default=2)
    requests_per_minute = models.PositiveIntegerField(default=30)
    allowed_host = models.CharField(max_length=255)
    locales = models.JSONField(default=list)
    devices = models.JSONField(default=list)
    currency = models.CharField(max_length=10, default='USD')
    # 多端域名（2026-09-24 ian：站点管理可自定义；同结构站点复用 profile 站点档案的路径表）
    pc_base_url = models.URLField(blank=True, default='', help_text='PC 前台域名')
    wap_base_url = models.URLField(blank=True, default='', help_text='WAP 前台域名')
    boss_base_url = models.URLField(blank=True, default='', help_text='后台完整入口（域名+安全入口段）')
    profile_key = models.CharField(max_length=100, default='shop-v1', help_text='复用的站点档案 id（config/sites.json）')
    # 站点测试账号（2026-09-24 ian：每站可配自己的前台/后台账密，测试遇到登录自动使用）
    front_account = models.CharField(max_length=200, blank=True, default='', help_text='前台测试账号')
    front_password = models.CharField(max_length=200, blank=True, default='', help_text='前台测试密码')
    boss_account = models.CharField(max_length=200, blank=True, default='', help_text='后台测试账号')
    boss_password = models.CharField(max_length=200, blank=True, default='', help_text='后台测试密码')
    # 探索独立账号（2026-11 三期 ian：AI 探索与真实 Job 账号隔离，避免探索写操作污染真实测试数据）
    explore_account = models.CharField(max_length=200, blank=True, default='', help_text='AI 探索专用前台账号（留空=复用前台测试账号）')
    explore_password = models.CharField(max_length=200, blank=True, default='', help_text='AI 探索专用前台密码')
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def snapshot(self):
        cfg = {
            'id': self.code, 'name': self.name, 'base_url': self.base_url,
            'adapter': self.adapter_key, 'allowed_host': self.allowed_host,
            'locales': self.locales, 'devices': self.devices, 'currency': self.currency,
            'max_concurrency': self.max_concurrency, 'requests_per_minute': self.requests_per_minute,
            'endpoints': self.endpoints(), 'profile': self.profile_key,
        }
        raw = json.dumps(cfg, sort_keys=True, ensure_ascii=False)
        return cfg, hashlib.sha256(raw.encode()).hexdigest()

    def endpoints(self):
        """三端域名（空值不输出，runner 端跳过覆盖）"""
        ep = {}
        if self.pc_base_url:
            ep['pc'] = self.pc_base_url
        if self.wap_base_url:
            ep['wap'] = self.wap_base_url
        if self.boss_base_url:
            ep['boss'] = self.boss_base_url
        return ep

class SiteVersion(models.Model):
    site = models.ForeignKey(Site, on_delete=models.PROTECT, related_name='versions')
    version = models.PositiveIntegerField()
    config = models.JSONField()
    sha256 = models.CharField(max_length=64)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['site', 'version'], name='unique_site_version')]
