/**
 * pin-tls: with TLS certificate pinning on, a relay on the path to the
 * Authority Server that terminates TLS with a DIFFERENT certificate — even one
 * the gateway would otherwise trust, e.g. issued by the internal CA passed via
 * --ca-file — receives no credential from any part of the gateway: not the
 * API key, not the Authority Server session cookie.
 *
 * Without pin-tls, only TLS protects the connection (see the scope note in
 * as-untrusted-server.test.ts).
 *
 * Real Authority Server (Postgres), real control plane + MCP server, a
 * throwaway CA generated here with openssl, and two TLS front-ends in this
 * process on the gateway's configured AS URL:
 *  - the genuine one (leaf cert A) during pairing, so the pin is the real
 *    server's certificate;
 *  - then a relay (leaf cert B, same CA) on the SAME port. It forwards
 *    everything to the real AS — the signing-key challenge included, which
 *    therefore verifies — and records every request carrying a credential.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { X509Certificate, createHash } from 'node:crypto';
import { createServer as createHttpsServer, type Server } from 'node:https';
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessManager } from '../src/helpers/process-manager';
import { GatewayClient } from '../src/helpers/gateway-client';
import {
  GW_DIR, SEED_API_KEY, ControlPlaneClient, asKeyEnv, ed25519Keypair, newSecret, readPairingFile, sleep,
  startControlPlane, startMcpServer, type StackOptions,
} from '../src/helpers/gateway-stack';

const AS_PORT = 18170;
const URL_PORT = 18171; // the gateway's configured AS URL — genuine front, later the relay
const CP_PORT = 18172;
const MCP_PORT = 18173;
const AS_URL = `https://localhost:${URL_PORT}`;

const pm = new ProcessManager();
const certDir = mkdtempSync(join(tmpdir(), 'hap-e2e-pintls-certs-'));
const dataDir = mkdtempSync(join(tmpdir(), 'hap-e2e-pintls-'));
const secret = newSecret();
const stack: StackOptions = {
  dataDir, ports: { cp: CP_PORT, mcp: MCP_PORT }, secret, asUrl: AS_URL,
  extraEnv: { NODE_EXTRA_CA_CERTS: join(certDir, 'ca.pem') },
};
const cp = new ControlPlaneClient(`http://localhost:${CP_PORT}`);
const mcpInternal = new GatewayClient(`http://localhost:${MCP_PORT}`, secret);

/** Requests that reached the relay, and those carrying a credential. */
const relay = { requests: [] as string[], leaks: [] as string[], handshakes: 0 };
let front: Server | null = null;

function forward(tag: 'genuine' | 'relay') {
  return (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (tag === 'relay') {
        const line = `${req.method} ${req.url}`;
        relay.requests.push(line);
        const seen = JSON.stringify(req.headers) + body.toString('utf-8');
        if (seen.includes(SEED_API_KEY) || /hap-session=/.test(String(req.headers.cookie ?? ''))) relay.leaks.push(line);
      }
      const up = httpRequest(
        { host: '127.0.0.1', port: AS_PORT, path: req.url, method: req.method, headers: { ...req.headers, host: `localhost:${AS_PORT}` } },
        (ur) => { res.writeHead(ur.statusCode ?? 502, ur.headers); ur.pipe(res); },
      );
      up.on('error', (e) => { res.writeHead(502); res.end(String(e)); });
      up.end(body);
    });
  };
}

async function startFront(tag: 'genuine' | 'relay', leaf: 'a' | 'b'): Promise<void> {
  const server = createHttpsServer(
    { key: readFileSync(join(certDir, `${leaf}.key`)), cert: readFileSync(join(certDir, `${leaf}.pem`)) },
    forward(tag),
  );
  if (tag === 'relay') server.on('secureConnection', () => { relay.handshakes++; });
  await new Promise<void>((r) => server.listen(URL_PORT, '127.0.0.1', () => r()));
  front = server;
}

async function stopFront(): Promise<void> {
  if (!front) return;
  const s = front;
  front = null;
  s.closeAllConnections?.();
  await new Promise<void>((r) => s.close(() => r()));
}

/** SHA-256 of a leaf certificate's SPKI — the fingerprint an operator checks
 *  out of band and passes as --expect-fingerprint. */
function spkiFingerprint(leaf: 'a' | 'b'): string {
  const cert = new X509Certificate(readFileSync(join(certDir, `${leaf}.pem`)));
  return createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
}

function cli(args: string[]) {
  return spawnSync(process.execPath, [join(GW_DIR, 'bundle', 'bin', 'suveren-gateway.js'), ...args], {
    env: { ...process.env, SUVEREN_DATA_DIR: dataDir, SUVEREN_AS_URL: AS_URL },
    encoding: 'utf-8',
    timeout: 30_000,
  });
}

beforeAll(async () => {
  const o = (args: string[]) => execFileSync('openssl', args, { cwd: certDir, stdio: 'pipe' });
  o(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2',
    '-subj', '/CN=hap-e2e internal CA', '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  writeFileSync(join(certDir, 'leaf.ext'),
    'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\n' +
    'keyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
  for (const leaf of ['a', 'b']) {
    o(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${leaf}.key`, '-out', `${leaf}.csr`, '-subj', '/CN=localhost']);
    o(['x509', '-req', '-in', `${leaf}.csr`, '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial',
      '-out', `${leaf}.pem`, '-days', '2', '-extfile', 'leaf.ext']);
  }

  pm.buildGateway();
  await pm.startSP(AS_PORT, { env: asKeyEnv(ed25519Keypair()) });

  // Enabling pin-tls requires the fingerprint checked out of band — here the
  // genuine server's (cert A). Staged before the first sign-in.
  const set = cli(['config', 'set', 'pin-tls', 'on', '--expect-fingerprint', spkiFingerprint('a')]);
  expect(set.status, set.stderr + set.stdout).toBe(0);

  await startControlPlane(pm, stack);
  await startMcpServer(pm, stack);
}, 180_000);

afterAll(async () => {
  await stopFront();
  await pm.killAll();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(certDir, { recursive: true, force: true });
}, 30_000);

describe('pin-tls on: first sign-in with the out-of-band fingerprint staged', () => {
  it('without the expected fingerprint, enabling pin-tls is refused', () => {
    const r = spawnSync(process.execPath, [join(GW_DIR, 'bundle', 'bin', 'suveren-gateway.js'), 'config', 'set', 'pin-tls', 'on'], {
      env: { ...process.env, SUVEREN_DATA_DIR: mkdtempSync(join(tmpdir(), 'hap-e2e-pintls-nofp-')), SUVEREN_AS_URL: AS_URL },
      encoding: 'utf-8',
      timeout: 30_000,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/--expect-fingerprint is required/);
  });

  it('a relay with a different certificate at FIRST sign-in is refused and receives no credential', async () => {
    await startFront('relay', 'b');
    relay.leaks.length = 0;
    const login = await cp.login(SEED_API_KEY);
    await stopFront();
    expect(login.status, JSON.stringify(login.body)).toBe(409);
    expect(login.body.error).toBe('as_tls_mismatch');
    expect(relay.leaks, 'a credential reached a server whose certificate is not the expected one').toEqual([]);
    expect(relay.requests.filter((r) => r.startsWith('POST /api/auth/session'))).toEqual([]);
    expect(readPairingFile(dataDir), 'a pairing was recorded with the wrong server').toBeNull();
  }, 60_000);
});

describe('pin-tls on: pairing with the genuine server', () => {
  beforeAll(async () => {
    await startFront('genuine', 'a');
  }, 30_000);

  it('signs in over TLS via --ca-file and pins the genuine certificate', async () => {
    const login = await cp.login(SEED_API_KEY);
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    const pairing = readPairingFile(dataDir) as unknown as { asUrl: string; tlsSpkiPinHex?: string };
    expect(pairing.asUrl).toBe(AS_URL);
    expect(pairing.tlsSpkiPinHex, 'the pin is not the genuine certificate checked out of band').toBe(spkiFingerprint('a'));
  }, 60_000);

  it('positive control: the control plane reaches the AS through the pinned connection', async () => {
    // Control plane → AS proxy (the gateway UI's own path).
    const groups = await cp.authed(SEED_API_KEY, 'GET', '/api/groups');
    expect(groups.status, await groups.clone().text()).toBe(200);
    expect((await cp.health()).vaultUnlocked).toBe(true);
  }, 60_000);
});

describe('pin-tls on: a relay with a different certificate is refused', () => {
  beforeAll(async () => {
    await stopFront();
    await startFront('relay', 'b');
  }, 30_000);

  it('the control plane AS proxy does not send the session cookie through the relay', async () => {
    // Before anything else can lock the gateway: the UI's /api proxy carries
    // the server-side session cookie to the AS on every call.
    expect((await cp.health()).vaultUnlocked, 'already locked — test would be vacuous').toBe(true);
    relay.leaks.length = 0;
    await cp.authed(SEED_API_KEY, 'GET', '/api/groups').catch(() => null);
    expect(relay.leaks, 'the session cookie went through a relay whose certificate is not the pinned one').toEqual([]);
  }, 30_000);

  it('the MCP server sends no credential through the relay and locks the gateway (as-tls-mismatch)', async () => {
    relay.leaks.length = 0;
    // Give the MCP server's 5-second proposal poll (which carries the session
    // cookie) two chances to reach the AS through the relay.
    await sleep(12_000);
    expect(relay.leaks, 'the MCP server sent a credential through the relay').toEqual([]);
    const h = await cp.waitForHealth((x) => x.session.state === 'locked', 10_000);
    expect(h.session.state).toBe('locked');
    expect(h.session.lockedReason).toBe('as-tls-mismatch');
  }, 60_000);

  it('signing in through the relay is refused before the API key is sent (409 as_tls_mismatch)', async () => {
    relay.leaks.length = 0;
    const login = await cp.login(SEED_API_KEY);
    expect(login.status, JSON.stringify(login.body)).toBe(409);
    expect(login.body.error).toBe('as_tls_mismatch');
    expect(relay.leaks, 'the API key went through the relay').toEqual([]);
    // The relay never even got an HTTP request carrying anything: the
    // handshake was aborted on the pin.
    expect(relay.requests.filter((r) => r.startsWith('POST /api/auth/session'))).toEqual([]);
  }, 30_000);

  it('the MCP server, configured with credentials directly, still refuses to send them', async () => {
    relay.leaks.length = 0;
    await mcpInternal.configure({ sessionCookie: 'hap-session=must-not-be-sent', apiKey: SEED_API_KEY });
    await sleep(7_000);
    expect(relay.leaks).toEqual([]);
  }, 30_000);
});

describe('pin-tls on: a second relay episode after signing in again', () => {
  beforeAll(async () => {
    await stopFront();
    await startFront('genuine', 'a');
    const login = await cp.login(SEED_API_KEY);
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    expect((await cp.health()).vaultUnlocked).toBe(true);
    await stopFront();
    await startFront('relay', 'b');
  }, 60_000);

  it('locks the gateway again (the lock signal is re-armed by the new sign-in)', async () => {
    relay.leaks.length = 0;
    await sleep(12_000); // two MCP poll intervals through the relay
    expect(relay.leaks).toEqual([]);
    const h = await cp.waitForHealth((x) => x.session.state === 'locked', 10_000);
    expect(h.session.state, 'the MCP server refused the relay but the gateway still shows as signed in').toBe('locked');
    expect(h.session.lockedReason).toBe('as-tls-mismatch');
  }, 60_000);
});

describe('pin-tls on: an Authority Server outage is an outage, not a pin mismatch', () => {
  beforeAll(async () => {
    // A fresh MCP server, so nothing from the relay episodes above carries over.
    await pm.stopProcess('mcp', { confirmDownUrl: `http://localhost:${MCP_PORT}/health` });
    await startMcpServer(pm, stack);
    await stopFront();
    await startFront('genuine', 'a');
    const login = await cp.login(SEED_API_KEY);
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    expect((await cp.health()).vaultUnlocked).toBe(true);
  }, 90_000);

  it('a refused connection does not lock the gateway as as-tls-mismatch', async () => {
    // Without pin-tls an unreachable AS refuses each action (no ticket, no
    // execution) but does not lock or tell the user their server's
    // certificate changed. With pin-tls on, the same outage must not be
    // reported as a security event that sends the operator re-pairing.
    await stopFront();
    await sleep(12_000); // two MCP poll intervals against the dead URL
    const h = await cp.health();
    expect(h.session.lockedReason, 'an outage was reported as a TLS certificate mismatch').not.toBe('as-tls-mismatch');
  }, 60_000);
});
