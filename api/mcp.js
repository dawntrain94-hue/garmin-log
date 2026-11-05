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

const SERVER_INFO = { name: 'ymc-training', title: 'YMC 훈련 기록', version: '1.1.0' };
const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const INSTRUCTIONS = [
  'YMC training data for one athlete (trail running, road running, cycling/granfondo, MTB), read live from Intervals.icu (synced from Garmin).',
  'Dates are the athlete\'s local dates (Asia/Seoul). Distances km, durations minutes, power W, HR bpm, pace min/km.',
  'Training load / fitness / fatigue / form are Intervals.icu\'s own model, not YMC\'s TRIMP model; say so when quoting them.',
  'Thresholds come from the athlete\'s Intervals.icu settings, which are entered manually and can be out of date.',
  'When the same workout was recorded on two devices at once (bike computer + watch), only the recording with power is returned; duplicateRecordingsHidden lists the hidden ones. Intervals.icu\'s own fitness/fatigue numbers may still include both copies.',
  'Elevation on track, treadmill and indoor activities is set to 0 (recordedElevationGain keeps what the device reported).',
  'For race-time questions use predict_race: it runs the same prediction model as the YMC app (readiness, durability, TID, condition factor).',
  'Start with get_training_overview for general questions; drill down with the other tools.',
].join(' ');

const RIDE_TYPES = new Set(['Ride', 'VirtualRide', 'GravelRide', 'EBikeRide', 'MountainBikeRide']);
const RUN_TYPES = new Set(['Run', 'TrailRun', 'VirtualRun']);
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
// 5.46 (min/km) → "5:28"
const paceText = (p) => { let m = Math.floor(p), sec = Math.round((p - m) * 60); if (sec === 60) { m++; sec = 0; } return `${m}:${String(sec).padStart(2, '0')}`; };
const minText = (min) => { const t = Math.round(min * 60), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60; return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`; };

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

// "1:52:30" / "52:30" → 분
function parseClock(v) {
  const parts = String(v || '').trim().split(':').map((x) => parseFloat(x));
  if (!parts.length || parts.some((x) => !(x >= 0))) return null;
  const sec = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts.length === 2 ? parts[0] * 60 + parts[1] : null;
  return sec > 0 ? sec / 60 : null;
}

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
  const pace = isRun && km && movingMin ? movingMin / km : null;
  const recordedGain = num(a.total_elevation_gain) ? Math.round(a.total_elevation_gain) : null;
  const flat = flatVenueReason({ type: a.type, name: a.name, trainer: a.trainer });
  return {
    id: a.id,
    date: String(a.start_date_local || '').slice(0, 10),
    start: a.start_date_local || null,
    name: a.name || null,
    type: a.type || null,
    km: r1(km),
    movingMin: movingMin ? Math.round(movingMin) : null,
    elevationGain: flat ? 0 : recordedGain,
    recordedElevationGain: flat && recordedGain ? recordedGain : undefined,
    elevationNote: flat && recordedGain ? flat : undefined,
    avgHR: num(a.average_heartrate) ? Math.round(a.average_heartrate) : null,
    maxHR: num(a.max_heartrate) ? Math.round(a.max_heartrate) : null,
    avgPower: num(a.icu_average_watts) ? Math.round(a.icu_average_watts) : null,
    normalizedPower: num(a.icu_weighted_avg_watts) ? Math.round(a.icu_weighted_avg_watts) : null,
    intensityFactor: num(a.icu_intensity) ? +(a.icu_intensity / 100).toFixed(2) : null,
    load: num(a.icu_training_load) ? Math.round(a.icu_training_load) : null,
    paceMinKm: pace ? +pace.toFixed(2) : null,
    pace: pace ? paceText(pace) : null, // mm:ss /km
    device: a.device_name || null,
    dataUnavailable: a._note ? 'Strava를 거쳐 들어온 활동이라 Intervals.icu가 상세 데이터를 주지 않음' : undefined,
  };
}

// Same ride recorded on two devices (Edge + watch) → keep the one with power (same rule as the app)
async function fetchActivities(oldest, newest) {
  const data = await icuJson(`${athletePath()}/activities?oldest=${oldest}&newest=${newest}`);
  const dd = dedupeActivities(Array.isArray(data) ? data : [], (a) => ({
    id: a.id, start: a.start_date_local, type: a.type,
    durationSec: a.elapsed_time || a.moving_time, hasPower: a.icu_average_watts > 0,
  }));
  const rows = dd.keep.map(toActivity);
  rows.duplicatesHidden = dd.dropped.map((d) => ({ id: d.item.id, date: String(d.item.start_date_local || '').slice(0, 10), device: d.item.device_name || null, keptId: d.keptId }));
  return rows;
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
    async run(args) {
      const sport = String(args.sport || '');
      if (!['road_run', 'trail_run', 'cycling', 'mtb'].includes(sport)) throw new ToolError('sport는 road_run / trail_run / cycling / mtb 중 하나예요');
      const raceKm = parseFloat(args.distance_km);
      if (!(raceKm > 0)) throw new ToolError('distance_km가 필요해요');
      const isCycling = sport === 'cycling' || sport === 'mtb';

      const today = todayLocal();
      const [acts, wellRaw, settings] = await Promise.all([
        fetchActivities(addDays(today, -119), today),
        icuJson(`${athletePath()}/wellness?oldest=${addDays(today, -59)}&newest=${today}`),
        fetchSettings(),
      ]);

      // Intervals.icu 행 → YMC 앱 활동 형태 (트레드밀도 러닝 볼륨으로 포함)
      const SPORT_OF = { Run: 'road_run', VirtualRun: 'road_run', TrailRun: 'trail_run', Ride: 'cycling', VirtualRide: 'cycling', GravelRide: 'cycling', EBikeRide: 'cycling', MountainBikeRide: 'mtb' };
      const usable = acts.filter((a) => !a.dataUnavailable && SPORT_OF[a.type] && a.km > 0);
      const ymcActs = usable.sort((a, b) => String(b.start).localeCompare(String(a.start))).map((a) => ({
        id: a.id, sport: SPORT_OF[a.type], activityDate: a.date, name: a.name,
        distanceKm: a.km, durationMin: a.movingMin || 0,
        avgPaceMinKm: a.km && a.movingMin ? +(a.movingMin / a.km).toFixed(2) : 0,
        avgHR: a.avgHR, elevationGain: a.elevationGain || 0, avgPower: a.avgPower,
      }));

      // 사이클 목표면 파워 상세(30초 bins)를 읽어서 지속 고강도 시간 평가에 사용
      if (isCycling) {
        const cutoff = addDays(today, -69);
        const rides = ymcActs.filter((a) => (a.sport === 'cycling' || a.sport === 'mtb') && a.avgPower && a.activityDate >= cutoff).slice(0, 30);
        await mapLimit(rides, 4, async (a) => { const { text } = await icuGpxText(a.id); a.powerBins = buildPowerBins(gpxPowerSeries(text)); });
      }

      const run = settings.run || {}, ride = settings.ride || {};
      let vdot = parseFloat(args.vdot) > 0 ? parseFloat(args.vdot) : null, vdotFrom = vdot ? 'given' : null;
      if (!vdot && args.recent_race_km && args.recent_race_time) {
        const t = parseClock(args.recent_race_time);
        if (!t) throw new ToolError('recent_race_time 형식이 이상해요 (예: 1:52:30)');
        vdot = calcVDOT(parseFloat(args.recent_race_km), t); vdotFrom = `${args.recent_race_km}km ${args.recent_race_time}`;
      }
      const wl = (Array.isArray(wellRaw) ? wellRaw : []).map(toWellness).filter(Boolean);
      const latestWeight = wl.slice().reverse().find((w) => w.weight);
      const profile = {
        ltPaceMinKm: run.thresholdPaceMinKm || '', ltHR: run.lthr || ride.lthr || '', maxHR: run.maxHr || ride.maxHr || '',
        ftp: ride.ftp || '', weight: latestWeight ? latestWeight.weight : '',
        vdot: vdot ? String(vdot) : '', age: args.age ? String(args.age) : '', gender: args.gender || 'male',
      };
      const gain = parseFloat(args.elevation_gain_m) >= 0 && args.elevation_gain_m != null ? parseFloat(args.elevation_gain_m) : null;
      const courseData = gain != null || isCycling
        ? { distanceKm: raceKm, elevationGain: gain || 0, gainPerKm: (gain || 0) / raceKm, elevProfile: null }
        : null;

      const r = predictRace({ activities: ymcActs, profile, wellness: wl, sport, raceKm, courseData, now: Date.now(), today });
      if (r.error) throw new ToolError(r.error);

      const rec = (r.runningRows || []).find((x) => x.isRecommended) || null;
      let goal;
      const goalMin = args.goal_time ? parseClock(args.goal_time) : null;
      if (args.goal_time && !goalMin) throw new ToolError('goal_time 형식이 이상해요 (예: 3:59:59)');
      if (goalMin && !isCycling) {
        goal = { time: args.goal_time, paceRequired: paceText(goalMin / raceKm) };
        if (rec) goal.gapVsRecommendedMin = +(rec.totalMin - goalMin).toFixed(1); // +면 예측이 목표보다 느림
      }
      const ts = r.trainingSummary;
      return {
        asOf: today,
        race: { sport, distanceKm: raceKm, elevationGainM: gain ?? undefined },
        prediction: (r.runningRows || []).map((x) => ({ label: x.label, recommended: x.isRecommended || undefined, pace: paceText(x.paceMinKm), time: minText(x.totalMin), basis: x.desc })),
        cyclingPrediction: r.cyclingRows ? r.cyclingRows.map((x) => ({ label: x.label, power: x.power, intensityFactor: x.if_val, avgSpeedKmh: x.speed, time: x.time, movingTime: x.movTime, basis: x.desc })) : undefined,
        goal,
        readiness: r.trainingReadiness ? { scorePct: r.trainingReadiness.score, level: r.trainingReadiness.level, goods: r.trainingReadiness.goods, warnings: r.trainingReadiness.warnings, notes: r.trainingReadiness.details } : null,
        durability: ts && ts.durability ? { score: ts.durability.score, label: ts.durability.label, longSessions: ts.durability.longActsCount, crossLongSessions: ts.durability.crossLongCount, longKmTotal: ts.durability.totalLongKm, expectedLateSlowdownPct: Math.round(ts.durability.lateDecayPct * 1000) / 10, appliedToPredictionPct: ts.durability.appliedPct || 0, appliedTo: 'LT and VDOT rows (late third of the race); training-based rows already include real long-run fatigue', longThresholdKm: Math.round(raceKm * 0.6 * 10) / 10 } : null,
        intensityDistribution: ts && ts.tid ? { z1Pct: ts.tid.z1Pct, z2Pct: ts.tid.z2Pct, z3Pct: ts.tid.z3Pct, activities: ts.tid.total, feedback: ts.tid.feedback, basis: 'per-activity average HR vs max HR (<75% / 75-87% / ≥87%)' } : null,
        condition: ts ? { factor: +ts.condFactorFinal.toFixed(3), label: ts.condLabel, meaning: '>1 slows the prediction (fatigue), <1 speeds it up' } : null,
        training: ts ? { window: ts.fitnessWindow, activities: ts.count, weeklyKm: +ts.weeklyKm, last7dKm: +ts.wk7km, prev3wkAvgKm: +ts.wk4avg, longestKm: +ts.maxDist, avgPace: ts.avgPace, longRunPace: ts.longPace, crossTrainingSharePct: ts.crossWeight || 0 } : null,
        inputs: {
          ltPace: profile.ltPaceMinKm ? paceText(+profile.ltPaceMinKm) : null,
          ltHR: profile.ltHR || null, maxHR: profile.maxHR || null, ftp: profile.ftp || null, weightKg: profile.weight || null,
          vdot: vdot || null, vdotFrom: vdotFrom || undefined,
          note: 'LT pace, LTHR, max HR and FTP come from Intervals.icu settings (entered manually, may be stale). Treadmill runs count toward running volume.',
        },
      };
    },
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
