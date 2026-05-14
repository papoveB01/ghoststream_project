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
//                 SOW summary) from the structured moments.

const gemini = require('./gemini');
const retrieval = require('./knowledge/retrieval');

const ANALYSIS_MODEL =
  process.env.GEMINI_ANALYSIS_MODEL || 'gemini-2.5-pro';
const CONTENT_MODEL =
  process.env.GEMINI_CONTENT_MODEL || 'gemini-2.5-flash';
const ENTITY_MODEL =
  process.env.GEMINI_CONTENT_MODEL || 'gemini-2.5-flash';

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
        'Claims the rep made that CONTRADICT the [Grounded Knowledge] section. ' +
        'Empty array if there are no contradictions or no grounded knowledge was provided.',
      items: {
        type: 'object',
        properties: {
          repQuote:      { type: 'string', description: "Exact quote of the rep's incorrect claim." },
          kbCitation:    { type: 'string', description: 'Citation token from [Grounded Knowledge], format: doc-id:c-N.' },
          contradiction: { type: 'string', description: 'One sentence: what the KB says vs. what the rep said.' },
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

async function findMoments(transcript, { groundedKnowledge } = {}) {
  const formatted = formatTranscript(transcript);
  const ai = gemini.getClient();

  const factCheckClause = groundedKnowledge && groundedKnowledge.chunks?.length
    ? (
      '\n\n## Grounded Knowledge (cite by token in [brackets])\n' +
      retrieval.formatForPrompt(groundedKnowledge.chunks) +
      '\n\n## Fact-Check Instruction\n' +
      'Compare the rep\'s claims in the transcript against the [Grounded Knowledge]. ' +
      'If the rep quotes a price, feature, timeline, contract term, or capability ' +
      'that CONTRADICTS the KB, add an entry to `knowledgeGaps` citing the offending ' +
      'chunk by its [doc-id:c-N] token. Be conservative — only flag clear ' +
      'contradictions, not tonal mismatches. If no contradictions exist, return ' +
      'an empty `knowledgeGaps` array.'
    )
    : '\n\nNo Knowledge Base entries available — return an empty `knowledgeGaps` array.';

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
// Lightweight writer model produces the follow-up email + SOW summary
// using the structured moments from stage 1.

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
    sowSummary: {
      type: 'object',
      properties: {
        scopeOneLine: { type: 'string' },
        commitments: { type: 'array', items: { type: 'string' } },
        outcomeMetric: { type: 'string' },
        termAndExit: { type: 'string' },
      },
      required: ['scopeOneLine', 'commitments', 'outcomeMetric', 'termAndExit'],
    },
  },
  required: ['email', 'sowSummary'],
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
              'You are the writer that turns a Moment-of-Truth into a follow-up email and a draft SOW. ' +
              'Tone: concise, specific, no sales clichés. Quote numbers the rep already gave. ' +
              'Email body must be EXACTLY three sentences. No greeting/signature.\n\n' +
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

  const stage1 = await findMoments(transcript, { groundedKnowledge });
  const stage2 = await draftFollowups({ transcript, moments: stage1.moments });

  return {
    moments: stage1.moments,
    email: stage2.email,
    sowSummary: stage2.sowSummary,
    grounding: {
      kbReady,
      entities: entities ? entities.entities : [],
      retrievedChunkCount: kbHits,
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
