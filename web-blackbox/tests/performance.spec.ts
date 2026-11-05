import { expect, test } from '../src/fixtures';
import { sites } from '../src/config';

// 桌面端用例仅在 Chromium(桌面 project) 运行；移动端由 tests/wap.spec.ts 覆盖
test.skip(({ browserName }) => browserName !== 'chromium', '桌面端用例不在移动端(WebKit)运行');

// 网站性能独立测试：记录导航耗时、请求数、慢请求与失败请求。
// 性能数据只做记录与阈值告警，不影响功能测试结论。

const SLOW_REQUEST_MS = 3000;

for (const site of sites) {
  test.describe(`${site.name} - 性能检测`, () => {
    test.use({ baseURL: site.baseURL });

    const perfRoutes = ['/', '/estimate', '/help', '/login'];

    for (const route of perfRoutes) {
      test(`/en${route === '/' ? '' : route} 加载性能`, async ({ page }) => {
        const requests: { url: string; duration: number; status: number }[] = [];
        const failed: { url: string; status: number }[] = [];
        const started = Date.now();

        page.on('request', (req) => {
          (req as any)._t0 = Date.now();
        });
        page.on('response', (res) => {
          const req = res.request();
          const t0 = (req as any)._t0 || started;
          const duration = Date.now() - t0;
          requests.push({ url: res.url(), duration, status: res.status() });
          if (res.status() >= 400) {
            failed.push({ url: res.url(), status: res.status() });
          }
        });

        await page.goto(`/${site.defaultLocale}${route === '/' ? '' : route}`, {
          waitUntil: 'load',
          timeout: 60_000,
        });
        const loadMs = Date.now() - started;
        await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
        const networkIdleMs = Date.now() - started;

        const durations = requests.map((r) => r.duration).sort((a, b) => a - b);
        const p95 = durations.length
          ? durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))]
          : 0;
        const slow = requests.filter((r) => r.duration >= SLOW_REQUEST_MS);

        // 输出性能数据到测试附件/标准输出，便于报告归档
        console.log(
          `[perf] ${route} load=${loadMs}ms networkIdle=${networkIdleMs}ms ` +
            `requests=${requests.length} p95=${p95}ms slow(>=${SLOW_REQUEST_MS}ms)=${slow.length} failed=${failed.length}`,
        );

        // 只断言硬性阈值：主文档加载不能超过 30s，失败请求单独列出
        expect(loadMs, '页面 load 事件超过 30 秒').toBeLessThan(30_000);
        expect(failed.map((f) => `${f.status} ${f.url}`).join('\n'), '存在 4xx/5xx 失败请求').toBe('');
      });
    }
  });
}
