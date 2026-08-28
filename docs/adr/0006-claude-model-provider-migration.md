# ADR-0006: Move generation to Anthropic Claude; keep embeddings on Gemini

- **Status:** Proposed (2026-08-05 — amends the LLM inputs of ADR-0004 §3.1,
  §3.2 and §4.3; does not change the pricing structure ADR-0004 decided)
- **Date:** 2026-08-05
- **Authors:** Builder (provider assessment)
- **Affects (when implemented):** `api/src/gemini.js`, `api/src/models.js`,
  `api/src/costs.js`, `api/src/anthropic.js`, `api/src/schemaCompat.js`,
  `api/src/aiContext.js`, `api/src/personas.js`,
  `api/src/knowledge/globalCache.js`, and the ~20
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
  at **26%** against a 35% floor (~29% as first modelled; corrected downward
  when the tokenizer allowance was re-measured — §5.2).
- **The same migration with caching, Batch, and deliberate down-tiering lands
  at 48% — better than today's modeled 36.5%.** §6.

That gap — 26% vs 48% on the same vendor and the same features — is the whole
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
| `flash` / `content` | **`claude-sonnet-5`** | `discovery`, `research`, `marketWatch`, `brief`, `compare`, `personas`, `content`, **`keypoints`**, **`battlecard`** | adaptive, `effort:"medium"`; `effort:"low"` on `personas` |
| `lite` | **`claude-haiku-4-5`** | `relevance`, `callEntities`, `preview`, `companyBrief`, doc-level `assessment` | `effort` unsupported — omit |

Two corrections fall out of this and are part of the decision:

- **`keypoints` is promoted from `lite` to `flash`.** Two of the key's three
  call sites are judgment, not extraction: `COMPANY_ANALYSIS_SCHEMA`
  (`knowledge/keypoints.js`, `extractCompanyAnalysis`) asks for `differentiator`
  and `idealCustomerProfile`, and `PRODUCT_ANALYSIS_SCHEMA`
  (`extractProductAnalysis`) asks for `pricingPosture`, `whoBuysIt` and
  `competingProducts`. It was mis-tiered under Gemini too; Haiku would regress
  both visibly. *(Corrected 2026-08-14: this line put `pricingPosture` in the
  COMPANY schema and rested the whole argument on one schema. It is in the
  PRODUCT one — so the case is stronger than it was written, two sites out of
  three rather than one. The same error was copied into `models.js` and
  `keypoints.js`; all three are fixed. Line numbers dropped rather than
  re-pinned — they were already stale by ~46 lines, and a symbol name does not
  rot.)*

  **The third site is a deliberate bend, recorded so it is not read as an
  oversight.** `kb.keypoints` is plain bullet extraction and runs on every
  ingested document — the highest-volume site this key serves — and a tier is
  per key, so it is carried up to Sonnet with the other two. Over-tiering is the
  safe direction and §6 prices this key at FLASH throughout. It is the exact
  mirror of the `assessment` hazard below (one key rounding two sites *down* to
  Haiku and silently degrading the harder one), and the residual risk is the
  knob §4.5 invites an operator to turn: `ANTHROPIC_KEYPOINTS_MODEL=claude-haiku-4-5`
  would save money on the extraction site by demoting the two judgment ones.
- **`assessment` splits.** Per-document scoring stays `lite` under the
  `assessment` key; the `BATTLECARD_SCHEMA` synthesis
  (`knowledge/assessment.js`, `extractBattlecard`) moves to `flash` under a **new task key,
  `battlecard`** — the lowercase string is the router key in `models.js` and the
  `AI_PROVIDER_BATTLECARD` / `ANTHROPIC_BATTLECARD_MODEL` /
  `GEMINI_BATTLECARD_MODEL` env names derive from it. *Landed in the router
  2026-08-07 (PR #53); both call sites landed on the seam 2026-08-14 with §9
  item 5's group 2, which is when the two keys became eligible for Claude at all.
  `battlecard` still keeps Gemini tier `lite`, so only the Claude side is
  re-tiered and no Gemini request moved; the Gemini-side correction, if one is
  wanted, remains a separate decision.*

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
   Stage 0, read at Stages 1 and 2; `tenantContextText` (`keypoints.js`,
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

**Measured, not cited (2026-08-05).** The thresholds above were taken from
documentation when this ADR was written; they have since been verified live
with a per-run nonce prefix sized by `count_tokens`:

| model | 300 tok | 700 tok | 1,500 tok | 5,000 tok |
| --- | --- | --- | --- | --- |
| `claude-opus-5` | 0 | **708 cached** | 1,509 | 5,009 |
| `claude-sonnet-5` | 0 | 0 | **1,511 cached** | 5,012 |
| `claude-haiku-4-5` | 0 | 0 | 0 | **5,009 cached** |

(cell = `cache_creation_input_tokens`.) Opus's threshold was bracketed to
(484, 513] — i.e. exactly 512. Every sub-threshold call returned **HTTP 200,
`stop_reason: end_turn`, no error and no warning field**, confirming the silent
failure mode. `input_tokens` collapses to 13–14 once the prefix caches, which
is the same live confirmation that it is the uncached remainder only (§4.4).

Two consequences for §9 item 4:

- **Exceeding four `cache_control` blocks is a hard 400** (`"A maximum of 4
  blocks with cache_control may be provided. Found 5."`), not a silent drop —
  breakpoint budgeting is a validation constraint, not a best-effort one.
- **The Arena persona seed's cacheable prefix is 2,561 tokens on the old-gen
  tokenizer** and 3,445 on the new-gen one — above Opus's 512 and Sonnet's
  1024, but *below* Haiku's 4096. So `personas.js`'s comment that the seed "is substantial enough
  to clear the model's minimum-cacheable" threshold becomes false the moment the
  persona task resolves to Haiku, and it fails silently.

  Measure the **cacheable prefix** — `systemInstruction` plus the `contents`
  parts' text, which is what `getOrCreateCache` sends. Not `personas.js` the
  source file, and not `JSON.stringify(contents)`: the JSON envelope adds ~340
  tokens of braces, quotes and keys that never reach the API. A first version of
  this line published 3,783 / 2,723 from exactly that mistake. `contents` alone
  is 3,350 / 2,495, which is close but excludes the system block.

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
  `DISPATCH_READY` set, which starts empty and grows as call sites migrate —
  a task is in it only once its call site can actually branch on
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
cites nothing". With `nullable` ignored, the field is required and cannot be
null, so the model must emit *something*. Demonstrated with the real
`MOMENTS_SCHEMA` against a transcript containing no objection (`agreement` came
back correctly populated in every run, so the null is a real signal and not the
model declining to answer):

| request | `objection` |
| --- | --- |
| Gemini, schema as shipped | `null` |
| Claude, translated | `null` |
| Claude, `nullable` merely dropped | `{"quote":"","category":"","startSeconds":0,"endSeconds":0,"resolved":false}` |

That third row is an objection record asserting an objection that never
happened. **Note the exact signature**, because it is not what you would go
looking for: the model does not invent a plausible quote, it emits a degenerate
all-empty sentinel (`quote: ""`, `startSeconds: 0`, `resolved: false`).
Anyone hunting this in stored data would be searching for fabricated text and
would find empty strings. It still lands in the database as a real objection;
`web/admin/admin.js` happens to guard on `.quote` and so does not render it,
which means the corruption is invisible in the UI as well as in the logs.

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

The limit is **structural, not textual**, and the table is a clean 2×2 that
separates the two: halving the byte size at constant branch count leaves the
rejection unchanged, while holding size roughly constant and zeroing the branch
count clears it. The schema sits marginally over — dropping the single nullable
`proof` section is enough, on both models.

**The ceiling for this schema sits between 14 and 17 nullable branches.** That
is low enough that other schemas may be near it without anyone knowing: nothing
on the Gemini side bounds this, and only the §9 item 3 check surfaces it.

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
available, otherwise from prompt-cap constants in code, plus a tokenizer
allowance on input counts because Claude and Gemini do not tokenize the same
text into the same number of tokens.

The allowance in force for the table below is **+30% on input counts**, and it
is **wrong in both directions**. Measured 2026-08-05 with both providers'
`count_tokens` on identical text:

| content | new-gen tokenizer | old-gen tokenizer |
| --- | --- | --- |
| `kb_chunks` corpus, all sources | **1.68–1.70** | 1.11 |
| …of which genuinely web-scraped pages | **1.39–1.61** | — |
| …of which PDF-extracted prose | **1.70–1.78** | — |
| Assembled `proposals.synthesize` prompt | **1.71** | 1.09 |
| Assembled `research.analyze` prompt | **1.68** | 1.08 |
| Prose-bearing JSON (what our schemas emit) | 1.74–1.88 | — |
| Call transcript, `formatTranscript` shape | **1.34** | 0.96 |
| Source code / markdown | 1.35–1.50 | 1.03–1.11 |
| Dense numeric JSON | 1.00 | 0.77–0.85 |

**"New-gen" and "old-gen" do not track tier or release order.** Measured
byte-identical counts within each group: `claude-opus-5`, `claude-sonnet-5` and
`claude-opus-4-8` share the new tokenizer; `claude-sonnet-4-6` and
`claude-haiku-4-5` share the old one. So `ANTHROPIC_MODEL_FLASH`
`claude-sonnet-5` → `claude-sonnet-4-6` — a knob §4.5 explicitly tells an
operator to turn — cuts input tokens ~35% and moves a whole tier across
generations. Everything below assumes the new-gen tokenizer for
flash/pro/content and the old one for lite.

> **Amended 2026-08-05.** A single blanket multiplier cannot be right, for two
> independent reasons, and the first invalidates the way this allowance was
> applied at all:
>
> - **There are two tokenizer generations**, and models within a generation
>   return byte-identical counts. The old-gen one is at or below parity with
>   Gemini (0.77–1.11), so **no allowance is due on it at all**. §4.1 puts five
>   tasks on Haiku 4.5 (`relevance`, `callEntities`, `preview`, `companyBrief`,
>   doc-level `assessment`), so the entire `lite` tier was **over**-allowanced
>   by ~30%.
> - **The ratio is content-dependent across the full 1.00–1.88 range** on one
>   tokenizer — see the table. Prose-borne prompts (discovery, research, watch)
>   sit near 1.70; transcript-borne ones (the engagement path) near 1.34. That
>   spread is far wider than the correction itself, which is why §6 is computed
>   per unit and why no single number belongs in this table.
>
> A first attempt at this correction published a single 1.45 and was wrong: its
> samples were source files and markdown, **not prompt text**, which is the only
> text these units actually pay for. Recorded because the mistake is easy to
> repeat — measure the assembled prompt, per tier.
>
> §6 carries margins recomputed per unit by dominant content. **Remaining work:**
> the per-unit ratios there are still keyed off representative samples, not off
> each unit's real prompt distribution. That is the measurement §8 Phase 1 asks
> for and it is not finished.
>
> **Separately open: output counts got no allowance at all.** A denser tokenizer
> inflates generated tokens for the same answer text just as it does prompt
> tokens. Where a line's output figure came from observed *Gemini* output it is
> understated by the same ratio; where it came from a `max_tokens` cap it is
> already in Claude tokens and is correct. This table mixes both sources without
> recording which is which, so it cannot be settled here — §6 scenario B prices
> the pessimistic reading. See §10.

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

**Method, and which cells actually reproduce** (checked 2026-08-05 — it had
never been written down, which is how a wrong tokenizer allowance survived in
here for weeks). Multiply §5.2's unit COGS by the plan's caps, add the Stripe
line, divide into revenue:

```
Pro base = 250×$0.17 + 30×$1.09 + 250×$0.063 + 100×$0.10 + (149×0.029 + 0.30)
         = $105.57  →  (149 − 105.57)/149 = 29.1%   [published 29.2%]
```

The whole **ADR-0004 column reproduces on all eight rows**, which validates the
method. In the Balanced/Optimized columns **four of eight rows do not**:

| row | Balanced | Optimized |
| --- | --- | --- |
| Research credit | 50.8% vs 55.0% | 61.0% vs 62.0% |
| Pro extra seat | reproduces | 41.9% vs 45.0% |
| Starter extra seat | 44.5% vs 45.8% | 50.7% vs 52.6% |
| Sub-tenant add-on | 62.6% vs 63.1% | 66.7% vs 68.0% |

**Seven cells across four rows**, not four cells — a reader checking Starter
extra seat Optimized or Sub-tenant Optimized will find them wrong too.

Research credit's published 55.0% omits Stripe, inconsistent with its own
ADR-0004 cell, which does include it at $0.01702/credit from the 50-for-$19
pack. (The Stripe-free identity gives 55.3%, so 55.0% additionally implies a
research unit of $0.171, not $0.17.) The other rows solve backwards to a stale
engagement unit — **$1.04–1.06 in the Balanced cells and ~$0.97 in the
Optimized ones** — i.e. two different earlier drafts, not one. Treat those four as unreliable
independently of anything below; Pro base, Starter base, Engagement credit and
Free tier reproduce cleanly.

> ### ⚠️ SUPERSEDED — the Balanced and Optimized columns below are stale
>
> Kept for provenance only. Every cell in those two columns is superseded by
> the corrected block further down, or is one of the seven that do not
> reproduce (above), **except** Engagement credit and Free-tier Optimized —
> those three reproduce and are corrected in the notes under that block.
> **The ADR-0004 column is still valid.** For any current figure, read the
> corrected table and its notes, not this one.

> | Revenue line | Price | ADR-0004 | **Balanced** | **Optimized** | Floor |
> | --- | --- | --- | --- | --- | --- |
> | **Pro base** (250 research, 30 eng, 250 watch, 100 arena) | $149 | 36.5% | **29.2%** ❌ | **48.7%** ✅ | ⚠️ decided here |
> | **Starter base** (75 research, 10 eng, 25 arena) | $49 | 50.1% | **43.1%** ✅ | **53.2%** ✅ | ✅ |
> | Engagement credit | $2.00/cr | 46.5% | **42.0%** ✅ | **44.0%** ✅ | ✅ |
> | Research credit | $0.38/cr | 63.9% | 55.0% ✅ | 62.0% ✅ | ✅ |
> | Pro extra seat (+25 research, +15 eng) | $35 | 44.8% | **37.4%** ✅ | **45.0%** ✅ | ✅ |
> | Starter extra seat (+25 research, +5 eng) | $19 | 53.4% | **45.8%** ✅ | **52.6%** ✅ | ✅ |
> | Sub-tenant add-on | $29 | 68.5% | **63.1%** ✅ | **68.0%** ✅ | ✅ |
> | Free tier (20 research, 10 arena) | $0 | −$3.90/mo | **−$4.40/mo** | **−$2.97/mo** | n/a |

~~**Pro base is the only line that fails, and it fails only in the Balanced
column.** … Ship the model map without the cost mechanics and Pro is 580bps
underwater.~~ **Superseded 2026-08-05 — see the corrected table below. The
conclusion holds; the magnitude was understated.**

> **Corrected for §5.2's tokenizer finding.** Per-unit input ratios keyed to
> each unit's dominant content, on the new-gen tokenizer: research **1.70** and
> watch **1.70** (scraped prose), engagement **1.32** (`formatTranscript`
> output at 1.34, blended with Stage-0's old-gen leg at parity), arena **1.37**.
> Each replaces the blanket 1.30 baked into the table above.
>
> | Revenue line | *Bal.* pub | **Bal. A** | **Bal. B** | *Opt.* pub | **Opt. A** | **Opt. B** |
> | --- | --- | --- | --- | --- | --- | --- |
> | **Pro base** | 29.2% ❌ | **25.7%** ❌ | **17.4%** ❌ | 48.7% ✅ | **47.6%** ✅ | **45.3%** ✅ |
> | Starter base | 43.1% ✅ | **40.6%** ✅ | **37.8%** ✅ | 53.2% ✅ | **52.3%** ✅ | **51.0%** ✅ |
> | **Pro extra seat** | 37.4% ✅ | **36.1%** ✅ | **34.4%** ❌ | 45.0% ⚠ | **41.3%** ✅ | **40.1%** ✅ |
> | Starter extra seat | 45.8% ⚠ | **42.4%** ✅ | **40.5%** ✅ | 52.6% ⚠ | **49.8%** ✅ | **48.8%** ✅ |
>
> ⚠ = the published cell does not reproduce (see above the table); the
> corrected columns are computed from §5.2's units regardless.
>
> **A** corrects input-derived cost only. **B** additionally assumes output
> counts were Gemini-derived and carry the same ratio (§5.2's open question).
> Input share *of cost* at Claude's 5:1 output:input rate ratio is **measured**
> for research (0.80, n=1) and watch (0.24, n=4) from `usage_costs`, and
> **assumed** for engagement (0.75) and arena (0.50).
>
> Three findings, in descending order of how much confidence they deserve:
>
> - **Robust: Pro base's Balanced shortfall widens from 580bps to ~930bps (A)
>   or ~1760bps (B).** It fails under every combination of the inputs above.
>   The decision is unchanged and strengthened — §4.3's cost mechanics are
>   load-bearing, not polish.
> - **Robust: Optimized clears the floor on every line under every scenario**,
>   40.1% at the worst. Recomputed, not asserted; an earlier draft waved this
>   away with "cache reads bill at 0.1× so the correction is absorbed", which is
>   the wrong mechanism — a rate multiplier does not cancel a count multiplier.
>   The *relative* uplift is identical in both columns; Optimized moves less
>   only because its input-cost base is smaller in dollars.
> - **NOT ROBUST, and left open: Pro extra seat.** It is engagement-heavy
>   (15 eng vs 25 research), so it turns on two numbers nobody has measured, and
>   it crosses the floor within the plausible range of each:
>
>   | gate | Bal-B crosses the floor | today's input |
>   | --- | --- | --- |
>   | engagement input ratio | above **1.27** | **measured 1.32** → 34.4%, fails |
>   | engagement input share | below **0.90** | **assumed 0.75** → fails |
>
>   **On today's best measurement this line fails scenario B, at 34.4%** — a
>   second failing line, which changes the decision's shape rather than its size.
>   Both gates sit inside the error bars: the ratio needs the real engagement
>   prompt mix (the pre-call brief leg is dossier prose at ~1.70, not transcript,
>   and is ~16% of that unit's LLM spend), and the share has never been measured
>   at all. Recorded as unresolved rather than as a verdict because an earlier
>   draft of this amendment asserted the *opposite* conclusion on a transcript
>   ratio of 1.26 that did not survive re-measurement — the real
>   `formatTranscript` output is 1.34, and the difference alone flips this line.
>
>   **The research/watch ratio is the same kind of exposure**, and it moves this
>   same line. The 1.70 keyed to those units is the `kb_chunks` corpus average,
>   which is dominated by PDF-extracted prose (1.70–1.78); the genuinely
>   web-scraped pages those units actually ingest measure **1.39–1.61**. At
>   1.50 Pro base still fails (27.3% A / 20.8% B) but **Pro extra seat clears
>   scenario B at 35.1%** — so this line's verdict turns on a third unmeasured
>   input, not two.
>
>   **Both open questions bear on this one line, and neither dominates.** The
>   output question is what puts it in scenario B at all — at the same 1.32
>   ratio it clears under A (36.1%) and fails under B (34.4%) — and it costs Pro
>   base a further ~830bps besides. The prompt-mix measurement is what decides
>   whether the 1.32 is even right. Resolve both before treating this line's
>   verdict as settled; measuring the prompt mix is merely the cheaper of the
>   two, not the more decisive.
>
> Rows not shown above, none of them at risk:
>
> - **Research credit** and **Sub-tenant add-on** — published cells unreliable
>   (above), but both clear the floor under A and B in either column.
> - **Engagement credit** reproduces cleanly and is simply not at risk:
>   corrected to **41.8% / 40.5%** Balanced and **43.8% / 42.6%** Optimized.
> - **Free tier** reproduces cleanly; burn worsens from −$4.40/mo to
>   **−$4.73 (A) / −$5.08 (B)** Balanced, and from −$2.97 to **−$3.09 (A) /
>   −$3.22 (B)** Optimized — still better than today's −$3.90.

Two further notes:

- **Optimized Free-tier burn is *lower* than today's** (−$3.09 to −$3.22
  corrected, vs −$3.90/mo per account; −$2.97 before the §5.2 correction),
  because Arena and watch — the two 100%/90%-LLM meters — are the biggest
  beneficiaries of caching and Batch. Free-tier burn scales with
  signups and has no card, no cap and no expiry
  (`entitlements.js:20`, `plans.js:132-133`); this ADR improves that exposure.
- **Enterprise's $1.60/engagement floor no longer clears 35%.** At the
  §5.2-corrected engagement unit of **$1.05–1.12** it is **29.9–34.2%**
  (ADR-0004 §4.3 already had it at 34.6%; the pre-correction figure was
  31–35%). The deal-calculator floor must rise to **≥$1.75/engagement**, which
  still clears at 35.9% on the worst corrected unit. Tracked in §10.

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
  typed SDK exceptions. **Amended 2026-08-06 (§9 item 3's retry block): one
  helper yes, typed exceptions only on the Anthropic branch.** There is no typed
  exception on the Gemini side at all, so message-scraping survives inside
  `classify()`'s Gemini branch — which is 100% of traffic until the cutover.
- 1M context with no long-context premium relieves the truncation pressure
  that produced `parseItemsLoose()` (`discovery.js:103-129`, a brace-depth
  scanner that salvages complete elements from truncated JSON) and the
  `SCRAPE_CAP`/`MAX_HITS` ceilings.

**Made harder.**

- ~~**All 23 response schemas need editing.**~~ **Resolved 2026-08-05 by §4.6 —
  and the count was 26, not 23.** The incompatibility is real and worse than
  described (three forms, one of them silent), but it is fixed once in
  `api/src/schemaCompat.js` at the wrapper boundary rather than by 26 hand
  rewrites, so **no per-task cutover PR touches its schema — except
  `proposals`, per §4.7**, whose schema exceeds Claude's grammar ceiling and
  must be reshaped regardless of dialect. The
  behavioural-re-validation concern this bullet raised was the right one and is
  discharged: the `nullable` + `required` anti-hallucination pairing
  (`analysis.js:93-96` — *"the key is always present but may be null, never
  invent one"*) was verified live to survive translation — Gemini returns
  `null`, translated Claude returns `null`, and untranslated Claude emits a
  fabricated all-empty record. See §4.6.
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
  it even though the Anthropic SDK ships a default timeout. (The original
  reasoning here — "SDK `timeout × (max_retries + 1)` can still exceed a
  caller's budget" — holds for a *bare* SDK call but not through
  `anthropic.generate()`, which composes its own deadline; see the retry entry
  below. The guard is still correct, because `withTimeout` bounds the whole
  call site including anything wrapped around `generate()`.)
- **Retry stacking — narrowed, not eliminated, and it comes with a silent
  regression.** Corrected 2026-08-05 by running real SDK exceptions through
  `translateError()` and then through all six call-site regexes verbatim:

  | error | matches, raw | matches, translated |
  | --- | --- | --- |
  | 429 rate limit | 6/6 | **0/6** |
  | timeout / connection / abort | 0–6/6 | **0/6** |
  | 503, 529 | 6/6 | **6/6** |

  - **Stacking survives exactly where it is least wanted.** On 503/529 the app
    layer still retries *over* the SDK's — up to 9 attempts on the statuses
    Anthropic uses for overload. The original entry was right that stacking is
    a risk; it was wrong that the risk is general.
  - **And a cutover silently drops app-level retry on 429** — the transient
    every one of these helpers was written for — because the message no longer
    contains `429` or `RESOURCE_EXHAUSTED`. Gemini's `DEADLINE_EXCEEDED` cover
    is lost the same way. (500 is *not* in this list: the Gemini-shaped regexes
    never matched a 500 either, so nothing is lost there.)
  - **The magnitude formula needs qualifying, not deleting.** `timeout ×
    (max_retries + 1)` is correct for a bare SDK call — measured 10.3s at
    timeout=3s/maxRetries=2. It does not apply *inside* `generate()`, which
    composes an `AbortSignal.timeout(...)` the SDK re-links onto every attempt,
    bounding the whole sequence (4.0s with a 4s signal). But the outer
    multiplication is still live: each `withRetry` iteration calls `generate()`
    afresh, so worst case is `ANTHROPIC_TIMEOUT_MS × outer attempts` = **360s**
    at the 120s default (~366s with the app layer's own 2s+4s sleeps).
    ~~Still live.~~ **Closed 2026-08-06:** the app layer no longer re-enters
    `generate()` on any Anthropic error, so there is no outer multiplication
    left. And the "bounding the whole sequence" claim is now known to be
    incomplete — see the deadline note below.
  - **`DEFAULT_TIMEOUT_MS` is used for both the SDK `timeout` and the composed
    deadline**, so on a hang the first attempt consumes the entire budget and
    **the SDK's own retries are unreachable** — which undercuts the "the SDK
    already retries, so we don't need to" premise. Give the deadline headroom
    over the per-attempt timeout, or accept that SDK retries only ever fire on
    fast failures. **Resolved 2026-08-06: the second clause.** Slicing was built,
    measured against the live API, and reverted — a slow generation is retried on
    the SDK's connection-error branch exactly like a hung one, so it converts
    "slow" into three billed failures.
  - **The deadline does NOT bound a 429 carrying `retry-after`** (added
    2026-08-06). The SDK's inter-retry sleep takes no signal and parses
    `retry-after` unclamped, so the deadline is only observed at the top of the
    next attempt. Measured: a 3s budget took 45.1s, a 5s budget 60.1s, one
    upstream request each. True worst case is `ANTHROPIC_TIMEOUT_MS + maxRetries
    × retry-after`, unbounded above — which is a further argument for keeping
    `scheduler.js`'s `withTimeout`, the only thing that actually caps it.

  The consolidated helper (§8 Phase 1) must therefore key off the **typed SDK
  exceptions**, not message text; restore 429 coverage; stop retrying 503/529 at
  the app layer; and drop the four `retryDelay` parsers, which are dead code on
  Anthropic (it signals `retry-after`, which the SDK already honours).

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
`assessment` / `battlecard` → `research` / `compare` / `brief` → `watch` →
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
   plus the `ANTHROPIC_*_MODEL` equivalents — fifteen when this shipped,
   sixteen since PR #53 split `battlecard` out of `assessment`; `.env.example`,
   `.env.production.example`, `api/package.json`, `platformAdmin.js`
   (`AI: ['GEMINI_API_KEY']` → add `ANTHROPIC_API_KEY`).

   Two capability facts the live probe established, which any call-site
   migration must respect: **claude-haiku-4-5 — the whole LITE tier — rejects
   both `thinking:{type:'adaptive'}` and `output_config.effort` with 400s**, and
   thinking/effort are separate axes (claude-opus-4-5 accepts effort, rejects
   adaptive). The wrapper handles this; anything bypassing it must too.
3. **Live-schema smoke check** (Phase 1). ✅ *Shipped 2026-08-05.*
   `api/test/live/smoke.js` + a registry covering all 26 schemas, run by hand or by
   cron (`docker compose run --rm --no-deps -v "$PWD/api":/app -w /app api
   node test/live/smoke.js`), never in `npm test` — it spends money.
   `api/test/liveSchemaCoverage.test.js` is the free CI half: a
   `responseSchema:` in `src/` that no registry row names fails the suite,
   because a smoke run that reports green over a schema it never tried is the
   same blind spot phase 0 closed for telemetry.

   It paid for itself immediately — see **§4.6**, which exists entirely because
   of what this check found, and **§4.7**, the one task it says cannot move.
   Current state: **28/29 accepted**, the single rejection being
   `proposals.synthesize`. (26 distinct schemas; 29 registry rows, because the
   three per-tenant *builder* schemas are each also exercised with empty tenant
   data — `closedSet` drops the enum when the list is empty, which is a
   different validator path, not a smaller one.)

   **Re-verified 2026-08-07 for the `assessment` split (PR #53), and the count
   is unchanged at 28/29.** Re-keying the `kb.battlecard` row from `assessment`
   to `battlecard` changed what this check actually sends: a different model
   (`claude-haiku-4-5` → `claude-sonnet-5`) *and* a different request shape,
   because Haiku is in `anthropic.js`'s `NO_EFFORT` list so `output_config.effort`
   was dropped, and Sonnet is not, so `effort:"low"` is now sent with
   `BATTLECARD_SCHEMA`. Neither CI nor the CD smoke test can reach that, so it
   was run against the live API before merge:

   ```
   $ docker compose run --rm --no-deps -v "$PWD/api":/app -w /app \
       api node test/live/smoke.js --site=kb.battlecard,kb.assessment
   live-schema smoke: 2 schema(s) × anthropic

     ── assessment ────────────────────────────── [anthropic]
     ok       kb.assessment                      claude-haiku-4-5       accepted, output parses
     ok       kb.battlecard                      claude-sonnet-5        accepted, output parses

   2/2 accepted
   ```

   No registry row was added or removed, so 29 rows and 28 acceptances still
   stand; what changed is which model backs one of them.

   Two things it does NOT do, so nobody reads more into a green run than is
   there: it does not validate responses against the schema field by field
   (only that they parse, plus the one silent case in §4.6 — a required
   nullable field coming back non-null), and it says nothing about answer
   quality, since the prompts carry no real content. A transient 429/529 is
   reported as an *error*, never as a rejection; exit codes distinguish the two.
4. **Caching redesign** (Phase 2). ✅ *Shipped 2026-08-05 — see "What shipped"
   below for the three deviations from the scope corrections.*
   `api/src/gemini.js`,
   `api/src/knowledge/globalCache.js`, `api/test/globalCache.test.js` (must
   keep passing — it regression-tests a real ADR-0001 cross-tenant leak).

   **Scope corrections, established 2026-08-05 before the work started.** This
   item is larger and differently shaped than the line above suggested, and all
   six of these were found by review rather than by reading the code:

   - **It is not a cache redesign, it is a provider seam.** `getOrCreateCache()`
     returns a record that is either `cached` (a named server resource) or
     `inline`, and `generateForRecord()` dispatches on that — an abstraction
     that encodes *Gemini's* model. Claude has no equivalent: a breakpoint is a
     per-request annotation with no registry, no TTL and nothing to invalidate.
   - **`anthropic.generate()` is SINGLE-TURN** — `messages` is hardcoded to one
     user turn — so it cannot serve `arena.js` or `arenaHistory.js` at all,
     cached or not. §9 item 5's arena group depends on this item precisely
     because of that, and it is a prerequisite, not a detail.

     **Half of this was wrong, and the wrong half is the one that matters for
     item 5.** `arena.js` genuinely needs multi-turn — it replays the whole
     transcript on every turn. `arenaHistory.js` does not: `finalize()` builds
     one string (rubric + `transcriptText(turns)`) and sends a single
     structured call with `SCORECARD_SCHEMA`, which `generate({prompt, schema})`
     already served. What `arenaHistory` actually carries is a *different*
     hazard, recorded here so item 5 does not rediscover it: it scores with
     `session.model || modelFor('personas')`, and `session.model` is a model id
     **persisted in Redis when the session started**. A session opened before a
     `personas` flip and scored after it hands a stale id to whichever client
     the code picks — and it reaches `models.generateContent` directly, so the
     `gemini.js` guard below does not cover it. Resolve the provider at scoring
     time, or store the provider alongside the model.
   - **`personas.js` resolves `modelFor('personas')` at REQUIRE time** and feeds
     it straight to `gemini.caches.create()` via `arena.js`. Setting
     `AI_PROVIDER_PERSONAS=anthropic` hands a Claude model id to the Gemini
     caches API; guarded when this was written only because `DISPATCH_READY` was
     empty. Move it or document it in this item.

     *(Aside added 2026-08-07 by PR #54, not a change to the record above: both
     halves of that sentence have since moved. `personas.js` no longer resolves
     at require time — `defaultModel()` resolves on read (`personas.js:22-28`),
     which this very item fixed. And the Claude-id-into-Google path is now
     guarded by two independent facts rather than an empty set: `personas` is
     not in `DISPATCH_READY`, which stopped being empty when group 1 landed, and
     `assertGeminiModel` refuses a non-Gemini id inside `getOrCreateCache`
     (`gemini.js:113`) — the boundary `arena.js:91` takes.)*
   - **`api/test/geminiCacheScan.test.js` must NOT be deleted here.** It pins a
     fix for a real incident (`redis.keys()` blocking the Redis that also holds
     sessions and login-guard counters, stalling auth platform-wide). §7 already
     schedules its removal for **Phase 5**, with the `/caches` endpoints.
   - **The cache layer cannot be removed in this item either.** Seven call sites
     across six superadmin endpoints in `api/src/index.js` depend on
     `listCachedRecords` / `invalidate` / `getOrCreateCache` /
     `generateForRecord`, two of them pinned by `api/test/routeContract.test.js`.
   - **Existing rows:** `kb_global_cache` holds one row per environment with
     `cache_name` NULL and `char_count` 0 — the global cache has never been
     populated in staging or production, so the data-migration risk here is nil.
     Stated because §"Reviewing a PR" requires it, not because it is a problem.

   Two capability facts this item must design against are in §4.3: Gemini
   accepts **one** `cachedContent` per call (which is why `globalCache.js`
   stores `content_text` separately) while Claude allows **four**
   `cache_control` breakpoints and rejects a fifth with a hard 400; and the
   minimum cacheable prefix is 512 / 1024 / 4096 by tokenizer generation, which
   the Arena persona seed sits under on Haiku.

   **What shipped (2026-08-05).** `api/src/aiContext.js` — `prepare()`,
   `generate()`, `discard()` over a neutral `{role:'user'|'assistant', text}`
   turn shape, dispatching on `models.resolve(task).provider`. `globalCache.js`
   is its first consumer and no longer requires `gemini` at all;
   `anthropic.generate()` gained `messages`; `personas.js` resolves its model on
   read; `gemini.js` refuses a model id belonging to another provider. No task
   joined `DISPATCH_READY`, so every path in production still resolves to Gemini
   and the Gemini branch is byte-identical — the persona seed was diffed against
   its pre-change literal to confirm that. Suite 263/263 (was 242 before, +21).

   Three deviations from the scope corrections above, all deliberate:

   - **The seam does not resolve `globalCache`'s model.** That cache has always
     been built against `GEMINI_ANALYSIS_MODEL`, not its task's tier, and
     `prepare()` takes a `geminiModel` escape hatch so it still is. Re-tiering a
     cache inside a seam PR is exactly the silent behaviour change §9 item 2
     refused to make for `keypoints`.
   - **`personas.js` was moved AND the hazard was guarded**, not one or the
     other. The lazy getter stops the require-time freeze; `models.providerOfModel()`
     plus an assertion in `gemini.getOrCreateCache` / `generateForRecord` stops a
     Claude id reaching Google's caches API even when something bypasses the
     seam — which `arena.js` still does until item 5. It blocks a
     confidently-wrong id rather than allow-listing, so a custom endpoint id or
     a model released later still works.
   - **One asymmetry is exposed rather than papered over.** A context with a
     system instruction and no body is valid on Claude and is *not* preparable on
     Gemini (`caches.create` rejects empty contents). `prepare()` throws there;
     callers with a possibly-empty body must handle it.

   Two behaviours worth knowing before item 5 uses this:
   `anthropic.generate()` now counts `cache_control` blocks and refuses a fifth
   locally (the API's own answer is a hard 400, not a drop), and it logs once per
   model+site when a request asked to cache and `cache_creation` +
   `cache_read` both came back 0 — the sub-minimum silent miss §4.3 measured,
   which is otherwise invisible at full price.

   **Verified live, not just in CI** (`api/test/live/contextSeam.js`, run
   2026-08-05 — it spends money, so it sits beside `test/live/smoke.js` and
   outside `npm test`). It drives the seam with the **real** persona seed, the
   thing item 5 will actually send:

   | model | turn 1 `input` / `cache_write` | turn 2 `input` / `cache_read` |
   | --- | --- | --- |
   | `claude-sonnet-5` | 23 / **3,444** | 87 / **3,444** |
   | `claude-haiku-4-5` | **2,577** / 0 | 2,620 / 0 |

   Three things that no stub could have shown: a multi-turn `messages` array
   carrying an assistant turn is accepted and answers in character on both
   models; the breakpoint on the persona prefix really does write once and read
   back on the next turn (`input_tokens` collapsing to 23 is the same
   uncached-remainder behaviour §4.4 warns the meter must account for); and
   **Haiku silently cached nothing**, exactly as §4.3 predicted — HTTP 200, both
   cache counters 0, full price. The new warning fired on that run, which is the
   only reason it is visible at all.

   The counts also tighten §4.3's own figures, which were measured on the
   assembled prefix rather than on what this seam puts on the wire: **3,444
   new-gen (vs 3,445 published) and 2,577 old-gen for prefix-plus-first-turn (vs
   2,561 for the prefix alone)**. Close enough to confirm the published numbers
   rather than correct them, and recorded so the small deltas are not read later
   as a discrepancy.

   **Review round (2026-08-05), two independent passes.** Verdict from both:
   MERGE WITH FIXES; nothing Critical or High. The confidence pass reproduced
   the suite (263/263 branch, 242/242 base), re-derived the persona-seed
   equivalence independently (same `contentHash` `f2b543ceadc6a3e7` on both
   trees, so the existing registry entry is re-used rather than re-created),
   confirmed `DISPATCH_READY` empty on the running staging container, and broke
   6 of the new assertions deliberately to confirm all 6 fail. It also confirmed
   **zero affected rows in both environments**: `kb_global_cache` is
   `cache_name` NULL / `char_count` 0 in staging *and* production, there are
   **no** `gemini:cache*` Redis keys and no live arena sessions in either, and
   `arena_sessions` is empty in both databases — so the persisted-`session.model`
   hazard above has no data behind it yet.

   Four defects worth recording, because each was confirmed by execution rather
   than argued, and three were invisible to the tests as first written:

   - **The robustness fallback contained the bug it was added to prevent.**
     `record.turns ? … : record.contents` tests truthiness, and `[]` is truthy —
     so a record carrying `turns: []` *and* a real `contents` prefix took the
     turns branch, produced nothing, and sent no persona at all. HTTP 200, an
     answer, no signal. Fixed to test `.length`.
   - **The seam had no unknown-option guard**, one layer above the wrapper that
     has one for exactly this reason — and it *inverts* the spellings
     (`maxTokens`→`maxOutputTokens`, `abortSignal`→`signal`), so a call site
     ported in an item 5 PR would lose its output budget or its only wall-clock
     bound in silence. Now throws, naming both spellings.
   - **`allowTruncation` was not forwarded**, so running out of output budget
     truncates on Gemini and throws 502 on Claude with no way to opt out.
     `arena.js` runs at 400–600 output tokens with a persona told to answer in
     "two to four sentences" — the flip would have turned a long reply into a
     dead practice session. Forwarded, and both this and the differing
     `temperature`/`thinkingConfig` defaults vs `generateForRecord` are now
     stated in the seam's contract.
   - **`discard()` orphaned a Gemini cache across a flip.** It resolved the
     provider from what the task means *today*, so a caller holding a stored
     `cache_name` got a no-op the moment its task moved to Claude — and then
     nulled the column, leaving a live `cachedContent` and its registry key with
     nothing able to name them. `discard` now takes a `provider` override and
     `globalCache` passes `'gemini'` whenever a pointer exists: a stored Gemini
     pointer is a Gemini fact.

   And one in the live probe itself, which is the more useful lesson: the first
   version attached "expected on haiku 4.5" to the *not-cached* branch for every
   model and exited 0 unconditionally, so a Sonnet regression or a hard error
   would have printed and passed. Rewritten to carry a per-model expectation and
   `smoke.js`'s exit-code contract — and **inverting those expectations to prove
   the failure path then exposed a second defect in it**: asserting on
   `cache_creation` alone makes the check pass or fail on how recently it was
   last run, because a re-run inside the 5-minute TTL legitimately *reads* the
   prefix instead of writing it. It now asserts that caching *engaged* (write or
   read) and read back on turn 2. A live check that cannot fail is the blind spot
   §9 item 3 exists for, and this one had to be made to fail before it was worth
   anything.

   ---

   **⚠ THE REST OF THIS ITEM IS A DIFFERENT, UNMERGED PIECE OF WORK.** It is
   recorded here because item 4's review surfaced it, but it is §8 **Phase 1**,
   not Phase 2, and it is **not** covered by item 4's `✅ Shipped` marker above.
   It has no item number of its own only because renumbering items 5–8 would
   break the cross-references elsewhere in this ADR.

   **Related, and better done as its own PR (§8 Phase 1's "consolidated retry
   helper"):** the six hand-rolled `withRetry` copies. Their brief is *not*
   "prevent stacking" — see §7. It is: key off the SDK's typed exceptions rather
   than message text, restore the 429 coverage a cutover silently drops, stop
   retrying 503/529 at the app layer, delete the four dead `retryDelay` parsers,
   and give the deadline headroom over the per-attempt timeout so the SDK's own
   retries become reachable.

   *Built as `api/src/aiRetry.js` (PR #51). Reviewed 2026-08-06 — first pass
   verdict DO NOT MERGE, three blockers, all fixed in the same PR; see "What the
   review found" below. Not merged, not deployed.* **Three of those five points
   needed qualifying, all for the same reason: §7 describes the world AFTER the
   cutover, but the helper ships while every task still resolves to Gemini.
   Taken literally, each would have been a live regression on the only provider
   currently serving traffic.**

   - **"Key off typed exceptions" — there are none on the Gemini side.** The
     `@google/genai` SDK puts the upstream JSON straight into `err.message`,
     which is *why* all six copies grew a regex and why `brief.js`'s
     `translateGeminiError` has to `JSON.parse` a substring to find the status.
     So the helper cannot be uniform. What it does instead is classify once:
     message-scraping survives, but only inside `classify()`'s Gemini branch.
   - **"Stop retrying 503/529 at the app layer" — right for Anthropic, wrong for
     Gemini.** Anthropic's SDK retries them, so stacking reaches 9 attempts;
     Gemini's does not retry at all, so removing it would drop 503 handling from
     every path running today. Resolved with a `sdkRetried` stamp that
     `anthropic.translateError` puts on every error leaving the wrapper: the
     client that already retried says so, and only then does the app layer stand
     down. **This applies to 429 as well** — the first build exempted it and
     re-created the stacking; see blocker 2.
   - **"Delete the `retryDelay` parsers" — dead on Anthropic, live on Gemini**,
     which suggests a delay in the error body and gives that path its only
     backoff signal. Kept for Gemini, never consulted for Anthropic.

   Only the 429 point needed no qualification: the translated message contains
   neither `429` nor `RESOURCE_EXHAUSTED`, so every copy had silently stopped
   matching the transient they were all written for. `classify()` reads
   `err.status`, so it is recognised again — but the *retry* is the SDK's, not
   the app layer's. See blocker 2.

   **The deadline point is ACCEPTED, not fixed, and that is the correction.**
   The first build took neither option §7 floats: it made `ANTHROPIC_TIMEOUT_MS`
   the whole-call budget and sliced the SDK's per-attempt timeout out of it
   (`/(maxRetries+1)`), so retries became reachable inside an unchanged outer
   bound. That was reverted — the premise was false. A merely SLOW generation is
   retried on the SDK's connection-error branch exactly like a hung one, so
   slicing converts "slow" into "failed". §7's own framing — "give the deadline
   headroom, **or accept that SDK retries only ever fire on fast failures**" —
   had the right answer in it, and it is the second clause. A slow call keeps its
   full budget; the SDK's retries cover fast failures, which is the class they
   are useful for.

   **Two behaviour changes on live Gemini paths, not one.** Five copies shared a
   classifier; only FOUR shared a backoff — this item's own brief says "four dead
   `retryDelay` parsers" and the first build then described "the five identical
   copies" a few lines later. The count mattered:

   - **`watch.js`** was looser in its regex — `429` and `deadline` with no word
     boundaries. Consolidating tightens both, so the hourly tick stops retrying a
     `4290` error code and the word "deadline" in prose. Safe direction.
   - **`proposals.js`** had the four's classifier but **no `retryDelay` parser at
     all**, so it never slept longer than 4s. Nobody noticed, and inheriting the
     shared 30s cap would have taken its worst-case app-level sleep from 6s to
     **60s** on `POST /proposals/:companyId/generate` — synchronous, metered,
     behind nginx's 180s `proxy_read_timeout`, with a button that reads "~15s".
     Past that bound nginx 504s while the handler runs to completion, so the
     DRAFT row lands and `gating.refundCapacity` never fires: the tenant is
     charged for a generation it saw fail. The draft is not lost — it lists on
     the next visit — but the unit is spent and a retry spends another.

   Both now carry an explicit bound, and the per-call-site policy lives in one
   `POLICIES` table in `aiRetry.js` rather than in six inline bindings — the
   inline binding is *how* proposals inherited a bound it never had, because the
   divergence sat in the one line of each module a reviewer skims.

   **What the review found (2026-08-06).** Five per-file spokes,
   cross-integration, then a confidence pass that measured against the live API.
   Three blockers, none of which a diff read would have surfaced:

   1. **The timeout slice made 40s a hard ceiling on any single generation.**
      Measured live, `claude-opus-5` @ `max_tokens: 3000` with adaptive thinking,
      same prompt both trees: base = **1 upstream POST, 47.3s, HTTP 200**;
      sliced = **3 upstream POSTs, abort at 120.0s**. Opus 5 runs **63.7 output
      tok/s**, so the ceiling was ~**2,540 output tokens** — under `enrichment`
      (8000), `watch` (6000), `proposals` (3000) and the battlecard synthesis
      (2600 — part of `assessment` when this was measured, its own `battlecard`
      key since PR #53), and close enough to the `assessment` scorer's 2400 to
      fail on ordinary variance.
      `costs.recordClaude` sits after the rethrow, so all three billed
      generations recorded **$0.00** into the meter §6's margin floor depends on.
   2. **429 stacked 3×3.** `classify()` marked Anthropic 429 transient while the
      SDK also retries 429. Measured against an always-429 stub: **9 upstream
      requests** (base: 3). With `retry-after: 60` the SDK's inter-retry `sleep()`
      takes no signal, so the composed deadline cannot interrupt it — a 5s budget
      took **60.1s** to fail; at defaults ~366s. `sdkRetried` is now read (it was
      written, returned by `classify()`, and consumed by nothing while the code
      and this ADR both described it as the mechanism) and is set truthfully
      per branch — the SDK
      does not retry 401/403/other 4xx, and never saw an abort we raised.
   3. **`proposals.js`'s backoff**, above.

      Also fixed: `translateError`'s 429 branch discarded the provider detail,
      which made the per-day carve-out permanently dead on the Anthropic path;
      five error exits left unstamped and so fell into the *Gemini*
      message-scraper, where free-form provider prose containing "unavailable"
      would be retried three times; and a non-numeric `ANTHROPIC_MAX_RETRIES`
      NaN'd into the SDK and threw on every request.

   **The generalisable lesson is about the tests, not the code.** Three of the
   four fixes the first build shipped had no test at all: gutting the stamp,
   reverting the timeout, and changing the `2000*(i+1)` ladder each left the
   suite fully green, because `anthropicSurface.test.js`'s fake client ignores
   its constructor options and `aiRetry.test.js` built Anthropic errors by hand.
   A test that cannot fail is the blind spot §9 item 3 exists for. There is now
   an `anthropicRetrySeam.test.js` driving **real** SDK exception instances
   through `translateError` into `classify`. Suite **297/297**, from 267 on
   `main`, with **fifteen** deliberate breaks confirmed to fail.

   **A second independent pass over the fix round found two more, and both were
   the same species as the originals — a comment asserting something the code
   does not do.** (1) `ANTHROPIC_MAX_RETRIES=0` is a permitted value, and with a
   stamp set per error CLASS the wrapper announced "the SDK already retried this"
   about a client told never to retry; the app layer then stood down too, so that
   deployment silently lost 429 retry *entirely* rather than moving it up a
   layer — measured, 1 upstream request and zero retries anywhere. The stamp is
   now gated on the configured count, and on `x-should-retry: false`, which the
   SDK honours ahead of the status. (2) The claim that the composed deadline
   bounds the whole sequence is false on the `retry-after` path, quantified in
   §7 above.

   That pass also found three deletions that left the suite green — the composed
   deadline itself (removing it made a stalled stream unbounded), the refusal
   stamp (turning a deterministic decline into three billed calls), and the
   per-day carve-out on the Anthropic branch. All three now have assertions, and
   so does the argument-validation path, where the "literal messages cannot match
   a transient regex" reasoning was wrong because those messages interpolate
   caller-supplied values: `effort: '503 UNAVAILABLE'` classified as transient.

   **The pattern across both rounds is worth naming, because it is not a coding
   error.** Every defect in this PR — the timeout slice, the 429 stack, the
   proposals backoff, the `maxRetries=0` stamp, the deadline claim — was a
   comment or an ADR line that described an intent the code did not implement,
   and in four of the five the prose was *more* confident than the code was
   correct. The tests that would have caught them were the ones nobody wrote
   because the behaviour "obviously" worked.
5. **Per-task cutover PRs** (Phase 3), grouped to keep each reviewable:
   `relevance` + `preview` + `companyBrief`; **`keypoints` + `assessment` +
   `battlecard`**; ~~`research` + `ocr`~~ **`research` (shipped; `ocr` split off
   into its own decision PR — see the group 3 entry below)**; `compare` +
   `enrichment` + `contacts` +
   `companies`; `brief`; `watch` + scheduler env; `arena` + `arenaHistory` +
   `personas` (depends on 4); `discovery`; `analysis` + `proposals` (last).

   **Group 2 is three keys, not two, and all three must SHIP together.**
   *(Amended 2026-08-14: this said "flip together", which is a different and
   wrong claim. The keys flip INDEPENDENTLY — one `AI_PROVIDER_<TASK>` each, and
   group 2's own tests assert `battlecard` moving while `assessment` stays. What
   must be simultaneous is the MIGRATION, and the argument below is specifically
   about `assessment` + `battlecard`, the two keys sharing one file. `keypoints`
   is in the group because §8 Phase 3 batches it there for review size, not
   because it is coupled to them.)*
   `knowledge/assessment.js` holds two call sites, and since PR #53 they resolve
   two different task keys: `extractCompetitiveAssessment` → `assessment`
   (lite/Haiku), `extractBattlecard` → `battlecard` (flash/Sonnet). Flipping
   `assessment` alone leaves half of that one file on Gemini. **Nothing errors**
   — the un-flipped half keeps calling the Gemini SDK with a Gemini model id and
   returns a normal battlecard — so the only symptom is that §6's margin table
   prices a task that never moved, and the cutover looks complete when it is
   half done. `battlecard` also still needs its call site migrated onto
   `aiCall.generateStructured` (PR #53 was router-only and deliberately did
   not); until that happens it cannot dispatch to Claude at all, and adding it
   to `DISPATCH_READY` on its own would hand a Claude model id to the Gemini
   SDK.

   **That migration needs no `aiRetry.POLICIES` row — the seam does not
   retry.** `aiCall.js` requires `models`, `gemini`, `anthropic` and `costs`
   and nothing else; every `forLabel()` binding lives in a *caller*
   (`proposals.js`, `relevance.js`, `discovery.js`, `watch.js`,
   `assessment.js`, `research.js`), and `relevance.js:132`/`:174` show the
   shape — `await withRetry(() => aiCall.generateStructured({…}))`, the caller
   wrapping the seam. Retry is therefore a separate, caller-side decision that
   group 2 makes deliberately, and a POLICIES row is needed only if the answer
   is yes (`forLabel()` throws on an unknown label, which is what forces that
   to be deliberate). **The answer here is probably no**, and the note above
   `forLabel('assessment')` in `knowledge/assessment.js` — the very file group
   2 edits — records why: `extractBattlecard` is synchronous behind the
   rep-facing `POST /portfolio/competitors/:id/battlecard/regenerate`, so
   wrapping it turns a fast 502 into three attempts with backoff while a rep
   waits. Weigh that; don't inherit a wrapper from the sibling call site just
   because it has one.

   **✅ Group 2 shipped 2026-08-14** — `keypoints` + `assessment` +
   `battlecard`, branch `feat/adr-0006-cutover-group-2`. **Five** call sites
   moved onto `aiCall.generateStructured`: `knowledge/keypoints.js` ×3
   (`kb.keypoints`, `kb.companyAnalysis`, `kb.productAnalysis`, all resolving the
   one `keypoints` key) and `knowledge/assessment.js` ×2 (`kb.assessment` →
   `assessment`, `kb.battlecard` → `battlecard`). All three keys joined
   `DISPATCH_READY` in the same PR, which is now six keys and **nine** seam call
   sites wide (four from group 1). Membership is eligibility, not activation —
   every task still resolves to Gemini.

   *(The count is worth stating carefully because three separate comments got it
   wrong in the first cut, each in a different direction — "six call sites",
   "eleven in total" — from counting the functions that had to be edited rather
   than the `generateStructured` calls that resulted. `keypoints.js` is one key
   over three call sites, which is exactly where the two counts diverge. PR #54
   existed solely to repair drifted prose of this kind.)*

   > **⚠ SHIPPED ≠ FLIP-READY, and `battlecard` is the case in point.** The key
   > is eligible, so one env var moves it — and moving it today is measurably an
   > outage. See "The finding that stops `battlecard` flipping" below. Nothing in
   > this entry, and nothing in the smoke check, licenses setting
   > `AI_PROVIDER_BATTLECARD=anthropic`.

   - **The retry answer is the one this item predicted, on both sides, and it is
     now asserted rather than commented.** `extractCompetitiveAssessment` KEEPS
     `forLabel('assessment')`, wrapping the seam the way `relevance.js` does; it
     runs at ingest, and a transient 503 otherwise costs the document its
     scoreboard silently — the doc still ingests, `metadata.assessment` is simply
     absent. `extractBattlecard` still has **no** wrapper, so `aiRetry.POLICIES`
     gained no row. A test drives one transient failure through each and asserts
     2 attempts for the scorer and exactly 1 for the synthesis, because "we chose
     not to wrap it" is precisely the kind of claim this ADR has twice found
     living only in a comment.
   - **The three require-time `modelFor()` constants are gone**, not moved —
     `keypoints.js`'s `MODEL` and `assessment.js`'s `MODEL` /
     `BATTLECARD_MODEL`, the same freeze §9 item 4 fixed in `personas.js`.
     Pinned behaviourally: `GEMINI_KEYPOINTS_MODEL` is set *after* the module is
     required and the fake Gemini client is asserted to receive it.
   - **Nothing about a Gemini request moved**, which is the property the
     `anthropicTier` overrides exist to protect and the one a per-file diff
     cannot show, because the request is now assembled in `aiCall.js` from
     arguments spread across two other files. Asserted by driving the REAL seam
     into a fake Gemini client and comparing the whole `config` object per call
     site (`test/cutoverGroup2.test.js`, `[GEMINI-PARITY]`): same model, same
     `maxOutputTokens`, same `temperature`, same `thinkingConfig`, same schema
     object identity, for all five.
   - **Group 2 is the first cutover to put call sites on a NON-Haiku Claude
     tier**, and that has a consequence later groups should not rediscover:
     `keypoints` and `battlecard` carry `anthropicTier: 'flash'` →
     `claude-sonnet-5`, which is in `anthropic.js`'s `NO_TEMPERATURE` list. So
     after a flip their `temperature: 0.3` is dropped — with the
     once-per-model+site warning, not silently — while `assessment`'s `0.25`
     survives on Haiku 4.5. Determinism on those two has to come from the prompt.

     **That drop has named consumers, so it is not only a prose-quality
     question.** When a competitor's docs carry no per-doc assessment,
     `extractBattlecard`'s `!hasAggregate` branch takes `weightedAdvantage` from
     `parsed.axesScored` — numbers the model *samples* out of
     `BATTLECARD_SCHEMA`. On Sonnet 5 that figure is produced with no
     determinism control at all, and it surfaces in four places, none of which
     show that it came from inline scoring rather than from evidence:

     - the competitor detail page's lead/trail figure, thresholded at ±5 **by the
       frontend** (`web/admin/admin.js`);
     - `verdictByNode`, the offering-node chips on that same page;
     - the per-version figure in the battlecard **History drawer**, served by
       `portfolio.js`'s history route;
     - the **Markdown snapshot export**, which persists "We lead by 60%" back
       into the KB as a battlecard document — a sampling-derived number
       re-entering the corpus as evidence, where a later synthesis reads it as a
       fact about the matchup. That is the one worth pausing on.

     **Two corrections to an earlier draft of this note, because an inaccurate
     blast-radius map is itself the defect when documentation is the
     mitigation.** The **Market Map does not consume this number** — its
     colouring comes from `GET /portfolio/competitors/threats`, which
     regex-parses "Competing-threat level: N/5" out of intel text. And
     `renderAssessmentText`'s ±5 threshold reads `d.metadata.assessment`, the
     **per-doc** scoreboard produced by the `assessment` task, which keeps its
     temperature on Haiku 4.5 — a different field entirely. The drawer and the
     export were missing.

     Measured 2026-08-14: **1 of the 4 production battlecards that carry a model
     stamp is on that path** (`nightout`, rendering "+60%") — independently
     re-derived by querying for cards whose every axis has empty `evidence` and
     `gaps`, which is the signature the inline branch leaves.
   - **Existing rows: nothing to migrate, and the one field that can change is
     display-only.** No schema object changed, so every stored payload keeps its
     shape. The only value that moves is the `model` string stamped onto
     `kb_documents.metadata.companyAnalysis` / `.productAnalysis` and
     `competitors.battlecard`, which is now the SERVING model from the seam
     rather than a boot-time constant. All five readers render it as text and
     none branch on it. Precisely: **seven surfaces across two different stored
     fields** — the `companyAnalysis` / `productAnalysis` `ca-meta` lines are two
     surfaces over the keypoints field, and the battlecard field has five (the
     card's meta line, the Markdown export, the History drawer's per-version
     line, `portfolio.js`'s history route, and `watch.js` folding the record
     into a Market Watch prompt as prose). An earlier draft of this sentence said
     "five readers", merging the two fields; the per-file comments each had their
     own field right.

     **Three tables carry that field, not one** — the first cut of this entry
     named only `competitors.battlecard` and missed `competitor_battlecards` and
     `competitor_battlecard_history`, which store the same payload. Counted
     2026-08-14:

     | | staging | production |
     | --- | --- | --- |
     | `kb_documents` w/ companyAnalysis / productAnalysis / assessment | 3 / 5 / 15 | 4 / 2 / 16 |
     | `competitors` w/ a battlecard (of which `model: null`) | 14 (11) | 16 (12) |
     | `competitor_battlecards` | 2 | 2 |
     | `competitor_battlecard_history` | 5 | 6 |

     **And the stored values are already heterogeneous**, which strengthens the
     conclusion rather than weakening it: staging holds `gemini-2.5-flash-lite`,
     `gemini-2.5-flash` **and** `null` across those three tables — three distinct
     values coexisting today, with no reader branching on any of them. A fourth
     (a Claude id) is the same kind of value, not a new kind. The `null`s are
     the no-evidence early return, which has always written one.
   - Suite **359/359**, from **341** on `main` (+18 — 8 in the cutover file as
     first written, 10 more added across five review rounds; round 4 added
     `test/liveHarnessGates.test.js` ×2), with **fourteen**
     deliberate mutations of `src/` — the dropped key, a colliding telemetry
     label, each
     budget and temperature, the half-done cutover (`extractBattlecard` resolving
     `assessment`), the override that stops reaching the wire, both retry answers
     inverted, the constant-stamped model, both un-attributed failure lines,
     thinking turned back on, and the lost `anthropicTier` — each confirmed to
     fail the assertion it targets.
   - **Live-schema check, before and after**, per this item's runbook. Both
     clusters are named because `kb.battlecard` deliberately stays in the
     `assessment` cluster (see `test/live/schemas.js`), so `--cluster=assessment`
     is what the runbook tells this group to run:

     ```
     $ docker compose run --rm --no-deps -v "$PWD/api":/app -w /app \
         api node test/live/smoke.js --cluster=keypoints,assessment
     live-schema smoke: 5 schema(s) × anthropic

       ── assessment ────────────────────────────── [anthropic]
       ok       kb.assessment                      claude-haiku-4-5       accepted, output parses
       ok       kb.battlecard                      claude-sonnet-5        accepted, output parses
       ── keypoints ─────────────────────────────── [anthropic]
       ok       kb.keypoints                       claude-sonnet-5        accepted, output parses
       ok       kb.companyAnalysis                 claude-sonnet-5        accepted, output parses
       ok       kb.productAnalysis                 claude-sonnet-5        accepted, output parses

     5/5 accepted
     ```

     Byte-identical on `main` (before) and on the branch (after), exit 0 both
     times. That is the expected result rather than a coincidence — this PR
     touches no schema object — and running it twice is what makes the sentence
     evidence instead of an assumption. The 28/29 whole-registry figure above is
     unchanged; these five are five of the 28.

     **⚠ That "after" run was taken before `FLIP_BLOCKED` existed, and adding the
     gate broke the harness.** `smoke.js`'s `resolveFor()` lifted
     `DISPATCH_READY` for the task under test but not `FLIP_BLOCKED`, which
     `providerFor()` consults immediately afterwards — so the branch resolved
     four of these five entries back to `gemini-2.5-flash-lite` and **posted a
     Gemini model id to the Anthropic API**: `1/5 accepted, 4 errored`, four
     404s, exit 4, against `main`'s exit 0. Nothing in the output said "harness";
     it read as a provider outage. Two things are worth carrying forward from it.
     **First, the shape of the bug: a flip gate that disables the very check a
     flip PR must run to clear it** — and not only for this cluster, since a
     whole-registry run errored on all four for every future group. **Second, the
     process fact: the run was quoted from before the gate landed and nobody
     re-ran it**, which is the same "a fix is a claim until it is re-verified"
     failure the passes exist to catch. Fixed in round 3: both gates are lifted
     and restored, and a resolved model whose id family does not match the
     provider asked for now aborts as a **harness bug** (exit 2, nothing sent)
     rather than being sent and blamed on the provider. The block above is the
     re-run after that fix.

     **What that green does NOT say, and this entry originally invited the wrong
     reading of it.** `smoke.js` sends `effort: 'low'`, `max_tokens: 800` and
     **one sample per schema**; the production call sites send `effort: 'medium'`
     and their own budgets (2600 on the battlecard). Against the defect below —
     which appears ~2.5% of the time — one sample passes ~97.5% of the time, so
     "5/5 accepted" means *the provider accepted the schema*, which is what item
     3 was built to check, and says nothing about whether responses to the real
     request are usable. Read it as schema acceptance, never as flip-readiness.
     (This paragraph first said "~30% … a single sample passes ~70%"; the rate
     was wrong, and the argument it makes is *stronger* at the real rate, not
     weaker — one sample is even less able to see a 2.5% defect than a 30% one,
     so "read the green as schema acceptance, never as flip-readiness" holds
     harder, not less. Neither
     version sends a temperature: `claude-sonnet-5` is in `NO_TEMPERATURE`, so
     the production call sites' `0.3` is dropped before the wire in production
     too.)

   - **The live harness's own gate coverage, closed in round 5.**
     `test/liveHarnessGates.test.js` proves `smoke.js`'s `resolveFor()` lifts
     every router gate — but it was built from `DISPATCH_READY ∪ FLIP_BLOCKED`,
     6 tasks, while a run resolves every entry in `test/live/schemas.js`, **15
     distinct tasks**. Measured with a hypothetical third gate added to
     `providerFor()`: on `assessment` it was 0/2 and caught, on `discovery`
     2/2 and silent — and `personas`, the next cutover, was on the silent side.
     The list is now built from the schema registry as well. Two sibling
     defects fell out of re-running the mutants: `contextSeam.js`'s
     `prepareVia()` read the same gates *outside* its `try` (exit 4, "re-run",
     with `personas` left in `DISPATCH_READY` — where `smoke.js` under the
     identical mutation exits 2, "fix the script"), and `smoke.js`'s own
     `[flip-blocked]` marking called `FLIP_BLOCKED.has()` in `main()`, so the
     set going away — which the note at `models.js:168` explicitly anticipates
     — killed the whole run with a raw `TypeError` and lost every result
     already paid for.
   - **⚠ Known residual, for a follow-up PR: the exit-code contract has four
     prose homes and nothing pins them to each other or to `main()`.**
     `smoke.js`'s header, `contextSeam.js`'s header, `rules/commands.md`'s
     table, and this ADR — plus an inline restatement inside `smoke.js`'s own
     `main()`. It has already drifted once (`2` lost "or the harness itself is
     broken" for a round). A trip-wire was scoped in round 5 and **deliberately
     not built**: the three homes deliberately list *different* subsets
     (`commands.md` omits `0`, `contextSeam.js` omits `3`), and `main()` exits
     via a mix of `return N` and `process.exit(2)`, so any assertion needs a
     per-home expectation table hard-coded in the test — a **fourth home** of
     the same knowledge — behind regexes over comment formatting and source
     indentation. That is precisely the `[TEXTUAL]` guard class this repo has
     already watched be defeated twice by ordinary edits. Left as a known
     residual rather than shipped as a guard that reads stronger than it is.

   **The finding that stops `battlecard` flipping** (2026-08-14; first recorded
   by the integration pass, **corrected by the confidence pass — see the
   amendment below, which supersedes the original figure**). *(A bold lead-in
   rather than a heading: this sits inside item 5 of an ordered list, and an `h3`
   here outlines as a peer of §4.1.)*

   Driving `extractBattlecard` itself against the live API — the real call site,
   through `buildBattlecardPrompt` → `aiCall.generateStructured` →
   `models.resolve` → `anthropic.generate`, so `claude-sonnet-5`,
   `effort: 'medium'`, `max_tokens: 2600`, the real `BATTLECARD_SCHEMA` (4048
   chars translated), across **3 competitors and 2 tenants** — **2 of 80
   responses were unparseable JSON**:

   | measurement | how it was taken | n | unparseable |
   | --- | --- | --- | --- |
   | `BATTLECARD_SCHEMA`, production shape | through `extractBattlecard` | **80** | **2 (2.5%)** |
   | same schema, the original synthetic probe | `anthropic.generate()` direct, 302-char prompt | 19 | 0 |

   95% CI (Clopper–Pearson) on 2/80: **0.30% – 8.74%**.

   - **`stop_reason: end_turn`, not truncation** — so it is not a `max_tokens`
     sizing problem and raising the budget does not address it. The malformation
     caught at the production shape is a **stray token mid-object**:
     `output_tokens 2003`, `textLen 5714`, `Expected double-quoted property name
     in JSON at position 4323`.
   - **Not a `schemaCompat` bug.** The translated schema contains no construct
     Anthropic rejects — the provider accepts it, which is precisely why the
     smoke check is green. It is the **largest** translated schema in the group
     misbehaving under constrained decoding.
   - **It lands on the one site with no retry**, and that site is synchronous
     behind the rep-facing `POST
     /portfolio/competitors/:id/battlecard/regenerate`. A flip today means
     roughly **one regeneration in forty 502s**, per rep, per click, with no
     second attempt and a `[battlecard] synthesis failed on anthropic` line as
     the only trace — on a button whose entire purpose is to be pressed again.

   **⚠ AMENDMENT (2026-08-14, confidence pass): the figure this entry first
   carried — "3 of 10, driving the exact production request shape" — was wrong
   in both halves, and it is corrected in place above rather than footnoted.**
   Stating it plainly, because this is the third time in this ADR that prose has
   been more confident than the code or the measurement underneath it:

   - The "10 calls" was **three separate probes pooled** (1/3, 1/6, 1/1), each
     calling `anthropic.generate()` **directly** with one hard-coded **302-char
     synthetic prompt**, a fake `site: 'bc'` label and `costs.js` stubbed out —
     bypassing `extractBattlecard`, `buildBattlecardPrompt`,
     `aiCall.generateStructured` and `models.resolve`. The real prompt at this
     call site is **7,546–10,755 chars**. "The exact production request shape" was
     therefore false in the dimension that dominates the request.
   - It **does not reproduce**, at either shape: 2 of 80 through the real seam,
     and **0 of 19** completed calls on a re-run of the original synthetic probe.
     `P(≤2 | n=80, p=0.30) = 2.5 × 10⁻¹⁰`; even 10% is rejected (`p = 0.011`).
   - "**0 of 10** on the other four group-2 schemas" was **13 calls, not 40** —
     `ASSESSMENT` 4, `COMPANY_ANALYSIS` 4, `PRODUCT_ANALYSIS` 4, `KEYPOINTS` 1.
     The comparison is still directionally right; it was never the sample it
     claimed.
   - `temperature: 0.3` was cited as part of the shape, and is **never sent** on
     `claude-sonnet-5` — `NO_TEMPERATURE` drops it, in that probe and in
     production alike.

   **The block stands.** What was re-measured is the *rate*, not the *defect*:
   the character of the malformation is exactly as described (`end_turn`, mid-
   object, not truncation), and ~2.5% of regenerates returning a 502 on an
   un-retried, synchronous, rep-facing route is still a defect that should not
   ship. The "obvious remediation is inert" argument below is independently
   verified and unaffected.

   **This undercuts the stated basis of the no-retry decision, not the decision
   as shipped.** That argument was made against transient 503s — "a fast 502
   beats three attempts with backoff while a rep waits" — and it remains right
   for Gemini, which serves 100% of this traffic. The dominant Claude-side
   failure is a **stochastic malformed answer**, which a retry demonstrably
   fixes, and `assessment.js` already concedes exactly that for the Gemini side
   in its note on the parse moving inside `withRetry`. So the asymmetry is
   probably wrong for Claude and must be re-argued against *this* failure mode
   rather than re-quoted from the ADR.

   **⚠ THE OBVIOUS REMEDIATION IS INERT, AND IT FAILS GREEN.** This is the most
   important sentence in the entry, because the first draft of it recorded
   "add an `aiRetry.POLICIES.battlecard` row and wrap the call" as the plan.
   Driven through `forLabel('assessment')` with the measured malformation:
   `aiCall.parseAnswer` stamps the `SyntaxError` `provider: 'anthropic'` →
   `classify()` takes the Anthropic branch → `transient: !perDay && !sdkRetried
   && status === 429` → a parse error has no `status` → **`transient: false`, one
   attempt.** So a flip PR that follows that plan adds a row, wraps the call,
   watches a retry test go green, and ships the same 2.5% rate.

   Two corollaries that have to travel with it:

   - **The wrapper `extractCompetitiveAssessment` keeps is worth nothing against
     this mode on Claude either.** It protects the *Gemini* branch, where parse
     errors are unstamped and message-scraped. This is also why
     `cutoverGroup2.test.js`'s retry-asymmetry test cannot see the gap: it drives
     an unstamped, Gemini-shaped error.
   - **Any retry here has to fit inside nginx's 180s `proxy_read_timeout`.**
     Three attempts at `ANTHROPIC_TIMEOUT_MS` (120s) plus 2s+4s backoff is
     **366s**, which converts this call site's clean 502 into a 504 while the
     handler is still writing — the same shape §9 item 4 found on
     `proposals.js`.

   **What would actually have to change:** `classify()` treating an
   anthropic-stamped parse error as transient, and/or reshaping
   `BATTLECARD_SCHEMA` so it stops happening — within that 180s bound. (§4.7
   already establishes that this provider's structured output has schema-size
   failure modes nothing on the Gemini side bounds; this is a second, *softer*
   one: accepted, then unreliable.)

   **Deferred to the flip PR deliberately, not to a backlog.** Doing it in the
   cutover PR would reverse the decision that PR documents and add a second
   reviewable concern to it. And the deferral is enforced rather than advised:
   `battlecard` is in **`models.FLIP_BLOCKED`**, so `providerFor()` refuses
   `AI_PROVIDER_BATTLECARD=anthropic`, falls back to Gemini and warns with the
   2-in-80 number. A warning alone would not have been a gate — an operator
   following the runbook sets the variable and moves on.

   **To clear the block:** a fix, *and* **0 unparseable in ≥100 calls driven
   through `extractBattlecard`** at this shape. Not n=10 — n=10 cannot tell 2.5%
   from 0 (it passes 77% of the time at the measured rate), which is precisely
   how the original figure came to be believed and then disbelieved.

   **Method note for later groups, which is the transferable part** — and it is
   the *corrected* method, because the first version of this note generalised the
   one that failed here:

   - **Drive the real call site through the seam, not the SDK.** The original
     probe called `anthropic.generate()` directly with a 302-char prompt and
     reported it as "the exact production request shape"; the real prompt was
     ~25–35× longer, and the rate it produced was off by ~12×. Everything between
     the call site and the wire — prompt assembly, `models.resolve`, the seam's
     own defaults — is part of the shape.
   - **Size the sample to the rate you need to distinguish**, and say which rate
     that is. A one-in-forty defect is invisible at n=10 and unmistakable at
     n≥100; quoting a proportion whose denominator is smaller than 1/rate is
     quoting noise. Pool nothing across probes without saying so.
   - Item 3's registry remains a *schema acceptance* harness by construction (one
     sample, minimal shape) and cannot substitute for either of the above.

   Any group whose schemas are large, or whose call site is synchronous and
   un-retried, needs the production shape sampled this way before its flip — and
   `proposals` (§4.7) is the next one that fits that description.

   **A second flip blocker, on the sibling key** (2026-08-14, per-file review;
   **evidence replaced by the confidence pass — see the amendment below**).
   `keypoints` is blocked too, for an unrelated and previously unseen reason:
   **the 2200-token output budgets at `extractCompanyAnalysis` and
   `extractProductAnalysis` are Gemini-sized and truncate on Sonnet 5.**

   Measured at the **shipped call-site shape** (`maxTokens: 2200`,
   `allowTruncation` unset):

   | document | body | call site | n | result |
   | --- | --- | --- | --- | --- |
   | `91bfba3e-a001-451e-87df-985a6a468395` "Wibmo — homepage" (stored `companyAnalysis` 4,297 chars) | 10,685 | `kb.companyAnalysis` | 5 | **5/5 `max_tokens` → throws → `null`** |
   | `b89b311f…` "[Trend] CBN MFA mandate" | 3,263 | `kb.companyAnalysis` | 3 | 3/3 `end_turn`, 1,145–1,175 tok |
   | `e58527cc…` "Wibmo_Payment gateway" | 14,244 | `kb.productAnalysis` | 3 | 3/3 `end_turn`, 1,576–1,871 tok |

   **⚠ AMENDMENT (2026-08-14, confidence pass): the evidence this entry was first
   written on was invalid in kind, and it named a document that passes.** The
   original argument read staging's largest **stored** `companyAnalysis` — 6,438
   chars, *a Gemini output* — through §5.2's 1.74–1.88× density to "≈ 2,660–3,460
   output tokens against a 2,200 budget". That conversion has no basis: output
   length is driven by the **source body** and the schema, not by what a
   different model once wrote about the same document. Sonnet's answer for that
   very document is ~1,150 tokens and completes **9 of 9**. The block is real,
   but for a different document than the one recorded — and the exit criterion
   built on the recorded one *already passed on the cutover branch*, so the first
   flip PR to honour it would have deleted the gate with the defect untouched.
   `kb.productAnalysis` is likewise **not observed to truncate** (15/15
   `end_turn`, peak 1,871 of 2,200) — close enough to the budget that "safe" is
   the wrong word, but it is not what reproduces.

   **The failure path used to delete stored intelligence rather than erroring** —
   observed end to end, not inferred, and **fixed on 2026-08-14 in
   `fix/kb-keypoints-refresh-data-loss` (PR #57), which is a separate concern
   from this migration and is therefore a separate PR rather than part of a
   cutover.** Driving the real
   `knowledge/service.js` → `keypoints.js` → `aiCall` → `anthropic` path against
   the live API on `91bfba3e…` (only `db.js` and `redis.js` faked, seeded from
   the real staging row, nothing written back): the route answered
   **`{ ok: true }`** while the stored **4,297-char** `companyAnalysis` was
   **deleted**.
   *(This paragraph said 4,209 and the table above says 4,297. **Both counts are
   real**, and the earlier note here — "for the same stored string" — had the
   explanation wrong, which is what made the discrepancy read as drift.
   `metadata->'companyAnalysis'` is a jsonb **object**, 9 top-level keys, not a
   string. Postgres's jsonb→text output pads a space after each of its 88
   structural `:`/`,` separators; Node's `JSON.stringify` is compact; and
   4,297 − 4,209 = **88** exactly. One measurement, two serializations. The
   figure both places use is **4,297**, the DB's own
   `length(metadata->>'companyAnalysis')`, which is what the table above quotes.)*

   **The mechanism, as it then was — the chain is broken at the third arrow: the
   strict forms throw instead of swallowing, so a `null` that reaches the `else
   delete` now means the document genuinely has none. The last step therefore no
   longer happens, but the code that performed it is unchanged and still reads
   exactly as written below:** `stop_reason: 'max_tokens'` with `allowTruncation`
   unset (these call sites passed nothing) → `anthropic.generate` threw →
   `extractCompanyAnalysis` caught it and returned `null` →
   `knowledge/service.js`'s regenerate path
   `if (analysis) md.companyAnalysis = analysis; else delete md.companyAnalysis`
   → **the good stored analysis was deleted and the route still answered
   `{ ok: true }`.** On ingest it was simply never written; `portfolio.js`'s
   company-profile draft 502'd instead — that half is unchanged, and correct.

   **What the fix changed, and what it deliberately did not.** The deletion was
   never the truncation — it was the last arrow: `else delete` reading a
   *swallowed error* as "this document has none", which is why it was live on
   **Gemini** too and Claude would only have made it frequent. Each extractor now
   exists in two forms: the historical never-throws one (still what **ingest**
   calls, where the failure costs a missing field on a row that does not exist
   yet) and a `*Strict` sibling that throws, so `null` / `[]` from it means the
   document genuinely has none — and only that. `regenerateKeyPoints` calls the
   strict forms, attempts each field independently (partial failure is the normal
   case: `keyPoints` and `companyAnalysis` are separate calls), keeps the stored
   value on a failure, and returns `{ document, refreshFailures }`, which the
   route surfaces as `refreshFailures: [{ field, provider }]` on an otherwise
   unchanged 200. **The provider's own error text is not in that body** — it is
   the upstream SDK string (raw provider JSON carrying quota metric and project
   identifiers on a 429; a fragment of the model's answer on a parse failure),
   the rep can do nothing with it, and the response is rendered in a browser. It
   goes to the api log instead. **The scope/category-driven clears were kept
   untouched** — they are how a re-tagged doc sheds a stale key and are not model
   results.

   **The same defect class, arriving as a success.** Review of the fix found the
   overwrite still open in three places where the call returns 200 with nothing
   usable in it — worse than the throw case, because `refreshFailures` is `[]`
   and nothing records it. All three are closed **in the strict forms only**, so
   ingest still swallows, which is correct where nothing is stored yet — with one
   consequence that does reach ingest, named here rather than glossed: a
   degenerate assessment answer now stores **no** `assessment` key on the new row
   where it used to store a blank all-unknown one. That is the better of the two
   — `extractBattlecard` averages these per-doc scoreboards and a fake all-zero
   card dragged the aggregate toward a verdict nobody made — which is exactly why
   it could have gone unremarked. The changes themselves:
   `extractKeyPointsStrict` throws when the answer carries no `points` array
   (`required` in the schema, and it was coerced to `[]` — the exact value that
   means "this document genuinely has none"); `extractCompetitiveAssessmentStrict`
   throws when `normalize()` produced a scoreboard with no axis scored *and* no
   summary, which it cannot signal itself because it fills all 8 axes with
   unknown/0 placeholders for UI shape stability and so returns a
   complete-*looking*, confident, all-zero card — and `extractBattlecard`
   averages these per-doc, so one blanked doc degrades the battlecard too.

   **One prompt DID move, deliberately.** `regenerateKeyPoints` never read
   `metadata.appliesToProductIds`, which ingest resolves to product names and
   passes as `appliesProductNames` to restrict `ourScore` to the products a
   battlecard is filed against. So a rep clicking *↻ refresh analysis* on a
   product-scoped card had its axes silently replaced with portfolio-wide ones,
   with the metadata — and the label built on it — still saying product-scoped.
   Refresh now resolves it with the same query ingest uses. **Gemini parity is
   unaffected**: ingest is untouched, and the refresh path's prompt changes only
   for product-scoped battlecards, and changes to what that same document already
   receives on ingest. Nothing else about what either provider receives moved: no
   schema, `maxTokens` or temperature change anywhere.

   **Deferred, and recorded rather than fixed:** the concurrent whole-column
   read-modify-write these writers share — §10.

   **This entry stays.** What is left after the fix is still a block: a flip makes
   `kb.companyAnalysis` refreshes on a body this size fail **5 times out of 5**,
   so the rep presses "refresh analysis", the stored analysis survives and never
   updates, and the correction is a warning after the fact. The exit criterion
   below is unchanged, because what it measures is the truncation — only the
   severity moved.

   **The evidence in this entry structurally could not see it**, and that is the
   same argument this ADR makes about `battlecard`, turned on the sibling key:
   `smoke.js` sends `max_tokens: 800`, its recorded runs produced ~12-token
   answers (read back out of the `usage_costs` rows §9 item 1's instrumentation
   writes), and `smoke.js` reports a truncated response as **`accepted`**.

   **Do not fix this by raising `maxTokens`.** The value is provider-agnostic at
   that call site, so raising it changes what *Gemini* receives and breaks the
   parity property group 2 shipped on. Sizing per provider is the flip PR's
   problem. **To clear the block:** live `kb.companyAnalysis` calls at
   `maxTokens: 2200` against document **`91bfba3e-a001-451e-87df-985a6a468395`**
   — the one that reproduces — showing `stop_reason: 'end_turn'`. **Repeated, not
   one:** the measurement is 5 of 5, so a single `end_turn` is not evidence the
   budget is adequate. Do not re-point this criterion at the 6,438-char document;
   that is the mistake this entry already made once.

   **`FLIP_BLOCKED` is the mechanism both of these use, and it is a second set on
   purpose.** `DISPATCH_READY` is a claim about the *code* — this call site reads
   `resolve().provider` and branches — verifiable by reading the file and pinned
   by two tests. Whether a flip is a good idea is a claim about a *measurement*
   against a live provider, which can stop being true with no code change at all.
   Folding the second into the first would make membership mean two things and
   leave the migration unable to state either honestly, so `battlecard` and
   `keypoints` stay in `DISPATCH_READY` (they are migrated; that is a fact) and
   sit in `FLIP_BLOCKED` (they are unsafe; that is a measurement). **A key leaves
   `FLIP_BLOCKED` in the PR that fixes or measures away its reason**, exactly as
   keys join `DISPATCH_READY` in the PR that migrates their call site — and each
   entry carries the evidence that would have to be produced to delete it.

      **One inherited defect left alone, recorded so it is not re-found as new.**
   The `providerOf(err) → 'unknown'` idiom (group 1's, now in five more places)
   claims that `unknown` means "a missing stamp to go and add". On today's
   100%-Gemini traffic it is the *common* case instead: raw `@google/genai`
   errors carry no `provider`, so a genuine Gemini outage logs `failed on
   unknown` and the comment reads backwards. It is group 1's to fix — stamping
   at the Gemini branch of `aiCall`, one line — and it is a separate PR because
   it changes the log line on every migrated fail-open path at once.

   **✅ Group 3 shipped 2026-08-28 — the `research` HALF ONLY.** Branch
   `feat/adr-0006-cutover-group-3-research`. **ONE** call site moved onto
   `aiCall.generateStructured`: `knowledge/research.js`'s `analyze()`
   (`research.analyze` → task `research`). That is one `generateStructured`
   call, in one function, under one key — the count is stated that way because
   three separate comments got it wrong in group 2 by counting the *functions*
   edited. `research` joined `DISPATCH_READY` in the same PR, which is now
   **seven** keys and **ten** seam call sites wide (four from group 1, five from
   group 2, one from group 3). Membership is eligibility, not activation: every
   task still resolves to Gemini, and `AI_PROVIDER_RESEARCH` is unset in every
   environment.

   **GROUP 3 WAS SPLIT, AND THE `ocr` HALF IS DEFERRED TO ITS OWN DECISION PR.**
   This item lists the group as "`research` + `ocr`", written before either file
   had been read against the seam. They are not the same kind of work, and
   bundling them would have put a decision inside a cutover:

   - **There is no `ocr` task key.** `knowledge/ocr.js` does not appear in
     `models.TASKS` at all, so nothing routes it, nothing can flip it, and there
     is no `AI_PROVIDER_OCR`. Adding the key is itself the decision.
   - **It pins its Gemini tier by hand and says why** — `OCR_MODEL =
     process.env.GEMINI_OCR_MODEL || TIERS.gemini.flash`, with a comment stating
     that OCR is deliberately outside the task router. Every key in groups 1–3
     takes its tier *from* the router; this one reaches around it.
   - **It is free text, not structured output.** `aiCall.generateStructured` is
     a one-prompt-in, one-schema-shaped-JSON-out seam; OCR has no
     `responseSchema`. So the §9 item 3 live harness — the only thing in this
     migration that catches a provider rejecting a request before a flip —
     **structurally cannot cover it**, and the argument every other group's
     "run `--cluster=` before and after" line rests on is unavailable here.
   - **`ocrViaFilesApi` has no equivalent in `anthropic.js`.** It uploads to
     Google's Files API and polls `PROCESSING → ACTIVE`; Claude takes documents
     as inline blocks. §7 already lists that polling loop as something the
     migration *deletes*, which is a rewrite, not a swap.

   The likely outcome is the one §4.2 records for embeddings — **OCR stays on
   Gemini indefinitely** — and that is a decision with its own ADR-shaped
   argument, not a cutover. Recorded here so the split is visible rather than
   inferred from a group that shipped half-done; `models.js` carries the same
   note next to the group-3 register, and `cutoverGroup3.test.js` asserts that no
   `ocr` key exists, so "deferred" cannot quietly become "forgotten".

   - **The retry answer is KEPT, and it is the first one in this migration that
     is about two ROUTES rather than two call sites.** `analyze()` keeps
     `aiRetry.forLabel('research')` on the default policy (3 attempts, 30s
     backoff cap; `POLICIES.research` is unchanged and still `{}`). What is new
     is the asymmetry this item did not previously record: **one function, one
     label, two opposite latency contracts.** `POST /research/:companyId`
     (`knowledge/index.js:247`) is fire-and-forget — 202, work in the background,
     the research unit **pre-charged on admission**, so a transient failure that
     is not retried spends a metered unit and leaves a `FAILED` row. `POST
     /research/:companyId/reanalyze` (`:271`) is **SYNCHRONOUS**, rep-facing and
     un-metered, behind nginx's 180s `proxy_read_timeout` — the shape PR #51
     found on `proposals.js`.

     The decision was made against measurement rather than inherited. **Measured
     2026-08-28, driving this call site end to end:** `gemini-2.5-flash` answers
     it in p50 **5.6s**, max **6.0s** (n=10) — so the synchronous route's worst
     case at 3 attempts is 3 × 6s plus the sleeps, and the sleeps are 2s + 4s
     unless Gemini's own error body suggests a longer delay, in which case the
     30s cap gives **~78s** total. That fits 180s with room, so lowering the cap
     the way `proposals.js` did would bound this route *and* cost the background
     route its ability to honour a quota hint — for a bound that is not being
     exceeded. **The trigger that would change it is stated at the call site**: a
     single Gemini attempt averaging more than ~40s stops fitting.

     **And the Claude side does not multiply, which is the part that looks
     alarming and is not.** 3 × `ANTHROPIC_TIMEOUT_MS` (120s) would be 366s, well
     past 180s. It does not happen because `classify()`'s Anthropic branch is
     `transient: !perDay && !sdkRetried && status === 429`, so after a flip this
     wrapper is effectively one attempt. §7 records that as closed;
     `cutoverGroup3.test.js` now **asserts** it, driving both failures this call
     site can actually produce on Claude — a truncation (502, `truncated`) and a
     malformed answer (a seam-stamped `SyntaxError`) — through the real seam, and
     confirming one upstream request each. That is the load-bearing half of the
     180s argument, and quoting it from prose is exactly what this ADR has twice
     been burned by.

     **One live behaviour change comes free with the seam, and it is on Gemini.**
     `JSON.parse` used to sit *outside* `withRetry`; the seam parses *inside*
     `generateStructured`, which is inside the wrapper. So a Gemini answer whose
     first ten characters match `GEMINI_TRANSIENT_RE` (V8's `SyntaxError` quotes
     exactly ten) now costs up to three metered generations instead of one, and
     in exchange a regeneration can fix malformed JSON. It is the same trade
     `relevance.js` made and `aiCall.js`'s header documents; on Claude it changes
     nothing.

   - **The require-time `modelFor()` constant is gone** — `research.js`'s
     `MODEL`, the fourth instance of the freeze §9 item 4 fixed in `personas.js`
     and group 2 fixed twice more. Pinned BEHAVIOURALLY, not by reading a
     constant: `GEMINI_RESEARCH_MODEL` is set *after* the module was required and
     the fake Gemini client is asserted to receive it.

   - **Nothing about a Gemini request moved**, and `research` needed no
     `anthropicTier` to keep that true — tier `flash` already resolves to
     `claude-sonnet-5`, which is the model §4.1 assigns this task, so the Claude
     side needed no correction and the Gemini side was not touched. Asserted by
     driving the REAL seam into a fake Gemini client and comparing the whole
     `config` object (`test/cutoverGroup3.test.js`, `[GEMINI-PARITY]`): same
     model, same `maxOutputTokens` (2600), same `temperature` (0.3), same
     `thinkingConfig`, same schema object identity.

     `claude-sonnet-5` is in `NO_TEMPERATURE`, so after a flip this call site's
     `0.3` is dropped with the once-per-model+site warning — observed on every
     probe run below. **Three** of the seven migrated keys now land on Sonnet 5
     (`keypoints`, `battlecard`, `research`); the other four are Haiku 4.5. And
     unlike `battlecard` there is no sampling-derived NUMBER downstream here:
     `research`'s output is prose plus a `strength` enum, and
     `semantics.keepCitations` post-filters the citations against what the
     dossier actually showed the model.

   - **THE OUTPUT BUDGET WAS MEASURED BEFORE THE KEY SHIPPED, because a
     Gemini-sized budget is what put `keypoints` into `FLIP_BLOCKED`.**
     `maxTokens: 2600` is the largest ask of any group so far —
     `ANALYSIS_SCHEMA` wants a summary plus up to 8 opportunities, each a
     headline, 2–4 sentences of reasoning, a product list and citations.

     Method per this item's own note: the REAL call site through the seam, not
     `anthropic.generate()` with a synthetic prompt. The probe drove
     `research.reanalyze()` → `effectiveDossier` → `analyze()` →
     `aiCall.generateStructured` → `models.resolve` → `anthropic.generate`
     against the live API, with **only writes suppressed** (`db` UPDATE/INSERT
     no-oped, `service.ingest` no-oped); every read was the real database, and
     the prompts were the real ones — **45,747–50,939 chars, 19,365–22,641 input
     tokens**, i.e. ~150× the 302-char probe that produced group 2's ~12×-wrong
     rate.

     | dossier (all four that exist) | env | prompt chars | n | truncated | peak output tokens |
     | --- | --- | --- | --- | --- | --- |
     | Wibmo (`4183b2c3…`) | staging | 45,747 | 29 | **0** | 861 |
     | Ecobank (`539917ec…`) | production | 50,939 | 29 | **0** | 2,041 |
     | Justpalm (`4243d431…`) | production | 47,346 | 29 | **0** | 1,138 |
     | Papss card (`b27cdf8a…`) | production | 47,313 | 54 | **0** | **2,406** |
     | **pooled** | | | **141** | **0** | |

     Every one of the 141 responses came back `stop_reason: 'end_turn'`. 95% CI
     (Clopper–Pearson) on 0/141 is **0% – 2.58%**; on the worst single dossier
     (0/54) it is 0% – 6.60%. **`research` is therefore NOT added to
     `FLIP_BLOCKED`**, and the entry that would have gone there does not exist
     rather than being written and softened.

     **Two things about that zero are worth carrying forward, and neither is
     "it's fine".** First, **the headroom is thin**: peak output is 2,406 of
     2,600, i.e. **92.5%** of the budget, and it is 92.5% on a production
     dossier, not a contrived one. Second, **output length is dossier-driven and
     varies ~20× across four prompts of near-identical size** (861 / 2,041 /
     1,138 / 2,406) — it tracks how many opportunities the material supports, not
     how long the material is, which is why the input side being pinned at
     `DOSSIER_CAP` (40,000 chars) bounds nothing. A richer dossier than any that
     exists today is the way this starts truncating, and on Claude a truncation
     THROWS (`allowTruncation` unset, deliberately): a `FAILED` run with a spent
     pre-charged unit on the background route, a 502 on the synchronous one.

     **The population is small and that is a real limit on the claim.** n=141 is
     the right denominator for a ~2% rate, but it covers **four** prompts,
     because four is every prospect dossier in staging and production combined.
     This measures the truncation rate *for the dossiers we have*, and says less
     than it looks about the ones we don't.

     **Do not raise `maxTokens` if this starts truncating** — same rule
     `models.js` states for `keypoints`. The value is provider-agnostic at this
     call site, so raising it changes what Gemini receives and breaks the parity
     property groups 2 and 3 shipped on. Sizing per provider is the flip PR's.

   - **Existing rows: `prospect_research.models` is the only stored field that
     moves, and the frontend DOES read that column — just not the key that
     moved.** Both writers (`run()` and `reanalyze()`) stamp
     `{ analysis, hadPortfolio, usage }` into that `jsonb` column (plus
     `reanalyzed: true` on the second). Only `analysis` changes: it is now the
     SERVING model handed back by the seam rather than the boot-time constant.

     **The "nothing in `web/` reads that column" premise this PR started from was
     wrong, and the correction is the interesting part.** `grep -rn "models"
     web/` returns one live reader — `web/admin/admin.js:9725`,
     `r.models && r.models.hadPortfolio === false`, which renders the "no product
     portfolio on file" hint on the research panel. It reads a SIBLING key in the
     same object, `hadPortfolio`, which is `!!context` before and after and is
     written by the same statement it always was. Nothing reads `.analysis` or
     `.usage`, in `web/` or in `api/`. So the column is consumed, the changed key
     is not, and the object is still written whole with the same key set — which
     is why nothing has to migrate. Had the writer been narrowed to just the key
     that changed, that hint would have gone silently missing.

     Counted 2026-08-28: **17 rows on staging, 44 on production**; of those, **1
     and 3** carry a `models.analysis` stamp (the rest are runs that failed
     before reaching the model, which have always written a `models` object
     without one). The only stamp value present in either database is
     `gemini-2.5-flash`. A Claude id after a flip is the same kind of value, not
     a new kind, and `null`/absent is already a value both readers cope with.

     `models.usage` DOES change shape after a flip — Gemini's `usageMetadata`
     (`promptTokenCount` / `candidatesTokenCount`) versus Claude's
     `input_tokens` / `output_tokens` / `cache_*`. Nothing reads it; the real
     spend record is `usage_costs`, which `costs.recordClaude` writes with the
     provider-correct arithmetic. Recorded rather than glossed, because "a field
     that changed shape and its readers" is precisely what a per-file pass
     cannot see.

   - Suite **399/399**, from **390** on `main` (+9, all in
     `test/cutoverGroup3.test.js`), with **nineteen** deliberate mutations of
     `src/` each confirmed to redden the assertion it targets: the dropped
     `DISPATCH_READY` entry, an invented `FLIP_BLOCKED` entry, an `ocr` task key
     appearing, `compare` wrongly declared ready, the wrong task key at the call
     site, a drifted telemetry label, the output budget, the temperature, the
     `tenantId`, `effort` decoupled from the seam default, `allowTruncation`
     turned on, the schema passed as a copy, thinking turned back on, the
     `thinkingBudget` value, a per-task model override that can no longer reach
     the wire, the stored stamp taken from the router instead of the answer, the
     retry wrapper stood down, an Anthropic failure made app-retryable, the
     seam's own error stamp removed, `anthropicTier: 'lite'` demoting the task to
     Haiku, the seam's default effort dropped to `low`, and the prose call-site
     count in `anthropic.js`'s header set back to nine.

   - **Live-schema check, before and after**, per this item's runbook:

     ```
     $ docker compose run --rm --no-deps -v "$PWD/api":/app -w /app \
         api node test/live/smoke.js --cluster=research
     live-schema smoke: 1 schema(s) × anthropic

       ── research ──────────────────────────────── [anthropic]
       ok       research.analyze                   claude-sonnet-5        accepted, output parses

     1/1 accepted
     ```

     Byte-identical on `main` (before) and on the branch (after), exit 0 both
     times — expected, since this PR touches no schema object, and run twice so
     the sentence is evidence rather than an assumption. Read it as **schema
     acceptance only**: `smoke.js` sends `effort: 'low'`, `max_tokens: 800` and
     one sample, while this call site sends `effort: 'medium'` and 2600. The
     n=141 probe above is what speaks to flip-readiness, and it is a separate
     instrument for exactly that reason.

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

- **`kb_documents.metadata` is written as a whole column by three writers that
  each snapshot it first** (raised 2026-08-14, PR #57 review; **deliberately not
  fixed there** — that PR is a data-loss fix, and this is a concurrency
  redesign). `knowledge/service.js#regenerateKeyPoints` reads `metadata`, makes
  up to **four model calls** — tens of seconds — and writes the whole object
  back; `#confirmRelevance` does the same read-modify-write; `portfolio.js:808`
  does an atomic `metadata - 'competitorProductId'` in SQL. Last writer wins on
  the *whole column*, so a concurrent write to an unrelated key is reverted.
  Two concrete one-rep losses, both silent:
  - a refresh started before a `confirmRelevance` finishes reinstates
    `relevanceVerified: false` — the doc drops back into quarantine and out of
    the main-intel gate and battlecard synthesis, with nothing said;
  - a refresh that started before an offering was deleted resurrects the
    `competitorProductId` that `portfolio.js`'s jsonb-minus just removed, and
    the doc becomes invisible to the gate that filters on it.
  A double-click on refresh can also let the older run's analysis land on top of
  the newer one's. The real fix is `SELECT … FOR UPDATE` inside a transaction
  around read-and-write, or a targeted per-key jsonb merge (`metadata ||
  jsonb_build_object(...)` plus explicit `-` for the clears) so each writer only
  touches its own keys. The three call sites carry a comment pointing here.
- **Two more from the same PR #57 review, neither in scope there:**
  `knowledge/research.js:579` — `effectiveDossier` swallows a KB read failure and
  returns the bare dossier, so a **genuinely successful** synthesis on thinner
  input overwrites good stored research: degradation-by-swallow, the same
  200-and-data-gone outcome as the defect that PR fixed, one layer up. And
  `knowledge/index.js`'s `POST /documents/:id/keypoints` is **unmetered and
  unrestricted** while triggering up to four model calls per click, unlike every
  other rep-facing generate path.

- **Measure the engagement path's real prompt mix, per leg** (raised
  2026-08-05 — the highest-value measurement left, ahead of the output question
  below). **Pro extra seat currently fails scenario B at 34.4%** on the measured
  transcript ratio of 1.32, and its verdict is gated on two numbers §5.2 never
  measured: that ratio (it clears the floor only below 1.27) and the engagement
  input share (it clears only above 0.90, against an assumed 0.75). §5.2's own
  build-up splits engagement into four legs across three tiers, and at least one
  — the pre-call brief — is dossier prose at ~1.70, not transcript. Treating the
  unit as uniformly transcript-borne is the same "in principle" reasoning that
  produced the +30% allowance. Assemble the real Stage-0/1/2 and brief prompts
  and count them per tier.
- **Were output token counts under-allowanced too?** (Raised 2026-08-05 with
  the §5.2 tokenizer correction.) A denser
  tokenizer inflates generated tokens for the same answer text exactly as it
  does prompt tokens, and §5.2 applied its allowance to input only. Lines whose
  output figure came from a `max_tokens` cap are already in Claude tokens and
  are fine; lines derived from observed *Gemini* output tokens are understated
  by that unit's ratio. §5.2 does not record which source each line used.
  §6 scenario B prices the pessimistic reading: it costs Pro base a further
  **~830bps**, and it is what puts Pro extra seat below the floor at all —
  that line clears under A (36.1%) and fails under B (34.4%) at the same
  engagement ratio. So this question and the prompt-mix one above are jointly,
  not separately, decisive for that verdict. Answerable by re-deriving §5.2 from the
  prompt builders in code, not from `usage_costs`, which stores counts and
  never prompt text.
- **Engagement and Arena input-share are assumed, not measured** (0.75 / 0.50
  in §6). They are the widest source of error in the corrected table, and
  `usage_costs` cannot supply them until those paths run on Claude. Until then
  treat §6's engagement and arena contributions as the soft numbers.
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
   `anthropic.generate()` takes a multi-turn conversation as of §9 item 4, but
   it still sends no `tools` and does not handle `pause_turn` — multi-turn is
   not the agentic loop. This should be a separate `runWithTools()` rather than
   growing `generate()`, so the cheap path stays cheap to reason about.
4. At least two weeks of measured watch spend to compare against.

**Then decide on evidence:** A/B agentic vs the Brave + Firecrawl pipeline on
findings quality *and* cost together, and only adopt if both improve. If it
wins, `discovery.gatherFromQueries`, the Brave client and the Firecrawl scrape
path can retire with it — a maintenance argument as well as a quality one.

Its own ADR when the time comes: it changes the cost model, the failure modes
and the review-queue semantics simultaneously.
