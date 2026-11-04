// YMC MCP server (Streamable HTTP, stateless, read-only) — lets Claude read your training data.
//
// Add in claude.ai → Customize → Connectors → Add custom connector
//   URL:    https://garmin-log.vercel.app/api/mcp
//   Header: Authorization: Bearer <YMC_SECRET>
//
// Data comes live from Intervals.icu with the server's INTERVALS_API_KEY. The cycling-intensity and
// recovery numbers use the same code as the YMC app (src/intensity.js, src/wellness.js).

import {
  DATE_RE, ID_RE, num, resolveAthlete, icuJson, icuGpxText, toWellness, toSettings,
  gpxPowerSeries, UpstreamError, normSecret,
} from './_icu.js';
import { buildPowerBins, sustainedMinutes } from '../src/intensity.js';
import { computeWellnessStatus } from '../src/wellness.js';

const SERVER_INFO = { name: 'ymc-training', title: 'YMC 훈련 기록', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const INSTRUCTIONS = [
  'YMC training data for one athlete (trail running, road running, cycling/granfondo, MTB), read live from Intervals.icu (synced from Garmin).',
  'Dates are the athlete\'s local dates (Asia/Seoul). Distances km, durations minutes, power W, HR bpm, pace min/km.',
  'Training load / fitness / fatigue / form are Intervals.icu\'s own model, not YMC\'s TRIMP model; say so when quoting them.',
  'Thresholds come from the athlete\'s Intervals.icu settings, which are entered manually and can be out of date.',
  'Start with get_training_overview for general questions; drill down with the other tools.',
].join(' ');

const RIDE_TYPES = new Set(['Ride', 'VirtualRide', 'GravelRide', 'EBikeRide', 'MountainBikeRide']);
const RUN_TYPES = new Set(['Run', 'TrailRun', 'VirtualRun']);
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

// ── date helpers (athlete is in Asia/Seoul)
const TZ_OFFSET_MS = 9 * 3600 * 1000;
function todayLocal() { return new Date(Date.now() + TZ_OFFSET_MS).toISOString().slice(0, 10); }
function addDays(dateStr, n) { const d = new Date(dateStr + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function range(args, defDays, maxDays) {
  const newest = DATE_RE.test(args.newest || '') ? args.newest : todayLocal();
  let oldest = DATE_RE.test(args.oldest || '') ? args.oldest : null;
  const days = Math.min(maxDays, Math.max(1, parseInt(args.days, 10) || defDays));
  if (!oldest) oldest = addDays(newest, -(days - 1));
  if (oldest > newest) throw new ToolError('oldest가 newest보다 늦어요');
  const span = (Date.parse(newest) - Date.parse(oldest)) / 86400000 + 1;
  if (span > maxDays) throw new ToolError(`기간은 최대 ${maxDays}일이에요`);
  return { oldest, newest };
}
const weekStart = (dateStr) => { const d = new Date(dateStr + 'T00:00:00Z'); const dow = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - dow); return d.toISOString().slice(0, 10); };

class ToolError extends Error {}

function athletePath() {
  const a = resolveAthlete();
  if (!a) throw new ToolError('서버의 INTERVALS_ATHLETE_ID 형식이 이상해요 ("i" + 숫자 또는 0)');
  return `/athlete/${a}`;
}

// Intervals.icu activity → compact row
function toActivity(a) {
  const km = num(a.distance) ? a.distance / 1000 : null;
  const movingMin = num(a.moving_time) ? a.moving_time / 60 : null;
  const isRun = RUN_TYPES.has(a.type);
  return {
    id: a.id,
    date: String(a.start_date_local || '').slice(0, 10),
    start: a.start_date_local || null,
    name: a.name || null,
    type: a.type || null,
    km: r1(km),
    movingMin: movingMin ? Math.round(movingMin) : null,
    elevationGain: num(a.total_elevation_gain) ? Math.round(a.total_elevation_gain) : null,
    avgHR: num(a.average_heartrate) ? Math.round(a.average_heartrate) : null,
    maxHR: num(a.max_heartrate) ? Math.round(a.max_heartrate) : null,
    avgPower: num(a.icu_average_watts) ? Math.round(a.icu_average_watts) : null,
    normalizedPower: num(a.icu_weighted_avg_watts) ? Math.round(a.icu_weighted_avg_watts) : null,
    intensityFactor: num(a.icu_intensity) ? +(a.icu_intensity / 100).toFixed(2) : null,
    load: num(a.icu_training_load) ? Math.round(a.icu_training_load) : null,
    paceMinKm: isRun && km && movingMin ? +(movingMin / km).toFixed(2) : null,
    device: a.device_name || null,
    dataUnavailable: a._note ? 'Strava를 거쳐 들어온 활동이라 Intervals.icu가 상세 데이터를 주지 않음' : undefined,
  };
}

async function fetchActivities(oldest, newest) {
  const data = await icuJson(`${athletePath()}/activities?oldest=${oldest}&newest=${newest}`);
  return (Array.isArray(data) ? data : []).map(toActivity);
}

async function fetchSettings() {
  return toSettings(await icuJson(`${athletePath()}/sport-settings`));
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch (e) { out[k] = { error: e.message || String(e) }; } }
  }));
  return out;
}

async function rideSustained(id, ftp) {
  const { text } = await icuGpxText(id);
  const bins = buildPowerBins(gpxPowerSeries(text));
  if (!bins) return { noPowerDetail: true };
  return {
    sweetSpotPlusMin: Math.round(sustainedMinutes(bins, ftp, 0.85, 2)),  // ≥85% FTP, blocks ≥2 min
    thresholdPlusMin: Math.round(sustainedMinutes(bins, ftp, 0.95, 2)),  // ≥95% FTP, blocks ≥2 min
  };
}

// ── tools
const TOOLS = [
  {
    name: 'get_training_overview',
    title: '훈련 개요',
    description: 'Big-picture view for the last N weeks (default 6): weekly hours/km/elevation/load per sport, current fitness/fatigue/form (Intervals.icu CTL/ATL), recovery status (HRV, resting HR, sleep vs personal baseline), and current thresholds. Use this first for questions like "how is my training going?" or "am I ready for my race?".',
    inputSchema: { type: 'object', properties: { weeks: { type: 'integer', minimum: 1, maximum: 26, default: 6, description: 'How many weeks back' } } },
    async run(args) {
      const weeks = Math.min(26, Math.max(1, parseInt(args.weeks, 10) || 6));
      const newest = todayLocal(), oldest = addDays(weekStart(newest), -7 * (weeks - 1));
      const [acts, wellRaw, settings] = await Promise.all([
        fetchActivities(oldest, newest),
        icuJson(`${athletePath()}/wellness?oldest=${addDays(newest, -59)}&newest=${newest}`),
        fetchSettings(),
      ]);
      const byWeek = {};
      const usable = acts.filter((a) => !a.dataUnavailable);
      for (const a of usable) {
        const w = weekStart(a.date); const sport = RIDE_TYPES.has(a.type) ? 'ride' : RUN_TYPES.has(a.type) ? 'run' : 'other';
        const row = (byWeek[w] ||= { weekStart: w, ride: blank(), run: blank(), other: blank() })[sport];
        row.count++; row.hours += (a.movingMin || 0) / 60; row.km += a.km || 0; row.elevation += a.elevationGain || 0; row.load += a.load || 0;
      }
      const weekly = Object.values(byWeek).sort((a, b) => a.weekStart.localeCompare(b.weekStart)).map((w) => {
        for (const k of ['ride', 'run', 'other']) { const s = w[k]; s.hours = r1(s.hours); s.km = r1(s.km); s.elevation = Math.round(s.elevation); s.load = Math.round(s.load); }
        return w;
      });
      const wl = Array.isArray(wellRaw) ? wellRaw : [];
      const lastLoad = wl.filter((w) => DATE_RE.test(w.id || '') && typeof w.ctl === 'number' && typeof w.atl === 'number')
        .sort((a, b) => b.id.localeCompare(a.id))[0];
      const status = computeWellnessStatus(wl.map(toWellness).filter(Boolean), newest);
      return {
        period: { oldest, newest, weeks },
        weekly,
        fitness: lastLoad ? { date: lastLoad.id, fitnessCTL: r1(lastLoad.ctl), fatigueATL: r1(lastLoad.atl), formTSB: r1(lastLoad.ctl - lastLoad.atl), rampRate: r1(lastLoad.rampRate), source: 'Intervals.icu training load model' } : null,
        recovery: status && summarizeStatus(status),
        thresholds: settings,
        activitiesWithoutData: acts.length - usable.length || undefined,
        longest: {
          ride: usable.filter((a) => RIDE_TYPES.has(a.type)).sort((a, b) => (b.km || 0) - (a.km || 0)).slice(0, 3).map(brief),
          run: usable.filter((a) => RUN_TYPES.has(a.type)).sort((a, b) => (b.km || 0) - (a.km || 0)).slice(0, 3).map(brief),
        },
      };
      function blank() { return { count: 0, hours: 0, km: 0, elevation: 0, load: 0 }; }
      function brief(a) { return { id: a.id, date: a.date, name: a.name, km: a.km, elevationGain: a.elevationGain, movingMin: a.movingMin }; }
    },
  },
  {
    name: 'list_activities',
    title: '활동 목록',
    description: 'List activities with summary metrics (distance, moving time, elevation, HR, power, NP, IF, load, run pace). Default: last 28 days. Optional sport filter.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'integer', minimum: 1, maximum: 366, default: 28 },
        oldest: { type: 'string', description: 'YYYY-MM-DD (overrides days)' },
        newest: { type: 'string', description: 'YYYY-MM-DD, default today' },
        sport: { type: 'string', enum: ['all', 'ride', 'run'], default: 'all' },
      },
    },
    async run(args) {
      const { oldest, newest } = range(args, 28, 366);
      let acts = await fetchActivities(oldest, newest);
      if (args.sport === 'ride') acts = acts.filter((a) => RIDE_TYPES.has(a.type));
      if (args.sport === 'run') acts = acts.filter((a) => RUN_TYPES.has(a.type));
      acts.sort((a, b) => String(b.start).localeCompare(String(a.start)));
      return { period: { oldest, newest }, count: acts.length, activities: acts };
    },
  },
  {
    name: 'get_cycling_intensity',
    title: '사이클 지속 고강도 시간',
    description: 'For rides in the last N weeks (default 6): minutes ridden in efforts sustained ≥2 min at ≥85% FTP (sweet spot and above) and ≥95% FTP (threshold and above), per ride and per week. Same method as the YMC app; short sprints and stop-and-go are excluded. Use for questions about ride intensity or sweet-spot work.',
    inputSchema: { type: 'object', properties: { weeks: { type: 'integer', minimum: 1, maximum: 12, default: 6 } } },
    async run(args) {
      const weeks = Math.min(12, Math.max(1, parseInt(args.weeks, 10) || 6));
      const newest = todayLocal(), oldest = addDays(newest, -(weeks * 7 - 1));
      const [acts, settings] = await Promise.all([fetchActivities(oldest, newest), fetchSettings()]);
      const ftp = settings.ride && settings.ride.ftp;
      if (!ftp) throw new ToolError('Intervals.icu 사이클 설정에 FTP가 없어요. Settings → Ride에서 FTP를 입력해 주세요');
      const rides = acts.filter((a) => RIDE_TYPES.has(a.type) && !a.dataUnavailable && a.avgPower).slice(0, 40);
      const detail = await mapLimit(rides, 4, (a) => rideSustained(a.id, ftp));
      const perRide = rides.map((a, i) => ({ id: a.id, date: a.date, name: a.name, km: a.km, movingMin: a.movingMin, intensityFactor: a.intensityFactor, ...detail[i] }));
      const ok = perRide.filter((r) => r.sweetSpotPlusMin != null);
      const total = ok.reduce((s, r) => s + r.sweetSpotPlusMin, 0);
      const byWeek = {};
      for (const r of ok) { const w = weekStart(r.date); byWeek[w] = (byWeek[w] || 0) + r.sweetSpotPlusMin; }
      return {
        period: { oldest, newest, weeks },
        ftp,
        sweetSpotPlusMinPerWeek: Math.round(total / weeks),
        ymcRating: total / weeks >= 40 ? '적절 (주당 40분 이상)' : total / weeks >= 20 ? '보통 (20~40분)' : '부족 (20분 미만)',
        byWeek: Object.keys(byWeek).sort().map((w) => ({ weekStart: w, sweetSpotPlusMin: byWeek[w] })),
        rides: perRide,
        ridesWithoutPowerDetail: perRide.length - ok.length,
        ridesWithoutPower: acts.filter((a) => RIDE_TYPES.has(a.type) && !a.dataUnavailable && !a.avgPower).length,
        ridesViaStravaNoData: acts.filter((a) => RIDE_TYPES.has(a.type) && a.dataUnavailable).length,
      };
    },
  },
  {
    name: 'get_recovery',
    title: '회복 데이터',
    description: 'Daily HRV (rMSSD), resting HR, sleep, VO2max, weight for the last N days (default 30, max 120), plus the YMC recovery verdict: 7-day HRV and resting HR compared with the personal 8-60 day baseline.',
    inputSchema: { type: 'object', properties: { days: { type: 'integer', minimum: 7, maximum: 120, default: 30 } } },
    async run(args) {
      const days = Math.min(120, Math.max(7, parseInt(args.days, 10) || 30));
      const newest = todayLocal();
      const fetchFrom = addDays(newest, -Math.max(days, 60) + 1); // baseline needs 60 days
      const raw = await icuJson(`${athletePath()}/wellness?oldest=${fetchFrom}&newest=${newest}`);
      const rows = (Array.isArray(raw) ? raw : []).map(toWellness).filter(Boolean);
      const status = computeWellnessStatus(rows, newest);
      const showFrom = addDays(newest, -(days - 1));
      return { period: { oldest: showFrom, newest }, verdict: status && summarizeStatus(status), daily: rows.filter((r) => r.date >= showFrom) };
    },
  },
  {
    name: 'get_thresholds',
    title: '역치 설정값',
    description: 'Current thresholds from Intervals.icu settings: running LTHR, max HR, threshold pace (min/km); cycling FTP, LTHR, max HR. These are entered manually and may be outdated.',
    inputSchema: { type: 'object', properties: {} },
    async run() { return fetchSettings(); },
  },
  {
    name: 'get_activity',
    title: '활동 상세',
    description: 'Details for one activity by id (from list_activities). For rides with power, also returns sustained minutes ≥85% and ≥95% FTP.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Activity id, e.g. i123456789' } }, required: ['id'] },
    async run(args) {
      const id = String(args.id || '').trim();
      if (!ID_RE.test(id)) throw new ToolError('id 형식이 이상해요 (예: i123456789)');
      const a = toActivity(await icuJson(`/activity/${id}`));
      let intensity = null;
      if (RIDE_TYPES.has(a.type) && a.avgPower && !a.dataUnavailable) {
        const s = await fetchSettings();
        if (s.ride && s.ride.ftp) intensity = { ftp: s.ride.ftp, ...(await rideSustained(id, s.ride.ftp)) };
      }
      return { ...a, intensity };
    },
  },
];

function summarizeStatus(s) {
  return {
    hrv: s.hrv, restingHR: s.rhr, sleepAvgHours7d: s.sleepAvg,
    latest: s.latest,
    predictionAdjustment: s.condAdj, // >1 = YMC slows race predictions (fatigue), <1 = fresh
    warnings: s.warnings, positives: s.goods, notes: s.details,
  };
}

// ── JSON-RPC / MCP plumbing
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

async function handleMessage(msg) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(msg && msg.id, -32600, 'Invalid Request');
  const isNotification = msg.id === undefined || msg.id === null;
  const p = msg.params || {};
  switch (msg.method) {
    case 'initialize': {
      const v = SUPPORTED_VERSIONS.includes(p.protocolVersion) ? p.protocolVersion : SUPPORTED_VERSIONS[0];
      return rpcResult(msg.id, { protocolVersion: v, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
    }
    case 'ping': return isNotification ? null : rpcResult(msg.id, {});
    case 'tools/list':
      return rpcResult(msg.id, {
        tools: TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: true, openWorldHint: false } })),
      });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === p.name);
      if (!tool) return rpcError(msg.id, -32602, `Unknown tool: ${p.name}`);
      try {
        const data = await tool.run(p.arguments || {});
        return rpcResult(msg.id, { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
      } catch (e) {
        const known = e instanceof ToolError || e instanceof UpstreamError;
        return rpcResult(msg.id, { content: [{ type: 'text', text: known ? e.message : `서버 오류: ${e.message || e}` }], isError: true });
      }
    }
    default:
      if (msg.method.startsWith('notifications/')) return null;
      return isNotification ? null : rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

function sentSecret(req) {
  const h = req.headers.authorization || '';
  const bearer = h.match(/^Bearer\s+(.+)$/i);
  let v = bearer ? bearer[1] : (req.headers['x-ymc-secret'] || (req.query && req.query.key) || '');
  try { v = decodeURIComponent(v); } catch { /* not encoded */ }
  return normSecret(v);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json(rpcError(null, -32000, 'Use POST (stateless Streamable HTTP; no SSE stream)'));
  }

  const secret = normSecret(process.env.YMC_SECRET);
  if (!secret || !process.env.INTERVALS_API_KEY) {
    return res.status(500).json(rpcError(null, -32000, '서버 환경변수(YMC_SECRET / INTERVALS_API_KEY)가 없어요'));
  }
  if (sentSecret(req) !== secret) {
    return res.status(401).json(rpcError(null, -32001, 'Unauthorized: Authorization: Bearer <YMC_SECRET> 헤더가 필요해요'));
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(400).json(rpcError(null, -32700, 'Parse error')); } }
  if (body == null) return res.status(400).json(rpcError(null, -32700, 'Parse error'));

  const batch = Array.isArray(body);
  const replies = (await Promise.all((batch ? body : [body]).map(handleMessage))).filter(Boolean);
  if (!replies.length) return res.status(202).end();

  return res.status(200).json(batch ? replies : replies[0]);
}
