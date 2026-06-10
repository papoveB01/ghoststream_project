// Gemini analysis pipeline.
//
// Three-stage strategy:
//
//   STAGE 0 (Flash-Lite, optional): extract Technical Entities — product
//                 names, pricing terms, competitor names, technical claims —
//                 that the rep made on the call. Skipped entirely if the
//                 Knowledge Base has zero READY documents.
//   STAGE 1 (Pro): read the transcript AND the retrieved [Grounded Knowledge]
//                 chunks, identify the Moment-of-Truth, and flag any rep
//                 claim that contradicts the KB as a "Knowledge Gap" citing
//                 the offending chunk(s).
//   STAGE 2 (Flash): draft the human-readable artifacts (follow-up email +
//                 consolidated report) from the structured moments.

const gemini = require('./gemini');
const retrieval = require('./knowledge/retrieval');

const { modelFor } = require('./models');
const ANALYSIS_MODEL = modelFor('callAnalysis');   // flagship moment-of-truth → PRO (gated)
const CONTENT_MODEL = modelFor('content');          // report / portal writing
const ENTITY_MODEL = modelFor('callEntities');      // cheap entity extraction → LITE

// ---------------------------------------------------------------- STAGE 0
//
// Entity-extraction schema. The Flash-Lite pass returns a flat list of
// technical entities; we concatenate them into a single retrieval query.
const ENTITIES_SCHEMA = {
  type: 'object',
  properties: {
    entities: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Concrete technical entities the rep mentioned: product names, ' +
        'pricing terms ($/seat/month etc.), feature names, SKUs, ' +
        'competitor names, technical claims, dates, SLA numbers. Skip ' +
        'generic phrases like "ROI" or "platform."',
    },
  },
  required: ['entities'],
};

async function extractEntities(transcript) {
  const formatted = formatTranscript(transcript);
  const ai = gemini.getClient();
  const response = await ai.models.generateContent({
    model: ENTITY_MODEL,
    contents: [{
      role: 'user',
      parts: [{
        text:
          'You are an entity extractor. From the sales-call transcript below, ' +
          'list the concrete TECHNICAL ENTITIES the REP (not the prospect) ' +
          'mentioned: product/feature names, pricing terms, SKUs, competitor ' +
          'names, specific numbers (prices, percentages, SLAs, dates), and ' +
          'technical claims (e.g. "SOC 2 Type II", "Postgres + pgvector"). ' +
          'Exclude vague marketing phrases. Return at most 25 entities.\n\n' +
          '## Transcript\n' + formatted,
      }],
    }],
    config: {
      responseMimeType: 'application/json',
      responseSchema: ENTITIES_SCHEMA,
      temperature: 0.1,
      maxOutputTokens: 1024,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  let parsed;
  try { parsed = JSON.parse(response.text); }
  catch (err) {
    throw new Error(`analysis stage 0: failed to parse JSON: ${response.text?.slice(0, 300)}`);
  }
  return {
    model: ENTITY_MODEL,
    usage: response.usageMetadata || null,
    entities: Array.isArray(parsed.entities) ? parsed.entities : [],
  };
}

// ---------------------------------------------------------------- STAGE 1
//
// Moments + fact-check schema. The Pro model returns JSON we can use directly.
const MOMENTS_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'One-line summary of the call.' },
    objection: {
      type: 'object',
      properties: {
        quote: { type: 'string' },
        category: { type: 'string', description: 'e.g. payback, security, layering, pricing' },
        startSeconds: { type: 'number' },
        endSeconds: { type: 'number' },
        resolved: { type: 'boolean' },
        repResponseQuote: { type: 'string' },
      },
      required: ['quote', 'category', 'startSeconds', 'endSeconds', 'resolved'],
    },
    agreement: {
      type: 'object',
      properties: {
        quote: { type: 'string' },
        commitment: { type: 'string', description: 'What the prospect agreed to do or accept.' },
        startSeconds: { type: 'number' },
        endSeconds: { type: 'number' },
      },
      required: ['quote', 'commitment', 'startSeconds', 'endSeconds'],
    },
    nextSteps: {
      type: 'array',
      items: { type: 'string' },
      description: 'Action items the rep committed to during the call.',
    },
    knowledgeGaps: {
      type: 'array',
      description:
        'Claims the rep made that CONTRADICT the [Grounded Knowledge] section ' +
        'OR contradict the [Pre-Call Brief] section (the predictions DealScope ' +
        "made about objections / competitive edge before the call). Empty array " +
        'if there are no contradictions or no grounded knowledge / brief was provided.',
      items: {
        type: 'object',
        properties: {
          repQuote:      { type: 'string', description: "Exact quote of the rep's incorrect claim." },
          kbCitation:    { type: 'string', description: 'Citation token: either a chunk token from [Grounded Knowledge] in the form doc-id:c-N, or the literal "[BRIEF]" when the contradiction is against the [Pre-Call Brief] section.' },
          contradiction: { type: 'string', description: 'One sentence: what the KB / brief says vs. what the rep said.' },
          severity:      { type: 'string', description: 'HIGH (pricing/contract terms), MEDIUM (feature/spec), LOW (positioning).' },
        },
        required: ['repQuote', 'kbCitation', 'contradiction', 'severity'],
      },
    },
  },
  required: ['summary', 'objection', 'agreement', 'nextSteps', 'knowledgeGaps'],
};

function formatTranscript(transcript) {
  return transcript.segments
    .map(([s, e, who, text]) => {
      const speaker = transcript.participants.find((p) => p.role === who);
      const name = speaker ? `${speaker.name} (${speaker.role})` : who;
      const t = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
      return `[${t(s)}-${t(e)}] ${name}: ${text}`;
    })
    .join('\n');
}

// Truncate the pre-call brief's content_md before threading it into the
// Stage-1 prompt. The brief is full-page markdown (strategy section + KB
// appendix). The appendix duplicates what `retrieval.retrieveContext`
// already pulls for analysis, so we just need the strategy header — first
// ~2000 chars covers the predictions section comfortably.
const BRIEF_PROMPT_TRUNCATE_CHARS = 2000;

async function findMoments(transcript, { groundedKnowledge, preCallBrief } = {}) {
  const formatted = formatTranscript(transcript);
  const ai = gemini.getClient();

  // Pre-call brief: the predictions DealScope made BEFORE the meeting,
  // grounded in the same KB. Including this in the Stage-1 prompt lets the
  // analysis flag "rep contradicted the predicted competitive edge" or
  // "rep accepted an objection the brief told them to push back on" —
  // structurally answerable only when the brief and the analysis share state.
  const briefClause = preCallBrief && preCallBrief.contentMd
    ? (
      '\n\n## Pre-Call Brief (what DealScope predicted before the call)\n' +
      'This is the briefing DealScope prepared for the rep ahead of time, ' +
      "grounded in the same KB. When flagging a rep claim that contradicts " +
      'the brief (e.g. predicted objection went unhandled, predicted ' +
      'competitive edge was misstated), add a `knowledgeGaps` entry with ' +
      'the literal token `[BRIEF]` in `kbCitation`.\n\n' +
      preCallBrief.contentMd.slice(0, BRIEF_PROMPT_TRUNCATE_CHARS) +
      (preCallBrief.contentMd.length > BRIEF_PROMPT_TRUNCATE_CHARS
        ? '\n\n[... brief truncated for prompt budget ...]'
        : '')
    )
    : '';

  const factCheckClause = groundedKnowledge && groundedKnowledge.chunks?.length
    ? (
      '\n\n## Grounded Knowledge (cite by token in [brackets])\n' +
      retrieval.formatForPrompt(groundedKnowledge.chunks) +
      '\n\n## Fact-Check Instruction\n' +
      'Compare the rep\'s claims in the transcript against the [Grounded Knowledge] ' +
      (preCallBrief ? 'AND the [Pre-Call Brief] ' : '') +
      'sections. If the rep quotes a price, feature, timeline, contract term, or ' +
      'capability that CONTRADICTS the KB, add an entry to `knowledgeGaps` citing ' +
      'the offending chunk by its [doc-id:c-N] token. ' +
      (preCallBrief
        ? "If the rep's behavior contradicts the brief's predictions (e.g. didn't " +
          'handle a predicted objection, mis-stated a predicted competitive edge), ' +
          'add a `knowledgeGaps` entry with `kbCitation` set to the literal `[BRIEF]`. '
        : '') +
      'Be conservative — only flag clear contradictions, not tonal mismatches. If ' +
      'no contradictions exist, return an empty `knowledgeGaps` array.'
    )
    : (preCallBrief
      ? '\n\n## Fact-Check Instruction\nNo Knowledge Base entries available. If the rep ' +
        'clearly contradicts a prediction in the [Pre-Call Brief] (predicted objection ' +
        'unhandled, predicted competitive edge misstated), add a `knowledgeGaps` entry ' +
        'with `kbCitation` set to the literal `[BRIEF]`. Otherwise return an empty array.'
      : '\n\nNo Knowledge Base entries available — return an empty `knowledgeGaps` array.');

  const response = await ai.models.generateContent({
    model: ANALYSIS_MODEL,
    contents: [
      {
        role: 'user',
        parts: [
          {
            text:
              'You are the analysis brain inside a sales-enablement product. Read the transcript ' +
              'of this sales call and identify ONE Moment-of-Truth: the most important objection ' +
              'the prospect raised, and the most important agreement the prospect made. Return ' +
              'precise timestamps so we can clip the audio/video later.\n\n' +
              '## Call metadata\n' +
              `Title: ${transcript.meetingTitle}\n` +
              `Duration: ${transcript.durationSeconds} seconds\n` +
              `Participants:\n${transcript.participants.map((p) => `- ${p.name} (${p.role}${p.title ? ', ' + p.title : ''}${p.company ? ', ' + p.company : ''})`).join('\n')}\n\n` +
              '## Transcript\n' +
              formatted +
              briefClause +
              factCheckClause,
          },
        ],
      },
    ],
    config: {
      responseMimeType: 'application/json',
      responseSchema: MOMENTS_SCHEMA,
      temperature: 0.3,
      maxOutputTokens: 4096,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  let parsed;
  try {
    parsed = JSON.parse(response.text);
  } catch (err) {
    throw new Error(`analysis stage 1: failed to parse JSON: ${response.text?.slice(0, 300)}`);
  }
  return {
    model: ANALYSIS_MODEL,
    usage: response.usageMetadata || null,
    moments: parsed,
  };
}

// ---------------------------------------------------------------- STAGE 2
//
// Lightweight writer model produces the follow-up email + the consolidated
// meeting report using the structured moments from stage 1.

const FOLLOWUP_SCHEMA = {
  type: 'object',
  properties: {
    email: {
      type: 'object',
      properties: {
        subject: { type: 'string' },
        bodyPlainText: { type: 'string', description: 'Exactly three sentences. No greeting line on its own, no signature.' },
      },
      required: ['subject', 'bodyPlainText'],
    },
    report: {
      type: 'object',
      properties: {
        overview: { type: 'string', description: '2-3 sentence consolidated overview of the meeting: who met, why, and where the deal stands.' },
        discussionPoints: { type: 'array', items: { type: 'string' }, description: 'The 3-6 key topics actually discussed, each one line, specific.' },
        commitments: { type: 'array', items: { type: 'string' }, description: 'Who committed to what, with any numbers/dates quoted.' },
        risksAndObjections: { type: 'string', description: 'Objections or risks raised and how (or whether) they were addressed. One short paragraph; "None raised." if none.' },
      },
      required: ['overview', 'discussionPoints', 'commitments', 'risksAndObjections'],
    },
  },
  required: ['email', 'report'],
};

async function draftFollowups({ transcript, moments }) {
  const ai = gemini.getClient();
  const response = await ai.models.generateContent({
    model: CONTENT_MODEL,
    contents: [
      {
        role: 'user',
        parts: [
          {
            text:
              'You are the writer that turns a sales call into a follow-up email and a CONSOLIDATED MEETING REPORT. ' +
              'Tone: concise, specific, no sales clichés. Quote numbers the participants actually gave; never invent. ' +
              'Email body must be EXACTLY three sentences. No greeting/signature. ' +
              'The report consolidates the whole meeting: a short overview, the key discussion points, every commitment made (by either side), and the risks/objections raised.\n\n' +
              `## Call summary\n${moments.summary}\n\n` +
              '## Prospect agreement\n' +
              `${moments.agreement.quote}\n` +
              `Commitment: ${moments.agreement.commitment}\n\n` +
              '## Rep next steps\n' +
              moments.nextSteps.map((s) => `- ${s}`).join('\n') +
              '\n\n' +
              '## Participants\n' +
              transcript.participants.map((p) => `- ${p.name} (${p.role}${p.title ? ', ' + p.title : ''})`).join('\n'),
          },
        ],
      },
    ],
    config: {
      responseMimeType: 'application/json',
      responseSchema: FOLLOWUP_SCHEMA,
      temperature: 0.5,
      maxOutputTokens: 2048,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  let parsed;
  try {
    parsed = JSON.parse(response.text);
  } catch (err) {
    throw new Error(`analysis stage 2: failed to parse JSON: ${response.text?.slice(0, 300)}`);
  }
  return {
    model: CONTENT_MODEL,
    usage: response.usageMetadata || null,
    ...parsed,
  };
}

// ---------------------------------------------------------------- FULL PIPELINE

// Founders tenant id — the recall.ai call-recording → portal flow is a
// Founders-only feature in Phase 1, so analysis defaults its KB scope here.
const FOUNDERS_TENANT_ID = '00000000-0000-0000-0000-000000000001';

async function runPipeline(transcript, {
  // KB scope for the grounded fact-check. Defaults to the Founders tenant
  // because today only Founders has the recall.ai meeting flow; once trial
  // tenants get a real call-capture path this should be threaded explicitly.
  tenantId = FOUNDERS_TENANT_ID,
  engagementProfile = null,
  // Tri-Tiered scope. When the portal was created from a scheduled mission,
  // thread the mission id (Live Pulse) and company id (Prospect Memory)
  // through so Fact-Check citations carry the right tier badge.
  currentMissionId = null,
  missionCompanyId = null,
} = {}) {
  // Stage 0 + retrieval is gated on KB readiness — if no docs are indexed yet,
  // we skip the Flash-Lite extraction pass entirely (saves a call) and fall
  // through to a standard moments analysis with empty knowledgeGaps.
  let entities = null;
  let groundedKnowledge = null;
  let kbHits = 0;

  const kbReady = await retrieval.hasReadyDocuments(tenantId);
  if (kbReady) {
    entities = await extractEntities(transcript);
    if (entities.entities.length > 0) {
      // One retrieval query, joining all entities — pgvector ranks chunks by
      // semantic relevance, so a comma-separated string works fine.
      const query = entities.entities.join(', ');
      groundedKnowledge = await retrieval.retrieveContext(query, {
        tenantId,
        k: parseInt(process.env.KB_RETRIEVAL_K || '8', 10),
        engagementProfile,
        currentMissionId,
        missionCompanyId,
      });
      kbHits = groundedKnowledge.chunks.length;
    }
  }

  // Pre-call brief: when the portal belongs to a mission, pull the latest
  // brief that DealScope generated BEFORE the meeting and thread it into
  // Stage 1. Without this, "did the rep handle the objections we predicted?"
  // is structurally unanswerable — the analysis pipeline would re-derive
  // everything from the transcript + KB without seeing the predictions.
  // Best-effort: a missing or unreadable brief doesn't fail the pipeline.
  let preCallBrief = null;
  if (currentMissionId) {
    try {
      const brief = require('./missions/brief');
      const latest = await brief.getLatest(tenantId, currentMissionId);
      if (latest && latest.content_md) {
        preCallBrief = {
          briefId: latest.id,
          generatedAt: latest.generated_at,
          contentMd: latest.content_md,
        };
      }
    } catch (err) {
      console.warn(`[analysis] pre-call brief lookup failed for mission ${currentMissionId}: ${err.message}`);
    }
  }

  const stage1 = await findMoments(transcript, { groundedKnowledge, preCallBrief });
  const stage2 = await draftFollowups({ transcript, moments: stage1.moments });

  return {
    moments: stage1.moments,
    email: stage2.email,
    report: stage2.report,
    grounding: {
      kbReady,
      entities: entities ? entities.entities : [],
      retrievedChunkCount: kbHits,
      // Pre-call brief consulted? When true, Stage 1 saw DealScope's
      // pre-meeting predictions and may have flagged contradictions with
      // `kbCitation: "[BRIEF]"` in knowledgeGaps. The portal can render
      // "Compared against pre-call brief" when this is true.
      preCallBrief: preCallBrief
        ? { briefId: preCallBrief.briefId, generatedAt: preCallBrief.generatedAt }
        : null,
      // Persist what filter was applied so manager-triage can re-run with a
      // different profile and the portal can show "audited against {product}".
      engagementProfile: engagementProfile || null,
      // Slim form — full text already lives in the prompt; we keep enough for
      // the portal to render "Fact-Check: AI consulted N KB entries" badges
      // plus the stream-type / effective-date metadata the SOW footer needs
      // ("Verified against: 2 PDFs, 1 Website, 1 Social Post").
      citations: groundedKnowledge
        ? groundedKnowledge.chunks.map((c) => ({
            citation: c.citation,
            documentId: c.documentId,
            documentTitle: c.documentTitle,
            category: c.category,
            distance: c.distance,
            streamType: c.streamType || 'FILE',
            effectiveDate: c.effectiveDate || null,
            sourceUrl: c.sourceUrl || null,
            // Tri-Tiered tier badge — drives the portal Fact-Check pill.
            tier: c.tier || 'BASIS',
          }))
        : [],
    },
    models: {
      entities: entities ? entities.model : null,
      analysis: stage1.model,
      content: stage2.model,
    },
    usage: {
      entities: entities ? entities.usage : null,
      analysis: stage1.usage,
      content: stage2.usage,
    },
  };
}

module.exports = {
  findMoments,
  draftFollowups,
  extractEntities,
  runPipeline,
  formatTranscript,
};
