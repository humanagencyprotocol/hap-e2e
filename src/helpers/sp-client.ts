import { randomUUID } from 'node:crypto';
import { fetchResilient } from './http.js';

/** Monotonic counter so auto-defaulted idempotency keys are unique per call. */
let receiptKeySeq = 0;

/**
 * Mint a per-ceremony authorization identity, exactly as the gateway UI does
 * at ceremony start. UUIDv4 collision odds are negligible, and the AS creates
 * the record NX — a genuine duplicate would surface as AUTHZ_MISMATCH, never
 * a silent merge.
 */
export function mintAuthorizationId(): string {
  return `authz_${randomUUID()}`;
}

/**
 * Thin HTTP client for the Suveren Authority Server's REST API.
 *
 * This is the seam that makes the live suite Suveren-specific. HAP fixes
 * payloads, canonicalisation and refusals but deliberately defines no
 * endpoints, so every route below is Suveren's choice rather than the
 * protocol's. Pointing this suite at a different Authority Server means
 * reimplementing this file for that server — see "Bring your own Authority
 * Server" in the README for the adapter split that would make it portable.
 *
 * ("Service Provider" was the role's name until v0.5; it is retired. The class
 * name and the `sp*` identifiers here still carry it because renaming them
 * touches every suite, and the wire they speak has not been renamed either.)
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
    return fetchResilient(`${this.baseUrl}${path}`, {
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

  /**
   * POST /api/as/attest — per-ceremony identity wire (v0.6).
   *
   * The caller (the ceremony) mints the `authorization_id` (`authz_<uuid>`);
   * when omitted the helper mints one, mirroring the gateway UI. The AS
   * creates the identity NX — replaying the same id with the same content is
   * an idempotent retry; different content is a 409 AUTHZ_MISMATCH.
   */
  async submitAttestation(
    apiKey: string,
    body: {
      /** Per-ceremony identity (authz_<uuid>). Auto-minted when omitted. */
      authorization_id?: string;
      /** Renew (extend expiry of) an existing authorization — content must match. */
      renew?: boolean;
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
    authorization_id: string;
    attestation_id: string;
    bounds_hash?: string;
    blob: string;
    status: string;
    attested_domains: string[];
    required_domains: string[];
    version: number;
  }> {
    const withId = { authorization_id: mintAuthorizationId(), ...body };
    const res = await this.request('POST', '/api/as/attest', withId, apiKey);
    if (!res.ok) {
      const respBody = await res.json().catch(() => ({}));
      throw new Error(`submitAttestation failed (${res.status}): ${JSON.stringify(respBody)}`);
    }
    return res.json();
  }

  /**
   * Like submitAttestation but never throws — returns { status, body } so
   * tests can assert on rejection paths (409 AUTHZ_MISMATCH / AUTHZ_REVOKED,
   * 403 foreign group) without try/catch gymnastics.
   */
  async submitAttestationRaw(
    apiKey: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await this.request('POST', '/api/as/attest', body, apiKey);
    const responseBody = await res.json().catch(() => ({})) as Record<string, unknown>;
    return { status: res.status, body: responseBody };
  }

  /** POST /api/authorizations/:id/revoke — permanent; there is no un-revoke. */
  async revokeAuthorization(
    apiKey: string,
    authorizationId: string,
    reason?: string,
  ): Promise<{ revocation: unknown }> {
    const res = await this.request(
      'POST',
      `/api/authorizations/${encodeURIComponent(authorizationId)}/revoke`,
      { reason },
      apiKey,
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`revokeAuthorization failed (${res.status}): ${JSON.stringify(body)}`);
    }
    return res.json();
  }

  /** GET /api/authorizations/:id/status */
  async getAuthorizationStatus(
    apiKey: string,
    authorizationId: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await this.request(
      'GET',
      `/api/authorizations/${encodeURIComponent(authorizationId)}/status`,
      undefined,
      apiKey,
    );
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    return { status: res.status, body };
  }

  /** GET /api/authorizations/:id — the summary the gateway's tool-proxy reads. */
  async getAuthorizationSummary(
    apiKey: string,
    authorizationId: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await this.request(
      'GET',
      `/api/authorizations/${encodeURIComponent(authorizationId)}`,
      undefined,
      apiKey,
    );
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    return { status: res.status, body };
  }

  // ── Receipts ────────────────────────────────────────────

  /**
   * POST /api/as/receipt — request the signed receipt pre-flight.
   * Returns status and response body; does NOT throw on 403.
   *
   * Wire (v0.6): the request names the governing grant by `authorizationId`;
   * `boundsHash` is an optional integrity cross-check (409 on disagreement).
   */
  async postReceipt(
    apiKey: string,
    body: {
      authorizationId: string;
      /** Optional cross-check — the AS 409s if it disagrees with the record. */
      boundsHash?: string;
      profileId: string;
      action: string;
      actionType?: string;
      amount?: number;
      executionContext?: Record<string, unknown>;
      /** v0.4 M3 — replay protection. Same key → same receipt, no double-count. */
      idempotencyKey?: string;
    },
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    // Synchronous (automatic-mode) receipts REQUIRE an idempotencyKey. Default a
    // unique one when the caller didn't set its own — mirrors the real gateway.
    // An explicit `idempotencyKey` in `body` overrides this.
    const withKey = { idempotencyKey: `e2e-${Date.now()}-${++receiptKeySeq}`, ...body };
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

  /**
   * A page of the caller's own receipts. With no `before` the AS returns the
   * most recent window; `nextBefore` is the cursor for the next (older) window
   * (null at the history floor). Mirrors the gateway UI's "Load older".
   */
  async getMyReceiptsPage(
    apiKey: string,
    options?: { before?: string; limit?: number },
  ): Promise<{ receipts: Array<Record<string, unknown>>; nextBefore: string | null }> {
    const params = new URLSearchParams();
    if (options?.before) params.set('before', options.before);
    if (options?.limit) params.set('limit', String(options.limit));
    const qs = params.toString();
    const res = await this.request('GET', `/api/receipts/mine${qs ? '?' + qs : ''}`, undefined, apiKey);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`getMyReceiptsPage failed (${res.status}): ${JSON.stringify(body)}`);
    }
    const data = await res.json() as { receipts?: Array<Record<string, unknown>>; nextBefore?: string | null };
    return { receipts: data.receipts ?? [], nextBefore: data.nextBefore ?? null };
  }
}
