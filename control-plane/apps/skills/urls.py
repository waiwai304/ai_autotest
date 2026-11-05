from django.urls import path
from . import views

urlpatterns = [
    path('', views.skill_list, name='skill_list'),
    path('create/', views.skill_create, name='skill_create'),
    path('<slug:code>/', views.skill_detail, name='skill_detail'),
    path('<slug:code>/edit/', views.skill_edit, name='skill_edit'),
]
