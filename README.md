# ai_autotest —— AI 驱动的网站自动化测试平台

> Django 控制平面 + Playwright 黑盒执行器：一句话口语描述 → AI 规划 → 真实浏览器探索验证 → 自动生成可执行的测试用例与截图报告。

![平台架构](docs/images/architecture.png)

## 一、项目简介

ai_autotest 是一套**面向电商及通用网站的 AI 自动化测试平台**。它把「测试人员写用例」变成「测试人员说一句话」：

```
口语描述（如"注册新账号，搜索蓝牙耳机，加购后去购物车验证"）
   ↓  AI 深度规划（6~20 步，操作→断言配对）
结构化测试计划（doc_steps）
   ↓  真实浏览器逐步实走取证（截图 / URL / toast / 失败页链接摘要）
探索验证结果
   ↓  失败步骤自动喂回 AI 修正（页面感知 replan，最多 2 轮）
可执行测试用例（自动创建并发布）
   ↓  Campaign 调度真实执行
HTML + MD 双件套测试报告（截图 + curl 逐步复现）
```

### 核心能力

| 模块 | 能力 |
|---|---|
| **多站点管理** | 站点档案（路径表 / PC/WAP 多端域名 / 测试账号）配置化；泛化适配器支持非同构站点；探索独立账号与真实测试数据隔离 |
| **流程库 / 用例库** | doc_steps 结构化用例，版本化管理（草稿/审核/发布/停用）；素材池（搜索关键词 / 搜索图片 / 搜索链接）卡片池管理，支持批量录入、启停、站点绑定 |
| **AI 口语建用例** | 一句话 → AI 深度规划；预览编辑模式（人工微调每步动作/参数）与**一键自动闭环**模式（自动探索 → 失败自动 AI 修正再探索 ≤2 轮 → 自动创建并发布用例），全程零人工介入 |
| **AI 探索验证** | 真实浏览器逐步实走，逐步截图取证；失败页可见链接摘要回喂 AI，实现"页面感知"的精准修正而非凭空猜 |
| **执行调度** | Campaign / Job 两级模型；站点锁互斥（探索与真实任务不冲突）、限流、失败重试、进度心跳、取消 |
| **测试报告** | 每次执行产出 HTML 报告 + Markdown 报告双件套；截图 + curl 逐步复现；Campaign 汇总报告；报告中心支持按关键字 / 类别 / 站点 / 时间范围筛选 |
| **动作配方库** | 白名单外意图由启发式探索自动尝试点击并沉淀候选配方；人工核准后即时并入 AI 规划词汇表，平台的"动作原语"可自我生长 |
| **通知与配额** | 通用 webhook 通知（每任务出结果即推 / 仅失败 / 仅汇总）；站点级并发与速率配额 |

### 技术栈

- **控制平面**：Python / Django / Celery / Redis / PostgreSQL
- **执行器**：TypeScript / Playwright（Chromium，PC 1440×900 与 WAP 390×844 双视口）
- **AI 接入**：OpenAI 兼容协议（自定义 base_url + api_key + model，DeepSeek 等均可），流式输出，配置存数据库不入代码
- **部署**：Docker Compose（web / browser-worker / scheduler / report-worker / redis / postgres / nginx）

## 二、目录结构

```
ai_autotest/
├── control-plane/          # Django 平台
│   ├── apps/
│   │   ├── sites/          # 站点管理（档案/多端域名/测试账号/配额）
│   │   ├── scenarios/      # 流程库、AI 规划器、探索运行、动作配方
│   │   ├── campaigns/      # 测试发起、Job 调度、执行洞察、台账
│   │   └── reports/        # 报告中心（筛选/删除/鉴权浏览）
│   ├── templates/          # 平台全部页面模板
│   └── scripts/            # 部署/验证脚本
├── django/                 # 部署层
│   ├── docker-compose.yml  # 全套服务编排
│   ├── docker/             # Dockerfile.web / Dockerfile.runner / nginx.conf
│   └── policy-packs/ skill-packs/ tools/
├── web-blackbox/           # Playwright 黑盒执行器
│   ├── tests/              # 用例 spec + ai_explore.ts 探索器
│   ├── tests/helpers/      # docflow 动作原语（register/login/search/add_cart/...）
│   ├── scripts/            # 站点探针与验证脚本
│   └── config/             # sites.example.json 站点档案模板
└── docs/                   # 实施文档 + 图片素材（docs/images/）
```

## 三、快速开始

```bash
# 1. 配置站点档案（模板 → 真实文件，按需修改域名与路径表）
cp web-blackbox/config/sites.example.json web-blackbox/config/sites.json

# 2. 启动全套服务
cd django && docker compose up -d

# 3. 初始化数据库并创建管理员
docker compose exec web python manage.py migrate
docker compose exec web python manage.py createsuperuser

# 4. 打开平台（默认 nginx 3008 端口），登录后：
#    站点管理 → 添加站点并配置测试账号
#    AI 接入设置 → 填 base_url / api_key / model 并启用
#    AI 建用例 → 写一句话，点「⚡ 一键自动闭环」
```

> 环境变量（DB/REDIS 密码、RUNNER_ROOT 等）见 `django/docker-compose.yml`。
> **数据边界**：本仓库不含任何真实站点配置、AI 密钥、测试报告与业务数据。

## 四、图片素材清单（待填充）

> 以下图片均为占位引用，素材放入 `docs/images/` 并按下表命名即可自动生效。

| 文件名 | 用途 | 建议尺寸 | 格式 | 内容要求 |
|---|---|---|---|---|
| `architecture.png` | README 顶部架构图 | 1600×900 | PNG/SVG | 平台三层架构：控制平面（Django）→ 任务队列（Celery/Redis）→ 执行器（Playwright）→ 被测站点；标注 AI 闭环（规划→探索→修正→建用例）回路 |
| `dashboard.png` | 平台总览截图 | 1600×1000 | PNG | 平台首页/仪表盘：用例数、站点数、近期执行、通过率卡片 |
| `ai-create.png` | AI 口语建用例页 | 1600×1000 | PNG | 输入态或预览态：口语描述输入框 + 步骤预览表 + 「⚡ 一键自动闭环」绿色按钮 |
| `explore-detail.png` | AI 探索验证详情 | 1600×1000 | PNG | 探索结果逐步列表（ok/失败徽标、截图缩略、URL、自动闭环轮次信息卡） |
| `report-center.png` | 报告中心 | 1600×1000 | PNG | 报告列表 + 顶部筛选栏（搜索/类别/站点/时间）双行布局 |
| `library-pool.png` | 测试用例库卡片池 | 1600×1000 | PNG | 关键词/搜索图片/搜索链接三列卡片池，虚线「＋添加」方块与查看/修改弹窗 |
| `workflow.png` | 使用流程图 | 1400×600 | PNG/SVG | 一句话 → AI 规划 → 探索取证 → 自动修正 → 建用例 → 报告 的端到端流程 |
| `logo.png` | 项目 Logo（备用） | 512×512 | PNG 透明底 | 简洁图标：AI + 自动化测试语义（闪电/机器人/复选框组合） |

**素材要求**：截图类使用平台真实页面（暗色或默认主题均可），浏览器宽度 ≥1440；图片文件 ≤500KB（截图可压缩）；命名严格按上表小写；无需修改 README——路径已按 `docs/images/<文件名>` 引用，补齐文件即显示。

## License

见 [LICENSE](LICENSE)。
