# ai_autotest —— AI 驱动的网站自动化测试平台

Django 控制平面（control-plane）+ Playwright 黑盒执行器（web-blackbox）双仓合一代码。
支持接入 AI 一键探索、截图报告与人工修正。

## 核心能力
- **多站点管理**：站点档案（路径表/多端域名/测试账号）配置化，泛化适配器支持非同构站点
- **流程库 / 测试用例库**：doc_steps 结构化用例；素材池（搜索关键词/图片/链接）卡片池管理
- **AI 口语建用例**：一句话 → AI 深度规划（6~20 步，操作→断言配对）→ 预览编辑 / 一键自动闭环
  （自动探索 → 失败自动 AI 修正再探索（≤2 轮）→ 自动创建并发布用例）
- **AI 探索验证**：真实浏览器逐步实走取证（截图/URL/toast/失败页链接摘要），页面感知 replan
- **执行调度**：Campaign/Job 模型，站点锁互斥、限流、重试、进度心跳
- **HTML+MD 双件套测试报告**：截图 + curl 逐步复现；Campaign 汇总报告；报告中心按类别/站点/时间筛选
- **动作配方库**：unknown 意图启发式探索沉淀候选配方，人工核准即并入原语词汇表

## 目录结构
- `control-plane/` Django 平台（apps: sites / scenarios / campaigns / reports / accounts）
- `django/` 部署层（docker-compose、Dockerfile.web/runner、nginx、Makefile、policy/skill packs）
- `web-blackbox/` Playwright 执行器（tests/ 用例 spec、helpers/docflow 动作原语、ai_explore.ts 探索器）
- `docs/` 实施文档

## 快速开始
```bash
cp web-blackbox/config/sites.example.json web-blackbox/config/sites.json  # 按需改成你的站点
cd django && docker compose up -d          # web / worker / redis / postgres / nginx
docker compose exec web python manage.py migrate
# 打开 http://<host>/ 注册管理员后即可使用
```

> 环境变量见 `django/docker-compose.yml`（DB/REDIS 密码、RUNNER_ROOT 等）；AI 能力在平台「AI 接入设置」页配置（base_url/api_key/model），配置存于数据库，**本仓库不含任何真实站点配置、AI 密钥、测试报告与业务数据**。
