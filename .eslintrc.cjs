module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  rules: {
    // Relax rules for practical development
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-require-imports': 'off',
    '@typescript-eslint/ban-types': 'warn',
    'no-console': 'off',
    'no-empty': 'warn',
    'prefer-const': 'warn',
  },
  ignorePatterns: [
    'node_modules/',
    'dist/',
    'coverage/',
    '*.js',
    '*.cjs',
    '*.mjs',
  ],
  overrides: [
    {
      // React/UI specific rules
      files: ['packages/ui/**/*.ts', 'packages/ui/**/*.tsx'],
      env: {
        browser: true,
      },
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
      settings: {
        react: {
          version: 'detect',
        },
      },
    },
    {
      // Test files - relaxed rules
      files: ['**/__tests__/**/*', '**/*.test.ts', '**/*.spec.ts'],
      env: {
        jest: true,
      },
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-unused-vars': 'off',
        '@typescript-eslint/ban-types': 'off',
        '@typescript-eslint/no-var-requires': 'off',
        '@typescript-eslint/no-require-imports': 'off',
        'no-empty': 'off',
      },
    },
  ],
};
