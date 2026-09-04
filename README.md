# hap-e2e — HAP conformance suite

The only place HAP enforcement is proven end to end: a real Authority Server,
a real gateway built from source, and real MCP servers over stdio. No mocks,
no stubbed transports.

MIT licensed. This file is the reference for testing across the whole project —
what exists, where it lives, how to run it, and what is deliberately not
covered.

## Three layers, and what each one needs

The suite has a public half and a Suveren half. Read this table before cloning:
most of it needs a checkout you may not have.

| Layer | What it proves | What you need |
|---|---|---|
| **1. Offline conformance** | Canonicalisation bytes and hashes match the published vectors; every profile declares `actionTypes` and `appliesTo`; every mapped MUST resolves to a real test or a recorded gap | This repo and the public spec. `npm ci && npm run test:offline` — 66 tests, no server, no build, no credentials (it runs under its own `vitest.offline.config.ts`, which omits the build step the live suites need) |
| **2. Live suite against Suveren** | The invariant itself: pre-flight tickets, fail-closed on an unreachable Authority Server, bounds, revocation, review flows, read governance, content binding | Everything in layer 1 **plus a checkout of `suveren-as`, which is proprietary and not public.** Without it, `npm test` fails in the build step |
| **3. Live suite against your own Authority Server** | That *your* implementation satisfies the same MUSTs | Not possible yet — see *Bring your own Authority Server* |

**The Authority Server is proprietary.** Suveren's Gateway, the profiles, the
core library, the connectors, the specification and this suite are open; the
Suveren Authority Server is not. That is a deliberate split, stated in the
protocol's own positioning, and it has a consequence you should know before you
start: the layer-2 tests spawn Suveren's Authority Server from source, so
without that checkout they cannot run. What you *can* run is layer 1, and what
you can *read* is `CONFORMANCE.md` — Suveren's report of where its
implementation stands against the specification, requirement by requirement.

## Bring your own Authority Server

Not supported today, and the reason is a gap in the specification rather than a
gap here.

HAP fixes **payloads, canonicalisation, error codes and refusals**. It
deliberately defines **no endpoints, no request authentication, no proposal or
approval transport, and no response envelope** beyond the `{approved, errors}`
shape. Two conformant implementations therefore verify each other's mandates
and tickets and still cannot talk to each other. This suite speaks Suveren's
HTTP API through one file — `src/helpers/sp-client.ts` — so pointing it at a
different Authority Server means reimplementing that file for that server.

What would make it portable, in order:

1. **A wire binding.** The protocol ledger tracks a non-normative companion
   (`hap-http-binding@0.1`): paths, methods, an auth header, the envelope, and
   `.well-known` key discovery. Until that exists, "portable live suite" has
   nothing to be portable *to*.
2. **An adapter seam here.** Split `sp-client.ts` into protocol operations
   every Authority Server must offer (issue a mandate, issue a ticket, revoke,
   verify, publish a key) and product operations only some will have (register
   a user, create a group, configure approvers). Point the suite at a running
   server with an environment variable instead of spawning one; tests that need
   product operations skip loudly when an adapter lacks them, exactly as the
   credential-gated suites already do.

In the meantime, an independent implementation can check itself against
**layer 1** — the vectors are implementation-neutral by construction — and use
`conformance/core-musts.ts` as the checklist of what a live suite would have to
prove.

## Repository layout

The suite spans six repositories, which is why it lives in its own. It resolves
siblings from the parent directory, so check them out alongside this one, not
inside it:

```
<workspace>/
  hap-e2e/            ← you are here                                  (public)
  hap-protocol/       ← specification, vectors, ledger                (public)
  hap-profiles/       ← published profiles                            (public)
  suveren-gateway/    ← Gatekeeper + Executor                         (public)
  hap-records-mcp/    ← connector used by several suites (must be BUILT) (public)
  suveren-as/         ← Authority Server — PROPRIETARY, not published
```

Layers 1 and the parts of the browser suite that do not reach the Authority
Server need the public five. Everything else needs `suveren-as`.

## Running it

Layer 1, from a fresh clone of this repo alone:

```bash
npm ci
npm run test:offline      # 66 tests: vectors, profiles, the MUST map
```

Layer 2, with all six repositories checked out as siblings:

```bash
npm ci
npx vitest run            # protocol conformance
npx playwright test       # browser journeys
```

Both spawn their own Authority Server and gateway on dedicated ports and tear
them down afterwards. **Do not run them concurrently** — they compete for those
ports.

`hap-records-mcp` must be built (`npm ci && npm run build`) — its `dist/` is
gitignored, and three suites spawn it directly. A fresh checkout does not have
it; a developer machine usually does, which is why its absence only ever broke
CI.

**Node ≥ 22 is required.** The MCP connectors and their `better-sqlite3`
dependency declare it. npm only *warns* on an engine mismatch and installs
anyway, so on Node 20 everything looks fine until the native binding fails at
runtime and every connector call returns "Tool not found".

Builds happen **once per run** in a vitest `globalSetup` (the gateway, and a
production build of the AS). Suites still start their own AS process, so
per-suite isolation is unchanged — only compilation is shared. Set
`HAP_E2E_SKIP_BUILD=1` to reuse existing output while iterating on one suite;
never in CI, where a stale build would test code that is not under review.

The AS runs as `next start`, not `next dev`. That is deliberate: the two are
not the same server, and the difference is not academic — a route prerendered
at build time was serving a stale signing key, which only production mode
revealed.

## A note on vocabulary

The specification moved to one vocabulary at v0.7: **mandate** (was
attestation), **mandate ticket** or **ticket** (was execution receipt),
**scope** (was context), **Mandate Owner** (was Decision Owner). The invariant
is *no mandate, no ticket; no ticket, no execution.*

Test names, helper files and assertions here still use the older words, because
they test the running implementation and its wire has not been renamed yet. The
rename is tracked in the protocol's changelog and in `CONFORMANCE.md`; this
README uses the current words for concepts and the old ones when naming a file
or a field that really is still called that.

## Where the tests are

Counts are what the runners report (parameterised cases expand at runtime, so
grepping the files under-counts).

| Repo | Location | Cases | Runs in CI |
|---|---|---|---|
| **hap-e2e** | `test/` (vitest, real stack) | 207 + 32 skipped | ✅ `e2e.yml` |
| | `e2e/` (Playwright, browser journeys) | 31 | ✅ same workflow |
| | `conformance/` (the MUST map — data, not tests) | — | ✅ checked by `test/conformance-map.test.ts` |
| **suveren-as** | `src/__tests__/` | 284 | ✅ `ci.yml` |
| **suveren-gateway** | `apps/mcp-server/test/` | 486 | ✅ `test.yml` |
| | `apps/control-plane/src/__tests__/` | 155 | ✅ same |
| | `apps/ui/src/**` | 120 | ✅ same |
| **hap-core** | `test/` | 197 | ✅ `ci.yml` |
| **hap-records-mcp** | `src/` | 4 | ✅ `ci.yml` |
| **hap-deploy-mcp** | `src/` | 9 | ✅ `ci.yml` |
| **hap-profiles** | — | 0 | validated from here (below) |
| **hap-crm-mcp**, **hap-linkedin-mcp**, **hap-googlecalendar-mcp** | — | 0 | see *Connectors without a suite* |

`hap-profiles` has no test tooling of its own. Two suites here hold it to its
contract instead, because the checks are cross-repo by nature:
`profile-conformance.test.ts` (every profile's latest version declares
`actionTypes` and `appliesTo`) and `hap-core-parity.test.ts` (the AS and the
gateway agree on the `hap-core` version).

### Which layer to put a test in

Default to **hap-e2e, against real servers**. Use an in-repo unit test only
where the wire boundary cannot reach the state under test, and say so in the
file. Current legitimate examples:

- time-warped cumulative windows (`suveren-as/cumulative-windows.test.ts`) —
  needs control of the clock;
- multi-owner coverage (`suveren-as/receipt-owner-coverage.test.ts`) — no live
  endpoint can mint a two-owner authorization;
- canonicalization vectors (`hap-core`) — byte-level, no server involved.

## What is covered

Enforcement, end to end: per-transaction and cumulative bounds; rolling
daily/weekly and calendar-month windows; TTL expiry and revocation;
exactly-once receipts (replay, lost response, mismatch); review-mode proposals
including *approve X, execute Y* refusal; above-cap team escalation and
approval; team roles and cap configuration; encrypted intent sharing; identity
assurance; content binding and verification footers; per-ceremony authorization
identity; and read authorization (age windows, resource scopes, capability
gates, query-injection containment).

The central invariant has its own suite: `as-outage-fail-closed.test.ts` stops
the Authority Server mid-session and proves the next write is refused — with a
positive control first, so "blocked" cannot be confused with "broken".

`conformance/core-musts.ts` maps 31 normative MUSTs from *Ticket Issuance*,
*Gatekeeper & Executor* and *Read Authorization* to the tests that hold them.
It doubles as the checklist an independent implementation would work through.
Every entry resolves to real test files **or** to where its gap is recorded —
never neither. The checker fails if a referenced file disappears or a ledger
claim is not actually written where it says.

## Known gaps

Recorded so that "untested" is never silently read as "not required". The
authoritative list is **`CONFORMANCE.md`** in this repository — Suveren's
implementation report. (It used to be a register inside the specification's
`review.md`; implementation status left the specification on 2026-09-03,
because a spec must be checkable by readers who cannot see the implementation,
and one component of this one is proprietary.)

| Gap | Status |
|---|---|
| **Multi-owner approval** | The receipt-time *check* is implemented and tested, but multi-owner ceremonies are **not reachable**: personal groups resolve to one owner, team groups to the attester, and the only endpoint that could require two returns 410. There is no feature to test end to end. Team governance is expressed through above-cap approvers instead. |
| **Displayed-must-be-bound** | No enforcement. An approval surface shows `bcc` while the binding omits it; defensible only because review-mode proposal matching pins the whole argument set. |
| **Per-correspondent read overrides** | Specified, not built. |
| **Owner mandate signatures** | Specification-led; nothing implemented (phased P1–P5 in the ledger). |
| **Mollie reads** | Its MCP server is remote and publishes no tool list, so anything unclassified is gated as a **write** — safe, but reads consume a write budget and produce receipts. Classifying them needs credentials to capture the live tool list. |
| **`read_daily_max`** | Declared on the email profile, never enforced — reads carry no receipt, so nothing counts them. Marked `enforced: false`, and `appliesTo: []`. |
| **Credential-gated suites** | Four suites and the Stripe half of `e2e.test.ts` self-skip in CI (below). |

## Test processes worth knowing

- **A new test must be able to fail.** Every enforcement test added here was
  verified by breaking the thing it checks and watching it go red. A test that
  has never failed has not been shown to test anything.
- **Confirm the state, not the signal.** `stopProcess` polls until the port
  stops answering, because signalling a process is not the same as the service
  being gone: `npx` spawns a child, and killing the wrapper left the server
  running — a test that passed locally while asserting nothing in CI.
- **Prefer the real trigger path.** A mocked trigger hides a dead feature;
  several bugs here were only visible with a real provider, a real build, or a
  cold CI machine.
- **Timeouts are wall-clock.** Suites set generous limits on purpose: a test
  that goes red because the machine was busy teaches people to hit re-run, and
  that habit is how a broken nightly survives for days.
- **A skip must be loud.** Anything that self-skips says so and is listed
  below, with when it must be run by hand.

## What runs in CI

`.github/workflows/e2e.yml` runs both suites on every push to `main`, on every
PR, and nightly at 06:00 UTC. It checks out all six repos, installs each,
builds `hap-records-mcp`, then runs vitest followed by Playwright (sequentially
— they compete for the same ports).

The nightly is not redundant with the PR run: this suite spans six repos, and
several breakages were pure cross-repo drift where nothing in *this* repo
changed — a footer string altered in the gateway, a profile moving 0.4 → 0.5, a
connector raising its Node floor.

Other repos run their own unit suites on push (`ci.yml` / `test.yml`); none of
them can see cross-repo drift, which is what this one is for.

## Credential-gated suites

**Decision (2026-08-26): no provider credentials in CI.** These suites detect
their missing environment and self-skip, so CI stays green and honest rather
than red-by-default. The cost is that they only run when someone runs them.

| Suite | Needs | Covers |
|---|---|---|
| `email-lifecycle` | `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` | Real send, recipient scope enforcement, revocation mid-flight |
| `email-read-age` | same | Read-age query injection: a trailing `OR`, an unbalanced paren, spam pinned off |
| `verification-footer` | same | The footer on a **genuinely delivered** message, verified against the AS |
| `calendar-read` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALENDAR_REFRESH_TOKEN` | Resource scope on reads, pre-fetch container filtering |
| `e2e` (Stripe half) | `STRIPE_TEST_KEY` | Charge bounds against a real payment API |

### Connectors with no suite of their own — recorded, not overlooked

`hap-linkedin-mcp` has no tests here and none in its own repo. That is a
decision, not a gap nobody noticed:

- The **gating path** it uses is covered. `identity-assurance` and
  `verification-footer-local` exercise the `publish` profile end to end —
  bounds, receipts, content binding, the verification footer — using a local
  stand-in connector, so what the Gatekeeper does for a publish-profile write
  is tested without LinkedIn in the loop.
- What is **not** covered is the connector itself: its argument mapping and
  the shape LinkedIn actually returns. Testing that needs real LinkedIn
  credentials and would post to a real account, which puts it in the same
  category as the credential-gated suites above.

The distinction that matters: a connector bug here cannot bypass the
Gatekeeper — it is downstream of the receipt. It can only make a call fail or
send something malformed. That is why this is acceptable while an untested
*enforcement* path would not be.

`hap-crm-mcp` and `hap-googlecalendar-mcp` likewise have no in-repo tests, but
both are driven directly by suites here (`crm-lifecycle`, `calendar-read`).

**When they must be run by hand:**

- before an Authority Server or gateway **release**;
- after any change to read governance, content binding, footers, or an
  integration manifest;
- when a connector's provider changes an argument or response shape.

They are the only tests that exercise a provider that can mangle what we send.
The em-dash subject that arrived corrupted — RFC 5322 headers are ASCII, the
connector wrote raw UTF-8 — was caught by a real delivery, and could not have
been caught by a mocked one. A green CI run does not cover this class of
defect; say so plainly rather than implying full coverage.

```bash
GMAIL_CLIENT_ID=… GMAIL_CLIENT_SECRET=… GMAIL_REFRESH_TOKEN=… \
  npx vitest run test/email-lifecycle.test.ts
```
