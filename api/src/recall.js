// Recall.ai client.
// Region is per-token — auth fails on the wrong region endpoint.

const RECALL_REGION = process.env.RECALL_AI_REGION || 'us-west-2';
const RECALL_API_KEY = process.env.RECALL_AI_API_KEY || '';
const RECALL_BASE = `https://${RECALL_REGION}.recall.ai/api/v1`;

function authHeaders() {
  if (!RECALL_API_KEY) throw new Error('RECALL_AI_API_KEY is not set');
  return {
    Authorization: `Token ${RECALL_API_KEY}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

async function http(method, path, body) {
  const url = RECALL_BASE + path;
  const res = await fetch(url, {
    method,
    headers: authHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { /* keep raw */ }
  if (!res.ok) {
    const err = new Error(`Recall.ai ${method} ${path} ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

// Per the sprint plan: real-time transcription is on so Gemini can think
// during the meeting instead of waiting for it to end.
//
// 2026-05-14: Recall.ai v1 retired the top-level `transcription_options`,
// `real_time_transcription`, and `recording_mode` fields. Everything now
// lives under `recording_config`. See:
//   https://docs.recall.ai/reference/bot_create
//
// 2026-05-29: a draft `teamsBotCredentialId` parameter was added here and
// then removed when we discovered Recall has no programmatic Teams bot
// credential API — authenticated Teams joining is configured once on Recall's
// dashboard (one Microsoft user account per Recall org). See ADR-0002 §8.
// captureVideo=false → transcript-only: the bot still joins and transcribes
// (real-time captions), so the sales-intel pipeline is unaffected, but we omit
// the mixed-video layout and never ingest a recording (privacy mode — see
// recordingSettings.js / migration 0043).
//
// noticeMessage → a recording/transcription notice posted to participants in
// the meeting chat when the bot joins (consent/notice).
async function createBot({ meetingUrl, botName = 'DealScope Notetaker', webhookUrl, metadata = {}, captureVideo = true, noticeMessage = null }) {
  if (!meetingUrl) throw new Error('createBot: meetingUrl required');
  const recordingConfig = {
    // Default real-time provider (the platform's own meeting captions).
    transcript: {
      provider: { meeting_captions: {} },
    },
  };
  // Only render/keep mixed video when video capture is enabled. speaker_view
  // used to live at the top level as `recording_mode`.
  if (captureVideo) recordingConfig.video_mixed_layout = 'speaker_view';
  if (webhookUrl) {
    // realtime_endpoints only stream transcript + participant events — bot
    // lifecycle events (bot.status_change → "done") are delivered out-of-band
    // through Recall.ai's webhook subscription system (configured per-org in
    // the Recall dashboard or via the /webhook/ endpoint, NOT here).
    recordingConfig.realtime_endpoints = [
      {
        type: 'webhook',
        url: webhookUrl,
        events: [
          'transcript.data',
          'transcript.partial_data',
        ],
      },
    ];
  }
  const body = {
    meeting_url: meetingUrl,
    bot_name: botName,
    metadata,
    recording_config: recordingConfig,
  };
  // Post a recording notice to the meeting chat the moment the bot joins.
  if (noticeMessage && String(noticeMessage).trim()) {
    // Recall.ai requires send_to alongside the message; omitting it returns
    // 400 {"chat":{"on_bot_join":{"send_to":["This field is required."]}}}.
    body.chat = {
      on_bot_join: {
        message: String(noticeMessage).trim().slice(0, 4000),
        send_to: 'everyone',
      },
    };
  }
  return http('POST', '/bot/', body);
}

async function getBot(botId) {
  return http('GET', `/bot/${botId}/`);
}

async function getTranscript(botId) {
  return http('GET', `/bot/${botId}/transcript/`);
}

async function getVideo(botId) {
  // Returns the bot record with video_url populated once recording is processed.
  const bot = await getBot(botId);
  return bot.video_url || null;
}

async function listBots(limit = 10) {
  return http('GET', `/bot/?limit=${limit}`);
}

module.exports = {
  createBot,
  getBot,
  getTranscript,
  getVideo,
  listBots,
  region: RECALL_REGION,
};
