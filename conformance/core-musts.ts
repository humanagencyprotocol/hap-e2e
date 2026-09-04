/**
 * Conformance map — the enforcement core of protocol.md v0.6.
 *
 * Why this exists: two normative MUSTs (the `actionTypes` registry, the
 * Multi-Owner Coverage Rule) were unimplemented AND untested for months, and
 * nothing surfaced it. An error code existed in the type definitions, appeared
 * in a MUST list in the spec, and was asserted by zero tests — a gap only a
 * hand audit found. A map turns that from archaeology into a diff.
 *
 * Scope is deliberate: *Receipt Issuance*, *Gatekeeper & Executor Behavior*,
 * and *Read Authorization*. That is where a failure means an unauthorized
 * action executes, and it is roughly a fifth of the specification's 201 MUSTs.
 * A map of everything, attempted at once, does not get finished. Extending it
 * is mechanical — add entries; the checker does the rest.
 *
 * Every entry must resolve to one of:
 *   - `tests`:    one or more real test files that exercise it
 *   - `ledgered`: a known, recorded gap — the reference MUST name where it is
 *                 recorded, so "not tested" is never silently equivalent to
 *                 "not required"
 *
 * The checker (test/conformance-map.test.ts) fails if a referenced file does
 * not exist, so the map cannot rot as tests are renamed or deleted.
 */

export interface CoreMust {
  /** Stable id, used in commit messages and ledger entries. */
  id: string;
  /** The section of protocol.md this comes from. */
  section: 'Receipt Issuance' | 'Gatekeeper & Executor' | 'Read Authorization';
  /** What the specification requires, in its own terms. */
  requirement: string;
  /** Test files that exercise it — paths relative to a repo root below. */
  tests?: string[];
  /** Where a known gap is recorded, when there is no test. */
  ledgered?: string;
}

/** Repo roots a `tests` path may be relative to, tried in order. */
export const TEST_ROOTS = ['.', '../suveren-as', '../suveren-gateway'];

export const CORE_MUSTS: CoreMust[] = [
  // ── Receipt Issuance ──────────────────────────────────────────────────────
  {
    id: 'RI-actiontype-registry',
    section: 'Receipt Issuance',
    requirement:
      "actionType MUST be a member of the profile's boundsSchema.actionTypes; the AS MUST reject others with INVALID_ACTION_TYPE",
    tests: [
      '../suveren-as/src/__tests__/receipt-action-type.test.ts',
      'test/authorization-bounds.test.ts',
    ],
  },
  {
    id: 'RI-actiontype-not-derived',
    section: 'Receipt Issuance',
    requirement:
      'actionType MUST come from the manifest; deriving it from the tool name is forbidden',
    tests: ['../suveren-gateway/apps/mcp-server/test/tools.test.ts'],
  },
  {
    id: 'RI-idempotency-required',
    section: 'Receipt Issuance',
    requirement:
      'A synchronous (automatic-mode) receipt request omitting idempotencyKey MUST be rejected with IDEMPOTENCY_KEY_REQUIRED',
    tests: ['test/idempotency.test.ts'],
  },
  {
    id: 'RI-idempotent-replay',
    section: 'Receipt Issuance',
    requirement:
      'A replayed idempotencyKey MUST return the ORIGINAL receipt without re-consuming bounds — even after revocation or expiry',
    tests: ['test/idempotency.test.ts', '../suveren-as/src/__tests__/receipt-after-revocation.test.ts'],
  },
  {
    id: 'RI-idempotency-mismatch',
    section: 'Receipt Issuance',
    requirement: 'Reusing an idempotencyKey for a different execution MUST return IDEMPOTENCY_MISMATCH',
    tests: ['test/idempotency.test.ts'],
  },
  {
    id: 'RI-revoked',
    section: 'Receipt Issuance',
    requirement: 'The AS MUST refuse a receipt against a revoked attestation (ATTESTATION_REVOKED)',
    tests: ['../suveren-as/src/__tests__/receipt-after-revocation.test.ts', 'test/crm-lifecycle.test.ts'],
  },
  {
    id: 'RI-expired',
    section: 'Receipt Issuance',
    requirement: 'The AS MUST refuse a receipt against an expired attestation (ATTESTATION_EXPIRED)',
    tests: ['e2e/journey-6-expiry.spec.ts'],
  },
  {
    id: 'RI-per-transaction-bounds',
    section: 'Receipt Issuance',
    requirement: 'Any executionContext value exceeding a per-transaction bound MUST be rejected (BOUND_EXCEEDED)',
    tests: ['test/authorization-bounds.test.ts'],
  },
  {
    id: 'RI-cumulative-bounds',
    section: 'Receipt Issuance',
    requirement: 'A cumulative limit that would be exceeded MUST be rejected (CUMULATIVE_LIMIT_EXCEEDED)',
    tests: ['test/cumulative-tracking.test.ts', '../suveren-as/src/__tests__/cumulative-windows.test.ts'],
  },
  {
    id: 'RI-review-mode',
    section: 'Receipt Issuance',
    requirement:
      'In review mode the AS MUST NOT issue a receipt for an action the human has not approved (PROPOSAL_REQUIRED)',
    tests: ['test/deferred-commitment.test.ts', '../suveren-as/src/__tests__/proposal-approve-reject.test.ts'],
  },
  {
    id: 'RI-proposal-match',
    section: 'Receipt Issuance',
    requirement:
      'A receipt request that does not match the approved proposal (tool, args, context) MUST be refused (PROPOSAL_MISMATCH)',
    tests: ['../suveren-as/src/__tests__/receipt-proposal-match.test.ts'],
  },
  {
    id: 'RI-above-cap',
    section: 'Receipt Issuance',
    requirement:
      'In review_above_cap mode, exceeding a cap MUST return APPROVAL_REQUIRED with the approver list — never a silent downgrade to BOUND_EXCEEDED',
    tests: ['test/team-approval.test.ts', '../suveren-as/src/__tests__/receipt-cap-enforcement.test.ts'],
  },
  {
    id: 'RI-owner-coverage',
    section: 'Receipt Issuance',
    requirement:
      'Before issuing, the AS MUST validate that attesting owners cover the required approver set',
    tests: ['../suveren-as/src/__tests__/receipt-owner-coverage.test.ts'],
  },
  {
    id: 'RI-retired-identifiers',
    section: 'Receipt Issuance',
    requirement:
      'A receipt request carrying attestationHash / frame_hash / path MUST be rejected (MALFORMED_RECEIPT_REQUEST)',
    tests: ['test/authorization-identity.test.ts'],
  },
  {
    id: 'RI-caller-owns-attestation',
    section: 'Receipt Issuance',
    requirement:
      'A caller who neither created the authorization nor belongs to its group MUST NOT obtain a receipt against it',
    tests: ['test/authority-hardening.test.ts', '../suveren-as/src/__tests__/authority-hardening.test.ts'],
  },

  // ── Gatekeeper & Executor ─────────────────────────────────────────────────
  {
    id: 'GK-receipt-before-execution',
    section: 'Gatekeeper & Executor',
    requirement:
      'Execution MUST be preceded by local verification AND issuance of a receipt; no receipt, no execution',
    tests: ['test/as-outage-fail-closed.test.ts', 'test/tool-gating.test.ts'],
  },
  {
    id: 'GK-fail-closed-as-unreachable',
    section: 'Gatekeeper & Executor',
    requirement:
      'If the AS is unreachable the Gatekeeper MUST block; MUST NOT use a cached receipt; MUST NOT have a degraded mode',
    tests: [
      'test/as-outage-fail-closed.test.ts',
      '../suveren-gateway/apps/mcp-server/test/tools.test.ts',
    ],
  },
  {
    id: 'GK-no-retry-past-definitive',
    section: 'Gatekeeper & Executor',
    requirement:
      'The Gatekeeper MUST reuse the idempotencyKey across retries and MUST NOT retry past a definitive rejection',
    tests: ['../suveren-gateway/apps/mcp-server/test/receipt-retry.test.ts'],
  },
  {
    id: 'GK-context-constraints-local',
    section: 'Gatekeeper & Executor',
    requirement:
      'The Gatekeeper is the SOLE enforcer of context constraints (enum, subset, pattern) and MUST check them before requesting a receipt',
    tests: ['test/crm-lifecycle.test.ts', 'test/email-lifecycle.test.ts'],
  },
  {
    id: 'GK-commitment-mode-signed',
    section: 'Gatekeeper & Executor',
    requirement:
      'Review-vs-automatic routing MUST come from the SIGNED commitment_mode; a mode/approver disagreement MUST fail closed',
    tests: ['../suveren-gateway/apps/mcp-server/test/commitment-downgrade.test.ts'],
  },
  {
    id: 'GK-every-tool-in-manifest',
    section: 'Gatekeeper & Executor',
    requirement:
      'Every gated tool MUST be described in a manifest; there is no permissive default and no ungated read access',
    tests: ['test/read-authorization.test.ts', 'test/tool-gating.test.ts'],
  },
  {
    id: 'GK-local-log-display-only',
    section: 'Gatekeeper & Executor',
    requirement:
      'A local execution log MUST NOT be used as a second cumulative enforcement layer; the AS is authoritative',
    tests: ['../suveren-gateway/apps/mcp-server/test/consumption-unenforced.test.ts'],
  },
  {
    id: 'GK-content-binding-refuse',
    section: 'Gatekeeper & Executor',
    requirement:
      'A declared-field binding whose required field is absent MUST refuse the call rather than bind less',
    tests: [
      '../suveren-gateway/apps/mcp-server/test/content-binding-fields.test.ts',
      '../suveren-as/src/__tests__/content-binding-fields-receipt.test.ts',
    ],
  },
  {
    id: 'GK-displayed-must-be-bound',
    section: 'Gatekeeper & Executor',
    requirement:
      'An implementation MUST NOT display a consequential parameter it does not bind, nor bind one it does not display',
    ledgered: 'content/0.6/review.md → Register 2 → "Displayed-must-be-bound"',
  },

  // ── Read Authorization ────────────────────────────────────────────────────
  {
    id: 'RA-resource-scope-binds-reads',
    section: 'Read Authorization',
    requirement:
      'A resource scope enforced on writes MUST bind reads of the same resource; a read outside the granted subset MUST be rejected',
    tests: ['test/calendar-read.test.ts'],
  },
  {
    id: 'RA-undeclared-governance-denies',
    section: 'Read Authorization',
    requirement:
      'A read tool declaring no applicable governance MUST be denied, or carry an explicit recorded exemption',
    tests: [
      'test/read-authorization.test.ts',
      '../suveren-gateway/apps/mcp-server/test/manifest-read-governance.test.ts',
    ],
  },
  {
    id: 'RA-unset-window-denies',
    section: 'Read Authorization',
    requirement: 'No configured read window MUST deny, not permit everything; 0 means "read nothing"',
    tests: ['test/read-policy.test.ts', '../suveren-gateway/apps/mcp-server/test/read-age-config.test.ts'],
  },
  {
    id: 'RA-capability-gate',
    section: 'Read Authorization',
    requirement:
      'A read gated on a capability bound the grant does not carry MUST be blocked (missing ⇒ blocked)',
    tests: ['test/read-gate-records.test.ts', 'test/crm-export-gate.test.ts'],
  },
  {
    id: 'RA-query-injection-uncancellable',
    section: 'Read Authorization',
    requirement:
      'Injected query constraints MUST be combined so an agent fragment cannot capture or cancel them; unsafe fragments MUST fail closed',
    tests: [
      'test/email-read-age.test.ts',
      '../suveren-gateway/apps/mcp-server/test/read-age-mechanisms.test.ts',
    ],
  },
  {
    id: 'RA-resource-widening-not-agent-supplied',
    section: 'Read Authorization',
    requirement:
      'A resource-widening argument (includeSpamTrash-style) is the Gatekeeper\'s to set; it MUST NOT be passed through unvalidated',
    tests: ['test/email-read-age.test.ts', '../suveren-gateway/apps/mcp-server/test/blocked-args.test.ts'],
  },
  {
    id: 'RA-per-correspondent-overrides',
    section: 'Read Authorization',
    requirement: 'Per-correspondent overrides raise a window for named participants; overrides may only raise',
    ledgered: 'content/0.6/review.md → Register 2 → "Per-correspondent overrides"',
  },
];
