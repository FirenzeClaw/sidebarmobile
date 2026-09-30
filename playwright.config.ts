// sidebarmobile — Playwright 配置（测试）
// 2026-09-29 | Kimi(speckit-implement) | 初始版本：Chromium 持久化上下文加载未打包扩展

import { defineConfig } from '@playwright/test';

/**
 * [DONE] 端到端测试配置。
 *
 * 说明：扩展不能在无头模式下可靠加载，故 e2e 使用有头 Chromium + 持久化上下文
 * （见 tests/e2e/fixtures.ts 的 launchPersistentContext）。开发机为 Windows，
 * 如需无人值守可改 headless: 'chromium' 并接受扩展加载限制。
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node --experimental-strip-types scripts/fixture-server.ts',
    url: 'http://127.0.0.1:8919/health',
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
