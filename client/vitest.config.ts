import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // 默认 5s 对含完整渲染 + 用户交互的用例偏紧：CI 冷启动时偶发超时（第四轮评审实测一红一绿），
    // 放宽到 15s；真正的性能问题由 build 体积与手动性能检查兜底。
    testTimeout: 15000,
    hookTimeout: 15000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // 只统计业务代码；排除测试、类型与壳层入口
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/**/__tests__/**',
        'src/test/**',
        'src/types/**',
        'src/main.tsx',
      ],
    },
  },
});
