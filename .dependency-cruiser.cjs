/**
 * The dependency rule, enforced.
 *
 * Package manifests already state most of it — `@agentos/agents` cannot import
 * `@agentos/core` because it does not declare it. These rules cover what a manifest cannot
 * express: `contracts -> anything`, and `core -> agents` anywhere but the composition root.
 *
 * KERNEL_BOUNDARY section 2 is the source. A change that breaks one of these is a change to
 * the architecture, not a change to the code.
 */
module.exports = {
  forbidden: [
    {
      name: 'contracts-depends-on-nothing',
      comment:
        'contracts/ is the shared vocabulary. A contract that imports a kernel type has '
        + 'coupled the two sides together permanently. Node builtins are permitted: they are '
        + 'not dependencies the manifest would declare.',
      severity: 'error',
      from: { path: '^contracts/src' },
      to: {
        pathNot: '^contracts/src',
        dependencyTypesNot: ['core'],
      },
    },
    {
      name: 'agents-never-reach-the-kernel',
      comment:
        'Dependency rule 1. An agent that can reach into core/ can bypass every guarantee '
        + 'in KERNEL_BOUNDARY. The practical test is the delete-core test.',
      severity: 'error',
      from: { path: '^agents/src' },
      to: { path: '^core/' },
    },
    {
      name: 'agents-never-write-state',
      comment:
        'Dependency rule 6. Agents produce envelopes; the kernel persists them. An agent '
        + 'that can write run state can rewrite history.',
      severity: 'error',
      from: { path: '^(agents|discovery|adapters|registries|policies)/src' },
      to: { path: '^state/src' },
    },
    {
      name: 'kernel-reaches-agents-only-through-composition',
      comment:
        'The kernel depends on agents through one interface: dispatch a typed input, receive '
        + 'a typed envelope. core/src/composition is where that interface is wired, and it is '
        + 'the only file permitted to name the agents or discovery packages.',
      severity: 'error',
      from: { path: '^core/src', pathNot: '^core/src/composition' },
      to: { path: '^(agents|discovery)/(src|dist)' },
    },
    {
      name: 'policies-and-registries-depend-only-on-contracts',
      comment: 'Their manifests say so; this catches a deep relative import that bypasses them.',
      severity: 'error',
      from: { path: '^(policies|registries|state)/src' },
      to: { path: '^(core|agents|adapters|discovery)/(src|dist)' },
    },
    {
      name: 'adapters-do-not-reach-the-kernel',
      comment:
        'Adapters are the enforcement point, not part of the kernel. Violations they detect '
        + 'are logged by core/, which means core/ calls them and never the reverse.',
      severity: 'error',
      from: { path: '^adapters/src' },
      to: { path: '^(core|agents|discovery|state)/(src|dist)' },
    },
    {
      name: 'discovery-reaches-the-world-only-through-adapters',
      comment:
        'Dependency rule 5. Probes observe; they do not open files or run commands '
        + 'themselves. node:fs and node:child_process belong in adapters/.',
      severity: 'error',
      from: { path: '^discovery/src' },
      to: { path: '^node:(fs|fs/promises|child_process|http|https|net|dgram)$' },
    },
    {
      name: 'agents-reach-the-world-only-through-adapters',
      comment: 'Same rule, applied to the place it matters most.',
      severity: 'error',
      from: { path: '^agents/src', pathNot: '^agents/src/substrate' },
      to: { path: '^node:(fs|fs/promises|child_process|http|https|net|dgram)$' },
    },
    {
      name: 'no-circular',
      comment: 'A cycle means two components have one reason to change between them.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      comment:
        'An unreachable module is code nothing exercises. Index and generated files are '
        + 'entry points rather than orphans.',
      severity: 'warn',
      from: {
        orphan: true,
        pathNot: [
          '(^|/)index\\.ts$',
          '(^|/)generated/',
          '\\.d\\.ts$',
          '(^|/)test/',
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|node_modules)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
