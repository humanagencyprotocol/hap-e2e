import { createHash } from 'node:crypto';

/**
 * Compute SHA-256 hash in the HAP format: "sha256:<hex>"
 */
export function sha256Hash(text: string): string {
  const hex = createHash('sha256').update(text, 'utf8').digest('hex');
  return `sha256:${hex}`;
}

/**
 * Hash gate content fields.
 *
 * v0.4 profiles: pass { intent } → returns { intent: 'sha256:...' }
 * v0.3 profiles: pass { problem, objective, tradeoffs } → returns hashed versions
 */
export function hashGateContent(content: {
  intent?: string;
  problem?: string;
  objective?: string;
  tradeoffs?: string;
}): Record<string, string> {
  if (content.intent !== undefined) {
    return { intent: sha256Hash(content.intent) };
  }
  return {
    problem: sha256Hash(content.problem ?? ''),
    objective: sha256Hash(content.objective ?? ''),
    tradeoffs: sha256Hash(content.tradeoffs ?? ''),
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

/**
 * Compute v0.4 bounds hash using canonical key=value format.
 * keyOrder must match the profile's declared bounds field order.
 */
export function computeBoundsHash(bounds: Record<string, unknown>, keyOrder: string[]): string {
  const lines = keyOrder.map((key) => `${key}=${String(bounds[key])}`);
  return sha256Hash(lines.join('\n'));
}

/**
 * Compute v0.4 context hash using canonical key=value format.
 * Returns hash of empty string when keyOrder is empty.
 */
export function computeContextHash(context: Record<string, unknown>, keyOrder: string[]): string {
  if (keyOrder.length === 0) {
    return sha256Hash('');
  }
  const lines = keyOrder.map((key) => `${key}=${String(context[key])}`);
  return sha256Hash(lines.join('\n'));
}
