from django.urls import path
from . import views
urlpatterns = [path('<path:path>', views.artifact_download, name='artifact_download')]
