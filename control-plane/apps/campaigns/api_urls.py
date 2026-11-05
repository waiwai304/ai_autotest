from django.urls import path
from . import api

urlpatterns = [
    path('actions', api.actions_list),
    path('campaigns/trigger', api.campaign_trigger),
    path('campaigns/<int:pk>', api.campaign_get),
    path('jobs/<int:pk>/artifacts', api.job_artifacts),
]
