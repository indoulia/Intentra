# core

Kernel. Intake recording, Work Item admission and lifecycle, workflow admission, run loop,
workflow state machine over a frozen graph, run ledger and event log, arbitration.

Everything here is deterministic and model-free, including the parts that decide what the
work is and which workflow it gets: the kernel validates a resolution proposal and a template
*selection*, never a novel graph, which is what keeps those decisions arithmetic rather than
judgment.

Contains no domain knowledge and no prompts. See ../docs/AGENTOS_ARCHITECTURE.md,
../docs/WORKFLOW_STATE_MACHINE.md and ../docs/INTENT_AND_WORK_ITEM_RESOLUTION.md.

Empty in Phase 0 — design only.
