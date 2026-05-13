// ESLint v9 flat config, applies to all packages in the monorepo.
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      'packages/backend/db/migrations/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      // Project-wide pragmatic defaults; tighten as the codebase grows.
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],
      'no-console': 'off',
    },
  },
  // React-specific rules only for tsx/jsx
  {
    files: ['**/*.{tsx,jsx}'],
    plugins: {
      react,
      'react-hooks': reactHooks,
    },
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react/jsx-uses-react': 'off', // not needed for the React 17+ JSX transform
      'react/react-in-jsx-scope': 'off',
    },
    settings: {
      react: { version: 'detect' },
    },
  },
  // Cross-package boundary enforcement (P-X-01 in plan.md):
  // backend cannot import from frontend, and vice versa.
  {
    files: ['packages/backend/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@agent-workflow/frontend', '@agent-workflow/frontend/*'], message: 'backend must not import from frontend' },
            { group: ['react', 'react-dom', '@xyflow/*', 'vite', 'vite/*'], message: 'no UI deps in backend' },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/frontend/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@agent-workflow/backend', '@agent-workflow/backend/*'], message: 'frontend must not import from backend' },
            { group: ['hono', 'drizzle-orm', 'bun:sqlite', 'bun:test'], message: 'no backend-only deps in frontend' },
          ],
        },
      ],
    },
  },
)
