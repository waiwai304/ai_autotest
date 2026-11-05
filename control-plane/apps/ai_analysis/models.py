from django.conf import settings
from django.db import models

class AIAnalysis(models.Model):
    job = models.ForeignKey('campaigns.TestJob', on_delete=models.CASCADE, related_name='ai_analyses')
    model = models.CharField(max_length=100)
    prompt_version = models.CharField(max_length=50)
    skill_snapshot = models.JSONField()
    input_hash = models.CharField(max_length=64)
    result = models.JSONField()
    reviewer_feedback = models.CharField(max_length=30, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
