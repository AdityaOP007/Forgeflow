import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.pnpm-store/**',
      '**/templates/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettierConfig,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
      },
    },
  },
  {
    files: ['apps/api/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['*fake-github-client*', '*fake-k8s-runner*', '**/test/**'],
              message:
                'Production code must not import test utilities, FakeGitHubClient, or FakeK8sRunner.',
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      'apps/api/src/app.ts',
      'apps/api/src/index.ts',
      'apps/api/src/modules/**/*.ts',
      'apps/api/src/routes/**/*.ts',
      'apps/api/src/middleware/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['*fake-github-client*', '*fake-k8s-runner*', '**/test/**'],
              message:
                'Production code must not import test utilities, FakeGitHubClient, or FakeK8sRunner.',
            },
            {
              group: ['*k8s/exec*', '**/k8s/exec*'],
              message:
                'API process must never run kubectl/helm or read the worker kubeconfig (worker only).',
            },
          ],
        },
      ],
    },
  }
);
