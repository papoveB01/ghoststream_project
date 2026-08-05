# ADR-0006: Move generation to Anthropic Claude; keep embeddings on Gemini

- **Status:** Proposed (2026-08-05 — amends the LLM inputs of ADR-0004 §3.1,
  §3.2 and §4.3; does not change the pricing structure ADR-0004 decided)
- **Date:** 2026-08-05
- **Authors:** Builder (provider assessment)
- **Affects (when implemented):** `api/src/gemini.js`, `api/src/models.js`,
  `api/src/costs.js`, `api/src/knowledge/globalCache.js`, and the ~20
  `generateContent` call sites in `api/src/analysis.js`,
  `api/src/knowledge/{discovery,keypoints,assessment,relevance,preview,research,ocr}.js`,
  `api/src/{watch,arena,arenaHistory,personas,proposals,enrichment,contacts,companies,companyBrief}.js`,
  `api/src/missions/brief.js`, `api/src/platformAdmin.js`,
  `api/test/*` (~15 stub files), `docker-compose.yml`, `.env.example`,
  `.env.production.example`, `api/package.json`.
  **Not affected:** `capture/`, `mcp/` (verified: no independent model calls),
  `api/src/knowledge/embeddings.js` (deliberately out of scope — §4.2).

## 1. Context

Every AI feature in the product routes through one wrapper
(`api/src/gemini.js`, 251 lines) and one task→tier router
(`api/src/models.js`, 57 lines). Four things about that arrangement are now
true and were not intended:

1. **We are on a free-tier Google AI Studio key.** `.env` carries the comment
   `# Free-tier API key has limit=0 on gemini-2.5-pro`, `GEMINI_MODEL_PRO` is
   commented out, and `models.js:15` documents the fallback in its own header:
   *"PRO defaults to GEMINI_ANALYSIS_MODEL (Flash on a free-tier key) so the
   premium path never errors."* Free tier trains on submitted data and carries
   hard per-day request caps. **This is not a configuration we can sell on,
   independent of which vendor we choose.**

2. **The `pro` tier is a phantom.** `models.js:43-44` routes `callAnalysis`
   and `proposal` — the Moment-of-Truth call analysis and the Proposal Engine,
   the two features the product is differentiated on — to tier `pro`, which
   resolves to `gemini-2.5-flash`. Both additionally run with
   `thinkingConfig: { thinkingBudget: 0 }`, as do all ~30 call sites.
   **Our flagship reasoning task runs on a mid-tier model with reasoning
   switched off.** The scar tissue is visible in the code: `analysis.js:93-96`
   documents fighting fabricated objections, `verifyMoments()` is a backstop
   for it, and the whole of `api/src/semantics.js` exists to catch
   schema-valid-but-incoherent output.

3. **We cannot measure LLM spend.** `usage_costs` (migration `0049`) and
   `api/src/costs.js` are correctly built, but only **4 of ~30 call sites**
   record anything — `watch.js:189`, `watch.js:488`, `watch.js:644`,
   `knowledge/research.js:339`. `analysis.js`, `arena.js`, `missions/brief.js`,
   `knowledge/discovery.js`, `proposals.js`, `enrichment.js` and all of KB
   ingest are silent. Nothing reads the table — `grep -rl usage_costs api/`
   returns only `costs.js` and the migration. It is write-only. Production has
   **zero** `service='gemini'` rows, ever. There is no per-tenant spend
   rollup, no alert, and no cost circuit breaker: `usage.consume` caps units,
   never dollars.

4. **The window to change this is now.** Production has 7 tenants, all
   TRIAL or INTERNAL; `extra_seats = 0` everywhere; `watch_enabled = 0` on
   every row (Market Watch has never fired in production); zero
   `arena_sessions`; 35 `kb_documents` lifetime. **There are no paying
   tenants, so a COGS change
   can be priced before it is sold**, and a rollout can break things without
   breaching a contract. That stops being true with the first Stripe
   subscription.

ADR-0004 §3.1 priced our LLM inputs at Gemini 2.5 rates and set every cap in
§4.3 against them. Those inputs are what this ADR changes.

### Why Claude, and why now

The assessment (2026-08-05, six-spoke fan-out over the full LLM surface)
found the migration is neither free nor prohibitive, and that the decision
turns on one variable we control: whether we adopt Claude's cost mechanics
or map tier-for-tier and hope.

- **Tier-for-tier mapping breaches the ADR-0004 §4.2 floor.** Pro base lands
  at ~29% against a 35% floor.
- **The same migration with caching, Batch, and deliberate down-tiering lands
  at ~49% — better than today's modeled 36.5%.** §6.

That gap — 29% vs 49% on the same vendor and the same features — is the whole
decision. It is not an optimization to schedule later; it is the thing being
decided.

## 2. Decision drivers

- **The ≥35%-at-full-utilization floor (ADR-0004 §4.2) is a non-negotiable**
  (`CLAUDE.md`, "Non-negotiables"). Any provider change that cannot be shown
  to clear it on every revenue line does not ship. Pro base carries only
  **200bps of headroom today** (37% modeled), because it is the only plan
  carrying the two most LLM-dense meters — `market_monitoring` (~90% LLM) and
  `arena` (100% LLM). Pro is where this is decided.
- **We must be able to measure what we changed.** A migration to a
  materially more expensive per-token provider, executed with no meter, is
  not a decision — it is a bet. Instrumentation is a prerequisite, not a
  follow-up.
- **Quality where quality is the product.** Call analysis and proposal
  synthesis are what a customer pays for. Everything else — relevance gates,
  entity extraction, previews — is plumbing that should run on the cheapest
  thing that holds.
- **Reversibility.** Every step must be revertable by an env flip or a
  single-file `git revert` until the last one. Anything that isn't (re-embedded
  vectors) stays out of scope.
- **Reviewability under the four-pass rule.** `CLAUDE.md` mandates per-file
  spokes → cross-integration → confidence verification → verdict for every PR
  and forbids merging on a single pass. A change touching 20 call sites in one
  PR is not reviewable under that rule; the decomposition is part of the
  decision (§8).
- **Free tier is an exit, not a baseline.** Whatever we decide, we are leaving
  a key that trains on our customers' competitive intelligence.

## 3. Alternatives considered

- **A — Stay on Gemini, move to a paid key, light up the real Pro tier.**
  Pro: no code change beyond env; cheapest per token in every tier; keeps
  embeddings, vision, and audio on one vendor. Con: does not address the
  quality ceiling on `callAnalysis` (Gemini Pro with `thinkingBudget: 0` is
  still reasoning-off), and Google charges a long-context premium that
  **doubles Pro input above 200k** — precisely where our transcript and
  dossier paths are heading. **Rejected as the primary path, but adopted as
  the fallback** — this ADR keeps it one env flip away (§8).

- **B — Big-bang swap to Claude across all call sites in one release.**
  Pro: one migration, one review cycle, no dual-provider period. Con:
  unreviewable under the four-pass rule; no incremental quality signal; puts
  discovery, call analysis, Arena, and Market Watch at risk simultaneously,
  with a CD smoke test that exercises no AI path at all (§7). **Rejected.**

- **C — Staged per-task migration behind a provider-aware router, Claude for
  generation, Gemini retained for embeddings.** Pro: `models.js` already has
  the exact shape needed (task → tier → env override); each task flips
  independently and reverts by env var; the irreversible piece (embeddings)
  never moves. Con: a dual-provider period with two SDKs and two keys in the
  image; per-call-site rewrite effort is unchanged. **Adopted (§4).**

- **D — Migrate embeddings too, to Voyage or OpenAI.** Pro: single-vendor
  story; both are ~0.1× the per-token price of `gemini-embedding-2`. Con:
  `kb_chunks.embedding` is `vector(768)` with a dim-locked HNSW index
  (`0001_kb_tables.sql:59,67`); **Voyage offers 256/512/1024/2048 — not 768**,
  so it forces a column migration *and* a full re-embed, while OpenAI can emit
  768 but still needs a full re-embed since vector spaces are incompatible
  across models. `embeddings.js:8-13` documents this in its own header. A
  partial backfill silently returns garbage retrieval for the un-migrated
  half. **Rejected — this is the one genuinely irreversible piece of the
  migration and it buys nothing the product can feel.**

- **E — Run Claude via Google Vertex AI to stay inside GCP.** Pro: one cloud
  relationship, existing GCP project. Con: Vertex has **no Batch API, no Files
  API, no Models API**, no web fetch, and only the basic web-search variant —
  i.e. it removes the single largest cost lever (Batch, −50%) that makes §6's
  optimized column work. **Rejected.**

- **F — Keep Gemini and buy quality by moving `callAnalysis` to Gemini 2.5 Pro
  with a real thinking budget.** Pro: smallest possible change; addresses the
  one genuine quality gap. Con: leaves us on free-tier-adjacent economics with
  a long-context premium, and does nothing about the metering gap. **Rejected
  as a substitute, but noted as the correct emergency move if this ADR stalls.**

## 4. Decision

### 4.1 Generation moves to Claude, on a three-model map (normative)

`models.js` tiers are re-derived, not renamed. Tier names stay (`lite`,
`flash`, `pro`, `content`) so per-task env overrides keep working.

| Tier | Model | Tasks | Settings |
| --- | --- | --- | --- |
| `pro` | **`claude-opus-5`** | `callAnalysis`, `proposal` | `thinking: {type:"adaptive"}`, `output_config: {effort:"high"}` |
| `flash` / `content` | **`claude-sonnet-5`** | `discovery`, `research`, `marketWatch`, `brief`, `compare`, `personas`, `content`, **`keypoints`** | adaptive, `effort:"medium"`; `effort:"low"` on `personas` |
| `lite` | **`claude-haiku-4-5`** | `relevance`, `callEntities`, `preview`, `companyBrief`, doc-level `assessment` | `effort` unsupported — omit |

Two corrections fall out of this and are part of the decision:

- **`keypoints` is promoted from `lite` to `flash`.** `COMPANY_ANALYSIS_SCHEMA`
  (`knowledge/keypoints.js:258+`) asks for `differentiator`,
  `idealCustomerProfile` and `pricingPosture` — judgment, not extraction. It
  was mis-tiered under Gemini too; Haiku would regress it visibly.
- **`assessment` splits.** Per-document scoring stays `lite`; the
  `BATTLECARD_SCHEMA` synthesis (`knowledge/assessment.js:595`) moves to
  `flash`.

**`thinkingBudget: 0` does not map to `thinking: {type:"disabled"}`.** On
Opus 5 disabled thinking is legal only at effort ≤ `high` and has two
documented failure modes: a tool call can arrive as visible text (the turn
succeeds and the call silently never runs) and `<thinking>` tags can leak into
output. The correct mapping is adaptive thinking at low effort, which is also
cheaper.

### 4.2 Embeddings stay on Gemini — indefinitely, not temporarily

Anthropic ships no embedding model. `api/src/knowledge/embeddings.js` keeps
`gemini-embedding-2` at 768 dims, `GEMINI_API_KEY` and `@google/genai` stay in
the image for that one module, and `kb_chunks` is not touched. This is a
standing decision, not a transitional one; revisiting it requires its own ADR
and a re-embed plan.

### 4.3 Cost mechanics are adopted as design constraints, not optimizations

Three are mandatory for any call site that qualifies. §6 shows the margin
table does not clear the floor without them.

1. **Prompt caching** (`cache_control` breakpoints, reads at 0.1× input,
   writes 1.25× at 5m / 2× at 1h, max 4 breakpoints). Mandatory on: the call
   transcript, which `analysis.js` re-sends across all three stages — cache at
   Stage 0, read at Stages 1 and 2; `tenantContextText` (`keypoints.js:135`,
   capped 5,000 chars, rebuilt per call today); the Arena persona seed; and
   the `globalCache` body.
2. **Batch API** (−50% on input *and* output, stacks multiplicatively with
   caching). Mandatory on every latency-insensitive path: the hourly
   `watchTick` fan-out, KB ingest, discovery backfills.
3. **`effort` as a per-route dial**, replacing the single binary
   `thinkingBudget` knob.

Minimum cacheable prefix is model-dependent and **not monotonic**: 512 tokens
on Opus 5, 1024 on Sonnet 5, **4096 on Haiku 4.5**. Short high-volume
`lite`-tier prompts are exactly where caching would pay most and exactly where
Haiku will silently not cache — `cache_creation_input_tokens: 0`, no error.
Do not model Haiku savings that assume caching.

### 4.4 Instrumentation is a prerequisite, gating the first task cutover

`costs.js` is extended for Claude's usage shape and the remaining ~26 call
sites are instrumented **before any task flips to Claude**. Note Claude's
`input_tokens` is the *uncached remainder only* — total prompt is
`input_tokens + cache_creation_input_tokens + cache_read_input_tokens`; a
naive field-rename under-reports and would make §6 unverifiable.

### 4.5 The cutover is staged per task behind a provider-aware router

A task resolves to a `{provider, model}` pair; a dispatch wrapper selects the
client. One task flips at a time by env var (`AI_PROVIDER_<TASK>`),
Founders/INTERNAL tenant first. `GEMINI_API_KEY` and `gemini.js` survive until
every task is confirmed stable — and `embeddings.js` keeps them forever (§4.2).

**Amended 2026-08-05 by what phase 1 shipped, on two points:**

- **`resolve(task)`, not `modelFor(task)`.** Changing `modelFor`'s return type
  would break all ~20 call sites inside a PR that is meant to change no
  behaviour. `resolve()` is the provider-aware API; `modelFor()` remains a
  string-returning wrapper and is deleted when the last call site moves.
- **An env var alone is not sufficient to flip a task.** The router carries a
  `DISPATCH_READY` set, empty until a call site can actually branch on
  `resolve().provider`. Setting `AI_PROVIDER_<TASK>=anthropic` before then
  warns and stays on Gemini. Without that gate the env var would hand a Claude
  model id to the Gemini SDK — and on `relevance`, which fails *open*, every
  competitor document would silently skip the quarantine for every tenant. A
  task joins `DISPATCH_READY` in the same PR that migrates its call site.

### 4.6 Every response schema needs translating (added 2026-08-05)

*Established by §9 item 3, the live-schema smoke check, once it existed. None
of this was visible from a diff, from CI, or from reading either provider's
docs — the third row below was found by the check on its first run.*

All 26 `responseSchema` objects in `api/src/` are written in Google's
OpenAPI-3.0 flavour. Anthropic's `output_config.format.json_schema` is standard
JSON Schema behind a strict validator, and they disagree in three places:

| Gemini dialect | Anthropic | Blast radius if untranslated |
| --- | --- | --- |
| `additionalProperties` absent on an object | **400** | **all 26** — every structured task 400s on its first request after a flip |
| `nullable: true` on an **object** | **400** | `analysis.moments`, `proposals.synthesize` |
| `nullable: true` on an array or string | **accepted, silently ignored** | the model can never return `null` again |
| `type: ['x','null']` on a node with an `enum` | **400** | the fix for the row above is itself invalid on an enum; needs `anyOf` |

**The third row is the dangerous one, and it is silent.** `analysis.js`
documents `objection` and `agreement` as *"null if the prospect raised none —
never invent one"*; `proposals.js` reads a null `citations` as "this section
cites nothing". With `nullable` ignored, a required non-nullable object forces
the model to **fabricate**. Demonstrated with the real `MOMENTS_SCHEMA` against
a transcript containing no objection:

| request | `objection` |
| --- | --- |
| Gemini, schema as shipped | `null` |
| Claude, translated | `null` |
| Claude, `nullable` merely dropped | `{"quote":"","category":"","startSeconds":0,"endSeconds":0,"resolved":false}` |

That third row is a fabricated objection with an empty quote, which
`analysis.js` and everything downstream treat as real. No error, no log line,
nothing in the UI.

`api/src/schemaCompat.js` translates inside `anthropic.generate()`, so a call
site migration stays the swap §4.5 promises rather than 26 hand-edited schemas.
It copies rather than mutating — the same constants are still sent verbatim by
the Gemini call sites, and several of the `enum` arrays are live application
state (`kb.assessment`'s IS `assessment.js`'s `AXIS_KEYS`).

**Consequence for §9 item 5:** no per-task cutover PR needs to touch its
schema. One exception, §4.7.

### 4.7 `proposals.synthesize` cannot move as it stands

The one schema translation cannot save. Live, on `claude-opus-5` and
`claude-sonnet-5` alike:

```
400 The compiled grammar is too large, which would cause performance issues.
```

| `PROPOSAL_SCHEMA` variant | size | null branches | result |
| --- | --- | --- | --- |
| as shipped | 5501 b | 17 | **400** |
| every `description` stripped | 2758 b | 17 | **400** |
| minus `intelligenceGaps` | — | 16 | **400** |
| minus `proof` | — | 14 | OK |
| no `nullable` anywhere | — | 0 | OK |

The limit is **structural, not textual**: it tracks the count of nullable
(`anyOf`) branches, and prose costs nothing. The schema sits marginally over —
dropping the single nullable `proof` section clears it on both models.

`proposal` therefore cannot join `DISPATCH_READY` until `PROPOSAL_SCHEMA` is
reshaped. The cheapest route is making the two nullable leaves inside
`section()` (`assumptions`, `citations`) non-nullable with an empty array as
the "nothing" value, which removes 16 of the 17 branches at once — but that
changes the Gemini path too (`pruneCitations` and the confidence rollup both
read them), so it belongs in the `proposals` cutover PR, not here.

It is also a standing warning for §9 item 6: on Claude, schema growth is
bounded by this ceiling; on Gemini it is bounded by nothing. The constraint is
invisible until a flip, so the smoke check is the only thing that surfaces it.

## 5. Revised unit-cost model (amends ADR-0004 §3.1–§3.2)

### 5.1 Vendor rates (retrieved 2026-08-05)

| Model | Input $/MTok | Output $/MTok | Cache read | Cache write (5m) |
| --- | --- | --- | --- | --- |
| `claude-opus-5` | $5.00 | $25.00 | $0.50 | $6.25 |
| `claude-sonnet-5` | $3.00 | $15.00 | $0.30 | $3.75 |
| `claude-haiku-4-5` | $1.00 | $5.00 | $0.10 | $1.25 |
| `gemini-embedding-2` (retained) | $0.20 | — | — | — |

**`claude-sonnet-5` carries introductory pricing of $2.00/$10.00 through
2026-08-31.** Every figure in this ADR uses the post-introductory $3.00/$15.00
rate. Do not build a case on the intro rate — it expires 26 days from this
ADR's date.

Batch API: −50% on both directions, no beta header. No long-context premium at
any size (contrast Gemini 2.5 Pro, which doubles input above 200k). Thinking
tokens bill as output. `max_tokens` is a truncation ceiling, **not** a spend
control — use `effort`.

All non-LLM rates from ADR-0004 §3.1 are unchanged: Recall.ai
$0.50/recording-hr + $0.15/hr transcription, Apollo $0.02/credit on-plan,
Firecrawl $0.0008–0.003/page, Brave $0.001/query, Stripe 2.9% + $0.30.

### 5.2 Per-unit COGS (normative — supersedes ADR-0004 §3.2)

Derived from measured Gemini token counts in `usage_costs` (staging) where
available, otherwise from prompt-cap constants in code. **A +30% allowance is
applied to all input token counts** — Claude 4.7+ uses a newer tokenizer that
produces roughly 1.3× the tokens for the same text, so counts measured against
Gemini do not transfer 1:1. Re-baseline with `count_tokens` during Phase 1
(§8) and amend this table.

| Unit | ADR-0004 | **Balanced** (§4.1 map only) | **Optimized** (§4.1 + §4.3) | LLM share |
| --- | --- | --- | --- | --- |
| Engagement | $1.00 | **$1.09** | **$1.05** | 25% → 31% |
| Research run | $0.12 | **$0.17** | **$0.131** | 8% → 36% |
| Market-watch unit | $0.06 | **$0.063** | **$0.016** | 90% |
| Arena session | $0.15 | **$0.10** | **$0.035** | 100% |
| Apollo reveal | $0.02 / $0.20 | unchanged | unchanged | 0% |

Engagement build-up (Balanced): Recall $0.65 + Stage-0 entities (Haiku) $0.018
+ Stage-1 moments (Opus 5) $0.23 + Stage-2 follow-ups (Sonnet 5) $0.036 +
pre-call brief (Sonnet 5) $0.053 + Stream/R2 and buffer $0.10.

Two observations that matter more than the totals:

- **ADR-0004's LLM line items were buffered 4–7× above observed spend.** The
  measured watch unit was ~$0.008 against a $0.054 budget; measured
  `research.analyze` was $0.0057. Much of Claude's price increase is absorbed
  by buffer that was already there, which is why the engagement unit moves only
  +9% despite Opus 5 costing 3.3× Gemini Pro on the analysis call.
- **The research run is the genuinely exposed line.** Its $0.010 LLM
  allowance was always too thin — measured spend was already 57% of it — and
  it is the only unit whose LLM share rises above 30% in the Balanced column.
  It is also the highest-volume meter on both paid plans.

## 6. Revised margin table (amends ADR-0004 §4.3)

Method matches ADR-0004 §4.3 exactly, including its per-line Stripe charge
(2.9% + $0.30). Full cap utilization, v2 catalog.

| Revenue line | Price | ADR-0004 | **Balanced** | **Optimized** | Floor |
| --- | --- | --- | --- | --- | --- |
| **Pro base** (250 research, 30 eng, 250 watch, 100 arena) | $149 | 36.5% | **29.2%** ❌ | **48.7%** ✅ | ⚠️ decided here |
| **Starter base** (75 research, 10 eng, 25 arena) | $49 | 50.1% | **43.1%** ✅ | **53.2%** ✅ | ✅ |
| Engagement credit | $2.00/cr | 46.5% | **42.0%** ✅ | **44.0%** ✅ | ✅ |
| Research credit | $0.38/cr | 63.9% | 55.0% ✅ | 62.0% ✅ | ✅ |
| Pro extra seat (+25 research, +15 eng) | $35 | 44.8% | **37.4%** ✅ | **45.0%** ✅ | ✅ |
| Starter extra seat (+25 research, +5 eng) | $19 | 53.4% | **45.8%** ✅ | **52.6%** ✅ | ✅ |
| Sub-tenant add-on | $29 | 68.5% | **63.1%** ✅ | **68.0%** ✅ | ✅ |
| Free tier (20 research, 10 arena) | $0 | −$3.90/mo | **−$4.40/mo** | **−$2.97/mo** | n/a |

**Pro base is the only line that fails, and it fails only in the Balanced
column.** This is the entire quantitative content of the decision: §4.3 is not
optional engineering polish, it is what keeps the flagship tier above the
floor. Ship the model map without the cost mechanics and Pro is 580bps
underwater.

Two further notes:

- **Optimized Free-tier burn is *lower* than today's** (−$2.97 vs −$3.90/mo
  per account), because Arena and watch — the two 100%/90%-LLM meters — are
  the biggest beneficiaries of caching and Batch. Free-tier burn scales with
  signups and has no card, no cap and no expiry
  (`entitlements.js:20`, `plans.js:132-133`); this ADR improves that exposure.
- **Enterprise's $1.60/engagement floor no longer clears 35%** at a $1.05–1.09
  unit COGS. ADR-0004 §4.3 already had it at 34.6%; it is now 31–35%. The
  deal-calculator floor must rise to **≥$1.75/engagement**. Tracked in §10.

**The v1 grandfathered catalog is not modeled here.** It was already
underwater at ADR-0004's own numbers (Starter v1 16.9%, Pro v1 −13.8% with
unbounded Arena), and there are zero v1 rows in either environment today. If a
v1 tenant ever exists, this migration amplifies an existing loss rather than
creating one; `plans.js` has no code path that migrates a v1 tenant to v2.

## 7. Consequences

**Made easier.**

- The flagship reasoning task gets reasoning. `callAnalysis` moves from
  Flash-with-thinking-off to Opus 5 with adaptive thinking — the largest
  single quality delta available anywhere in the product.
- ~200 lines of `gemini.js` delete. Claude's caching is a per-request
  breakpoint, not a named server resource, so the Redis cache registry, the
  skip-flag machinery (`isUncacheableError`, `SKIP_REFRESH_SEC`),
  `caches.delete`, `invalidate()`, `listCachedRecords()`, the `scanKeys`
  helper, the cached-vs-inline `mode` branch, the `/caches` admin endpoints
  (`index.js:110-148`) and `kb_global_cache.cache_name` all go away.
- The one-cache-per-call constraint disappears. `globalCache.js:8-11`
  documents a real workaround — *"Gemini only accepts ONE cachedContent per
  call, so the Arena pastes the intelligence block inline because its slot
  belongs to the persona cache."* With 4 breakpoints, Arena caches both.
- `ocr.js`'s Files API `PROCESSING → ACTIVE` polling loop and
  `FILES_ACTIVE_TIMEOUT_MS` delete.
- Six hand-duplicated `withRetry` functions (`watch.js:36`, `proposals.js:30`,
  `research.js:305`, `relevance.js:52`, `assessment.js:86`, `discovery.js:78`),
  each regex-matching Gemini error strings, collapse into one helper over
  typed SDK exceptions.
- 1M context with no long-context premium relieves the truncation pressure
  that produced `parseItemsLoose()` (`discovery.js:103-129`, a brace-depth
  scanner that salvages complete elements from truncated JSON) and the
  `SCRAPE_CAP`/`MAX_HITS` ceilings.

**Made harder.**

- **All 23 response schemas need editing.** They use `nullable: true` — an
  OpenAPI-3.0-ism, not JSON Schema — and Claude needs
  `anyOf: [{type:"x"},{type:"null"}]` plus `additionalProperties: false` on
  every object (currently missing everywhere). This is not cosmetic: the
  `nullable` + `required` pairing is a deliberate anti-hallucination guard
  (`analysis.js:93-96` — *"the key is always present but may be null, never
  invent one"*), so each rewrite needs behavioural re-validation. If the model
  starts filling non-null slots, Moment-of-Truth degrades silently and
  `verifyMoments()` may not catch it.
- **`temperature` is gone.** Removed on Opus 5 (400 error), non-default values
  rejected on Sonnet 5; 35 occurrences. Most are determinism settings
  replaceable by low `effort` — but **`arena.js:113` uses
  `temperature: 0.85` specifically for persona variety across roleplay runs.**
  There is no parameter substitute; variety must be elicited by prompt. This
  is a genuine, unmitigated capability loss for Arena.
- **A new failure mode: `stop_reason: "refusal"`.** Opus 5 ships elevated
  cybersecurity safeguards and returns **HTTP 200** with empty or partial
  content on a decline. Competitor intelligence and security-vendor prospect
  research are plausibly adjacent enough to trip false positives. Every
  `response.content[0]` access breaks. All Opus 5 call sites need a
  `stop_reason` check plus `fallbacks: "default"`.
- **Dynamic per-request schemas cost latency.** `closedSet()`
  (`discovery.js:47-50`) and `companies.js:440` bake tenant product IDs into
  enums, so the schema differs on every call — a permanent structured-output
  schema-compile cache miss on every discovery request. Gemini has no
  equivalent penalty. Mitigation: drop the enum and rely on the existing
  `ourIds.has(...)` post-parse backstop.
- **No audio or video input.** Gemini accepts both; Claude accepts images and
  PDFs only. Latent today — `recall.js` supplies transcripts and Stream video
  is stored but never sent to a model — but `analysis.js:285` states the
  intent to work from recordings. Any future "analyze the recording directly"
  feature is foreclosed on Claude and would need a retained Gemini path.
- **Two SDKs, two keys, two rate-limit shapes** for as long as embeddings stay
  on Gemini — i.e. indefinitely.

**Residual risks we accept.**

- **The PR #40 gap (2026-07-30) — closed for structured output as of
  2026-08-05, still open otherwise.** `.github/workflows/ci.yml` runs against
  Redis only, with no live API call anywhere; `ops/cd-deploy.sh` smoke-tests
  `/api/health`, `/capture/health` and `/` — **no AI path at all**. A rejected
  structured output would 502 discovery for every tenant with CD reporting
  green. §9 item 3 now covers exactly that case, and the first thing it did was
  find four rejections nothing else could have (§4.6, §4.7). What remains
  uncovered: the check is **not** automatic — it is not in CI (it costs money)
  and not in the CD smoke test, so it protects a cutover only if someone runs
  it. Wiring it to a cron on staging is the cheapest way to make that
  unconditional; until then this risk is mitigated, not eliminated.
- **`embedAll()` has no timeout wrapping** (`embeddings.js`, `CONCURRENCY=4`).
  A hung `embedContent` stalls KB ingestion indefinitely. Out of scope here —
  embeddings aren't moving — but noted because it is the same class of defect
  the scheduler's `withTimeout` guard was built for.
- **Market Watch is hardened.** `scheduler.js:281` wraps
  `watch.runEntityScheduled` in `withTimeout(..., WATCH_ENTITY_TIMEOUT_MS)`,
  covered by `watchEntityTimeout.test.js` and `schedulerPhases.test.js`. That
  guard sits above the model call and survives the migration unchanged. Keep
  it even though the Anthropic SDK ships a default timeout — SDK
  `timeout × (max_retries + 1)` can still exceed a caller's budget.
- **Retry stacking.** The Anthropic SDK auto-retries 408/409/429/5xx
  (`max_retries` default 2). Leaving that active *under* the consolidated
  app-level retry compounds backoff. Decide explicitly, per §9.

## 8. Migration plan (staged; each phase independently revertable)

**Phase 0 — instrumentation (gates everything).** Extend `costs.js` for
Claude's usage shape including `cache_creation_input_tokens` /
`cache_read_input_tokens`; instrument the ~26 silent call sites, starting with
`analysis.js` and `arena.js` (the two units ADR-0004 §8 already said must be
instrumented before touching caps); build a per-tenant $/period read path.
Ships entirely on Gemini — no behaviour change, pure observability.

**Phase 1 — foundation.** Anthropic client wrapper; provider-aware
`models.js`; consolidated retry helper; live-schema smoke check per task
cluster (discovery, analysis, proposals, watch, assessment), manually or
cron-triggered rather than in `npm test`, since it costs money. Router still
defaults every task to Gemini. Re-baseline token counts with `count_tokens`
and amend §5.2.

**Phase 2 — caching redesign.** `gemini.js` cache layer and
`knowledge/globalCache.js`. Isolated because of ADR-0001's cross-tenant leak
history — `test/globalCache.test.js` regression-tests a real prior CRITICAL
finding and must keep passing through the redesign.

**Phase 3 — per-task cutover, cheapest and lowest-risk first.**
`relevance` → `callEntities` → `preview` / `companyBrief` → `keypoints` /
`assessment` → `research` / `compare` / `brief` → `watch` →
`arena` / `personas` → `discovery` → `analysis` / `proposals`.
Founders/INTERNAL tenant first at each step. Shadow-compare
`discovery.js`, `analysis.js` and `proposals.js` against Gemini before
cutting over — these three carry the business risk and one of them
(`discovery`) has a documented wrong-results incident.

**Phase 4 — cost mechanics.** Batch on `watchTick`, KB ingest and discovery
backfills; cache breakpoints on the four prefixes in §4.3; `effort` sweep per
route. **Measure against Phase 0's meter and re-run §6 with real numbers.**

**Phase 5 — cutover close.** Remove `@google/genai` generation paths.
`GEMINI_API_KEY` and `embeddings.js` stay.

**Rollback.** Phases 0–2 are additive. Phase 3 reverts per task by env flip.
Phase 4 reverts per lever. Nothing before Phase 5 removes the Gemini path.
Preserve original Gemini prompt text in git history rather than overwriting in
place — Claude-tuned prompts are not guaranteed to work as well if reverted
onto Gemini.

## 9. Builder hand-off (ordered)

One PR per bullet unless noted. Each carries the full four-pass review; the
decomposition exists so that per-file spokes stay tractable.

1. **`costs.js` + instrumentation** (Phase 0). `api/src/costs.js`,
   ~26 call sites, a read path in `platformAdmin.js`. No migration needed —
   `usage_costs` (`0049`) already has the right shape. *Never edit `0049`;
   if a column is genuinely missing, add a new numbered migration.*
2. **Client wrapper + provider-aware router + env** (Phase 1). ✅ *Shipped
   2026-08-05 — see the §4.5 amendment for the two deviations.*
   New `api/src/anthropic.js`; `api/src/models.js` gains `resolve(task)`
   returning `{provider, model}` (not a changed `modelFor`); the eleven
   unreachable `GEMINI_*_MODEL` overrides wired through `docker-compose.yml`,
   plus the fifteen `ANTHROPIC_*_MODEL` equivalents; `.env.example`,
   `.env.production.example`, `api/package.json`, `platformAdmin.js`
   (`AI: ['GEMINI_API_KEY']` → add `ANTHROPIC_API_KEY`).

   Two capability facts the live probe established, which any call-site
   migration must respect: **claude-haiku-4-5 — the whole LITE tier — rejects
   both `thinking:{type:'adaptive'}` and `output_config.effort` with 400s**, and
   thinking/effort are separate axes (claude-opus-4-5 accepts effort, rejects
   adaptive). The wrapper handles this; anything bypassing it must too.
3. **Live-schema smoke check** (Phase 1). ✅ *Shipped 2026-08-05.*
   `api/test/live/smoke.js` + a registry of all 26 schemas, run by hand or by
   cron (`docker compose run --rm --no-deps -v "$PWD/api":/app -w /app api
   node test/live/smoke.js`), never in `npm test` — it spends money.
   `api/test/liveSchemaCoverage.test.js` is the free CI half: a
   `responseSchema:` in `src/` that no registry row names fails the suite,
   because a smoke run that reports green over a schema it never tried is the
   same blind spot phase 0 closed for telemetry.

   It paid for itself immediately — see **§4.6**, which exists entirely because
   of what this check found, and **§4.7**, the one task it says cannot move.
   Current state: **28/29 accepted**, the single rejection being
   `proposals.synthesize`.

   Two things it does NOT do, so nobody reads more into a green run than is
   there: it does not validate responses against the schema field by field
   (only that they parse, plus the one silent case in §4.6 — a required
   nullable field coming back non-null), and it says nothing about answer
   quality, since the prompts carry no real content. A transient 429/529 is
   reported as an *error*, never as a rejection; exit codes distinguish the two.
4. **Caching redesign** (Phase 2). `api/src/gemini.js`,
   `api/src/knowledge/globalCache.js`, `api/test/geminiCacheScan.test.js`
   (likely deleted), `api/test/globalCache.test.js` (must keep passing).
5. **Per-task cutover PRs** (Phase 3), grouped to keep each reviewable:
   `relevance` + `preview` + `companyBrief`; `keypoints` + `assessment`;
   `research` + `ocr`; `compare` + `enrichment` + `contacts` + `companies`;
   `brief`; `watch` + scheduler env; `arena` + `arenaHistory` + `personas`
   (depends on 4); `discovery`; `analysis` + `proposals` (last).

   Every group's schemas are already proven acceptable by item 3 — **except
   `proposals`, which carries the §4.7 reshape and is the reason that group is
   last.** Run the check for a group before flipping it (`--cluster=`), and
   again after: the schemas are shared objects, so a change made for Claude is
   also a change to what Gemini receives.
6. **Cost mechanics** (Phase 4). Batch wrappers, cache breakpoints,
   `effort` per route. Re-run §6 and amend this ADR with measured numbers.
7. **Enterprise deal-calculator floor** → ≥$1.75/engagement (§6). Docs only;
   no `plans.js` change (Enterprise is `contactSales`).
8. **Cutover close** (Phase 5).

Not in scope for any PR above: embeddings (§4.2), `capture/`, `mcp/`, any
`plans.js` cap or price change (§10), any Stripe price ID work.

## 10. Open questions / follow-ups

- **Does Pro base need a cap reduction anyway?** §6 clears the floor in the
  Optimized column, but on *modeled* numbers. If Phase 4's measured figures
  land between Balanced and Optimized, the lever is `market_monitoring`
  250 → 100 and `arena` 100 → 40 for **new checkouts only** — data-only in
  `plans.js:150`, no Stripe change, no migration. Do not touch existing
  subscriptions without a v3 catalog.
- **If a v3 catalog is ever needed**, `seatPriceIdFor` and
  `subTenantPriceIdFor` (`plans.js:216-223`) hard-code `PLANS_V2` and take no
  version argument — they would silently keep selling v2 seats to v3 tenants.
  Fix as part of any v3 work. And per the non-negotiable: **never repoint
  `STRIPE_PRICE_*_V1` or `_V2` at a new price** — grandfathering depends on
  the IDs staying distinct.
- **Ship the deferred $2.50 engagement overage?** (`plans.js:155-162`, wiring
  already present at `entitlements.js:114-119` and `gating.js:159-162`.) It
  holds ≥35% at the new engagement COGS and is additive in Stripe, so no
  grandfathering risk. It only helps the engagement tail, which is the *least*
  LLM-exposed unit — so it is revenue work, not margin defence.
- **ADR-0004's status.** It reads `Proposed` while migration `0049` and the
  v2 catalog are live in both environments. Flip it to `Accepted` or record
  what remains unimplemented; this ADR amends it either way.
- **Re-verify Sonnet 5 pricing after 2026-08-31** when introductory rates
  expire, and re-verify all rates quarterly per ADR-0004 §8's Recall precedent.
- **Arena persona variety** post-`temperature` (§7) needs a prompt-side
  solution and an A/B before Phase 3's Arena cutover.
- **Claude's server-side `web_search_20260209` / `web_fetch_20260209`** could
  replace the hand-rolled Brave + Firecrawl prompt-feeding path in discovery,
  research and watch, with native citations and no 6,000-char truncation.
  Deliberately out of scope — a separate ADR, after the swap is stable. The
  strongest case is Market Watch, written up in §13.

## 11. Relationship to other ADRs

- **Amends ADR-0004** §3.1 (vendor rates), §3.2 (per-unit COGS) and §4.3 (the
  margin table). The pricing *structure* ADR-0004 decided — seat scaling, the
  v2 catalog, the ≥35%-at-full-utilization floor, credit packs, sub-tenant
  pricing — is unchanged and remains in force. ADR-0004 §8's requirement to
  instrument Arena session cost before any Arena cap change is absorbed into
  §8 Phase 0 here.
- **Constrained by ADR-0001** (multi-tenant knowledge isolation): the
  `globalCache` redesign in Phase 2 must preserve the cross-tenant guard that
  `test/globalCache.test.js` regression-tests.
- **Independent of ADR-0005** (FORCE RLS): no shared surface, but both touch
  `scheduler.js` and `platformAdmin.js` — sequence the PRs to avoid conflicts.
- **Does not supersede anything.**

## 12. Sources (retrieved 2026-08-05)

- Claude models & pricing: https://platform.claude.com/docs/en/about-claude/pricing
- Claude prompt caching: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Claude batch processing: https://platform.claude.com/docs/en/build-with-claude/batch-processing
- Claude structured outputs: https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- Gemini API pricing: https://ai.google.dev/gemini-api/docs/pricing
- Voyage AI pricing & model dimensions: https://docs.voyageai.com/docs/pricing ,
  https://docs.voyageai.com/docs/embeddings
- OpenAI embedding pricing: https://developers.openai.com/api/docs/pricing
- In-repo evidence: `.env`, `api/src/models.js`, `api/src/costs.js`,
  `api/src/knowledge/embeddings.js`, `api/db/migrations/0001_kb_tables.sql`,
  `api/db/migrations/0049_pricing_v2.sql`, `usage_costs` rows on `ghost-db`
  and `dsp-db`.

## 13. Deferred: agentic Market Watch on the Batch API

Recorded here rather than acted on, because it depends on three things that do
not exist yet. It is the single best candidate in the product for both server-
side tool use *and* the Batch API, and the two reinforce each other rather than
competing — which was not obvious until it was checked.

**What it would be.** Today `watch.runEntity` calls `buildWatchQueries(name)`
for fixed query strings, `discovery.gatherFromQueries` runs Brave (5 results per
query, 14 hits) and Firecrawl-scrapes the top 3, and that text is pasted into a
single `extractDevelopments` call. The model sees whatever that pipeline
happened to catch and **cannot follow up on what it finds** — a funding round
that appears in a search snippet stays a snippet. The agentic version hands the
model `web_search` + `web_fetch` with a `max_uses` cap and lets it decide what
to search, what to read, and whether an item is a real development or noise,
returning the same `DEV_SCHEMA` so dedupe, `watch_findings` and the digest email
are untouched.

**Verified 2026-08-05, against the live API — these were the open questions:**

- **Batch supports web search.** *"You can include the web search tool in the
  Messages Batches API."* Batch's unsupported list (`stream`, `speed`, `store`,
  `cache_hint`, `context_hint`, `max_tokens: 0`, `previous_thread_event_id`,
  `research_preview_2026_02`) does not touch this.
- **Search and structured output compose.** This was the real risk: web-search
  citations are always on, and citations normally 400 against
  `output_config.format`. Tested directly — `claude-sonnet-5` with
  `web_search_20260209` **and** a `json_schema` returned `stop_reason:end_turn`,
  2 searches, and valid schema-conformant JSON. So the existing schema contract
  survives.
- **It is slow: 101 seconds for one entity.** That is the argument for Batch
  rather than an obstacle to it. Synchronously it is unusable inside an hourly
  tick over a 4-worker pool; asynchronously it costs nothing, because nobody is
  waiting on a watch scan.

**Why Market Watch and not something else.** Nobody waits on it (hourly cron,
per-entity cadence of daily/weekly/monthly). Entities are independent, so it is
a natural fan-out — the shape Batch wants. It is the highest-volume workflow
once tenants actually enable it. And its unit is ~90% LLM (§5.2), so Batch's
50% token discount lands almost entirely on real cost.

**The four things that would bite.**

1. **`pause_turn` cannot be resumed inside a batch.** A long search turn pauses
   and must be continued by sending the assistant message back in a *new*
   request. In a batch that result comes back paused. Cap `max_uses` (3–5) and
   treat a paused row as a retry on the next tick, not a failure — and note the
   existing refund path (`watch.js`, `watchFailure`) must not fire for it.
2. **Search is not discounted.** Batch halves tokens; `$10 per 1,000 searches`
   is charged identically either way. At `max_uses: 3` that is ~$0.03 per entity
   scan in search fees alone, against §5.2's *entire* modelled watch unit of
   $0.063. It could double the unit cost while tokens halve. **This is the
   number that decides it**, and nothing can measure it until the meter is live.
3. **Batch throttles web search per organisation** — "large batches with many
   searches might take longer to complete." Fanning out across every tenant's
   entities is exactly the shape that hits that limit.
4. **`response_inclusion: "excluded"`** (`web_search_20260318`) drops raw search
   blocks from the response, cutting output tokens for workflows that do not
   echo search content back. Built for this case; use it.

**Preconditions, in order.** Do not start before all four hold:

1. Phase 0 metering merged and reporting real per-site numbers (§9 item 1).
2. `marketWatch` migrated to Claude *scripted*, on Batch, and stable — so the
   agentic A/B has a same-provider baseline to beat rather than confounding a
   provider change with a technique change.
3. The wrapper extended with a tool-capable, `pause_turn`-aware path.
   `anthropic.generate()` is deliberately single-shot and sends no `tools`; this
   should be a separate `runWithTools()` rather than growing `generate()`, so
   the cheap path stays cheap to reason about.
4. At least two weeks of measured watch spend to compare against.

**Then decide on evidence:** A/B agentic vs the Brave + Firecrawl pipeline on
findings quality *and* cost together, and only adopt if both improve. If it
wins, `discovery.gatherFromQueries`, the Brave client and the Firecrawl scrape
path can retire with it — a maintenance argument as well as a quality one.

Its own ADR when the time comes: it changes the cost model, the failure modes
and the review-queue semantics simultaneously.
