# OneBuy 自动化测试平台（端口 3008）功能与页面说明 —— 供 UI 设计使用

> 版本：2026-09-24 · 代码根：`/mnt500/www/wwwroot/onebuy_ceshi/Django/control-plane/`
> 用途：ian UI 重设计参考。本文档按「平台定位 → 信息架构 → 逐页说明 → 状态语义 → 现状与建议」组织。

---

## 一、平台定位（一句话）

面向测试团队的 **网站自动化测试管理与执行平台**：管理员在平台上选择「目标网站 × 测试用例 × 终端（PC/WAP）」发起测试，平台驱动 Playwright 真实浏览器跑完整业务链路（下单→后台处理→发货→收货），并集中展示每轮测试的 HTML 报告（逐步截图 + curl 复现 + 异常分类）。

**核心用户动线**：
```
仪表盘总览 → 发起测试（选网站/用例/端） → 执行中心盯进度（Campaign→Job） → 报告中心看结果 → Job 详情排查（日志/产物/重试）
```

**技术栈**（UI 需感知的约束）：Django 模板 + Bootstrap 5.3.3（CDN）+ 少量原生 JS；无前端构建链，UI 改造建议继续走 Bootstrap 5 主题定制或引入轻量 CSS 覆盖层，不建议引入重型前端框架。

---

## 二、信息架构（全局导航，9 项）

顶栏：品牌「🧪 OneBuy 测试平台」+ 主导航 + 右侧用户名/退出（POST /logout/）。

| 导航项 | 路由 | 模块 | 一句话职责 |
|---|---|---|---|
| 仪表盘 | `/dashboard/` | accounts | 全站总览：统计卡 + 最近用例/记录/Campaign |
| 网站 | `/sites/` | sites | 被测网站档案（只读） |
| 流程库 | `/scenarios/` | scenarios | 测试用例（流程）与版本管理（只读） |
| 用例说明 | `/scenarios/cases/` | scenarios | 用例步骤文档页（人类可读的用例说明书） |
| Policy | `/policies/` | policies | 执行策略规则包（只读） |
| Skills | `/skills/` | skills | 技能包版本（只读） |
| 执行中心 | `/campaigns/` | campaigns | Campaign/Job 的发起、进度、取消、重试（核心交互） |
| 报告中心 | `/reports/` | reports | 历史 HTML 报告卡片流 + Campaign 汇总报告 |
| 后台管理 | `/admin/` | Django Admin | 数据增删改（唯一写入口） |

其余非导航路由：`/login/`、`/artifacts/<path>`（产物鉴权下载）、`/api/v1/*`（REST 只读 API）、`/health/`。

---

## 三、逐页功能说明

### 3.1 登录页 `/login/`
- 卡片式表单，标题「登录 · 网站自动化测试平台」；字段：用户名（autofocus）、密码；错误 alert；通栏「登录」主按钮。
- UI 要点：唯一无需登录的页面，适合做品牌化门面。

### 3.2 仪表盘 `/dashboard/`
- 页头：「仪表盘」+ 主按钮「▶ 发起测试」→ `/campaigns/new/`
- 4 个统计卡：测试用例数 / 网站数 / Campaign 数 / 执行记录数
- 3 个状态卡（彩色边框）：通过（绿）/ 失败（红）/ 运行中（黄）
- 「最近测试用例」表 7 列：用例 code、名称、支持端徽章（🖥PC/📱WAP）、执行入口 spec（code 样式）、自定义设置数、最近 3 次 Job 状态迷你徽章、操作列「发起」按钮（→ 预选该用例的发起表单）
- 「最近测试记录」表（最近 12 条 Job）7 列：JOB 链接、端徽章、站点、用例、状态徽章、耗时、报告链接
- 「最近 Campaign」表（最近 8 条）6 列：ID 链接、名称、状态、任务完成度 finished/total、通过/失败、创建时间

### 3.3 网站管理
- `/sites/` 列表：标题「网站管理」；表格 6 列：编码、名称、Base URL、Adapter、白名单域名、启用（✅/❌）；空态提示「可在 /admin/ 或 seed_onebuy 导入」。**只读，无新建/编辑按钮**。
- `/sites/<pk>/` 详情：标题=网站名+code；键值表：Base URL、Adapter、白名单域名、语言、设备、并发限制、RPM 频率限制。

### 3.4 流程库（测试用例）
- `/scenarios/` 列表：标题「流程库」；表格 3 列：编码（链详情）、名称、启用。只读。
- `/scenarios/<pk>/` 详情：标题=用例名+code；版本表 5 列：版本 v{n}、状态（草稿/审核中/已发布/已停用）、Runner Spec、SHA256 前 16 位、创建时间。只读。
- `/scenarios/cases/` 用例说明页（重设计重点页）：
  - 页头：「📋 测试用例说明」+「▶ 发起测试」按钮；副标题说明数据来源与生成时间
  - case_docs.json 缺失时显示生成命令警告条
  - 每用例一张卡片：
    - 卡头：code、描述、支持端徽章、复用性徽章（✅可复用其他网站 / ⚠复用性不达标）、「发起」按钮
    - 卡体：各端执行入口 spec 徽章、站点档案驱动标记、硬编码域名警告徽章
    - 「步骤（N 步）」表 3 列：步骤 ID（F1/B1…）、端、内容/预期
    - 「涉及页面」徽章组（站点档案键 → 实际路径）

### 3.5 Policy `/policies/`
- 只读列表；表格 4 列：编码、版本、名称、锁定（🔒/—）；空态提示 make sync 导入。

### 3.6 Skills `/skills/`
- 只读列表；表格 3 列：编码、版本、名称；空态同上。

### 3.7 执行中心（核心业务模块）
- `/campaigns/` 列表：页头「执行中心」+「+ 新建 Campaign」；表格 6 列：ID 链接、名称、状态、任务 finished/total、通过/失败、创建时间。
- `/campaigns/new/` **发起测试表单（全平台最复杂表单）**，字段清单：
  | 字段 | 控件 | 必填 | 说明 |
  |---|---|---|---|
  | name | text | 否 | 留空自动命名「Campaign YYYY-MM-DD HH:MM」 |
  | ends | checkbox×2 | 否（默认全勾） | 🖥 PC 端 / 📱 WAP 端；每端各生成一个 Job |
  | site_ids | checkbox 组 | 是 | 启用的网站，标签「名称（编码）」 |
  | override_pc / override_wap / override_boss | text×3 | 否 | 域名覆盖（高级区），须 http(s):// 开头，非法回显报错 |
  | scenario_ids | 用例卡片组 | 是 | 每个已发布用例一张卡（code·名称·v版本+端徽章+「真实交易」红徽章+spec）；支持 URL `?scenario=<code>` 预选 |
  | set_<code>_<key> | 动态控件 | 否 | 按用例 settings_schema 渲染（bool=checkbox/text=输入框）；勾选用例后 JS 展开 |
  - 布局：左栏（4/12）网站清单+提示+域名覆盖；右栏（8/12）用例卡片列表；底部「创建并投递执行」主按钮。成功后 messages 提示并跳详情页。
- `/campaigns/<pk>/` 详情：标题「Campaign #id · 名称」；未完成时「取消」按钮（POST）；概要行：状态、端（🖥/📱）、任务进度、通过/失败数；有汇总报告时「查看 Campaign 报告」按钮；Job 表 7 列：JOB 链接、端徽章、站点、流程、状态、报告链接、操作（failed/lost 显示「重试」）。
- `/campaigns/<pk>/jobs/<job_id>/` Job 详情：标题 JOB-xxxxxx+状态+端徽章；信息行：站点、用例、尝试次数、心跳时间；有报告时绿色醒目按钮「📄 打开本轮测试报告」；左右两栏 pre：结果摘要 / RunManifest JSON；「Runner 日志（尾部）」深色终端风 pre（最后 3000 字符）；「产物文件」下载列表；failed/lost 时「重试本 Job」。

### 3.8 报告中心 `/reports/`
- 标题「📑 测试报告中心」+副标题（历史轮次 + 平台轮次，区分 PC/WAP）。
- **Job 报告卡片网格**（auto-fill，最小 260px，圆角 22px 悬浮卡）：每卡=📄 图标+目录名（如 JOB-000012-PC）+ 端徽章（🖥 蓝 / 📱 绿）+ 关联 Job 徽章（用例code·状态色）+ 🕒 时间 + 🖼 截图张数；整卡点击进 HTML 报告；空态「📭 暂无测试报告」。
- **Campaign 汇总报告表** 6 列：Campaign #id、名称、状态、任务进度、通过/失败、报告链接（md/json）。
- **注意：当前无任何筛选/搜索控件**，固定按时间倒序。

### 3.9 其他
- `/artifacts/<path>`：产物文件鉴权下载（无页面）。
- `/api/v1/actions|campaigns/<pk>|jobs/<pk>/artifacts`：只读 REST（无页面）。

---

## 四、状态与颜色语义（UI 必须沿用）

| 维度 | 取值 → 语义色 |
|---|---|
| 端 | PC=蓝(primary)、WAP=绿(success)，徽章统一 🖥/📱 前缀 |
| Job 状态 | passed 通过=绿 / failed 失败=红 / running 运行中=黄 / lost 失联=黑灰 / queued 排队 / cancelled 取消=灰 |
| Campaign 状态 | created 已创建 / queued 排队中 / running 运行中 / completed 已完成 / cancelled 已取消 |
| 用例版本状态 | 草稿 / 审核中 / 已发布（仅已发布可被执行中心选中）/ 已停用 |
| 特殊徽章 | 「真实交易」（用例 mutating=会下真实订单）=红，「可复用其他网站」=绿 |

## 五、UI 现状基线与建议改进点

现状基线：深色顶导航 + 浅灰背景 + 白卡片/表格；Bootstrap 5.3.3；emoji 图标 + 彩色徽章表达状态；中文界面。

建议改进点（当前代码层面已确认缺失/瑕疵）：
1. **报告中心无筛选器**——建议补：按端（PC/WAP）、按用例、按状态、按时间范围筛选 + 关键词搜索。
2. **只读管理页无编辑入口**——sites/scenarios/policies/skills 全只读，数据管理跳 Django Admin；建议 UI 上保留只读但增加「去 Admin 编辑」跳转或说明。
3. 仪表盘信息密度高（4 统计+3 状态+3 表格），重设计可考虑卡片分区/Tab 化。
4. 小 bug：`policies/list.html` 锁定列 yesno 过滤器参数末尾多一个引号会显示到页面；`campaigns/new.html` 有一处空 `{% if %}{% endif %}`；`accounts/views.py home()` 为死代码。
5. 深色终端风 pre 块（日志/manifest）与浅色卡片风格差异大，重设计时建议统一「代码/终端」视觉语言。

## 六、角色模型（权限 UI 预留）

accounts 定义四角色：admin 管理员 / lead 测试负责人 / tester 测试人员 / viewer 只读用户；另有审计日志模型（页面层未使用）。当前 UI 未按角色显隐，重设计可预留角色徽章与权限化菜单。
