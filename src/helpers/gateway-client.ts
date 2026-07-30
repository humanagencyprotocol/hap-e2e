/**
 * Thin HTTP client for the HAP Gateway internal endpoints.
 * All requests go to loopback — gateway enforces loopback-only access.
 */
import { fetchResilient } from './http.js';
export class GatewayClient {
  constructor(private baseUrl: string) {}

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    return fetchResilient(`${this.baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body != null ? JSON.stringify(body) : undefined,
    });
  }

  // ── Configuration ───────────────────────────────────────

  async configure(opts: {
    sessionCookie: string;
    apiKey?: string;
    vaultKeyHex?: string;
  }): Promise<void> {
    const res = await this.request('POST', '/internal/configure', opts);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`configure failed (${res.status}): ${JSON.stringify(body)}`);
    }
  }

  // ── Gate Content ────────────────────────────────────────

  async pushGateContent(
    hashOrOpts:
      | string
      | { authorizationId: string; boundsHash?: string; contextHash?: string; context?: Record<string, unknown> }
      | { authorizationId: string; boundsHash?: string; contextHash?: string; context?: Record<string, unknown>; path: string; gateContent: { intent?: string } },
    path?: string,
    gateContent?: { intent?: string },
  ): Promise<void> {
    let body: Record<string, unknown>;

    if (typeof hashOrOpts === 'string') {
      // String form: the per-ceremony authorization id.
      body = { authorizationId: hashOrOpts, path, gateContent };
    } else if ('path' in hashOrOpts && 'gateContent' in hashOrOpts) {
      // All-in-one object form: { authorizationId, boundsHash?, contextHash?, context?, path, gateContent }
      const { path: p, gateContent: gc, ...rest } = hashOrOpts as { authorizationId: string; boundsHash?: string; contextHash?: string; context?: Record<string, unknown>; path: string; gateContent: Record<string, string> };
      body = { ...rest, path: p, gateContent: gc };
    } else {
      // The gateway stores gate content keyed by the per-ceremony
      // authorizationId — the only identity; fingerprints never key anything.
      body = { authorizationId: hashOrOpts.authorizationId, boundsHash: hashOrOpts.boundsHash, contextHash: hashOrOpts.contextHash, context: hashOrOpts.context, path, gateContent };
    }

    const res = await this.request('POST', '/internal/gate-content', body);
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(`pushGateContent failed (${res.status}): ${JSON.stringify(errBody)}`);
    }
  }

  // ── Service Credentials ─────────────────────────────────

  async pushServiceCredentials(
    serviceId: string,
    credentials: Record<string, string>,
  ): Promise<void> {
    const res = await this.request('POST', '/internal/service-credentials', {
      serviceId,
      credentials,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`pushServiceCredentials failed (${res.status}): ${JSON.stringify(body)}`);
    }
  }

  // ── Integrations ────────────────────────────────────────

  async addIntegration(config: {
    id: string;
    name: string;
    command: string;
    args: string[];
    envKeys: Record<string, string>;
    env?: Record<string, string>;
    profile: string | null;
    enabled: boolean;
    toolGating?: Record<string, unknown>;
  }): Promise<{ ok: boolean; id: string; tools: string[]; warning?: string }> {
    const res = await this.request('POST', '/internal/add-integration', config);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`addIntegration failed (${res.status}): ${JSON.stringify(body)}`);
    }
    return res.json();
  }

  async removeIntegration(id: string): Promise<void> {
    const res = await this.request('DELETE', `/internal/remove-integration/${id}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`removeIntegration failed (${res.status}): ${JSON.stringify(body)}`);
    }
  }

  // ── Health ──────────────────────────────────────────────

  async health(): Promise<{ status: string }> {
    const res = await fetchResilient(`${this.baseUrl}/health`);
    return res.json();
  }

  /** Current status of every registered integration. */
  async integrations(): Promise<Array<{ id: string; running?: boolean; error?: string; readAgeDays?: number | null }>> {
    const res = await this.request('GET', '/internal/integrations');
    if (!res.ok) return [];
    const body = (await res.json()) as {
      integrations?: Array<{ id: string; running?: boolean; error?: string; readAgeDays?: number | null }>;
    };
    return body.integrations ?? [];
  }

  /**
   * Set the LOCAL read-age window for an integration (days), or null to clear
   * it and fall back to the signed grant bound. Returns the raw response so
   * tests can assert on rejected input too.
   */
  async setReadPolicy(id: string, readAgeDays: number | null | unknown): Promise<Response> {
    return this.request('PATCH', `/internal/integration/${encodeURIComponent(id)}/read-policy`, { readAgeDays });
  }

  /**
   * Block until an integration is actually running.
   *
   * Replaces the fixed `sleep(10_000)` these suites used to rely on. That sleep
   * only ever worked by accident: the gateway installed integrations with a
   * BLOCKING execSync, so the install always finished before a test could run.
   * Installing asynchronously (required to keep the event loop responsive, and
   * to spawn npm correctly on Windows) means a cold `npm install` — measured at
   * ~12s for crm-mcp — now overruns any fixed wait. Poll for the real state
   * instead of guessing a duration.
   */
  async waitForIntegration(id: string, timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last = 'never reported';
    while (Date.now() < deadline) {
      const entry = (await this.integrations().catch(() => [])).find((i) => i.id === id);
      if (entry?.running) return;
      if (entry?.error) last = `error: ${entry.error}`;
      else if (entry) last = 'registered, not yet running';
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`Integration "${id}" did not start within ${timeoutMs}ms (${last})`);
  }
}
