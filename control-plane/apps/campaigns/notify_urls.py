from django.urls import path
from . import views_notify

urlpatterns = [
    path('', views_notify.notify_list, name='notify_list'),
    path('settings/', views_notify.notify_settings_save, name='notify_settings'),
    path('new/', views_notify.notify_new, name='notify_new'),
    path('<int:pk>/edit/', views_notify.notify_edit, name='notify_edit'),
    path('<int:pk>/toggle/', views_notify.notify_toggle, name='notify_toggle'),
    path('<int:pk>/delete/', views_notify.notify_delete, name='notify_delete'),
    path('<int:pk>/test/', views_notify.notify_test, name='notify_test'),
]
