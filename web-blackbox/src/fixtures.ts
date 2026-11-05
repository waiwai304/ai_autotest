import { test as base, expect } from '@playwright/test';

/**
 * 增强版 test fixture：
 * - 自动收集控制台错误与失败请求
 * - 用例失败时自动附加「中文诊断附件」：最终URL、页面标题、页面文本摘要、
 *   控制台错误、失败请求，让 HTML 报告一眼看出问题所在
 */
export const test = base.extend<{ attachDiagnostics: void }>({
  attachDiagnostics: [
    async ({ page }, use, testInfo) => {
      const consoleErrors: string[] = [];
      const failedRequests: string[] = [];

      page.on('console', (m) => {
        if (m.type() === 'error') consoleErrors.push(m.text());
      });
      page.on('pageerror', (e) => consoleErrors.push(e.message));
      page.on('response', (r) => {
        if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url()}`);
      });

      await use();

      if (testInfo.status !== testInfo.expectedStatus) {
        const url = page.url();
        const redirectedToWap = /\/wap/i.test(url);

        const conclusion = redirectedToWap
          ? [
              '【结论】浏览器最终停留在 WAP 移动站：' + url,
              '移动端 UA 被站点分流到独立 WAP 应用（hash 路由），',
              '桌面端选择器/文案断言在 WAP 页面上必然失败。',
              '这属于站点双端架构分流，不是页面报错或功能损坏；',
              '如需测试移动端功能，需要为 /wap 站点编写专用用例。',
            ].join('\n')
          : [
              '【结论】浏览器最终停留在：' + url,
              '请对照下方「页面文本摘要」与「控制台错误」定位具体问题。',
            ].join('\n');

        await testInfo.attach('🔍诊断-结论(先看我)', {
          body: conclusion,
          contentType: 'text/plain',
        });
        await testInfo.attach('🔍诊断-最终URL', {
          body: url,
          contentType: 'text/plain',
        });

        let title = '';
        let bodyText = '';
        try {
          title = await page.title();
          bodyText = (await page.locator('body').innerText()).slice(0, 3000);
        } catch {
          /* 页面可能已关闭 */
        }
        await testInfo.attach('🔍诊断-页面标题', {
          body: title || '(无法获取)',
          contentType: 'text/plain',
        });
        await testInfo.attach('🔍诊断-页面文本摘要', {
          body: bodyText || '(页面无文本内容)',
          contentType: 'text/plain',
        });
        if (consoleErrors.length) {
          await testInfo.attach('🔍诊断-控制台错误', {
            body: consoleErrors.join('\n'),
            contentType: 'text/plain',
          });
        }
        if (failedRequests.length) {
          await testInfo.attach('🔍诊断-失败请求(4xx/5xx)', {
            body: failedRequests.join('\n'),
            contentType: 'text/plain',
          });
        }
      }
    },
    { auto: true },
  ],
});

export { expect };
