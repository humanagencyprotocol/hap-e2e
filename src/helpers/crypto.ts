import { createHash } from 'node:crypto';

/**
 * Compute SHA-256 hash in the HAP format: "sha256:<hex>"
 */
export function sha256Hash(text: string): string {
  const hex = createHash('sha256').update(text, 'utf8').digest('hex');
  return `sha256:${hex}`;
}

/**
 * Hash gate content fields (problem, objective, tradeoffs).
 * Returns object with same keys, values as "sha256:<hex>".
 */
export function hashGateContent(content: {
  problem: string;
  objective: string;
  tradeoffs: string;
}): { problem: string; objective: string; tradeoffs: string } {
  return {
    problem: sha256Hash(content.problem),
    objective: sha256Hash(content.objective),
    tradeoffs: sha256Hash(content.tradeoffs),
  };
}

/**
 * Build the canonical frame string and compute its hash.
 * Uses the spend profile's keyOrder: profile, path, amount_max, currency, action_type.
 */
export function computeFrameHash(frame: Record<string, unknown>, keyOrder: string[]): string {
  const lines = keyOrder.map((key) => `${key}=${String(frame[key])}`);
  return sha256Hash(lines.join('\n'));
}

/**
 * Hash an execution context object (deterministic JSON serialization).
 */
export function hashExecutionContext(ctx: Record<string, unknown>): string {
  const sorted = Object.keys(ctx)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = ctx[key];
      return acc;
    }, {});
  return sha256Hash(JSON.stringify(sorted));
}
