from django.urls import path
from . import views_ledger, views_insights

urlpatterns = [
    path('', views_ledger.ledger_list, name='ledger_list'),
    path('insights/', views_insights.insights, name='insights'),
]
