from django.urls import path
from . import views

urlpatterns = [
    path('', views.policy_list, name='policy_list'),
    path('create/', views.policy_create, name='policy_create'),
    path('<slug:code>/', views.policy_detail, name='policy_detail'),
    path('<slug:code>/edit/', views.policy_edit, name='policy_edit'),
    path('<slug:code>/lock/', views.policy_lock_toggle, name='policy_lock_toggle'),
]
