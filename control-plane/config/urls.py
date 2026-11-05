from django.contrib import admin
from django.urls import path, include
from django.contrib.auth import views as auth_views
from django.http import JsonResponse
from django.shortcuts import redirect
from apps.accounts.views import LoginView
from apps.campaigns.views import job_list, job_delete

def health(request):
    return JsonResponse({'status': 'ok'})

urlpatterns = [
    path('', lambda r: redirect('/dashboard/')),
    path('health/', health),
    path('admin/', admin.site.urls),
    path('login/', LoginView.as_view(), name='login'),
    path('logout/', auth_views.LogoutView.as_view(), name='logout'),
    path('dashboard/', include('apps.accounts.dashboard_urls')),
    # 全局执行记录（2026-09-26 仪表盘数字下钻；顶层独立路由，区别于 /campaigns/ 执行中心）
    path('jobs/', job_list, name='job_list'),
    path('jobs/delete/', job_delete, name='job_delete'),
    # 测试用例库（2026-10-08 ian：关键词/图片/链接素材池）
    path('library/', include('apps.campaigns.library_urls')),
    path('notify/', include('apps.campaigns.notify_urls')),
    path('ledger/', include('apps.campaigns.ledger_urls')),
    path('sites/', include('apps.sites.urls')),
    path('scenarios/', include('apps.scenarios.urls')),
    path('policies/', include('apps.policies.urls')),
    path('skills/', include('apps.skills.urls')),
    path('campaigns/', include('apps.campaigns.urls')),
    path('reports/', include('apps.reports.urls')),
    path('artifacts/<str:path>', include('apps.artifacts.artifact_urls')),
    path('api/v1/', include('apps.campaigns.api_urls')),
]
