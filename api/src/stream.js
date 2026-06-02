// Cloudflare Stream client. Used to clip identified Moments-of-Truth.
//
// Stream API is gated behind CLOUDFLARE_STREAM_API_TOKEN. If the token isn't
// configured we return MOCK clip records so the rest of the pipeline (analysis
// → portal → UI) keeps working in dev. When the token is added later, the
// same call paths produce real clips with zero code changes.

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || '';
const STREAM_TOKEN = process.env.CLOUDFLARE_STREAM_API_TOKEN || '';
const CUSTOMER_SUBDOMAIN =
  process.env.CLOUDFLARE_STREAM_CUSTOMER_SUBDOMAIN ||
  'customer-default.cloudflarestream.com';

function isConfigured() {
  return Boolean(ACCOUNT_ID && STREAM_TOKEN);
}

async function http(method, path, body) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${STREAM_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Cloudflare Stream ${method} ${path} ${res.status}: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text);
}

// Uploads a source video URL to Stream (copy-from-URL). Returns the Stream uid.
async function ingestFromUrl(videoUrl, name = 'GhostStream call') {
  if (!isConfigured()) {
    return {
      uid: 'mock_' + Math.random().toString(36).slice(2, 12),
      mock: true,
      reason: 'CLOUDFLARE_STREAM_API_TOKEN not set',
      sourceUrl: videoUrl,
    };
  }
  const r = await http('POST', '/stream/copy', { url: videoUrl, meta: { name } });
  return r.result;
}

// Creates a clip from a parent Stream video.
//   videoUid: parent video on Stream
//   startSeconds, endSeconds: clip range
async function createClip({ videoUid, startSeconds, endSeconds, label }) {
  if (!isConfigured() || (videoUid && videoUid.startsWith('mock_'))) {
    return {
      uid: 'mock_clip_' + Math.random().toString(36).slice(2, 12),
      mock: true,
      reason: !isConfigured() ? 'CLOUDFLARE_STREAM_API_TOKEN not set' : 'mock parent video',
      parent: videoUid,
      clipFrom: startSeconds,
      clipTo: endSeconds,
      playbackUrl: 'https://www.w3.org/2010/05/sintel/trailer.mp4', // public demo video for dev
      hlsUrl: null,
      label: label || null,
    };
  }
  const r = await http('POST', `/stream/${videoUid}/clip`, {
    clippedFromVideoUID: videoUid,
    startTimeSeconds: startSeconds,
    endTimeSeconds: endSeconds,
    meta: { name: label || `clip ${startSeconds}-${endSeconds}` },
  });
  const clipUid = r.result.uid;
  return {
    uid: clipUid,
    parent: videoUid,
    clipFrom: startSeconds,
    clipTo: endSeconds,
    playbackUrl: `https://${CUSTOMER_SUBDOMAIN}/${clipUid}/manifest/video.m3u8`,
    hlsUrl: `https://${CUSTOMER_SUBDOMAIN}/${clipUid}/manifest/video.m3u8`,
    label: label || null,
  };
}

// Delete a Stream video/clip by uid (tenant erasure). Best-effort; a 404 (already
// gone) is treated as success.
async function deleteVideo(uid) {
  if (!uid || !isConfigured()) return false;
  try {
    await http('DELETE', `/stream/${encodeURIComponent(uid)}`);
    return true;
  } catch (err) {
    if (/\b404\b/.test(err.message)) return true;
    throw err;
  }
}

module.exports = { isConfigured, ingestFromUrl, createClip, deleteVideo };
