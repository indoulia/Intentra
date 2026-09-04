import tseslint from 'typescript-eslint';

/**
 * Lint configuration.
 *
 * The rules that earn their place here are the ones that catch a class of defect the type
 * checker does not: an unhandled union member, a floating promise, a comparison that will
 * always be true. Style is left to the formatter and to the surrounding code.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'contracts/src/generated/**',
      '.dependency-cruiser.cjs',
    ],
  },
  /* Build-time scripts under tools/ are plain ESM JavaScript and are outside the TypeScript
   * projects, so the type-aware rules cannot apply to them. They get the untyped
   * recommended set instead of being skipped. */
  {
    files: ['tools/**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['**/*.ts'],
    extends: tseslint.configs.strictTypeChecked,
    languageOptions: {
      parserOptions: {
        project: [
          './contracts/tsconfig.json',
          './policies/tsconfig.json',
          './registries/tsconfig.json',
          './state/tsconfig.json',
          './adapters/tsconfig.json',
          './discovery/tsconfig.json',
          './agents/tsconfig.json',
          './core/tsconfig.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      /*
       * An unhandled union member in the envelope-status switch is the failure the
       * discriminated-union design exists to prevent, so it is an error.
       *
       * A `default` clause counts as covering the rest. The switches that must be exhaustive
       * — envelope status to kernel action, gate classification — end in `assertNever`, which
       * makes the compiler enforce it and does so at build time rather than at lint time. The
       * ones with a `default` are renderers that narrate a handful of event kinds and fall
       * back to generic text for the rest, and listing thirty kinds to say "generic text"
       * would obscure the few that are special.
       */
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: true },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': 'off',
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
      'no-param-reassign': 'error',

      /* Relaxations, each with a reason. */
      // Template literals over ids and enum values are safe and are how messages are built.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
      /* A parse or lookup helper that projects untyped JSON into a declared type uses its
       * type parameter only in the return position, and that is the point of it: the
       * alternative is a cast at every call site, which moves the assertion somewhere less
       * visible rather than removing it. */
      '@typescript-eslint/no-unnecessary-type-parameters': 'off',
      // The validator and the replayer walk `unknown` by design; narrowing is explicit there.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
  {
    /* Tests assert on shapes deliberately built wrong, so the type-level rules that would
     * forbid constructing them are relaxed here and only here. */
    files: ['**/test/**/*.ts'],
    rules: {
      /* `node:test`'s test() and describe() return promises nobody awaits by design; the
       * runner owns their lifecycle. */
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      /* A test double implements an async port with a synchronous fixture. The `async` is
       * required by the interface, not by the body, and rewriting each one as an explicit
       * `Promise.resolve` would make the doubles harder to read than the ports they stand in
       * for. */
      '@typescript-eslint/require-await': 'off',
      /* `assert.throws(() => log.append(x))` returns void from a shorthand arrow, which is
       * exactly how the assertion helpers are meant to be called. */
      '@typescript-eslint/no-confusing-void-expression': 'off',
    },
  },
);
