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
import { dedupeActivities } from '../src/dedupe.js';
import { loadActivitySplits, SplitsError } from './_activitySplits.js';
import { flatVenueReason } from '../src/elevation.js';
import { predictRace, calcVDOT } from '../src/predict.js';

const SERVER_INFO = { name: 'ymc-training', title: 'YMC 훈련 기록', version: '1.2.0' };
const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const INSTRUCTIONS = [
  'YMC training data for one athlete (trail running, road running, cycling/granfondo, MTB), read live from Intervals.icu (synced from Garmin).',
  'Dates are the athlete\'s local dates (Asia/Seoul). Distances km, durations minutes, power W, HR bpm, pace min/km.',
  'Training load / fitness / fatigue / form are Intervals.icu\'s own model, not YMC\'s TRIMP model; say so when quoting them.',
  'Thresholds come from the athlete\'s Intervals.icu settings, which are entered manually and can be out of date.',
  'When the same workout was recorded on two devices at once (bike computer + watch), only the recording with power is returned; duplicateRecordingsHidden lists the hidden ones. Intervals.icu\'s own fitness/fatigue numbers may still include both copies.',
  'Elevation on track, treadmill and indoor activities is set to 0 (recordedElevationGain keeps what the device reported).',
  'For races in the athlete\'s calendar (upcoming, D-day, prediction vs actual) use get_races. For other race-time questions use predict_race: it runs the same prediction model as the YMC app (readiness, durability, TID, condition factor).',
  'Start with get_training_overview for general questions; drill down with the other tools.',
].join(' ');

import {
  RIDE_TYPES, RUN_TYPES, r1, paceText, minText, TZ_OFFSET_MS, todayLocal, addDays, range, weekStart, ToolError, parseClock, athletePath, toActivity, fetchActivities, fetchSettings, mapLimit, rideSustained, RACE_SPORT, SPORT_TYPES, eventKm, eventGoal, eventGain, daysBetween, toRace, matchRaceActivity, pastRaceReview, runPrediction, getRaces,
} from './_core.js';

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
        duplicateRecordingsHidden: acts.duplicatesHidden.length || undefined,
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
      const hidden = acts.duplicatesHidden;
      if (args.sport === 'ride') acts = acts.filter((a) => RIDE_TYPES.has(a.type));
      if (args.sport === 'run') acts = acts.filter((a) => RUN_TYPES.has(a.type));
      acts.sort((a, b) => String(b.start).localeCompare(String(a.start)));
      return { period: { oldest, newest }, count: acts.length, activities: acts, duplicateRecordingsHidden: hidden.length ? hidden : undefined };
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
    name: 'predict_race',
    title: '대회 기록 예측',
    description: 'Predict a race finish time with the YMC app\'s own model (same code as the app\'s 🎯 예측 tab): pace/time rows (recommended row flagged), training readiness score with reasons, durability index (expected late-race slowdown from long-run history), training intensity distribution, and the condition factor from recent load, HR and HRV/resting HR. Built from the last 120 days of Intervals.icu activities and the athlete\'s Intervals.icu thresholds (LT pace, LTHR, max HR, FTP), which are entered manually and may be stale. For road running, pass a recent race result (recent_race_km + recent_race_time) or vdot to add the Jack Daniels VDOT estimate; otherwise the LT-pace and training-pace estimates are used. Use for "what time will I run/ride?", sub-X goals and race readiness.',
    inputSchema: {
      type: 'object',
      properties: {
        sport: { type: 'string', enum: ['road_run', 'trail_run', 'cycling', 'mtb'], description: 'Target race type' },
        distance_km: { type: 'number', minimum: 1, maximum: 400, description: 'Race distance, e.g. 42.195' },
        elevation_gain_m: { type: 'number', minimum: 0, maximum: 15000, description: 'Course elevation gain in m (optional; recommended for trail and cycling)' },
        recent_race_km: { type: 'number', minimum: 1, maximum: 100, description: 'Distance of a recent race or all-out effort (road running VDOT)' },
        recent_race_time: { type: 'string', description: 'Its finish time, h:mm:ss or mm:ss' },
        vdot: { type: 'number', minimum: 20, maximum: 90, description: 'VDOT if already known (overrides recent_race_*)' },
        age: { type: 'integer', minimum: 10, maximum: 100 },
        gender: { type: 'string', enum: ['male', 'female'] },
        goal_time: { type: 'string', description: 'Optional goal, h:mm:ss — the result then says the goal pace and the gap to the recommended prediction' },
      },
      required: ['sport', 'distance_km'],
    },
    async run(args) { return runPrediction(args, null); },
  },
  {
    name: 'get_races',
    title: '대회 일정 · 예측 대비 실제',
    description: 'Races from the athlete\'s Intervals.icu calendar (RACE_A/B/C events: name, date, type, distance; a goal time is read from the description as "목표 3:59:59" or "goal 3:59:59", course elevation gain as "고도 1300" or "D+1300", the official finish time as "기록 5:18:48", which then counts as the actual result). Upcoming races get days-to-go and the current YMC prediction (same model as predict_race) with the gap to the goal. On the race eve / race day the prediction is saved into the race description ("[YMC 예측 date] 추천 …"). Past races are matched to the activity recorded that day and get prediction-vs-actual: first against that saved prediction, then the YMC prediction recomputed with data up to the day before the race, the error per prediction row, which row was closest, plus pacing (first vs second half against the predicted pace, HR drift, the km where stride started shortening). Use for "how did my race go vs the prediction?", "what races do I have?" and D-day questions.',
    inputSchema: {
      type: 'object',
      properties: {
        days_back: { type: 'integer', minimum: 0, maximum: 730, default: 365, description: 'How far back to look for past races' },
        days_ahead: { type: 'integer', minimum: 0, maximum: 730, default: 365 },
        past_limit: { type: 'integer', minimum: 0, maximum: 10, default: 3, description: 'How many of the most recent past races get a full prediction-vs-actual review' },
        predict_upcoming: { type: 'boolean', default: true, description: 'Run the YMC prediction for upcoming races within 60 days (max 3)' },
        vdot: { type: 'number', minimum: 20, maximum: 90, description: 'VDOT to use for upcoming road races; also written into their descriptions as "VDOT x" so the race-eve snapshot uses it. Omit to use what the descriptions already say.' },
        age: { type: 'integer', minimum: 10, maximum: 100 },
        save_snapshots: { type: 'boolean', default: true, description: 'On the race eve / race day, save the current prediction into the race description in Intervals.icu (once; never after the race)' },
      },
    },
    async run(args) { return getRaces(args); },
  },
  {
    name: 'get_activity_splits',
    title: '구간 기록 · 심박 흐름',
    description: 'Per-km splits (default 1 km for runs, 5 km for rides) with pace/speed, avg & max HR, power, elevation; first-half vs second-half comparison with HR drift and aerobic decoupling % (pace:HR, or power:HR for rides with power; under ~5% means the effort was held aerobically); pace fade (first 3 vs last 3 splits); time in HR zones by % of LTHR. For runs also cadence (spm), stride length and, when the watch records them, ground contact time, vertical oscillation and vertical ratio per split, and formChange: peak vs last splits split into cadence and stride changes, plus the first km where stride stayed >3% shorter than at the peak (a sign of leg fatigue / form breakdown). Uses the watch\'s own distance stream, so treadmill runs work; stops are excluded. availableStreams lists what the recording contains. Use this to analyse pacing, fatigue, or how a session went.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Activity id from list_activities, e.g. i123456789' },
        split_km: { type: 'number', minimum: 0.2, maximum: 20, description: 'Split length in km (default 1 for runs, 5 for rides)' },
      },
      required: ['id'],
    },
    async run(args) {
      const id = String(args.id || '').trim();
      if (!ID_RE.test(id)) throw new ToolError('id 형식이 이상해요 (예: i123456789)');
      let r;
      try { r = await loadActivitySplits(id, args.split_km); } catch (e) { if (e instanceof SplitsError) throw new ToolError(e.message); throw e; }
      const { raw, flat, source, availableStreams, result } = r;
      const a = toActivity(raw);
      return {
        activity: { id: a.id, date: a.date, name: a.name, type: a.type, device: a.device, recordedKm: a.km, recordedElevationGain: a.recordedElevationGain ?? a.elevationGain, elevationNote: flat || undefined },
        source,
        availableStreams,
        ...result,
        notes: [
          'Moving time only: gaps over 10 s and near-stationary samples are excluded, so totals can differ slightly from Garmin.',
          flat ? `Elevation set to 0: ${flat}.` : 'Elevation is smoothed (5-sample average, 1 m steps); recordedElevationGain is what the device reported.',
        ],
      };
    },
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
