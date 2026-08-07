// One retry helper for every AI call site, replacing six hand-rolled copies
// (watch.js, proposals.js, knowledge/{research,relevance,assessment,discovery}.js).
//
// ADR-0006 §7 gives the brief: key off typed exceptions rather than message
// text, restore the 429 coverage a cutover silently drops, stop retrying
// 503/529 at the app layer, and drop the dead `retryDelay` parsers.
//
// (§7's brief has five points; the fifth — give the deadline headroom over the
// per-attempt timeout — is anthropic.js's, not this module's. It was built,
// measured against the live API, and reverted; see that file.)
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
//      and only then does the app layer stand down. This applies to 429 too —
//      see the Anthropic branch, where getting that wrong cost 9 upstream
//      requests for one logical call.
//   3. "DROP THE retryDelay PARSERS." They are dead on Anthropic (it sends
//      `retry-after`, which the SDK honours). They are LIVE on Gemini, which
//      suggests a delay in the error body and is the only backoff signal that
//      path has. Kept for Gemini, never consulted for Anthropic.
//
// The one part of the brief that needed no qualification is 429: Anthropic's
// translated message no longer contains "429" or "RESOURCE_EXHAUSTED", so every
// one of the six regexes stopped matching it — the transient they were all
// written for. classify() reads `err.status`, so it is recognised again. The
// coverage is restored by the SDK, which retries 429 honouring `retry-after`;
// the app layer's job is to not stack a second set of attempts on top.
//
// A NOTE ON WHAT "THE SIX COPIES" WERE, because the first version of this file
// got it wrong and the error was load-bearing. Five copies shared a classifier;
// only FOUR shared a backoff. `proposals.js` had the same transient predicate
// as the four knowledge modules but NO retryDelay parser and no cap — it always
// slept 2s then 4s. `watch.js` differed in both. So consolidating changes the
// backoff of two call sites, not one, and both are named at their bindings.

const DEFAULT_TRIES = 3;
const GEMINI_MAX_BACKOFF_MS = 30000;

// A per-day quota is not transient — retrying burns the remaining allowance
// against a cap that resets tomorrow. Every one of the six copies carried this
// carve-out. The REGEX is preserved verbatim; the semantics are, for five of the
// six. watch.js applied it as an unconditional veto (`if (perDay || !transient)
// throw`), where here — as in the other five — it vetoes only the 429 arm. So an
// error matching BOTH a per-day quota and 503/UNAVAILABLE/overloaded now retries
// for watch where it used to throw. No real Gemini body carries both tokens
// (a quota response is not also an overload response), so this is a disclosure,
// not a live change; recorded because "tightens two matches" was the first
// description of the watch consolidation and it loosens this one.
const PER_DAY_RE = /per[_\s-]?day|PerDay|free_tier_requests/i;

// Gemini's transient set, character-for-character from the five copies that
// shared a classifier. Do not "tidy" it: `\b429\b` not `429` matters, because an
// error body can contain 4290 or a timestamp, and `deadline[ _]?exceeded` not
// `deadline` matters because "deadline" alone matches prose in unrelated
// messages.
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

  // ── the seam's own pre-dispatch throws ───────────────────────────────────
  // aiCall stamps 'aiCall' on the errors it raises BEFORE a provider is
  // resolved (unknown option, missing task/prompt). There is no vendor to
  // attribute them to, and nothing worth scraping: the message is one we wrote,
  // and it interpolates caller-supplied option names — so a mechanical port
  // passing `{ deadlineExceeded: … }` would match GEMINI_TRANSIENT_RE below and
  // buy three attempts at a deterministic caller bug. Same hole anthropic.js
  // closed on its own argument validation, one layer up.
  if (err && err.provider === 'aiCall') {
    return { status: null, perDay, sdkRetried: false, backoffMs: null, transient: false };
  }

  // ── Anthropic ────────────────────────────────────────────────────────────
  // anthropic.translateError stamps `provider` and `sdkRetried`, so there is a
  // real signal to read and no message scraping is needed or wanted.
  if (err && err.provider === 'anthropic') {
    const status = err.status || null;
    const sdkRetried = err.sdkRetried === true;
    return {
      status,
      perDay,
      sdkRetried,
      backoffMs: null,
      // `sdkRetried` is the whole decision, and it is why the stamp exists.
      //
      // The first version of this branch retried every 429 — which is the one
      // status the Anthropic SDK also retries, honouring `retry-after`. The two
      // layers multiplied: measured against an always-429 stub, 3 SDK attempts ×
      // 3 app tries = 9 UPSTREAM REQUESTS (base: 3), and with `retry-after: 60`
      // the SDK's inter-retry sleep takes no signal, so the composed deadline
      // cannot interrupt it — ~366s and ~6 upstream for one logical call. That
      // is the stacking §7 exists to remove, reintroduced by the fix for it.
      //
      // So: if the client already retried, the app layer stands down. What
      // remains retryable here is only what the SDK declined to retry and we
      // still think is worth another go — today that is nothing, because the
      // SDK's retryable set (408/409/429/5xx/connection) is a superset of ours.
      // The branch is kept rather than hardcoded to false so that a future call
      // site with `maxRetries: 0` gets app-level cover automatically.
      //
      // Keyed on 429 alone, NOT on `status >= 500`: `status` here is the
      // route-facing status translateError assigned, not the provider's. It maps
      // rejected credentials AND a truncated answer to 502, and both are
      // deterministic — a `>= 500` test would retry them three times each.
      transient: !perDay && !sdkRetried && status === 429,
    };
  }

  // ── Gemini (and anything else) ───────────────────────────────────────────
  // No typed exception to read; the status is inside the message. This branch
  // reproduces the five shared classifiers exactly, so the Gemini path — which
  // is every path today — classifies as it did before consolidation. Backoff is
  // the caller's to bound: see `maxBackoffMs` and the two bindings that set it.
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
//   maxBackoffMs  cap on the computed delay, and the knob that keeps the two
//          odd copies from inheriting a bound they never had. The four knowledge
//          modules capped at 30s (the default). watch.js and proposals.js had no
//          retryDelay parser at all and so never slept longer than 4s; both pass
//          their own cap rather than being silently harmonised up to 30s.
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

// Per-call-site policy, in one place instead of six bindings.
//
// The bindings were inline at first, and that is how proposals.js silently
// inherited a 30s backoff cap it had never had — the divergence lived in the
// one line of each module a reviewer skims. Here the six sit together, so a
// deviation has to be read next to the five things it deviates from, and a test
// can assert the table rather than trusting six separate call sites.
//
// An unknown label throws rather than falling back to the defaults: a typo
// would otherwise be a silent policy change.
const POLICIES = {
  // The four that shared a classifier AND a backoff. Defaults, stated
  // explicitly so "not listed" is never confused with "takes the defaults".
  research: {},
  relevance: {},
  assessment: {},
  discovery: {},
  // Synchronous, metered, a rep is watching. See the note in proposals.js.
  proposals: { maxBackoffMs: 4000 },
  // Background fan-out inside a 600s per-entity budget. See watch.js.
  watch: { maxBackoffMs: 8000 },
};

function forLabel(label) {
  if (!Object.prototype.hasOwnProperty.call(POLICIES, label)) {
    throw new Error(
      `aiRetry.forLabel: no policy for "${label}". Add one to POLICIES in aiRetry.js ` +
      '— falling back to the defaults silently is how a call site inherits a bound it never had.'
    );
  }
  const policy = POLICIES[label];
  return (fn, tries = DEFAULT_TRIES) => withRetry(fn, { tries, label, ...policy });
}

module.exports = { withRetry, classify, forLabel, POLICIES, DEFAULT_TRIES, GEMINI_MAX_BACKOFF_MS };
