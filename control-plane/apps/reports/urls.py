from django.urls import path
from . import views
urlpatterns = [
    path('', views.report_center, name='report_center'),
    path('delete/', views.report_delete, name='report_delete'),
    path('view/<str:name>/', views.report_view, name='report_view'),
    path('view/<str:name>/<path:rest>', views.report_view, name='report_view_file'),
    path('<int:campaign_id>/<str:name>/', views.campaign_report_file, name='campaign_report_file'),
]
