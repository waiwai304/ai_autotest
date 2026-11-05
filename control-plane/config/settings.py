from pathlib import Path
import environ

BASE_DIR = Path(__file__).resolve().parent.parent
env = environ.Env(DEBUG=(bool, False))
environ.Env.read_env(BASE_DIR.parent / '.env')

SECRET_KEY = env('DJANGO_SECRET_KEY')
DEBUG = env('DEBUG')
ALLOWED_HOSTS = env.list('DJANGO_ALLOWED_HOSTS', default=['localhost'])
CSRF_TRUSTED_ORIGINS = env.list('CSRF_TRUSTED_ORIGINS', default=[])

INSTALLED_APPS = [
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    'django_celery_beat',
    'rest_framework',
    'apps.accounts',
    'apps.sites',
    'apps.scenarios',
    'apps.policies',
    'apps.skills',
    'apps.campaigns',
    'apps.reports',
    'apps.artifacts',
    'apps.ai_analysis',
]

MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    'whitenoise.middleware.WhiteNoiseMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'apps.accounts.middleware.audit_middleware',
]

ROOT_URLCONF = 'config.urls'
TEMPLATES = [{
    'BACKEND': 'django.template.backends.django.DjangoTemplates',
    'DIRS': [BASE_DIR / 'templates'],
    'APP_DIRS': True,
    'OPTIONS': {'context_processors': [
        'django.template.context_processors.request',
        'django.contrib.auth.context_processors.auth',
        'django.contrib.messages.context_processors.messages',
    ]},
}]
WSGI_APPLICATION = 'config.wsgi.application'

# Bootstrap 5 alert 语义（Django 默认 error → alert-danger）
from django.contrib.messages import constants as _message_constants
MESSAGE_TAGS = {_message_constants.ERROR: 'danger'}

DATABASES = {'default': env.db('DATABASE_URL')}

AUTH_PASSWORD_VALIDATORS = [
    {'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator'},
    {'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator'},
    {'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator'},
    {'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator'},
]
LANGUAGE_CODE = 'zh-hans'
TIME_ZONE = 'Asia/Shanghai'
USE_I18N = True
USE_TZ = True
STATIC_URL = 'static/'
STATICFILES_DIRS = [BASE_DIR / 'static']
STATIC_ROOT = BASE_DIR / 'staticfiles'
STATICFILES_STORAGE = 'whitenoise.storage.CompressedStaticFilesStorage'
DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'
LOGIN_URL = '/login/'
LOGIN_REDIRECT_URL = '/dashboard/'
LOGOUT_REDIRECT_URL = '/login/'

CELERY_BROKER_URL = env('CELERY_BROKER_URL')
CELERY_RESULT_BACKEND = env('CELERY_RESULT_BACKEND')
CELERY_ACCEPT_CONTENT = ['json']
CELERY_TASK_SERIALIZER = 'json'
CELERY_RESULT_SERIALIZER = 'json'
CELERY_TASK_TRACK_STARTED = True
CELERY_TASK_ACKS_LATE = True
CELERY_WORKER_PREFETCH_MULTIPLIER = 1
CELERY_TASK_SOFT_TIME_LIMIT = 25 * 60
CELERY_TASK_TIME_LIMIT = 30 * 60
CELERY_BEAT_SCHEDULER = 'django_celery_beat.schedulers:DatabaseScheduler'
# 显式队列路由（2026-09-23 修复：默认全进 celery 队列无人消费，导致 Campaign 不展开/失联检查不跑）
CELERY_TASK_ROUTES = {
    'campaigns.tasks.expand_campaign': {'queue': 'scheduler'},
    # 用例 spec 骨架生成：需写 RUNNER_ROOT（仅 browser-worker 挂载 web-blackbox 可写）
    'scenarios.tasks.generate_doc_spec': {'queue': 'browser'},
    'campaigns.tasks.check_lost_jobs': {'queue': 'scheduler'},
    'campaigns.tasks.run_browser_job': {'queue': 'browser'},
    # 2026-10-27 勾选删除连带清理 playwright 原始产物目录（RUNNER_ROOT/output 仅 browser-worker 可写）
    'campaigns.tasks.purge_run_dirs': {'queue': 'browser'},
    # AI 探索验证（2026-11 二期）：tsx 探索器需 browser-worker 的 RUNNER_ROOT/node_modules
    'scenarios.tasks.run_ai_explore': {'queue': 'browser'},
    'reports.tasks.build_campaign_report': {'queue': 'report'},
    'ai_analysis.tasks.analyze_failed_job': {'queue': 'report'},
    '*': {'queue': 'scheduler'},
}
CELERY_BEAT_SCHEDULE = {
    'check-lost-jobs': {'task': 'campaigns.tasks.check_lost_jobs', 'schedule': 60.0},
}

ARTIFACT_ROOT = Path(env('ARTIFACT_ROOT', default='/data/artifacts'))
# 平台对外地址（2026-10-21 通知推送里的详情/报告链接前缀；内网可填 http://<内网IP>:3008）
PLATFORM_BASE_URL = env('PLATFORM_BASE_URL', default='http://127.0.0.1:3008').rstrip('/')
# 外部触发 API 令牌（2026-10-21 ian：飞书/CI 可 POST /api/v1/campaigns/trigger 发起测试；空=禁用）
API_TRIGGER_TOKEN = env('API_TRIGGER_TOKEN', default='')
REPORT_ROOT = Path(env('REPORT_ROOT', default='/data/reports'))
MANIFEST_ROOT = Path(env('MANIFEST_ROOT', default='/data/run-manifests'))
# web-blackbox 历史报告目录（只读挂载，报告中心展示全部报告）
HTML_REPORT_ROOT = Path(env('HTML_REPORT_ROOT', default='/data/html-report'))
ARTIFACT_RETENTION_DAYS = env.int('ARTIFACT_RETENTION_DAYS', default=30)
RUNNER_ROOT = env('RUNNER_ROOT', default='/workspace/runner')
BROWSER_WORKER_CONCURRENCY = env.int('BROWSER_WORKER_CONCURRENCY', default=1)
ALLOW_MUTATING_TESTS = env.bool('ALLOW_MUTATING_TESTS', default=False)

AI_ENABLED = env.bool('AI_ENABLED', default=False)
AI_BASE_URL = env('AI_BASE_URL', default='')
AI_API_KEY = env('AI_API_KEY', default='')
AI_TIMEOUT_SECONDS = env.int('AI_TIMEOUT_SECONDS', default=90)

REST_FRAMEWORK = {
    'DEFAULT_AUTHENTICATION_CLASSES': ['rest_framework.authentication.SessionAuthentication'],
    'DEFAULT_PERMISSION_CLASSES': ['rest_framework.permissions.IsAuthenticated'],
}
