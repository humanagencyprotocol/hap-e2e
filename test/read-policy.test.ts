/**
 * Local read policy — Gateway E2E.
 *
 * Read enforcement never reaches the Authority Server, so the read-age window
 * is LOCAL config on the integration rather than a signed bound — "a limit
 * lives in the same trust domain as its enforcement"
 * (`content/0.5/protocol.md` → *Bounds, Context, and Read Policy*). Being
 * local, it must be settable and changeable at any time WITHOUT a new
 * attestation.
 *
 * What only an e2e can prove (the unit tests cover the decision logic, not the
 * wire): the endpoint round-trips through the registry to disk, the value
 * comes back in integration status, `0` survives as a real value, `null`
 * clears it, and malformed input is rejected rather than persisted as
 * something the read path would silently treat as "unset".
 *
 * Real @humanagencyp/records-mcp (local SQLite) — no credentials, no external
 * side effects, CI-safe. The Gmail-side enforcement of the resulting window is
 * credential-gated and lives in `email-read-age.test.ts`.
 *
 * Run:  npx vitest run test/read-policy.test.ts
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { join } from 'node:path';

import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import { GatewayClient } from '../src/helpers/gateway-client.js';

const SP_PORT = 16500;
const GW_PORT = 16530;
const ROOT = join(import.meta.dirname, '..', '..');
const PROFILES_DIR = join(ROOT, 'hap-profiles');

const RECORDS_INTEGRATION = {
  id: 'records',
  name: 'Records',
  command: 'npx',
  args: ['-y', '@humanagencyp/records-mcp@latest'],
  envKeys: {},
  profile: 'records',
  enabled: true,
  toolGating: {
    default: { executionMapping: {}, staticExecution: {} },
    overrides: {
      create_record: { executionMapping: {}, staticExecution: { action_type: 'write' } },
      list_records: { category: 'read', readGovernance: 'none' },
    },
  },
};

const pm = new ProcessManager();
let gw: GatewayClient;

/** The integration's currently-persisted local read window. */
async function currentReadAge(): Promise<number | null | undefined> {
  const all = await gw.integrations();
  return all.find(i => i.id === 'records')?.readAgeDays;
}

beforeAll(async () => {
  const spUrl = `http://localhost:${SP_PORT}`;
  pm.buildGateway();
  await pm.startSP(SP_PORT);

  const sp = new SPClient(spUrl);
  const user = await sp.register('ReadPolicy E2E', `readpolicy-${Date.now()}@test.local`);

  await pm.startGateway({ port: GW_PORT, spUrl, spApiKey: user.apiKey, profilesDir: PROFILES_DIR });
  gw = new GatewayClient(`http://localhost:${GW_PORT}`);
  await gw.configure({ sessionCookie: 'readpolicy-e2e', apiKey: user.apiKey });

  await gw.addIntegration(RECORDS_INTEGRATION);
  await gw.waitForIntegration('records');
}, 180_000);

afterAll(async () => {
  await pm.killAll();
});

describe('local read policy — set, read back, clear', () => {
  it('starts with no local window (falls back to the signed grant bound)', async () => {
    // Unset must be distinguishable from 0. Null/undefined = "no local
    // setting"; the read path then uses the grant bound.
    expect(await currentReadAge()).toBeFalsy();
    expect(await currentReadAge()).not.toBe(0);
  });

  it('sets a window and reports it back in integration status', async () => {
    const res = await gw.setReadPolicy('records', 30);
    expect(res.status).toBe(200);
    expect(await currentReadAge()).toBe(30);
  });

  it('changes the window with no new attestation', async () => {
    // The whole point of local policy: one place, live. No re-attestation, no
    // gateway restart, no touching the grant.
    await gw.setReadPolicy('records', 7);
    expect(await currentReadAge()).toBe(7);
  });

  it('persists 0 as a real value — "read nothing", not "unset"', async () => {
    // The dangerous confusion: if 0 round-tripped as unset, the read path
    // would fall back to the grant bound and read MORE than the owner allowed.
    const res = await gw.setReadPolicy('records', 0);
    expect(res.status).toBe(200);
    expect(await currentReadAge()).toBe(0);
  });

  it('clears the window with null, restoring the grant-bound fallback', async () => {
    const res = await gw.setReadPolicy('records', null);
    expect(res.status).toBe(200);
    const after = await currentReadAge();
    expect(after == null).toBe(true);
  });
});

describe('local read policy — rejects what it cannot enforce', () => {
  // Re-establish a known window before EVERY case, so one rejected write can
  // never cascade into the next assertion.
  beforeEach(async () => {
    await gw.setReadPolicy('records', 30);
    expect(await currentReadAge()).toBe(30);
  });

  // NOT tested here: NaN/Infinity. JSON cannot carry them — `JSON.stringify`
  // emits `null`, so over the wire they are indistinguishable from a genuine
  // "clear this setting" request and are correctly accepted as one. The
  // in-process guard against them lives in `readAgeOf`'s unit tests.
  const bad: Array<[string, unknown]> = [
    ['a negative window', -1],
    ['a fractional day count', 1.5],
    ['a numeric string', '30'],
    ['a boolean', true],
    ['an object', { days: 30 }],
  ];

  for (const [label, value] of bad) {
    it(`rejects ${label} and leaves the stored window untouched`, async () => {
      const res = await gw.setReadPolicy('records', value);
      expect(res.status).toBe(400);
      // Fail loudly, never persist something the read path would misread.
      expect(await currentReadAge()).toBe(30);
    });
  }

  it('404s for an unknown integration rather than inventing one', async () => {
    const res = await gw.setReadPolicy('no-such-integration', 30);
    expect(res.status).toBe(404);
  });
});
