import eslint from '@eslint/js';
import globals from 'globals';
import vue from 'eslint-plugin-vue';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '.codex-design/**',
      '.agents/**',
      'openspec/**',
      'docs/**',
      'tooling/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs['flat/recommended'],
  {
    files: ['**/*.{config,conf}.{js,mjs,cjs,ts}', '**/*.config.{js,mjs,cjs,ts}'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['src/**/*.{ts,tsx,vue}', 'tests/**/*.{ts,tsx,vue}', 'e2e/**/*.ts'],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { parser: tseslint.parser },
    },
  },
);
