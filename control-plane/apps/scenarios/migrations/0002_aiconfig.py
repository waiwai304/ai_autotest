from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('scenarios', '0001_initial'),
    ]

    operations = [
        migrations.CreateModel(
            name='AiConfig',
            fields=[
                ('id', models.BigAutoField(auto_created=True, blank=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('base_url', models.CharField(default='https://api.deepseek.com/v1', help_text='OpenAI 兼容接口地址，如 https://api.deepseek.com/v1', max_length=300)),
                ('api_key', models.CharField(blank=True, default='', max_length=200)),
                ('model', models.CharField(blank=True, default='deepseek-chat', help_text='模型名须与服务端完全一致（部分网关要求全小写）', max_length=120)),
                ('enabled', models.BooleanField(default=False)),
                ('temperature', models.FloatField(default=0.2)),
                ('timeout_sec', models.PositiveIntegerField(default=120)),
                ('max_tokens', models.PositiveIntegerField(default=6000, help_text='reasoning 模型思考也计入，规划类建议 ≥4000')),
                ('last_test_ok', models.BooleanField(blank=True, default=None, null=True)),
                ('last_test_at', models.DateTimeField(blank=True, null=True)),
                ('last_test_msg', models.CharField(blank=True, default='', max_length=300)),
                ('updated_at', models.DateTimeField(auto_now=True)),
            ],
            options={
                'verbose_name': 'Agent 接入配置',
            },
        ),
    ]
