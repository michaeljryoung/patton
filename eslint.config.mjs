import eslint from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import importPlugin from 'eslint-plugin-import';
import globals from 'globals';

export default [
  eslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2021,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs['eslint-recommended'].overrides[0].rules,
      ...tsPlugin.configs['recommended'].rules,
    },
  },
  importPlugin.flatConfigs.recommended,
  importPlugin.flatConfigs.electron,
  importPlugin.flatConfigs.typescript,
  {
    // Forge 8 and Vite 8 ship ESM-only packages whose entry is only in package.json
    // "exports", which eslint-plugin-import's node resolver can't read, so every import
    // of them reported as unresolved (S46; lint had failed since the Forge 8 upgrade).
    // Forge itself loads these files on every build, so a truly broken import still
    // fails the verifier there. The rule stays on everywhere else.
    files: ['forge.config.ts', 'vite.*.config.ts'],
    rules: { 'import/no-unresolved': 'off' },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.node } },
  },
  {
    // Hidden-Electron checks: Node on the outside, a page function serialized into the window.
    files: ['scripts/**/*.cjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'commonjs', globals: { ...globals.node, ...globals.browser } },
  },
  {
    ignores: ['node_modules/', 'dist/', '.vite/', 'out/', '.worktrees/', 'eslint.config.mjs'],
  },
];
