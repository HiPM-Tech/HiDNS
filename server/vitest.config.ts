import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'lcov'],
      exclude: [
        'node_modules/',
        'dist/',
        'tests/',
        'scripts/',
        '**/*.d.ts',
        '**/*.config.ts',
      ],
    },
    testTimeout: 30000,
    hookTimeout: 30000,
    // node:test 写的用例统一命名为 *.test.node.ts，由 `pnpm run test:node` 用 tsx 跑，
    // 不再被 vitest 收集（vitest 默认只认 *.test.ts / *.spec.ts）。
    //
    // 历史上的 4 个腐化集成用例（tests/{db-migration,proxy-config,ns-monitor,domain-filter}）
    // 已于 2026-10-23 删除：它们引用重构前已删除的模块（src/db/init-dsm、/src/db/business-adapter），
    // 且 fixture 与旧 schema 绑定（users.password 已改名 password_hash），在 DSM 接管建表后无法直接运行。
    // 替代覆盖：tests/db-bootstrap.test.ts（新库能建表 + 关键列断言）与 src/utils/domain-classify.test.ts（顶域/子域分类）。
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.test.node.ts',
      // 审核员/临时探针目录：不进入门禁（避免外部脚本把主测试结果染红）
      '**/__probe__/**',
    ],
  },
  resolve: {
    alias: {
      '@': './src',
    },
  },
});
