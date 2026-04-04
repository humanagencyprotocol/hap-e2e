import { test, expect, PROFILE_IDS, SP_URL } from './fixtures';

test.describe('Profiles API', () => {
  test('GET /api/profiles returns protocol profiles with URI-based IDs', async ({ request }) => {
    const res = await request.get(`${SP_URL}/api/profiles`);
    expect(res.ok()).toBe(true);

    const profiles = await res.json();
    expect(profiles.length).toBeGreaterThanOrEqual(3);

    for (const p of profiles) {
      expect(p).toHaveProperty('id');
      expect(p).toHaveProperty('version');
      expect(p).toHaveProperty('description');
    }

    const ids = profiles.map((p: { id: string }) => p.id);
    for (const expected of PROFILE_IDS) {
      expect(ids).toContain(expected);
    }
  });

  test('GET /api/profiles/:id returns full profile shape', async ({ request }) => {
    const id = PROFILE_IDS[0]; // charge
    const res = await request.get(`${SP_URL}/api/profiles/${encodeURIComponent(id)}`);
    expect(res.ok()).toBe(true);

    const profile = await res.json();
    expect(profile.id).toBe(id);
    expect(profile).toHaveProperty('boundsSchema');
    expect(profile).toHaveProperty('executionContextSchema');
    expect(profile).toHaveProperty('requiredGates');
    expect(profile).toHaveProperty('ttl');
  });

  test('GET /api/sp/pubkey returns a public key', async ({ request }) => {
    const res = await request.get(`${SP_URL}/api/sp/pubkey`);
    expect(res.ok()).toBe(true);

    const { publicKey } = await res.json();
    expect(typeof publicKey).toBe('string');
    expect(publicKey.length).toBeGreaterThan(0);
  });
});
