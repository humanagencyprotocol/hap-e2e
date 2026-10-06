/**
 * Clock offset for a spawned process — preloaded with `node --require`.
 *
 * Why: a reporting window of N days can only be tested with a ticket that is
 * really older than N days. Its timestamp is signed by the Authority Server,
 * so it cannot be edited afterwards, and a test cannot wait days. Instead the
 * Authority Server and the gateway run with a shifted clock while that one
 * ticket is issued, and with the real clock afterwards. Every process stays
 * real; only `Date` reads a different "now".
 *
 * The offset (in seconds) is read from the file named by HAP_E2E_CLOCK_FILE,
 * re-read at most every 200 ms, so a test can move the clock of a running
 * process (Next.js may fork workers; they inherit NODE_OPTIONS and read the
 * same file). A missing or unreadable file means offset 0.
 */
'use strict';
const fs = require('node:fs');

const file = process.env.HAP_E2E_CLOCK_FILE;
if (file) {
  const RealDate = Date;
  const realNow = RealDate.now.bind(RealDate);
  let offsetMs = 0;
  let lastRead = -Infinity;

  const offset = () => {
    const n = realNow();
    if (n - lastRead > 200) {
      lastRead = n;
      try {
        const v = Number(fs.readFileSync(file, 'utf8').trim());
        offsetMs = Number.isFinite(v) ? v * 1000 : 0;
      } catch {
        offsetMs = 0;
      }
    }
    return offsetMs;
  };
  const now = () => realNow() + offset();

  globalThis.Date = new Proxy(RealDate, {
    construct(target, args, newTarget) {
      if (args.length === 0) return Reflect.construct(target, [now()], newTarget);
      return Reflect.construct(target, args, newTarget);
    },
    apply(target) {
      return new target(now()).toString();
    },
    get(target, prop, receiver) {
      if (prop === 'now') return now;
      return Reflect.get(target, prop, receiver);
    },
  });
}
