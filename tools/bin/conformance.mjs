#!/usr/bin/env node
/**
 * The architecture conformance check.
 *
 * The plan's final gate ends with a conformance check against the frozen documents, and the
 * point of putting it in code is that "we read the documents" is not a check. Everything
 * here is a property of the repository that a frozen document states and that could
 * plausibly drift: the directory set, the dependency table, where I/O is permitted, who
 * writes to `state/`, and whether any production code is unfinished.
 *
 * Each check names the document and section it enforces. A failure is an architecture
 * violation, not a lint finding.
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const failures = [];
const passes = [];

function check(name, source, fn) {
  let detail;
  try {
    detail = fn();
  } catch (error) {
    failures.push({ name, source, detail: error instanceof Error ? error.message : String(error) });
    return;
  }
  if (detail === true || detail === undefined) passes.push({ name, source });
  else failures.push({ name, source, detail: String(detail) });
}

function sourceFiles(pkg) {
  const dir = join(ROOT, pkg, 'src');
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.ts')) out.push(full);
    }
  };
  walk(dir);
  return out;
}

function readAll(pkg) {
  return sourceFiles(pkg).map((f) => [relative(ROOT, f).replace(/\\/g, '/'), readFileSync(f, 'utf8')]);
}

const PACKAGES = [
  'contracts', 'policies', 'registries', 'state',
  'adapters', 'discovery', 'agents', 'core',
];

/* ------------------------------------------------------- the nine directories stand ---- */

check(
  'nine directories, and no tenth',
  'AGENTOS_ARCHITECTURE section 8',
  () => {
    const expected = new Set([...PACKAGES, 'docs', 'tools']);
    const actual = readdirSync(ROOT).filter((entry) => {
      if (entry.startsWith('.')) return false;
      if (!statSync(join(ROOT, entry)).isDirectory()) return false;
      return entry !== 'node_modules';
    });
    const unexpected = actual.filter((d) => !expected.has(d));
    if (unexpected.length > 0) {
      return `unexpected top-level directories: ${unexpected.join(', ')}. `
        + 'A new component belongs in one of the nine, or the architecture changed.';
    }
    const missing = [...expected].filter((d) => !actual.includes(d));
    if (missing.length > 0) return `missing directories: ${missing.join(', ')}`;
    return true;
  },
);

/* ------------------------------------------------------------- the dependency table ---- */

const DEPENDENCY_TABLE = {
  contracts: [],
  policies: ['contracts'],
  registries: ['contracts'],
  state: ['contracts'],
  adapters: ['contracts', 'policies'],
  discovery: ['contracts', 'adapters'],
  agents: ['contracts', 'policies', 'registries', 'adapters', 'discovery'],
  /* core reaches agents and discovery through the composition root only; dependency-cruiser
   * enforces that narrowing, and the manifest has to declare them for it to resolve. */
  core: ['contracts', 'policies', 'registries', 'adapters', 'state', 'agents', 'discovery'],
};

check(
  'every manifest declares exactly its permitted dependencies',
  'IMPLEMENTATION_PLAN section 3, KERNEL_BOUNDARY section 2',
  () => {
    const problems = [];
    for (const [pkg, allowed] of Object.entries(DEPENDENCY_TABLE)) {
      const manifestPath = join(ROOT, pkg, 'package.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const declared = Object.keys(manifest.dependencies ?? {})
        .map((d) => d.replace('@agentos/', ''))
        .sort();
      const want = [...allowed].sort();
      if (declared.join(',') !== want.join(',')) {
        problems.push(`${pkg}: declares [${declared.join(', ')}], table says [${want.join(', ')}]`);
      }
    }
    return problems.length === 0 ? true : problems.join('; ');
  },
);

check(
  'contracts declares no dependencies at all',
  'IMPLEMENTATION_PLAN section 2, KERNEL_BOUNDARY dependency rule 4',
  () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'contracts', 'package.json'), 'utf8'));
    const deps = Object.keys(manifest.dependencies ?? {});
    const devDeps = Object.keys(manifest.devDependencies ?? {});
    if (deps.length > 0) return `contracts declares dependencies: ${deps.join(', ')}`;
    if (devDeps.length > 0) return `contracts declares devDependencies: ${devDeps.join(', ')}`;
    return true;
  },
);

check(
  'no package declares @agentos/core except none',
  'KERNEL_BOUNDARY dependency rule 1',
  () => {
    const offenders = [];
    for (const pkg of PACKAGES) {
      const manifestPath = join(ROOT, pkg, 'package.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if ('@agentos/core' in (manifest.dependencies ?? {})) offenders.push(pkg);
    }
    return offenders.length === 0 ? true : `${offenders.join(', ')} declare @agentos/core`;
  },
);

/* --------------------------------------------------- all outside access via adapters ---- */

const IO_MODULES = /from '(node:fs|node:fs\/promises|node:child_process|node:http|node:https|node:net|node:dgram)'/;

/*
 * The exceptions, each named with the decision that permits it. A file not on this list that
 * imports an I/O module is a boundary violation; the list itself is short on purpose, because
 * "all outside-world access goes through adapters" is only true if the exceptions are
 * countable.
 */
const IO_EXCEPTIONS = new Map([
  ['policies/src/data-source.ts',
    "decision I-11: the policy loader reads AgentOS's own installation at startup, and "
    + 'routing it through the adapters would be circular because path confinement reads '
    + 'paths.json. Confined to the policy data root, and it is one file.'],
  ['agents/src/substrate/claude-agent-sdk.ts',
    "decision D-2: the substrate is the transport to the agent execution host, and D-2's "
    + 'reversal clause wants swapping it to be a one-file change.'],
]);

check(
  'only adapters/, state/ and the named exceptions reach the filesystem, a process or the network',
  'KERNEL_BOUNDARY dependency rule 5',
  () => {
    const offenders = [];
    for (const pkg of PACKAGES) {
      /* adapters/ is the enforcement point and does I/O by definition. state/ is the durable
       * run store, which the kernel is the only writer to and which is files by decision D-3. */
      if (pkg === 'adapters' || pkg === 'state') continue;
      for (const [file, text] of readAll(pkg)) {
        if (IO_EXCEPTIONS.has(file)) continue;
        if (IO_MODULES.test(text)) offenders.push(file);
      }
    }
    return offenders.length === 0
      ? true
      : `these files import an I/O module directly and are not a named exception: ${offenders.join(', ')}`;
  },
);

check(
  'every named I/O exception still exists and still needs to be one',
  'IMPLEMENTATION_DECISIONS I-11, ARCHITECTURE_FREEZE D-2',
  () => {
    const stale = [];
    for (const [file] of IO_EXCEPTIONS) {
      const pkg = file.split('/')[0];
      const sources = readAll(pkg);
      /* A package with no source yet cannot have a stale exception. The exception is
       * declared ahead of the file it names so that the file lands into a check rather
       * than past one. */
      if (sources.length === 0) continue;
      const found = sources.find(([name]) => name === file);
      if (found === undefined) {
        stale.push(`${file} does not exist, so its exception should be removed`);
      } else if (!IO_MODULES.test(found[1])) {
        stale.push(`${file} does not do I/O, so its exception should be removed`);
      }
    }
    return stale.length === 0 ? true : stale.join('; ');
  },
);

check(
  'contracts does no I/O at all: the schemas are embedded',
  'IMPLEMENTATION_PLAN section 2',
  () => {
    const offenders = readAll('contracts')
      .filter(([, text]) => /from 'node:(fs|child_process|http|https|net)/.test(text))
      .map(([file]) => file);
    return offenders.length === 0 ? true : offenders.join(', ');
  },
);

/* -------------------------------------------------------- the kernel has no model in it -- */

check(
  'the kernel contains no prompt and no model call',
  'KERNEL_BOUNDARY section 3, SKILL_AND_MODEL_SELECTION "No model at all"',
  () => {
    const offenders = [];
    for (const [file, text] of readAll('core')) {
      if (/@anthropic-ai\//.test(text)) offenders.push(`${file} (imports a model SDK)`);
      if (/\bsystemPrompt\b|\bYou are an?\b/.test(text)) offenders.push(`${file} (contains a prompt)`);
    }
    return offenders.length === 0 ? true : offenders.join('; ');
  },
);

check(
  'no threshold is hard-coded in the kernel',
  'KERNEL_BOUNDARY section 6',
  () => {
    /* Numeric literals appear legitimately as array indices, string lengths and slice
     * bounds. What must not appear is a policy value: a loop cap, a sample rate, a
     * freshness window or a cost ceiling. Those are named, so the names are what to look
     * for outside policies/. */
    const forbidden = /\b(rework|review|architecture|discovery)_?cap\s*=\s*\d|sampleRate\s*=\s*0\.|freshnessMs\s*=\s*\d|costCeiling\s*=\s*\d/;
    const offenders = readAll('core')
      .filter(([, text]) => forbidden.test(text))
      .map(([file]) => file);
    return offenders.length === 0
      ? true
      : `${offenders.join(', ')} appear to hard-code a policy threshold`;
  },
);

/* ------------------------------------------------------------------ unfinished work ---- */

check(
  'no unfinished production functionality',
  'IMPLEMENTATION_PLAN "Code quality"',
  () => {
    /*
     * The markers the plan asks to be searched for. Test files and fixtures are exempt: a
     * fixture called `stub` is a legitimate test double, and a test that names `mock` in a
     * describe block is describing what it tests. Production source is not exempt.
     */
    const markers = /\b(TODO|FIXME|XXX|HACK|NotImplemented|not implemented|unimplemented)\b/i;
    const offenders = [];
    for (const pkg of PACKAGES) {
      for (const [file, text] of readAll(pkg)) {
        if (file.includes('/fixtures')) continue;
        for (const [i, line] of text.split('\n').entries()) {
          if (markers.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim().slice(0, 80)}`);
        }
      }
    }
    return offenders.length === 0 ? true : `\n    ${offenders.join('\n    ')}`;
  },
);

check(
  'no production source throws "not implemented"',
  'IMPLEMENTATION_PLAN "Code quality"',
  () => {
    const offenders = [];
    for (const pkg of PACKAGES) {
      for (const [file, text] of readAll(pkg)) {
        if (/throw new Error\(['"`](?:not implemented|unimplemented|TODO)/i.test(text)) {
          offenders.push(file);
        }
      }
    }
    return offenders.length === 0 ? true : offenders.join(', ');
  },
);

/* --------------------------------------------------------------------- policy is data -- */

check(
  'policies/data contains only data',
  'KERNEL_BOUNDARY section 7, IMPLEMENTATION_PLAN WP-2 "must not contain code"',
  () => {
    const dir = join(ROOT, 'policies', 'data');
    if (!existsSync(dir)) return true;
    const bad = [];
    const walk = (d) => {
      for (const entry of readdirSync(d)) {
        const full = join(d, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (!/\.(json|md)$/.test(entry)) bad.push(relative(ROOT, full).replace(/\\/g, '/'));
      }
    };
    walk(dir);
    return bad.length === 0 ? true : `non-data files under policies/data: ${bad.join(', ')}`;
  },
);

/* ------------------------------------------------------------- principle 17: agnostic -- */

check(
  'no product-specific identifier is compiled into AgentOS',
  'AGENTOS_PRINCIPLES 17',
  () => {
    /*
     * "Any product-specific identifier appearing in AgentOS code or policy is a bug."
     * The names below are the ones the frozen documents use as *examples* of a target
     * repository, which makes them exactly the ones most likely to be copied into code.
     */
    const names = /\b(marksy|BSESN|bsesn)\b/;
    const offenders = [];
    for (const pkg of PACKAGES) {
      for (const [file, text] of readAll(pkg)) {
        if (names.test(text)) offenders.push(file);
      }
    }
    const policyDir = join(ROOT, 'policies', 'data');
    if (existsSync(policyDir)) {
      const walk = (d) => {
        for (const entry of readdirSync(d)) {
          const full = join(d, entry);
          if (statSync(full).isDirectory()) walk(full);
          else if (names.test(readFileSync(full, 'utf8'))) {
            offenders.push(relative(ROOT, full).replace(/\\/g, '/'));
          }
        }
      };
      walk(policyDir);
    }
    return offenders.length === 0
      ? true
      : `product-specific identifiers appear in: ${offenders.join(', ')}`;
  },
);

/* ------------------------------------------------------------------------- reporting ---- */

const width = 62;
console.log('architecture conformance\n');
for (const { name, source } of passes) {
  console.log(`  PASS  ${name}`);
  console.log(`        ${source}`);
}
for (const { name, source, detail } of failures) {
  console.log(`  FAIL  ${name}`);
  console.log(`        ${source}`);
  console.log(`        ${detail}`);
}
console.log(`\n${'-'.repeat(width)}`);
console.log(`${passes.length} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log('\nA failure here is an architecture violation. Either the code is wrong, or the');
  console.log('frozen document changed and the amendment protocol was not followed.');
  process.exit(1);
}
