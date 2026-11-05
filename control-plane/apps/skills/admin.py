from django.contrib import admin
from .models import SkillPackVersion

@admin.register(SkillPackVersion)
class SkillPackVersionAdmin(admin.ModelAdmin):
    list_display = ('code', 'version', 'name', 'published_at')
    readonly_fields = ('sha256',)
