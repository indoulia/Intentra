/*
 * GENERATED FILE - DO NOT EDIT.
 *
 * The schema documents from contracts/schema/*.json, embedded so that
 * `@agentos/contracts` needs neither a filesystem nor a dependency to validate.
 * Produced by `npm run codegen`.
 */

import type { JsonSchemaObject } from '../validator/types.js';

export const ADAPTER_SCHEMA: JsonSchemaObject = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://agentos.dev/schema/adapter.json",
  "title": "Adapter operation descriptors, call records, mutation events and idempotency",
  "description": "What makes adapters enforceable rather than conventional.",
  "$defs": {
    "operationDescriptor": {
      "description": "REPOSITORY_ADAPTER section 2.3. Fail-closed defaults throughout: an operation whose observation safety cannot be established is observation_safe: false.",
      "type": "object",
      "properties": {
        "adapter": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "op": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "description": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "mutating": {
          "description": "Does it change authoritative state: repository content, VCS refs, an external system, a data store, or AgentOS run state.",
          "type": "boolean"
        },
        "reversal": {
          "description": "The operation that undoes it, or null for non-reversible. A dispatch that performed a reversal: null operation is never automatically retried.",
          "oneOf": [
            {
              "$ref": "#/$defs/reversalSpec"
            },
            {
              "type": "null"
            }
          ]
        },
        "idempotent_by_key": {
          "type": "boolean"
        },
        "identity_args": {
          "description": "The argument names the work-item-scoped idempotency key is computed over. For create_pr that is repository, head and base — not the PR body.",
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/nonEmptyString"
          }
        },
        "external_destination": {
          "type": "boolean"
        },
        "observation_safe": {
          "description": "May the kernel replay this to verify evidence. observation_safe: true implies mutating: false; the converse does not hold.",
          "type": "boolean"
        },
        "incidental_artifacts": {
          "description": "Declared by-products: coverage output, caches, temp files. No mutation event, no reversal, and not a loophole — a by-product something else depends on surviving disqualifies the operation.",
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/pathGlob"
          }
        },
        "args_schema": {
          "description": "JSON Schema for the operation's arguments, used to build the dispatch tool surface.",
          "type": "object"
        },
        "gates": {
          "description": "Gates this operation can fire, in addition to whatever the classifiers detect.",
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/gate"
          }
        }
      },
      "required": [
        "adapter",
        "op",
        "description",
        "mutating",
        "reversal",
        "idempotent_by_key",
        "identity_args",
        "external_destination",
        "observation_safe",
        "incidental_artifacts",
        "args_schema",
        "gates"
      ],
      "additionalProperties": false
    },
    "reversalSpec": {
      "type": "object",
      "properties": {
        "op": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "args_from": {
          "description": "How the reversal's arguments are derived from the mutation event's `before` state.",
          "type": "object"
        }
      },
      "required": [
        "op",
        "args_from"
      ],
      "additionalProperties": false
    },
    "callRecord": {
      "description": "Every adapter call, reads included. This is what makes coverage checkable and screenshot provenance verifiable.",
      "type": "object",
      "properties": {
        "call_id": {
          "$ref": "common.json#/$defs/id"
        },
        "dispatch_id": {
          "type": [
            "string",
            "null"
          ],
          "minLength": 1
        },
        "adapter": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "op": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "args_digest": {
          "type": "string"
        },
        "paths_touched": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "capabilities_touched": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "outcome": {
          "enum": [
            "OK",
            "REFUSED",
            "ERROR",
            "DEDUPLICATED",
            "BLOCKED"
          ]
        },
        "refusal": {
          "oneOf": [
            {
              "enum": [
                "scope_violation",
                "security_violation",
                "grant_missing",
                "ambiguous_state"
              ]
            },
            {
              "type": "null"
            }
          ]
        },
        "aggregated_count": {
          "description": "Reads are logged at a policy-defined granularity. Aggregation is permitted; omission is not.",
          "type": "integer",
          "minimum": 1
        },
        "started_at": {
          "$ref": "common.json#/$defs/timestamp"
        },
        "duration_ms": {
          "type": "integer",
          "minimum": 0
        }
      },
      "required": [
        "call_id",
        "dispatch_id",
        "adapter",
        "op",
        "args_digest",
        "paths_touched",
        "capabilities_touched",
        "outcome",
        "refusal",
        "aggregated_count",
        "started_at",
        "duration_ms"
      ],
      "additionalProperties": false
    },
    "mutationEvent": {
      "description": "Emitted by the adapter at call time, before returning. The reversal record exists the moment the mutation does.",
      "type": "object",
      "properties": {
        "work_item_id": {
          "$ref": "common.json#/$defs/id"
        },
        "run_id": {
          "$ref": "common.json#/$defs/id"
        },
        "dispatch_id": {
          "$ref": "common.json#/$defs/id"
        },
        "adapter": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "op": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "target": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "before": {
          "type": "object"
        },
        "after": {
          "type": "object"
        },
        "reversal": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "op": {
                  "$ref": "common.json#/$defs/nonEmptyString"
                },
                "args": {
                  "type": "object"
                }
              },
              "required": [
                "op",
                "args"
              ],
              "additionalProperties": false
            },
            {
              "type": "null"
            }
          ]
        },
        "at": {
          "$ref": "common.json#/$defs/timestamp"
        }
      },
      "required": [
        "work_item_id",
        "run_id",
        "dispatch_id",
        "adapter",
        "op",
        "target",
        "before",
        "after",
        "reversal",
        "at"
      ],
      "additionalProperties": false
    },
    "idempotencyRecord": {
      "type": "object",
      "properties": {
        "key": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "scope": {
          "enum": [
            "dispatch",
            "work_item"
          ]
        },
        "adapter": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "op": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "result": {},
        "external_locator": {
          "description": "How to re-read the external resource on a key hit. A work-item-scoped hit is verified, never trusted.",
          "oneOf": [
            {
              "$ref": "common.json#/$defs/locator"
            },
            {
              "type": "null"
            }
          ]
        },
        "recorded_at": {
          "$ref": "common.json#/$defs/timestamp"
        }
      },
      "required": [
        "key",
        "scope",
        "adapter",
        "op",
        "result",
        "external_locator",
        "recorded_at"
      ],
      "additionalProperties": false
    },
    "classification": {
      "description": "A fail-closed determination, recorded with its confidence so a run that was conservative because it was blind is distinguishable from one that was conservative because the target really was production.",
      "type": "object",
      "properties": {
        "subject": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "kind": {
          "enum": [
            "branch_protection",
            "environment",
            "observation_safety",
            "spawns_agents"
          ]
        },
        "value": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "confidence": {
          "$ref": "common.json#/$defs/confidenceClass"
        },
        "failed_closed": {
          "description": "True when the value was chosen because the probe could not establish it.",
          "type": "boolean"
        },
        "probe_detail": {
          "type": "string"
        }
      },
      "required": [
        "subject",
        "kind",
        "value",
        "confidence",
        "failed_closed",
        "probe_detail"
      ],
      "additionalProperties": false
    },
    "availability": {
      "description": "An unreachable adapter is a recorded UNAVAILABLE, which is a fact about access and not a fact about the system under study.",
      "type": "object",
      "properties": {
        "adapter": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "state": {
          "enum": [
            "AVAILABLE",
            "UNAVAILABLE",
            "NOT_CONFIGURED",
            "DENIED"
          ]
        },
        "detail": {
          "type": "string"
        },
        "checked_at": {
          "$ref": "common.json#/$defs/timestamp"
        }
      },
      "required": [
        "adapter",
        "state",
        "detail",
        "checked_at"
      ],
      "additionalProperties": false
    }
  }
};

export const ASSERTION_SCHEMA: JsonSchemaObject = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://agentos.dev/schema/assertion.json",
  "title": "Assertion",
  "description": "Every leaf value in the system is one. A discriminated union on `confidence`, so the obligations of each class are structural rather than remembered: FACT owes evidence, INFERENCE owes what it was derived from, UNKNOWN owes a reason and what would recover it.",
  "oneOf": [
    {
      "$ref": "#/$defs/fact"
    },
    {
      "$ref": "#/$defs/inference"
    },
    {
      "$ref": "#/$defs/unknown"
    }
  ],
  "$defs": {
    "evidenceRef": {
      "description": "An evidence id where an evidence pool exists to reference — an envelope carries `evidence[]` and its assertions cite ids — or the evidence itself where the assertion stands alone, as every assertion in the Context Package does. Both forms occur in the frozen documents and both are the same evidence.",
      "oneOf": [
        {
          "$ref": "common.json#/$defs/id"
        },
        {
          "$ref": "evidence.json"
        }
      ]
    },
    "base": {
      "type": "object",
      "properties": {
        "value": {},
        "confidence": {
          "$ref": "common.json#/$defs/confidenceClass"
        },
        "observed_at": {
          "$ref": "common.json#/$defs/timestamp"
        },
        "probe": {
          "description": "The probe or dispatch that produced this assertion. Required so that every assertion names its source, agent-authored inferences included.",
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "freshness": {
          "$ref": "common.json#/$defs/freshness"
        }
      },
      "required": [
        "value",
        "confidence",
        "observed_at",
        "probe",
        "freshness"
      ]
    },
    "fact": {
      "allOf": [
        {
          "$ref": "#/$defs/base"
        }
      ],
      "type": "object",
      "properties": {
        "confidence": {
          "const": "FACT"
        },
        "evidence": {
          "description": "A FACT with no evidence is an INFERENCE that has not admitted it.",
          "type": "array",
          "minItems": 1,
          "items": {
            "$ref": "#/$defs/evidenceRef"
          }
        }
      },
      "required": [
        "evidence"
      ],
      "unevaluatedProperties": false
    },
    "inference": {
      "allOf": [
        {
          "$ref": "#/$defs/base"
        }
      ],
      "type": "object",
      "properties": {
        "confidence": {
          "const": "INFERENCE"
        },
        "derived_from": {
          "description": "Assertion or evidence ids this was reasoned from.",
          "type": "array",
          "minItems": 1,
          "items": {
            "$ref": "common.json#/$defs/id"
          }
        },
        "reasoning": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "evidence": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/evidenceRef"
          }
        }
      },
      "required": [
        "derived_from",
        "reasoning"
      ],
      "unevaluatedProperties": false
    },
    "unknown": {
      "allOf": [
        {
          "$ref": "#/$defs/base"
        }
      ],
      "type": "object",
      "properties": {
        "confidence": {
          "const": "UNKNOWN"
        },
        "value": {
          "const": null
        },
        "reason": {
          "$ref": "common.json#/$defs/absenceReason"
        },
        "recoverable_by": {
          "description": "What would resolve it. This is what makes an unknown actionable rather than decorative, and it is what the uncertainty ladder's rung 2 dispatches.",
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "attempted": {
          "type": "string"
        }
      },
      "required": [
        "reason",
        "recoverable_by"
      ],
      "unevaluatedProperties": false
    }
  }
};

export const AUTHORIZATION_SCHEMA: JsonSchemaObject = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://agentos.dev/schema/authorization.json",
  "title": "Human authorization",
  "description": "Built before any mutating adapter exists, because building mutation first and adding authorization after is how the gate ends up bypassable.",
  "$defs": {
    "draftRequest": {
      "description": "What an agent may put in an envelope. A draft is not a request: the kernel records the request, and a human decides.",
      "type": "object",
      "properties": {
        "gate": {
          "$ref": "common.json#/$defs/gate"
        },
        "target": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "what": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "why": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "blast_radius": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "reversibility": {
          "$ref": "#/$defs/reversibility"
        },
        "evidence": {
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/id"
          }
        },
        "unknowns": {
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/nonEmptyString"
          }
        },
        "alternatives": {
          "description": "Including doing nothing.",
          "type": "array",
          "minItems": 1,
          "items": {
            "$ref": "common.json#/$defs/nonEmptyString"
          }
        },
        "recommendation": {
          "$ref": "common.json#/$defs/nonEmptyString"
        }
      },
      "required": [
        "gate",
        "target",
        "what",
        "why",
        "blast_radius",
        "reversibility",
        "evidence",
        "unknowns",
        "alternatives",
        "recommendation"
      ],
      "additionalProperties": false
    },
    "reversibility": {
      "type": "object",
      "properties": {
        "how": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "verified": {
          "type": "boolean"
        },
        "cost": {
          "$ref": "common.json#/$defs/nonEmptyString"
        }
      },
      "required": [
        "how",
        "verified",
        "cost"
      ],
      "additionalProperties": false
    },
    "authorizationRequest": {
      "description": "The kernel's record. A human cannot authorize what they cannot evaluate, so every field of the draft survives into the record.",
      "type": "object",
      "properties": {
        "request_id": {
          "$ref": "common.json#/$defs/id"
        },
        "work_item_id": {
          "$ref": "common.json#/$defs/id"
        },
        "run_id": {
          "$ref": "common.json#/$defs/id"
        },
        "stage": {
          "$ref": "common.json#/$defs/stage"
        },
        "requested_by": {
          "$ref": "common.json#/$defs/agentRole"
        },
        "requested_at": {
          "$ref": "common.json#/$defs/timestamp"
        },
        "draft": {
          "$ref": "#/$defs/draftRequest"
        },
        "classification": {
          "description": "The mechanical classification that fired the gate, if any. A gate that fires only when an agent volunteers is not a gate.",
          "oneOf": [
            {
              "$ref": "adapter.json#/$defs/classification"
            },
            {
              "type": "null"
            }
          ]
        },
        "trigger": {
          "enum": [
            "classifier",
            "self_declaration",
            "kernel_accounting",
            "kernel_policy"
          ]
        },
        "state": {
          "enum": [
            "PENDING",
            "GRANTED",
            "DENIED",
            "EXPIRED",
            "REVOKED"
          ]
        }
      },
      "required": [
        "request_id",
        "work_item_id",
        "run_id",
        "stage",
        "requested_by",
        "requested_at",
        "draft",
        "classification",
        "trigger",
        "state"
      ],
      "additionalProperties": false
    },
    "authorizationGrant": {
      "description": "One gate, one target, one run. No blanket grants, no standing approvals.",
      "type": "object",
      "properties": {
        "grant_id": {
          "$ref": "common.json#/$defs/id"
        },
        "run_id": {
          "$ref": "common.json#/$defs/id"
        },
        "work_item_id": {
          "$ref": "common.json#/$defs/id"
        },
        "gate": {
          "$ref": "common.json#/$defs/gate"
        },
        "target": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "scope": {
          "const": "single_action"
        },
        "granted_by": {
          "description": "The identifier the host asserted. AgentOS records it and refuses to proceed without one; inventing an authorizer is a security floor violation.",
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "granted_at": {
          "$ref": "common.json#/$defs/timestamp"
        },
        "expires_at": {
          "$ref": "common.json#/$defs/timestamp"
        },
        "conditions": {
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/nonEmptyString"
          }
        },
        "request_ref": {
          "$ref": "common.json#/$defs/id"
        },
        "evidence_reviewed": {
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/nonEmptyString"
          }
        },
        "revoked_at": {
          "type": [
            "string",
            "null"
          ],
          "format": "date-time"
        }
      },
      "required": [
        "grant_id",
        "run_id",
        "work_item_id",
        "gate",
        "target",
        "scope",
        "granted_by",
        "granted_at",
        "expires_at",
        "conditions",
        "request_ref",
        "evidence_reviewed",
        "revoked_at"
      ],
      "additionalProperties": false
    },
    "gateDefinition": {
      "description": "policies/gates.json. Classifiers are policy data, not kernel code.",
      "type": "object",
      "properties": {
        "gate": {
          "$ref": "common.json#/$defs/gate"
        },
        "description": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "fires_at_end_of_run": {
          "type": "boolean"
        },
        "once_per_work_item": {
          "type": "boolean"
        },
        "classifiers": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/classifier"
          }
        },
        "pre_grantable_by_policy": {
          "description": "Whether policy may pre-grant this gate per configured source. Only AUTONOMOUS_INTAKE_EXECUTION is, so a trusted webhook stays autonomous.",
          "type": "boolean"
        }
      },
      "required": [
        "gate",
        "description",
        "fires_at_end_of_run",
        "once_per_work_item",
        "classifiers",
        "pre_grantable_by_policy"
      ],
      "additionalProperties": false
    },
    "classifier": {
      "type": "object",
      "properties": {
        "id": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "kind": {
          "enum": [
            "path_pattern",
            "content_pattern",
            "descriptor_flag",
            "classification_value",
            "kernel_accounting",
            "trust_class_and_mutating_stage",
            "scope_escape"
          ]
        },
        "patterns": {
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/nonEmptyString"
          }
        },
        "descriptor_field": {
          "type": [
            "string",
            "null"
          ],
          "minLength": 1
        },
        "expected": {
          "type": [
            "string",
            "boolean",
            "null"
          ]
        },
        "fires_when_unevaluable": {
          "description": "A classifier that cannot evaluate fires the gate. Always true; declared so the rule is visible in the data.",
          "const": true
        }
      },
      "required": [
        "id",
        "kind",
        "patterns",
        "descriptor_field",
        "expected",
        "fires_when_unevaluable"
      ],
      "additionalProperties": false
    }
  }
};

export const CAPABILITY_SCHEMA: JsonSchemaObject = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://agentos.dev/schema/capability.json",
  "title": "Capability record, chain stage record and capability graph",
  "description": "The capability is AgentOS's unit of truth. The registry's purpose is blunt: make disconnected architecture visible.",
  "$defs": {
    "chainStageRecord": {
      "description": "`implemented` without `connected` is an orphan. `connected` without `exercised` is a capability that exists only on paper.",
      "type": "object",
      "properties": {
        "stage": {
          "$ref": "common.json#/$defs/chainStage"
        },
        "applicable": {
          "$ref": "common.json#/$defs/predicateValue"
        },
        "not_applicable_reason": {
          "type": [
            "string",
            "null"
          ]
        },
        "implemented": {
          "$ref": "common.json#/$defs/predicateValue"
        },
        "connected": {
          "$ref": "common.json#/$defs/predicateValue"
        },
        "exercised": {
          "$ref": "common.json#/$defs/predicateValue"
        },
        "evidence": {
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/id"
          }
        },
        "semantics": {
          "description": "How this stage represents absence and uncertainty.",
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/dataSemantic"
          }
        },
        "defects": {
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/id"
          }
        }
      },
      "required": [
        "stage",
        "applicable",
        "not_applicable_reason",
        "implemented",
        "connected",
        "exercised",
        "evidence",
        "semantics",
        "defects"
      ],
      "additionalProperties": false
    },
    "capabilityRecord": {
      "type": "object",
      "properties": {
        "id": {
          "$ref": "common.json#/$defs/id"
        },
        "name": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "description": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "canonical_entity": {
          "type": [
            "string",
            "null"
          ],
          "minLength": 1
        },
        "status": {
          "$ref": "common.json#/$defs/capabilityStatus"
        },
        "chain": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/chainStageRecord"
          }
        },
        "inputs": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/reference"
          }
        },
        "writers": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/reference"
          }
        },
        "storage": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/reference"
          }
        },
        "consumers": {
          "description": "What reads it, from code references rather than assumptions.",
          "type": "array",
          "items": {
            "$ref": "#/$defs/reference"
          }
        },
        "api": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/reference"
          }
        },
        "ui": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/reference"
          }
        },
        "provenance": {
          "$ref": "common.json#/$defs/predicateValue"
        },
        "observability": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/reference"
          }
        },
        "validation": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/layerVerdict"
          }
        },
        "production_evidence": {
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/id"
          }
        },
        "outcome": {
          "type": [
            "string",
            "null"
          ]
        },
        "learning": {
          "type": [
            "string",
            "null"
          ]
        },
        "reconciliation": {
          "$ref": "common.json#/$defs/reconciliationState"
        },
        "sources_seen": {
          "description": "Which of intent, code and runtime named this capability. A capability appearing in only one source is itself a finding, and which source tells you what kind.",
          "type": "array",
          "minItems": 1,
          "uniqueItems": true,
          "items": {
            "enum": [
              "INTENT",
              "CODE",
              "RUNTIME"
            ]
          }
        },
        "findings": {
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/id"
          }
        },
        "confidence": {
          "$ref": "common.json#/$defs/confidenceClass"
        },
        "scope_paths": {
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/pathGlob"
          }
        },
        "observed_at": {
          "$ref": "common.json#/$defs/timestamp"
        },
        "freshness": {
          "$ref": "common.json#/$defs/freshness"
        }
      },
      "required": [
        "id",
        "name",
        "description",
        "canonical_entity",
        "status",
        "chain",
        "inputs",
        "writers",
        "storage",
        "consumers",
        "api",
        "ui",
        "provenance",
        "observability",
        "validation",
        "production_evidence",
        "outcome",
        "learning",
        "reconciliation",
        "sources_seen",
        "findings",
        "confidence",
        "scope_paths",
        "observed_at",
        "freshness"
      ],
      "additionalProperties": false
    },
    "reference": {
      "type": "object",
      "properties": {
        "label": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "locator": {
          "$ref": "common.json#/$defs/locator"
        },
        "confidence": {
          "$ref": "common.json#/$defs/confidenceClass"
        }
      },
      "required": [
        "label",
        "locator",
        "confidence"
      ],
      "additionalProperties": false
    },
    "layerVerdict": {
      "type": "object",
      "properties": {
        "layer": {
          "enum": [
            "UNIT",
            "INTEGRATION",
            "CAPABILITY",
            "RUNTIME",
            "PRODUCTION"
          ]
        },
        "verdict": {
          "enum": [
            "PASS",
            "FAIL",
            "NOT_APPLICABLE",
            "NOT_VALIDATED"
          ]
        },
        "reason": {
          "type": [
            "string",
            "null"
          ]
        },
        "evidence": {
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/id"
          }
        }
      },
      "required": [
        "layer",
        "verdict",
        "reason",
        "evidence"
      ],
      "additionalProperties": false
    },
    "graphNode": {
      "type": "object",
      "properties": {
        "node_id": {
          "$ref": "common.json#/$defs/id"
        },
        "capability": {
          "$ref": "common.json#/$defs/id"
        },
        "stage": {
          "$ref": "common.json#/$defs/chainStage"
        },
        "label": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "locator": {
          "$ref": "common.json#/$defs/locator"
        }
      },
      "required": [
        "node_id",
        "capability",
        "stage",
        "label",
        "locator"
      ],
      "additionalProperties": false
    },
    "graphEdge": {
      "description": "A structural edge is an INFERENCE; an edge confirmed by tracing a real record through a runtime is a FACT.",
      "type": "object",
      "properties": {
        "from": {
          "$ref": "common.json#/$defs/id"
        },
        "to": {
          "$ref": "common.json#/$defs/id"
        },
        "kind": {
          "enum": [
            "DATA_FLOW",
            "CALL",
            "READ",
            "WRITE",
            "RENDER"
          ]
        },
        "confidence": {
          "$ref": "common.json#/$defs/confidenceClass"
        },
        "carries_provenance": {
          "$ref": "common.json#/$defs/predicateValue"
        },
        "evidence": {
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/id"
          }
        }
      },
      "required": [
        "from",
        "to",
        "kind",
        "confidence",
        "carries_provenance",
        "evidence"
      ],
      "additionalProperties": false
    },
    "capabilityGraph": {
      "type": "object",
      "properties": {
        "version": {
          "type": "integer",
          "minimum": 1
        },
        "nodes": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/graphNode"
          }
        },
        "edges": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/graphEdge"
          }
        },
        "built_at": {
          "$ref": "common.json#/$defs/timestamp"
        }
      },
      "required": [
        "version",
        "nodes",
        "edges",
        "built_at"
      ],
      "additionalProperties": false
    },
    "capabilityRegistry": {
      "type": "object",
      "properties": {
        "version": {
          "type": "integer",
          "minimum": 1
        },
        "run_id": {
          "$ref": "common.json#/$defs/id"
        },
        "records": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/capabilityRecord"
          }
        },
        "graph": {
          "$ref": "#/$defs/capabilityGraph"
        },
        "assembled_at": {
          "$ref": "common.json#/$defs/timestamp"
        }
      },
      "required": [
        "version",
        "run_id",
        "records",
        "graph",
        "assembled_at"
      ],
      "additionalProperties": false
    }
  }
};

export const COMMON_SCHEMA: JsonSchemaObject = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://agentos.dev/schema/common.json",
  "title": "AgentOS common vocabulary",
  "description": "The closed vocabularies every other contract draws on. Defined once so that two components cannot disagree about what a value means.",
  "$defs": {
    "id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 256,
      "pattern": "^[A-Za-z0-9][A-Za-z0-9_.:@/#-]*$"
    },
    "timestamp": {
      "type": "string",
      "format": "date-time"
    },
    "nonEmptyString": {
      "type": "string",
      "minLength": 1
    },
    "pathGlob": {
      "type": "string",
      "minLength": 1,
      "maxLength": 1024
    },
    "confidenceClass": {
      "description": "CONTEXT_MODEL section 1. UNKNOWN never silently becomes FACT.",
      "enum": [
        "FACT",
        "INFERENCE",
        "UNKNOWN"
      ]
    },
    "absenceReason": {
      "description": "DATA_SEMANTICS. The one absence vocabulary; a probe must not invent a reason string.",
      "enum": [
        "UNKNOWN",
        "UNAVAILABLE",
        "NOT_APPLICABLE",
        "NOT_COMPUTED",
        "INSUFFICIENT_EVIDENCE",
        "CONFLICTING"
      ]
    },
    "dataSemantic": {
      "description": "DATA_SEMANTICS full vocabulary, used when describing a target system's values.",
      "enum": [
        "ZERO",
        "NULL",
        "EMPTY",
        "UNKNOWN",
        "UNAVAILABLE",
        "NOT_APPLICABLE",
        "NOT_COMPUTED",
        "STALE",
        "CONFLICTING",
        "PARTIAL",
        "INSUFFICIENT_EVIDENCE"
      ]
    },
    "freshness": {
      "description": "CONTEXT_MODEL section 2: orthogonal to confidence. A value can be FACT and STALE at once.",
      "enum": [
        "CURRENT",
        "STALE",
        "UNKNOWN"
      ]
    },
    "predicateValue": {
      "description": "WORKFLOW_STATE_MACHINE section 4.3. A predicate over an UNKNOWN assertion is INDETERMINATE, never FALSE.",
      "enum": [
        "TRUE",
        "FALSE",
        "INDETERMINATE"
      ]
    },
    "evidenceKind": {
      "enum": [
        "file",
        "git",
        "command",
        "query",
        "http",
        "log",
        "ticket",
        "document",
        "screenshot",
        "metric"
      ]
    },
    "verificationStatus": {
      "enum": [
        "VERIFIED",
        "MISMATCH",
        "UNREPLAYABLE",
        "UNVERIFIED",
        "UNVERIFIABLE"
      ]
    },
    "severity": {
      "enum": [
        "CRITICAL",
        "HIGH",
        "MEDIUM",
        "LOW",
        "INFO"
      ]
    },
    "agentRole": {
      "description": "AGENT_ROLES: the eight roles. `context-discovery` covers both the resolution and context mandates.",
      "enum": [
        "orchestrator",
        "context-discovery",
        "auditor",
        "architect",
        "implementer",
        "validator",
        "product-ux",
        "production"
      ]
    },
    "reviewingRole": {
      "description": "The roles entitled to return REJECTED (AGENT_HANDOFF_CONTRACT cross-field rules).",
      "enum": [
        "validator",
        "product-ux"
      ]
    },
    "stage": {
      "description": "WORKFLOW_STATE_MACHINE section 2: prologue, template stages, and control states.",
      "enum": [
        "INTAKE_RECEIVED",
        "RESOLUTION",
        "CONTEXT_DISCOVERY",
        "UNDERSTOOD",
        "WORKFLOW_SELECTED",
        "AUDIT",
        "ROOT_CAUSE",
        "ARCHITECTURE",
        "PLAN",
        "DECOMPOSITION",
        "CHILD_COORDINATION",
        "IMPLEMENTATION",
        "VALIDATION",
        "STRUCTURAL_REAUDIT",
        "UX_REVIEW",
        "REWORK",
        "PR_PREPARATION",
        "PR_REVIEW",
        "REVIEW_TRIAGE",
        "COMMENT_RESOLUTION",
        "AUTHORIZATION",
        "MERGE",
        "DEPLOY",
        "PRODUCTION_VALIDATION",
        "COMPLETION",
        "BLOCKED",
        "CANCELLED",
        "COMPLETE"
      ]
    },
    "prologueStage": {
      "enum": [
        "INTAKE_RECEIVED",
        "RESOLUTION",
        "CONTEXT_DISCOVERY",
        "UNDERSTOOD",
        "WORKFLOW_SELECTED"
      ]
    },
    "controlState": {
      "enum": [
        "BLOCKED",
        "CANCELLED",
        "COMPLETE"
      ]
    },
    "templateStage": {
      "description": "Stages a workflow template may contain. The prologue and the control states are excluded: no template contains them and no proposal can add one.",
      "enum": [
        "AUDIT",
        "ROOT_CAUSE",
        "ARCHITECTURE",
        "PLAN",
        "DECOMPOSITION",
        "CHILD_COORDINATION",
        "IMPLEMENTATION",
        "VALIDATION",
        "STRUCTURAL_REAUDIT",
        "UX_REVIEW",
        "REWORK",
        "PR_PREPARATION",
        "PR_REVIEW",
        "REVIEW_TRIAGE",
        "COMMENT_RESOLUTION",
        "AUTHORIZATION",
        "MERGE",
        "DEPLOY",
        "PRODUCTION_VALIDATION",
        "COMPLETION"
      ]
    },
    "workItemType": {
      "description": "INTENT_AND_WORK_ITEM_RESOLUTION section 3.3. PR and REVIEW are deliberately not types.",
      "enum": [
        "EPIC",
        "FEATURE",
        "STORY",
        "DEFECT",
        "TASK",
        "INCIDENT",
        "INVESTIGATION",
        "CHANGE_REQUEST",
        "UNKNOWN"
      ]
    },
    "workItemLifecycle": {
      "enum": [
        "RESOLVED",
        "UNDERSTOOD",
        "EXECUTING",
        "BLOCKED",
        "ACHIEVED",
        "ABANDONED",
        "SUPERSEDED"
      ]
    },
    "workItemLinkKind": {
      "enum": [
        "CHILD_OF",
        "PARENT_OF",
        "DUPLICATE_OF",
        "DISCOVERED_BY",
        "DEPENDS_ON",
        "SUPERSEDES",
        "SUPERSEDED_BY"
      ]
    },
    "intakeSource": {
      "enum": [
        "NATURAL_LANGUAGE",
        "PROJECT_MANAGEMENT",
        "VCS",
        "DOCUMENT",
        "EVENT",
        "SCHEDULE",
        "RUNTIME_ALERT"
      ]
    },
    "trustClass": {
      "description": "Set by the host from authenticated context, never from intake content.",
      "enum": [
        "OPERATOR",
        "INTERNAL",
        "EXTERNAL"
      ]
    },
    "reconciliationState": {
      "description": "CONTEXT_MODEL section 5. Used at capability level and at work-item level.",
      "enum": [
        "ALIGNED",
        "INTENT_ONLY",
        "CODE_ONLY",
        "CODE_NO_RUNTIME",
        "RUNTIME_NO_CODE",
        "CLAIMED_DONE_UNPROVEN",
        "CONFLICTING",
        "INDETERMINATE"
      ]
    },
    "capabilityStatus": {
      "enum": [
        "PROVEN",
        "WORKING",
        "PARTIAL",
        "DISCONNECTED",
        "ORPHANED",
        "CLAIMED",
        "ABSENT",
        "UNKNOWN"
      ]
    },
    "chainStage": {
      "enum": [
        "SOURCE",
        "INGESTION",
        "NORMALIZATION",
        "CANONICAL_STORE",
        "INTELLIGENCE",
        "API",
        "UI",
        "OUTCOME",
        "LEARNING"
      ]
    },
    "riskClass": {
      "description": "WORKFLOW_STATE_MACHINE section 3.6, derived by the kernel from the admitted graph and scope.",
      "enum": [
        "READ_ONLY",
        "LOCAL_MUTATION",
        "EXTERNAL_MUTATION",
        "IRREVERSIBLE"
      ]
    },
    "gate": {
      "enum": [
        "MERGE_PROTECTED",
        "DEPLOY_PRODUCTION",
        "DESTRUCTIVE_MIGRATION",
        "IRREVERSIBLE_DATA_MUTATION",
        "CREDENTIAL_OR_SECURITY_CHANGE",
        "EXTERNAL_COMMUNICATION",
        "PRODUCTION_WRITE",
        "SCOPE_EXPANSION",
        "COST_CEILING_EXCEEDED",
        "AUTONOMOUS_INTAKE_EXECUTION"
      ]
    },
    "dodVerdict": {
      "description": "DEFINITION_OF_DONE section 1. NOT_VALIDATED is never counted as MET.",
      "enum": [
        "MET",
        "NOT_MET",
        "NOT_APPLICABLE",
        "NOT_VALIDATED"
      ]
    },
    "completionVerdict": {
      "enum": [
        "COMPLETE",
        "COMPLETE_WITH_GAPS",
        "INCOMPLETE",
        "INDETERMINATE"
      ]
    },
    "dodProfileId": {
      "enum": [
        "data-capability",
        "service-capability",
        "ui-capability",
        "internal-capability",
        "fix",
        "audit",
        "documentation"
      ]
    },
    "runOutcome": {
      "enum": [
        "COMPLETE",
        "BLOCKED",
        "FAILED",
        "CANCELLED",
        "RERESOLVED"
      ]
    },
    "locator": {
      "description": "A re-executable read. `op: null` marks a genuinely unrepeatable observation, which caps the assertion it supports at INFERENCE.",
      "type": "object",
      "properties": {
        "adapter": {
          "$ref": "#/$defs/nonEmptyString"
        },
        "op": {
          "type": [
            "string",
            "null"
          ],
          "minLength": 1
        },
        "args": {
          "type": "object"
        }
      },
      "required": [
        "adapter",
        "op",
        "args"
      ],
      "additionalProperties": false
    },
    "scope": {
      "description": "A typed, bounded scope. Becomes `mandate.in_scope`, so an over-wide scope is an over-wide grant of reach.",
      "type": "object",
      "properties": {
        "paths": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/pathGlob"
          }
        },
        "capabilities": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/id"
          }
        },
        "repositories": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/nonEmptyString"
          }
        }
      },
      "required": [
        "paths",
        "capabilities",
        "repositories"
      ],
      "additionalProperties": false
    },
    "cost": {
      "type": "object",
      "properties": {
        "input_tokens": {
          "type": "integer",
          "minimum": 0
        },
        "output_tokens": {
          "type": "integer",
          "minimum": 0
        },
        "usd": {
          "type": [
            "number",
            "null"
          ],
          "minimum": 0
        }
      },
      "required": [
        "input_tokens",
        "output_tokens"
      ],
      "additionalProperties": false
    }
  }
};

export const CONTEXT_PACKAGE_SCHEMA: JsonSchemaObject = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://agentos.dev/schema/context-package.json",
  "title": "ContextPackage",
  "description": "The durable, structured answer to what is actually true about this repository, its intent and its runtime. Twenty-three sections; the section names are the vocabulary of `required_inputs`, so they are load-bearing identifiers and not documentation.",
  "type": "object",
  "properties": {
    "meta": {
      "$ref": "#/$defs/meta"
    },
    "work_item": {
      "description": "A reference, not a copy. Keeping a third copy would give the run two answers to what it is doing.",
      "type": [
        "string",
        "null"
      ],
      "minLength": 1
    },
    "current_reality": {
      "$ref": "#/$defs/currentReality"
    },
    "repository": {
      "$ref": "#/$defs/section"
    },
    "product": {
      "$ref": "#/$defs/section"
    },
    "capabilities": {
      "description": "A reference into the Capability Registry rather than a copy. There is one representation of a capability per run.",
      "type": [
        "string",
        "null"
      ],
      "minLength": 1
    },
    "architecture": {
      "$ref": "#/$defs/section"
    },
    "domain_model": {
      "$ref": "#/$defs/section"
    },
    "source_map": {
      "$ref": "#/$defs/section"
    },
    "data_map": {
      "$ref": "#/$defs/section"
    },
    "api_map": {
      "$ref": "#/$defs/section"
    },
    "ui_map": {
      "$ref": "#/$defs/section"
    },
    "tests": {
      "$ref": "#/$defs/section"
    },
    "git_state": {
      "$ref": "#/$defs/section"
    },
    "runtime_state": {
      "$ref": "#/$defs/section"
    },
    "production_state": {
      "$ref": "#/$defs/section"
    },
    "intent": {
      "$ref": "#/$defs/section"
    },
    "reconciliation": {
      "$ref": "#/$defs/reconciliationMatrix"
    },
    "agent_capabilities": {
      "$ref": "#/$defs/section"
    },
    "model_capabilities": {
      "$ref": "#/$defs/section"
    },
    "constraints": {
      "$ref": "#/$defs/section"
    },
    "authorization": {
      "$ref": "#/$defs/section"
    },
    "gaps": {
      "description": "A first-class section, not a footnote. What AgentOS does not know is as operationally important as what it does.",
      "type": "array",
      "items": {
        "$ref": "finding.json#/$defs/unknown"
      }
    }
  },
  "required": [
    "meta",
    "work_item",
    "current_reality",
    "repository",
    "product",
    "capabilities",
    "architecture",
    "domain_model",
    "source_map",
    "data_map",
    "api_map",
    "ui_map",
    "tests",
    "git_state",
    "runtime_state",
    "production_state",
    "intent",
    "reconciliation",
    "agent_capabilities",
    "model_capabilities",
    "constraints",
    "authorization",
    "gaps"
  ],
  "additionalProperties": false,
  "$defs": {
    "sectionName": {
      "enum": [
        "meta",
        "work_item",
        "current_reality",
        "repository",
        "product",
        "capabilities",
        "architecture",
        "domain_model",
        "source_map",
        "data_map",
        "api_map",
        "ui_map",
        "tests",
        "git_state",
        "runtime_state",
        "production_state",
        "intent",
        "reconciliation",
        "agent_capabilities",
        "model_capabilities",
        "constraints",
        "authorization",
        "gaps"
      ]
    },
    "section": {
      "description": "Every leaf is an assertion, never a bare value. Probes choose the keys within a section; the section names themselves are fixed.",
      "type": "object",
      "patternProperties": {
        "^[a-z][a-z0-9_]*$": {
          "$ref": "assertion.json"
        }
      },
      "additionalProperties": false
    },
    "meta": {
      "type": "object",
      "properties": {
        "run_id": {
          "$ref": "common.json#/$defs/id"
        },
        "work_item_id": {
          "type": [
            "string",
            "null"
          ],
          "minLength": 1
        },
        "package_version": {
          "description": "The package is versioned, not appended. On-demand discovery produces a new version.",
          "type": "integer",
          "minimum": 1
        },
        "assembled_at": {
          "$ref": "common.json#/$defs/timestamp"
        },
        "tier": {
          "description": "1 orientation, 2 work-item-relevant depth, 3 on-demand.",
          "type": "integer",
          "minimum": 1,
          "maximum": 3
        },
        "probe_coverage": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/probeCoverage"
          }
        },
        "adapter_availability": {
          "type": "array",
          "items": {
            "$ref": "adapter.json#/$defs/availability"
          }
        }
      },
      "required": [
        "run_id",
        "work_item_id",
        "package_version",
        "assembled_at",
        "tier",
        "probe_coverage",
        "adapter_availability"
      ],
      "additionalProperties": false
    },
    "probeCoverage": {
      "description": "An agent must be able to distinguish 'found no orphan readers here' from 'discovery never looked here'.",
      "type": "object",
      "properties": {
        "probe": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "section": {
          "$ref": "#/$defs/sectionName"
        },
        "state": {
          "enum": [
            "RAN",
            "SKIPPED",
            "UNAVAILABLE",
            "PARTIAL"
          ]
        },
        "reason": {
          "type": [
            "string",
            "null"
          ]
        },
        "scope_examined": {
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/pathGlob"
          }
        },
        "scope_not_examined": {
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/pathGlob"
          }
        },
        "observed_at": {
          "$ref": "common.json#/$defs/timestamp"
        }
      },
      "required": [
        "probe",
        "section",
        "state",
        "reason",
        "scope_examined",
        "scope_not_examined",
        "observed_at"
      ],
      "additionalProperties": false
    },
    "currentReality": {
      "description": "Written only by probes. No part of it may be derived from the intake text, from a ticket's status field alone, or from an agent's account of a previous run.",
      "type": "object",
      "properties": {
        "implementation_present": {
          "$ref": "assertion.json"
        },
        "tests_present": {
          "$ref": "assertion.json"
        },
        "pr": {
          "$ref": "assertion.json"
        },
        "ci": {
          "$ref": "assertion.json"
        },
        "reviews": {
          "$ref": "assertion.json"
        },
        "merge_state": {
          "$ref": "assertion.json"
        },
        "deployment": {
          "$ref": "assertion.json"
        },
        "outcome_evidence": {
          "$ref": "assertion.json"
        },
        "children": {
          "$ref": "assertion.json"
        },
        "agentos_history": {
          "$ref": "assertion.json"
        },
        "reconciliation": {
          "description": "The three-way reconciliation applied to the work item rather than to a capability. Same enum, same rule.",
          "$ref": "common.json#/$defs/reconciliationState"
        }
      },
      "required": [
        "implementation_present",
        "tests_present",
        "pr",
        "ci",
        "reviews",
        "merge_state",
        "deployment",
        "outcome_evidence",
        "children",
        "agentos_history",
        "reconciliation"
      ],
      "additionalProperties": false
    },
    "realityElement": {
      "enum": [
        "implementation_present",
        "tests_present",
        "pr",
        "ci",
        "reviews",
        "merge_state",
        "deployment",
        "outcome_evidence",
        "children",
        "agentos_history"
      ]
    },
    "reconciliationMatrix": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "capability": {
            "$ref": "common.json#/$defs/id"
          },
          "intent": {
            "$ref": "assertion.json"
          },
          "code": {
            "$ref": "assertion.json"
          },
          "runtime": {
            "$ref": "assertion.json"
          },
          "state": {
            "$ref": "common.json#/$defs/reconciliationState"
          },
          "rationale": {
            "$ref": "common.json#/$defs/nonEmptyString"
          }
        },
        "required": [
          "capability",
          "intent",
          "code",
          "runtime",
          "state",
          "rationale"
        ],
        "additionalProperties": false
      }
    }
  }
};

export const DOD_SCHEMA: JsonSchemaObject = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://agentos.dev/schema/dod.json",
  "title": "Definition of Done",
  "description": "Profiles are policy data; per-criterion verdicts come from agents; the arithmetic is the kernel's.",
  "$defs": {
    "criterionId": {
      "type": "integer",
      "minimum": 1,
      "maximum": 18
    },
    "criterionVerdict": {
      "description": "One agent owns each criterion, and no agent supplies the verdict on its own work.",
      "type": "object",
      "properties": {
        "criterion": {
          "$ref": "#/$defs/criterionId"
        },
        "verdict": {
          "$ref": "common.json#/$defs/dodVerdict"
        },
        "reason": {
          "description": "Mandatory for NOT_APPLICABLE and NOT_VALIDATED: a criterion set aside without a reason is a criterion quietly skipped.",
          "type": [
            "string",
            "null"
          ]
        },
        "evidence": {
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/id"
          }
        },
        "capability": {
          "type": [
            "string",
            "null"
          ],
          "minLength": 1
        }
      },
      "required": [
        "criterion",
        "verdict",
        "reason",
        "evidence",
        "capability"
      ],
      "additionalProperties": false
    },
    "dodProfile": {
      "type": "object",
      "properties": {
        "profile_id": {
          "$ref": "common.json#/$defs/dodProfileId"
        },
        "description": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "criteria": {
          "type": "array",
          "minItems": 1,
          "uniqueItems": true,
          "items": {
            "$ref": "#/$defs/criterionId"
          }
        },
        "critical_criteria": {
          "description": "Criteria whose failure makes the verdict INCOMPLETE rather than COMPLETE_WITH_GAPS.",
          "type": "array",
          "uniqueItems": true,
          "items": {
            "$ref": "#/$defs/criterionId"
          }
        },
        "not_applicable_by_default": {
          "description": "Criteria this kind of thing genuinely does not have, each with the reason. A profile that marks an inconvenient criterion NOT_APPLICABLE without a reason is rejected.",
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "criterion": {
                "$ref": "#/$defs/criterionId"
              },
              "reason": {
                "$ref": "common.json#/$defs/nonEmptyString"
              }
            },
            "required": [
              "criterion",
              "reason"
            ],
            "additionalProperties": false
          }
        },
        "evidence_requirements": {
          "type": "object",
          "patternProperties": {
            "^(1[0-8]|[1-9])$": {
              "type": "object",
              "properties": {
                "kinds": {
                  "type": "array",
                  "minItems": 1,
                  "items": {
                    "$ref": "common.json#/$defs/evidenceKind"
                  }
                },
                "note": {
                  "$ref": "common.json#/$defs/nonEmptyString"
                }
              },
              "required": [
                "kinds",
                "note"
              ],
              "additionalProperties": false
            }
          },
          "additionalProperties": false
        },
        "applies_when": {
          "description": "Applicability rules the kernel checks a profile assignment against.",
          "type": "object",
          "properties": {
            "capability_kinds": {
              "type": "array",
              "items": {
                "$ref": "common.json#/$defs/nonEmptyString"
              }
            },
            "work_item_types": {
              "type": "array",
              "items": {
                "oneOf": [
                  {
                    "$ref": "common.json#/$defs/workItemType"
                  },
                  {
                    "const": "*"
                  }
                ]
              }
            },
            "requires_access": {
              "description": "Access classes the profile's criteria need. An outcome binding only to a profile whose access this run lacks is not checkable, and admission says so.",
              "type": "array",
              "items": {
                "enum": [
                  "repository",
                  "git",
                  "project_management",
                  "runtime",
                  "production"
                ]
              }
            }
          },
          "required": [
            "capability_kinds",
            "work_item_types",
            "requires_access"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "profile_id",
        "description",
        "criteria",
        "critical_criteria",
        "not_applicable_by_default",
        "evidence_requirements",
        "applies_when"
      ],
      "additionalProperties": false
    },
    "completionReport": {
      "description": "Written for a reader who was not present and does not trust the run.",
      "type": "object",
      "properties": {
        "work_item_id": {
          "$ref": "common.json#/$defs/id"
        },
        "run_id": {
          "$ref": "common.json#/$defs/id"
        },
        "profile_id": {
          "$ref": "common.json#/$defs/dodProfileId"
        },
        "verdict": {
          "$ref": "common.json#/$defs/completionVerdict"
        },
        "criteria": {
          "type": "array",
          "minItems": 1,
          "items": {
            "type": "object",
            "properties": {
              "criterion": {
                "$ref": "#/$defs/criterionId"
              },
              "verdict": {
                "$ref": "common.json#/$defs/dodVerdict"
              },
              "reason": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "evidence": {
                "type": "array",
                "items": {
                  "$ref": "common.json#/$defs/id"
                }
              },
              "owner_role": {
                "$ref": "common.json#/$defs/agentRole"
              },
              "supplied_by_envelope": {
                "type": [
                  "string",
                  "null"
                ],
                "minLength": 1
              }
            },
            "required": [
              "criterion",
              "verdict",
              "reason",
              "evidence",
              "owner_role",
              "supplied_by_envelope"
            ],
            "additionalProperties": false
          }
        },
        "unmet_critical": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/criterionId"
          }
        },
        "not_validated": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/criterionId"
          }
        },
        "gaps": {
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/nonEmptyString"
          }
        },
        "route_back_to": {
          "description": "The stage that owes the missing verdicts. Populated when the verdict is INCOMPLETE.",
          "oneOf": [
            {
              "$ref": "common.json#/$defs/templateStage"
            },
            {
              "type": "null"
            }
          ]
        },
        "source_drift": {
          "oneOf": [
            {
              "$ref": "#/$defs/sourceDrift"
            },
            {
              "type": "null"
            }
          ]
        },
        "computed_at": {
          "$ref": "common.json#/$defs/timestamp"
        }
      },
      "required": [
        "work_item_id",
        "run_id",
        "profile_id",
        "verdict",
        "criteria",
        "unmet_critical",
        "not_validated",
        "gaps",
        "route_back_to",
        "source_drift",
        "computed_at"
      ],
      "additionalProperties": false
    },
    "sourceDrift": {
      "description": "The intake's own locator, re-executed at COMPLETION. Disclosure, never chasing.",
      "type": "object",
      "properties": {
        "state": {
          "enum": [
            "UNCHANGED",
            "CHANGED",
            "UNAVAILABLE"
          ]
        },
        "hash_at_admission": {
          "type": "string"
        },
        "hash_now": {
          "type": [
            "string",
            "null"
          ]
        },
        "detail": {
          "type": "string"
        }
      },
      "required": [
        "state",
        "hash_at_admission",
        "hash_now",
        "detail"
      ],
      "additionalProperties": false
    }
  }
};

export const EVENT_SCHEMA: JsonSchemaObject = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://agentos.dev/schema/event.json",
  "title": "Event log record",
  "description": "The authoritative record. run.json and work-item.json are projections; if they disagree with the log, the log wins. One newline-terminated line per event.",
  "allOf": [
    {
      "$ref": "#/$defs/base"
    },
    {
      "$ref": "#/$defs/payload"
    }
  ],
  "unevaluatedProperties": false,
  "$defs": {
    "base": {
      "type": "object",
      "properties": {
        "seq": {
          "description": "Monotonic within one log. Recovery is a pure function of the log, and the sequence is what makes a prefix well-defined.",
          "type": "integer",
          "minimum": 1
        },
        "at": {
          "$ref": "common.json#/$defs/timestamp"
        },
        "work_item_id": {
          "$ref": "common.json#/$defs/id"
        },
        "run_id": {
          "type": [
            "string",
            "null"
          ],
          "minLength": 1
        },
        "stage": {
          "oneOf": [
            {
              "$ref": "common.json#/$defs/stage"
            },
            {
              "type": "null"
            }
          ]
        },
        "dispatch_id": {
          "type": [
            "string",
            "null"
          ],
          "minLength": 1
        },
        "agent": {
          "oneOf": [
            {
              "$ref": "common.json#/$defs/agentRole"
            },
            {
              "type": "null"
            }
          ]
        },
        "event": {
          "$ref": "#/$defs/eventKind"
        },
        "data": {}
      },
      "required": [
        "seq",
        "at",
        "work_item_id",
        "run_id",
        "stage",
        "dispatch_id",
        "agent",
        "event",
        "data"
      ]
    },
    "eventKind": {
      "enum": [
        "run_started",
        "run_ended",
        "intake_recorded",
        "work_item_admitted",
        "work_item_rejected",
        "understood_computed",
        "workflow_admitted",
        "workflow_override",
        "entry_stage_computed",
        "stage_marked_completed_prior",
        "transition",
        "dispatch_intent",
        "dispatch_result",
        "envelope_received",
        "envelope_rejected",
        "contract_violation",
        "evidence_verification",
        "evidence_integrity",
        "mutation",
        "adapter_call",
        "dispatch_rollback",
        "idempotency",
        "gate_fired",
        "authorization_requested",
        "authorization_decided",
        "scope_violation",
        "security_violation",
        "conflict",
        "budget",
        "dod_computed",
        "source_drift",
        "reresolved",
        "child_work_item",
        "lease",
        "recovery",
        "selection",
        "question",
        "discovery",
        "context_package_versioned",
        "capability_registry_updated",
        "work_item_lifecycle",
        "tool_surface_conformance",
        "intake_instruction_attempt",
        "duplicate_candidates",
        "predicate_evaluated",
        "note"
      ]
    },
    "payload": {
      "oneOf": [
        {
          "$ref": "#/$defs/e_run_started"
        },
        {
          "$ref": "#/$defs/e_run_ended"
        },
        {
          "$ref": "#/$defs/e_intake_recorded"
        },
        {
          "$ref": "#/$defs/e_work_item_admitted"
        },
        {
          "$ref": "#/$defs/e_work_item_rejected"
        },
        {
          "$ref": "#/$defs/e_understood_computed"
        },
        {
          "$ref": "#/$defs/e_workflow_admitted"
        },
        {
          "$ref": "#/$defs/e_workflow_override"
        },
        {
          "$ref": "#/$defs/e_entry_stage_computed"
        },
        {
          "$ref": "#/$defs/e_stage_marked_completed_prior"
        },
        {
          "$ref": "#/$defs/e_transition"
        },
        {
          "$ref": "#/$defs/e_dispatch_intent"
        },
        {
          "$ref": "#/$defs/e_dispatch_result"
        },
        {
          "$ref": "#/$defs/e_envelope_received"
        },
        {
          "$ref": "#/$defs/e_envelope_rejected"
        },
        {
          "$ref": "#/$defs/e_contract_violation"
        },
        {
          "$ref": "#/$defs/e_evidence_verification"
        },
        {
          "$ref": "#/$defs/e_evidence_integrity"
        },
        {
          "$ref": "#/$defs/e_mutation"
        },
        {
          "$ref": "#/$defs/e_adapter_call"
        },
        {
          "$ref": "#/$defs/e_dispatch_rollback"
        },
        {
          "$ref": "#/$defs/e_idempotency"
        },
        {
          "$ref": "#/$defs/e_gate_fired"
        },
        {
          "$ref": "#/$defs/e_authorization_requested"
        },
        {
          "$ref": "#/$defs/e_authorization_decided"
        },
        {
          "$ref": "#/$defs/e_scope_violation"
        },
        {
          "$ref": "#/$defs/e_security_violation"
        },
        {
          "$ref": "#/$defs/e_conflict"
        },
        {
          "$ref": "#/$defs/e_budget"
        },
        {
          "$ref": "#/$defs/e_dod_computed"
        },
        {
          "$ref": "#/$defs/e_source_drift"
        },
        {
          "$ref": "#/$defs/e_reresolved"
        },
        {
          "$ref": "#/$defs/e_child_work_item"
        },
        {
          "$ref": "#/$defs/e_lease"
        },
        {
          "$ref": "#/$defs/e_recovery"
        },
        {
          "$ref": "#/$defs/e_selection"
        },
        {
          "$ref": "#/$defs/e_question"
        },
        {
          "$ref": "#/$defs/e_discovery"
        },
        {
          "$ref": "#/$defs/e_context_package_versioned"
        },
        {
          "$ref": "#/$defs/e_capability_registry_updated"
        },
        {
          "$ref": "#/$defs/e_work_item_lifecycle"
        },
        {
          "$ref": "#/$defs/e_tool_surface_conformance"
        },
        {
          "$ref": "#/$defs/e_intake_instruction_attempt"
        },
        {
          "$ref": "#/$defs/e_duplicate_candidates"
        },
        {
          "$ref": "#/$defs/e_predicate_evaluated"
        },
        {
          "$ref": "#/$defs/e_note"
        }
      ]
    },
    "e_run_started": {
      "type": "object",
      "properties": {
        "event": {
          "const": "run_started"
        },
        "data": {
          "type": "object",
          "properties": {
            "run_id": {
              "$ref": "common.json#/$defs/id"
            },
            "holder": {
              "$ref": "common.json#/$defs/nonEmptyString"
            },
            "reason": {
              "enum": [
                "NEW",
                "RESUME",
                "RERESOLUTION",
                "RETRY"
              ]
            }
          },
          "required": [
            "run_id",
            "holder",
            "reason"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "event",
        "data"
      ]
    },
    "e_run_ended": {
      "type": "object",
      "properties": {
        "event": {
          "const": "run_ended"
        },
        "data": {
          "type": "object",
          "properties": {
            "outcome": {
              "$ref": "common.json#/$defs/runOutcome"
            },
            "detail": {
              "type": "string"
            }
          },
          "required": [
            "outcome",
            "detail"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "event",
        "data"
      ]
    },
    "e_intake_recorded": {
      "type": "object",
      "properties": {
        "event": {
          "const": "intake_recorded"
        },
        "data": {
          "$ref": "work-item.json#/$defs/intakeRecord"
        }
      },
      "required": [
        "event",
        "data"
      ]
    },
    "e_work_item_admitted": {
      "type": "object",
      "properties": {
        "event": {
          "const": "work_item_admitted"
        },
        "data": {
          "type": "object",
          "properties": {
            "work_item": {
              "$ref": "work-item.json#/$defs/workItem"
            },
            "checks": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/checkOutcome"
              }
            },
            "type_downgraded": {
              "description": "True where a type was asserted without its minimum evidence and admitted as UNKNOWN.",
              "type": "boolean"
            }
          },
          "required": [
            "work_item",
            "checks",
            "type_downgraded"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "event",
        "data"
      ]
    },
    "e_work_item_rejected": {
      "type": "object",
      "properties": {
        "event": {
          "const": "work_item_rejected"
        },
        "data": {
          "type": "object",
          "properties": {
            "checks": {
              "type": "array",
              "minItems": 1,
              "items": {
                "$ref": "#/$defs/checkOutcome"
              }
            },
            "attempt": {
              "type": "integer",
              "minimum": 1
            },
            "next": {
              "enum": [
                "REDISPATCH",
                "LADDER",
                "BLOCKED"
              ]
            }
          },
          "required": [
            "checks",
            "attempt",
            "next"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "event",
        "data"
      ]
    },
    "e_understood_computed": {
      "type": "object",
      "properties": {
        "event": {
          "const": "understood_computed"
        },
        "data": {
          "type": "object",
          "properties": {
            "verdict": {
              "enum": [
                "SUFFICIENT",
                "INSUFFICIENT"
              ]
            },
            "conditions": {
              "type": "array",
              "minItems": 5,
              "items": {
                "$ref": "#/$defs/checkOutcome"
              }
            },
            "undetermined_predicates": {
              "description": "Naming which predicate is undetermined names which discovery would resolve it. Sufficiency failures are actionable by construction.",
              "type": "array",
              "items": {
                "$ref": "common.json#/$defs/nonEmptyString"
              }
            }
          },
          "required": [
            "verdict",
            "conditions",
            "undetermined_predicates"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "event",
        "data"
      ]
    },
    "e_workflow_admitted": {
      "type": "object",
      "properties": {
        "event": {
          "const": "workflow_admitted"
        },
        "data": {
          "type": "object",
          "properties": {
            "graph": {
              "$ref": "workflow.json#/$defs/frozenGraph"
            },
            "admissible_templates": {
              "type": "array",
              "minItems": 1,
              "items": {
                "type": "string"
              }
            },
            "checks": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/checkOutcome"
              }
            }
          },
          "required": [
            "graph",
            "admissible_templates",
            "checks"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "event",
        "data"
      ]
    },
    "e_workflow_override": {
      "type": "object",
      "properties": {
        "event": {
          "const": "workflow_override"
        },
        "data": {
          "type": "object",
          "properties": {
            "proposed_template": {
              "type": [
                "string",
                "null"
              ]
            },
            "selected_template": {
              "$ref": "common.json#/$defs/nonEmptyString"
            },
            "reason": {
              "$ref": "common.json#/$defs/nonEmptyString"
            },
            "failed_checks": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/checkOutcome"
              }
            }
          },
          "required": [
            "proposed_template",
            "selected_template",
            "reason",
            "failed_checks"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "event",
        "data"
      ]
    },
    "e_entry_stage_computed": {
      "type": "object",
      "properties": {
        "event": {
          "const": "entry_stage_computed"
        },
        "data": {
          "type": "object",
          "properties": {
            "entry_stage": {
              "oneOf": [
                {
                  "$ref": "common.json#/$defs/stage"
                },
                {
                  "type": "null"
                }
              ]
            },
            "walk": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "stage": {
                    "$ref": "common.json#/$defs/templateStage"
                  },
                  "satisfied_by": {
                    "type": [
                      "string",
                      "null"
                    ]
                  },
                  "evaluated": {
                    "$ref": "common.json#/$defs/predicateValue"
                  },
                  "mutating": {
                    "type": "boolean"
                  },
                  "decision": {
                    "enum": [
                      "COMPLETED_PRIOR",
                      "ENTER",
                      "DISCOVER",
                      "BLOCK_AMBIGUOUS_STATE"
                    ]
                  },
                  "evidence": {
                    "type": "array",
                    "items": {
                      "$ref": "common.json#/$defs/id"
                    }
                  }
                },
                "required": [
                  "stage",
                  "satisfied_by",
                  "evaluated",
                  "mutating",
                  "decision",
                  "evidence"
                ],
                "additionalProperties": false
              }
            }
          },
          "required": [
            "entry_stage",
            "walk"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "event",
        "data"
      ]
    },
    "e_stage_marked_completed_prior": {
      "type": "object",
      "properties": {
        "event": {
          "const": "stage_marked_completed_prior"
        },
        "data": {
          "type": "object",
          "properties": {
            "marked_stage": {
              "$ref": "common.json#/$defs/templateStage"
            },
            "predicate": {
              "$ref": "common.json#/$defs/nonEmptyString"
            },
            "evidence": {
              "type": "array",
              "items": {
                "$ref": "common.json#/$defs/id"
              }
            },
            "note": {
              "description": "COMPLETED_PRIOR means the mutation has already occurred, not that the criteria are met.",
              "const": "criteria remain NOT_VALIDATED"
            }
          },
          "required": [
            "marked_stage",
            "predicate",
            "evidence",
            "note"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "event",
        "data"
      ]
    },
    "e_transition": {
      "type": "object",
      "properties": {
        "event": {
          "const": "transition"
        },
        "data": {
          "type": "object",
          "properties": {
            "from": {
              "$ref": "common.json#/$defs/stage"
            },
            "to": {
              "$ref": "common.json#/$defs/stage"
            },
            "trigger": {
              "$ref": "common.json#/$defs/nonEmptyString"
            },
            "edge_kind": {
              "enum": [
                "advance",
                "branch",
                "loop",
                "escalate",
                "terminal"
              ]
            },
            "proposed_by": {
              "oneOf": [
                {
                  "$ref": "common.json#/$defs/agentRole"
                },
                {
                  "type": "null"
                }
              ]
            },
            "proposed_stage": {
              "oneOf": [
                {
                  "$ref": "common.json#/$defs/stage"
                },
                {
                  "type": "null"
                }
              ]
            },
            "overridden": {
              "description": "True when the agent proposed something else. The override is logged with both the claim and the evaluated value.",
              "type": "boolean"
            },
            "evidence": {
              "type": "array",
              "items": {
                "$ref": "common.json#/$defs/id"
              }
            }
          },
          "required": [
            "from",
            "to",
            "trigger",
            "edge_kind",
            "proposed_by",
            "proposed_stage",
            "overridden",
            "evidence"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "event",
        "data"
      ]
    },
    "e_dispatch_intent": {
      "description": "Written before the agent is invoked, so a crash mid-agent is detectable rather than invisible.",
      "type": "object",
      "properties": {
        "event": {
          "const": "dispatch_intent"
        },
        "data": {
          "type": "object",
          "properties": {
            "input_package": {
              "$ref": "input-package.json"
            },
            "attempt": {
              "type": "integer",
              "minimum": 1
            }
          },
          "required": [
            "input_package",
            "attempt"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "event",
        "data"
      ]
    },
    "e_dispatch_result": {
      "type": "object",
      "properties": {
        "event": {
          "const": "dispatch_result"
        },
        "data": {
          "type": "object",
          "properties": {
            "outcome": {
              "enum": [
                "ENVELOPE",
                "FAILED",
                "ABORTED"
              ]
            },
            "envelope_id": {
              "type": [
                "string",
                "null"
              ],
              "minLength": 1
            },
            "failure_reason": {
              "oneOf": [
                {
                  "enum": [
                    "NO_MODEL",
                    "TIMEOUT",
                    "TOOL_SURFACE_VIOLATION",
                    "MALFORMED_ENVELOPE",
                    "SUBSTRATE_ERROR",
                    "BUDGET_EXCEEDED",
                    "SECURITY_VIOLATION"
                  ]
                },
                {
                  "type": "null"
                }
              ]
            },
            "detail": {
              "type": "string"
            },
            "cost": {
              "$ref": "common.json#/$defs/cost"
            }
          },
          "required": [
            "outcome",
            "envelope_id",
            "failure_reason",
            "detail",
            "cost"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "event",
        "data"
      ]
    },
    "e_envelope_received": {
      "type": "object",
      "properties": {
        "event": {
          "const": "envelope_received"
        },
        "data": {
          "type": "object",
          "properties": {
            "envelope_id": {
              "$ref": "common.json#/$defs/id"
            },
            "status": {
              "$ref": "handoff-envelope.json#/$defs/status"
            },
            "steps": {
              "description": "The eight receipt steps, in order. Later steps do not run if an earlier one rejects.",
              "type": "array",
              "minItems": 1,
              "items": {
                "$ref": "#/$defs/checkOutcome"
              }
            }
          },
          "required": [
            "envelope_id",
            "status",
            "steps"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "event",
        "data"
      ]
    },
    "e_envelope_rejected": {
      "type": "object",
      "properties": {
        "event": {
          "const": "envelope_rejected"
        },
        "data": {
          "type": "object",
          "properties": {
            "envelope_id": {
              "type": [
                "string",
                "null"
              ],
              "minLength": 1
            },
            "step": {
              "$ref": "#/$defs/receiptStep"
            },
            "violations": {
              "type": "array",
              "minItems": 1,
              "items": {
                "$ref": "rejection.json#/$defs/violation"
              }
            }
          },
          "required": [
            "envelope_id",
            "step",
            "violations"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "event",
        "data"
      ]
    },
    "e_contract_violation": {
      "type": "object",
      "properties": {
        "event": {
          "const": "contract_violation"
        },
        "data": {
          "$ref": "rejection.json#/$defs/violation"
        }
      },
      "required": [
        "event",
        "data"
      ]
    },
    "e_evidence_verification": {
      "type": "object",
      "properties": {
        "event": {
          "const": "evidence_verification"
        },
        "data": {
          "type": "object",
          "properties": {
            "envelope_id": {
              "$ref": "common.json#/$defs/id"
            },
            "results": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "evidence_id": {
                    "$ref": "common.json#/$defs/id"
                  },
                  "status": {
                    "$ref": "common.json#/$defs/verificationStatus"
                  },
                  "selected_because": {
                    "enum": [
                      "ALWAYS_CRITICAL_FINDING",
                      "ALWAYS_AUTHORIZATION",
                      "ALWAYS_DOD_MET",
                      "ALWAYS_CONTRADICTS",
                      "SAMPLED",
                      "NOT_SELECTED",
                      "DECLARED_UNREPRODUCIBLE"
                    ]
                  },
                  "detail": {
                    "type": "string"
                  }
                },
                "required": [
                  "evidence_id",
                  "status",
                  "selected_because",
                  "detail"
                ],
                "additionalProperties": false
              }
            },
            "mismatch_count": {
              "type": "integer",
              "minimum": 0
            }
          },
          "required": [
            "envelope_id",
            "results",
            "mismatch_count"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "event",
        "data"
      ]
    },
    "e_evidence_integrity": {
      "description": "Logged against the producing agent and model. One fabrication is a defect; two is an untrustworthy witness.",
      "type": "object",
      "properties": {
        "event": {
          "const": "evidence_integrity"
        },
        "data": {
          "type": "object",
          "properties": {
            "envelope_id": {
              "$ref": "common.json#/$defs/id"
            },
            "evidence_id": {
              "$ref": "common.json#/$defs/id"
            },
            "model": {
              "$ref": "common.json#/$defs/nonEmptyString"
            },
            "status": {
              "enum": [
                "MISMATCH",
                "UNREPLAYABLE"
              ]
            },
            "downgraded_assertions": {
              "type": "array",
              "items": {
                "$ref": "common.json#/$defs/id"
              }
            },
            "demoted_findings": {
              "type": "array",
              "items": {
                "$ref": "common.json#/$defs/id"
              }
            },
            "envelope_rejected": {
              "type": "boolean"
            }
          },
          "required": [
            "envelope_id",
            "evidence_id",
            "model",
            "status",
            "downgraded_assertions",
            "demoted_findings",
            "envelope_rejected"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "event",
        "data"
      ]
    },
    "e_mutation": {
      "type": "object",
      "properties": {
        "event": {
          "const": "mutation"
        },
        "data": {
          "$ref": "adapter.json#/$defs/mutationEvent"
        }
      },
      "required": [
        "event",
        "data"
      ]
    },
    "e_adapter_call": {
      "type": "object",
      "properties": {
        "event": {
          "const": "adapter_call"
        },
        "data": {
          "$ref": "adapter.json#/$defs/callRecord"
        }
      },
      "required": [
        "event",
        "data"
      ]
    },
    "e_dispatch_rollback": {
      "type": "object",
      "properties": {
        "event": {
          "const": "dispatch_rollback"
        },
        "data": {
          "type": "object",
          "properties": {
            "rolled_back_dispatch": {
              "$ref": "common.json#/$defs/id"
            },
            "reversed": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "adapter": {
                    "$ref": "common.json#/$defs/nonEmptyString"
                  },
                  "op": {
                    "$ref": "common.json#/$defs/nonEmptyString"
                  },
                  "target": {
                    "$ref": "common.json#/$defs/nonEmptyString"
                  },
                  "reversal_op": {
                    "$ref": "common.json#/$defs/nonEmptyString"
                  },
                  "outcome": {
                    "enum": [
                      "REVERSED",
                      "FAILED"
                    ]
                  }
                },
                "required": [
                  "adapter",
                  "op",
                  "target",
                  "reversal_op",
                  "outcome"
                ],
                "additionalProperties": false
              }
            },
            "new_dispatch_id": {
              "type": [
                "string",
                "null"
              ],
              "minLength": 1
            },
            "blocked_non_reversible": {
              "description": "True where the dispatch performed a reversal: null operation. Such a dispatch is never automatically retried.",
              "type": "boolean"
            }
          },
          "required": [
            "rolled_back_dispatch",
            "reversed",
            "new_dispatch_id",
            "blocked_non_reversible"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "event",
        "data"
      ]
    },
    "e_idempotency": {
      "type": "object",
      "properties": {
        "event": {
          "const": "idempotency"
        },
        "data": {
          "type": "object",
          "properties": {
            "key": {
              "type": "string"
            },
            "scope": {
              "enum": [
                "dispatch",
                "work_item"
              ]
            },
            "adapter": {
              "$ref": "common.json#/$defs/nonEmptyString"
            },
            "op": {
              "$ref": "common.json#/$defs/nonEmptyString"
            },
            "verdict": {
              "description": "A work-item-scoped key hit is verified, never trusted. Unreachable is neither a return nor a re-execute.",
              "enum": [
                "RECORDED",
                "DEDUPLICATED",
                "IDEMPOTENCY_DIVERGENCE",
                "AMBIGUOUS_STATE"
              ]
            },
            "reread": {
              "oneOf": [
                {
                  "enum": [
                    "PRESENT",
                    "ABSENT",
                    "UNREACHABLE",
                    "NOT_ATTEMPTED"
                  ]
                },
                {
                  "type": "null"
                }
              ]
            },
            "detail": {
              "type": "string"
            }
          },
          "required": [
            "key",
            "scope",
            "adapter",
            "op",
            "verdict",
            "reread",
            "detail"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "event",
        "data"
      ]
    },
    "e_gate_fired": {
      "type": "object",
      "properties": {
        "event": {
          "const": "gate_fired"
        },
        "data": {
          "type": "object",
          "properties": {
            "gate": {
              "$ref": "common.json#/$defs/gate"
            },
            "target": {
              "$ref": "common.json#/$defs/nonEmptyString"
            },
            "trigger": {
              "enum": [
                "classifier",
                "self_declaration",
                "kernel_accounting",
                "kernel_policy"
              ]
            },
            "classifier_id": {
              "type": [
                "string",
                "null"
              ],
              "minLength": 1
            },
            "classification": {
              "oneOf": [
                {
                  "$ref": "adapter.json#/$defs/classification"
                },
                {
                  "type": "null"
                }
              ]
            },
            "request_id": {
              "type": [
                "string",
                "null"
              ],
              "minLength": 1
            }
          },
          "required": [
            "gate",
            "target",
            "trigger",
            "classifier_id",
            "classification",
            "request_id"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "event",
        "data"
      ]
    },
    "e_authorization_requested": {
      "type": "object",
      "properties": {
        "event": {
          "const": "authorization_requested"
        },
        "data": {
          "$ref": "authorization.json#/$defs/authorizationRequest"
        }
      },
      "required": [
        "event",
        "data"
      ]
    },
    "e_authorization_decided": {
      "type": "object",
      "properties": {
        "event": {
          "const": "authorization_decided"
        },
        "data": {
          "type": "object",
          "properties": {
            "request_id": {
              "$ref": "common.json#/$defs/id"
            },
            "decision": {
              "enum": [
                "GRANTED",
                "DENIED",
                "EXPIRED",
                "REVOKED"
              ]
            },
            "grant": {
              "oneOf": [
                {
                  "$ref": "authorization.json#/$defs/authorizationGrant"
                },
                {
                  "type": "null"
                }
              ]
            },
            "decided_by": {
              "type": [
                "string",
                "null"
              ],
              "minLength": 1
            },
            "reason": {
              "type": "string"
            }
          },
          "required": [
            "request_id",
            "decision",
            "grant",
            "decided_by",
            "reason"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "event",
        "data"
      ]
    },
    "e_scope_violation": {
      "type": "object",
      "properties": {
        "event": {
          "const": "scope_violation"
        },
        "data": {
          "$ref": "#/$defs/pathRefusal"
        }
      },
      "required": [
        "event",
        "data"
      ]
    },
    "e_security_violation": {
      "description": "Aborts the dispatch immediately and is reported regardless of the run's outcome. An agent that attempted it is worth knowing about even if it failed.",
      "type": "object",
      "properties": {
        "event": {
          "const": "security_violation"
        },
        "data": {
          "$ref": "#/$defs/pathRefusal"
        }
      },
      "required": [
        "event",
        "data"
      ]
    },
    "e_conflict": {
      "type": "object",
      "properties": {
        "event": {
          "const": "conflict"
        },
        "data": {
          "type": "object",
          "properties": {
            "conflict_id": {
              "$ref": "common.json#/$defs/id"
            },
            "subject": {
              "$ref": "common.json#/$defs/nonEmptyString"
            },
            "position_a": {
              "$ref": "#/$defs/conflictPosition"
            },
            "position_b": {
              "$ref": "#/$defs/conflictPosition"
            },
            "phase": {
              "enum": [
                "DETECTED",
                "RESOLVED_BY_RULE",
                "DELEGATED",
                "RESOLVED_ON_MERITS",
                "ESCALATED"
              ]
            },
            "winner": {
              "enum": [
                "A",
                "B",
                "NONE"
              ]
            },
            "rule": {
              "type": [
                "string",
                "null"
              ]
            },
            "detail": {
              "type": "string"
            }
          },
          "required": [
            "conflict_id",
            "subject",
            "position_a",
            "position_b",
            "phase",
            "winner",
            "rule",
            "detail"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "event",
        "data"
      ]
    },
    "e_budget": {
      "type": "object",
      "properties": {
        "event": {
          "const": "budget"
        },
        "data": {
          "type": "object",
          "properties": {
            "kind": {
              "enum": [
                "CONSUMED",
                "EXCEEDED"
              ]
            },
            "counter": {
              "$ref": "common.json#/$defs/nonEmptyString"
            },
            "scope": {
              "enum": [
                "run",
                "work_item"
              ]
            },
            "value": {
              "type": "number",
              "minimum": 0
            },
            "cap": {
              "type": [
                "number",
                "null"
              ],
              "minimum": 0
            },
            "tried": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          },
          "required": [
            "kind",
            "counter",
            "scope",
            "value",
            "cap",
            "tried"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "event",
        "data"
      ]
    },
    "e_dod_computed": {
      "type": "object",
      "properties": {
        "event": {
          "const": "dod_computed"
        },
        "data": {
          "$ref": "dod.json#/$defs/completionReport"
        }
      },
      "required": [
        "event",
        "data"
      ]
    },
    "e_source_drift": {
      "type": "object",
      "properties": {
        "event": {
          "const": "source_drift"
        },
        "data": {
          "$ref": "dod.json#/$defs/sourceDrift"
        }
      },
      "required": [
        "event",
        "data"
      ]
    },
    "e_reresolved": {
      "type": "object",
      "properties": {
        "event": {
          "const": "reresolved"
        },
        "data": {
          "type": "object",
          "properties": {
            "reason": {
              "$ref": "common.json#/$defs/nonEmptyString"
            },
            "evidence": {
              "type": "array",
              "items": {
                "$ref": "common.json#/$defs/id"
              }
            },
            "count": {
              "type": "integer",
              "minimum": 1
            },
            "cap": {
              "type": "integer",
              "minimum": 1
            },
            "new_run_id": {
              "type": [
                "string",
                "null"
              ],
              "minLength": 1
            }
          },
          "required": [
            "reason",
            "evidence",
            "count",
            "cap",
            "new_run_id"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "event",
        "data"
      ]
    },
    "e_child_work_item": {
      "type": "object",
      "properties": {
        "event": {
          "const": "child_work_item"
        },
        "data": {
          "type": "object",
          "properties": {
            "action": {
              "enum": [
                "CREATED",
                "LINKED",
                "REFUSED"
              ]
            },
            "child_id": {
              "type": [
                "string",
                "null"
              ],
              "minLength": 1
            },
            "external_identity": {
              "type": [
                "string",
                "null"
              ],
              "minLength": 1
            },
            "depends_on": {
              "type": "array",
              "items": {
                "$ref": "common.json#/$defs/id"
              }
            },
            "reason": {
              "type": "string"
            }
          },
          "required": [
            "action",
            "child_id",
            "external_identity",
            "depends_on",
            "reason"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "event",
        "data"
      ]
    },
    "e_lease": {
      "type": "object",
      "properties": {
        "event": {
          "const": "lease"
        },
        "data": {
          "type": "object",
          "properties": {
            "action": {
              "enum": [
                "ACQUIRED",
                "REFUSED",
                "RECLAIMED",
                "RELEASED"
              ]
            },
            "run_id": {
              "$ref": "common.json#/$defs/id"
            },
            "active_run_id": {
              "type": [
                "string",
                "null"
              ],
              "minLength": 1
            },
            "abandoned_run_id": {
              "type": [
                "string",
                "null"
              ],
              "minLength": 1
            },
            "holder": {
              "$ref": "common.json#/$defs/nonEmptyString"
            }
          },
          "required": [
            "action",
            "run_id",
            "active_run_id",
            "abandoned_run_id",
            "holder"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "event",
        "data"
      ]
    },
    "e_recovery": {
      "type": "object",
      "properties": {
        "event": {
          "const": "recovery"
        },
        "data": {
          "type": "object",
          "properties": {
            "phase": {
              "enum": [
                "STARTED",
                "PARTIAL_LINE_DISCARDED",
                "INTERRUPTED_DISPATCH_FOUND",
                "COMPLETED"
              ]
            },
            "replayed_events": {
              "type": "integer",
              "minimum": 0
            },
            "discarded_bytes": {
              "type": "integer",
              "minimum": 0
            },
            "interrupted_dispatch": {
              "type": [
                "string",
                "null"
              ],
              "minLength": 1
            },
            "detail": {
              "type": "string"
            }
          },
          "required": [
            "phase",
            "replayed_events",
            "discarded_bytes",
            "interrupted_dispatch",
            "detail"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "event",
        "data"
      ]
    },
    "e_selection": {
      "type": "object",
      "properties": {
        "event": {
          "const": "selection"
        },
        "data": {
          "type": "object",
          "properties": {
            "kind": {
              "enum": [
                "MODEL",
                "SKILL",
                "AGENT"
              ]
            },
            "selected": {
              "type": [
                "string",
                "null"
              ],
              "minLength": 1
            },
            "candidates": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "id": {
                    "$ref": "common.json#/$defs/nonEmptyString"
                  },
                  "score": {
                    "type": "number"
                  },
                  "reasons": {
                    "type": "array",
                    "items": {
                      "type": "string"
                    }
                  },
                  "excluded_because": {
                    "type": [
                      "string",
                      "null"
                    ]
                  }
                },
                "required": [
                  "id",
                  "score",
                  "reasons",
                  "excluded_because"
                ],
                "additionalProperties": false
              }
            },
            "why": {
              "$ref": "common.json#/$defs/nonEmptyString"
            },
            "escalated_from": {
              "type": [
                "string",
                "null"
              ],
              "minLength": 1
            },
            "escalation_trigger": {
              "type": [
                "string",
                "null"
              ]
            }
          },
          "required": [
            "kind",
            "selected",
            "candidates",
            "why",
            "escalated_from",
            "escalation_trigger"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "event",
        "data"
      ]
    },
    "e_question": {
      "type": "object",
      "properties": {
        "event": {
          "const": "question"
        },
        "data": {
          "type": "object",
          "properties": {
            "phase": {
              "enum": [
                "ASKED",
                "ANSWERED",
                "TIMED_OUT"
              ]
            },
            "question": {
              "$ref": "common.json#/$defs/nonEmptyString"
            },
            "readings": {
              "description": "One question, both readings, the evidence for each, and what AgentOS would do under each.",
              "type": "array",
              "minItems": 2,
              "items": {
                "type": "object",
                "properties": {
                  "reading": {
                    "$ref": "common.json#/$defs/nonEmptyString"
                  },
                  "evidence": {
                    "type": "array",
                    "items": {
                      "$ref": "common.json#/$defs/id"
                    }
                  },
                  "would_do": {
                    "$ref": "common.json#/$defs/nonEmptyString"
                  }
                },
                "required": [
                  "reading",
                  "evidence",
                  "would_do"
                ],
                "additionalProperties": false
              }
            },
            "answer": {
              "type": [
                "string",
                "null"
              ]
            },
            "answered_by": {
              "type": [
                "string",
                "null"
              ],
              "minLength": 1
            }
          },
          "required": [
            "phase",
            "question",
            "readings",
            "answer",
            "answered_by"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "event",
        "data"
      ]
    },
    "e_discovery": {
      "type": "object",
      "properties": {
        "event": {
          "const": "discovery"
        },
        "data": {
          "type": "object",
          "properties": {
            "kind": {
              "enum": [
                "TIER_RUN",
                "ON_DEMAND_REQUESTED",
                "TARGETED_PROBE",
                "REPROBE_STALE"
              ]
            },
            "tier": {
              "type": [
                "integer",
                "null"
              ],
              "minimum": 1,
              "maximum": 3
            },
            "probes": {
              "type": "array",
              "items": {
                "$ref": "common.json#/$defs/nonEmptyString"
              }
            },
            "reason": {
              "$ref": "common.json#/$defs/nonEmptyString"
            },
            "requested_sections": {
              "type": "array",
              "items": {
                "$ref": "context-package.json#/$defs/sectionName"
              }
            }
          },
          "required": [
            "kind",
            "tier",
            "probes",
            "reason",
            "requested_sections"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "event",
        "data"
      ]
    },
    "e_context_package_versioned": {
      "type": "object",
      "properties": {
        "event": {
          "const": "context_package_versioned"
        },
        "data": {
          "type": "object",
          "properties": {
            "version": {
              "type": "integer",
              "minimum": 1
            },
            "tier": {
              "type": "integer",
              "minimum": 1,
              "maximum": 3
            },
            "path": {
              "$ref": "common.json#/$defs/nonEmptyString"
            },
            "supersedes": {
              "type": [
                "integer",
                "null"
              ],
              "minimum": 1
            }
          },
          "required": [
            "version",
            "tier",
            "path",
            "supersedes"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "event",
        "data"
      ]
    },
    "e_capability_registry_updated": {
      "type": "object",
      "properties": {
        "event": {
          "const": "capability_registry_updated"
        },
        "data": {
          "type": "object",
          "properties": {
            "version": {
              "type": "integer",
              "minimum": 1
            },
            "path": {
              "$ref": "common.json#/$defs/nonEmptyString"
            },
            "record_count": {
              "type": "integer",
              "minimum": 0
            },
            "edge_count": {
              "type": "integer",
              "minimum": 0
            },
            "updated_by": {
              "$ref": "common.json#/$defs/agentRole"
            }
          },
          "required": [
            "version",
            "path",
            "record_count",
            "edge_count",
            "updated_by"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "event",
        "data"
      ]
    },
    "e_work_item_lifecycle": {
      "type": "object",
      "properties": {
        "event": {
          "const": "work_item_lifecycle"
        },
        "data": {
          "type": "object",
          "properties": {
            "from": {
              "$ref": "common.json#/$defs/workItemLifecycle"
            },
            "to": {
              "$ref": "common.json#/$defs/workItemLifecycle"
            },
            "reason": {
              "$ref": "common.json#/$defs/nonEmptyString"
            },
            "evidence": {
              "type": "array",
              "items": {
                "$ref": "common.json#/$defs/id"
              }
            },
            "decided_by": {
              "enum": [
                "kernel",
                "human"
              ]
            }
          },
          "required": [
            "from",
            "to",
            "reason",
            "evidence",
            "decided_by"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "event",
        "data"
      ]
    },
    "e_tool_surface_conformance": {
      "description": "D-2's binding condition. An SDK upgrade that adds a tool must break this check rather than pass quietly.",
      "type": "object",
      "properties": {
        "event": {
          "const": "tool_surface_conformance"
        },
        "data": {
          "type": "object",
          "properties": {
            "substrate": {
              "$ref": "common.json#/$defs/nonEmptyString"
            },
            "verdict": {
              "enum": [
                "CONFORMS",
                "UNEXPECTED_TOOLS",
                "MISSING_TOOLS",
                "UNVERIFIABLE"
              ]
            },
            "expected": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "effective": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "unexpected": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "missing": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "detail": {
              "type": "string"
            }
          },
          "required": [
            "substrate",
            "verdict",
            "expected",
            "effective",
            "unexpected",
            "missing",
            "detail"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "event",
        "data"
      ]
    },
    "e_intake_instruction_attempt": {
      "description": "Intake content naming a template, requesting a stage, setting a confidence or trust class, widening a scope, or claiming an authorization has no effect, and the attempt is recorded.",
      "type": "object",
      "properties": {
        "event": {
          "const": "intake_instruction_attempt"
        },
        "data": {
          "type": "object",
          "properties": {
            "intake_id": {
              "$ref": "common.json#/$defs/id"
            },
            "trust_class": {
              "$ref": "common.json#/$defs/trustClass"
            },
            "attempted": {
              "type": "array",
              "minItems": 1,
              "items": {
                "enum": [
                  "NAME_TEMPLATE",
                  "REQUEST_STAGE",
                  "SET_CONFIDENCE",
                  "SET_TRUST_CLASS",
                  "WIDEN_SCOPE",
                  "CLAIM_AUTHORIZATION",
                  "CANCEL_RUN"
                ]
              }
            },
            "excerpt": {
              "type": "string"
            },
            "effect": {
              "const": "NONE"
            }
          },
          "required": [
            "intake_id",
            "trust_class",
            "attempted",
            "excerpt",
            "effect"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "event",
        "data"
      ]
    },
    "e_duplicate_candidates": {
      "type": "object",
      "properties": {
        "event": {
          "const": "duplicate_candidates"
        },
        "data": {
          "type": "object",
          "properties": {
            "candidates": {
              "type": "array",
              "minItems": 1,
              "items": {
                "$ref": "common.json#/$defs/id"
              }
            },
            "basis": {
              "const": "identical scope and normalized title"
            },
            "action": {
              "const": "SURFACED"
            }
          },
          "required": [
            "candidates",
            "basis",
            "action"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "event",
        "data"
      ]
    },
    "e_predicate_evaluated": {
      "description": "Both the agent's claim and the kernel's evaluated value, so a systematically over-claiming agent becomes visible in the run narrative.",
      "type": "object",
      "properties": {
        "event": {
          "const": "predicate_evaluated"
        },
        "data": {
          "type": "object",
          "properties": {
            "predicate": {
              "$ref": "common.json#/$defs/nonEmptyString"
            },
            "evaluated": {
              "$ref": "common.json#/$defs/predicateValue"
            },
            "claim": {
              "type": [
                "string",
                "null"
              ]
            },
            "inputs": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "reprobed": {
              "type": "boolean"
            },
            "reason": {
              "type": "string"
            }
          },
          "required": [
            "predicate",
            "evaluated",
            "claim",
            "inputs",
            "reprobed",
            "reason"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "event",
        "data"
      ]
    },
    "e_note": {
      "type": "object",
      "properties": {
        "event": {
          "const": "note"
        },
        "data": {
          "type": "object",
          "properties": {
            "topic": {
              "$ref": "common.json#/$defs/nonEmptyString"
            },
            "detail": {
              "$ref": "common.json#/$defs/nonEmptyString"
            }
          },
          "required": [
            "topic",
            "detail"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "event",
        "data"
      ]
    },
    "checkOutcome": {
      "type": "object",
      "properties": {
        "check": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "result": {
          "enum": [
            "PASS",
            "FAIL",
            "NOT_APPLICABLE",
            "INDETERMINATE"
          ]
        },
        "detail": {
          "type": "string"
        }
      },
      "required": [
        "check",
        "result",
        "detail"
      ],
      "additionalProperties": false
    },
    "receiptStep": {
      "enum": [
        "schema",
        "cross_field",
        "reconciliation",
        "evidence_verification",
        "transition",
        "persist",
        "merge",
        "conflict_check"
      ]
    },
    "pathRefusal": {
      "type": "object",
      "properties": {
        "adapter": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "op": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "requested": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "resolved": {
          "type": [
            "string",
            "null"
          ]
        },
        "rule": {
          "enum": [
            "worktree_root",
            "mandate_in_scope",
            "mandate_out_of_scope",
            "deny_list",
            "symlink_escape",
            "unresolvable"
          ]
        },
        "deny_list_entry": {
          "type": [
            "string",
            "null"
          ]
        },
        "aborted_dispatch": {
          "type": "boolean"
        },
        "detail": {
          "type": "string"
        }
      },
      "required": [
        "adapter",
        "op",
        "requested",
        "resolved",
        "rule",
        "deny_list_entry",
        "aborted_dispatch",
        "detail"
      ],
      "additionalProperties": false
    },
    "conflictPosition": {
      "type": "object",
      "properties": {
        "source": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "claim": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "confidence": {
          "$ref": "common.json#/$defs/confidenceClass"
        },
        "evidence": {
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/id"
          }
        }
      },
      "required": [
        "source",
        "claim",
        "confidence",
        "evidence"
      ],
      "additionalProperties": false
    }
  }
};

export const EVIDENCE_SCHEMA: JsonSchemaObject = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://agentos.dev/schema/evidence.json",
  "title": "Evidence",
  "description": "An observation the kernel can re-execute. `locator` is what makes evidence a claim the system can check rather than a claim it must believe.",
  "type": "object",
  "properties": {
    "id": {
      "$ref": "common.json#/$defs/id"
    },
    "kind": {
      "$ref": "common.json#/$defs/evidenceKind"
    },
    "locator": {
      "$ref": "common.json#/$defs/locator"
    },
    "ref": {
      "description": "Human-readable pointer. For human reading only; never the basis of a check.",
      "$ref": "common.json#/$defs/nonEmptyString"
    },
    "excerpt": {
      "type": "string"
    },
    "observed_at": {
      "$ref": "common.json#/$defs/timestamp"
    },
    "reproducible": {
      "description": "False for a genuinely unrepeatable observation, which caps the assertion it supports at INFERENCE.",
      "type": "boolean"
    },
    "predicate": {
      "description": "Mandatory for kind `log` and `metric`: the kernel re-evaluates a predicate rather than comparing a volatile raw value.",
      "$ref": "#/$defs/predicate"
    },
    "verification": {
      "description": "Kernel-owned. An envelope arriving with this populated is a contract violation.",
      "$ref": "#/$defs/verification"
    }
  },
  "required": [
    "id",
    "kind",
    "locator",
    "ref",
    "excerpt",
    "observed_at",
    "reproducible"
  ],
  "additionalProperties": false,
  "$defs": {
    "predicate": {
      "description": "A machine-evaluable statement about an observation, e.g. `count == 0` or `error_rate < 0.01`.",
      "type": "object",
      "properties": {
        "subject": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "operator": {
          "enum": [
            "eq",
            "ne",
            "lt",
            "lte",
            "gt",
            "gte",
            "contains",
            "not_contains",
            "matches"
          ]
        },
        "operand": {
          "type": [
            "string",
            "number",
            "boolean",
            "null"
          ]
        }
      },
      "required": [
        "subject",
        "operator",
        "operand"
      ],
      "additionalProperties": false
    },
    "verification": {
      "type": "object",
      "properties": {
        "status": {
          "$ref": "common.json#/$defs/verificationStatus"
        },
        "at": {
          "$ref": "common.json#/$defs/timestamp"
        },
        "by": {
          "const": "kernel"
        },
        "matches": {
          "type": [
            "boolean",
            "null"
          ]
        },
        "detail": {
          "type": "string"
        }
      },
      "required": [
        "status",
        "at",
        "by",
        "matches"
      ],
      "additionalProperties": false
    }
  }
};

export const FINDING_SCHEMA: JsonSchemaObject = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://agentos.dev/schema/finding.json",
  "title": "Envelope section shapes",
  "description": "Finding, Blocker, Unknown, Assumption, Recommendation, ArtifactChange and Coverage. Grouped because they are the envelope's sections and only the envelope uses them.",
  "$defs": {
    "finding": {
      "description": "A finding without evidence is not a finding; it is a recommendation of category `hypothesis`.",
      "type": "object",
      "properties": {
        "id": {
          "$ref": "common.json#/$defs/id"
        },
        "title": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "severity": {
          "$ref": "common.json#/$defs/severity"
        },
        "category": {
          "$ref": "#/$defs/findingCategory"
        },
        "capability": {
          "type": [
            "string",
            "null"
          ],
          "minLength": 1
        },
        "chain_stage": {
          "oneOf": [
            {
              "$ref": "common.json#/$defs/chainStage"
            },
            {
              "type": "null"
            }
          ]
        },
        "description": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "evidence": {
          "type": "array",
          "minItems": 1,
          "items": {
            "$ref": "common.json#/$defs/id"
          }
        },
        "confidence": {
          "$ref": "common.json#/$defs/confidenceClass"
        },
        "impact": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "remediation_hint": {
          "type": "string"
        }
      },
      "required": [
        "id",
        "title",
        "severity",
        "category",
        "capability",
        "chain_stage",
        "description",
        "evidence",
        "confidence",
        "impact"
      ],
      "additionalProperties": false
    },
    "findingCategory": {
      "description": "The ten structural detectors of CAPABILITY_MODEL section 5, plus the data-semantics, test-quality and generic categories the Auditor's standing search list names.",
      "enum": [
        "orphan-writer",
        "orphan-reader",
        "orphan-store",
        "dead-calculation",
        "broken-chain",
        "phantom-api",
        "phantom-ui",
        "duplicate-ownership",
        "field-loss",
        "provenance-break",
        "fabricated-default",
        "collapsed-absence",
        "missing-provenance",
        "missing-timestamp",
        "stale-documentation",
        "test-asserts-on-mock",
        "unproven-completion",
        "structural",
        "correctness",
        "security",
        "other"
      ]
    },
    "blocker": {
      "type": "object",
      "properties": {
        "id": {
          "$ref": "common.json#/$defs/id"
        },
        "kind": {
          "$ref": "#/$defs/blockerKind"
        },
        "description": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "conflicting_requirements": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "options": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "needs": {
          "$ref": "#/$defs/needs"
        },
        "evidence": {
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/id"
          }
        }
      },
      "required": [
        "id",
        "kind",
        "description",
        "needs",
        "evidence"
      ],
      "additionalProperties": false
    },
    "blockerKind": {
      "enum": [
        "ARCHITECTURE_CONTRADICTION",
        "MISSING_ACCESS",
        "MISSING_CAPABILITY",
        "AMBIGUOUS_GOAL",
        "AMBIGUOUS_STATE",
        "WORK_ITEM_MISCLASSIFIED",
        "AUTHORIZATION_REQUIRED",
        "BUDGET_EXHAUSTED",
        "UNRESOLVED_CONFLICT",
        "EXTERNAL_DEPENDENCY"
      ]
    },
    "needs": {
      "enum": [
        "architect_decision",
        "human_decision",
        "human_authorization",
        "access_grant",
        "additional_discovery",
        "external_fix",
        "re_resolution"
      ]
    },
    "unknown": {
      "type": "object",
      "properties": {
        "id": {
          "$ref": "common.json#/$defs/id"
        },
        "subject": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "reason": {
          "$ref": "common.json#/$defs/absenceReason"
        },
        "attempted": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "recoverable_by": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "blocks": {
          "description": "Downstream obligations that cannot be met. Every entry must name a real obligation; a decorative unknown is a contract violation.",
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/nonEmptyString"
          }
        }
      },
      "required": [
        "id",
        "subject",
        "reason",
        "attempted",
        "recoverable_by",
        "blocks"
      ],
      "additionalProperties": false
    },
    "assumption": {
      "type": "object",
      "properties": {
        "id": {
          "$ref": "common.json#/$defs/id"
        },
        "statement": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "breaks_if_wrong": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "verify_by": {
          "$ref": "common.json#/$defs/nonEmptyString"
        }
      },
      "required": [
        "id",
        "statement",
        "breaks_if_wrong",
        "verify_by"
      ],
      "additionalProperties": false
    },
    "recommendation": {
      "type": "object",
      "properties": {
        "id": {
          "$ref": "common.json#/$defs/id"
        },
        "category": {
          "enum": [
            "hypothesis",
            "out-of-scope",
            "improvement",
            "risk"
          ]
        },
        "statement": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "priority": {
          "$ref": "common.json#/$defs/severity"
        },
        "rationale": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "owner_role": {
          "oneOf": [
            {
              "$ref": "common.json#/$defs/agentRole"
            },
            {
              "type": "null"
            }
          ]
        },
        "confirming_observation": {
          "description": "Mandatory for `hypothesis`: the observation that would turn a suspicion into a finding.",
          "type": [
            "string",
            "null"
          ]
        },
        "evidence": {
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/id"
          }
        }
      },
      "required": [
        "id",
        "category",
        "statement",
        "priority",
        "rationale",
        "owner_role"
      ],
      "additionalProperties": false
    },
    "artifactChange": {
      "description": "The agent's account of a mutation. Reconciled against adapter mutation events; it is not the reversal record.",
      "type": "object",
      "properties": {
        "kind": {
          "enum": [
            "file",
            "commit",
            "branch",
            "migration",
            "ticket",
            "runtime",
            "pr",
            "comment"
          ]
        },
        "target": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "change": {
          "enum": [
            "created",
            "modified",
            "deleted",
            "renamed",
            "transitioned"
          ]
        },
        "sha": {
          "type": [
            "string",
            "null"
          ]
        },
        "branch": {
          "type": [
            "string",
            "null"
          ]
        }
      },
      "required": [
        "kind",
        "target",
        "change"
      ],
      "additionalProperties": false
    },
    "coverage": {
      "description": "The difference between 'found nothing there' and 'never looked there'. Mandatory, and reconciled against the dispatch's adapter call log.",
      "type": "object",
      "properties": {
        "scope_examined": {
          "type": "array",
          "minItems": 1,
          "items": {
            "$ref": "common.json#/$defs/pathGlob"
          }
        },
        "scope_not_examined": {
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/pathGlob"
          }
        },
        "confidence": {
          "$ref": "common.json#/$defs/confidenceClass"
        },
        "notes": {
          "type": "string"
        }
      },
      "required": [
        "scope_examined",
        "scope_not_examined",
        "confidence"
      ],
      "additionalProperties": false
    }
  }
};

export const HANDOFF_ENVELOPE_SCHEMA: JsonSchemaObject = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://agentos.dev/schema/handoff-envelope.json",
  "title": "HandoffEnvelope",
  "description": "The only thing that crosses the boundary between agents. Conversation is never the transport.",
  "type": "object",
  "properties": {
    "envelope_version": {
      "const": "1.2"
    },
    "work_item_id": {
      "$ref": "common.json#/$defs/id"
    },
    "run_id": {
      "$ref": "common.json#/$defs/id"
    },
    "envelope_id": {
      "$ref": "common.json#/$defs/id"
    },
    "dispatch_id": {
      "description": "Echoes the dispatch this envelope answers, so a substrate returning the wrong envelope is detectable rather than merged.",
      "$ref": "common.json#/$defs/id"
    },
    "agent": {
      "$ref": "common.json#/$defs/agentRole"
    },
    "agent_version": {
      "$ref": "common.json#/$defs/nonEmptyString"
    },
    "model": {
      "$ref": "common.json#/$defs/nonEmptyString"
    },
    "skills_used": {
      "type": "array",
      "items": {
        "$ref": "common.json#/$defs/nonEmptyString"
      }
    },
    "stage_in": {
      "$ref": "common.json#/$defs/stage"
    },
    "started_at": {
      "$ref": "common.json#/$defs/timestamp"
    },
    "completed_at": {
      "$ref": "common.json#/$defs/timestamp"
    },
    "cost": {
      "$ref": "common.json#/$defs/cost"
    },
    "status": {
      "$ref": "#/$defs/status"
    },
    "summary": {
      "$ref": "common.json#/$defs/nonEmptyString"
    },
    "findings": {
      "type": "array",
      "items": {
        "$ref": "finding.json#/$defs/finding"
      }
    },
    "evidence": {
      "type": "array",
      "items": {
        "$ref": "evidence.json"
      }
    },
    "assumptions": {
      "type": "array",
      "items": {
        "$ref": "finding.json#/$defs/assumption"
      }
    },
    "unknowns": {
      "type": "array",
      "items": {
        "$ref": "finding.json#/$defs/unknown"
      }
    },
    "artifacts_changed": {
      "type": "array",
      "items": {
        "$ref": "finding.json#/$defs/artifactChange"
      }
    },
    "recommendations": {
      "type": "array",
      "items": {
        "$ref": "finding.json#/$defs/recommendation"
      }
    },
    "blockers": {
      "type": "array",
      "items": {
        "$ref": "finding.json#/$defs/blocker"
      }
    },
    "coverage": {
      "$ref": "finding.json#/$defs/coverage"
    },
    "outputs": {
      "description": "The dispatch's `required_outputs`, filled. Keyed by output name; a missing or null key is an unfilled output, which is what separates PARTIAL from COMPLETE.",
      "type": "object",
      "propertyNames": {
        "$ref": "common.json#/$defs/nonEmptyString"
      }
    },
    "dod_verdicts": {
      "description": "Per-criterion verdicts this stage owes. The kernel does the arithmetic and never judges a criterion itself.",
      "type": "array",
      "items": {
        "$ref": "dod.json#/$defs/criterionVerdict"
      }
    },
    "proposals": {
      "$ref": "#/$defs/proposals"
    },
    "next_action": {
      "description": "A proposal. The kernel validates it against the frozen graph and evaluates the transition predicate itself.",
      "oneOf": [
        {
          "$ref": "#/$defs/nextAction"
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "envelope_version",
    "work_item_id",
    "run_id",
    "envelope_id",
    "dispatch_id",
    "agent",
    "agent_version",
    "model",
    "skills_used",
    "stage_in",
    "started_at",
    "completed_at",
    "cost",
    "status",
    "summary",
    "findings",
    "evidence",
    "assumptions",
    "unknowns",
    "artifacts_changed",
    "recommendations",
    "blockers",
    "coverage",
    "outputs",
    "dod_verdicts",
    "proposals",
    "next_action"
  ],
  "additionalProperties": false,
  "$defs": {
    "status": {
      "description": "Every value maps to exactly one kernel action (WORKFLOW_STATE_MACHINE section 4.2). PARTIAL is never a soft COMPLETE.",
      "enum": [
        "COMPLETE",
        "PARTIAL",
        "BLOCKED",
        "BLOCKED_BY_ARCHITECTURE",
        "FAILED",
        "REJECTED"
      ]
    },
    "nextAction": {
      "type": "object",
      "properties": {
        "proposed_stage": {
          "$ref": "common.json#/$defs/stage"
        },
        "proposed_agent": {
          "oneOf": [
            {
              "$ref": "common.json#/$defs/agentRole"
            },
            {
              "type": "null"
            }
          ]
        },
        "rationale": {
          "$ref": "common.json#/$defs/nonEmptyString"
        }
      },
      "required": [
        "proposed_stage",
        "proposed_agent",
        "rationale"
      ],
      "additionalProperties": false
    },
    "proposals": {
      "description": "The only place an agent may ask for something structural. Every key is optional and every one is a proposal the kernel admits, adjusts or refuses.",
      "type": "object",
      "properties": {
        "work_item": {
          "$ref": "work-item.json#/$defs/proposedWorkItem"
        },
        "workflow": {
          "$ref": "#/$defs/workflowProposal"
        },
        "decomposition": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/decompositionProposal"
          }
        },
        "triage": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/triageProposal"
          }
        },
        "cancellation": {
          "$ref": "#/$defs/cancellationProposal"
        },
        "dispatch": {
          "$ref": "#/$defs/dispatchProposal"
        },
        "arbitration": {
          "$ref": "#/$defs/arbitrationProposal"
        },
        "authorization_request": {
          "$ref": "authorization.json#/$defs/draftRequest"
        }
      },
      "additionalProperties": false
    },
    "workflowProposal": {
      "type": "object",
      "properties": {
        "template_id": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "include_optional": {
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/templateStage"
          }
        },
        "exclude_optional": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "stage": {
                "$ref": "common.json#/$defs/templateStage"
              },
              "claim": {
                "description": "A claim, never a decision. The kernel evaluates the stage's predicate itself and keeps the stage on TRUE or INDETERMINATE.",
                "$ref": "common.json#/$defs/nonEmptyString"
              },
              "rationale": {
                "$ref": "common.json#/$defs/nonEmptyString"
              }
            },
            "required": [
              "stage",
              "claim",
              "rationale"
            ],
            "additionalProperties": false
          }
        },
        "stage_mandates": {
          "description": "Per-stage mandate scope, bounded by and never exceeding the Work Item's admitted scope.",
          "type": "object",
          "patternProperties": {
            "^[A-Z_]+$": {
              "$ref": "common.json#/$defs/scope"
            }
          },
          "additionalProperties": false
        },
        "rationale": {
          "$ref": "common.json#/$defs/nonEmptyString"
        }
      },
      "required": [
        "template_id",
        "include_optional",
        "exclude_optional",
        "rationale"
      ],
      "additionalProperties": false
    },
    "decompositionProposal": {
      "type": "object",
      "properties": {
        "title": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "type": {
          "$ref": "common.json#/$defs/workItemType"
        },
        "scope": {
          "$ref": "common.json#/$defs/scope"
        },
        "desired_outcome": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "depends_on": {
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/nonEmptyString"
          }
        },
        "external_identity": {
          "type": [
            "string",
            "null"
          ],
          "minLength": 1
        }
      },
      "required": [
        "title",
        "type",
        "scope",
        "desired_outcome",
        "depends_on",
        "external_identity"
      ],
      "additionalProperties": false
    },
    "triageProposal": {
      "type": "object",
      "properties": {
        "thread_id": {
          "$ref": "common.json#/$defs/id"
        },
        "reading": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "remediation_scope": {
          "$ref": "common.json#/$defs/scope"
        },
        "separable": {
          "description": "The agent's reading of whether the remediation can be split off. Undeterminable is expressed as UNKNOWN and counts as inside scope.",
          "$ref": "common.json#/$defs/predicateValue"
        },
        "proposed_route": {
          "description": "Recorded and ignored. Routing is kernel scope containment.",
          "enum": [
            "COMMENT_RESOLUTION",
            "CHILD_WORK_ITEM",
            "SCOPE_EXPANSION"
          ]
        }
      },
      "required": [
        "thread_id",
        "reading",
        "remediation_scope",
        "separable",
        "proposed_route"
      ],
      "additionalProperties": false
    },
    "cancellationProposal": {
      "type": "object",
      "properties": {
        "work_item_id": {
          "$ref": "common.json#/$defs/id"
        },
        "to": {
          "enum": [
            "SUPERSEDED",
            "ABANDONED"
          ]
        },
        "evidence": {
          "type": "array",
          "minItems": 1,
          "items": {
            "$ref": "common.json#/$defs/id"
          }
        },
        "rationale": {
          "$ref": "common.json#/$defs/nonEmptyString"
        }
      },
      "required": [
        "work_item_id",
        "to",
        "evidence",
        "rationale"
      ],
      "additionalProperties": false
    },
    "dispatchProposal": {
      "description": "The Orchestrator's proposed next dispatch. The kernel selects; this is an input to ranking, not a bypass of it.",
      "type": "object",
      "properties": {
        "stage": {
          "$ref": "common.json#/$defs/stage"
        },
        "agent": {
          "$ref": "common.json#/$defs/agentRole"
        },
        "objective": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "mandate_scope": {
          "$ref": "common.json#/$defs/scope"
        },
        "advisory_notes": {
          "description": "Untrusted free text. Grants nothing, and no adapter consults it.",
          "type": "string"
        },
        "model_preference": {
          "type": [
            "string",
            "null"
          ],
          "minLength": 1
        },
        "skill_preference": {
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/nonEmptyString"
          }
        }
      },
      "required": [
        "stage",
        "agent",
        "objective",
        "mandate_scope",
        "advisory_notes"
      ],
      "additionalProperties": false
    },
    "arbitrationProposal": {
      "type": "object",
      "properties": {
        "conflict_id": {
          "$ref": "common.json#/$defs/id"
        },
        "classification": {
          "enum": [
            "FACTUAL",
            "INTERPRETIVE",
            "SCOPE"
          ]
        },
        "discriminating_observation": {
          "type": [
            "string",
            "null"
          ],
          "minLength": 1
        },
        "resolution": {
          "enum": [
            "A",
            "B",
            "CANNOT_SETTLE"
          ]
        },
        "rationale": {
          "$ref": "common.json#/$defs/nonEmptyString"
        }
      },
      "required": [
        "conflict_id",
        "classification",
        "discriminating_observation",
        "resolution",
        "rationale"
      ],
      "additionalProperties": false
    }
  }
};

export const INPUT_PACKAGE_SCHEMA: JsonSchemaObject = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://agentos.dev/schema/input-package.json",
  "title": "InputPackage",
  "description": "What an agent receives. A typed input, never a conversation. `prior_envelopes` are references to structured envelopes, not transcript text.",
  "type": "object",
  "properties": {
    "work_item_id": {
      "$ref": "common.json#/$defs/id"
    },
    "run_id": {
      "$ref": "common.json#/$defs/id"
    },
    "dispatch_id": {
      "description": "Seeds idempotency: every mutating adapter call in this dispatch derives its key from it.",
      "$ref": "common.json#/$defs/id"
    },
    "agent": {
      "$ref": "common.json#/$defs/agentRole"
    },
    "mandate_name": {
      "description": "Which of the role's mandates this dispatch is. Context Discovery has two: `resolution` before admission, `context` after it.",
      "$ref": "common.json#/$defs/nonEmptyString"
    },
    "stage": {
      "$ref": "common.json#/$defs/stage"
    },
    "work_item_ref": {
      "description": "Replaces v0.2's inlined goal. One authoritative statement of what is being attempted, read by every agent.",
      "type": [
        "string",
        "null"
      ],
      "minLength": 1
    },
    "intake_ref": {
      "description": "Populated for the resolution mandate, which runs before a Work Item exists.",
      "type": [
        "string",
        "null"
      ],
      "minLength": 1
    },
    "workflow": {
      "description": "Read-only, so an agent knows what comes after it. Insufficient for changing anything: the graph is frozen and the kernel evaluates the edges.",
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "template_id": {
              "$ref": "common.json#/$defs/nonEmptyString"
            },
            "version": {
              "$ref": "common.json#/$defs/nonEmptyString"
            },
            "stages_remaining": {
              "type": "array",
              "items": {
                "$ref": "common.json#/$defs/templateStage"
              }
            }
          },
          "required": [
            "template_id",
            "version",
            "stages_remaining"
          ],
          "additionalProperties": false
        },
        {
          "type": "null"
        }
      ]
    },
    "context_package_ref": {
      "type": [
        "string",
        "null"
      ],
      "minLength": 1
    },
    "context_sections": {
      "description": "The materialized subset. `required_inputs` bounds what is built, which is what keeps input size independent of run length.",
      "type": "object",
      "patternProperties": {
        "^[a-z_]+$": {}
      },
      "additionalProperties": false
    },
    "capability_registry_ref": {
      "type": [
        "string",
        "null"
      ],
      "minLength": 1
    },
    "prior_envelopes": {
      "type": "array",
      "items": {
        "$ref": "common.json#/$defs/id"
      }
    },
    "mandate": {
      "$ref": "#/$defs/mandate"
    },
    "required_inputs": {
      "type": "array",
      "items": {
        "$ref": "context-package.json#/$defs/sectionName"
      }
    },
    "required_outputs": {
      "type": "array",
      "items": {
        "$ref": "common.json#/$defs/nonEmptyString"
      }
    },
    "dod_profile_ref": {
      "type": [
        "string",
        "null"
      ],
      "minLength": 1
    },
    "dod_criteria_owed": {
      "type": "array",
      "items": {
        "$ref": "dod.json#/$defs/criterionId"
      }
    },
    "constraints": {
      "type": "array",
      "items": {
        "$ref": "common.json#/$defs/nonEmptyString"
      }
    },
    "authorization_scope": {
      "$ref": "#/$defs/authorizationScope"
    },
    "tools_granted": {
      "description": "The exact adapter operations this dispatch may reach. The effective tool surface is an allowlist, and a startup conformance check asserts it equals this set.",
      "type": "array",
      "items": {
        "$ref": "#/$defs/toolGrant"
      }
    },
    "skills_available": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/skillOffer"
      }
    },
    "model": {
      "$ref": "common.json#/$defs/nonEmptyString"
    },
    "budget": {
      "$ref": "#/$defs/dispatchBudget"
    }
  },
  "required": [
    "work_item_id",
    "run_id",
    "dispatch_id",
    "agent",
    "mandate_name",
    "stage",
    "work_item_ref",
    "intake_ref",
    "workflow",
    "context_package_ref",
    "context_sections",
    "capability_registry_ref",
    "prior_envelopes",
    "mandate",
    "required_inputs",
    "required_outputs",
    "dod_profile_ref",
    "dod_criteria_owed",
    "constraints",
    "authorization_scope",
    "tools_granted",
    "skills_available",
    "model",
    "budget"
  ],
  "additionalProperties": false,
  "$defs": {
    "mandate": {
      "description": "Structured, not prose. The adapters enforce in_scope and out_of_scope as path constraints on top of worktree confinement.",
      "type": "object",
      "properties": {
        "objective": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "in_scope": {
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/pathGlob"
          }
        },
        "out_of_scope": {
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/pathGlob"
          }
        },
        "capabilities": {
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/id"
          }
        },
        "advisory_notes": {
          "description": "Untrusted free text from the Orchestrator Agent. It grants nothing and no adapter consults it.",
          "type": "string"
        }
      },
      "required": [
        "objective",
        "in_scope",
        "out_of_scope",
        "capabilities",
        "advisory_notes"
      ],
      "additionalProperties": false
    },
    "authorizationScope": {
      "type": "object",
      "properties": {
        "autonomous": {
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/nonEmptyString"
          }
        },
        "gated": {
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/gate"
          }
        },
        "grants_held": {
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/id"
          }
        }
      },
      "required": [
        "autonomous",
        "gated",
        "grants_held"
      ],
      "additionalProperties": false
    },
    "toolGrant": {
      "type": "object",
      "properties": {
        "adapter": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "op": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "tool_name": {
          "description": "The name the substrate exposes. The conformance check compares effective tool names against exactly this set.",
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "description": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "args_schema": {
          "type": "object"
        }
      },
      "required": [
        "adapter",
        "op",
        "tool_name",
        "description",
        "args_schema"
      ],
      "additionalProperties": false
    },
    "skillOffer": {
      "description": "A suggestion to the agent, not an obligation. A skill that can spawn an agent never appears here.",
      "type": "object",
      "properties": {
        "id": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "source": {
          "enum": [
            "global",
            "repository",
            "plugin",
            "connector",
            "mcp",
            "builtin",
            "script"
          ]
        },
        "description": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "mutating": {
          "type": "boolean"
        }
      },
      "required": [
        "id",
        "source",
        "description",
        "mutating"
      ],
      "additionalProperties": false
    },
    "dispatchBudget": {
      "type": "object",
      "properties": {
        "max_usd": {
          "type": "number",
          "minimum": 0
        },
        "max_turns": {
          "type": "integer",
          "minimum": 1
        },
        "max_wall_clock_ms": {
          "type": "integer",
          "minimum": 1
        }
      },
      "required": [
        "max_usd",
        "max_turns",
        "max_wall_clock_ms"
      ],
      "additionalProperties": false
    }
  }
};

export const POLICY_SCHEMA: JsonSchemaObject = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://agentos.dev/schema/policy.json",
  "title": "Policy data",
  "description": "Every behaviour the design calls policy exists as data, and a mis-authored policy fails loudly at startup rather than quietly during a run. No threshold lives anywhere but here.",
  "$defs": {
    "predicateDefinition": {
      "description": "policies/predicates.json. A transition table whose branch conditions are prose is a table an agent decides.",
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "pattern": "^(reality|architecture|ux|audit|production|regression)\\.[a-z_]+$"
        },
        "family": {
          "enum": [
            "applicability",
            "reality"
          ]
        },
        "description": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "reads": {
          "description": "Which named inputs the evaluator consults. A predicate over an UNKNOWN input is INDETERMINATE, never FALSE.",
          "type": "array",
          "minItems": 1,
          "items": {
            "$ref": "common.json#/$defs/nonEmptyString"
          }
        },
        "freshness_class": {
          "description": "Which freshness window governs the inputs. A STALE input is re-probed before the predicate is evaluated.",
          "enum": [
            "git",
            "runtime",
            "repository",
            "intent",
            "agentos"
          ]
        },
        "evaluator": {
          "description": "The kernel evaluator that implements it. Naming it in data keeps the mapping auditable without putting the logic here.",
          "$ref": "common.json#/$defs/nonEmptyString"
        }
      },
      "required": [
        "name",
        "family",
        "description",
        "reads",
        "freshness_class",
        "evaluator"
      ],
      "additionalProperties": false
    },
    "predicateSet": {
      "type": "object",
      "properties": {
        "version": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "predicates": {
          "type": "array",
          "minItems": 1,
          "items": {
            "$ref": "#/$defs/predicateDefinition"
          }
        }
      },
      "required": [
        "version",
        "predicates"
      ],
      "additionalProperties": false
    },
    "floorRule": {
      "description": "policies/workflow-floor.json. Rules of the form: if the graph contains X, it must contain Y before it.",
      "type": "object",
      "properties": {
        "id": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "description": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "trigger": {
          "$ref": "#/$defs/floorTrigger"
        },
        "requires": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/floorRequirement"
          }
        },
        "forbids": {
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/templateStage"
          }
        },
        "keyed_on": {
          "description": "A floor rule keyed on a resolved field can only be as good as the resolution; a rule keyed on observed reality cannot be defeated by misclassification.",
          "enum": [
            "graph",
            "type",
            "reality",
            "scope"
          ]
        }
      },
      "required": [
        "id",
        "description",
        "trigger",
        "requires",
        "forbids",
        "keyed_on"
      ],
      "additionalProperties": false
    },
    "floorTrigger": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "contains_stage"
            },
            "stage": {
              "$ref": "common.json#/$defs/templateStage"
            }
          },
          "required": [
            "kind",
            "stage"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "work_item_type"
            },
            "type": {
              "$ref": "common.json#/$defs/workItemType"
            }
          },
          "required": [
            "kind",
            "type"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "predicate_true"
            },
            "predicate": {
              "$ref": "common.json#/$defs/nonEmptyString"
            }
          },
          "required": [
            "kind",
            "predicate"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "always"
            }
          },
          "required": [
            "kind"
          ],
          "additionalProperties": false
        }
      ]
    },
    "floorRequirement": {
      "type": "object",
      "properties": {
        "stage": {
          "$ref": "common.json#/$defs/templateStage"
        },
        "position": {
          "enum": [
            "before",
            "after",
            "present",
            "sole_predecessor_of_complete"
          ]
        },
        "relative_to": {
          "oneOf": [
            {
              "$ref": "common.json#/$defs/templateStage"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "stage",
        "position",
        "relative_to"
      ],
      "additionalProperties": false
    },
    "floorSet": {
      "type": "object",
      "properties": {
        "version": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "rules": {
          "type": "array",
          "minItems": 1,
          "items": {
            "$ref": "#/$defs/floorRule"
          }
        }
      },
      "required": [
        "version",
        "rules"
      ],
      "additionalProperties": false
    },
    "stageSet": {
      "type": "object",
      "properties": {
        "version": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "stages": {
          "type": "array",
          "minItems": 1,
          "items": {
            "$ref": "workflow.json#/$defs/stageDescriptor"
          }
        }
      },
      "required": [
        "version",
        "stages"
      ],
      "additionalProperties": false
    },
    "workItemPolicy": {
      "description": "policies/work-items.json. Per type, the minimum evidence class required to assert it. Nobody declares an incident by writing the word.",
      "type": "object",
      "properties": {
        "version": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "resolution_confidence_threshold": {
          "type": "number",
          "minimum": 0,
          "maximum": 1
        },
        "types": {
          "type": "array",
          "minItems": 9,
          "items": {
            "type": "object",
            "properties": {
              "type": {
                "$ref": "common.json#/$defs/workItemType"
              },
              "description": {
                "$ref": "common.json#/$defs/nonEmptyString"
              },
              "minimum_evidence": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "requirement": {
                      "enum": [
                        "external_item_of_this_type",
                        "child_items_exist",
                        "runtime_or_production_observation",
                        "capability_record_intersecting_scope",
                        "no_capability_record_intersecting_scope",
                        "named_path_exists",
                        "existing_change_proposal",
                        "reproduction_or_incorrect_behaviour_report",
                        "none"
                      ]
                    },
                    "kinds": {
                      "type": "array",
                      "items": {
                        "$ref": "common.json#/$defs/evidenceKind"
                      }
                    },
                    "note": {
                      "$ref": "common.json#/$defs/nonEmptyString"
                    }
                  },
                  "required": [
                    "requirement",
                    "kinds",
                    "note"
                  ],
                  "additionalProperties": false
                }
              },
              "satisfied_by": {
                "description": "`ALL` requires every entry; `ANY` requires one. `UNKNOWN` requires none, which is why it is the fallback.",
                "enum": [
                  "ALL",
                  "ANY",
                  "NONE"
                ]
              },
              "candidate_dod_profiles": {
                "type": "array",
                "minItems": 1,
                "items": {
                  "$ref": "common.json#/$defs/dodProfileId"
                }
              }
            },
            "required": [
              "type",
              "description",
              "minimum_evidence",
              "satisfied_by",
              "candidate_dod_profiles"
            ],
            "additionalProperties": false
          }
        }
      },
      "required": [
        "version",
        "resolution_confidence_threshold",
        "types"
      ],
      "additionalProperties": false
    },
    "intakePolicy": {
      "type": "object",
      "properties": {
        "version": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "hosts": {
          "description": "What each host can assert. A host that cannot assert a principal must classify EXTERNAL.",
          "type": "array",
          "minItems": 1,
          "items": {
            "type": "object",
            "properties": {
              "host": {
                "$ref": "common.json#/$defs/nonEmptyString"
              },
              "can_assert_principal": {
                "type": "boolean"
              },
              "trust_class": {
                "$ref": "common.json#/$defs/trustClass"
              },
              "sources": {
                "type": "array",
                "minItems": 1,
                "items": {
                  "$ref": "common.json#/$defs/intakeSource"
                }
              }
            },
            "required": [
              "host",
              "can_assert_principal",
              "trust_class",
              "sources"
            ],
            "additionalProperties": false
          }
        },
        "default_trust_class": {
          "description": "EXTERNAL. Every source classifies EXTERNAL until a host exists that can assert a principal for it.",
          "const": "EXTERNAL"
        },
        "pre_granted_autonomous_intake": {
          "description": "Sources for which AUTONOMOUS_INTAKE_EXECUTION is pre-granted, so a trusted webhook stays autonomous and an unconfigured one does not.",
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/nonEmptyString"
          }
        },
        "instruction_markers": {
          "description": "Patterns whose presence in intake content is recorded as an attempted instruction and otherwise ignored.",
          "type": "array",
          "minItems": 1,
          "items": {
            "type": "object",
            "properties": {
              "attempt": {
                "enum": [
                  "NAME_TEMPLATE",
                  "REQUEST_STAGE",
                  "SET_CONFIDENCE",
                  "SET_TRUST_CLASS",
                  "WIDEN_SCOPE",
                  "CLAIM_AUTHORIZATION",
                  "CANCEL_RUN"
                ]
              },
              "patterns": {
                "type": "array",
                "minItems": 1,
                "items": {
                  "$ref": "common.json#/$defs/nonEmptyString"
                }
              }
            },
            "required": [
              "attempt",
              "patterns"
            ],
            "additionalProperties": false
          }
        }
      },
      "required": [
        "version",
        "hosts",
        "default_trust_class",
        "pre_granted_autonomous_intake",
        "instruction_markers"
      ],
      "additionalProperties": false
    },
    "evidencePolicy": {
      "type": "object",
      "properties": {
        "version": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "always_verify": {
          "type": "array",
          "minItems": 4,
          "items": {
            "enum": [
              "critical_or_high_finding",
              "authorization_request",
              "dod_criterion_met",
              "fact_contradicting_existing_assertion"
            ]
          }
        },
        "sample_rate": {
          "type": "number",
          "minimum": 0,
          "maximum": 1
        },
        "sample_minimum_per_envelope": {
          "type": "integer",
          "minimum": 0
        },
        "mismatch_threshold_per_envelope": {
          "type": "integer",
          "minimum": 1
        },
        "authorization_mismatch_threshold": {
          "type": "integer",
          "minimum": 1
        },
        "comparators": {
          "type": "array",
          "minItems": 10,
          "items": {
            "type": "object",
            "properties": {
              "kind": {
                "$ref": "common.json#/$defs/evidenceKind"
              },
              "comparator": {
                "enum": [
                  "normalized_exact_match",
                  "predicate_reevaluation",
                  "identifier_plus_content_hash",
                  "not_kernel_verifiable"
                ]
              },
              "requires_predicate": {
                "type": "boolean"
              },
              "note": {
                "$ref": "common.json#/$defs/nonEmptyString"
              }
            },
            "required": [
              "kind",
              "comparator",
              "requires_predicate",
              "note"
            ],
            "additionalProperties": false
          }
        }
      },
      "required": [
        "version",
        "always_verify",
        "sample_rate",
        "sample_minimum_per_envelope",
        "mismatch_threshold_per_envelope",
        "authorization_mismatch_threshold",
        "comparators"
      ],
      "additionalProperties": false
    },
    "budgetPolicy": {
      "type": "object",
      "properties": {
        "version": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "loops": {
          "type": "object",
          "properties": {
            "rework": {
              "$ref": "#/$defs/scopedCap"
            },
            "architecture": {
              "$ref": "#/$defs/scopedCap"
            },
            "review": {
              "$ref": "#/$defs/scopedCap"
            },
            "discovery": {
              "$ref": "#/$defs/scopedCap"
            }
          },
          "required": [
            "rework",
            "architecture",
            "review",
            "discovery"
          ],
          "additionalProperties": false
        },
        "reresolution": {
          "type": "integer",
          "minimum": 0
        },
        "decomposition": {
          "type": "object",
          "properties": {
            "max_children": {
              "type": "integer",
              "minimum": 1
            },
            "max_depth": {
              "type": "integer",
              "minimum": 1
            }
          },
          "required": [
            "max_children",
            "max_depth"
          ],
          "additionalProperties": false
        },
        "cost": {
          "type": "object",
          "properties": {
            "run_usd": {
              "type": "number",
              "minimum": 0
            },
            "work_item_usd": {
              "type": "number",
              "minimum": 0
            },
            "dispatch_usd": {
              "type": "number",
              "minimum": 0
            }
          },
          "required": [
            "run_usd",
            "work_item_usd",
            "dispatch_usd"
          ],
          "additionalProperties": false
        },
        "wall_clock_ms": {
          "type": "object",
          "properties": {
            "run": {
              "type": "integer",
              "minimum": 1
            },
            "dispatch": {
              "type": "integer",
              "minimum": 1
            }
          },
          "required": [
            "run",
            "dispatch"
          ],
          "additionalProperties": false
        },
        "dispatches": {
          "$ref": "#/$defs/scopedCap"
        },
        "dispatch_retries": {
          "type": "integer",
          "minimum": 0
        },
        "model_escalations_per_dispatch": {
          "type": "integer",
          "minimum": 0
        },
        "max_turns_per_dispatch": {
          "type": "integer",
          "minimum": 1
        },
        "lease_timeout_ms": {
          "type": "integer",
          "minimum": 1
        },
        "authorization_window_ms": {
          "type": "integer",
          "minimum": 1
        },
        "question_window_ms": {
          "type": "integer",
          "minimum": 1
        },
        "freshness_windows_ms": {
          "type": "object",
          "properties": {
            "git": {
              "type": "integer",
              "minimum": 1
            },
            "runtime": {
              "type": "integer",
              "minimum": 1
            },
            "repository": {
              "type": "integer",
              "minimum": 1
            },
            "intent": {
              "type": "integer",
              "minimum": 1
            },
            "agentos": {
              "type": "integer",
              "minimum": 1
            }
          },
          "required": [
            "git",
            "runtime",
            "repository",
            "intent",
            "agentos"
          ],
          "additionalProperties": false
        },
        "read_call_log_granularity": {
          "description": "Reads are logged at this granularity. Aggregation is permitted; omission is not.",
          "type": "object",
          "properties": {
            "aggregate_identical_within_ms": {
              "type": "integer",
              "minimum": 0
            },
            "max_aggregated": {
              "type": "integer",
              "minimum": 1
            }
          },
          "required": [
            "aggregate_identical_within_ms",
            "max_aggregated"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "version",
        "loops",
        "reresolution",
        "decomposition",
        "cost",
        "wall_clock_ms",
        "dispatches",
        "dispatch_retries",
        "model_escalations_per_dispatch",
        "max_turns_per_dispatch",
        "lease_timeout_ms",
        "authorization_window_ms",
        "question_window_ms",
        "freshness_windows_ms",
        "read_call_log_granularity"
      ],
      "additionalProperties": false
    },
    "scopedCap": {
      "description": "Per Workflow Run and per Work Item. A budget that resets on every attempt is not a budget.",
      "type": "object",
      "properties": {
        "per_run": {
          "type": "integer",
          "minimum": 0
        },
        "per_work_item": {
          "type": "integer",
          "minimum": 0
        }
      },
      "required": [
        "per_run",
        "per_work_item"
      ],
      "additionalProperties": false
    },
    "pathPolicy": {
      "description": "policies/paths.json. The absolute deny-list, checked even for paths that pass worktree and mandate checks. Rule 3 is the backstop that holds when 1 and 2 are wrong.",
      "type": "object",
      "properties": {
        "version": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "deny": {
          "type": "array",
          "minItems": 1,
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "$ref": "common.json#/$defs/nonEmptyString"
              },
              "description": {
                "$ref": "common.json#/$defs/nonEmptyString"
              },
              "kind": {
                "enum": [
                  "installation_relative",
                  "absolute",
                  "home_relative",
                  "name_anywhere"
                ]
              },
              "patterns": {
                "type": "array",
                "minItems": 1,
                "items": {
                  "$ref": "common.json#/$defs/pathGlob"
                }
              }
            },
            "required": [
              "id",
              "description",
              "kind",
              "patterns"
            ],
            "additionalProperties": false
          }
        },
        "scratch_roots": {
          "description": "Where incidental artifacts may land without disqualifying an operation's observation safety.",
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/pathGlob"
          }
        }
      },
      "required": [
        "version",
        "deny",
        "scratch_roots"
      ],
      "additionalProperties": false
    },
    "gatePolicy": {
      "type": "object",
      "properties": {
        "version": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "gates": {
          "type": "array",
          "minItems": 10,
          "items": {
            "$ref": "authorization.json#/$defs/gateDefinition"
          }
        }
      },
      "required": [
        "version",
        "gates"
      ],
      "additionalProperties": false
    },
    "dodPolicySet": {
      "type": "object",
      "properties": {
        "version": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "criteria": {
          "description": "The eighteen criteria and their single owning role. A criterion with two owners is decided by whichever ran last.",
          "type": "array",
          "minItems": 18,
          "maxItems": 18,
          "items": {
            "type": "object",
            "properties": {
              "criterion": {
                "$ref": "dod.json#/$defs/criterionId"
              },
              "name": {
                "$ref": "common.json#/$defs/nonEmptyString"
              },
              "owner_role": {
                "$ref": "common.json#/$defs/agentRole"
              },
              "owner_pass": {
                "description": "Which pass of the owning role supplies it. The Auditor's second pass owns 6, 16 and 17.",
                "enum": [
                  "first",
                  "second",
                  "only"
                ]
              },
              "evidence_class": {
                "enum": [
                  "structural",
                  "implementation",
                  "behavioural",
                  "capability",
                  "runtime",
                  "production",
                  "ux",
                  "knowledge"
                ]
              }
            },
            "required": [
              "criterion",
              "name",
              "owner_role",
              "owner_pass",
              "evidence_class"
            ],
            "additionalProperties": false
          }
        },
        "profiles": {
          "type": "array",
          "minItems": 7,
          "items": {
            "$ref": "dod.json#/$defs/dodProfile"
          }
        }
      },
      "required": [
        "version",
        "criteria",
        "profiles"
      ],
      "additionalProperties": false
    },
    "executionPolicy": {
      "description": "policies/execution.json. Which risk classes this installation may execute. Milestone 1 is a read-only AgentOS that discovers and audits and mutates nothing, and this is where that is stated as data rather than as an absence of code: the mutation frameworks are built and no mutating operation is registered, and this file is what refuses a mutating workflow if one ever were.",
      "type": "object",
      "properties": {
        "version": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "mutation_enabled": {
          "type": "boolean"
        },
        "admissible_risk_classes": {
          "description": "A workflow whose derived risk class is not listed is inadmissible, and the kernel falls back to the most conservative admissible template with the restriction logged.",
          "type": "array",
          "minItems": 1,
          "uniqueItems": true,
          "items": {
            "$ref": "common.json#/$defs/riskClass"
          }
        },
        "rationale": {
          "$ref": "common.json#/$defs/nonEmptyString"
        }
      },
      "required": [
        "version",
        "mutation_enabled",
        "admissible_risk_classes",
        "rationale"
      ],
      "additionalProperties": false
    },
    "agentPolicy": {
      "description": "Which proposals and statuses each role may make, and in which stages. Enforced as cross-field rules on envelope receipt.",
      "type": "object",
      "properties": {
        "version": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "roles": {
          "type": "array",
          "minItems": 8,
          "maxItems": 8,
          "items": {
            "type": "object",
            "properties": {
              "role": {
                "$ref": "common.json#/$defs/agentRole"
              },
              "may_propose": {
                "type": "array",
                "items": {
                  "enum": [
                    "work_item",
                    "workflow",
                    "decomposition",
                    "triage",
                    "cancellation",
                    "dispatch",
                    "arbitration",
                    "authorization_request"
                  ]
                }
              },
              "proposal_stages": {
                "description": "Stage restrictions per proposal key. A decomposition outside DECOMPOSITION is a contract violation.",
                "type": "object",
                "patternProperties": {
                  "^[a-z_]+$": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "oneOf": [
                        {
                          "$ref": "common.json#/$defs/stage"
                        },
                        {
                          "const": "*"
                        }
                      ]
                    }
                  }
                },
                "additionalProperties": false
              },
              "may_return_statuses": {
                "type": "array",
                "minItems": 1,
                "items": {
                  "$ref": "handoff-envelope.json#/$defs/status"
                }
              },
              "permitted_adapters": {
                "description": "The Orchestrator's is empty on purpose: the component that judges evidence must not also manufacture it.",
                "type": "array",
                "items": {
                  "$ref": "common.json#/$defs/nonEmptyString"
                }
              },
              "read_only": {
                "type": "boolean"
              }
            },
            "required": [
              "role",
              "may_propose",
              "proposal_stages",
              "may_return_statuses",
              "permitted_adapters",
              "read_only"
            ],
            "additionalProperties": false
          }
        }
      },
      "required": [
        "version",
        "roles"
      ],
      "additionalProperties": false
    }
  }
};

export const REGISTRY_SCHEMA: JsonSchemaObject = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://agentos.dev/schema/registry.json",
  "title": "Skill, model and agent registry entries",
  "description": "Three indexes of what exists, sharing one lookup shape: discover, describe, rank, select. Registries rank; the kernel selects.",
  "$defs": {
    "skillEntry": {
      "type": "object",
      "properties": {
        "id": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "source": {
          "enum": [
            "global",
            "repository",
            "plugin",
            "connector",
            "mcp",
            "builtin",
            "script"
          ]
        },
        "description": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "declared_inputs": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "declared_outputs": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "availability": {
          "$ref": "adapter.json#/$defs/availability"
        },
        "mutating": {
          "type": "boolean"
        },
        "spawns_agents": {
          "description": "A skill with spawns_agents: true is never selectable. A skill whose spawning behaviour cannot be determined is treated as true.",
          "type": "boolean"
        },
        "spawns_agents_determined": {
          "type": "boolean"
        },
        "external_destination": {
          "type": "boolean"
        },
        "reversal": {
          "type": [
            "string",
            "null"
          ],
          "minLength": 1
        },
        "domains": {
          "type": "array",
          "items": {
            "enum": [
              "repository_analysis",
              "git",
              "database",
              "api",
              "ui",
              "testing",
              "deployment",
              "project_management",
              "documentation"
            ]
          }
        },
        "operations": {
          "type": "array",
          "items": {
            "enum": [
              "read",
              "analyse",
              "generate",
              "mutate",
              "verify"
            ]
          }
        },
        "targets": {
          "type": "array",
          "items": {
            "enum": [
              "filesystem",
              "vcs",
              "data_store",
              "network",
              "runtime"
            ]
          }
        },
        "observed_success_rate": {
          "type": [
            "number",
            "null"
          ],
          "minimum": 0,
          "maximum": 1
        },
        "cost_hint": {
          "enum": [
            "low",
            "medium",
            "high",
            "unknown"
          ]
        }
      },
      "required": [
        "id",
        "source",
        "description",
        "declared_inputs",
        "declared_outputs",
        "availability",
        "mutating",
        "spawns_agents",
        "spawns_agents_determined",
        "external_destination",
        "reversal",
        "domains",
        "operations",
        "targets",
        "observed_success_rate",
        "cost_hint"
      ],
      "additionalProperties": false
    },
    "modelEntry": {
      "description": "Where a property is not knowable it is null, and selection degrades sensibly rather than assuming the best case.",
      "type": "object",
      "properties": {
        "id": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "availability": {
          "$ref": "adapter.json#/$defs/availability"
        },
        "context_window": {
          "type": [
            "integer",
            "null"
          ],
          "minimum": 1
        },
        "reasoning": {
          "enum": [
            "shallow",
            "mid",
            "deep",
            "unknown"
          ]
        },
        "coding": {
          "enum": [
            "none",
            "basic",
            "strong",
            "unknown"
          ]
        },
        "vision": {
          "enum": [
            "none",
            "basic",
            "strong",
            "unknown"
          ]
        },
        "tool_use": {
          "enum": [
            "none",
            "basic",
            "strong",
            "unknown"
          ]
        },
        "usd_per_mtok_input": {
          "type": [
            "number",
            "null"
          ],
          "minimum": 0
        },
        "usd_per_mtok_output": {
          "type": [
            "number",
            "null"
          ],
          "minimum": 0
        },
        "latency_class": {
          "enum": [
            "fast",
            "medium",
            "slow",
            "unknown"
          ]
        },
        "precision_class": {
          "enum": [
            "standard",
            "high",
            "unknown"
          ]
        }
      },
      "required": [
        "id",
        "availability",
        "context_window",
        "reasoning",
        "coding",
        "vision",
        "tool_use",
        "usd_per_mtok_input",
        "usd_per_mtok_output",
        "latency_class",
        "precision_class"
      ],
      "additionalProperties": false
    },
    "requirement": {
      "description": "Each agent declares what it needs, not which model it wants.",
      "type": "object",
      "properties": {
        "context": {
          "enum": [
            "small",
            "medium",
            "large"
          ]
        },
        "reasoning": {
          "enum": [
            "shallow",
            "mid",
            "deep"
          ]
        },
        "coding": {
          "type": "boolean"
        },
        "vision": {
          "type": "boolean"
        },
        "tool_use": {
          "enum": [
            "none",
            "basic",
            "strong"
          ]
        },
        "precision": {
          "enum": [
            "standard",
            "high"
          ]
        }
      },
      "required": [
        "context",
        "reasoning",
        "coding",
        "vision",
        "tool_use",
        "precision"
      ],
      "additionalProperties": false
    },
    "rankedCandidate": {
      "type": "object",
      "properties": {
        "id": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "score": {
          "type": "number"
        },
        "reasons": {
          "type": "array",
          "minItems": 1,
          "items": {
            "$ref": "common.json#/$defs/nonEmptyString"
          }
        },
        "excluded_because": {
          "type": [
            "string",
            "null"
          ]
        }
      },
      "required": [
        "id",
        "score",
        "reasons",
        "excluded_because"
      ],
      "additionalProperties": false
    },
    "skillRegistry": {
      "type": "object",
      "properties": {
        "entries": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/skillEntry"
          }
        },
        "enumerated_at": {
          "$ref": "common.json#/$defs/timestamp"
        }
      },
      "required": [
        "entries",
        "enumerated_at"
      ],
      "additionalProperties": false
    },
    "modelRegistry": {
      "type": "object",
      "properties": {
        "entries": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/modelEntry"
          }
        },
        "enumerated_at": {
          "$ref": "common.json#/$defs/timestamp"
        }
      },
      "required": [
        "entries",
        "enumerated_at"
      ],
      "additionalProperties": false
    },
    "agentSpec": {
      "description": "An agent is a specification: mandate, required inputs, permitted adapters, output envelope type, and the model and skill requirements it declares.",
      "type": "object",
      "properties": {
        "role": {
          "$ref": "common.json#/$defs/agentRole"
        },
        "mandate_name": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "version": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "objective": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "stages": {
          "type": "array",
          "minItems": 1,
          "items": {
            "$ref": "common.json#/$defs/stage"
          }
        },
        "required_inputs": {
          "type": "array",
          "items": {
            "$ref": "context-package.json#/$defs/sectionName"
          }
        },
        "required_outputs": {
          "type": "array",
          "minItems": 1,
          "items": {
            "$ref": "common.json#/$defs/nonEmptyString"
          }
        },
        "permitted_adapters": {
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/nonEmptyString"
          }
        },
        "read_only": {
          "type": "boolean"
        },
        "hard_limits": {
          "description": "Hard limits matter as much as mandates. Most multi-agent failure is an agent quietly doing another agent's job.",
          "type": "array",
          "minItems": 1,
          "items": {
            "$ref": "common.json#/$defs/nonEmptyString"
          }
        },
        "must_declare": {
          "type": "array",
          "minItems": 1,
          "items": {
            "$ref": "common.json#/$defs/nonEmptyString"
          }
        },
        "model_requirement": {
          "$ref": "#/$defs/requirement"
        },
        "dod_criteria_owned": {
          "type": "array",
          "items": {
            "$ref": "dod.json#/$defs/criterionId"
          }
        }
      },
      "required": [
        "role",
        "mandate_name",
        "version",
        "objective",
        "stages",
        "required_inputs",
        "required_outputs",
        "permitted_adapters",
        "read_only",
        "hard_limits",
        "must_declare",
        "model_requirement",
        "dod_criteria_owned"
      ],
      "additionalProperties": false
    }
  }
};

export const REJECTION_SCHEMA: JsonSchemaObject = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://agentos.dev/schema/rejection.json",
  "title": "Violations and rejections",
  "description": "Syntactic validity confers nothing. This is the vocabulary for what the kernel refused and why, so that a refusal is a locatable rule rather than a message.",
  "$defs": {
    "violationCode": {
      "description": "One code per rule the kernel enforces itself. Each maps to a cross-field rule, an invariant, or an admission check.",
      "enum": [
        "SCHEMA_INVALID",
        "COMPLETE_WITH_BLOCKERS",
        "COMPLETE_WITH_UNFILLED_OUTPUT",
        "BLOCKED_WITHOUT_BLOCKERS",
        "BLOCKED_BY_ARCHITECTURE_ILLEGAL_ROLE",
        "BLOCKED_BY_ARCHITECTURE_ILLEGAL_STAGE",
        "BLOCKED_BY_ARCHITECTURE_NO_ARCHITECTURE_STAGE",
        "REJECTED_FROM_NON_REVIEWING_ROLE",
        "STATUS_ILLEGAL_FOR_STAGE",
        "PROPOSAL_NOT_PERMITTED_FOR_ROLE",
        "PROPOSAL_NOT_PERMITTED_IN_STAGE",
        "PROPOSAL_RESERVES_KERNEL_DECISION",
        "DANGLING_EVIDENCE_REFERENCE",
        "DANGLING_BLOCKS_REFERENCE",
        "FACT_FINDING_WITHOUT_VERIFIED_EVIDENCE",
        "VERIFICATION_PRESENT_ON_ARRIVAL",
        "COVERAGE_MISSING",
        "COVERAGE_OVERSTATED",
        "PREDICATE_MISSING_ON_LOG_OR_METRIC_EVIDENCE",
        "UX_VERDICT_WITHOUT_CALL_ANCHORED_EVIDENCE",
        "ASSERTION_WITHOUT_CONFIDENCE",
        "ARTIFACTS_UNDER_REPORTED",
        "ARTIFACTS_OVER_REPORTED",
        "EVIDENCE_MISMATCH_THRESHOLD",
        "DISPATCH_ID_MISMATCH",
        "OUTPUT_NOT_A_REQUIRED_OUTPUT",
        "DOD_VERDICT_CRITERION_NOT_OWNED",
        "DOD_VERDICT_MISSING_REASON",
        "ILLEGAL_TRANSITION",
        "STAGE_NOT_IN_TEMPLATE",
        "EXCLUSION_PREDICATE_NOT_FALSE",
        "SCOPE_EXCEEDS_WORK_ITEM",
        "UNBOUNDED_SCOPE",
        "TYPE_WITHOUT_MINIMUM_EVIDENCE",
        "EXTERNAL_IDENTITY_UNRESOLVED",
        "OUTCOME_NOT_BINDABLE",
        "DECOMPOSITION_BOUND_EXCEEDED",
        "DECOMPOSITION_CYCLE",
        "CANCELLATION_WITHOUT_EVIDENCE",
        "INTAKE_INSTRUCTION_IGNORED",
        "GRANT_MISSING",
        "GRANT_EXPIRED",
        "GRANT_MISMATCHED",
        "SECURITY_FLOOR_VIOLATION",
        "TOOL_SURFACE_NON_CONFORMANT",
        "SPAWNING_SKILL_SELECTED",
        "MUTATING_SKILL_FOR_READ_ONLY_STAGE",
        "UNLOGGABLE_MUTATION",
        "OBSERVATION_NOT_SAFE_FOR_REPLAY"
      ]
    },
    "violation": {
      "type": "object",
      "properties": {
        "code": {
          "$ref": "#/$defs/violationCode"
        },
        "rule": {
          "description": "Where the rule is written, e.g. `AGENT_HANDOFF_CONTRACT cross-field rules` or `KERNEL_BOUNDARY section 8 invariant 4`.",
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "message": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "path": {
          "description": "JSON Pointer into the offending document, where one applies.",
          "type": [
            "string",
            "null"
          ]
        },
        "handled_as": {
          "description": "A contract violation is handled as BLOCKED; the kernel never guesses what an agent meant.",
          "enum": [
            "BLOCKED",
            "FAILED",
            "DOWNGRADED",
            "REFUSED",
            "OVERRIDDEN"
          ]
        },
        "subject": {
          "type": [
            "string",
            "null"
          ]
        }
      },
      "required": [
        "code",
        "rule",
        "message",
        "path",
        "handled_as",
        "subject"
      ],
      "additionalProperties": false
    },
    "rejection": {
      "description": "The result of any kernel admission or receipt. `accepted: false` always carries at least one violation.",
      "type": "object",
      "properties": {
        "accepted": {
          "type": "boolean"
        },
        "violations": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/violation"
          }
        }
      },
      "required": [
        "accepted",
        "violations"
      ],
      "additionalProperties": false
    }
  }
};

export const WORK_ITEM_SCHEMA: JsonSchemaObject = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://agentos.dev/schema/work-item.json",
  "title": "Intake and Work Item",
  "description": "IntakeRecord, the proposed Work Item resolution produces, and the admitted Work Item the kernel creates from it.",
  "$defs": {
    "intakeRecord": {
      "description": "Adapter-normalized. `raw` is verbatim: no agent summarizes intake before it is recorded, because a summary that drops the discriminating clause is how a resolution goes wrong invisibly.",
      "type": "object",
      "properties": {
        "intake_id": {
          "$ref": "common.json#/$defs/id"
        },
        "received_at": {
          "$ref": "common.json#/$defs/timestamp"
        },
        "source": {
          "$ref": "common.json#/$defs/intakeSource"
        },
        "source_locator": {
          "$ref": "common.json#/$defs/locator"
        },
        "principal": {
          "$ref": "#/$defs/principal"
        },
        "trust_class": {
          "description": "Set by the host from authenticated context, never from the content. A webhook body cannot promote itself.",
          "$ref": "common.json#/$defs/trustClass"
        },
        "raw": {
          "type": "string"
        },
        "content_hash": {
          "description": "Hash of `raw` at admission. Compared at COMPLETION against a re-execution of `source_locator` to detect source drift.",
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "attachments": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/attachment"
          }
        },
        "correlation": {
          "type": "object",
          "properties": {
            "prior_work_item": {
              "type": [
                "string",
                "null"
              ],
              "minLength": 1
            },
            "prior_run": {
              "type": [
                "string",
                "null"
              ],
              "minLength": 1
            }
          },
          "required": [
            "prior_work_item",
            "prior_run"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "intake_id",
        "received_at",
        "source",
        "source_locator",
        "principal",
        "trust_class",
        "raw",
        "content_hash",
        "attachments",
        "correlation"
      ],
      "additionalProperties": false
    },
    "principal": {
      "type": "object",
      "properties": {
        "id": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "asserted_by": {
          "description": "Which host asserted this identity. A host that cannot assert a principal classifies the intake EXTERNAL.",
          "$ref": "common.json#/$defs/nonEmptyString"
        }
      },
      "required": [
        "id",
        "asserted_by"
      ],
      "additionalProperties": false
    },
    "attachment": {
      "type": "object",
      "properties": {
        "name": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "locator": {
          "$ref": "common.json#/$defs/locator"
        },
        "media_type": {
          "$ref": "common.json#/$defs/nonEmptyString"
        }
      },
      "required": [
        "name",
        "locator",
        "media_type"
      ],
      "additionalProperties": false
    },
    "proposedWorkItem": {
      "description": "Resolution's output. Every field is an assertion with a confidence class, the type included.",
      "type": "object",
      "properties": {
        "source_intake": {
          "$ref": "common.json#/$defs/id"
        },
        "intent": {
          "$ref": "assertion.json"
        },
        "type": {
          "$ref": "assertion.json"
        },
        "external_identity": {
          "$ref": "assertion.json"
        },
        "title": {
          "$ref": "assertion.json"
        },
        "desired_outcome": {
          "$ref": "assertion.json"
        },
        "scope": {
          "$ref": "#/$defs/scopeAssertion"
        },
        "constraints": {
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/nonEmptyString"
          }
        },
        "dependencies": {
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/nonEmptyString"
          }
        },
        "parent": {
          "$ref": "assertion.json"
        },
        "resolution_confidence": {
          "description": "The agent's own number. Recorded, never the reason anything is believed, consulted only at the policy threshold.",
          "type": "number",
          "minimum": 0,
          "maximum": 1
        },
        "alternatives": {
          "description": "Every alternative reading considered and why it was rejected. This list is what the uncertainty ladder and any question to a human are built from.",
          "type": "array",
          "items": {
            "$ref": "#/$defs/alternative"
          }
        }
      },
      "required": [
        "source_intake",
        "intent",
        "type",
        "external_identity",
        "title",
        "desired_outcome",
        "scope",
        "constraints",
        "dependencies",
        "parent",
        "resolution_confidence",
        "alternatives"
      ],
      "additionalProperties": false
    },
    "alternative": {
      "type": "object",
      "properties": {
        "type": {
          "$ref": "common.json#/$defs/workItemType"
        },
        "reading": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "why_rejected": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "would_do": {
          "description": "What AgentOS would do under this reading. Rung 4 of the uncertainty ladder asks with this in hand.",
          "type": "string"
        }
      },
      "required": [
        "type",
        "reading",
        "why_rejected"
      ],
      "additionalProperties": false
    },
    "scopeAssertion": {
      "type": "object",
      "properties": {
        "paths": {
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/pathGlob"
          }
        },
        "capabilities": {
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/id"
          }
        },
        "repositories": {
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/nonEmptyString"
          }
        },
        "confidence": {
          "$ref": "common.json#/$defs/confidenceClass"
        }
      },
      "required": [
        "paths",
        "capabilities",
        "repositories",
        "confidence"
      ],
      "additionalProperties": false
    },
    "workItem": {
      "description": "The durable thing AgentOS is trying to accomplish. It outlives every attempt.",
      "type": "object",
      "properties": {
        "work_item_id": {
          "$ref": "common.json#/$defs/id"
        },
        "created_at": {
          "$ref": "common.json#/$defs/timestamp"
        },
        "source_intake": {
          "$ref": "common.json#/$defs/id"
        },
        "origin_trust_class": {
          "$ref": "common.json#/$defs/trustClass"
        },
        "type": {
          "$ref": "common.json#/$defs/workItemType"
        },
        "claimed_type": {
          "description": "What resolution asserted, kept when the kernel admitted the item as UNKNOWN for want of the type's minimum evidence.",
          "oneOf": [
            {
              "$ref": "common.json#/$defs/workItemType"
            },
            {
              "type": "null"
            }
          ]
        },
        "title": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "external_identity": {
          "type": [
            "string",
            "null"
          ],
          "minLength": 1
        },
        "desired_outcome": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "scope": {
          "$ref": "common.json#/$defs/scope"
        },
        "constraints": {
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/nonEmptyString"
          }
        },
        "dependencies": {
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/id"
          }
        },
        "lifecycle": {
          "$ref": "common.json#/$defs/workItemLifecycle"
        },
        "candidate_dod_profiles": {
          "description": "Profiles the desired outcome binds to. Non-empty is an admission requirement: an outcome nothing can demonstrate is a wish.",
          "type": "array",
          "minItems": 1,
          "items": {
            "$ref": "common.json#/$defs/dodProfileId"
          }
        },
        "links": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/link"
          }
        },
        "duplicate_candidates": {
          "description": "Surfaced, never auto-merged. A wrong merge destroys history.",
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/id"
          }
        },
        "lease": {
          "oneOf": [
            {
              "$ref": "#/$defs/lease"
            },
            {
              "type": "null"
            }
          ]
        },
        "runs": {
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/id"
          }
        },
        "reresolution_count": {
          "type": "integer",
          "minimum": 0
        },
        "decomposition_depth": {
          "type": "integer",
          "minimum": 0
        },
        "denied_gates": {
          "description": "Denials are recorded at the work item level, so starting a fresh run is not a way to re-ask.",
          "type": "array",
          "items": {
            "$ref": "#/$defs/denial"
          }
        },
        "consumed_budget": {
          "$ref": "#/$defs/consumedBudget"
        }
      },
      "required": [
        "work_item_id",
        "created_at",
        "source_intake",
        "origin_trust_class",
        "type",
        "claimed_type",
        "title",
        "external_identity",
        "desired_outcome",
        "scope",
        "constraints",
        "dependencies",
        "lifecycle",
        "candidate_dod_profiles",
        "links",
        "duplicate_candidates",
        "lease",
        "runs",
        "reresolution_count",
        "decomposition_depth",
        "denied_gates",
        "consumed_budget"
      ],
      "additionalProperties": false
    },
    "link": {
      "type": "object",
      "properties": {
        "kind": {
          "$ref": "common.json#/$defs/workItemLinkKind"
        },
        "target": {
          "$ref": "common.json#/$defs/id"
        }
      },
      "required": [
        "kind",
        "target"
      ],
      "additionalProperties": false
    },
    "lease": {
      "description": "One active Workflow Run per Work Item. Acquired atomically by exclusive create, never read-then-write.",
      "type": "object",
      "properties": {
        "run_id": {
          "$ref": "common.json#/$defs/id"
        },
        "acquired_at": {
          "$ref": "common.json#/$defs/timestamp"
        },
        "holder": {
          "$ref": "common.json#/$defs/nonEmptyString"
        }
      },
      "required": [
        "run_id",
        "acquired_at",
        "holder"
      ],
      "additionalProperties": false
    },
    "denial": {
      "type": "object",
      "properties": {
        "gate": {
          "$ref": "common.json#/$defs/gate"
        },
        "target": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "denied_at": {
          "$ref": "common.json#/$defs/timestamp"
        },
        "denied_by": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "reason": {
          "type": "string"
        }
      },
      "required": [
        "gate",
        "target",
        "denied_at",
        "denied_by",
        "reason"
      ],
      "additionalProperties": false
    },
    "consumedBudget": {
      "description": "Per Work Item, not only per run: three runs of two laps each is six laps, and a budget that resets on every attempt is not a budget.",
      "type": "object",
      "properties": {
        "usd": {
          "type": "number",
          "minimum": 0
        },
        "input_tokens": {
          "type": "integer",
          "minimum": 0
        },
        "output_tokens": {
          "type": "integer",
          "minimum": 0
        },
        "dispatches": {
          "type": "integer",
          "minimum": 0
        },
        "loops": {
          "type": "object",
          "patternProperties": {
            "^[a-z_]+$": {
              "type": "integer",
              "minimum": 0
            }
          },
          "additionalProperties": false
        }
      },
      "required": [
        "usd",
        "input_tokens",
        "output_tokens",
        "dispatches",
        "loops"
      ],
      "additionalProperties": false
    }
  }
};

export const WORKFLOW_SCHEMA: JsonSchemaObject = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://agentos.dev/schema/workflow.json",
  "title": "Workflow templates, stage descriptors and the frozen run graph",
  "description": "The machine is data-driven, so its data has a shape before the machine does.",
  "$defs": {
    "stageDescriptor": {
      "description": "policies/stages.json, one per stage. `mutating` is load-bearing in three places: the safe-prefix computation, the resume rule, and the AUTONOMOUS_INTAKE_EXECUTION gate.",
      "type": "object",
      "properties": {
        "stage": {
          "$ref": "common.json#/$defs/templateStage"
        },
        "mutating": {
          "type": "boolean"
        },
        "default_agent": {
          "$ref": "common.json#/$defs/agentRole"
        },
        "required_outputs": {
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/nonEmptyString"
          }
        },
        "exit_condition": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "satisfied_by": {
          "description": "The reality predicate meaning 'already done'. `null` where a stage can never be satisfied by prior reality.",
          "type": [
            "string",
            "null"
          ],
          "minLength": 1
        },
        "gates_possible": {
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/gate"
          }
        },
        "dod_criteria": {
          "type": "array",
          "items": {
            "type": "integer",
            "minimum": 1,
            "maximum": 18
          }
        },
        "applicability_predicate": {
          "description": "Evaluated by the kernel when a proposal asks to exclude this stage. TRUE or INDETERMINATE keeps the stage.",
          "type": [
            "string",
            "null"
          ],
          "minLength": 1
        }
      },
      "required": [
        "stage",
        "mutating",
        "default_agent",
        "required_outputs",
        "exit_condition",
        "satisfied_by",
        "gates_possible",
        "dod_criteria",
        "applicability_predicate"
      ],
      "additionalProperties": false
    },
    "edge": {
      "type": "object",
      "properties": {
        "from": {
          "$ref": "common.json#/$defs/templateStage"
        },
        "to": {
          "$ref": "common.json#/$defs/stage"
        },
        "when": {
          "description": "`always`, a named predicate (optionally negated with `NOT `), or `envelope.<STATUS>`.",
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "kind": {
          "enum": [
            "advance",
            "branch",
            "loop",
            "escalate",
            "terminal"
          ]
        },
        "counter": {
          "type": [
            "string",
            "null"
          ],
          "minLength": 1
        },
        "cap": {
          "type": [
            "string",
            "null"
          ],
          "minLength": 1
        },
        "blocker_kind": {
          "oneOf": [
            {
              "$ref": "finding.json#/$defs/blockerKind"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "from",
        "to",
        "when",
        "kind"
      ],
      "additionalProperties": false
    },
    "workflowTemplate": {
      "type": "object",
      "properties": {
        "template_id": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "version": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "description": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "applies_to": {
          "type": "object",
          "properties": {
            "types": {
              "description": "Work item types, or `[\"*\"]` for a template admissible for every type.",
              "type": "array",
              "minItems": 1,
              "items": {
                "oneOf": [
                  {
                    "$ref": "common.json#/$defs/workItemType"
                  },
                  {
                    "const": "*"
                  }
                ]
              }
            }
          },
          "required": [
            "types"
          ],
          "additionalProperties": false
        },
        "entry": {
          "$ref": "common.json#/$defs/templateStage"
        },
        "stages": {
          "type": "array",
          "minItems": 1,
          "uniqueItems": true,
          "items": {
            "$ref": "common.json#/$defs/templateStage"
          }
        },
        "optional_stages": {
          "type": "array",
          "uniqueItems": true,
          "items": {
            "$ref": "common.json#/$defs/templateStage"
          }
        },
        "edges": {
          "type": "array",
          "minItems": 1,
          "items": {
            "$ref": "#/$defs/edge"
          }
        },
        "dod_profile_default": {
          "$ref": "common.json#/$defs/dodProfileId"
        }
      },
      "required": [
        "template_id",
        "version",
        "description",
        "applies_to",
        "entry",
        "stages",
        "optional_stages",
        "edges",
        "dod_profile_default"
      ],
      "additionalProperties": false
    },
    "frozenGraph": {
      "description": "The parameterized instance, frozen at run start. Replayed on recovery, never recomputed.",
      "type": "object",
      "properties": {
        "template_id": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "template_version": {
          "$ref": "common.json#/$defs/nonEmptyString"
        },
        "entry": {
          "$ref": "common.json#/$defs/templateStage"
        },
        "stages": {
          "type": "array",
          "minItems": 1,
          "uniqueItems": true,
          "items": {
            "$ref": "common.json#/$defs/templateStage"
          }
        },
        "edges": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/edge"
          }
        },
        "excluded_stages": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "stage": {
                "$ref": "common.json#/$defs/templateStage"
              },
              "predicate": {
                "$ref": "common.json#/$defs/nonEmptyString"
              },
              "evaluated": {
                "const": "FALSE"
              }
            },
            "required": [
              "stage",
              "predicate",
              "evaluated"
            ],
            "additionalProperties": false
          }
        },
        "stage_mandates": {
          "type": "object",
          "patternProperties": {
            "^[A-Z_]+$": {
              "$ref": "common.json#/$defs/scope"
            }
          },
          "additionalProperties": false
        },
        "risk_class": {
          "$ref": "common.json#/$defs/riskClass"
        },
        "dod_profile_default": {
          "$ref": "common.json#/$defs/dodProfileId"
        }
      },
      "required": [
        "template_id",
        "template_version",
        "entry",
        "stages",
        "edges",
        "excluded_stages",
        "stage_mandates",
        "risk_class",
        "dod_profile_default"
      ],
      "additionalProperties": false
    },
    "stageCursorEntry": {
      "type": "object",
      "properties": {
        "stage": {
          "$ref": "common.json#/$defs/templateStage"
        },
        "state": {
          "description": "COMPLETED_PRIOR means the mutation has already occurred, not that the criteria are met.",
          "enum": [
            "PENDING",
            "ACTIVE",
            "COMPLETED",
            "COMPLETED_PRIOR",
            "EXCLUDED"
          ]
        },
        "reality_evidence": {
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/id"
          }
        },
        "entered_at": {
          "type": [
            "string",
            "null"
          ],
          "format": "date-time"
        },
        "left_at": {
          "type": [
            "string",
            "null"
          ],
          "format": "date-time"
        }
      },
      "required": [
        "stage",
        "state",
        "reality_evidence",
        "entered_at",
        "left_at"
      ],
      "additionalProperties": false
    },
    "run": {
      "description": "run.json — a projection rebuildable from events.ndjson. If they disagree, the log wins.",
      "type": "object",
      "properties": {
        "run_id": {
          "$ref": "common.json#/$defs/id"
        },
        "work_item_id": {
          "$ref": "common.json#/$defs/id"
        },
        "started_at": {
          "$ref": "common.json#/$defs/timestamp"
        },
        "ended_at": {
          "type": [
            "string",
            "null"
          ],
          "format": "date-time"
        },
        "outcome": {
          "oneOf": [
            {
              "$ref": "common.json#/$defs/runOutcome"
            },
            {
              "type": "null"
            }
          ]
        },
        "graph": {
          "$ref": "#/$defs/frozenGraph"
        },
        "current_stage": {
          "$ref": "common.json#/$defs/stage"
        },
        "pre_block_stage": {
          "oneOf": [
            {
              "$ref": "common.json#/$defs/stage"
            },
            {
              "type": "null"
            }
          ]
        },
        "cursor": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/stageCursorEntry"
          }
        },
        "loop_counters": {
          "type": "object",
          "patternProperties": {
            "^[a-z_]+$": {
              "type": "integer",
              "minimum": 0
            }
          },
          "additionalProperties": false
        },
        "consumed_budget": {
          "$ref": "work-item.json#/$defs/consumedBudget"
        },
        "open_blockers": {
          "type": "array",
          "items": {
            "$ref": "finding.json#/$defs/blocker"
          }
        },
        "pending_authorizations": {
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/id"
          }
        },
        "envelope_ids": {
          "type": "array",
          "items": {
            "$ref": "common.json#/$defs/id"
          }
        },
        "context_package_version": {
          "type": [
            "integer",
            "null"
          ],
          "minimum": 1
        },
        "last_seq": {
          "type": "integer",
          "minimum": 0
        }
      },
      "required": [
        "run_id",
        "work_item_id",
        "started_at",
        "ended_at",
        "outcome",
        "graph",
        "current_stage",
        "pre_block_stage",
        "cursor",
        "loop_counters",
        "consumed_budget",
        "open_blockers",
        "pending_authorizations",
        "envelope_ids",
        "context_package_version",
        "last_seq"
      ],
      "additionalProperties": false
    }
  }
};

/** Every schema document, in a stable order. */
export const ALL_SCHEMAS: readonly JsonSchemaObject[] = [
  ADAPTER_SCHEMA,
  ASSERTION_SCHEMA,
  AUTHORIZATION_SCHEMA,
  CAPABILITY_SCHEMA,
  COMMON_SCHEMA,
  CONTEXT_PACKAGE_SCHEMA,
  DOD_SCHEMA,
  EVENT_SCHEMA,
  EVIDENCE_SCHEMA,
  FINDING_SCHEMA,
  HANDOFF_ENVELOPE_SCHEMA,
  INPUT_PACKAGE_SCHEMA,
  POLICY_SCHEMA,
  REGISTRY_SCHEMA,
  REJECTION_SCHEMA,
  WORK_ITEM_SCHEMA,
  WORKFLOW_SCHEMA,
];

/** Schema `$id` per contract, for callers that validate by name. */
export const SCHEMA_ID = {
  "adapter": "https://agentos.dev/schema/adapter.json",
  "assertion": "https://agentos.dev/schema/assertion.json",
  "authorization": "https://agentos.dev/schema/authorization.json",
  "capability": "https://agentos.dev/schema/capability.json",
  "common": "https://agentos.dev/schema/common.json",
  "context-package": "https://agentos.dev/schema/context-package.json",
  "dod": "https://agentos.dev/schema/dod.json",
  "event": "https://agentos.dev/schema/event.json",
  "evidence": "https://agentos.dev/schema/evidence.json",
  "finding": "https://agentos.dev/schema/finding.json",
  "handoff-envelope": "https://agentos.dev/schema/handoff-envelope.json",
  "input-package": "https://agentos.dev/schema/input-package.json",
  "policy": "https://agentos.dev/schema/policy.json",
  "registry": "https://agentos.dev/schema/registry.json",
  "rejection": "https://agentos.dev/schema/rejection.json",
  "work-item": "https://agentos.dev/schema/work-item.json",
  "workflow": "https://agentos.dev/schema/workflow.json",
} as const;
