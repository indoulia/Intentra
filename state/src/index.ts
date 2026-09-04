/**
 * `@agentos/state` — durable work item and run data.
 *
 * Kept separate from `core/` because durable state must be inspectable and restorable
 * independently of the code that writes it. That separation is what makes interruption
 * recovery credible: a run's story can be read with `cat` while AgentOS is not running.
 *
 * Written only by `core/`. Nothing here interprets an event — what an event means is the
 * kernel's, and keeping the split is what makes "recovery is a pure function of the log" a
 * property of one small module rather than a hope about a large one.
 */
export { NdjsonLog, LogError } from './ndjson.js';
export type { AppendResult, ReadResult } from './ndjson.js';
export { StateLayout, RUN_SUBDIRECTORIES, assertSafeId } from './layout.js';
export type { RunSubdirectory } from './layout.js';
export { RunStore, StoreError } from './store.js';
export type { LeaseInfo, LeaseOutcome } from './store.js';
