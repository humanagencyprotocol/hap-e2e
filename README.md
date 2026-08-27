# hap-e2e — protocol conformance suite

The only place HAP enforcement is proven end to end: a real Authority Server,
a real gateway built from source, and real MCP servers over stdio. No mocks,
no stubbed transports.

The suite spans five repositories, which is why it lives in its own. It
resolves siblings from the parent directory — `hap-e2e/../suveren-as`,
`../suveren-gateway`, `../hap-profiles`, `../hap-records-mcp` — so check them
out alongside this one, not inside it.

## Running it

```bash
npm ci
npx vitest run            # protocol conformance (27 suites)
npx playwright test       # browser journeys (8 specs)
```

Both spawn their own AS and gateway on dedicated ports and tear them down
afterwards. Do not run them concurrently — they compete for those ports.

## What runs in CI

`.github/workflows/e2e.yml` runs both, on every push to `main`, on every PR,
and nightly at 06:00 UTC. The nightly run is not redundant: this suite spans
five repos and its two most recent breakages were pure cross-repo drift, where
nothing in *this* repo changed.

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

## Layering

Tests belong here by default, against real servers. In-repo unit tests are for
what the wire boundary cannot reach — time-warped cumulative windows, or a
store state no live endpoint can produce (`suveren-as`'s multi-owner coverage
test is the current example, and says so in its header).
