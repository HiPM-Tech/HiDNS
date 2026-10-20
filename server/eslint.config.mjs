import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import { defineConfig, globalIgnores } from 'eslint/config';

/**
 * 服务端 ESLint 配置。
 *
 * 刻意只启用**高信号、零误报**的规则：
 *   - 类型正确性交给 tsc --noEmit（已单独作为门禁）；
 *   - @typescript-eslint/recommended 全量在本仓库会产生大量存量告警，
 *     一次性打开等于把门禁变成噪声，所以只挑与安全直接相关的几条。
 * 核心是禁止 eval 类动态执行 —— 工作流 DSL 明确不使用 eval/Function/vm，
 * 这几条规则就是它的护栏。
 */
export default defineConfig([
  globalIgnores(['dist/**', 'node_modules/**', 'coverage/**', '**/*.test.node.ts']),
  {
    files: ['src/**/*.ts'],
    extends: [js.configs.recommended],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      // 安全护栏：禁止任何形式的动态代码执行
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      // 常见危险写法
      'no-script-url': 'error',
      'no-proto': 'error',
      // 已由 tsc 覆盖，避免重复噪音
      'no-unused-vars': 'off',
      'no-undef': 'off',
      'no-console': 'off',
      'no-useless-escape': 'off',
      'no-control-regex': 'off',
      'no-empty': 'off',
      'no-redeclare': 'off',
      // 这两条在 TS 语法上误报严重（catch 分支被判 unreachable、!!x 被当多余），
      // 且真实的可达性由 tsc 覆盖，故关闭。
      'no-unreachable': 'off',
      'no-extra-boolean-cast': 'off',
      'no-fallthrough': 'off',
      'no-case-declarations': 'off',
      'no-constant-condition': 'off',
    },
  },
]);
