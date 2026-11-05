from django.conf import settings
from django.db import models

class Role(models.TextChoices):
    ADMIN = 'admin', '管理员'
    LEAD = 'lead', '测试负责人'
    TESTER = 'tester', '测试人员'
    VIEWER = 'viewer', '只读用户'

class RoleProfile(models.Model):
    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='role_profile')
    role = models.CharField(max_length=20, choices=Role.choices, default=Role.TESTER)

    def __str__(self):
        return f'{self.user.username}:{self.get_role_display()}'

class AuditLog(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL)
    action = models.CharField(max_length=200)
    detail = models.JSONField(default=dict)
    ip = models.GenericIPAddressField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']
        verbose_name = '审计日志'
