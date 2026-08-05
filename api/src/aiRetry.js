// One retry helper for every AI call site, replacing six hand-rolled copies
// (watch.js, proposals.js, knowledge/{research,relevance,assessment,discovery}.js).
//
// ADR-0006 §7 gives the brief: key off typed exceptions rather than message
// text, restore the 429 coverage a cutover silently drops, stop retrying
// 503/529 at the app layer, and drop the dead `retryDelay` parsers.
//
// THREE OF THOSE FOUR NEEDED QUALIFYING, and the reason is the same each time:
// §7 was written describing the world AFTER the cutover, but this helper ships
// while every task still resolves to Gemini. Taken literally it would be a live
// regression on the only provider currently running.
//
//   1. "KEY OFF TYPED EXCEPTIONS." There are none on the Gemini side. The
//      @google/genai SDK puts the upstream JSON straight into `err.message` —
//      which is exactly why all six copies grew a regex, and why brief.js's
//      translateGeminiError has to `JSON.parse` a substring to find the status
//      code. So this module cannot be uniform. What it can do, and does, is
//      make classification happen ONCE here instead of six times at the call
//      sites: classify() returns a structured verdict, and message-scraping
//      lives only in its Gemini branch.
//   2. "STOP RETRYING 503/529 AT THE APP LAYER." Right for Anthropic, whose SDK
//      already retries them — stacking gets you up to 9 attempts on exactly the
//      statuses Anthropic uses for overload. Wrong for Gemini, whose SDK does
//      not retry, so removing it would drop 503 handling on every path that
//      runs today. Hence `sdkRetried`: the client that already retried says so,
//      and only then does the app layer stand down.
//   3. "DROP THE retryDelay PARSERS." They are dead on Anthropic (it sends
//      `retry-after`, which the SDK honours). They are LIVE on Gemini, which
//      suggests a delay in the error body and is the only backoff signal that
//      path has. Kept for Gemini, never consulted for Anthropic.
//
// The one part of the brief that needed no qualification is 429: Anthropic's
// translated message no longer contains "429" or "RESOURCE_EXHAUSTED", so every
// one of the six regexes stopped matching it — the transient they were all
// written for. classify() reads `err.status`, so it matches again.

const DEFAULT_TRIES = 3;
const GEMINI_MAX_BACKOFF_MS = 30000;

// A per-day quota is not transient — retrying burns the remaining allowance
// against a cap that resets tomorrow. Every one of the six copies carried this
// carve-out (watch.js spelled it differently); it is preserved verbatim.
const PER_DAY_RE = /per[_\s-]?day|PerDay|free_tier_requests/i;

// Gemini's transient set, character-for-character from the five identical
// copies. Do not "tidy" it: `\b429\b` not `429` matters, because an error body
// can contain 4290 or a timestamp, and `deadline[ _]?exceeded` not `deadline`
// matters because "deadline" alone matches prose in unrelated messages.
const GEMINI_429_RE = /\b429\b|RESOURCE_EXHAUSTED/i;
const GEMINI_TRANSIENT_RE = /\b(503|UNAVAILABLE|overloaded)\b|high demand|deadline[ _]?exceeded/i;
const GEMINI_RETRY_DELAY_RE = /retryDelay["']?\s*[:=]\s*["']?(\d+)/i;

// What kind of failure is this, in provider-neutral terms?
//
//   status      HTTP-ish code where one can be determined, else null
//   perDay      a daily-cap quota error — never retryable
//   transient   worth another attempt AT THE APP LAYER specifically
//   sdkRetried  the provider client already exhausted its own retries
//   backoffMs   provider-suggested delay, when it gave one
function classify(err) {
  const msg = String((err && err.message) || err || '');
  const perDay = PER_DAY_RE.test(msg);

  // ── Anthropic ────────────────────────────────────────────────────────────
  // anthropic.translateError stamps `provider` and `sdkRetried`, so there is a
  // real signal to read and no message scraping is needed or wanted.
  if (err && err.provider === 'anthropic') {
    const status = err.status || null;
    return {
      status,
      perDay,
      sdkRetried: err.sdkRetried === true,
      backoffMs: null,
      // 429 only. 502/503/529 arrive here having already been retried by the
      // SDK; retrying again is the stacking §7 measured. A local timeout (504,
      // err.aborted) means our own deadline fired — another attempt would just
      // spend it again.
      transient: !perDay && status === 429,
    };
  }

  // ── Gemini (and anything else) ───────────────────────────────────────────
  // No typed exception to read; the status is inside the message. This branch
  // reproduces the five identical copies exactly, so the Gemini path — which is
  // every path today — behaves as it did before consolidation.
  const is429 = GEMINI_429_RE.test(msg);
  const m = msg.match(GEMINI_RETRY_DELAY_RE);
  return {
    status: err && err.status ? err.status : (is429 ? 429 : null),
    perDay,
    sdkRetried: false,
    backoffMs: m ? Math.min(parseInt(m[1], 10) * 1000 + 500, GEMINI_MAX_BACKOFF_MS) : null,
    transient: GEMINI_TRANSIENT_RE.test(msg) || (is429 && !perDay),
  };
}

// Retry `fn` on transient failures.
//
//   tries  total attempts, not extra ones (3 = the original + 2 retries), which
//          is what all six copies meant by it
//   label  log prefix, e.g. 'watch' — matches what each copy printed
//   maxBackoffMs  cap on the computed delay. watch.js capped at 8s where the
//          others capped at 30s; pass it rather than silently harmonising, so
//          the hourly tick keeps its tighter bound.
async function withRetry(fn, { tries = DEFAULT_TRIES, label = 'ai', maxBackoffMs = GEMINI_MAX_BACKOFF_MS } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const v = classify(err);
      if (!v.transient || i === tries - 1) throw err;
      const waitMs = Math.min(v.backoffMs || 2000 * (i + 1), maxBackoffMs);
      console.warn(
        `[${label}] transient AI error (attempt ${i + 1}/${tries}), retrying in ${waitMs}ms: ` +
        String((err && err.message) || err).slice(0, 120)
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

module.exports = { withRetry, classify, DEFAULT_TRIES, GEMINI_MAX_BACKOFF_MS };
