from django.urls import path
from . import views

urlpatterns = [
    path('', views.scenario_list, name='scenario_list'),
    path('cases/', views.case_docs, name='scenario_cases'),
    path('cases/create/', views.case_create, name='scenario_case_create'),
    path('cases/ai-create/', views.ai_case_create, name='scenario_case_ai_create'),
    path('cases/ai-create/stream/', views.ai_create_stream, name='scenario_case_ai_create_stream'),
    path('ai-config/', views.ai_config, name='scenario_ai_config'),
    path('explore/<int:pk>/', views.scenario_explore_detail, name='scenario_explore_detail'),
    path('recipes/', views.action_recipes, name='scenario_recipes'),
    path('<int:pk>/dry-run/', views.scenario_dry_run, name='scenario_dry_run'),
    path('<int:pk>/replan/', views.scenario_replan, name='scenario_replan'),
    path('<int:pk>/rename/', views.scenario_rename, name='scenario_rename'),
    path('<int:pk>/weight/', views.scenario_weight, name='scenario_weight'),
    path('<int:pk>/toggle/', views.scenario_toggle, name='scenario_toggle'),
    path('<int:pk>/delete/', views.scenario_delete, name='scenario_delete'),
    path('<int:pk>/', views.scenario_detail, name='scenario_detail'),
]
