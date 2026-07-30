/**
 * `fetch` that survives a stale pooled keep-alive socket.
 *
 * ## The failure this prevents
 *
 * Node's HTTP servers — Next.js dev (the Authority Server) and Express (the
 * gateway) — close idle keep-alive sockets after `keepAliveTimeout`, 5s by
 * default. undici's global pool keeps the socket and only learns it died when it
 * processes the close event.
 *
 * If the event loop is *blocked* across that window, undici never gets to
 * process it. `pm.buildGateway()` is a synchronous `execSync('pnpm build')` and
 * blocks the loop for as long as the build runs — ~15s cold on CI, ~0s locally
 * where turbo caches it. When it returns, the next request is written to a
 * socket the server closed seconds ago.
 *
 * undici retries idempotent methods transparently. It does not retry POST, so
 * the error surfaces as `UND_ERR_SOCKET: other side closed` (or `ECONNRESET`).
 * That is what made `authorization-identity.test.ts` fail on every CI run while
 * passing locally: locally the build is instant, so the gap never crosses 5s.
 *
 * ## Why retrying is safe here
 *
 * These codes mean the server closed the connection *before* the request was
 * processed — the bytes never reached the application. A request that failed
 * mid-response fails with a different error and is not retried. Retrying once is
 * therefore safe even for non-idempotent methods.
 *
 * The root cause is fixed by building the gateway before any server starts. This
 * exists so that reintroducing a long blocking call somewhere else fails loudly
 * on its own merits rather than as a mystery socket error.
 */

/** Socket-level codes that mean "the request never reached the server". */
const RETRYABLE = new Set(['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE']);

function socketErrorCode(err: unknown): string | null {
  const e = err as { code?: string; cause?: { code?: string } };
  const code = e?.cause?.code ?? e?.code;
  return code && RETRYABLE.has(code) ? code : null;
}

/**
 * Drop-in `fetch` that retries once when a pooled socket turns out to be dead.
 */
export async function fetchResilient(
  input: string | URL,
  init?: RequestInit,
): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (err) {
    const code = socketErrorCode(err);
    if (!code) throw err;
    console.error(
      `[E2E] stale pooled socket (${code}) on ${init?.method ?? 'GET'} ${input} — retrying once`,
    );
    return fetch(input, init);
  }
}
