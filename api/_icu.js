// Shared Intervals.icu helpers for /api/intervals (YMC app) and /api/mcp (Claude connector).
// Files starting with "_" in /api are not deployed as routes on Vercel.

import { gunzipSync } from 'node:zlib';

export const BASE = 'https://intervals.icu/api/v1';
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const ID_RE = /^i?\d+$/;

export const clean = (s) => String(s || '').normalize('NFKC').trim().replace(/^["']|["']$/g, '');
export const num = (v) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : null);

export function authHeader() {
  const token = Buffer.from(`API_KEY:${clean(process.env.INTERVALS_API_KEY)}`).toString('base64');
  return `Basic ${token}`;
}

// Returns "0" / "i123456", or null if the env value is unusable
export function resolveAthlete() {
  let athlete = clean(process.env.INTERVALS_ATHLETE_ID).toLowerCase() || '0';
  if (/^[1-9]\d*$/.test(athlete)) athlete = 'i' + athlete; // 숫자만 넣은 경우
  const found = athlete.match(/(?:^|[^a-z0-9])(i\d+)(?:$|[^0-9])/); if (found) athlete = found[1]; // URL째 붙여넣은 경우
  return /^(0|i\d+)$/.test(athlete) ? athlete : null;
}

// "/athlete/<id>" 또는 null
export function athletePathOrNull() { const a = resolveAthlete(); return a ? `/athlete/${a}` : null; }

export const UPSTREAM_MSG = {
  401: 'Intervals.icu가 API 키를 거절했어요. INTERVALS_API_KEY를 확인해 주세요',
  403: 'Intervals.icu 접근이 거부됐어요. INTERVALS_ATHLETE_ID가 API 키 주인과 같은지 확인해 주세요',
  404: 'Intervals.icu에서 찾을 수 없어요. INTERVALS_ATHLETE_ID를 확인해 주세요',
  429: 'Intervals.icu 요청이 너무 많아요. 잠시 후 다시 시도해 주세요',
};
export const upstreamMessage = (status) => UPSTREAM_MSG[status] || `Intervals.icu 오류 (${status})`;

export class UpstreamError extends Error {
  constructor(status) { super(upstreamMessage(status)); this.status = status; }
}

// GET JSON from Intervals.icu; throws UpstreamError on non-2xx
export async function icuJson(path) {
  const r = await fetch(`${BASE}${path}`, { headers: { Authorization: authHeader() } });
  if (!r.ok) throw new UpstreamError(r.status);
  return r.json();
}

// PUT JSON (캘린더 이벤트 설명란에 대회 전 예측을 저장할 때만 씀)
export async function icuPut(path, body) {
  const r = await fetch(`${BASE}${path}`, { method: 'PUT', headers: { Authorization: authHeader(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new UpstreamError(r.status);
  return r.json().catch(() => null);
}

// POST JSON (계획 훈련을 캘린더에 등록할 때만 씀)
export async function icuPost(path, body) {
  const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: { Authorization: authHeader(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new UpstreamError(r.status);
  return r.json().catch(() => null);
}

// GET an activity's GPX as text (handles gzipped responses)
export async function icuGpxText(id) {
  const r = await fetch(`${BASE}/activity/${id}/gpx-file`, { headers: { Authorization: authHeader() } });
  if (!r.ok) throw new UpstreamError(r.status);
  let buf = Buffer.from(await r.arrayBuffer());
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
  return { text: buf.toString('utf8'), bytes: buf.length };
}

// Intervals.icu wellness row → the fields YMC uses (id is the date, YYYY-MM-DD)
export function toWellness(w) {
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

// Sport settings array → { run, ride } thresholds
export function toSettings(settings) {
  const pick = (type) => (Array.isArray(settings) ? settings : [])
    .find((s) => Array.isArray(s.types) && s.types.includes(type)) || null;
  const run = pick('Run'), ride = pick('Ride');
  return {
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
  };
}

const gpxTag = (inner, names) => {
  const re = new RegExp(`<(?:[\\w-]+:)?(?:${names})\\b[^>]*>\\s*([^<\\s][^<]*?)\\s*</(?:[\\w-]+:)?(?:${names})>`, 'i');
  const m = inner.match(re);
  return m ? m[1] : null;
};
const TRKPT = /<trkpt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/trkpt>)/gi;

// Rewrite a GPX down to the fields parseActivityGPX uses: lat/lon, ele, time, hr, power, plus name/type.
// Namespaced tags (gpxtpx:hr, ns3:power …) are matched by local name.
export function slimGpx(text) {
  const esc = (s) => s.replace(/&(?!amp;|lt;|gt;|quot;|apos;|#)/g, '&amp;').replace(/</g, '&lt;');
  const head = text.split(/<trkpt\b/i)[0];
  const name = gpxTag(head, 'name');
  const type = gpxTag(head, 'type');

  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<gpx version="1.1" creator="YMC" xmlns="http://www.topografix.com/GPX/1/1">', '<trk>'];
  if (name) out.push(`<name>${esc(name)}</name>`);
  if (type) out.push(`<type>${esc(type)}</type>`);
  out.push('<trkseg>');

  const pt = new RegExp(TRKPT.source, 'gi');
  let m, count = 0;
  while ((m = pt.exec(text))) {
    const lat = (m[1].match(/\blat\s*=\s*["']([^"']+)["']/) || [])[1];
    const lon = (m[1].match(/\blon\s*=\s*["']([^"']+)["']/) || [])[1];
    if (!lat || !lon) continue;
    const inner = m[2] || '';
    const ele = gpxTag(inner, 'ele'), time = gpxTag(inner, 'time');
    const hr = gpxTag(inner, 'hr|heartrate'), pwr = gpxTag(inner, 'power|watts');
    out.push(`<trkpt lat="${lat}" lon="${lon}">` +
      (ele ? `<ele>${ele}</ele>` : '') + (time ? `<time>${time}</time>` : '') +
      (hr ? `<hr>${hr}</hr>` : '') + (pwr ? `<power>${pwr}</power>` : '') + '</trkpt>');
    count++;
  }
  out.push('</trkseg>', '</trk>', '</gpx>');
  return count ? out.join('\n') : text; // nothing recognised → leave untouched
}

// [[unixSeconds, watts], ...] from a GPX (same rules as the app's parser: 0 ≤ W < 2000)
export function gpxPowerSeries(text) {
  const pt = new RegExp(TRKPT.source, 'gi');
  const series = [];
  let m;
  while ((m = pt.exec(text))) {
    const inner = m[2] || '';
    const time = gpxTag(inner, 'time'), pwr = gpxTag(inner, 'power|watts');
    if (!time || pwr == null) continue;
    const w = parseInt(pwr, 10), t = Date.parse(time) / 1000;
    if (w >= 0 && w < 2000 && t) series.push([t, w]);
  }
  return series;
}

// Same normalisation for the shared secret everywhere
export const normSecret = (s) => String(s || '').normalize('NFKC').trim().replace(/^["']|["']$/g, '');

// DELETE (계획 훈련 삭제 전용)
export async function icuDelete(path) {
  const r = await fetch(`${BASE}${path}`, { method: 'DELETE', headers: { Authorization: authHeader() } });
  if (!r.ok) throw new UpstreamError(r.status);
  return true;
}
