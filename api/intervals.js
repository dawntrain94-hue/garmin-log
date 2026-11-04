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
//   GET /api/intervals?action=wellness&oldest=2026-09-01&newest=2026-11-04
//   GET /api/intervals?action=profile

import { gunzipSync, gzipSync } from 'node:zlib';

const BASE = 'https://intervals.icu/api/v1';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^i?\d+$/;

const clean = (s) => String(s || '').normalize('NFKC').trim().replace(/^["']|["']$/g, '');

function authHeader() {
  const token = Buffer.from(`API_KEY:${clean(process.env.INTERVALS_API_KEY)}`).toString('base64');
  return `Basic ${token}`;
}

// The app may be opened from a branch/preview URL (garmin-log-git-main-….vercel.app),
// which Vercel's Standard Protection guards. The client always calls the production
// API instead, so allow those sibling origins via CORS.
const ALLOWED_ORIGIN = /^https:\/\/garmin-log(-[a-z0-9-]+)?\.vercel\.app$/;

// Rewrite a GPX down to the fields parseActivityGPX uses: lat/lon, ele, time, hr, power, plus name/type.
// Namespaced tags (gpxtpx:hr, ns3:power …) are matched by local name.
export function slimGpx(text) {
  const tag = (inner, names) => {
    const re = new RegExp(`<(?:[\\w-]+:)?(?:${names})\\b[^>]*>\\s*([^<\\s][^<]*?)\\s*</(?:[\\w-]+:)?(?:${names})>`, 'i');
    const m = inner.match(re);
    return m ? m[1] : null;
  };
  const esc = (s) => s.replace(/&(?!amp;|lt;|gt;|quot;|apos;|#)/g, '&amp;').replace(/</g, '&lt;');
  const head = text.split(/<trkpt\b/i)[0];
  const name = tag(head, 'name');
  const type = tag(head, 'type');

  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<gpx version="1.1" creator="YMC" xmlns="http://www.topografix.com/GPX/1/1">', '<trk>'];
  if (name) out.push(`<name>${esc(name)}</name>`);
  if (type) out.push(`<type>${esc(type)}</type>`);
  out.push('<trkseg>');

  const pt = /<trkpt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/trkpt>)/gi;
  let m, count = 0;
  while ((m = pt.exec(text))) {
    const lat = (m[1].match(/\blat\s*=\s*["']([^"']+)["']/) || [])[1];
    const lon = (m[1].match(/\blon\s*=\s*["']([^"']+)["']/) || [])[1];
    if (!lat || !lon) continue;
    const inner = m[2] || '';
    const ele = tag(inner, 'ele'), time = tag(inner, 'time');
    const hr = tag(inner, 'hr|heartrate'), pwr = tag(inner, 'power|watts');
    out.push(`<trkpt lat="${lat}" lon="${lon}">` +
      (ele ? `<ele>${ele}</ele>` : '') + (time ? `<time>${time}</time>` : '') +
      (hr ? `<hr>${hr}</hr>` : '') + (pwr ? `<power>${pwr}</power>` : '') + '</trkpt>');
    count++;
  }
  out.push('</trkseg>', '</trk>', '</gpx>');
  return count ? out.join('\n') : text; // nothing recognised → leave untouched
}

const num = (v) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : null);

// Intervals.icu wellness row → the few fields YMC uses (id is the date, YYYY-MM-DD)
function toWellness(w) {
  if (!w || !DATE_RE.test(w.id || '')) return null;
  const row = {
    date: w.id,
    hrv: num(w.hrv),                 // rMSSD, ms
    restingHR: num(w.restingHR),
    vo2max: num(w.vo2max),
    weight: num(w.weight),           // kg
    sleepHours: num(w.sleepSecs) ? +(w.sleepSecs / 3600).toFixed(2) : null,
    sleepScore: num(w.sleepScore),
  };
  const hasAny = Object.keys(row).some((k) => k !== 'date' && row[k] != null);
  return hasAny ? row : null;
}

// Never pass Intervals.icu's own 401/403 through: the app would mistake it for our secret check
async function upstreamError(res, r) {
  const msg = {
    401: 'Intervals.icu가 API 키를 거절했어요. INTERVALS_API_KEY를 확인해 주세요',
    403: 'Intervals.icu 접근이 거부됐어요. INTERVALS_ATHLETE_ID가 API 키 주인과 같은지 확인해 주세요',
    404: 'Intervals.icu에서 찾을 수 없어요. INTERVALS_ATHLETE_ID를 확인해 주세요',
    429: 'Intervals.icu 요청이 너무 많아요. 잠시 후 다시 시도해 주세요',
  }[r.status] || `Intervals.icu 오류 (${r.status})`;
  return res.status(502).json({ error: msg, upstreamStatus: r.status });
}

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
  let athlete = clean(process.env.INTERVALS_ATHLETE_ID).toLowerCase() || '0';
  if (/^[1-9]\d*$/.test(athlete)) athlete = 'i' + athlete; // 숫자만 넣은 경우
  const found = athlete.match(/(?:^|[^a-z0-9])(i\d+)(?:$|[^0-9])/); if (found) athlete = found[1]; // URL째 붙여넣은 경우
  if (!/^(0|i\d+)$/.test(athlete)) {
    return res.status(500).json({ error: `INTERVALS_ATHLETE_ID 형식이 이상해요 ("i" + 숫자, 예: i123456). 지금 ${athlete.length}자` });
  }

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
      if (!r.ok) return upstreamError(res, r);

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

    if (action === 'wellness') {
      const end = newest || oldest;
      if (!DATE_RE.test(oldest || '') || !DATE_RE.test(end || '')) {
        return res.status(400).json({ error: 'oldest/newest must be YYYY-MM-DD' });
      }
      const r = await fetch(`${BASE}/athlete/${athlete}/wellness?oldest=${oldest}&newest=${end}`, {
        headers: { Authorization: authHeader() },
      });
      if (!r.ok) return upstreamError(res, r);
      const data = await r.json();
      return res.status(200).json((Array.isArray(data) ? data : []).map(toWellness).filter(Boolean));
    }

    if (action === 'profile') {
      const r = await fetch(`${BASE}/athlete/${athlete}/sport-settings`, {
        headers: { Authorization: authHeader() },
      });
      if (!r.ok) return upstreamError(res, r);
      const settings = await r.json();
      const pick = (type) => (Array.isArray(settings) ? settings : [])
        .find((s) => Array.isArray(s.types) && s.types.includes(type)) || null;
      const run = pick('Run'), ride = pick('Ride');
      return res.status(200).json({
        run: run && {
          lthr: num(run.lthr),
          maxHr: num(run.max_hr),
          // threshold_pace is stored as speed in m/s → min/km
          thresholdPaceMinKm: num(run.threshold_pace) ? +(1000 / run.threshold_pace / 60).toFixed(3) : null,
        },
        ride: ride && {
          ftp: num(ride.ftp),
          lthr: num(ride.lthr),
          maxHr: num(ride.max_hr),
        },
      });
    }

    if (action === 'gpx') {
      if (!ID_RE.test(id || '')) return res.status(400).json({ error: 'invalid id' });
      const r = await fetch(`${BASE}/activity/${id}/gpx-file`, {
        headers: { Authorization: authHeader() },
      });
      if (!r.ok) return upstreamError(res, r);

      let buf = Buffer.from(await r.arrayBuffer());
      if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf); // gzipped response

      // Vercel caps a function response at 4.5 MB; a long ride's GPX easily exceeds that.
      // Keep only what YMC reads, then gzip (≈10x smaller again).
      const slim = gzipSync(Buffer.from(slimGpx(buf.toString('utf8')), 'utf8'));
      res.setHeader('Content-Type', 'application/gpx+xml; charset=utf-8');
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('X-Original-Bytes', String(buf.length));
      return res.status(200).send(slim);
    }

    return res.status(400).json({ error: 'action must be list, gpx, wellness or profile' });
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e) });
  }
}
