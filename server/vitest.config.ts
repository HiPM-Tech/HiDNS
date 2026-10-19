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
    // 以下文件用 node:test 编写，被 vitest 按 *.test.ts 收集后只会报 "No test suite found"，
    // 导致 `pnpm test` 恒为非 0、真实回归淹没在噪声里。排除以恢复门禁信号；
    // 迁移到 vitest 后请逐条删除。
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'tests/db-migration.test.ts',
      'tests/proxy-config.test.ts',
      'tests/ns-monitor.test.ts',
      'tests/domain-filter.test.ts',
      'src/utils/domain-edge-cases.test.ts',
      'src/utils/domain.test.ts',
      'src/utils/http.test.ts',
      'src/utils/roles.test.ts',
      'src/utils/response.test.ts',
      'src/lib/dns/providerAlias.test.ts',
      'src/service/token.test.ts',
      'src/db/bal/business-adapter.test.ts',
    ],
  },
  resolve: {
    alias: {
      '@': './src',
    },
  },
});
