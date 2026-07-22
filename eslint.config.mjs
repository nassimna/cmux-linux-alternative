import eslint from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/out/**',
      '**/release/**',
      '**/target/**',
      'packages/protocol-client/src/generated/**'
    ]
  },
  eslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        project: [
          './apps/desktop/tsconfig.node.json',
          './apps/desktop/tsconfig.web.json',
          './packages/protocol-client/tsconfig.json'
        ],
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error'
    }
  },
  {
    files: [
      '**/*.config.{js,mjs,ts}',
      'apps/desktop/src/main/**/*.ts',
      'apps/desktop/src/preload/**/*.ts'
    ],
    languageOptions: {
      globals: globals.node
    }
  }
)
