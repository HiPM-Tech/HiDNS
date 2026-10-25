import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'coverage']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // 以下三条在本仓库有数百处存量，一次性清零不现实；降为 warn 后
      // `eslint .` 的退出码只反映**其余**规则，门禁才有意义（此前 CI 对 client
      // 的 lint 一直用 `|| true` 兜住，等于完全没跑）。
      // 新代码仍会在输出里看到这些告警，存量按文件逐步清理。
      '@typescript-eslint/no-explicit-any': 'warn',
      // 重构后已无告警，收紧为 error：新代码引入未使用变量即失败
      '@typescript-eslint/no-unused-vars': 'error',
      // 已清零：同步 setState 的 effect 一律可以改成派生状态或 key 重挂载，
      // 收紧为 error 防止回潮（新增即失败）。
      'react-hooks/set-state-in-effect': 'error',
      // Provider 与其配套 hook / 纯函数常量同文件导出是刻意设计（避免循环依赖），
      // 用 allowExportNames 精确放行，而不是整条规则关掉。
      'react-refresh/only-export-components': ['warn', {
        allowExportNames: [
          'useThemeMode', 'ThemeProvider',
          'RealtimeProvider', 'useRealtimeStatus', 'EVENT_QUERY_MAP',
          'resolveReturnTo', 'parseBatchLine', 'resolveTheme', 'applyTheme',
        ],
      }],
      'no-control-regex': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
    },
  },
  {
    // 设计系统原语（shadcn 风格）：同一文件既导出组件又导出 variants 与 cn 工具，
    // fast-refresh 在该目录属误报，按目录豁免而不是逐行 disable。
    // 必须放在最后：ESLint 平铺配置按顺序合并，后者的 rules 覆盖前者。
    files: ['src/ui/**/*.tsx', 'src/ui/**/*.ts'],
    rules: { 'react-refresh/only-export-components': 'off' },
  },
  {
    // 唯一豁免：这里是有意匹配控制字符（清洗用户输入的记录值），不是笔误。
    files: ['src/types/record-types.ts'],
    rules: { 'no-control-regex': 'off' },
  },
])
