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
  const profileId = PROFILE_IDS[0]; // charge@0.4
  const pcUrl = () => `${SP_URL}/api/groups/${groupId}/profile-config/${encodeURIComponent(profileId)}`;

  test.beforeAll(async ({ request }) => {
    const register = async (name: string): Promise<string> => {
      const r = await request.post(`${SP_URL}/api/auth/register`, {
        headers: { 'Content-Type': 'application/json' },
        data: { name, email: `${name}-${Date.now()}@test.local` },
      });
      expect(r.ok()).toBe(true);
      return (await r.json()).apiKey as string;
    };
    adminKey = await register('rc-admin');
    memberKey = await register('rc-member');

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
    expect(joinRes.ok()).toBe(true);
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
