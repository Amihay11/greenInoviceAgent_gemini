// Canva Connect REST wrapper. No public Canva MCP exists yet, so we call the
// REST API directly per https://www.canva.dev/docs/connect/.
//
// OAuth 2.0 with PKCE. Setup is one-time:
//   node agent/scripts/canva-oauth.js
// which walks the PKCE dance and saves CANVA_REFRESH_TOKEN to .env.
//
// Required env vars:
//   CANVA_CLIENT_ID, CANVA_CLIENT_SECRET, CANVA_REFRESH_TOKEN

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const API = 'https://api.canva.com/rest/v1';

let cachedAccessToken = null;
let cachedExpiry = 0;

export function isConfigured() {
  return Boolean(
    process.env.CANVA_CLIENT_ID &&
    process.env.CANVA_CLIENT_SECRET &&
    process.env.CANVA_REFRESH_TOKEN
  );
}

async function getAccessToken() {
  if (cachedAccessToken && Date.now() < cachedExpiry - 60_000) return cachedAccessToken;
  if (!isConfigured()) throw new Error('Canva not configured (CANVA_CLIENT_ID / CANVA_CLIENT_SECRET / CANVA_REFRESH_TOKEN)');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: process.env.CANVA_REFRESH_TOKEN,
  });
  const auth = Buffer.from(`${process.env.CANVA_CLIENT_ID}:${process.env.CANVA_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${auth}`,
    },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`Canva token refresh failed: ${data.error_description || data.error || res.statusText}`);
  }
  cachedAccessToken = data.access_token;
  cachedExpiry = Date.now() + ((data.expires_in || 3600) * 1000);

  if (data.refresh_token && data.refresh_token !== process.env.CANVA_REFRESH_TOKEN) {
    process.env.CANVA_REFRESH_TOKEN = data.refresh_token;
    try {
      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const envPath = path.join(__dirname, '..', '.env');
      if (fs.existsSync(envPath)) {
        let content = fs.readFileSync(envPath, 'utf8');
        content = content.replace(/^CANVA_REFRESH_TOKEN=.*$/m, `CANVA_REFRESH_TOKEN=${data.refresh_token}`);
        fs.writeFileSync(envPath, content);
      }
    } catch (err) {
      console.error('[Canva] Failed to update CANVA_REFRESH_TOKEN in .env:', err.message);
    }
  }

  return cachedAccessToken;
}

async function call(method, path, { params = null, body = null } = {}) {
  const token = await getAccessToken();
  const url = new URL(`${API}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  const opts = { method, headers: { Authorization: `Bearer ${token}` } };
  if (body) {
    opts.body = JSON.stringify(body);
    opts.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url.toString(), opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Canva ${method} ${path} → ${data.message || data.error || res.statusText}`);
  }
  return data;
}

// ── Designs (read for style derivation) ──────────────────────────────────────

export async function listDesigns({ limit = 20, query = null } = {}) {
  const data = await call('GET', '/designs', {
    params: { limit, ...(query ? { query } : {}) },
  });
  return Array.isArray(data?.items) ? data.items : (Array.isArray(data?.data) ? data.data : []);
}

export async function getDesign(id) {
  return call('GET', `/designs/${encodeURIComponent(id)}`);
}

// ── Brand templates (Canva Pro) ──────────────────────────────────────────────

export async function listBrandTemplates({ limit = 20 } = {}) {
  try {
    const data = await call('GET', '/brand-templates', { params: { limit } });
    return Array.isArray(data?.items) ? data.items : [];
  } catch (e) {
    // Brand templates require Pro — return empty if unavailable rather than throw.
    return [];
  }
}

// ── Create + export ──────────────────────────────────────────────────────────

export async function createDesign({ title, design_type = 'instagram_post', brand_template_id = null, asset_id = null, styleProfile = null }) {
  const body = { title };
  if (brand_template_id) {
    body.brand_template_id = brand_template_id;
  } else {
    body.design_type = { type: 'preset', name: design_type };
  }
  if (asset_id) {
    body.asset_id = asset_id;
  }
  if (styleProfile?.preferred_design_types?.length && !brand_template_id) {
    // Override default with the user's typical type.
    body.design_type = { type: 'preset', name: styleProfile.preferred_design_types[0] };
  }
  return call('POST', '/designs', { body });
}

// Polls until the export is FINISHED. Returns the export URLs (typically PNGs).
export async function exportDesign(designId, { format = 'png', maxAttempts = 12, delayMs = 2500 } = {}) {
  const job = await call('POST', '/exports', {
    body: { design_id: designId, format: { type: format } },
  });
  const jobId = job?.job?.id || job?.id;
  if (!jobId) throw new Error('Canva export: no job id returned');

  for (let i = 0; i < maxAttempts; i++) {
    const status = await call('GET', `/exports/${encodeURIComponent(jobId)}`);
    const state = status?.job?.status || status?.status;
    if (state === 'success' || state === 'FINISHED' || state === 'completed') {
      const urls = status?.job?.urls || status?.urls;
      const single = status?.job?.url || status?.url;
      return { urls: urls || (single ? [single] : []), url: single || (urls && urls[0]) || null, raw: status };
    }
    if (state === 'failed' || state === 'error') {
      throw new Error(`Canva export failed: ${JSON.stringify(status).slice(0, 200)}`);
    }
    await new Promise(r => setTimeout(r, delayMs));
  }
  throw new Error('Canva export timed out');
}

export async function uploadAsset({ buffer, filename, mimeType = 'image/png' }) {
  const token = await getAccessToken();
  const res = await fetch(`${API}/asset-uploads`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': mimeType,
      'Asset-Upload-Metadata': JSON.stringify({ name_base64: Buffer.from(filename).toString('base64') }),
    },
    body: buffer,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Canva upload failed: ${data.message || res.statusText}`);
  return data;
}
