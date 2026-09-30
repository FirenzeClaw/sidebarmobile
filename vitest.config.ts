// sidebarmobile — Vitest 配置（测试）
// 2026-09-29 | Kimi(speckit-implement) | 初始版本：单测与集成测试共用，浏览器 API 走 mock

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    // 端到端场景由 Playwright 覆盖（tests/e2e），不在 Vitest 内重复运行
    exclude: ['node_modules', 'dist', 'tests/e2e'],
  },
});
