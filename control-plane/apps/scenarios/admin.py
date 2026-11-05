from django.contrib import admin
from .models import Scenario, ScenarioVersion

@admin.register(Scenario)
class ScenarioAdmin(admin.ModelAdmin):
    list_display = ('code', 'name', 'enabled')

admin.site.register(ScenarioVersion)
