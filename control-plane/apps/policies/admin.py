from django.contrib import admin
from .models import PolicyPackVersion

@admin.register(PolicyPackVersion)
class PolicyPackVersionAdmin(admin.ModelAdmin):
    list_display = ('code', 'version', 'name', 'locked', 'published_at')
    readonly_fields = ('sha256',)
