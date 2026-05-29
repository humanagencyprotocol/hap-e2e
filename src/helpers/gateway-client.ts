/**
 * Thin HTTP client for the HAP Gateway internal endpoints.
 * All requests go to loopback — gateway enforces loopback-only access.
 */
export class GatewayClient {
  constructor(private baseUrl: string) {}

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
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
      | { frameHash?: string; boundsHash: string; contextHash: string; context?: Record<string, unknown> }
      | { frameHash?: string; boundsHash: string; contextHash: string; context?: Record<string, unknown>; path: string; gateContent: { intent?: string } },
    path?: string,
    gateContent?: { intent?: string },
  ): Promise<void> {
    let body: Record<string, unknown>;

    if (typeof hashOrOpts === 'string') {
      body = { frameHash: hashOrOpts, path, gateContent };
    } else if ('path' in hashOrOpts && 'gateContent' in hashOrOpts) {
      // All-in-one object form: { frameHash?, boundsHash, contextHash, context, path, gateContent }
      const { path: p, gateContent: gc, ...rest } = hashOrOpts as { frameHash?: string; boundsHash: string; contextHash: string; context?: Record<string, unknown>; path: string; gateContent: Record<string, string> };
      body = { ...rest, path: p, gateContent: gc };
    } else {
      // v0.4: send frameHash (per-user storage key) for the AS lookup; boundsHash
      // is the content fingerprint used for gate-store matching.
      body = { frameHash: hashOrOpts.frameHash, boundsHash: hashOrOpts.boundsHash, contextHash: hashOrOpts.contextHash, context: hashOrOpts.context, path, gateContent };
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
    const res = await fetch(`${this.baseUrl}/health`);
    return res.json();
  }
}
