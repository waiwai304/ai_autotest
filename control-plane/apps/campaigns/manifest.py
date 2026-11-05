"""RunManifest 构建 + 安全校验（JSON Schema / 域名白名单 / Action 白名单 / Secret 扫描）"""
import hashlib, json
from pathlib import Path
from jsonschema import Draft202012Validator

SCHEMA_PATH = Path(__file__).resolve().parent.parent.parent / 'manifests' / 'run-manifest.schema.json'
ALLOWED_ACTIONS = {
    '__legacy_spec__', 'open_home', 'open_login', 'search_product', 'wait_product_results',
    'assert_product_count', 'assert_product_fields', 'assert_product_price',
    'assert_no_console_error', 'assert_locale_consistency',
}
SECRET_PATTERNS = ('password', 'passwd', 'secret', 'api_key', 'authorization', 'cookie', 'token=')

class ManifestError(Exception):
    pass

def _sha(obj) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True, ensure_ascii=False).encode()).hexdigest()

def build_manifest(job, site, scenario_version, dataset: dict | None = None, end: str | None = None) -> dict:
    end = (end or job.device or 'pc').lower()
    end = 'wap' if end in ('wap', 'mobile') else 'pc'
    site_cfg, site_sha = site.snapshot()
    # 2026-11-04 ian：技能包按用例内容自动挂载（含注册流程 → temp-mail-verification-code 等），
    # 执行侧通过 SKILL_PACKS 环境变量读取，运行留痕精确到技能包版本。
    from apps.skills.services import resolve_for_version
    extra = ' '.join(str(v) for v in (dataset or {}).get('vars', {}).values())
    skill_packs = resolve_for_version(scenario_version, extra)
    manifest = {
        'run_id': f"RUN-{job.campaign_id:06d}",
        'job_id': f"JOB-{job.pk:06d}",
        'site': site_cfg,
        'scenario': {
            'id': scenario_version.scenario.code,
            'version': scenario_version.version,
            'sha256': scenario_version.sha256,
            'runner_spec': scenario_version.end_spec(end),
        },
        'dataset': dataset or {},
        'policy_packs': [], 'skill_packs': skill_packs,
        'runtime': {
            'browser': 'chromium',
            'device': end,
            'locale': job.locale,
            'end': end,
        },
        'steps': [{'action': '__legacy_spec__', 'params': {'spec': scenario_version.runner_spec}}],
        'dataset_sha256': _sha(dataset or {}),
        'scenario_sha256': scenario_version.sha256,
        'site_sha256': site_sha,
    }
    validate(manifest)
    return manifest

def validate(m: dict) -> None:
    schema = json.loads(SCHEMA_PATH.read_text())
    v = Draft202012Validator(schema)
    errors = sorted(v.iter_errors(m), key=lambda e: e.path)
    if errors:
        raise ManifestError('Schema 校验失败: ' + '; '.join(f"{list(e.path)}: {e.message}" for e in errors[:5]))
    # 域名白名单
    host = m['site'].get('allowed_host', '')
    from urllib.parse import urlparse
    if urlparse(m['site']['base_url']).hostname != host:
        raise ManifestError('base_url 与 allowed_host 不一致')
    # Action 白名单
    for st in m['steps']:
        if st.get('action') not in ALLOWED_ACTIONS:
            raise ManifestError(f'未注册 Action: {st.get("action")}')
    # Secret 明文扫描
    raw = json.dumps(m, ensure_ascii=False).lower()
    for p in SECRET_PATTERNS:
        if f'"{p}"' in raw:
            raise ManifestError(f'Manifest 含疑似 Secret 字段: {p}')
    raw_spec = str(m['scenario'].get('runner_spec', ''))
    if '..' in raw_spec or raw_spec.startswith('/'):
        raise ManifestError('runner_spec 非法路径')
