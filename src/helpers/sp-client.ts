/** Monotonic counter so auto-defaulted idempotency keys are unique per call. */
let receiptKeySeq = 0;

/**
 * Thin HTTP client for the HAP Service Provider REST API.
 */
export class SPClient {
  constructor(
    private baseUrl: string,
    private apiKey?: string,
  ) {}

  private async request(
    method: string,
    path: string,
    body?: unknown,
    overrideApiKey?: string,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    const key = overrideApiKey ?? this.apiKey;
    if (key) {
      headers['X-API-Key'] = key;
    }
    return fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
    });
  }

  // ── Auth ────────────────────────────────────────────────

  async register(
    name: string,
    email: string,
  ): Promise<{
    user: { id: string; name: string; email: string; did: string };
    apiKey: string;
  }> {
    const res = await this.request('POST', '/api/auth/register', { name, email });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`register failed (${res.status}): ${JSON.stringify(body)}`);
    }
    return res.json();
  }

  // ── Groups ──────────────────────────────────────────────

  async getPersonalGroupId(apiKey: string): Promise<string> {
    const res = await this.request('GET', '/api/groups', undefined, apiKey);
    if (!res.ok) throw new Error(`getGroups failed (${res.status})`);
    const data = await res.json() as { groups: Array<{ id: string; name: string; allowLazyEnable?: boolean }> };
    const personal = data.groups.find(g => g.allowLazyEnable || g.name === 'Personal');
    if (!personal) throw new Error('No personal group found');
    return personal.id;
  }

  async createGroup(
    apiKey: string,
    name: string,
  ): Promise<{ group: { id: string; inviteCode: string }; inviteCode: string }> {
    const res = await this.request('POST', '/api/groups', { name }, apiKey);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`createGroup failed (${res.status}): ${JSON.stringify(body)}`);
    }
    return res.json();
  }

  async joinGroup(
    apiKey: string,
    inviteCode: string,
  ): Promise<{ group: unknown; member: unknown }> {
    const res = await this.request('POST', '/api/groups/join', { inviteCode }, apiKey);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`joinGroup failed (${res.status}): ${JSON.stringify(body)}`);
    }
    return res.json();
  }

  async setMemberDomains(
    apiKey: string,
    groupId: string,
    userId: string,
    domains: string[],
  ): Promise<{ member: unknown }> {
    const res = await this.request(
      'PUT',
      `/api/groups/${groupId}/members/${userId}`,
      { domains },
      apiKey,
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`setMemberDomains failed (${res.status}): ${JSON.stringify(body)}`);
    }
    return res.json();
  }

  /**
   * v0.4 profile config — replaces the removed `setLimits` and `setPathDomains`
   * (both 410 in v0.4). `caps` are the per-bound thresholds above which approval
   * is required; `approvers` are the userIds who can approve above-cap requests.
   * PUT /api/groups/:id/profile-config/:profileId — body { approvers, caps? }.
   * For personal-group bound-enforcement flows this is usually NOT needed: the
   * attestation's own bounds are enforced directly.
   */
  async setProfileConfig(
    apiKey: string,
    groupId: string,
    profileId: string,
    config: { approvers: string[]; caps?: Record<string, number> },
  ): Promise<{ profileId: string; config: { approvers: string[]; caps?: Record<string, number> } }> {
    const res = await this.request(
      'PUT',
      `/api/groups/${groupId}/profile-config/${encodeURIComponent(profileId)}`,
      config,
      apiKey,
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`setProfileConfig failed (${res.status}): ${JSON.stringify(body)}`);
    }
    return res.json();
  }

  // ── Attestation ─────────────────────────────────────────

  async submitAttestation(
    apiKey: string,
    body: {
      profile_id: string;
      /** v0.4 requires group_id on every attestation (use personal group for individual flows). */
      group_id: string;
      /** v0.4 bounds */
      bounds?: Record<string, unknown>;
      bounds_hash?: string;
      context_hash: string;
      domain: string;
      did: string;
      /** v0.4: 'automatic' (receipt issued at call time) or 'review' (agent submits proposal, human commits) */
      commitment_mode: 'automatic' | 'review';
      gate_content_hashes: Record<string, string>;
      execution_context_hash: string;
    },
  ): Promise<{
    attestation_id: string;
    /** v0.3 hash key */
    frame_hash: string;
    /** v0.4 hash key */
    bounds_hash?: string;
    blob: string;
    status: string;
    attested_domains: string[];
    required_domains: string[];
  }> {
    const res = await this.request('POST', '/api/as/attest', body, apiKey);
    if (!res.ok) {
      const respBody = await res.json().catch(() => ({}));
      throw new Error(`submitAttestation failed (${res.status}): ${JSON.stringify(respBody)}`);
    }
    return res.json();
  }

  async revokeAttestation(
    apiKey: string,
    frameHash: string,
    reason?: string,
  ): Promise<{ revocation: unknown }> {
    const res = await this.request(
      'POST',
      `/api/attestations/${encodeURIComponent(frameHash)}/revoke`,
      { reason },
      apiKey,
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`revokeAttestation failed (${res.status}): ${JSON.stringify(body)}`);
    }
    return res.json();
  }

  // ── Receipts ────────────────────────────────────────────

  /**
   * POST /api/as/receipt — submit an execution receipt for limit enforcement.
   * Returns status and response body; does NOT throw on 403.
   */
  async postReceipt(
    apiKey: string,
    body: {
      attestationHash: string;
      profileId: string;
      action: string;
      actionType?: string;
      amount?: number;
      executionContext?: Record<string, unknown>;
      /** v0.4 M3 — replay protection. Same key → same receipt, no double-count. */
      idempotencyKey?: string;
    },
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const { attestationHash, ...rest } = body;
    // v0.5 wire contract: the receipt request carries the bare `boundsHash`, not
    // the composite per-user key. Tests hold the composite frame_hash
    // (`${boundsHash}:${userId}`); boundsHash is `sha256:<hex>` (one colon), so
    // its first two colon-segments are the boundsHash (a bare hash maps to itself).
    const boundsHash = attestationHash.split(':').slice(0, 2).join(':');
    // Synchronous (automatic-mode) receipts REQUIRE an idempotencyKey. Default a
    // unique one when the caller didn't set its own — mirrors the real gateway.
    // An explicit `idempotencyKey` in `body` overrides this.
    const withKey = { idempotencyKey: `e2e-${Date.now()}-${++receiptKeySeq}`, boundsHash, ...rest };
    const res = await this.request('POST', '/api/as/receipt', withKey, apiKey);
    const responseBody = await res.json().catch(() => ({})) as Record<string, unknown>;
    return { status: res.status, body: responseBody };
  }

  async getGroupReceipts(
    apiKey: string,
    groupId: string,
  ): Promise<{ receipts: Array<Record<string, unknown>> }> {
    const res = await this.request(
      'GET',
      `/api/groups/${groupId}/receipts`,
      undefined,
      apiKey,
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`getGroupReceipts failed (${res.status}): ${JSON.stringify(body)}`);
    }
    return res.json();
  }
}
