import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import vue from 'eslint-plugin-vue'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default [
  {
    ignores: [
      'dist/**',
      'dist-electron/**',
      'dist-headless/**',
      'node_modules/**',
      'playwright-report/**',
      'release/**',
      'test-results/**',
    ],
  },
  {
    files: ['electron/**/*.ts'],
    ignores: [
      '**/*.test.ts',
      '**/*test-support.ts',
      '**/*-fixtures.ts',
      'electron/runtime/create-agent-runtime.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='SessionManager']",
          message:
            'Production code must create SessionManager through createAgentRuntime().',
        },
      ],
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs['flat/recommended'],
  {
    files: ['src/**/*.vue'],
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        parser: tseslint.parser,
      },
    },
    rules: {
      'vue/multi-word-component-names': 'off',
    },
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    files: [
      'electron/**/*.ts',
      'shared/**/*.ts',
      'e2e/**/*.ts',
      '*.config.ts',
      'vite.config.ts',
    ],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: [
      'electron/runtime/agent-runtime.ts',
      'electron/runtime/create-agent-runtime.ts',
      'electron/runtime/runtime-event*.ts',
      'electron/headless/**/*.ts',
      'electron/session/**/*.ts',
      'electron/tools/**/*.ts',
      'electron/providers/**/*.ts',
      'electron/mcp/**/*.ts',
      'electron/skills/**/*.ts',
      'electron/logging/**/*.ts',
      'electron/process/**/*.ts',
      'electron/safety/**/*.ts',
      'electron/project/**/*.ts',
      'electron/code-intelligence/**/*.ts',
      'electron/config/secret-store.ts',
    ],
    ignores: ['**/*.test.ts', '**/*test-support.ts', '**/*-fixtures.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message:
                'Agent Runtime code must depend on host adapters instead of Electron values.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['scripts/**/*.cjs'],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  prettier,
]
