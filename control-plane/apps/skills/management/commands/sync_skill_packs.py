import hashlib, re
from pathlib import Path
from django.core.management.base import BaseCommand
from apps.skills.models import SkillPackVersion

class Command(BaseCommand):
    help = '同步 skill-packs 目录（Hash 去重，变化建新版本）'

    def add_arguments(self, parser):
        parser.add_argument('root')

    def handle(self, *args, **opts):
        root = Path(opts['root'])
        for f in sorted(root.rglob('SKILL.md')):
            content = f.read_text()
            sha = hashlib.sha256(content.encode()).hexdigest()
            m = re.search(r'^id:\s*(.+)$', content, re.M)
            code = m.group(1).strip() if m else f.parent.name
            n = re.search(r'^name:\s*(.+)$', content, re.M)
            name = n.group(1).strip() if n else ''
            latest = SkillPackVersion.objects.filter(code=code).order_by('-version').first()
            if latest and latest.sha256 == sha:
                self.stdout.write(f'skip {code}@{latest.version} (hash 相同)')
                continue
            # 2026-10-15 修复：code 是 unique 字段（每 code 仅一条记录），
            # 旧逻辑"变化 create 新版本"第二次变更必触发 IntegrityError——改为就地更新 version+1
            if latest:
                latest.content, latest.sha256 = content, sha
                latest.version = latest.version + 1
                latest.name = name or latest.name
                latest.save()
                self.stdout.write(self.style.SUCCESS(f'updated {code}@{latest.version}'))
            else:
                SkillPackVersion.objects.create(code=code, version=1, name=name, content=content, sha256=sha)
                self.stdout.write(self.style.SUCCESS(f'created {code}@1'))
