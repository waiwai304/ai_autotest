# 2026-11-04 ian：流程库增加"更新时间"（版本发布/改名/权重/启停时刷新），用于排序与筛选

from django.db import migrations, models
from django.utils import timezone


def backfill_updated_at(apps, schema_editor):
    """回填：无版本记录的取创建时间；有版本的取「最新版本时间与创建时间」较新者"""
    Scenario = apps.get_model('scenarios', 'Scenario')
    ScenarioVersion = apps.get_model('scenarios', 'ScenarioVersion')
    for sc in Scenario.objects.all():
        latest = ScenarioVersion.objects.filter(scenario=sc) \
            .order_by('-created_at', '-version').values_list('created_at', flat=True).first()
        sc.updated_at = max(latest, sc.created_at) if latest else sc.created_at
        sc.save(update_fields=['updated_at'])


def rollback_updated_at(apps, schema_editor):
    pass  # 字段删除即回滚，无需清理数据


class Migration(migrations.Migration):

    dependencies = [
        ('scenarios', '0004_scenario_weight'),
    ]

    operations = [
        migrations.AddField(
            model_name='scenario',
            name='updated_at',
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.RunPython(backfill_updated_at, rollback_updated_at),
    ]
