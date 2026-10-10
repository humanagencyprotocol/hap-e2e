/**
 * The deploy connector must START in a real gateway — found 2026-10-10:
 * deploy-mcp 0.5.0 exited silently when launched through its package bin (a
 * symlink), so Deploy (GitHub) stayed "Stopped" and no website release was
 * possible. Nothing caught it because no suite started this connector.
 *
 * Real path: the gateway installs the PINNED published package from its
 * shipped manifest and spawns it the way it spawns every connector. Starting
 * needs no GitHub call, so a placeholder token is enough.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProcessManager } from '../src/helpers/process-manager.js';
import { GatewayClient } from '../src/helpers/gateway-client.js';
import { MANIFESTS_DIR, newSecret, startMcpServer, type StackOptions } from '../src/helpers/gateway-stack.js';

const MCP_PORT = 19822;
const MANIFEST = join(MANIFESTS_DIR, 'deploy-github.json');
const available = existsSync(MANIFEST);

const pm = new ProcessManager();
const dataDir = mkdtempSync(join(tmpdir(), 'hap-e2e-deploy-start-'));
const secret = newSecret();
const stack: StackOptions = {
  dataDir, ports: { cp: 19821, mcp: MCP_PORT }, secret, asUrl: 'http://localhost:19820',
  extraEnv: { SUVEREN_DISABLE_AUTO_INTEGRATIONS: '1' },
};
const mcpInternal = new GatewayClient(`http://localhost:${MCP_PORT}`, secret);

describe.skipIf(!available)('the deploy connector starts in a real gateway (pinned package, launched via its bin)', () => {
  beforeAll(async () => {
    pm.buildGateway();
    await startMcpServer(pm, stack, 'mcp');
  }, 300_000);

  afterAll(async () => {
    await pm.killAll();
    rmSync(dataDir, { recursive: true, force: true });
  }, 30_000);

  it('installs the pinned version and reaches "running"', async () => {
    const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    await mcpInternal.addIntegration({
      id: m.id, name: m.name, command: m.mcp.command, args: m.mcp.args,
      envKeys: {}, env: { GITHUB_TOKEN: 'placeholder-not-used-at-start' },
      profile: m.profile, enabled: true, toolGating: m.toolGating, npmPackage: m.npmPackage,
    } as Parameters<GatewayClient['addIntegration']>[0]);
    await mcpInternal.waitForIntegration(m.id, 120_000);
    const row = (await mcpInternal.integrations()).find((i) => i.id === m.id);
    expect(row?.running, JSON.stringify(row)).toBe(true);
    const bin = join(dataDir, 'integrations', 'node_modules', '@humanagencyp', 'deploy-mcp', 'package.json');
    expect(JSON.parse(readFileSync(bin, 'utf8')).version).toBe(m.npmVersion);
  }, 180_000);
});
