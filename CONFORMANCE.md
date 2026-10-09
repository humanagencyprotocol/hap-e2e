# Suveren — HAP implementation report

**Implementation:** Suveren — Suveren Gateway (Gatekeeper + Executor; open source) and Suveren Authority Server (Authority Server; **proprietary**, hosted at suveren.ai), built on `@humanagencyp/hap-core` (open source).
**Specification:** Human Agency Protocol, `content/<version>/` at [humanagencyprotocol/hap-protocol](https://github.com/humanagencyprotocol/hap-protocol).
**Report date:** 2026-10-09 (describes the v0.7 release: hap-core 0.12.0, the v0.7 Authority Server and Gateway). **Maintainer:** Suveren. **Update rule:** this file changes in the same change as any implementation change that affects a normative requirement.

This is *one implementation's* statement of where it stands against the specification, in the specification's terms (`governance.md` → *Reference Conformance* → *Implementation reports*). It replaces the status registers that lived in the specification's `review.md` until 2026-09-03: a specification must be checkable by readers who cannot see the implementation, and the Authority Server here is proprietary, so status written into the spec was an unverifiable claim.

**Writing your own.** Any implementation may publish a report in this shape, and nothing about it is Suveren-specific: state the protocol version you claim on the wire, which optional surfaces you implement, which conformance vectors you reproduce, and every normative requirement you do not yet meet — named as the specification names it, not as your code names it. Do not describe internals a reader cannot inspect; where a claim rests on code nobody outside can see, say so, as the last section here does.

**What a reader of this report can check.** The Gateway, the core library, the profiles and this suite are open, so every claim about them is verifiable by running `npm test` with the public repositories checked out. Claims about the Authority Server's internals are the operator's word, and are collected in the final section rather than scattered through the others.

## Version claimed on the wire

- **v0.7.** Mandates are issued with `version: "0.7"` and the v0.7 vocabulary (`mandate_id`, `scope_hash`, `mandate_owners`, `HAP-mandate`), with `issuer` and `profile_hash`; the request carries `supported_versions` and is refused with `VERSION_UNSUPPORTED` when there is no common version. Only v0.7 is supported: mandates issued under earlier versions are refused (`VERSION_UNSUPPORTED`) and re-approved — a deliberate pre-1.0 choice, made possible because no v0.6 mandate was ever issued (earlier mandates were v0.5).
- **Tickets:** carry `version`, `issuer`, `mandateId`, `limits`; signatures are base64url; no `path`. Tickets additionally carry a signed `authorizationId` — an implementation extension the specification does not define (the Gateway binds a ticket to the grant it requested by it). The specification's direction *A ticket names the request it answers* addresses the same need.
- **Features implemented:** content binding (v1 and v2), read authorization, identity assurance (`self_declared`, `as_vouched`), Gatekeeper custody archive, permanent revocation, exactly-once ticket issuance, `appliesTo`, `disclose_fields`, the `intent-disclosure@0.1` companion (with the limitations stated in the specification).

## Conformance vectors (`content/0.7/vectors/`)

| Set | Status |
|---|---|
| `canonical-bounds-and-scope.json` | Reproduced by the core library (0.12.0) and this suite's helper. |
| `profile-hash.json` | Reproduced by the core library and this suite. |
| `payload-signatures.json` | Reproduced by the core library (all cases, incl. the owner-signed projection and the co-signed chain). This suite replays the AS-signed cases through the published library; the owner-signed cases are a named gap here. |
| `required-refusals.json` | Every row is accounted for: the Authority Server's own tests drive 22 rows through its real routes and assert the code in the `{approved:false, errors:[{code}]}` envelope (*operator's word* — those tests are not public); the core library decides the 9 profile/signature/version rows; the `fail_closed_situations` are Gatekeeper behaviour exercised by this suite. |

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
- Gatekeeper custody: append-only, encrypted, unpruned archive of the complete signed ticket and mandate blobs, with the issuer key on every entry and an offline signature verifier; the archive entry is written before execution and a failed write blocks the action (`wire-switch-v07.test.ts` proves a real gated write's entry verifies offline with only its stored key).
- Scope values do not travel to the Authority Server: the execution context sent in a ticket request carries only the fields a bound reads and the action type.
- Error codes: every refusal on the wire uses the canonical code in the specification's envelope; implementation-specific codes appear only where the specification assigns none.
- Version negotiation and the hard switch: the retired v0.6 ticket path answers 410 `VERSION_UNSUPPORTED`; the Gateway checks the Authority Server's protocol version at start and fails closed on a mismatch.
- Notification surfaces carry presence, never content.

## Requirements not met (in the specification's terms)

- *Ticket Request Schema* rule 1 — the ticket request is resolved through the authorization record; `boundsHash` is checked against it but is not the sole lookup key.
- *Profiles* — `deploy@0.11` declares a field-level `enum` beside its `boundType` (`rollback_allowed`).
- *Error Codes* — `APPROVAL_REQUIRED` from the team above-cap mechanism names approvers by user identifier rather than DID.
- *Ticket Verification* — the redacted public ticket page presents a "valid" indicator the specification forbids on a redacted view.
- *Trust on First Use* / *Profile Bytes Retention* — profiles are fetched at runtime; `profile_hash` now binds each mandate to the exact bytes, but the bytes are not retained.
- *Mandate Payload* — no signing-key rotation.
- *Commitment Modes* — `review_above_cap` is not accepted as a signed mode; above-cap routing uses unsigned group configuration.
- *Validation Steps* — the review path re-issues a ticket without re-running local verification.
- *Owner Signatures* — the `did:key` implementation accepts Ed25519 only, while platform authenticators commonly sign with P-256; the curve for signing DIDs is an open decision that blocks the owner-signature phase.
- *Read Authorization* — per-correspondent overrides not built; post-fetch age enforcement omitted for list/search tools; NFKC normalization absent; the mail container control is a denylist, not the preferred allowlist.
- *Content Binding* — displayed-must-be-bound: a blind-copy recipient is displayed and not bound; mitigated in review mode by full-argument proposal matching only.
- *Gatekeeper custody* — no owner deletion after the retention floor.
- *Identity DIDs vs signing DIDs* — owner DIDs are decorative `did:key` strings carrying no key; no owner signatures (P2–P5 not started); no WebAuthn.
- *Multi-Owner Coverage Rule* — coverage is checked per record, not as the union of live mandates.
- The enforcement-class annotations — not implemented.

## What this suite proves

`conformance/core-musts.ts` maps 31 normative MUSTs from *Ticket Issuance*, *Gatekeeper & Executor Behavior*, and *Read Authorization* to the tests here that exercise them against a real Authority Server, real Gateway, and real MCP servers, or to the line above where the requirement is not yet met. A mapping that points nowhere fails the suite. The vectors are consumed by `test/canonical-vectors.test.ts` and `test/profile-and-signature-vectors.test.ts`; `test/wire-switch-v07.test.ts` covers the v0.7 switch itself (retired path, version refusal, permanent revocation, `PROFILE_INVALID`, offline-verifiable custody).

## What a reader cannot check

The Authority Server's internals: cumulative-state computation, revocation storage, retention, key custody, and the migration behaviour of its stores. Those lines above are the operator's statements. The specification's *Enforcement classes* table says which of them a relying party is trusting the operator for in any case.
