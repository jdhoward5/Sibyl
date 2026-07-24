module.exports = {
  root: true,
  env: {
    es2022: true
  },
  ignorePatterns: [
    'node_modules/',
    'out/',
    'release/',
    'coverage/',
    'llama/',
    '*.tsbuildinfo'
  ],
  overrides: [
    {
      files: ['**/*.ts', '**/*.tsx'],
      parser: '@typescript-eslint/parser',
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module'
      },
      plugins: ['@typescript-eslint', 'react-hooks'],
      extends: [
        'eslint:recommended',
        'plugin:@typescript-eslint/recommended',
        'plugin:react-hooks/recommended'
      ],
      rules: {
        // TypeScript performs the authoritative unused-symbol check for both
        // projects, with type information the syntax-only ESLint rule cannot see.
        '@typescript-eslint/no-unused-vars': 'off'
      }
    },
    {
      files: ['src/renderer/**/*.ts', 'src/renderer/**/*.tsx', 'src/shared/**/*.ts'],
      env: {
        browser: true
      }
    },
    {
      files: [
        'src/main/**/*.ts',
        'src/preload/**/*.ts',
        'electron.vite.config.ts',
        '**/*.js',
        '**/*.mjs',
        '**/*.cjs'
      ],
      env: {
        node: true
      }
    },
    {
      files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module'
      },
      extends: ['eslint:recommended']
    },
    {
      // Playwright's page/app evaluate callbacks in this Node script execute in
      // a browser renderer and legitimately reference its global `window`.
      files: ['scripts/ui-e2e.mjs'],
      env: {
        browser: true
      }
    }
  ]
}
