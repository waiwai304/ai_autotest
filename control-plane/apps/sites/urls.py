from django.urls import path
from . import views

urlpatterns = [
    path('', views.site_list, name='site_list'),
    path('new/', views.site_new, name='site_new'),
    path('<int:pk>/', views.site_detail, name='site_detail'),
    path('<int:pk>/edit/', views.site_edit, name='site_edit'),
    path('<int:pk>/toggle/', views.site_toggle, name='site_toggle'),
    path('<int:pk>/weight/', views.site_weight, name='site_weight'),
]
