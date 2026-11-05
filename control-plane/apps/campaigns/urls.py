from django.urls import path
from . import views

urlpatterns = [
    path('', views.campaign_list, name='campaign_list'),
    path('new/', views.campaign_new, name='campaign_new'),
    # 2026-10-27 执行中心勾选删除（放在 <int:pk>/ 前）
    path('delete/', views.campaign_delete, name='campaign_delete'),
    path('<int:pk>/', views.campaign_detail, name='campaign_detail'),
    path('<int:pk>/progress/', views.campaign_progress, name='campaign_progress'),
    path('<int:pk>/cancel/', views.campaign_cancel, name='campaign_cancel'),
    path('<int:pk>/jobs/<int:job_id>/', views.job_detail, name='campaign_job'),
    path('<int:pk>/jobs/<int:job_id>/log/', views.job_log, name='job_log'),
    path('<int:pk>/jobs/<int:job_id>/retry/', views.job_retry, name='job_retry'),
    path('<int:pk>/jobs/<int:job_id>/resume/', views.job_resume, name='job_resume'),
    path('<int:pk>/jobs/<int:job_id>/cancel/', views.job_cancel, name='job_cancel'),
]
