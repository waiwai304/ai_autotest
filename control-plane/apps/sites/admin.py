from django.contrib import admin
from .models import Site, SiteVersion

@admin.register(Site)
class SiteAdmin(admin.ModelAdmin):
    list_display = ('code', 'name', 'base_url', 'adapter_key', 'enabled', 'max_concurrency')
    search_fields = ('code', 'name')

admin.site.register(SiteVersion)
