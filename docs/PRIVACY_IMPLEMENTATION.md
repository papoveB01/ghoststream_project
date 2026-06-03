# Lili — Privacy Layer Implementation

> **Status:** Layers 1–3 shipped on `desktop-dev`; local activity log + cloud
> sync shipped (Phase 2a/2b). Backend ingest endpoint (Phase 1) staged for deploy.
> **Spec of record:** `docs/Lili_Privacy_Layer_Rev_1_2.pdf` (+ Rev 1.2.1 amendment),
> `docs/DESKTOP_TO_BACKEND_PRIVACY_LAYER.md`, `docs/DESKTOP_TO_BACKEND_PRIVACY_ACTIVITY.md`.
> **Code:** `client/src/privacy/` (+ tool boundary in `client/src/tools/index.js`,
> turn wiring in `client/src/agent/loop.js`).

---

## 1. What problem this solves

Lili sends user speech/text to a cloud model (Claude) and to cloud tools
(Gmail, Calendar, Drive, Slack, web search, etc.). The privacy layer makes sure
**sensitive values are detected, replaced with opaque placeholders before they
leave the device, and restored only where it's safe to do so** — without
degrading the model's ability to reason about the conversation.

The core trick: a **per-conversation substitution map**. We swap real values for
distinctive tokens on the way *out*, and reverse the swap on the way *back in*,
so Claude sees `《§EM001§》` instead of `jane@acme.com` but the user only ever
sees `jane@acme.com`.

### The placeholder format

```
《§<TYPE><INDEX>§》     e.g.  《§CC001§》  《§EM003§》  《§P001§》
```

CJK double angle brackets (`《》`, U+300A/B) + section sign (`§`, U+00A7) + a short
type code + zero-padded index. These were chosen because they tokenize as
compact, distinctive units across cloud providers and are extremely unlikely to
occur in real user content or be invented by the model. The same value always
maps to the same placeholder within a conversation (stable dedup), so the model
can reason about "the same person" across turns.

---

## 2. The three detection layers

All three feed a single overlap-resolution pass (`recognizers/index.js`
`detectAll()`), which sorts matches by position and keeps the longer/more
specific match on overlap. Every match carries `{ type, start, end, value, origin }`
so the rest of the pipeline is layer-agnostic.

### Layer 1 — Structured PII recognizers (regex)
`client/src/privacy/recognizers/`

Fast, deterministic pattern matchers, run most-specific-first so a long token
can't be partially matched as something looser:

| Recognizer | Type code | Severity |
|---|---|---|
| API keys / tokens | `AK` | high |
| Credit cards | `CC` | high |
| Social Security numbers | `SSN` | high |
| AWS ARNs | `AWS` | high |
| DB connection strings | `DBC` | high |
| Email addresses | `EM` | medium |
| Phone numbers | `PH` | medium |
| IP addresses | `IP` | medium |
| Env-var references | `ENV` | medium |
| URLs | `URL` | low |
| GitHub paths | `GH` | low |

### Layer 2 — Named-Entity Recognition (local ML)
`client/src/privacy/nerLayer2.js`

Catches person / organization / place names that regex can't. Runs **locally on
CPU** via `transformers.js` with the quantized (`q8`) ONNX build of
`Xenova/bert-base-NER` (~50 MB, cached to `userData/models`).

- Maps CoNLL labels → our codes: `PER→P`, `ORG→ORG`, `LOC→GPE`. `MISC` is
  intentionally dropped (too noisy).
- Confidence floor of **0.85**.
- Custom token-aggregation pass (not the library's `simple` mode) so
  subword-tokenized non-English names like "Ramy Molosa" don't get split.
- **Non-blocking:** the model downloads/loads asynchronously at boot
  (`preload()`); until ready, `detect()` returns `[]` and turns still get
  Layer 1 + Layer 3 protection.

### Layer 3 — User-curated sensitivity dictionary (encrypted)
`client/src/privacy/dictionary.js`

Strings the user explicitly marks private — client names, codenames, project
labels, counterparties.

- **Encrypted at rest** with AES-256-GCM. The key is a 32-byte device key stored
  in the OS keychain via `keytar` (service `AVOA`, account `dictionary-key`);
  falls back to in-memory if keytar is unavailable. On-disk file:
  `dictionary.dat`.
- Type codes: `CUST` (unclassified), `ORG`, `P`, `GPE`, `CODE`, `DEAL`.
- **Alias collapsing:** all aliases of one entry share a `canonicalKey`, so any
  variant the user types maps to the same placeholder, and restore always emits
  the **canonical** form (Lili replies using the "official" name even if the
  user typed a variant).
- On-disk format matches the backend dictionary-blob spec so a future passphrase
  (PBKDF2-SHA256, 600k iters) cross-device sync can upload the envelope unchanged.

---

## 3. The substitution map
`client/src/privacy/substitutionMap.js`

Per-conversation, bidirectional, discarded on conversation close (Rev 1.2 §1.4):

- `originals` : matched string → placeholder
- `placeholders` : placeholder → canonical value (drives restore)
- `byCanonical` : canonicalKey → placeholder (Layer 3 alias dedup)
- `counters` : type code → next index
- `origins` : placeholder → `layer1` | `layer3` (drives the tool-boundary rule)

**Persistence.** The map is as sensitive as the conversation history it's bound
to, and both already live on disk under `%LOCALAPPDATA%\AVOA`. We `serialize()`
it into each conversation record and `hydrate()` on load/switch. Without this,
every relaunch lost the map and historical placeholders leaked verbatim into the
chat bubble + TTS (observed 2026-05-28 with `《§ORG002§》` / `《§P001§》`).

**Legacy recovery.** For conversations created before persistence shipped,
`recoverFromHistory()` scans assistant text for `《§XXX###§》 (value)` /
`value (《§XXX###§》)` pairs and reconstructs the map by most-frequent value —
never overwriting known mappings.

---

## 4. The turn lifecycle
`client/src/agent/loop.js`

```
USER INPUT
   │
   ▼
privacy.substitute(userText)            ← Layer 1 + 2 + 3, overlap-merged
   │  → placeholders swapped in, activity events recorded per layer
   ▼
CLOUD MODEL (Claude sees only placeholders)
   │
   ├── streamed reply deltas ──► makeStreamingRestore() ──► bubble + TTS
   │        (buffers partial placeholders split across deltas)
   │
   ├── tool call ──► tools.invoke()  ← TOOL BOUNDARY (see §5)
   │
   ▼
privacy.restore(finalText)              ← final reconstruction
```

### Streaming restore — the subtle bit
`makeStreamingRestore()` in `privacy/index.js`

Claude streams the reply in many small deltas, and a placeholder like `《§ORG004§》`
can be split across two deltas. Restoring per-delta would leak the literal token.
The wrapper:

- Holds back any buffer tail that *could* be an unfinished placeholder (anchored
  regex `PARTIAL`), flushing only once enough chars arrive to complete it or rule
  it out (`MAX_HOLD = 64`).
- Restores against the **live** map first, then falls back to a **frozen
  snapshot** (`captureReverse()`) taken at turn start — so a concurrent
  conversation switch that resets the live map mid-turn can't leak a placeholder
  into the bubble/TTS (observed 2026-06-01 with `《§ORG006§》` in a French reply).

---

## 5. The tool boundary — cloud vs. local
`client/src/tools/index.js` `invoke()`

This is where the layer-origin distinction earns its keep. Tools are classified
as **cloud-bound** or **local** (`_isCloudBoundTool`): local MCP servers
(`filesystem`, `sequential-thinking`) and all in-process local tools are local;
everything else (Gmail, Calendar, Drive, Slack, web search, unknown user-added
MCP servers) is cloud-bound by default (safer).

**Tier A\* — layer-aware reverse substitution.** Every string field of the tool
input is walked:
- **Layer 1 / Layer 2** placeholders (auto-detected) → always restored. They
  were values the user typed with intent to act on; the tool needs the real value.
- **Layer 3** placeholders (user-curated dictionary) → restored **only if the
  tool is local**. For cloud-bound tools they are deliberately **left in place**
  (`{ skipLayer3: cloudBound }`), so the user's private dictionary values never
  leave the device through a cloud API call.

**Tier B — invariant leak check (fail-closed).** After Tier A\*, if any exotic
placeholder still survives in the input, the call is **blocked**:
- If it's a Layer 3 placeholder on a cloud-bound tool → a specific error tells
  the model to *ask the user* before retrying ("X is in your private dictionary;
  send it to `<service>` anyway, skip it, or answer from what I already know?"),
  and a `blocked` activity event is recorded (type codes only, never values).
- Otherwise (a placeholder we genuinely couldn't restore — model-invented,
  cross-conversation) → blocked with a generic fail-closed message.

This guarantees the substitution map is the *only* thing that can reintroduce a
real value, and that Layer 3 values are structurally prevented from leaving via
cloud tools.

---

## 6. Privacy-activity log (Phase 2a — local)
`client/src/privacy/activityLog.js`

An append-only, on-device audit trail of *what was redacted and where* — **never
the values themselves**, only metadata.

- **On disk:** JSONL at `%LOCALAPPDATA%\AVOA\privacy-activity.jsonl`, one event
  per line, crash-safe. **90-day retention** enforced on init by rewriting the
  file past the cutoff.
- **In memory:** a 2000-event ring for cheap dashboard reads; falls through to
  disk only for windows older than the ring.
- **Event schema** (closed enums, validated on write):
  `{ client_event_id, ts, layer, severity, types[], count, direction, tool_category, tool, blocked }`
  where `direction ∈ {user-input, tool-result, blocked}` and `tool_category` is
  derived from the tool name (`email`/`calendar`/`files`/`search`/`chat`/`local`/`unknown`).
- One event is recorded **per layer** per detection point (user input,
  tool-result substitution, and boundary blocks).
- Read API: `list()` (most-recent-first, filterable), `stats()` (aggregations by
  severity/layer/category/type), `clear()`. Surfaced in the **Activity sub-tab**
  of the Privacy panel.

### Avatar trust-calibration pulse
`client/renderer/app.js`

When a turn redacts ≥1 item, the orb pulses in the highest detected severity's
colour — **high = red, medium = amber, low = cyan** (`pulsePrivacy()` /
`setPrivacyPulse()`). It's the one always-visible signal that the privacy layer
just did something.

---

## 7. Privacy-activity sync (Phase 2b — cloud, optional)
`client/src/privacy/activitySync.js`

Background flush of local activity events to the control plane
(`/cp/privacy-activity`), so paid/enterprise users get a cross-device dashboard.

- **Gated by entitlements**, re-checked every tick: `privacy.activity_sync_enabled`
  (default off), `privacy.activity_tool_detail` (default off — strips the `tool`
  field on the wire when false), `privacy.activity_retention_days` (default 90).
- **Flush loop:** every 60 s, batched at ≤200 events, advancing a persisted
  cursor (`privacy-activity-sync.json`) by the latest event `ts`.
- **Signed envelopes:** each batch is signed by the device key; the canonical
  byte ordering must match the backend's verifier exactly.
- **Backoff/error handling:** exponential backoff (30 s → 30 min) on 429/5xx/transport;
  schema-400 skips the bad batch (advances cursor) rather than retrying forever;
  403/feature-disabled re-polls hourly; 401/signature-invalid backs off pending re-pair.
- **Structural guarantee:** there is *nothing content-bearing* in a local event
  record to begin with — only counts, type codes, severities, categories. The
  wire can't carry a value because the value was never stored.

---

## 8. Control-plane isolation guarantee

The model relay (`POST /v1/messages`) is a separate process that forwards to
Anthropic with only a static shared token — no license, no balance, no prompt
logging — and is lint-enforced to keep no imports out of its directory
(`scripts/lint-control-plane.mjs`, `scripts/smoke-control-plane.mjs`,
TEAM_SCOPE_REV_1_2 §2.4: "structurally can't log prompts"). Privacy-activity
ingest lives in the *control plane*, never the relay, preserving the
"prompts never touch a logging-capable process" property.

---

## 9. Design invariants (the things that must stay true)

1. **The substitution map is the only path back to a real value.** No tool, log,
   or sync record reconstructs a value any other way.
2. **Layer 3 (user dictionary) values never leave the device via cloud tools.**
   Enforced positively (skip-restore) *and* negatively (Tier B block).
3. **Fail closed.** An unrestorable placeholder blocks the tool call; it never
   passes through verbatim.
4. **No values in telemetry.** The activity log and sync carry metadata only —
   counts, type codes, severities, categories, tool names (tool name gated).
5. **Local-first, cloud-optional.** Detection (all 3 layers) and the activity log
   work fully offline; sync is an entitlement-gated add-on.
6. **Don't break the turn.** Privacy failures degrade gracefully — NER not loaded,
   keytar missing, log write fails — the turn still completes with whatever
   protection is available.

---

## 10. File map

| Path | Role |
|---|---|
| `client/src/privacy/index.js` | Public API: `substitute` / `restore` / `makeStreamingRestore` / severity map |
| `client/src/privacy/recognizers/` | Layer 1 regex recognizers + `detectAll()` overlap merge |
| `client/src/privacy/nerLayer2.js` | Layer 2 local NER (transformers.js / bert-base-NER) |
| `client/src/privacy/dictionary.js` | Layer 3 encrypted user dictionary (AES-256-GCM + keytar) |
| `client/src/privacy/substitutionMap.js` | Per-conversation bidirectional map + persistence + recovery |
| `client/src/privacy/activityLog.js` | Phase 2a local JSONL audit log + stats |
| `client/src/privacy/activitySync.js` | Phase 2b signed cloud sync (entitlement-gated) |
| `client/src/agent/loop.js` | Turn wiring: substitute in, streaming-restore out |
| `client/src/tools/index.js` | Tool boundary: Tier A\* reverse-sub + Tier B leak block |
| `client/renderer/app.js` | Avatar severity pulse + Activity sub-tab |
