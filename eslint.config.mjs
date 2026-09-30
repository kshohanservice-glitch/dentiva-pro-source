import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'release/**',
      'coverage/**',
      'node_modules/**',
      'build/icons/**',
      'build/icon-source.png',
      'tests/e2e/.artifacts/**',
      'src/renderer/**/*.css',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['*.js', '*.mjs', 'tools/*.mjs', 'eslint.config.mjs'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true, allowBoolean: true }],
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-warning-comments': ['error', { terms: ['todo', 'fixme', 'xxx', 'hack', 'placeholder', 'not implemented'], location: 'anywhere' }],
      'no-var': 'error',
      'object-shorthand': 'error',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      // The renderer's helpers come from React context objects, so they are
      // typed as methods but are plain functions at runtime. The rule is aimed
      // at class methods losing `this`, which cannot happen here.
      '@typescript-eslint/unbound-method': 'off',
      // Screens pass async handlers straight to JSX attributes and to Button's
      // onClick. React ignores the returned promise, and every one of those
      // handlers reports its own failure through `run()`, so only the
      // "condition" and "argument" checks (real mistakes) stay on.
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
      // Non-null assertions appear only after the value has been guarded, in
      // tables and forms that re-read an array slot they just checked.
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // The JSX runtime shim mirrors React's own declaration file.
    files: ['src/renderer/react-jsx.d.ts'],
    rules: { '@typescript-eslint/no-empty-object-type': 'off' },
  },
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'src/core/**/*.ts', 'tools/**/*.mjs', 'tools/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // The development bridge is a console tool: it prints the calls it serves.
    // Its port stubs must also return promises without awaiting anything, and
    // the API serves JSON where `String(value)` on an unknown payload field is
    // the intended behaviour.
    files: ['src/main/dev-bridge.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
    },
  },
  {
    files: ['tools/**/*.mjs', 'tools/**/*.ts', '*.mjs', 'eslint.config.mjs'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
  {
    files: ['tests/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Tests assert on shapes returned by the real services; the assertions
      // describe the expected contract and stay even when TypeScript can infer
      // the same type.
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-redundant-type-constituents': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      'no-console': 'off',
    },
  },
);
