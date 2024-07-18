module.exports = {
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: 'tsconfig.json',
    sourceType: 'module',
    tsconfigRootDir: __dirname,
  },
  plugins: ['@typescript-eslint', 'eslint-plugin-import'],
  rules: {
    '@typescript-eslint/no-floating-promises': 'error',
    'import/extensions': ['error', 'always', { ts: 'never' }],
  },
  root: true,
};
