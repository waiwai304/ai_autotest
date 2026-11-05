from django.urls import path
from . import views_library

urlpatterns = [
    path('', views_library.library_list, name='library_list'),
    path('add/', views_library.library_add, name='library_add'),
    path('<int:pk>/edit/', views_library.library_edit, name='library_edit'),
    path('<int:pk>/toggle/', views_library.library_toggle, name='library_toggle'),
    path('<int:pk>/delete/', views_library.library_delete, name='library_delete'),
]
