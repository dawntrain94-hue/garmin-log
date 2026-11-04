// Vercel serverless function: YMC <-> Intervals.icu proxy
// Keeps the Intervals.icu API key on the server (never shipped to the browser).
//
// Required Vercel environment variables:
//   INTERVALS_API_KEY     - intervals.icu → Settings → Developer Settings → API Key
//   INTERVALS_ATHLETE_ID  - e.g. i123456 (from the URL when logged in). "0" = key owner.
//   YMC_SECRET            - any long random string; YMC sends it in the x-ymc-secret header
//
// Endpoints:
//   GET /api/intervals?action=list&oldest=2026-10-01&newest=2026-11-04
//   GET /api/intervals?action=gpx&id=i123456789

import { gunzipSync } from 'node:zlib';

const BASE = 'https://intervals.icu/api/v1';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^i?\d+$/;

function authHeader() {
  const token = Buffer.from(`API_KEY:${process.env.INTERVALS_API_KEY}`).toString('base64');
  return `Basic ${token}`;
}

// The app may be opened from a branch/preview URL (garmin-log-git-main-….vercel.app),
// which Vercel's Standard Protection guards. The client always calls the production
// API instead, so allow those sibling origins via CORS.
const ALLOWED_ORIGIN = /^https:\/\/garmin-log(-[a-z0-9-]+)?\.vercel\.app$/;

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGIN.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'x-ymc-secret');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();

  // The app is public, so block anyone who doesn't know the secret.
  const norm = (s) => String(s || '').normalize('NFKC').trim().replace(/^["']|["']$/g, '');
  const serverSecret = norm(process.env.YMC_SECRET);
  if (!serverSecret) {
    return res.status(500).json({ error: '서버에 YMC_SECRET이 없어요 (환경변수 추가 후 Redeploy 필요)' });
  }
  if (!process.env.INTERVALS_API_KEY) {
    return res.status(500).json({ error: '서버에 INTERVALS_API_KEY가 없어요 (환경변수 추가 후 Redeploy 필요)' });
  }
  let raw = req.headers['x-ymc-secret'] || '';
  try { raw = decodeURIComponent(raw); } catch { /* not encoded */ }
  const sent = norm(raw);
  if (sent !== serverSecret) {
    // 값은 절대 돌려주지 않고, 어디서 어긋나는지만 알려줌
    return res.status(401).json({
      error: 'unauthorized',
      sentLength: sent.length,
      serverLength: serverSecret.length,
      caseOnly: sent.toLowerCase() === serverSecret.toLowerCase(),
    });
  }

  const { action, oldest, newest, id } = req.query;
  const athlete = process.env.INTERVALS_ATHLETE_ID || '0';

  try {
    if (action === 'list') {
      const end = newest || oldest;
      if (!DATE_RE.test(oldest || '') || !DATE_RE.test(end || '')) {
        return res.status(400).json({ error: 'oldest/newest must be YYYY-MM-DD' });
      }
      const r = await fetch(
        `${BASE}/athlete/${athlete}/activities?oldest=${oldest}&newest=${end}`,
        { headers: { Authorization: authHeader() } }
      );
      if (!r.ok) return res.status(r.status).json({ error: await r.text() });

      const data = await r.json();
      const activities = data.map((a) => ({
        id: a.id,
        name: a.name,
        type: a.type,
        start: a.start_date_local,
        distance: a.distance,           // m
        movingTime: a.moving_time,      // s
        elapsedTime: a.elapsed_time,    // s
        avgHr: a.average_heartrate,
        maxHr: a.max_heartrate,
        elevationGain: a.total_elevation_gain,
        load: a.icu_training_load,
        device: a.device_name,
        source: a.source,
        // Strava-synced activities come back as stubs with a _note and no data
        unavailable: Boolean(a._note),
        note: a._note,
      }));
      return res.status(200).json(activities);
    }

    if (action === 'gpx') {
      if (!ID_RE.test(id || '')) return res.status(400).json({ error: 'invalid id' });
      const r = await fetch(`${BASE}/activity/${id}/gpx-file`, {
        headers: { Authorization: authHeader() },
      });
      if (!r.ok) return res.status(r.status).json({ error: await r.text() });

      let buf = Buffer.from(await r.arrayBuffer());
      if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf); // gzipped response
      res.setHeader('Content-Type', 'application/gpx+xml; charset=utf-8');
      return res.status(200).send(buf.toString('utf8'));
    }

    return res.status(400).json({ error: 'action must be list or gpx' });
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e) });
  }
}
