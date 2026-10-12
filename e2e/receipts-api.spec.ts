import { test, expect, PROFILE_IDS, SP_URL } from './fixtures';

/**
 * Profile-config API (the v0.4 replacement for the removed /limits endpoint).
 * PUT /api/groups/:id/profile-config/:profileId  { approvers, caps }
 *   - admin (group creator) only; non-admin → 403
 * GET  → members only; unauthenticated → 401
 *
 * Uses freshly-registered users (not the shared ALICE/BOB) so team membership
 * from other specs can't interfere with the one-team-per-user constraints.
 */
test.describe('Profile-config (group caps) API', () => {
  let groupId: string;
  let adminKey: string;
  let memberKey: string;
  const profileId = PROFILE_IDS[0]; // charge (newest published version)
  const pcUrl = () => `${SP_URL}/api/groups/${groupId}/profile-config/${encodeURIComponent(profileId)}`;

  test.beforeAll(async ({ request }) => {
    const register = async (name: string): Promise<{ apiKey: string; id: string }> => {
      const r = await request.post(`${SP_URL}/api/auth/register`, {
        headers: { 'Content-Type': 'application/json' },
        data: { name, email: `${name}-${Date.now()}@test.local` },
      });
      expect(r.ok()).toBe(true);
      const data = await r.json();
      return { apiKey: data.apiKey as string, id: data.user.id as string };
    };
    adminKey = (await register('rc-admin')).apiKey;
    const member = await register('rc-member');
    memberKey = member.apiKey;

    const res = await request.post(`${SP_URL}/api/groups`, {
      headers: { 'x-api-key': adminKey, 'Content-Type': 'application/json' },
      data: { name: 'API Test Group' },
    });
    expect(res.ok()).toBe(true);
    const body = await res.json();
    groupId = body.group.id;

    const joinRes = await request.post(`${SP_URL}/api/groups/join`, {
      headers: { 'x-api-key': memberKey, 'Content-Type': 'application/json' },
      data: { inviteCode: body.inviteCode },
    });
    // Since WS0 the invite code only creates a request (202); the admin
    // confirms it, and only then is the account a member.
    expect(joinRes.status()).toBe(202);
    const confirmRes = await request.post(`${SP_URL}/api/groups/${groupId}/requests/${member.id}`, {
      headers: { 'x-api-key': adminKey, 'Content-Type': 'application/json' },
      data: { action: 'confirm' },
    });
    expect(confirmRes.ok(), await confirmRes.text()).toBe(true);
  });

  test('admin PUT and GET /profile-config round-trips', async ({ request }) => {
    const putRes = await request.put(pcUrl(), {
      headers: { 'x-api-key': adminKey, 'Content-Type': 'application/json' },
      data: { approvers: [], caps: { amount_max: 50 } },
    });
    expect(putRes.ok()).toBe(true);

    const getRes = await request.get(pcUrl(), { headers: { 'x-api-key': adminKey } });
    expect(getRes.ok()).toBe(true);
    const body = await getRes.json();
    expect(body.config.caps.amount_max).toBe(50);
  });

  test('non-admin cannot update profile-config', async ({ request }) => {
    const putRes = await request.put(pcUrl(), {
      headers: { 'x-api-key': memberKey, 'Content-Type': 'application/json' },
      data: { approvers: [], caps: {} },
    });
    expect(putRes.status()).toBe(403);
  });

  test('member can read profile-config', async ({ request }) => {
    const getRes = await request.get(pcUrl(), { headers: { 'x-api-key': memberKey } });
    expect(getRes.ok()).toBe(true);
  });

  test('unauthenticated requests are rejected', async ({ request }) => {
    const res = await request.get(pcUrl());
    expect(res.status()).toBe(401);
  });
});
