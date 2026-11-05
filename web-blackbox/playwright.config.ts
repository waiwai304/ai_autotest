// eslint-disable-next-line @typescript-eslint/no-var-requires
const { defineConfig, devices } = require('@playwright/test');
const { readFileSync } = require('node:fs');

// 加载 .env（Node 20.6+ 原生支持）
try {
  process.loadEnvFile();
} catch {
  /* .env 不存在时忽略 */
}

/** 默认 baseURL：BASE_URL env > config/sites.json 站点档案（TEST_SITE_ID/TEST_SITE_IDS 选站） > 兜底 */
function pickBaseURL() {
  if (process.env.BASE_URL && process.env.BASE_URL.trim()) return process.env.BASE_URL.trim();
  try {
    const cfg = JSON.parse(readFileSync('config/sites.json', 'utf-8'));
    const enabled = (cfg.sites || []).filter((s) => s.enabled);
    if (!enabled.length) throw new Error('无 enabled 站点');
    const id = (process.env.TEST_SITE_ID || (process.env.TEST_SITE_IDS || '').split(',')[0] || '').trim();
    const chosen = (id ? enabled.find((s) => s.id === id) : enabled[0]) || enabled[0];
    return (chosen.pc && chosen.pc.baseURL) || chosen.baseURL;
  } catch {
    return 'https://demo.example.com';
  }
}

const baseURL = pickBaseURL();
const workers = Number(process.env.WORKERS || '2');
const retries = Number(process.env.RETRIES || '1');

module.exports = defineConfig({
  testDir: './tests',
  outputDir: './output/test-results',
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: true,
  workers,
  retries,
  forbidOnly: Boolean(process.env.CI),
  reporter: [
    ['list'],
    // playwright 原生 HTML 报告放独立目录 playwright-report/<RUN_ID>：
    // 严禁与自定义报告 output/html-report/<RUN_ID>（capture-flow-steps 截图 + gen-html-report.py）共用——
    // html reporter 写入时会【清空目标目录】，2026-09-22 曾因此删光 screenshots/ 导致自定义报告全部碎图
    ['html', { outputFolder: process.env.RUN_ID ? `output/playwright-report/${process.env.RUN_ID}` : 'output/playwright-report/_latest', open: 'never' }],
    ['junit', { outputFile: process.env.RUN_ID ? `output/${process.env.RUN_ID}/junit-results.xml` : 'output/junit/results.xml' }],
    ['json', { outputFile: process.env.RUN_ID ? `output/${process.env.RUN_ID}/results.json` : 'output/json/results.json' }],
  ],
  use: {
    baseURL,
    headless: process.env.HEADLESS !== 'false',
    ignoreHTTPSErrors: false,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    locale: 'en-US',
    timezoneId: 'Asia/Shanghai',
    // 2026-09-27 ian：报告需要每步骤截图反馈——改为每个用例结束都截图（attachments 进 results.json）
    screenshot: 'on',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'onebuy-desktop',
      use: {
        baseURL,
        // 2026-10-12 终局定案：删除 devices['Desktop Chrome']——其伪装 UA（Windows Chrome）触发站点风控降级，
        // 详情页价格区不渲染（UA 对照实验铁证：真实 HeadlessChrome UA ¥20.60 渲染成功 vs 伪装 UA bodyLen 406 无价格，
        // 全天「探针活 Job 死」的根因）。viewport 1280×720 与默认一致，删除无副作用。
        // 容器环境 /dev/shm 受限：后台照片上传预览渲染大图时 renderer 会 crash（Target closed）
        launchOptions: { args: ['--disable-dev-shm-usage', '--disable-gpu'] },
      },
    },
    {
      name: 'onebuy-mobile',
      use: {
        ...devices['iPhone 15'],
        baseURL,
      },
    },
  ],
});
