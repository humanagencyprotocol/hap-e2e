import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

export interface TestUser {
  id: string;
  name: string;
  email: string;
  did: string;
  apiKey: string;
}

export interface TestContext {
  /** Alice — creates group, assigns domains, sets limits */
  adminUser: TestUser | null;
  /** Bob — attests, runs tools via gateway */
  agentUser: TestUser | null;
  groupId: string | null;
  inviteCode: string | null;
  frameHash: string | null;
  gateContent: {
    intent: string;
  };
  mcpClient: Client | null;
}

/**
 * Mutable test state shared across sequential tests.
 */
export const ctx: TestContext = {
  adminUser: null,
  agentUser: null,
  groupId: null,
  inviteCode: null,
  frameHash: null,
  gateContent: {
    intent: 'Test purchasing authority for E2E validation. Enable automated payment processing up to bounded limits. Accepts risk of charges up to configured limits.',
  },
  mcpClient: null,
};
