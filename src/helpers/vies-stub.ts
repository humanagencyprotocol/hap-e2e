/**
 * A local stand-in for the EU VIES REST service — the ONE external service the
 * ERP connector's Local mode calls (hap-erp-mcp src/live/local/vies.ts). It is
 * the only thing a suite may stand in for: the connector, the gateway and the
 * Authority Server stay real. The connector reaches it through its own setting,
 * `ERP_VIES_URL` (vies.ts `viesClientFromEnv`).
 *
 * Speaks the wire shape of
 *   POST https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number
 *   body {countryCode, vatNumber, requesterMemberStateCode?, requesterNumber?}
 * and answers per VAT ID (`<countryCode><vatNumber>`, e.g. "ATU11111111") from
 * a table the test sets — and may change mid-test (`set`), which is how a
 * suite makes the card's answer and the execution-time answer differ (AM1).
 *
 * Unlisted VAT IDs answer `valid`. Every request is logged (`calls`), so a
 * test can prove a VAT ID was — or was never — sent outside.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type ViesAnswer =
  | { kind: 'valid'; requestIdentifier?: string; name?: string; address?: string }
  | { kind: 'invalid' }
  /** HTTP 503 — the connector maps it to `not_checked` ("VIES unreachable (HTTP 503)"). */
  | { kind: 'unavailable' }
  /** HTTP 200 with a VIES service error, e.g. MS_UNAVAILABLE → `not_checked`. */
  | { kind: 'userError'; code: string };

export interface ViesCall {
  at: number;
  countryCode: string;
  vatNumber: string;
  requester: string | null;
}

export class ViesStub {
  private server: Server | null = null;
  private answers = new Map<string, ViesAnswer>();
  readonly calls: ViesCall[] = [];
  private seq = 0;
  url = '';

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', () => resolve()));
    const { port } = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}/taxation_customs/vies/rest-api/check-vat-number`;
    return this.url;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  /** Set (or replace) the answer for one full VAT ID, e.g. "ATU11111111". */
  set(vatId: string, answer: ViesAnswer): void {
    this.answers.set(vatId.toUpperCase(), answer);
  }

  callsFor(vatId: string): ViesCall[] {
    return this.calls.filter((c) => `${c.countryCode}${c.vatNumber}`.toUpperCase() === vatId.toUpperCase());
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: Record<string, string> = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* answered below */ }
    if (req.method !== 'POST' || typeof body.countryCode !== 'string' || typeof body.vatNumber !== 'string') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ errorWrappers: [{ error: 'INVALID_INPUT' }] }));
      return;
    }
    const vatId = `${body.countryCode}${body.vatNumber}`.toUpperCase();
    this.calls.push({
      at: Date.now(), countryCode: body.countryCode, vatNumber: body.vatNumber,
      requester: body.requesterMemberStateCode ? `${body.requesterMemberStateCode}${body.requesterNumber ?? ''}` : null,
    });
    const answer = this.answers.get(vatId) ?? { kind: 'valid' as const };
    const json = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const base = { countryCode: body.countryCode, vatNumber: body.vatNumber, requestDate: new Date().toISOString() };
    switch (answer.kind) {
      case 'valid':
        json(200, {
          ...base, valid: true,
          requestIdentifier: answer.requestIdentifier ?? `WAPIAAAA${String(++this.seq).padStart(8, '0')}`,
          name: answer.name ?? '---', address: answer.address ?? '---',
        });
        return;
      case 'invalid':
        json(200, { ...base, valid: false, requestIdentifier: '', name: '---', address: '---' });
        return;
      case 'unavailable':
        json(503, { message: 'Service Unavailable' });
        return;
      case 'userError':
        json(200, { ...base, valid: false, userError: answer.code });
        return;
    }
  }
}
