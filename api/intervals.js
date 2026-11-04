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

export default async function handler(req, res) {
  // The app is public, so block anyone who doesn't know the secret.
  if (!process.env.YMC_SECRET || req.headers['x-ymc-secret'] !== process.env.YMC_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!process.env.INTERVALS_API_KEY) {
    return res.status(500).json({ error: 'INTERVALS_API_KEY is not set' });
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
