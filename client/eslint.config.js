import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
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
      '@typescript-eslint/no-unused-vars': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      // 以下为已知存量（各 1~5 处），单独排期清理；先降为 warn 让门禁可用。
      // react-refresh/only-export-components：context 文件同时导出 hook 是正常写法。
      // no-control-regex：RecordForm 里对控制字符的校验是有意的。
      'react-refresh/only-export-components': 'warn',
      'no-control-regex': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
    },
  },
])
