# OneBuy Django 测试管理平台（端口 3008）

依据《Django网站自动化测试平台实施文档-端口3008.md》实施；结合现有 Playwright 黑盒测试项目（../web-blackbox）。

- 平台入口: http://服务器IP:3008
- **测试执行与报告输出统一存放在 `../web-blackbox/output/django/`（artifacts / reports / run-manifests）**
- Runner = 现有 web-blackbox 项目（宿主机挂载进 browser-worker 容器 /workspace/runner），不复制、不改动其核心用例

## 快速开始
```bash
make build && make up && make migrate && make superuser && make sync && make ps
```
访问 http://服务器IP:3008 ，用创建的管理员登录。

## 目录
- control-plane/  Django 控制平台（Django 5.2 + DRF + Celery + HTMX + Bootstrap5）
- docker/         Dockerfile.web（控制面）/ Dockerfile.runner（Playwright 1.55.0-noble 浏览器 Worker）/ nginx.conf
- policy-packs/   系统锁定安全基线（base-production-rules）
- skill-packs/    production-safety / ecommerce-basic / ecommerce-product / ecommerce-i18n / ecommerce-auth
- 数据卷: web-blackbox/output/django/{artifacts,reports,run-manifests}

## Runner 打通方式（阶段二 MVP）
Scenario 通过 `runner_spec` 选择 web-blackbox 中**已存在的测试文件**（如 tests/full-chain.spec.ts），
Django 只生成经过校验的 RunManifest（JSON Schema + 域名白名单 + Action 白名单 + Secret 扫描），
browser-worker 在容器内以 `npx playwright test <spec>` 执行（WORKERS=1），result.json/junit/截图落盘 web-blackbox。
