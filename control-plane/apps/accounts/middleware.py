import json
from apps.accounts.models import AuditLog

EXEMPT_PREFIXES = ('/static/', '/health/', '/login/', '/admin/jsi18n')

def audit_middleware(get_response):
    def middleware(request):
        response = get_response(request)
        p = request.path
        if request.method == 'POST' and not any(p.startswith(x) for x in EXEMPT_PREFIXES) and getattr(request, 'user', None) and request.user.is_authenticated:
            try:
                AuditLog.objects.create(
                    user=request.user, action=f'{request.method} {p}',
                    detail={'status': response.status_code},
                    ip=request.META.get('REMOTE_ADDR'),
                )
            except Exception:
                pass
        return response
    return middleware
