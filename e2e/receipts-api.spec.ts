import { test, expect, ALICE, BOB, PROFILE_IDS, SP_URL } from './fixtures';

test.describe('Limits & Receipts API', () => {
  let groupId: string;

  test.beforeAll(async ({ request }) => {
    // Create a group
    const res = await request.post(`${SP_URL}/api/groups`, {
      headers: { 'x-api-key': ALICE.apiKey, 'Content-Type': 'application/json' },
      data: { name: 'API Test Group' },
    });
    expect(res.ok()).toBe(true);
    const body = await res.json();
    groupId = body.group.id;

    // Bob joins
    const joinRes = await request.post(`${SP_URL}/api/groups/join`, {
      headers: { 'x-api-key': BOB.apiKey, 'Content-Type': 'application/json' },
      data: { inviteCode: body.inviteCode },
    });
    expect(joinRes.ok()).toBe(true);
  });

  test('PUT and GET /api/groups/:id/limits round-trips', async ({ request }) => {
    const profileId = PROFILE_IDS[0]; // charge@0.4
    const limits = { [profileId]: { amount_max: 50 } };

    const putRes = await request.put(`${SP_URL}/api/groups/${groupId}/limits`, {
      headers: { 'x-api-key': ALICE.apiKey, 'Content-Type': 'application/json' },
      data: { limits },
    });
    expect(putRes.ok()).toBe(true);

    const getRes = await request.get(`${SP_URL}/api/groups/${groupId}/limits`, {
      headers: { 'x-api-key': ALICE.apiKey },
    });
    expect(getRes.ok()).toBe(true);

    const body = await getRes.json();
    expect(body.limits[profileId]).toBeDefined();
  });

  test('non-admin cannot update limits', async ({ request }) => {
    const putRes = await request.put(`${SP_URL}/api/groups/${groupId}/limits`, {
      headers: { 'x-api-key': BOB.apiKey, 'Content-Type': 'application/json' },
      data: { limits: {} },
    });
    expect(putRes.status()).toBe(403);
  });

  test('member can read limits', async ({ request }) => {
    const getRes = await request.get(`${SP_URL}/api/groups/${groupId}/limits`, {
      headers: { 'x-api-key': BOB.apiKey },
    });
    expect(getRes.ok()).toBe(true);
  });

  test('unauthenticated requests are rejected', async ({ request }) => {
    const limitsRes = await request.get(`${SP_URL}/api/groups/${groupId}/limits`);
    expect(limitsRes.status()).toBe(401);
  });
});
