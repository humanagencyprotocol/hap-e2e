import { createHash } from 'node:crypto';

/**
 * Compute SHA-256 hash in the HAP format: "sha256:<hex>"
 */
export function sha256Hash(text: string): string {
  const hex = createHash('sha256').update(text, 'utf8').digest('hex');
  return `sha256:${hex}`;
}

/**
 * Hash the v0.4 gate content. v0.4 uses a single `intent` gate:
 * pass { intent } → returns { intent: 'sha256:...' }.
 */
export function hashGateContent(content: { intent: string }): Record<string, string> {
  return { intent: sha256Hash(content.intent) };
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

// ─── Bounds & scope canonicalization ─────────────────────────────────────────
//
// A DUPLICATE CANONICALIZER, deliberately. These helpers compute the hashes an
// E2E test signs and the Authority Server (hap-core) then verifies; importing
// hap-core here would make the suite agree with the implementation by
// construction and prove nothing about the bytes. So the logic is mirrored
// instead — byte-for-byte with hap-core's `canonicalRecords` (src/frame.ts) and
// with protocol.md → *Bounds & Scope Canonicalization*. The shared answer key
// is content/0.7/vectors/canonical-bounds-and-scope.json; test/canonical-
// vectors.test.ts checks this copy against it.

/**
 * Thrown when a value cannot be canonicalized at all — currently only a raw
 * LF/CR inside a value. Mirrors hap-core's `CanonicalValueError`, including the
 * protocol error code.
 */
export class CanonicalValueError extends Error {
  readonly code: 'BOUNDS_INVALID_VALUE' | 'CONTEXT_INVALID_VALUE';
  readonly field: string;

  constructor(code: 'BOUNDS_INVALID_VALUE' | 'CONTEXT_INVALID_VALUE', field: string, message: string) {
    super(message);
    this.name = 'CanonicalValueError';
    this.code = code;
    this.field = field;
  }
}

/**
 * Percent-encode a value per protocol.md → *Value encoding*: over the value's
 * UTF-8 bytes, as `%` + two UPPERCASE hex digits, for `=` (0x3D), `%` (0x25),
 * and every byte outside printable ASCII 0x20–0x7E. LF/CR are not in the list —
 * they are refused below, so encoding them is unreachable.
 */
function percentEncodeCanonicalValue(raw: string): string {
  const bytes = new TextEncoder().encode(raw);
  let out = '';
  for (const b of bytes) {
    if (b === 0x3d || b === 0x25 || b < 0x20 || b > 0x7e) {
      out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
    } else {
      out += String.fromCharCode(b);
    }
  }
  return out;
}

/**
 * The one place `key=value` records are built for bounds and context:
 *   - keys in the schema's keyOrder, never alphabetical
 *   - a value carrying a raw LF/CR is REFUSED (never stripped or encoded)
 *   - `=`, `%`, and any byte outside 0x20–0x7E are percent-encoded (UPPERCASE)
 *   - numbers use `String()`, the shortest round-trippable form
 *   - a key with no value is OMITTED entirely (no record), so a sparse grant
 *     never hashes the JavaScript artifact "undefined"; a key present with ""
 *     renders as `key=`
 */
export function canonicalRecords(
  params: Record<string, unknown>,
  keyOrder: string[],
  code: 'BOUNDS_INVALID_VALUE' | 'CONTEXT_INVALID_VALUE',
): string {
  const lines: string[] = [];

  for (const key of keyOrder) {
    const value = params[key];
    if (value === undefined || value === null) continue;

    const raw = String(value);
    if (raw.includes('\n') || raw.includes('\r')) {
      throw new CanonicalValueError(
        code,
        key,
        `Value for "${key}" contains a raw newline or carriage return. ` +
          'Refusing: a hash over stripped or normalized input would not represent what was authorized.',
      );
    }

    lines.push(`${key}=${percentEncodeCanonicalValue(raw)}`);
  }

  return lines.join('\n');
}

/**
 * Compute the v0.4+ bounds hash. keyOrder must match the profile's declared
 * bounds field order.
 *
 * @throws CanonicalValueError (BOUNDS_INVALID_VALUE) if a value carries a raw LF/CR
 */
export function computeBoundsHash(bounds: Record<string, unknown>, keyOrder: string[]): string {
  return sha256Hash(canonicalRecords(bounds, keyOrder, 'BOUNDS_INVALID_VALUE'));
}

/**
 * Compute the v0.4+ context (v0.7: scope) hash. An empty keyOrder hashes the
 * empty string — which is still a hash the mandate must carry.
 *
 * @throws CanonicalValueError (CONTEXT_INVALID_VALUE) if a value carries a raw LF/CR
 */
export function computeContextHash(context: Record<string, unknown>, keyOrder: string[]): string {
  return sha256Hash(canonicalRecords(context, keyOrder, 'CONTEXT_INVALID_VALUE'));
}
