// Pre-Call Brief pipeline.
//
// Inputs : a scheduled_meetings row (with company + tag arrays)
// Outputs: a markdown brief persisted in pre_call_briefs + status flip on
//          the parent mission row
//
// Steps:
//   1. If the company has a domain, scrape it via Firecrawl as a TRANSIENT
//      kb_documents row (transient_for_mission_id = this mission).
//   2. Build a retrieval query from the engagement triplet's display names
//      (product/persona/competitor) so the KB-side filters AND the semantic
//      search both pull the most relevant chunks.
//   3. Pull top-K chunks via retrieveContext with engagementProfile +
//      currentMissionId so the mission's own transient docs are included.
//   4. Compose a Gemini Pro prompt: strategy section (Gemini-authored),
//      then a "Key Intelligence Snippets" appendix containing the full
//      verbatim text of the 3-4 most relevant chunks (per the locked
//      product decision — rep reads in the car, no citation hunting).
//   5. Persist as pre_call_briefs row, link via setBrief().

const db = require('../db');
const gemini = require('../gemini');
const retrieval = require('../knowledge/retrieval');
const web = require('../knowledge/web');
const service = require('./service');

const BRIEF_MODEL = require('../models').modelFor('brief');
const BRIEF_RETRIEVAL_K = parseInt(process.env.BRIEF_RETRIEVAL_K || '8', 10);
const APPENDIX_CHUNK_COUNT = parseInt(process.env.BRIEF_APPENDIX_CHUNKS || '4', 10);

// Translate raw Gemini SDK errors (the JSON-in-message ones) into a clean
// HTTP-shaped error so the admin UI / scheduler don't surface walls of
// provider JSON to the user. Returns the original error if it doesn't match
// a known pattern.
function translateGeminiError(err) {
  const msg = String(err?.message || err || '');
  // The SDK puts the upstream JSON straight into err.message — try to parse it.
  let upstream = null;
  const m = msg.match(/\{[\s\S]*\}$/);
  if (m) { try { upstream = JSON.parse(m[0]); } catch { /* ignore */ } }
  const code   = upstream?.error?.code   ?? err?.status;
  const status = upstream?.error?.status ?? '';
  const body   = upstream?.error?.message || msg;

  if (code === 429 || status === 'RESOURCE_EXHAUSTED') {
    const isBilling = /prepayment|credits|billing|quota|exceeded/i.test(body);
    const e = new Error(isBilling
      ? "AI provider quota exhausted — retry shortly. (Ops: top up the provider account or rotate the API key.)"
      : "AI rate limit hit — wait a moment and retry.");
    e.status = 429;
    e.code = 'GEMINI_QUOTA';
    return e;
  }
  if (code === 401 || code === 403) {
    const e = new Error("The AI provider rejected the request (auth). Contact support — the workspace's AI access needs attention.");
    e.status = 502; e.code = 'GEMINI_AUTH';
    return e;
  }
  if (code >= 500) {
    const e = new Error(`AI provider error (${code}) — retry in a moment.`);
    e.status = 502; e.code = 'GEMINI_UPSTREAM';
    return e;
  }
  return err;
}

// Look up display names for each id in the engagement profile. Arrays in,
// arrays out — empty array if nothing matches. One round-trip per dimension
// using `= ANY($1::text[])`.
async function fetchEntityNames(tenantId, profile) {
  const lookup = async (table, ids) => {
    if (!ids || ids.length === 0) return [];
    const r = await db.query(`SELECT name FROM ${table} WHERE id = ANY($1::text[]) AND tenant_id = $2`, [ids, tenantId]);
    return r.rows.map((row) => row.name).filter(Boolean);
  };
  return {
    productNames:    await lookup('products',    profile.productIds),
    personaNames:    await lookup('personas',    profile.personaIds),
    competitorNames: await lookup('competitors', profile.competitorIds),
  };
}

// Compose the retrieval-side query from the engagement-display names plus
// the company name. Concatenated string works because Gemini's query
// embedding handles entity tokens well — no need for entity expansion here.
function composeQuery({ companyName, productNames, personaNames, competitorNames }) {
  return [
    companyName,
    ...(productNames    || []),
    ...(personaNames    || []),
    ...(competitorNames || []),
    'pricing', 'objections',
  ].filter(Boolean).join(' ');
}

const PROMPT_HEADER =
  'You are DealScope\'s Mission Brief author. Compose a one-page brief for ' +
  'a sales rep about to walk into a real call. Audience: the rep, on a phone ' +
  'screen, 5 minutes before the meeting starts. Tone: punchy, specific, no ' +
  'filler, no marketing voice. Salesperson must be able to skim this in 90 ' +
  'seconds and walk in armed.\n\n' +
  'Format requirements — exactly this markdown structure, in order:\n\n' +
  '# Mission Brief — {companyName}\n' +
  '**Call**: {scheduledAtHuman} · **Persona**: {personaName} · **Competitor**: {competitorName}\n\n' +
  '## Company Snapshot\n' +
  'Two or three sentences. What they do, recent signal you noticed from their ' +
  'website or social. Quote specifics. No generic descriptions.\n\n' +
  '## Likely Objections from {personaName}\n' +
  'Three bullets. Each: the objection in their voice, then the silver-bullet ' +
  'counter in one sentence (start the counter with "→").\n\n' +
  '## Competitive Edge Against {competitorName}\n' +
  'Three bullets. Each: their weakness, then your differentiator in one ' +
  'sentence (start the differentiator with "→").\n\n' +
  '## Three Opening Moves\n' +
  'Three numbered items. Specific things to do in the first 5 minutes of ' +
  'the call. Not "build rapport" — actual moves.\n\n' +
  'Knowledge sourcing: each grounded snippet has a tier prefix in its citation ' +
  'block — [BASIS] is product/battlecard/org-wide intel, [PROSPECT_MEMORY] is ' +
  'what we already know about THIS company from prior interactions, ' +
  '[LIVE_PULSE] is a fresh scrape we did minutes ago. Prefer the prospect-' +
  'specific tiers when they\'re available — quoting "Prospect Memory" lands ' +
  'harder than a generic battlecard.\n\n' +
  'Do NOT include the appendix. The system will append it.';

function formatChunkForAppendix(chunk) {
  const date = chunk.effectiveDate
    ? ` · as of ${new Date(chunk.effectiveDate).toISOString().slice(0, 10)}`
    : '';
  const source = chunk.sourceUrl ? `\n_Source: ${chunk.sourceUrl}_` : '';
  return [
    `### [${chunk.citation}] ${chunk.documentTitle}`,
    `_${chunk.category} · ${chunk.streamType}${date}_${source}`,
    '',
    chunk.text,
  ].join('\n');
}

// Tri-Tiered appendix grouping. We render the top APPENDIX_CHUNK_COUNT chunks
// in tier order — LIVE_PULSE first (most current), then PROSPECT_MEMORY
// (this-company history), then BASIS (everything else) — preserving the
// cosine+recency order within each tier. The rep skims tier-by-tier on the
// way into the call.
const TIER_LABELS = {
  LIVE_PULSE:      'Live Pulse — this mission\'s fresh scrape',
  PROSPECT_MEMORY: 'Prospect Memory — what we already know about this account',
  BASIS:           'Basis — product, battlecard, and org-wide intel',
};
const TIER_ORDER = ['LIVE_PULSE', 'PROSPECT_MEMORY', 'BASIS'];

function buildAppendix(chunks) {
  if (chunks.length === 0) {
    return '\n\n---\n\n## Key Intelligence Snippets\n\n_(No relevant snippets in the Knowledge Base for this engagement scope. Add product docs / battlecards via Knowledge Base → Upload to unlock this section.)_';
  }
  const buckets = new Map(TIER_ORDER.map((t) => [t, []]));
  for (const c of chunks) {
    const tier = TIER_ORDER.includes(c.tier) ? c.tier : 'BASIS';
    buckets.get(tier).push(c);
  }
  const sections = [];
  for (const tier of TIER_ORDER) {
    const items = buckets.get(tier);
    if (items.length === 0) continue;
    sections.push(
      `### ${TIER_LABELS[tier]}\n\n` +
      items.map(formatChunkForAppendix).join('\n\n')
    );
  }
  return '\n\n---\n\n## Key Intelligence Snippets\n\n' +
    `Full text of the top-${chunks.length} chunks the AI consulted, grouped by tier. ` +
    'Read in the car, quote in the meeting.\n\n' +
    sections.join('\n\n---\n\n');
}

function fmtCallTime(iso) {
  try {
    const d = new Date(iso);
    return d.toUTCString();
  } catch { return iso; }
}

async function generate(missionId, tenantId) {
  if (!tenantId) throw new Error('brief.generate: tenantId required');
  const mission = await service.get(tenantId, missionId);
  if (!mission) throw new Error(`mission ${missionId} not found for tenant ${tenantId}`);

  const profile = service.profileFromMission(mission);
  const names = await fetchEntityNames(tenantId, profile);

  // 1. Transient web scrape of the company domain (if present + Firecrawl
  //    is configured). Best-effort — a failed scrape doesn't kill the brief.
  const transientDocIds = [];
  if (mission.company_domain && web.isConfigured()) {
    try {
      const url = mission.company_domain.startsWith('http')
        ? mission.company_domain
        : `https://${mission.company_domain}`;
      const doc = await web.syncUrl({
        tenantId,
        url,
        category: 'PRODUCT_INTEL', // categorise the prospect's own site as PRODUCT_INTEL —
                                   // it doesn't really fit BATTLECARDS or ORG_INTELLIGENCE
        title: `${mission.company_name} — homepage (mission ${missionId.slice(0,8)})`,
        dryRun: false,
        // It's intel about the PROSPECT (scope=PROSPECT, company_id set), but
        // transient_for_mission_id is also set so deriveTier() promotes it to
        // LIVE_PULSE for this mission's own retrieval.
        scope: mission.company_id ? 'PROSPECT' : 'TENANT',
        companyId: mission.company_id || null,
        productIds:    profile.productIds.length    ? profile.productIds    : null,
        personaIds:    profile.personaIds.length    ? profile.personaIds    : null,
        competitorIds: profile.competitorIds.length ? profile.competitorIds : null,
        transientForMissionId: missionId,
      });
      if (doc && doc.id) transientDocIds.push(doc.id);
    } catch (err) {
      console.warn(`[brief] web-sync failed for ${mission.company_domain}: ${err.message}`);
    }
  }

  // 2 + 3. Retrieve top-K chunks with engagement filter + this mission's
  //         transient scope so the scraped page is visible.
  const query = composeQuery({
    companyName:     mission.company_name,
    productNames:    names.productNames,
    personaNames:    names.personaNames,
    competitorNames: names.competitorNames,
  });
  const retrieved = await retrieval.retrieveContext(query, {
    tenantId,
    k: BRIEF_RETRIEVAL_K,
    engagementProfile: profile,
    currentMissionId: missionId,
    missionCompanyId: mission.company_id || null,
  });

  // 4. Gemini Pro composes the strategy section. The appendix is built
  //    deterministically from the top-N retrieved chunks (verbatim text) —
  //    we don't let the model rewrite the snippets, so the rep sees exactly
  //    what's in the KB.
  const ai = gemini.getClient();
  // The prompt template uses singular {personaName}/{competitorName} placeholders
  // for headline cosmetics — join multi-tag missions with " / " so a brief titled
  // "vs Salesforce / Gong" still reads naturally. The retrieval filter (above)
  // already considers the full set; this is just the human-facing summary.
  const joinNames = (arr, fallback) => (arr && arr.length) ? arr.join(' / ') : fallback;
  const filledHeader = PROMPT_HEADER
    .replaceAll('{companyName}',     mission.company_name)
    .replaceAll('{personaName}',     joinNames(names.personaNames,    'the prospect'))
    .replaceAll('{competitorName}',  joinNames(names.competitorNames, 'the incumbent vendor'))
    .replaceAll('{scheduledAtHuman}', fmtCallTime(mission.scheduled_at));

  const promptParts = [filledHeader];
  if (mission.prospect_emails && mission.prospect_emails.length > 0) {
    promptParts.push(`\n## Prospect contacts on the call\n${mission.prospect_emails.map((e) => `- ${e}`).join('\n')}`);
  }
  promptParts.push(`\n## Engagement scope\nProduct: ${joinNames(names.productNames, 'unspecified')} · Persona: ${joinNames(names.personaNames, 'unspecified')} · Competitor: ${joinNames(names.competitorNames, 'unspecified')}`);
  if (retrieved.chunks.length > 0) {
    promptParts.push('\n## Source knowledge (use these to ground the brief — quote specifics)\n' + retrieval.formatForPrompt(retrieved.chunks));
  } else {
    promptParts.push('\n## Source knowledge\n(none — KB is empty or filters excluded everything. Brief should explicitly note the rep is going in cold.)');
  }

  let response;
  try {
    response = await ai.models.generateContent({
      model: BRIEF_MODEL,
      contents: [{ role: 'user', parts: [{ text: promptParts.join('\n') }] }],
      config: { temperature: 0.4, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } },
    });
  } catch (raw) {
    const clean = translateGeminiError(raw);
    // Mark the mission so the brief column shows the friendly reason on the
    // list page, then re-throw so the route handler returns the right status.
    try { await service.setBriefError(tenantId, missionId, clean.message); }
    catch (e) { console.warn(`[brief] setBriefError failed: ${e.message}`); }
    throw clean;
  }

  const strategy = (response.text || '').trim();

  // Build the appendix from the top N chunks deterministically, grouped by
  // Tri-Tiered tier (Live Pulse → Prospect Memory → Basis).
  const appendixChunks = retrieved.chunks.slice(0, APPENDIX_CHUNK_COUNT);
  const appendixMarkdown = buildAppendix(appendixChunks);

  const contentMd = strategy + appendixMarkdown;

  // 5. Persist + flip mission to BRIEFED.
  const insert = await db.query(
    `INSERT INTO pre_call_briefs
       (tenant_id, scheduled_meeting_id, content_md, retrieved_citations, transient_doc_ids, models, usage)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, generated_at`,
    [
      tenantId,
      missionId,
      contentMd,
      JSON.stringify(retrieved.chunks.map((c) => ({
        citation: c.citation,
        documentId: c.documentId,
        documentTitle: c.documentTitle,
        category: c.category,
        streamType: c.streamType,
        tier: c.tier || 'BASIS',
        distance: c.distance,
      }))),
      JSON.stringify(transientDocIds),
      JSON.stringify({ brief: BRIEF_MODEL }),
      JSON.stringify({ brief: response.usageMetadata || null }),
    ]
  );
  const briefId = insert.rows[0].id;
  await service.setBrief(tenantId, missionId, briefId);

  return {
    briefId,
    generatedAt: insert.rows[0].generated_at,
    chunkCount: retrieved.chunks.length,
    transientDocCount: transientDocIds.length,
    contentMd,
  };
}

// Convenience: latest brief for a mission, scoped to the tenant.
async function getLatest(tenantId, missionId) {
  const r = await db.query(
    `SELECT id, scheduled_meeting_id, content_md, retrieved_citations,
            transient_doc_ids, models, usage, generated_at
       FROM pre_call_briefs
      WHERE tenant_id = $1 AND scheduled_meeting_id = $2
      ORDER BY generated_at DESC
      LIMIT 1`,
    [tenantId, missionId]
  );
  return r.rows[0] || null;
}

module.exports = { generate, getLatest };
