import { randomUUID } from 'node:crypto';
import { fetchResilient } from './http.js';

/** Monotonic counter so auto-defaulted idempotency keys are unique per call. */
let ticketKeySeq = 0;

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
 * Thin HTTP client for the Suveren Authority Server's REST API (v0.7).
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

  // ── Profiles ────────────────────────────────────────────

  /**
   * POST /api/profiles — create a community (author-your-own) profile.
   * The AS auto-prefixes the id to `community/<userId>/<given id>` unless it
   * already starts with `community/`. Used by tests that need a profile shape
   * no published hap-profiles profile has yet — never a substitute for
   * publishing a real profile version.
   */
  async createProfile(
    apiKey: string,
    profile: Record<string, unknown>,
  ): Promise<{ profile_id: string; created_at: number }> {
    const res = await this.request('POST', '/api/profiles', { profile }, apiKey);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`createProfile failed (${res.status}): ${JSON.stringify(body)}`);
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
   * v0.7 profile config — `caps` are the per-bound thresholds above which approval
   * is required; `approvers` are the userIds who can approve above-cap requests.
   * PUT /api/groups/:id/profile-config/:profileId — body { approvers, caps? }.
   * For personal-group bound-enforcement flows this is usually NOT needed: the
   * mandate's own bounds are enforced directly.
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

  // ── Mandate (v0.7) ──────────────────────────────────────

  /**
   * POST /api/as/mandate — issue a signed mandate (v0.7).
   *
   * The caller (the ceremony) mints the `authorization_id` (`authz_<uuid>`);
   * when omitted the helper mints one, mirroring the gateway UI. The AS
   * creates the identity NX — replaying the same id with the same content is
   * an idempotent retry; different content is a 409 AUTHZ_MISMATCH.
   */
  async submitMandate(
    apiKey: string,
    body: {
      /** Per-ceremony identity (authz_<uuid>). Auto-minted when omitted. */
      authorization_id?: string;
      /** Renew (extend expiry of) an existing authorization — content must match. */
      renew?: boolean;
      profile_id: string;
      /** v0.7 requires group_id on every mandate (use personal group for individual flows). */
      group_id: string;
      /** v0.7 bounds */
      bounds?: Record<string, unknown>;
      bounds_hash?: string;
      scope_hash: string;
      domain: string;
      did: string;
      /** v0.7: 'automatic' (ticket issued at call time) or 'review' (human commits proposal) */
      commitment_mode: 'automatic' | 'review' | 'review_above_cap';
      gate_content_hashes: Record<string, string>;
      execution_context_hash: string;
      supported_versions?: string[];
    },
  ): Promise<{
    authorization_id: string;
    mandate_id: string;
    bounds_hash?: string;
    scope_hash: string;
    blob: string;
    status: string;
    attested_domains: string[];
    required_domains: string[];
    version: number;
  }> {
    // Add version negotiation if not provided
    const withDefaults = {
      supported_versions: ['0.7'],
      authorization_id: mintAuthorizationId(),
      ...body,
    };
    const res = await this.request('POST', '/api/as/mandate', withDefaults, apiKey);
    if (!res.ok) {
      const respBody = await res.json().catch(() => ({}));
      throw new Error(`submitMandate failed (${res.status}): ${JSON.stringify(respBody)}`);
    }
    return res.json();
  }

  /**
   * Like submitMandate but never throws — returns { status, body } so
   * tests can assert on rejection paths (409 AUTHZ_MISMATCH / AUTHZ_REVOKED,
   * 403 foreign group) without try/catch gymnastics.
   */
  async submitMandateRaw(
    apiKey: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const withDefaults = {
      supported_versions: ['0.7'],
      ...body,
    };
    const res = await this.request('POST', '/api/as/mandate', withDefaults, apiKey);
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

  // ── Tickets (v0.7) ──────────────────────────────────────

  /**
   * POST /api/as/ticket — request the signed ticket pre-flight (v0.7).
   * Returns status and response body; does NOT throw on errors.
   *
   * Wire (v0.7): the request names the governing grant by `authorization_id`;
   * `bounds_hash` is an optional integrity cross-check (409 on disagreement).
   */
  async postTicket(
    apiKey: string,
    body: {
      authorization_id: string;
      /** Optional cross-check — the AS 409s if it disagrees with the record. */
      bounds_hash?: string;
      profile_id: string;
      action: string;
      action_type?: string;
      amount?: number;
      execution_context?: Record<string, unknown>;
      /** v0.7 M3 — replay protection. Same key → same ticket, no double-count. */
      idempotency_key?: string;
    },
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    // Synchronous (automatic-mode) tickets REQUIRE an idempotency key. Default a
    // unique one when the caller didn't set its own — mirrors the real gateway.
    // An explicit `idempotency_key` in `body` overrides this.
    const withKey = { idempotency_key: `e2e-${Date.now()}-${++ticketKeySeq}`, ...body };
    const res = await this.request('POST', '/api/as/ticket', withKey, apiKey);
    const responseBody = await res.json().catch(() => ({})) as Record<string, unknown>;
    return { status: res.status, body: responseBody };
  }

  /**
   * Test that the old /api/as/receipt endpoint returns 410 with VERSION_UNSUPPORTED.
   */
  async postReceiptRetired(
    apiKey: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await this.request('POST', '/api/as/receipt', body, apiKey);
    const responseBody = await res.json().catch(() => ({})) as Record<string, unknown>;
    return { status: res.status, body: responseBody };
  }

  async getGroupTickets(
    apiKey: string,
    groupId: string,
  ): Promise<{ tickets: Array<Record<string, unknown>> }> {
    const res = await this.request(
      'GET',
      `/api/groups/${groupId}/tickets`,
      undefined,
      apiKey,
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`getGroupTickets failed (${res.status}): ${JSON.stringify(body)}`);
    }
    return res.json();
  }

  /**
   * A page of the caller's own tickets. With no `before` the AS returns the
   * most recent window; `nextBefore` is the cursor for the next (older) window
   * (null at the history floor). Mirrors the gateway UI's "Load older".
   */
  async getMyTicketsPage(
    apiKey: string,
    options?: { before?: string; limit?: number },
  ): Promise<{ tickets: Array<Record<string, unknown>>; nextBefore: string | null }> {
    const params = new URLSearchParams();
    if (options?.before) params.set('before', options.before);
    if (options?.limit) params.set('limit', String(options.limit));
    const qs = params.toString();
    const res = await this.request('GET', `/api/tickets/mine${qs ? '?' + qs : ''}`, undefined, apiKey);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`getMyTicketsPage failed (${res.status}): ${JSON.stringify(body)}`);
    }
    const data = await res.json() as { tickets?: Array<Record<string, unknown>>; nextBefore?: string | null };
    return { tickets: data.tickets ?? [], nextBefore: data.nextBefore ?? null };
  }

  // ── Backward compatibility aliases (for gradual migration) ────────────────

  /**
   * Deprecated: use submitMandate() instead.
   * This method redirects to submitMandate for backward compatibility during migration.
   */
  async submitAttestation(
    apiKey: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    // Convert old field names to new ones
    const converted = this.convertAttestationToMandate(body);
    return this.submitMandate(apiKey, converted as Parameters<typeof this.submitMandate>[1]);
  }

  /**
   * Deprecated: use submitMandateRaw() instead.
   */
  async submitAttestationRaw(
    apiKey: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const converted = this.convertAttestationToMandate(body);
    return this.submitMandateRaw(apiKey, converted);
  }

  /**
   * Deprecated: use postTicket() instead.
   */
  async postReceipt(
    apiKey: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const converted = this.convertReceiptToTicket(body);
    return this.postTicket(apiKey, converted as Parameters<typeof this.postTicket>[1]);
  }

  /**
   * Deprecated: use getGroupTickets() instead.
   */
  async getGroupReceipts(
    apiKey: string,
    groupId: string,
  ): Promise<{ receipts: Array<Record<string, unknown>> }> {
    const result = await this.getGroupTickets(apiKey, groupId);
    return { receipts: result.tickets };
  }

  /**
   * Deprecated: use getMyTicketsPage() instead.
   */
  async getMyReceiptsPage(
    apiKey: string,
    options?: { before?: string; limit?: number },
  ): Promise<{ receipts: Array<Record<string, unknown>>; nextBefore: string | null }> {
    const result = await this.getMyTicketsPage(apiKey, options);
    return { receipts: result.tickets, nextBefore: result.nextBefore };
  }

  // ── Field conversion helpers ────────────────────────────

  private convertAttestationToMandate(body: Record<string, unknown>): Record<string, unknown> {
    const converted = { ...body };
    // Convert old field names to new ones
    if ('context_hash' in converted) {
      converted.scope_hash = converted.context_hash;
      delete converted.context_hash;
    }
    return converted;
  }

  private convertReceiptToTicket(body: Record<string, unknown>): Record<string, unknown> {
    const converted = { ...body };
    // Convert old field names to new ones
    if ('authorizationId' in converted) {
      converted.authorization_id = converted.authorizationId;
      delete converted.authorizationId;
    }
    if ('profileId' in converted) {
      converted.profile_id = converted.profileId;
      delete converted.profileId;
    }
    if ('actionType' in converted) {
      converted.action_type = converted.actionType;
      delete converted.actionType;
    }
    if ('executionContext' in converted) {
      converted.execution_context = converted.executionContext;
      delete converted.executionContext;
    }
    if ('idempotencyKey' in converted) {
      converted.idempotency_key = converted.idempotencyKey;
      delete converted.idempotencyKey;
    }
    if ('boundsHash' in converted) {
      converted.bounds_hash = converted.boundsHash;
      delete converted.boundsHash;
    }
    return converted;
  }
}
