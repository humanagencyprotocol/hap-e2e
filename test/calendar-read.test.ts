/**
 * Calendar read resource-scope enforcement — Gateway E2E (Finding F7).
 *
 * Asserts that `allowed_calendars` binds READS (not just writes) — the fix for
 * the family-calendar hole. Through the real gateway + real Google Calendar MCP:
 *   - list_events / free_busy on an ALLOWED calendar (primary) → permitted;
 *   - the same on a calendar OUTSIDE allowed_calendars → BLOCKED before any fetch;
 *   - an OMITTED calendarId resolves to the provider default (primary) and is
 *     still checked (not a bypass);
 *   - list_calendars is filtered to the allowed set (an excluded calendar's very
 *     existence isn't disclosed).
 *
 * CREDENTIAL-GATED (skipIf !HAS_CAL) — needs real Google Calendar OAuth
 * (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_CALENDAR_REFRESH_TOKEN).
 * Not run in the credential-less dev/CI environment; the decision logic is
 * unit-tested in suveren-gateway/apps/mcp-server/test/read-gate.test.ts.
 *
 * Run (with creds):
 *   GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… GOOGLE_CALENDAR_REFRESH_TOKEN=… \
 *     npx vitest run test/calendar-read.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { join } from 'node:path';

import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import { GatewayClient } from '../src/helpers/gateway-client.js';
import { hashGateContent, hashExecutionContext, computeBoundsHash, computeContextHash } from '../src/helpers/crypto.js';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? '';
const REFRESH_TOKEN = process.env.GOOGLE_CALENDAR_REFRESH_TOKEN ?? '';
const HAS_CAL = !!(CLIENT_ID && CLIENT_SECRET && REFRESH_TOKEN);

const SP_PORT = 17280;
const GW_PORT = 17281;
const SP_URL = `http://localhost:${SP_PORT}`;
const GW_URL = `http://localhost:${GW_PORT}`;

const PROFILE_ID = 'github.com/humanagencyprotocol/hap-profiles/calendar@0.4';
const PROFILE_SHORT = 'calendar';
const ROOT = join(import.meta.dirname, '..', '..');
const PROFILES_DIR = join(ROOT, 'hap-profiles');

// A calendar id we do NOT permit — the resource check denies before any fetch,
// so it need not exist. Shaped like a real secondary calendar id.
const BLOCKED_CAL = 'blocked-family@group.calendar.google.com';

const BOUNDS_KEY_ORDER = ['profile', 'booking_daily_max', 'booking_duration_max', 'lookahead_days_max'];
const CONTEXT_KEY_ORDER = ['allowed_calendars', 'allowed_attendees', 'allowed_domains'];
const BOUNDS = {
  profile: PROFILE_ID,
  booking_daily_max: 0,   // read-only grant
  booking_duration_max: 0,
  lookahead_days_max: 0,
};
// Allow ONLY the primary calendar. Everything else must be blocked on read.
const CONTEXT: Record<string, string> = { allowed_calendars: 'primary', allowed_attendees: '', allowed_domains: '' };

// Read adapters under test (mirror content/integrations/calendar.json).
const CAL_TOOL_GATING = {
  default: { executionMapping: {}, staticExecution: { duration: 0, lookahead: 0 } },
  overrides: {
    list_calendars: { category: 'read', read: { resourceBound: 'allowed_calendars', resultResourcePath: 'id' } },
    list_events: { category: 'read', read: { resourceBound: 'allowed_calendars', resourceArg: 'calendarId', resourceDefault: 'primary' } },
    get_event: { category: 'read', read: { resourceBound: 'allowed_calendars', resourceArg: 'calendarId', resourceDefault: 'primary' } },
    free_busy: { category: 'read', read: { resourceBound: 'allowed_calendars', resourceArrayArg: 'calendarIds', resourceDefault: 'primary' } },
  },
};

const pm = new ProcessManager();
const sp = new SPClient(SP_URL);
const gw = new GatewayClient(GW_URL);
let mcpClient: Client;

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

async function callText(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const result = await mcpClient.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n');
  return { text, isError: result.isError === true };
}

beforeAll(async () => {
  if (!HAS_CAL) return;

  pm.buildGateway();
  await pm.startSP(SP_PORT);

  const user = await sp.register('Calendar Read E2E', `cal-read-${Date.now()}@test.local`);
  const apiKey = user.apiKey;
  const groupId = await sp.getPersonalGroupId(apiKey);

  await pm.startGateway({ port: GW_PORT, spUrl: SP_URL, spApiKey: apiKey, profilesDir: PROFILES_DIR });
  await gw.configure({ sessionCookie: 'cal-read-e2e', apiKey });

  const boundsHash = computeBoundsHash(BOUNDS, BOUNDS_KEY_ORDER);
  const contextHash = computeContextHash(CONTEXT, CONTEXT_KEY_ORDER);
  const gateContent = { intent: 'Read the primary calendar only for E2E.' };

  const att = await sp.submitAttestation(apiKey, {
    profile_id: PROFILE_ID,
    group_id: groupId,
    bounds: BOUNDS,
    bounds_hash: boundsHash,
    context_hash: contextHash,
    domain: 'owner', // personal grant — matches the crm-lifecycle pattern; adjust if the deployment maps calendar to another governance domain
    did: user.user.did,
    commitment_mode: 'automatic',
    gate_content_hashes: hashGateContent(gateContent),
    execution_context_hash: hashExecutionContext({ ...CONTEXT }),
  });
  await gw.pushGateContent(
    { authorizationId: att.authorization_id, boundsHash, contextHash, context: CONTEXT },
    PROFILE_ID,
    gateContent,
  );

  await gw.pushServiceCredentials('calendar', { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, refreshToken: REFRESH_TOKEN });
  await gw.addIntegration({
    id: 'calendar',
    name: 'Google Calendar',
    command: 'npx',
    args: ['-y', '@humanagencyp/google-calendar-mcp@latest'],
    envKeys: {
      GOOGLE_CLIENT_ID: 'calendar.clientId',
      GOOGLE_CLIENT_SECRET: 'calendar.clientSecret',
      GOOGLE_CALENDAR_REFRESH_TOKEN: 'calendar.refreshToken',
    },
    profile: PROFILE_SHORT,
    enabled: true,
    toolGating: CAL_TOOL_GATING,
  });
  await sleep(8_000);

  mcpClient = new Client({ name: 'hap-calendar-read-e2e', version: '0.1.0' }, { capabilities: {} });
  await mcpClient.connect(new SSEClientTransport(new URL(`${GW_URL}/sse`)));
}, 180_000);

afterAll(async () => {
  if (mcpClient) { try { await mcpClient.close(); } catch { /* ignore */ } }
  await pm.killAll();
}, 30_000);

const RESOURCE_DENIAL = /may only read the containers|not in your permitted set/i;

describe.skipIf(!HAS_CAL)('Calendar read resource-scope enforcement (F7)', () => {
  it('list_events on the allowed (primary) calendar is permitted', async () => {
    const { text, isError } = await callText('calendar__list_events', { calendarId: 'primary' });
    expect(isError).toBe(false);
    expect(text).not.toMatch(RESOURCE_DENIAL);
  });

  it('list_events with NO calendarId defaults to primary and is permitted (not a bypass)', async () => {
    const { isError } = await callText('calendar__list_events', {});
    expect(isError).toBe(false);
  });

  it('list_events on a calendar OUTSIDE allowed_calendars is BLOCKED before any fetch', async () => {
    const { text, isError } = await callText('calendar__list_events', { calendarId: BLOCKED_CAL });
    expect(isError).toBe(true);
    expect(text).toMatch(RESOURCE_DENIAL);
    // The blocked calendar's contents must not leak.
    expect(text).not.toMatch(/"summary"|"items"|"start"/);
  });

  it('free_busy on a non-allowed calendar is blocked', async () => {
    const now = new Date(1_700_000_000_000).toISOString();
    const later = new Date(1_700_000_000_000 + 3_600_000).toISOString();
    const { isError, text } = await callText('calendar__free_busy', {
      timeMin: now, timeMax: later, calendarIds: [BLOCKED_CAL],
    });
    expect(isError).toBe(true);
    expect(text).toMatch(RESOURCE_DENIAL);
  });

  it('list_calendars is filtered to the allowed set (excluded calendars are not disclosed)', async () => {
    const { text, isError } = await callText('calendar__list_calendars', {});
    expect(isError).toBe(false);
    // Every returned calendar id must be one we permit (only "primary").
    const ids = [...text.matchAll(/"id"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
    for (const id of ids) expect(id).toBe('primary');
  });
});
