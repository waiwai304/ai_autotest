from django.contrib import admin
from .models import RoleProfile, AuditLog

@admin.register(RoleProfile)
class RoleProfileAdmin(admin.ModelAdmin):
    list_display = ('user', 'role')

@admin.register(AuditLog)
class AuditLogAdmin(admin.ModelAdmin):
    list_display = ('user', 'action', 'ip', 'created_at')
    search_fields = ('user__username', 'action')
    readonly_fields = ('user', 'action', 'detail', 'ip', 'created_at')
