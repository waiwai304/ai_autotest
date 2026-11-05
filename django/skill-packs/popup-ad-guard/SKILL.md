id: popup-ad-guard
version: 1
name: 开屏广告/弹窗通用关闭守卫规范
---

# 背景

部分站点（如 spanbuy.tmp.dev.1buyo.com）首页有开屏广告弹窗（antd `popup-ad-modal` 等），遮挡搜索框/登录表单/CTA 按钮，导致测试「卡在首页」（案例：JOB-000105-PC）。

# 必须遵循

1. 所有用例打开站点页面后、执行首个业务交互前，必须先执行开屏广告/弹窗守卫 `dismissOverlays(page, logs)`（实现：`tests/helpers/overlay.ts`）。
2. 守卫为 best-effort：任何关闭失败不得阻断测试主流程，守卫自身绝不抛错。
3. 关闭策略只允许：精确文本关闭按钮（× / 关闭 / 跳过 / 我知道了 / 不再提醒 / close / skip）、class/aria 关闭特征（`[class*=close]`、`[aria-label*=close]`）、ESC 键兜底。
4. 禁止点击遮罩/mask 关闭（部分电商广告点遮罩=跳转活动页，误点风险大于收益）。
5. 禁止点击含「登录/注册/购买/加入/提交/确认/领取/立即/支付」等业务动词的元素（不是关闭按钮，防误触发下单/领券）。
6. 每轮至多点击 3 个候选、最多 5 轮（防误伤扩散）；每次成功关闭须写入 logs 留痕（报告可见「[overlay] 已关闭 N 个弹窗」）。

# 接入点（已覆盖，新增用例须保持）

- `tests/helpers/docflow.ts`：login / openHome / searchPickAndOpen / waitDetailRendered / addCartAndVerify / openCartAndCheck（全部 auto-v1 自动生成用例 doc-*.spec.ts 经此生效）。
- `tests/full-chain.spec.ts`：frontLogin / searchBoxEnter / 图搜方向 goto 首页后 / 详情页进入 / orders 订单页。

# 验证记录

- 2026-10-16 探针 `scripts/probe-overlay-guard.ts` 实测 spanbuy 首页：`popup-ad-modal` 开屏弹窗 2 个关闭元素命中，关闭后弹窗残留 0、页面恢复可交互。
