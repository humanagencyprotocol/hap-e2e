# hap-e2e — TODO

Work items for the conformance suite. Protocol-level directions live in the
specification's forward ledger (`hap-protocol/content/<version>/review.md`);
this file is where the corresponding *work* is tracked. Where Suveren's
implementation falls short of a requirement, that is recorded in
`CONFORMANCE.md`, not here.

## Coverage

- [ ] **Extend the conformance map beyond the enforcement core.**
  `conformance/core-musts.ts` covers 31 MUSTs from Ticket Issuance, Gatekeeper
  & Executor and Read Authorization, out of roughly 201 in the specification.
  Extending it is mechanical — add entries and the checker does the rest.
  Priority order: the mandate-issuance refusals (they now have published
  vectors to check against), then Retention and custody, then the owner-
  signature verification procedure.

- [ ] **Consume the published refusal vectors.** `test/canonical-vectors.test.ts`
  drives `canonical-bounds-and-scope.json`. The other three sets are published
  and unused here: `required-refusals.json` is the one that would earn its
  keep, because it turns "the AS refuses correctly" from prose into a table the
  live suite can iterate. Blocked on the implementation emitting canonical
  error codes — see `CONFORMANCE.md`.

- [ ] **Classify Mollie's read tools.** Its MCP server is remote and publishes
  no tool list, so anything unclassified is gated as a write — safe, but reads
  consume a write budget and produce tickets. Needs credentials to capture the
  live tool list once; see the ledger entry on remote, vendor-controlled
  connectors.

## Portability

- [ ] **Extract an adapter seam,** if and when a second implementation exists.
  The README's *Bring your own Authority Server* section states the shape; this
  is the work behind it. The coupling is more concentrated than it looks: no
  test reads a `SUVEREN_*` variable, and 19 of 31 suites never call `fetch`
  directly — they speak through `src/helpers/`. Three things would have to move
  behind an interface:
  - `process-manager.ts` — hardcodes `npx next start` in `suveren-as/` and
    `node apps/mcp-server/dist/http.mjs`
  - `sp-client.ts` / `gateway-client.ts` — of the Authority Server endpoints
    used, only the mandate and ticket payloads are specified; `register` and
    the `groups` endpoints are Suveren's alone, and the gateway side is
    entirely the private `/internal/*` control plane
  - the "personal group" assumption, which 25 suites depend on and which is a
    Suveren modelling choice rather than a HAP concept

  Deliberately **not** done yet, and the reason has changed: it used to be
  "there is nothing a third party can check against". That is no longer true —
  the specification publishes conformance vectors, and `npm run test:offline`
  runs them here. The remaining blocker is that HAP defines no endpoints, so an
  adapter has no wire to adapt to. The ledger tracks that as a non-normative
  HTTP binding companion; this work follows it, not the other way round.

## Housekeeping

- [ ] **Give `hap-profiles` its own CI.** It has no tests and no workflow of
  its own; its only automated check is `profile-conformance.test.ts` here.
  Roughly twenty lines of workflow removes the dependency, so HAP's published
  profiles are not validated solely by a suite that lives elsewhere.

- [ ] **Update the vocabulary.** Test names, helpers and assertions use the
  pre-v0.7 words (attestation, receipt, context) because the implementation's
  wire still does. They move when the implementation renames — one change, not
  two — and the README says so.

## Done

- [x] **Publish an implementation-neutral vector set.** Shipped 2026-09-03 with
  v0.7: canonical bounds and scope strings and hashes, payload signatures under
  published test keys, the profile hash, and the required-refusal tables, at
  `hap-protocol/content/0.7/vectors/`. Consumed here by
  `test/canonical-vectors.test.ts` and runnable with no server via
  `npm run test:offline`.
