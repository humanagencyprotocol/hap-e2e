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

  async setLimits(
    apiKey: string,
    groupId: string,
    limits: Record<string, unknown>,
  ): Promise<unknown> {
    const res = await this.request(
      'PUT',
      `/api/groups/${groupId}/limits`,
      { limits },
      apiKey,
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`setLimits failed (${res.status}): ${JSON.stringify(body)}`);
    }
    return res.json();
  }

  async setPathDomains(
    apiKey: string,
    groupId: string,
    pathDomains: Record<string, Record<string, string[]>>,
  ): Promise<unknown> {
    const res = await this.request(
      'PUT',
      `/api/groups/${groupId}/path-domains`,
      { pathDomains },
      apiKey,
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`setPathDomains failed (${res.status}): ${JSON.stringify(body)}`);
    }
    return res.json();
  }

  // ── Attestation ─────────────────────────────────────────

  async submitAttestation(
    apiKey: string,
    body: {
      profile_id: string;
      group_id?: string;
      /** v0.3 frame (kept for backward compat) */
      frame?: Record<string, unknown>;
      /** v0.4 bounds */
      bounds?: Record<string, unknown>;
      bounds_hash?: string;
      context_hash?: string;
      domain: string;
      did: string;
      path: string;
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
    const res = await this.request('POST', '/api/sp/attest', body, apiKey);
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
   * POST /api/sp/receipt — submit an execution receipt for limit enforcement.
   * Returns status and response body; does NOT throw on 403.
   */
  async postReceipt(
    apiKey: string,
    body: {
      attestationHash: string;
      profileId: string;
      path?: string;
      action: string;
      amount?: number;
      executionContext?: Record<string, unknown>;
    },
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await this.request('POST', '/api/sp/receipt', body, apiKey);
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
