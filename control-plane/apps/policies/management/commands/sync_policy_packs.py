import hashlib, yaml
from pathlib import Path
from django.core.management.base import BaseCommand
from apps.policies.models import PolicyPackVersion

class Command(BaseCommand):
    help = '同步 policy-packs 目录（内容 Hash 相同不重复；内容变化创建新版本；已发布版本不覆盖）'

    def add_arguments(self, parser):
        parser.add_argument('root')

    def handle(self, *args, **opts):
        root = Path(opts['root'])
        for f in sorted(root.rglob('*.yaml')):
            content = f.read_text()
            sha = hashlib.sha256(content.encode()).hexdigest()
            data = yaml.safe_load(content) or {}
            code = data.get('id') or f.parent.name
            name = data.get('name', '')
            latest = PolicyPackVersion.objects.filter(code=code).order_by('-version').first()
            if latest and latest.sha256 == sha:
                self.stdout.write(f'skip {code}@{latest.version} (hash 相同)')
                continue
            # 2026-10-15 修复：code 是 unique 字段（每 code 仅一条记录），
            # 旧逻辑"变化 create 新版本"第二次变更必触发 IntegrityError——改为就地更新 version+1
            if latest:
                latest.content, latest.sha256 = content, sha
                latest.version = latest.version + 1
                latest.name = name or latest.name
                latest.locked = bool(data.get('locked'))
                latest.save()
                self.stdout.write(self.style.SUCCESS(f'updated {code}@{latest.version}'))
            else:
                PolicyPackVersion.objects.create(code=code, version=1, name=name, content=content,
                                                 locked=bool(data.get('locked')), sha256=sha,
                                                 published_at=__import__('django.utils.timezone', fromlist=['now']).now())
                self.stdout.write(self.style.SUCCESS(f'created {code}@1'))
