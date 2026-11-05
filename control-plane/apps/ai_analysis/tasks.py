import hashlib, json
from celery import shared_task
from django.conf import settings

@shared_task(name='ai_analysis.tasks.analyze_failed_job')
def analyze_failed_job(job_id: int):
    """阶段四实现：证据脱敏 → Policy/Skill 快照 → 固定 Prompt → JSON Schema 校验 → AIAnalysis。MVP 仅入队占位。"""
    if not settings.AI_ENABLED:
        return 'AI_ENABLED=false, skip'
    return 'pending implementation'
