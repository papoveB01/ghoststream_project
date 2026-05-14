// SOCIAL ingestion lane — Phyllo (api.getphyllo.com).
//
// Auth: HTTP Basic with PHYLLO_CLIENT_ID:PHYLLO_CLIENT_SECRET.
// Endpoint: GET /v1/social/contents?account_id=...&from_date=...
//
// One Phyllo post becomes one kb_documents row. We do this — rather than
// rolling all posts up into a single "handle" document — so each post has
// its own effective_date and the retrieval recency tiebreaker can pick the
// freshest post per query. The title encodes platform + handle + date +
// short snippet to keep Library-tab rows readable.

// service.js is required lazily inside syncAccount() — see web.js for the
// full explanation. service.js imports this module for isConfigured()
// reflection in getStatus(), creating a circular require that captures an
// empty exports object if we require eagerly here.

const DEFAULT_LIMIT = parseInt(process.env.PHYLLO_DEFAULT_LIMIT || '50', 10);
const DEFAULT_LOOKBACK_DAYS = parseInt(process.env.PHYLLO_DEFAULT_LOOKBACK_DAYS || '30', 10);
const REQUEST_TIMEOUT_MS = parseInt(process.env.PHYLLO_TIMEOUT_MS || '30000', 10);

function isConfigured() {
  return Boolean(
    process.env.PHYLLO_CLIENT_ID &&
    process.env.PHYLLO_CLIENT_SECRET &&
    process.env.PHYLLO_BASE_URL
  );
}

function authHeader() {
  const id = process.env.PHYLLO_CLIENT_ID;
  const secret = process.env.PHYLLO_CLIENT_SECRET;
  return 'Basic ' + Buffer.from(`${id}:${secret}`, 'utf8').toString('base64');
}

function baseUrl() {
  return process.env.PHYLLO_BASE_URL.replace(/\/+$/, '');
}

async function listContents({ accountId, fromDate, toDate, limit = DEFAULT_LIMIT }) {
  if (!isConfigured()) {
    const err = new Error('Phyllo not configured (set PHYLLO_CLIENT_ID, PHYLLO_CLIENT_SECRET, PHYLLO_BASE_URL)');
    err.status = 503;
    throw err;
  }
  if (!accountId) {
    const err = new Error('accountId required (Phyllo connected-account id)');
    err.status = 400;
    throw err;
  }

  const params = new URLSearchParams();
  params.set('account_id', accountId);
  params.set('limit', String(Math.min(limit, 100)));
  if (fromDate) params.set('from_date', fromDate);
  if (toDate)   params.set('to_date', toDate);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl()}/v1/social/contents?${params}`, {
      headers: { Authorization: authHeader(), Accept: 'application/json' },
      signal: controller.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = body.error_message || body.detail || body.error || `HTTP ${res.status}`;
      const err = new Error(`Phyllo /social/contents failed: ${msg}`);
      err.status = res.status >= 400 && res.status < 600 ? res.status : 502;
      throw err;
    }
    return body;
  } catch (err) {
    if (err.name === 'AbortError') {
      const e = new Error(`Phyllo request timed out after ${REQUEST_TIMEOUT_MS}ms`);
      e.status = 504;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// "x · @ghoststream · 2026-05-10 — Excited to announce our new..."
function buildTitle(post) {
  const handle = post.account?.platform_username || post.account?.username || 'unknown';
  const platform = String(
    post.account?.work_platform?.name
    || post.account?.platform
    || 'social'
  ).toLowerCase();
  const when = post.published_at || post.created_at || new Date().toISOString();
  const dateStr = new Date(when).toISOString().slice(0, 10);
  const text = String(post.description || post.title || '').replace(/\s+/g, ' ').trim();
  const snippet = text.slice(0, 60);
  return `${platform} · ${handle} · ${dateStr}${snippet ? ' — ' + snippet : ''}`;
}

async function syncAccount({ tenantId = null, accountId, category, since, limit = DEFAULT_LIMIT, dryRun = false, productIds = null, personaIds = null, competitorIds = null, companyId = null, scope = 'TENANT' }) {
  const fromDate = since || new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 86400_000).toISOString();
  const payload = await listContents({ accountId, fromDate, limit });
  const posts = Array.isArray(payload.data) ? payload.data : [];

  if (dryRun) {
    return {
      dryRun: true,
      accountId,
      fromDate,
      fetched: posts.length,
      sample: posts.slice(0, 8).map((p) => {
        const text = String(p.description || p.title || '').trim();
        return {
          id: p.id,
          url: p.url,
          publishedAt: p.published_at || p.created_at || null,
          platform: (p.account && (p.account.work_platform && p.account.work_platform.name)) || (p.account && p.account.platform) || null,
          handle: p.account && p.account.platform_username || null,
          type: p.type || p.format || null,
          engagement: p.engagement || null,
          text: text.slice(0, 1200),
          textTruncated: text.length > 1200,
        };
      }),
    };
  }

  // Lazy require — see comment at top of file.
  const service = require('./service');

  const ingested = [];
  const skipped = [];
  for (const post of posts) {
    const text = String(post.description || post.title || '').trim();
    if (text.length < 10) {
      skipped.push({ id: post.id, reason: 'text too short' });
      continue;
    }
    try {
      const doc = await service.ingest({
        tenantId,
        file: {
          buffer: Buffer.from(text, 'utf8'),
          mimetype: 'text/plain',
          originalname: `${post.id || 'post'}.txt`,
        },
        category,
        title: buildTitle(post),
        metadata: {
          phyllo: {
            id: post.id,
            externalId: post.external_id,
            platform: post.account?.work_platform?.name || post.account?.platform,
            handle: post.account?.platform_username,
            engagement: post.engagement || null,
            type: post.type,
            format: post.format,
          },
        },
        streamType: 'SOCIAL',
        effectiveDate: post.published_at || post.created_at || new Date().toISOString(),
        sourceUrl: post.url,
        // All posts in one sync inherit the same engagement tags. Each post
        // gets its own kb_documents row, so tags are duplicated per post —
        // that's fine because the junction-table inserts are cheap.
        productIds,
        personaIds,
        competitorIds,
        companyId,
        scope,
      });
      ingested.push({ id: doc.id, title: doc.title, sourceUrl: post.url });
    } catch (err) {
      // Per-post failure must not abort the batch — log and skip.
      console.warn(`[social] skipped post ${post.id}: ${err.message}`);
      skipped.push({ id: post.id, reason: err.message });
    }
  }

  return {
    accountId,
    fromDate,
    fetched: posts.length,
    ingested: ingested.length,
    skipped: skipped.length,
    documents: ingested,
    skipReasons: skipped,
  };
}

module.exports = { isConfigured, listContents, syncAccount };
