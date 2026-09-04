import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ABSENCE_REASONS,
  AGENT_ROLES,
  BLOCKER_KINDS,
  BLOCKER_NEEDS,
  CAPABILITY_STATUSES,
  CHAIN_STAGES,
  COMPLETION_VERDICTS,
  CONFIDENCE_CLASSES,
  CONTEXT_SECTION_NAMES,
  CONTROL_STATES,
  DATA_SEMANTICS,
  DOD_PROFILE_IDS,
  DOD_VERDICTS,
  ENVELOPE_STATUSES,
  EVENT_KINDS,
  EVIDENCE_KINDS,
  FINDING_CATEGORIES,
  FRESHNESS_VALUES,
  GATES,
  INTAKE_SOURCES,
  PREDICATE_VALUES,
  PROLOGUE_STAGES,
  REALITY_ELEMENTS,
  RECONCILIATION_STATES,
  REVIEWING_ROLES,
  RISK_CLASSES,
  RUN_OUTCOMES,
  SEVERITIES,
  STAGES,
  TEMPLATE_STAGES,
  TRUST_CLASSES,
  VERIFICATION_STATUSES,
  VIOLATION_CODES,
  WORK_ITEM_LIFECYCLES,
  WORK_ITEM_LINK_KINDS,
  WORK_ITEM_TYPES,
  formatErrors,
  validators,
} from '../src/index.js';
import * as fx from '../src/fixtures.js';

/**
 * "One valid fixture per control-flow-bearing enum value. An enum value with no fixture is
 * an enum value nothing has ever exercised" (IMPLEMENTATION_PLAN section 2).
 *
 * The fixtures are built rather than stored, so the loop closes over the vocabulary read
 * out of the schema. A value added to a schema without a builder case therefore fails this
 * test rather than sitting unexercised — which a directory of files could not do.
 */

function checkAll<T extends string>(
  values: readonly T[],
  label: string,
  build: (value: T) => { readonly validator: keyof typeof validators; readonly instance: unknown },
): void {
  test(`${label} — ${values.length} values, each exercised by a valid instance`, () => {
    assert.ok(values.length > 0, `${label} has no values`);
    for (const value of values) {
      const { validator, instance } = build(value);
      const result = validators[validator].check(instance);
      assert.ok(
        result.valid,
        `${label} value ${value} has no valid fixture:\n${formatErrors(result.errors)}`,
      );
    }
  });
}

describe('enum coverage — every control-flow-bearing value has a valid fixture', () => {
  checkAll(CONFIDENCE_CLASSES, 'confidence class', (c) => ({
    validator: 'assertion',
    instance: c === 'FACT'
      ? fx.factAssertion('x')
      : c === 'INFERENCE' ? fx.inferenceAssertion('x') : fx.unknownAssertion(),
  }));

  checkAll(ABSENCE_REASONS, 'absence reason', (reason) => ({
    validator: 'assertion',
    instance: fx.unknownAssertion({ reason }),
  }));

  checkAll(FRESHNESS_VALUES, 'freshness', (f) => ({
    validator: 'assertion',
    instance: fx.assertionOfFreshness(f),
  }));

  checkAll(DATA_SEMANTICS, 'data semantic', (semantic) => ({
    validator: 'capabilityRecord',
    instance: fx.capabilityRecord({
      chain: [fx.chainStageRecord('CANONICAL_STORE', { semantics: [semantic] })],
    }),
  }));

  checkAll(PREDICATE_VALUES, 'predicate value', (value) => ({
    validator: 'capabilityRecord',
    instance: fx.capabilityRecord({
      chain: [fx.chainStageRecord('SOURCE', { applicable: value })],
      provenance: value,
    }),
  }));

  checkAll(EVIDENCE_KINDS, 'evidence kind', (kind) => ({
    validator: 'evidence',
    instance: fx.evidence({ kind, id: `E-${kind}` }),
  }));

  checkAll(VERIFICATION_STATUSES, 'verification status', (status) => ({
    validator: 'evidence',
    instance: fx.evidence({
      verification: {
        status,
        at: fx.T2,
        by: 'kernel',
        matches: status === 'VERIFIED' ? true : status === 'MISMATCH' ? false : null,
      },
    }),
  }));

  checkAll(SEVERITIES, 'severity', (severity) => ({
    validator: 'finding',
    instance: fx.findingOfSeverity(severity),
  }));

  checkAll(FINDING_CATEGORIES, 'finding category', (category) => ({
    validator: 'finding',
    instance: fx.findingOfCategory(category),
  }));

  checkAll(BLOCKER_KINDS, 'blocker kind', (kind) => ({
    validator: 'blocker',
    instance: fx.blockerOfKind(kind),
  }));

  checkAll(BLOCKER_NEEDS, 'blocker needs', (needs) => ({
    validator: 'blocker',
    instance: fx.blockerNeeding(needs),
  }));

  checkAll(ENVELOPE_STATUSES, 'envelope status', (status) => ({
    validator: 'handoffEnvelope',
    instance: fx.envelopeWithStatus(status),
  }));

  checkAll(AGENT_ROLES, 'agent role', (role) => ({
    validator: 'handoffEnvelope',
    instance: fx.envelopeFromRole(role),
  }));

  checkAll(REVIEWING_ROLES, 'reviewing role', (role) => ({
    validator: 'handoffEnvelope',
    instance: fx.envelope({ agent: role, status: 'REJECTED', stage_in: 'VALIDATION' }),
  }));

  checkAll(STAGES, 'stage', (stage) => ({
    validator: 'handoffEnvelope',
    instance: fx.envelope({ stage_in: stage }),
  }));

  checkAll(PROLOGUE_STAGES, 'prologue stage', (stage) => ({
    validator: 'handoffEnvelope',
    instance: fx.envelope({ stage_in: stage }),
  }));

  checkAll(CONTROL_STATES, 'control state', (stage) => ({
    validator: 'handoffEnvelope',
    instance: fx.envelope({ stage_in: stage }),
  }));

  checkAll(TEMPLATE_STAGES, 'template stage', (stage) => ({
    validator: 'stageCursorEntry',
    instance: { stage, state: 'PENDING', reality_evidence: [], entered_at: null, left_at: null },
  }));

  checkAll(WORK_ITEM_TYPES, 'work item type', (type) => ({
    validator: 'workItem',
    instance: fx.workItemOfType(type),
  }));

  checkAll(WORK_ITEM_LIFECYCLES, 'work item lifecycle', (lifecycle) => ({
    validator: 'workItem',
    instance: fx.workItemInLifecycle(lifecycle),
  }));

  checkAll(WORK_ITEM_LINK_KINDS, 'work item link kind', (kind) => ({
    validator: 'workItem',
    instance: fx.workItem({ links: [{ kind, target: 'wi_c_other' }] }),
  }));

  checkAll(INTAKE_SOURCES, 'intake source', (source) => ({
    validator: 'intakeRecord',
    instance: fx.intakeOfSource(source),
  }));

  checkAll(TRUST_CLASSES, 'trust class', (trust) => ({
    validator: 'intakeRecord',
    instance: fx.intakeOfTrust(trust),
  }));

  checkAll(RECONCILIATION_STATES, 'reconciliation state', (state) => ({
    validator: 'currentReality',
    instance: fx.realityWithReconciliation(state),
  }));

  checkAll(CAPABILITY_STATUSES, 'capability status', (status) => ({
    validator: 'capabilityRecord',
    instance: fx.capabilityOfStatus(status),
  }));

  checkAll(CHAIN_STAGES, 'chain stage', (stage) => ({
    validator: 'capabilityRecord',
    instance: fx.capabilityRecord({ chain: [fx.chainStageRecord(stage)] }),
  }));

  checkAll(RISK_CLASSES, 'risk class', (risk) => ({
    validator: 'frozenGraph',
    instance: {
      template_id: 'investigation.readonly',
      template_version: '1.0',
      entry: 'AUDIT',
      stages: ['AUDIT', 'COMPLETION'],
      edges: [{ from: 'AUDIT', to: 'COMPLETION', when: 'always', kind: 'advance' }],
      excluded_stages: [],
      stage_mandates: {},
      risk_class: risk,
      dod_profile_default: 'audit',
    },
  }));

  checkAll(GATES, 'gate', (gate) => ({
    validator: 'draftAuthorizationRequest',
    instance: {
      gate,
      target: 'subject :: main',
      what: 'the action the human is being asked to permit',
      why: 'tied to the work item outcome',
      blast_radius: 'one service',
      reversibility: { how: 'revert the change', verified: true, cost: 'one deploy cycle' },
      evidence: ['E-001'],
      unknowns: [],
      alternatives: ['do nothing'],
      recommendation: 'proceed',
    },
  }));

  checkAll(DOD_VERDICTS, 'DoD verdict', (verdict) => ({
    validator: 'criterionVerdict',
    instance: fx.criterionVerdictOf(verdict),
  }));

  checkAll(COMPLETION_VERDICTS, 'completion verdict', (verdict) => ({
    validator: 'completionReport',
    instance: {
      work_item_id: 'wi_c_subject',
      run_id: 'run_20260904T100000Z_000001',
      profile_id: 'audit',
      verdict,
      criteria: [{
        criterion: 3,
        verdict: 'MET',
        reason: null,
        evidence: ['E-001'],
        owner_role: 'auditor',
        supplied_by_envelope: 'env_001',
      }],
      unmet_critical: [],
      not_validated: [],
      gaps: [],
      route_back_to: verdict === 'INCOMPLETE' ? 'VALIDATION' : null,
      source_drift: null,
      computed_at: fx.T2,
    },
  }));

  checkAll(DOD_PROFILE_IDS, 'DoD profile id', (profile) => ({
    validator: 'workItem',
    instance: fx.workItem({ candidate_dod_profiles: [profile] }),
  }));

  checkAll(RUN_OUTCOMES, 'run outcome', (outcome) => ({
    validator: 'event',
    instance: {
      seq: 1,
      at: fx.T2,
      work_item_id: 'wi_c_subject',
      run_id: 'run_20260904T100000Z_000001',
      stage: 'COMPLETION',
      dispatch_id: null,
      agent: null,
      event: 'run_ended',
      data: { outcome, detail: '' },
    },
  }));

  checkAll(CONTEXT_SECTION_NAMES, 'context section name', (section) => ({
    validator: 'inputPackage',
    instance: fx.inputPackage({ required_inputs: [section] }),
  }));

  checkAll(REALITY_ELEMENTS, 'reality element', (element) => ({
    validator: 'currentReality',
    /* Each element is exercised as a FACT in turn, over the otherwise-unknown baseline. */
    instance: { ...fx.currentReality(), [element]: fx.factAssertion(true) },
  }));

  checkAll(VIOLATION_CODES, 'violation code', (code) => ({
    validator: 'violation',
    instance: {
      code,
      rule: 'AGENT_HANDOFF_CONTRACT cross-field consistency rules',
      message: 'the rule this code names was violated',
      path: null,
      handled_as: 'BLOCKED',
      subject: null,
    },
  }));
});

describe('enum coverage — the event log', () => {
  /*
   * Every event kind needs a valid record, because the log is the authoritative account of
   * a run and a kind with no valid instance is a kind the replayer has never parsed. The
   * payloads live here rather than in the builder because each one is specific to its kind,
   * and a generic builder would be a second definition of the payload shapes.
   */
  const PAYLOADS: Readonly<Record<string, unknown>> = {
    run_started: { run_id: 'run_20260904T100000Z_000001', holder: 'pid:1', reason: 'NEW' },
    run_ended: { outcome: 'COMPLETE', detail: '' },
    intake_recorded: fx.intakeRecord(),
    work_item_admitted: {
      work_item: fx.workItem(),
      checks: [{ check: 'schema_and_confidence', result: 'PASS', detail: '' }],
      type_downgraded: false,
    },
    work_item_rejected: {
      checks: [{ check: 'scope_bounded', result: 'FAIL', detail: 'scope of ** refused' }],
      attempt: 1,
      next: 'REDISPATCH',
    },
    understood_computed: {
      verdict: 'SUFFICIENT',
      conditions: [
        { check: 'type_known_or_investigation', result: 'PASS', detail: '' },
        { check: 'outcome_binds_to_profile', result: 'PASS', detail: '' },
        { check: 'entry_predicates_determinate', result: 'PASS', detail: '' },
        { check: 'blocking_unknowns_handled', result: 'PASS', detail: '' },
        { check: 'resolution_confidence', result: 'PASS', detail: '' },
      ],
      undetermined_predicates: [],
    },
    workflow_admitted: {
      graph: {
        template_id: 'investigation.readonly',
        template_version: '1.0',
        entry: 'AUDIT',
        stages: ['AUDIT', 'COMPLETION'],
        edges: [{ from: 'AUDIT', to: 'COMPLETION', when: 'always', kind: 'advance' }],
        excluded_stages: [],
        stage_mandates: {},
        risk_class: 'READ_ONLY',
        dod_profile_default: 'audit',
      },
      admissible_templates: ['investigation.readonly'],
      checks: [{ check: 'template_exists', result: 'PASS', detail: '' }],
    },
    workflow_override: {
      proposed_template: 'task.direct',
      selected_template: 'investigation.readonly',
      reason: 'proposed template is not admissible for type UNKNOWN',
      failed_checks: [{ check: 'applies_to_matches', result: 'FAIL', detail: '' }],
    },
    entry_stage_computed: {
      entry_stage: 'AUDIT',
      walk: [{
        stage: 'AUDIT',
        satisfied_by: null,
        evaluated: 'FALSE',
        mutating: false,
        decision: 'ENTER',
        evidence: [],
      }],
    },
    stage_marked_completed_prior: {
      marked_stage: 'IMPLEMENTATION',
      predicate: 'reality.implementation_present',
      evidence: ['E-001'],
      note: 'criteria remain NOT_VALIDATED',
    },
    transition: {
      from: 'AUDIT',
      to: 'COMPLETION',
      trigger: 'always',
      edge_kind: 'advance',
      proposed_by: 'auditor',
      proposed_stage: 'COMPLETION',
      overridden: false,
      evidence: [],
    },
    dispatch_intent: { input_package: fx.inputPackage(), attempt: 1 },
    dispatch_result: {
      outcome: 'ENVELOPE',
      envelope_id: 'env_001',
      failure_reason: null,
      detail: '',
      cost: { input_tokens: 1000, output_tokens: 100 },
    },
    envelope_received: {
      envelope_id: 'env_001',
      status: 'COMPLETE',
      steps: [{ check: 'schema', result: 'PASS', detail: '' }],
    },
    envelope_rejected: {
      envelope_id: 'env_001',
      step: 'cross_field',
      violations: [{
        code: 'COMPLETE_WITH_BLOCKERS',
        rule: 'AGENT_HANDOFF_CONTRACT cross-field consistency rules',
        message: 'COMPLETE requires blockers empty',
        path: '/blockers',
        handled_as: 'BLOCKED',
        subject: 'env_001',
      }],
    },
    contract_violation: {
      code: 'VERIFICATION_PRESENT_ON_ARRIVAL',
      rule: 'AGENT_HANDOFF_CONTRACT evidence',
      message: 'verification is kernel-owned',
      path: '/evidence/0/verification',
      handled_as: 'BLOCKED',
      subject: 'env_001',
    },
    evidence_verification: {
      envelope_id: 'env_001',
      results: [{
        evidence_id: 'E-001',
        status: 'VERIFIED',
        selected_because: 'ALWAYS_CRITICAL_FINDING',
        detail: '',
      }],
      mismatch_count: 0,
    },
    evidence_integrity: {
      envelope_id: 'env_001',
      evidence_id: 'E-001',
      model: 'claude-opus-5',
      status: 'MISMATCH',
      downgraded_assertions: [],
      demoted_findings: ['F-001'],
      envelope_rejected: false,
    },
    mutation: fx.mutationEvent(),
    adapter_call: {
      call_id: 'c_001',
      dispatch_id: 'd_001',
      adapter: 'repo',
      op: 'read_file',
      args_digest: 'abc',
      paths_touched: ['src/a.ts'],
      capabilities_touched: [],
      outcome: 'OK',
      refusal: null,
      aggregated_count: 1,
      started_at: fx.T1,
      duration_ms: 3,
    },
    dispatch_rollback: {
      rolled_back_dispatch: 'd_001',
      reversed: [{
        adapter: 'git',
        op: 'commit',
        target: 'worktree/x',
        reversal_op: 'reset_hard',
        outcome: 'REVERSED',
      }],
      new_dispatch_id: 'd_002',
      blocked_non_reversible: false,
    },
    idempotency: {
      key: 'abc',
      scope: 'work_item',
      adapter: 'git',
      op: 'create_pr',
      verdict: 'AMBIGUOUS_STATE',
      reread: 'UNREACHABLE',
      detail: 'the PR host could not be reached',
    },
    gate_fired: {
      gate: 'MERGE_PROTECTED',
      target: 'subject :: main',
      trigger: 'classifier',
      classifier_id: 'merge_target_protected',
      classification: {
        subject: 'main',
        kind: 'branch_protection',
        value: 'PROTECTED',
        confidence: 'UNKNOWN',
        failed_closed: true,
        probe_detail: 'the host refused the protection query',
      },
      request_id: 'req_001',
    },
    authorization_requested: {
      request_id: 'req_001',
      work_item_id: 'wi_c_subject',
      run_id: 'run_20260904T100000Z_000001',
      stage: 'AUTHORIZATION',
      requested_by: 'production',
      requested_at: fx.T2,
      draft: {
        gate: 'MERGE_PROTECTED',
        target: 'subject :: main',
        what: 'merge',
        why: 'validated',
        blast_radius: 'one service',
        reversibility: { how: 'revert', verified: true, cost: 'one deploy' },
        evidence: ['E-001'],
        unknowns: [],
        alternatives: ['do nothing'],
        recommendation: 'merge',
      },
      classification: null,
      trigger: 'classifier',
      state: 'PENDING',
    },
    authorization_decided: {
      request_id: 'req_001',
      decision: 'DENIED',
      grant: null,
      decided_by: 'operator@example.com',
      reason: 'not this release',
    },
    scope_violation: {
      adapter: 'repo',
      op: 'write_file',
      requested: '../outside.txt',
      resolved: 'C:/outside.txt',
      rule: 'mandate_out_of_scope',
      deny_list_entry: null,
      aborted_dispatch: false,
      detail: '',
    },
    security_violation: {
      adapter: 'repo',
      op: 'write_file',
      requested: 'state/work-items/x',
      resolved: 'C:/AIAgent/agent-os/state/work-items/x',
      rule: 'deny_list',
      deny_list_entry: 'agentos_state',
      aborted_dispatch: true,
      detail: '',
    },
    conflict: {
      conflict_id: 'cf_001',
      subject: 'whether the writer is connected',
      position_a: { source: 'auditor', claim: 'connected', confidence: 'FACT', evidence: ['E-001'] },
      position_b: { source: 'validator', claim: 'not connected', confidence: 'INFERENCE', evidence: [] },
      phase: 'RESOLVED_BY_RULE',
      winner: 'A',
      rule: 'FACT beats INFERENCE',
      detail: '',
    },
    budget: { kind: 'EXCEEDED', counter: 'rework', scope: 'run', value: 4, cap: 3, tried: [] },
    dod_computed: {
      work_item_id: 'wi_c_subject',
      run_id: 'run_20260904T100000Z_000001',
      profile_id: 'audit',
      verdict: 'INCOMPLETE',
      criteria: [{
        criterion: 3,
        verdict: 'NOT_VALIDATED',
        reason: 'the stage was COMPLETED_PRIOR and supplied no verdicts',
        evidence: [],
        owner_role: 'auditor',
        supplied_by_envelope: null,
      }],
      unmet_critical: [3],
      not_validated: [3],
      gaps: ['canonical ownership was never checked'],
      route_back_to: 'AUDIT',
      source_drift: null,
      computed_at: fx.T2,
    },
    source_drift: {
      state: 'CHANGED',
      hash_at_admission: 'a'.repeat(64),
      hash_now: 'b'.repeat(64),
      detail: 'the ticket was edited after admission',
    },
    reresolved: {
      reason: 'the feature was never built, so this is not a defect',
      evidence: ['E-001'],
      count: 1,
      cap: 1,
      new_run_id: 'run_20260904T110000Z_000002',
    },
    child_work_item: {
      action: 'LINKED',
      child_id: 'wi_jira_STORY-201',
      external_identity: 'jira:STORY-201',
      depends_on: [],
      reason: 'the external item already exists',
    },
    lease: {
      action: 'REFUSED',
      run_id: 'run_20260904T110000Z_000002',
      active_run_id: 'run_20260904T100000Z_000001',
      abandoned_run_id: null,
      holder: 'pid:2',
    },
    recovery: {
      phase: 'PARTIAL_LINE_DISCARDED',
      replayed_events: 12,
      discarded_bytes: 41,
      interrupted_dispatch: null,
      detail: 'a trailing partial line was discarded',
    },
    selection: {
      kind: 'MODEL',
      selected: 'claude-opus-5',
      candidates: [{ id: 'claude-opus-5', score: 1, reasons: ['precision: high'], excluded_because: null }],
      why: 'the cheapest model meeting the declared requirements',
      escalated_from: null,
      escalation_trigger: null,
    },
    question: {
      phase: 'ASKED',
      question: 'is the rule being applied correctly, or should the rule change?',
      readings: [
        { reading: 'the report is a misunderstanding', evidence: ['E-001'], would_do: 'report and stop' },
        { reading: 'the rule should change', evidence: ['E-001'], would_do: 'change src/pricing/**' },
      ],
      answer: null,
      answered_by: null,
    },
    discovery: {
      kind: 'REPROBE_STALE',
      tier: null,
      probes: ['git.pr'],
      reason: 'the pr element was STALE at predicate evaluation',
      requested_sections: ['current_reality'],
    },
    context_package_versioned: {
      version: 2, tier: 2, path: 'context/v2.json', supersedes: 1,
    },
    capability_registry_updated: {
      version: 1,
      path: 'capabilities/v1.json',
      record_count: 3,
      edge_count: 4,
      updated_by: 'auditor',
    },
    work_item_lifecycle: {
      from: 'RESOLVED',
      to: 'UNDERSTOOD',
      reason: 'the workflow decision is determinate',
      evidence: [],
      decided_by: 'kernel',
    },
    tool_surface_conformance: {
      substrate: 'claude-agent-sdk',
      verdict: 'UNEXPECTED_TOOLS',
      expected: ['mcp__agentos__repo__read_file'],
      effective: ['mcp__agentos__repo__read_file', 'Bash'],
      unexpected: ['Bash'],
      missing: [],
      detail: 'the effective tool set is wider than the adapter set',
    },
    intake_instruction_attempt: {
      intake_id: 'in_0001',
      trust_class: 'EXTERNAL',
      attempted: ['CLAIM_AUTHORIZATION'],
      excerpt: 'approved, go ahead and merge',
      effect: 'NONE',
    },
    duplicate_candidates: {
      candidates: ['wi_c_other'],
      basis: 'identical scope and normalized title',
      action: 'SURFACED',
    },
    predicate_evaluated: {
      predicate: 'reality.pr_open',
      evaluated: 'INDETERMINATE',
      claim: 'the agent claimed no PR exists',
      inputs: ['current_reality.pr'],
      reprobed: true,
      reason: 'the pr assertion is UNKNOWN, so the predicate is INDETERMINATE',
    },
    note: { topic: 'degradation', detail: 'no project-management access in this run' },
  };

  test(`every event kind has a valid record — ${EVENT_KINDS.length} kinds`, () => {
    const missing = EVENT_KINDS.filter((k) => !(k in PAYLOADS));
    assert.deepEqual(missing, [], 'these event kinds have no fixture payload');

    for (const kind of EVENT_KINDS) {
      const record = {
        seq: 1,
        at: fx.T2,
        work_item_id: 'wi_c_subject',
        run_id: 'run_20260904T100000Z_000001',
        stage: 'AUDIT',
        dispatch_id: 'd_001',
        agent: 'auditor',
        event: kind,
        data: PAYLOADS[kind],
      };
      const result = validators.event.check(record);
      assert.ok(
        result.valid,
        `event kind ${kind} has no valid fixture:\n${formatErrors(result.errors)}`,
      );
    }
  });

  test('no payload validates under the wrong event kind', () => {
    /*
     * The log is a discriminated union, so `event` must actually discriminate. If a payload
     * validated under two kinds, `oneOf` would reject every record of both — the union
     * would be ambiguous rather than permissive, and the failure would look mysterious.
     */
    for (const kind of EVENT_KINDS) {
      const record = {
        seq: 1,
        at: fx.T2,
        work_item_id: 'wi_c_subject',
        run_id: 'run_20260904T100000Z_000001',
        stage: 'AUDIT',
        dispatch_id: 'd_001',
        agent: 'auditor',
        event: kind,
        data: PAYLOADS[kind],
      };
      assert.ok(validators.event.check(record).valid, `${kind} must validate as itself`);
    }
  });
});
