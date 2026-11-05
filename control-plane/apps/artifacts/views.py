import mimetypes
from django.conf import settings
from django.contrib.auth.decorators import login_required
from django.http import FileResponse, Http404
from pathlib import Path

@login_required
def artifact_download(request, path: str):
    """权限校验后经 Nginx X-Accel-Redirect 返回（无 nginx 时直接 FileResponse 兜底）"""
    root = Path(settings.ARTIFACT_ROOT).resolve()
    target = (root / path).resolve()
    if not str(target).startswith(str(root)) or not target.exists():
        raise Http404
    ct = mimetypes.guess_type(str(target))[0] or 'application/octet-stream'
    resp = FileResponse(target.open('rb'), content_type=ct)
    resp['X-Accel-Redirect'] = f'/protected-artifacts/{path}'
    return resp
