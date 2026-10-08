/**
 * The whole gateway — control plane AND MCP server — wired together the way
 * `bundle/server.js` wires them, for suites whose subject lives in the
 * control plane (sign-in, pairing, locking) or in how the two halves agree.
 *
 * Most suites start only the MCP server (`ProcessManager.startGateway`) and
 * hand it an API key directly. That skips sign-in entirely, which is exactly
 * where the Authority Server's key is pinned, so the pairing suites cannot use
 * it. Everything here runs from the gateway's own build output; nothing is
 * stubbed.
 *
 * Environment hygiene matters more than usual: the control plane and MCP
 * server fall back to the developer's live ports (3402 / 3430) and to
 * ~/.suveren when a variable is missing. Every variable that could point at a
 * live gateway is set explicitly, and the ones that must NOT leak in from the
 * caller's shell (SUVEREN_AS_URL, NODE_EXTRA_CA_CERTS, …) are removed.
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ProcessManager } from './process-manager';
import type { SPClient } from './sp-client';
import { computeBoundsHash, computeScopeHash, hashExecutionContext, hashGateContent } from './crypto';
import { PROFILE_V07, profileHashFor } from './profiles';

// src/helpers/ → src → hap-e2e → workspace root
export const ROOT = join(import.meta.dirname, '..', '..', '..');
export const GW_DIR = join(ROOT, 'suveren-gateway');
/** The sibling hap-profiles checkout, or HAP_E2E_PROFILES_DIR (e.g. a worktree of an
 *  unmerged profile branch, while the sibling checkout is on another branch). */
export const PROFILES_DIR = process.env.HAP_E2E_PROFILES_DIR ?? join(ROOT, 'hap-profiles');
export const RECORDS_DIST = join(ROOT, 'hap-records-mcp', 'dist', 'index.js');
export const MANIFESTS_DIR = join(GW_DIR, 'content', 'integrations');

/** The Authority Server's seeded local operator (in-memory store only). Present
 *  on EVERY fresh AS process, which is what lets one API key sign in to two
 *  independent servers — the precondition for telling them apart by key. */
export const SEED_API_KEY = 'local-dev-key';
export const SEED_DID = 'did:key:local-admin';

export const RECORDS_PROFILE_ID = PROFILE_V07.records;
const RECORDS_BOUNDS_KEY_ORDER = ['profile', 'read_access', 'write_daily_max', 'delete_access', 'archive_access'];

/** Raw Ed25519 keypair in the hex form the AS reads from SP_PRIVATE_KEY / SP_PUBLIC_KEY. */
export function ed25519Keypair(): { privateKeyHex: string; publicKeyHex: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyHex: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'der' })).subarray(-32).toString('hex'),
    publicKeyHex: Buffer.from(publicKey.export({ type: 'spki', format: 'der' })).subarray(-32).toString('hex'),
  };
}

export function asKeyEnv(kp: { privateKeyHex: string; publicKeyHex: string }): Record<string, string> {
  return { SP_PRIVATE_KEY: kp.privateKeyHex, SP_PUBLIC_KEY: kp.publicKeyHex };
}

export interface StackPorts {
  cp: number;
  mcp: number;
}

export interface StackOptions {
  dataDir: string;
  ports: StackPorts;
  /** Shared CP↔MCP secret, as bundle/server.js generates one per start. */
  secret: string;
  /** Sets SUVEREN_AS_URL. Omit to exercise saved-config / default resolution. */
  asUrl?: string;
  /** Applied last, e.g. NODE_EXTRA_CA_CERTS for an AS behind an internal CA. */
  extraEnv?: Record<string, string>;
}

export function newSecret(): string {
  return randomBytes(32).toString('hex');
}

/** The env both halves get — the same object, as in bundle/server.js. */
export function stackEnv(o: StackOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ['SUVEREN_AS_URL', 'SUVEREN_AS_API_KEY', 'NODE_EXTRA_CA_CERTS', 'SUVEREN_CP_INTERNAL_URL']) delete env[k];
  Object.assign(env, {
    SUVEREN_DATA_DIR: o.dataDir,
    SUVEREN_CP_PORT: String(o.ports.cp),
    SUVEREN_MCP_PORT: String(o.ports.mcp),
    SUVEREN_MCP_INTERNAL_URL: `http://127.0.0.1:${o.ports.mcp}`,
    SUVEREN_INTERNAL_SECRET: o.secret,
    SUVEREN_PROFILES_DIR: PROFILES_DIR,
    SUVEREN_MANIFESTS_DIR: MANIFESTS_DIR,
    SUVEREN_INTEGRATIONS_DIR: join(o.dataDir, 'integrations'),
  });
  if (o.asUrl) env.SUVEREN_AS_URL = o.asUrl;
  Object.assign(env, o.extraEnv ?? {});
  return env;
}

export async function startControlPlane(pm: ProcessManager, o: StackOptions, name = 'cp'): Promise<void> {
  await pm.startManaged(name, process.execPath, ['apps/control-plane/dist/index.mjs'], {
    cwd: GW_DIR,
    env: stackEnv(o),
    healthUrl: `http://localhost:${o.ports.cp}/health`,
  });
}

export async function startMcpServer(pm: ProcessManager, o: StackOptions, name = 'mcp'): Promise<void> {
  await pm.startManaged(name, process.execPath, ['apps/mcp-server/dist/http.mjs'], {
    cwd: GW_DIR,
    env: stackEnv(o),
    healthUrl: `http://localhost:${o.ports.mcp}/health`,
  });
}

/** The control plane's HTTP surface, as the gateway UI uses it. */
export class ControlPlaneClient {
  constructor(private baseUrl: string) {}

  /** POST /auth/login — never throws, so refusals can be asserted on. */
  async login(apiKey: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${this.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify({}),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  async health(): Promise<{
    vaultUnlocked: boolean;
    spUrl: string;
    session: { state: 'active' | 'locked'; lockedReason?: string };
  }> {
    const res = await fetch(`${this.baseUrl}/health`);
    return res.json() as never;
  }

  /** Poll /health until `pred` holds (the MCP→CP lock signal is fire-and-forget). */
  async waitForHealth(pred: (h: Awaited<ReturnType<ControlPlaneClient['health']>>) => boolean, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    let last = await this.health();
    while (!pred(last) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      last = await this.health();
    }
    return last;
  }

  async authed(apiKey: string, method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: body != null ? JSON.stringify(body) : undefined,
    });
  }
}

export interface PairingFile {
  asUrl: string;
  publicKeyHex: string;
  pairedAt: string;
}

export function readPairingFile(dataDir: string): PairingFile | null {
  const p = join(dataDir, 'as-pairing.json');
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf-8')) as PairingFile;
}

/**
 * Titles of every record in the records connector's own database, read by a
 * SEPARATE records-mcp process pointed at the same data dir — the downstream
 * system's view, not the gateway's. This is the side-effect oracle: "the tool
 * was not called" means no row, whatever the gateway reported.
 */
export async function recordTitles(dataDir: string): Promise<string[]> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [RECORDS_DIST],
    env: { ...(process.env as Record<string, string>), HAP_DATA_DIR: dataDir },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'hap-e2e-records-oracle', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);
  try {
    const result = await client.callTool({ name: 'list_records', arguments: { limit: 1000 } });
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '[]';
    const parsed = JSON.parse(text) as Array<{ title?: string }> | { records?: Array<{ title?: string }> };
    const rows = Array.isArray(parsed) ? parsed : parsed.records ?? [];
    return rows.map((r) => r.title ?? '');
  } finally {
    await client.close().catch(() => {});
  }
}

/** The local records connector, gated under the records profile (same
 *  declarations as read-gate-records / deferred-commitment). */
export const RECORDS_INTEGRATION = {
  id: 'records',
  name: 'Records',
  command: 'node',
  args: [RECORDS_DIST],
  envKeys: {},
  profile: 'records',
  enabled: true,
  toolGating: {
    default: { executionMapping: {}, staticExecution: {} },
    overrides: {
      create_record: { executionMapping: {}, staticExecution: { action_type: 'write' } },
      list_records: { category: 'read', boundField: 'read_access', requiredValue: 'unlimited' },
      get_record: { category: 'read', boundField: 'read_access', requiredValue: 'unlimited' },
      search_records: { category: 'read', boundField: 'read_access', requiredValue: 'unlimited' },
      export_records: { category: 'disabled' },
    },
  },
};

/**
 * A group the seeded operator can grant records mandates in. The seed user has
 * no personal group (those are made at registration), so it gets a team group
 * in which it holds the owner domain and is the records approver — the
 * minimum the AS requires before it will sign a team mandate.
 */
export async function seedOperatorGroup(sp: SPClient, userId = 'local-admin'): Promise<string> {
  const { group } = await sp.createGroup(SEED_API_KEY, `e2e-${Date.now()}`);
  await sp.setMemberDomains(SEED_API_KEY, group.id, userId, ['owner']);
  await sp.setProfileConfig(SEED_API_KEY, group.id, RECORDS_PROFILE_ID, { approvers: [userId] });
  return group.id;
}

/** Grant a records mandate on `sp`. */
export async function grantRecordsMandate(
  sp: SPClient,
  opts: { apiKey: string; did: string; intent: string; mode: 'automatic' | 'review'; groupId?: string; writeDailyMax?: number },
): Promise<{ authorizationId: string; boundsHash: string; scopeHash: string; gateContent: { intent: string } }> {
  const groupId = opts.groupId ?? await sp.getPersonalGroupId(opts.apiKey);
  const bounds = {
    profile: RECORDS_PROFILE_ID,
    read_access: 'unlimited',
    write_daily_max: opts.writeDailyMax ?? 20,
    delete_access: 'allowed',
    archive_access: 'allowed',
  };
  const boundsHash = computeBoundsHash(bounds, RECORDS_BOUNDS_KEY_ORDER);
  const scopeHash = computeScopeHash({}, []);
  const gateContent = { intent: opts.intent };
  const att = await sp.submitMandate(opts.apiKey, {
    profile_id: RECORDS_PROFILE_ID,
    profile_hash: profileHashFor(RECORDS_PROFILE_ID, PROFILES_DIR),
    group_id: groupId,
    bounds,
    bounds_hash: boundsHash,
    scope_hash: scopeHash,
    domain: 'owner',
    did: opts.did,
    commitment_mode: opts.mode,
    gate_content_hashes: hashGateContent(gateContent),
    execution_context_hash: hashExecutionContext({ profile: RECORDS_PROFILE_ID, domain: 'owner' }),
  });
  return { authorizationId: att.authorization_id, boundsHash, scopeHash, gateContent };
}

export function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? '').join(' ');
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
