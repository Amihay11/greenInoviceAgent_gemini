// Meta Graph API wrapper — Facebook Page + Instagram Business publishing & insights.
//
// Uses Graph API v21.0 endpoints. Two-step IG publish (container → publish_id) per
// https://developers.facebook.com/docs/instagram-platform/content-publishing/.
//
// Required env vars:
//   META_PAGE_ID         — your Facebook Page ID
//   META_PAGE_TOKEN      — long-lived Page access token (60-day TTL, renew when expired)
//   IG_BUSINESS_ID       — Instagram Business Account ID linked to that Page
//   META_AD_ACCOUNT_ID   — optional, for ad insights (act_XXXXX)
//
// All functions throw on API errors with the Meta-returned message.

const GRAPH = 'https://graph.facebook.com/v21.0';

function token() {
  const t = process.env.META_PAGE_TOKEN;
  if (!t) throw new Error('META_PAGE_TOKEN not set in .env');
  return t;
}

function pageId() {
  const id = process.env.META_PAGE_ID;
  if (!id) throw new Error('META_PAGE_ID not set in .env');
  return id;
}

function igId() {
  const id = process.env.IG_BUSINESS_ID;
  if (!id) throw new Error('IG_BUSINESS_ID not set in .env');
  return id;
}

export function isConfigured() {
  return Boolean(process.env.META_PAGE_TOKEN && (process.env.META_PAGE_ID || process.env.IG_BUSINESS_ID));
}

async function call(method, path, params = {}, body = null) {
  const url = new URL(`${GRAPH}${path}`);
  url.searchParams.set('access_token', token());
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  const opts = { method };
  if (body) {
    opts.body = JSON.stringify(body);
    opts.headers = { 'Content-Type': 'application/json' };
  }
  const res = await fetch(url.toString(), opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const msg = data.error?.message || res.statusText || 'Meta API error';
    const err = new Error(`Meta ${method} ${path} → ${msg}`);
    err.meta = data.error || data;
    throw err;
  }
  return data;
}

// ── Facebook Page ─────────────────────────────────────────────────────────────

export async function postToFacebookPage({ message, imageUrl = null, scheduledUnix = null }) {
  if (imageUrl) {
    const params = { url: imageUrl, caption: message };
    if (scheduledUnix) {
      params.published = false;
      params.scheduled_publish_time = scheduledUnix;
    }
    const res = await call('POST', `/${pageId()}/photos`, params);
    return { id: res.post_id || res.id, permalink: res.post_id ? `https://facebook.com/${res.post_id}` : null };
  }
  const params = { message };
  if (scheduledUnix) {
    params.published = false;
    params.scheduled_publish_time = scheduledUnix;
  }
  const res = await call('POST', `/${pageId()}/feed`, params);
  return { id: res.id, permalink: res.id ? `https://facebook.com/${res.id}` : null };
}

export async function pageInsights({ since = null, until = null } = {}) {
  const metrics = 'page_impressions,page_engaged_users,page_post_engagements,page_fans';
  const params = { metric: metrics, period: 'day' };
  if (since) params.since = since;
  if (until) params.until = until;
  return call('GET', `/${pageId()}/insights`, params);
}

// ── Instagram Business (two-step publish) ────────────────────────────────────

export async function postToInstagram({ caption, imageUrl }) {
  if (!imageUrl) throw new Error('Instagram requires an imageUrl');
  // Step 1: create container.
  const created = await call('POST', `/${igId()}/media`, {
    image_url: imageUrl,
    caption,
  });
  const containerId = created.id;

  // Step 2: poll status until FINISHED, then publish.
  const status = await waitForContainerReady(containerId);
  if (status !== 'FINISHED') {
    throw new Error(`IG container not ready: status=${status}`);
  }

  const published = await call('POST', `/${igId()}/media_publish`, { creation_id: containerId });
  const mediaId = published.id;

  let permalink = null;
  try {
    const meta = await call('GET', `/${mediaId}`, { fields: 'permalink' });
    permalink = meta.permalink || null;
  } catch (_) { /* permalink is best-effort */ }

  return { id: mediaId, permalink };
}

async function waitForContainerReady(containerId, maxAttempts = 12, delayMs = 2500) {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await call('GET', `/${containerId}`, { fields: 'status_code' });
    const code = res.status_code;
    if (code === 'FINISHED') return 'FINISHED';
    if (code === 'ERROR' || code === 'EXPIRED') return code;
    await new Promise(r => setTimeout(r, delayMs));
  }
  return 'IN_PROGRESS';
}

export async function instagramInsights({ days = 14 } = {}) {
  const metrics = 'impressions,reach,profile_views,follower_count';
  return call('GET', `/${igId()}/insights`, { metric: metrics, period: 'day', metric_type: 'total_value' });
}

export async function recentPagePosts(limit = 10) {
  return call('GET', `/${pageId()}/posts`, { limit, fields: 'id,message,created_time,permalink_url' });
}

export async function recentInstagramMedia(limit = 10) {
  return call('GET', `/${igId()}/media`, { limit, fields: 'id,caption,media_type,permalink,timestamp,like_count,comments_count' });
}

// ── Ad insights (optional) ────────────────────────────────────────────────────

export async function adAccountInsights({ days = 7 } = {}) {
  const adAct = process.env.META_AD_ACCOUNT_ID;
  if (!adAct) throw new Error('META_AD_ACCOUNT_ID not set');
  return call('GET', `/${adAct}/insights`, {
    fields: 'spend,impressions,clicks,ctr,cpc,reach,actions',
    date_preset: `last_${days}d`,
  });
}
