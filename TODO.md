# hap-e2e — TODO

Work items for the conformance suite. Protocol-level directions live in the
ledger (`hap-protocol/content/0.6/review.md`); this file is where the
corresponding *work* is tracked, and links back to it.

## Conformance vectors — publishing what a third party can check

- [ ] **Publish an implementation-neutral vector set.** Tracked in the ledger
  as *"Conformance vectors — making 'open protocol' checkable" (targets v0.7)*.
  Three sets, all checkable offline with no server running:
  - canonical bounds → the exact canonical string → its `sha256`
  - attestation and receipt payloads + a published test key → the exact
    base64url signature
  - a table of (situation, request, required error code)

  Most of the material exists — `hap-core` already publishes signing vectors,
  and `conformance/core-musts.ts` enumerates the refusals worth pinning. The
  work is collecting it into a published artifact rather than inventing it.

  **Why not simply share this suite:** it drives *this* implementation's
  processes and URLs, and the specification defines no endpoints at all. A
  conformant Authority Server may share no URL with ours.

  **What it will not prove:** sequence — that the receipt preceded execution,
  or that cumulative state is right across many calls. Those need a live suite.
  Say so wherever the vectors are published.

## Making this suite reusable by another implementation (secondary)

- [ ] **Extract an adapter seam,** if and when a second implementation exists.
  The coupling is more concentrated than it looks: no test reads a `SUVEREN_*`
  variable, and 19 of 31 suites never call `fetch` directly — they speak
  through `src/helpers/`. Three things would have to move behind an interface:
  - `process-manager.ts` — hardcodes `npx next start` in `suveren-as/` and
    `node apps/mcp-server/dist/http.mjs`
  - `sp-client.ts` / `gateway-client.ts` — of the AS endpoints used, only
    `attest` and `receipt` have specified payloads; `register` and the
    `groups` endpoints are ours alone, and the gateway side is entirely the
    private `/internal/*` control plane
  - the "personal group" assumption, which 25 suites depend on and which is a
    Suveren modelling choice rather than a HAP concept

  Deliberately **not** done yet: there is no second implementation to justify
  the abstraction, and inventing a seam for a hypothetical consumer usually
  fits only that hypothesis. The vector set above serves a third party sooner
  and at a fraction of the cost.

## Ownership — this suite belongs to Suveren, not to HAP

Not started; recorded so the decision is picked up deliberately rather than
rediscovered. **Step 3 needs a GitHub org transfer and is the owner's call.**

The finding: this repo is the reference implementation's conformance suite
wearing a protocol name. The sharpest evidence is not the hardcoded paths —
it is that **nobody outside Suveren can run it**. CI checks out
`suverenai/suveren-as`, a private repo, with a token. A repo in the protocol
org that no community member can execute is mislabelled by definition.

Supporting: `process-manager.ts` runs `npx next start` in `suveren-as/` and
`node apps/mcp-server/dist/http.mjs`; the gateway side drives the private
`/internal/*` control plane; and 25 of 31 suites depend on "personal group",
a Suveren modelling choice with no basis in the specification.

Do these in order — the first is a prerequisite, not a nicety:

- [ ] **Give `hap-profiles` its own CI first.** It has no tests and no
  workflow of its own; its only automated check is `profile-conformance.test.ts`
  in this repo. Moving this suite as-is would leave HAP's published profiles
  validated solely by a Suveren-owned repo — a governance smell for an open
  protocol, and a silent one. Roughly twenty lines of workflow removes the
  dependency entirely.
- [ ] **Correct the claim in the README.** It opens "The only place HAP
  enforcement is proven end to end" — true of the implementation, overclaiming
  for a repo in the protocol org. It should say *the reference
  implementation's* conformance suite.
- [ ] **Then transfer to `suverenai/`,** named for what it is
  (`suveren-conformance` or similar). Cross-org checkout already works in both
  directions, so CI is unaffected. Owner action: it changes URLs people may
  hold.
- [ ] **Leave a pointer in the HAP org,** so "where is HAP tested?" has an
  answer rather than a gap.

**What must NOT simply move with it.** `conformance/core-musts.ts` is two
things fused: what the protocol requires (protocol-level) and which of our
tests prove it (implementation-level). The first half is precisely what a
third-party implementer needs, and it belongs in the HAP org alongside the
vector set above.

**The counter-argument, recorded because it is fair:** moving this out leaves
the protocol org visibly thinner — specification, profiles, core library,
connectors, and no end-to-end proof — which some readers will take as
"unimplemented". That is an argument for shipping the conformance vectors, not
for keeping a suite where it does not belong. Vectors in the HAP org and the
harness in Suveren's is the honest version of what the org currently implies.

## Coverage

- [ ] **Classify Mollie's read tools.** Its MCP server is remote and publishes
  no tool list, so anything unclassified is gated as a write — safe, but reads
  consume a write budget and produce receipts. Needs credentials to capture the
  live tool list once; see the ledger entry on remote connectors.
- [ ] **Extend the conformance map beyond the enforcement core.** It covers 31
  MUSTs from Receipt Issuance, Gatekeeper & Executor and Read Authorization,
  out of roughly 201 in the specification. Extending it is mechanical — add
  entries and the checker does the rest.
