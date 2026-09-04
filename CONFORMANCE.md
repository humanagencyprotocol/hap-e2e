# Suveren — HAP implementation report

**Implementation:** Suveren — Suveren Gateway (Gatekeeper + Executor; open source) and Suveren Authority Server (Authority Server; **proprietary**, hosted at suveren.ai), built on `@humanagencyp/hap-core` (open source).
**Specification:** Human Agency Protocol, `content/<version>/` at [humanagencyprotocol/hap-protocol](https://github.com/humanagencyprotocol/hap-protocol).
**Report date:** 2026-09-03. **Maintainer:** Suveren. **Update rule:** this file changes in the same change as any implementation change that affects a normative requirement.

This is *one implementation's* statement of where it stands against the specification, in the specification's terms (`governance.md` → *Reference Conformance* → *Implementation reports*). It replaces the status registers that lived in the specification's `review.md` until 2026-09-03: a specification must be checkable by readers who cannot see the implementation, and the Authority Server here is proprietary, so status written into the spec was an unverifiable claim.

**Writing your own.** Any implementation may publish a report in this shape, and nothing about it is Suveren-specific: state the protocol version you claim on the wire, which optional surfaces you implement, which conformance vectors you reproduce, and every normative requirement you do not yet meet — named as the specification names it, not as your code names it. Do not describe internals a reader cannot inspect; where a claim rests on code nobody outside can see, say so, as the last section here does.

**What a reader of this report can check.** The Gateway, the core library, the profiles and this suite are open, so every claim about them is verifiable by running `npm test` with the public repositories checked out. Claims about the Authority Server's internals are the operator's word, and are collected in the final section rather than scattered through the others.

## Version claimed on the wire

- **Mandates:** issued with `version: "0.5"` and pre-0.6 field names (`attestation_id`, `context_hash`, `resolved_owners`, `resolved_domains`). Not yet v0.6 on the wire, not yet v0.7. The v0.7 vocabulary (`mandate_id`, `scope_hash`, `mandate_owners`, `HAP-mandate`) is not implemented.
- **Tickets:** carry no `version`, `issuer`, or `mandateId`; carry an `authorizationId` and a `path` field the specification forbids.
- **Features implemented beyond the version stamp:** content binding (v1 and v2), read authorization, identity assurance (`self_declared`, `as_vouched`), Gatekeeper custody archive, permanent revocation, exactly-once ticket issuance, `appliesTo`, the `intent-disclosure@0.1` companion (with the limitations stated in the specification).

## Conformance vectors (`content/0.7/vectors/`)

| Set | Status |
|---|---|
| `canonical-bounds-and-scope.json` | Reproduced by the core library, the Gateway UI, and this suite's helper — on unreleased branches (2026-09-03). The released core library (0.9.0) does not escape values, does not refuse newlines, and renders absent optional keys as a placeholder; it fails the escaping, refusal, and optional-key cases. |
| `profile-hash.json` | Not implemented (no party computes `profile_hash`). |
| `payload-signatures.json` | Not reproducible: v0.7 field names are not implemented, and signatures are emitted as standard base64 rather than base64url. |
| `required-refusals.json` | Partially: the ticket-path refusals for missing/unregistered `actionType`, unknown mandate, revoked, expired, idempotency key required/mismatch, proposal states, and retired identifiers are produced, several under retired code names (see *Error codes*). Mandate-path refusals for `profile_hash`, `PROFILE_INVALID`, `disclose_fields`, `expires_at`, nonce reuse, and `VERSION_UNSUPPORTED` are not implemented. `BOUND_EXCEEDED` / `CUMULATIVE_LIMIT_EXCEEDED` are emitted under a retired generic code. |

## Requirements met, by area (verifiable through this suite unless marked *operator's word*)

- Pre-flight ticket before execution, fail-closed on an unreachable Authority Server; no bypass mode, no cached-ticket reuse, no degraded mode.
- Idempotency key per invocation, reused unchanged on retry, no retry past a definitive refusal.
- Commitment mode routed from the signed payload; commitment-mode downgrade fails closed.
- `actionType` taken from the manifest's `staticExecution` only; validated against the profile registry; a write with no action type is refused.
- Closed manifest transform vocabulary; `_`-prefixed keys never enter the execution context.
- Per-transaction bounds and scope constraints (`enum`, `subset`, `requiredFor`) enforced locally before the ticket request.
- Cumulative state recomputed from ticket history with the specified windows (rolling 24 h, rolling 7 d, calendar month UTC) — *operator's word*, exercised by the cumulative-tracking suite.
- Exactly-once issuance: idempotent replay returns the original ticket before any state mutates; review-path `committed → executed` transition is atomic.
- Permanent revocation: no un-revoke path; a revoked mandate cannot be renewed under the same id.
- Third-party verification response contains only signed fields, signature, and revocation status.
- Ticket lookup by content: opt-in per profile, rate-limited, indistinguishable not-found.
- `title` never in the signed payload.
- Read authorization: unset window denies (for tools declaring an age dimension); resource scopes bind reads; undeclared read governance denies at runtime and at lint time; query injection is bracketed and fails closed; resource-widening arguments are set by the Gateway, not the agent.
- Content binding: text canonicalization (NFC, LF, trailing whitespace, trailing blank lines), v2 declared fields with `required_fields`, absent/empty equivalence, refusal when no declared field carries a value, identifier normalization before display, transport encoding after hashing.
- Gatekeeper custody: append-only, encrypted, unpruned archive of the complete signed ticket and mandate blobs, with an offline signature verifier.
- Notification surfaces carry presence, never content.

## Requirements not met (in the specification's terms)

Fixed on unreleased branches as of 2026-09-03, recorded here on release:
- *Privacy Invariant* — the content-hash preimage was sent to the Authority Server alongside the hash.
- *Executor Gating* — cumulative bounds were enforced from a local record before the Authority Server was consulted.
- *Tool-Gating Manifests* rule 1 — a tool absent from a manifest was not refused.
- *Canonicalization Rules* — value escaping, newline refusal, and the absent-optional-key rule (hash-affecting; requires the three canonicalizers to ship together and sparse mandates to be re-issued).
- *Gatekeeper & Executor Behavior* — the verification library approved an empty mandate list.
- *Mandate Request Schema* — a mandate could be requested with a hash and no plaintext bounds, after which no bounds were enforced at ticket time.
- *AS Authorization Responsibilities* 2–3 — group membership was checked, required-approver status was not.
- *Retention at the Authority Server* — signed mandate blobs were not retained past expiry.
- One authentication path accepted an unverified header as an owner identity (removed).

Open:
- *Ticket Request Schema* rule 1 — `boundsHash` is not the lookup key; a mandate identifier is required in its place.
- *Ticket Payload Schema* rule 2 — tickets carry `path`.
- *Signing Canonicalization* rule 3 — signatures are standard base64, not base64url.
- *Error Codes* — retired and non-canonical codes are emitted (`LIMIT_EXCEEDED`, `ATTESTATION_*`, `MALFORMED_RECEIPT_REQUEST`, `PROPOSAL_ATTESTATION_MISMATCH`, and implementation-specific codes); `APPROVAL_REQUIRED` is emitted outside the error envelope with user identifiers rather than DIDs.
- *Ticket Verification* — the redacted public ticket page presents a "valid" indicator the specification forbids on a redacted view.
- *Bounds Schema* rule 3 / *Migration* semantic change 1 — the field-name fallback remains in both enforcement points; its absent-`appliesTo` semantics are narrower than "governs every action type".
- *Trust on First Use* / *Profile Bytes Retention* — profiles are fetched at runtime from a mutable source and not retained.
- *Mandate Payload* — no `issuer`; no signing-key rotation; no `profile_hash`; no `supported_versions` negotiation.
- *Commitment Modes* — `review_above_cap` is not accepted as a signed mode; above-cap routing uses unsigned group configuration, and the Gateway has no signed approver list to enforce against.
- *Validation Steps* — `scope_hash` is verified only when scope is non-empty; the review path re-issues a ticket without re-running local verification.
- *Privacy Invariant* / *Enforcement Authority* — scope values reach the Authority Server in plaintext: the mail connector's manifest maps a message's recipients into execution-context keys that the scope schema declares, and the whole execution context is sent and stored in the signed ticket. No bound reads them and the AS cannot act on them, so the disclosure is pure cost. Direction recorded in the specification's ledger (*Scope values must not travel in the execution context*).
- *Owner Signatures* — the `did:key` implementation accepts Ed25519 only, while platform authenticators commonly sign with P-256; the curve for signing DIDs is an open decision that blocks the owner-signature phase.
- *Read Authorization* — per-correspondent overrides not built; post-fetch age enforcement omitted for list/search tools; NFKC normalization absent; the mail container control is a denylist, not the preferred allowlist.
- *Content Binding* — displayed-must-be-bound: a blind-copy recipient is displayed and not bound; mitigated in review mode by full-argument proposal matching only.
- *Gatekeeper custody* — the issuer key is optional per archive entry; the archive is best-effort rather than blocking; no owner deletion after the retention floor.
- *Identity DIDs vs signing DIDs* — owner DIDs are decorative `did:key` strings carrying no key; no owner signatures (P2–P5 not started); no WebAuthn.
- *Multi-Owner Coverage Rule* — coverage is checked per record, not as the union of live mandates.
- *Profiles* — published profiles carry `paths` arrays (`customers@0.7`, `email@0.6`) and a `field.enum` (`deploy@0.9`); one count bound declares an empty `appliesTo`; all are v0.6-shaped.
- *Version negotiation*, *Ticket Disclosure Is Declared*, `disclose_fields`, the enforcement-class annotations, the wire vocabulary — not implemented.

## What this suite proves

`conformance/core-musts.ts` maps 31 normative MUSTs from *Ticket Issuance*, *Gatekeeper & Executor Behavior*, and *Read Authorization* to the tests here that exercise them against a real Authority Server, real Gateway, and real MCP servers, or to the line above where the requirement is not yet met. A mapping that points nowhere fails the suite. The vectors are consumed by `test/canonical-vectors.test.ts` (on the unreleased branch).

## What a reader cannot check

The Authority Server's internals: cumulative-state computation, revocation storage, retention, key custody, and the migration behaviour of its stores. Those lines above are the operator's statements. The specification's *Enforcement classes* table says which of them a relying party is trusting the operator for in any case.
