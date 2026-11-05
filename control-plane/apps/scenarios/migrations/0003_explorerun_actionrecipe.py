from django.db import migrations, models
import django.db.models.deletion
from django.conf import settings


class Migration(migrations.Migration):

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ('sites', '0003_site_boss_account_site_boss_password_and_more'),
        ('scenarios', '0002_aiconfig'),
    ]

    operations = [
        migrations.CreateModel(
            name='ExploreRun',
            fields=[
                ('id', models.BigAutoField(auto_created=True, blank=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('code', models.CharField(blank=True, default='', help_text='关联用例标识（预览阶段可空）', max_length=60)),
                ('plan', models.JSONField(help_text='探索的计划：steps(doc_steps 同构) + name/description/case_text')),
                ('status', models.CharField(choices=[('created', '待执行'), ('running', '探索中'), ('done', '已完成'), ('error', '执行失败')], default='created', max_length=20)),
                ('result', models.JSONField(blank=True, null=True, help_text='ai_explore.ts 产出的 result.json 内容')),
                ('error', models.CharField(blank=True, default='', max_length=500)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('finished_at', models.DateTimeField(blank=True, null=True)),
                ('created_by', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, to=settings.AUTH_USER_MODEL)),
                ('site', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='explore_runs', to='sites.site')),
            ],
            options={
                'ordering': ['-id'],
                'verbose_name': 'AI 探索验证',
            },
        ),
        migrations.CreateModel(
            name='ActionRecipe',
            fields=[
                ('id', models.BigAutoField(auto_created=True, blank=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('action_name', models.CharField(help_text='建议原语名（小写下划线），人工命名', max_length=60)),
                ('intent', models.CharField(help_text='口语意图（来自步骤 name/expect）', max_length=200)),
                ('evidence', models.JSONField(default=dict, help_text='探索证据：clicked_text/url_before/url_after/toast/截图')),
                ('status', models.CharField(choices=[('candidate', '候选'), ('approved', '已核准'), ('rejected', '已弃用')], default='candidate', max_length=20)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('explore', models.ForeignKey(null=True, blank=True, on_delete=django.db.models.deletion.SET_NULL, related_name='recipes', to='scenarios.exploreRun')),
            ],
            options={
                'ordering': ['-id'],
                'verbose_name': '动作配方',
            },
        ),
    ]
