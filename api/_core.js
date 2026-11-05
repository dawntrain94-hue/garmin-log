// YMC 서버 공용 로직 — /api/mcp (Claude 커넥터)와 /api/intervals (앱)가 같이 씀
// Files starting with "_" in /api are not deployed as routes on Vercel.

import {
  DATE_RE, num, resolveAthlete, icuJson, icuGpxText, toWellness, toSettings, gpxPowerSeries,
} from './_icu.js';
import { buildPowerBins, sustainedMinutes } from '../src/intensity.js';
import { dedupeActivities } from '../src/dedupe.js';
import { loadActivitySplits } from './_activitySplits.js';
import { flatVenueReason } from '../src/elevation.js';
import { predictRace, calcVDOT } from '../src/predict.js';

export const RIDE_TYPES = new Set(['Ride', 'VirtualRide', 'GravelRide', 'EBikeRide', 'MountainBikeRide']);
export const RUN_TYPES = new Set(['Run', 'TrailRun', 'VirtualRun']);
export const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
// 5.46 (min/km) → "5:28"
export const paceText = (p) => { let m = Math.floor(p), sec = Math.round((p - m) * 60); if (sec === 60) { m++; sec = 0; } return `${m}:${String(sec).padStart(2, '0')}`; };
export const minText = (min) => { const t = Math.round(min * 60), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60; return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`; };

// ── date helpers (athlete is in Asia/Seoul)
export const TZ_OFFSET_MS = 9 * 3600 * 1000;
export function todayLocal() { return new Date(Date.now() + TZ_OFFSET_MS).toISOString().slice(0, 10); }
export function addDays(dateStr, n) { const d = new Date(dateStr + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
export function range(args, defDays, maxDays) {
  const newest = DATE_RE.test(args.newest || '') ? args.newest : todayLocal();
  let oldest = DATE_RE.test(args.oldest || '') ? args.oldest : null;
  const days = Math.min(maxDays, Math.max(1, parseInt(args.days, 10) || defDays));
  if (!oldest) oldest = addDays(newest, -(days - 1));
  if (oldest > newest) throw new ToolError('oldest가 newest보다 늦어요');
  const span = (Date.parse(newest) - Date.parse(oldest)) / 86400000 + 1;
  if (span > maxDays) throw new ToolError(`기간은 최대 ${maxDays}일이에요`);
  return { oldest, newest };
}
export const weekStart = (dateStr) => { const d = new Date(dateStr + 'T00:00:00Z'); const dow = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - dow); return d.toISOString().slice(0, 10); };

export class ToolError extends Error {}

// "1:52:30" / "52:30" → 분
export function parseClock(v) {
  const parts = String(v || '').trim().split(':').map((x) => parseFloat(x));
  if (!parts.length || parts.some((x) => !(x >= 0))) return null;
  const sec = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts.length === 2 ? parts[0] * 60 + parts[1] : null;
  return sec > 0 ? sec / 60 : null;
}

export function athletePath() {
  const a = resolveAthlete();
  if (!a) throw new ToolError('서버의 INTERVALS_ATHLETE_ID 형식이 이상해요 ("i" + 숫자 또는 0)');
  return `/athlete/${a}`;
}

// Intervals.icu activity → compact row
export function toActivity(a) {
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
    elapsedMin: num(a.elapsed_time) ? +(a.elapsed_time / 60).toFixed(1) : null,
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
export async function fetchActivities(oldest, newest) {
  const data = await icuJson(`${athletePath()}/activities?oldest=${oldest}&newest=${newest}`);
  const dd = dedupeActivities(Array.isArray(data) ? data : [], (a) => ({
    id: a.id, start: a.start_date_local, type: a.type,
    durationSec: a.elapsed_time || a.moving_time, hasPower: a.icu_average_watts > 0,
  }));
  const rows = dd.keep.map(toActivity);
  rows.duplicatesHidden = dd.dropped.map((d) => ({ id: d.item.id, date: String(d.item.start_date_local || '').slice(0, 10), device: d.item.device_name || null, keptId: d.keptId }));
  return rows;
}

export async function fetchSettings() {
  return toSettings(await icuJson(`${athletePath()}/sport-settings`));
}

export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch (e) { out[k] = { error: e.message || String(e) }; } }
  }));
  return out;
}

export async function rideSustained(id, ftp) {
  const { text } = await icuGpxText(id);
  const bins = buildPowerBins(gpxPowerSeries(text));
  if (!bins) return { noPowerDetail: true };
  return {
    sweetSpotPlusMin: Math.round(sustainedMinutes(bins, ftp, 0.85, 2)),  // ≥85% FTP, blocks ≥2 min
    thresholdPlusMin: Math.round(sustainedMinutes(bins, ftp, 0.95, 2)),  // ≥95% FTP, blocks ≥2 min
  };
}


// ── 대회 (Intervals.icu 캘린더의 RACE_A/B/C 이벤트)
export const RACE_SPORT = { Run: 'road_run', VirtualRun: 'road_run', TrailRun: 'trail_run', Ride: 'cycling', VirtualRide: 'cycling', GravelRide: 'cycling', EBikeRide: 'cycling', MountainBikeRide: 'mtb' };
export const SPORT_TYPES = { road_run: ['Run', 'VirtualRun'], trail_run: ['TrailRun', 'Run'], cycling: ['Ride', 'VirtualRide', 'GravelRide', 'EBikeRide'], mtb: ['MountainBikeRide', 'Ride'] };

// 이벤트 거리: Intervals.icu가 m로 줌 (작은 값이면 km로 봄)
export function eventKm(e) {
  for (const k of ['distance', 'distance_target', 'race_distance']) {
    const v = num(e[k]);
    if (v) return +(v > 500 ? v / 1000 : v).toFixed(3);
  }
  return null;
}
// 설명란의 "목표 3:59:59" / "goal 1:45:00"
export function eventGoal(e) {
  const m = String(e.description || '').match(/(?:목표|goal|target)\s*(?:기록|시간|time)?\s*[:：]?\s*(\d{1,2}:\d{2}(?::\d{2})?)/i);
  return m ? m[1] : null;
}
// 설명란의 획득고도: "고도 1300", "획득고도 1,300m", "D+1300", "1300m↑"
export function eventGain(e) {
  const t = String(e.description || '').replace(/(\d),(\d{3})/g, '$1$2');
  const m = t.match(/(?:획득\s*고도|상승\s*고도|고도|D\+)\s*[:：]?\s*(\d{2,5})/i) || t.match(/(\d{2,5})\s*m\s*(?:↑|상승)/);
  return m ? parseInt(m[1], 10) : null;
}
// 설명란의 공식 기록: "기록 5:18:48", "공식기록 5:18:48", "result 5:18:48" ("목표 기록"은 제외)
export function eventResult(e) {
  const t = String(e.description || '');
  const re = /(공식\s*기록|완주\s*기록|기록|결과|result|finish)\s*[:：]?\s*(\d{1,2}:\d{2}(?::\d{2})?)/gi;
  let m;
  while ((m = re.exec(t))) { if (!/(목표|goal|target)\s*$/i.test(t.slice(0, m.index))) return m[2]; }
  return null;
}
export const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);

export function toRace(e, today) {
  const date = String(e.start_date_local || '').slice(0, 10);
  return {
    eventId: e.id, date, name: e.name || null,
    priority: String(e.category || '').replace('RACE_', '') || null,
    type: e.type || null, sport: RACE_SPORT[e.type] || null,
    distanceKm: eventKm(e), goalTime: eventGoal(e), elevationGainM: eventGain(e), officialTime: eventResult(e),
    daysUntil: DATE_RE.test(date) ? daysBetween(today, date) : null,
  };
}

// 대회 날짜(±1일)의 같은 종목 활동 중 거리가 가장 가까운 것 (20% 이내)
export function matchRaceActivity(race, acts) {
  const types = SPORT_TYPES[race.sport] || [];
  const near = acts.filter((a) => types.includes(a.type) && Math.abs(daysBetween(race.date, a.date)) <= 1 && a.km > 0);
  if (!near.length) return null;
  if (!race.distanceKm) return near.sort((a, b) => b.km - a.km)[0];
  const best = near.sort((a, b) => Math.abs(a.km - race.distanceKm) - Math.abs(b.km - race.distanceKm))[0];
  return Math.abs(best.km - race.distanceKm) / race.distanceKm <= 0.2 ? best : null;
}

// "4h 27m" / "4:27:00" → 분
function parseHm(v) {
  const m = String(v || '').match(/^(\d+)h\s*(\d+)m$/);
  return m ? +m[1] * 60 + +m[2] : parseClock(v);
}

export async function pastRaceReview(race, acts) {
  const act = matchRaceActivity(race, acts);
  if (!act) return { status: 'no matching activity found on the race date' };
  const isRide = race.sport === 'cycling' || race.sport === 'mtb';
  const moving = act.movingMin || null, elapsed = act.elapsedMin || null;
  // 기록 시간: 정지가 많지 않으면 경과 시간(대회 기록에 가까움), 정지·켜둔 시간이 길면 이동 시간 기준으로 비교
  const stopHeavy = moving && elapsed && elapsed / moving > 1.15;
  const officialMin = race.officialTime ? parseClock(race.officialTime) : null; // 설명란의 공식 기록이 있으면 그게 실제 기록
  const actualMin = officialMin || (stopHeavy ? moving : (elapsed || moving));
  const raceKm = race.distanceKm || act.km;
  const distOffPct = race.distanceKm ? +((act.km / race.distanceKm - 1) * 100).toFixed(1) : 0;
  const distMatches = Math.abs(distOffPct) <= 5;
  const actualSpeed = moving ? act.km / (moving / 60) : null;           // km/h (이동)
  const actualPace = moving ? moving / act.km : null;                    // min/km (이동)
  const out = {
    activity: {
      id: act.id, date: act.date, name: act.name, km: act.km, avgHR: act.avgHR,
      moving: moving ? minText(moving) : null, elapsed: elapsed ? minText(elapsed) : null,
      official: officialMin ? minText(officialMin) : undefined,
      comparedOn: officialMin ? 'official' : stopHeavy ? 'moving' : 'elapsed',
      movingSpeedKmh: isRide && actualSpeed ? +actualSpeed.toFixed(1) : undefined,
      movingPace: !isRide && actualPace ? paceText(actualPace) : undefined,
    },
    notes: [],
  };
  if (officialMin && !distMatches) out.notes.push(`공식 기록 ${minText(officialMin)}로 비교 — 워치·기기 기록은 ${act.km}km만 남아 있어서 구간 분석은 그 부분만`);
  else if (stopHeavy && !officialMin) out.notes.push(`경과 ${minText(elapsed)} 중 이동 ${minText(moving)} — 정지·켜둔 시간이 길어서 이동 시간 기준으로 비교`);
  if (!distMatches && !officialMin) out.notes.push(`기록 거리 ${act.km}km ≠ 대회 거리 ${race.distanceKm}km (${distOffPct > 0 ? '+' : ''}${distOffPct}%) — 기록 일부가 빠졌거나 코스가 달라서 완주 시간 비교는 하지 않고 ${isRide ? '속도' : '페이스'}만 비교`);

  // 대회 전날까지의 데이터로 YMC 예측을 다시 계산 (그때 앱이 냈을 예측)
  if (race.sport && raceKm) {
    try {
      const p = await runPrediction({ sport: race.sport, distance_km: raceKm, elevation_gain_m: race.elevationGainM ?? undefined }, addDays(race.date, -1));
      let rows;
      if (isRide) {
        rows = (p.cyclingPrediction || []).map((x) => {
          const movMin = parseHm(x.movingTime), totMin = parseHm(x.time);
          const predSpeed = movMin ? raceKm / (movMin / 60) : null;
          return {
            label: x.label, recommended: /추천/.test(x.label) || undefined,
            predicted: totMin ? minText(totMin) : x.time, predictedMoving: movMin ? minText(movMin) : null,
            predictedSpeedKmh: predSpeed ? +predSpeed.toFixed(1) : null,
            // 공식 기록이 있으면 정지 포함 예측 시간과, 없으면 이동 시간끼리 비교
            errorMin: officialMin && totMin ? +(officialMin - totMin).toFixed(1) : distMatches && movMin && moving ? +(moving - movMin).toFixed(1) : null,
            speedErrorPct: predSpeed && actualSpeed ? +((actualSpeed / predSpeed - 1) * 100).toFixed(1) : null, // −면 예측보다 느림
          };
        });
      } else {
        rows = (p.prediction || []).map((x) => {
          const m = parseClock(x.time), predPace = m ? m / raceKm : null;
          return {
            label: x.label, recommended: x.recommended, predicted: x.time, predictedPace: x.pace,
            errorMin: (officialMin || distMatches) && m && actualMin ? +(actualMin - m).toFixed(1) : null,
            paceErrorPct: predPace && actualPace ? +((actualPace / predPace - 1) * 100).toFixed(1) : null, // +면 예측보다 느림
          };
        });
      }
      const key = (x) => (x.errorMin != null ? Math.abs(x.errorMin) : Math.abs(isRide ? x.speedErrorPct : x.paceErrorPct));
      const scored = rows.filter((x) => key(x) != null && isFinite(key(x)));
      out.predictionAsOfRaceEve = {
        asOf: p.asOf, rows,
        closest: scored.length ? scored.slice().sort((a, b) => key(a) - key(b))[0].label : null,
        readinessPct: p.readiness ? p.readiness.scorePct : null,
        durability: p.durability ? p.durability.label : null,
        note: isRide
          ? 'errorMin = actual moving − predicted moving (+ = slower); speedErrorPct = actual vs predicted moving speed (− = slower). Thresholds are today\'s Intervals.icu settings.'
          : 'errorMin = actual − predicted (+ = slower); paceErrorPct = actual vs predicted pace (+ = slower). Thresholds are today\'s Intervals.icu settings.',
      };
      const rec = rows.find((x) => x.recommended);
      if (rec && !isRide) out._recPace = parseClock(rec.predicted) / raceKm;
      if (rec && isRide) out._recSpeed = rec.predictedSpeedKmh;
    } catch (e) { out.predictionAsOfRaceEve = { error: e.message || String(e) }; }
  }

  // 페이스 운영: 전·후반, 심박 흐름, (러닝) 폼 변화
  try {
    const { result } = await loadActivitySplits(act.id);
    const h = result.halves, fc = result.formChange;
    out.pacing = isRide ? {
      firstHalfSpeedKmh: h.first.speedKmh, secondHalfSpeedKmh: h.second.speedKmh,
      firstHalfPowerW: h.first.avgPower, secondHalfPowerW: h.second.avgPower,
      firstHalfVsRecommendedPct: out._recSpeed && h.first.speedKmh ? +((h.first.speedKmh / out._recSpeed - 1) * 100).toFixed(1) : undefined,
      hrDriftBpm: h.hrDriftBpm, aerobicDecouplingPct: h.aerobicDecouplingPct, decouplingBasis: h.basis,
      note: 'speeds are moving speeds; firstHalfVsRecommendedPct > 0 means the first half was faster than the recommended prediction',
    } : {
      firstHalf: h.first.paceMinKm ? paceText(h.first.paceMinKm) : undefined, secondHalf: h.second.paceMinKm ? paceText(h.second.paceMinKm) : undefined,
      firstHalfVsRecommendedPct: out._recPace && h.first.paceMinKm ? +((h.first.paceMinKm / out._recPace - 1) * 100).toFixed(1) : undefined,
      hrDriftBpm: h.hrDriftBpm, aerobicDecouplingPct: h.aerobicDecouplingPct,
      strideDropFromKm: fc ? fc.strideDropFromKm : undefined,
      peakToLast: fc ? fc.peakToLast : undefined,
      note: 'firstHalfVsRecommendedPct < 0 means the first half was faster than the recommended predicted pace',
    };
  } catch (e) { out.pacing = { error: e.message || String(e) }; }
  delete out._recPace; delete out._recSpeed;
  if (!out.notes.length) delete out.notes;
  return out;
}

// predict_race 계산 본체 — asOf(YYYY-MM-DD)까지의 데이터만 사용 (get_races의 '대회 전날 기준 예측'도 이걸로 재현)
export async function runPrediction(args, asOf) {
  const sport = String(args.sport || '');
  if (!['road_run', 'trail_run', 'cycling', 'mtb'].includes(sport)) throw new ToolError('sport는 road_run / trail_run / cycling / mtb 중 하나예요');
  const raceKm = parseFloat(args.distance_km);
  if (!(raceKm > 0)) throw new ToolError('distance_km가 필요해요');
  const isCycling = sport === 'cycling' || sport === 'mtb';

  const today = asOf || todayLocal();
  const nowMs = asOf ? Date.parse(`${asOf}T23:59:59+09:00`) : Date.now();
  const [acts, wellRaw, settings] = await Promise.all([
    fetchActivities(addDays(today, -119), today),
    icuJson(`${athletePath()}/wellness?oldest=${addDays(today, -59)}&newest=${today}`),
    fetchSettings(),
  ]);

  // Intervals.icu 행 → YMC 앱 활동 형태 (트레드밀도 러닝 볼륨으로 포함)
  const SPORT_OF = { Run: 'road_run', VirtualRun: 'road_run', TrailRun: 'trail_run', Ride: 'cycling', VirtualRide: 'cycling', GravelRide: 'cycling', EBikeRide: 'cycling', MountainBikeRide: 'mtb' };
  // asOf 이후 기록은 절대 쓰지 않음 (대회 전날 기준 재계산에 대회 당일 기록이 섞이지 않게)
  const usable = acts.filter((a) => !a.dataUnavailable && SPORT_OF[a.type] && a.km > 0 && a.date <= today);
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
  const wl = (Array.isArray(wellRaw) ? wellRaw : []).map(toWellness).filter((w) => w && w.date <= today);
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

  const r = predictRace({ activities: ymcActs, profile, wellness: wl, sport, raceKm, courseData, now: nowMs, today });
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
}


// get_races 본체 (MCP 도구와 앱 /api/intervals?action=races가 같이 씀)
export async function getRaces(args = {}) {
  const today = todayLocal();
  const back = Math.min(730, Math.max(0, parseInt(args.days_back ?? 365, 10) || 0));
  const ahead = Math.min(730, Math.max(0, parseInt(args.days_ahead ?? 365, 10) || 0));
  const pastLimit = Math.min(10, Math.max(0, parseInt(args.past_limit ?? 3, 10)));
  const events = await icuJson(`${athletePath()}/events?oldest=${addDays(today, -back)}&newest=${addDays(today, ahead)}`);
  const raceEvents = (Array.isArray(events) ? events : []).filter((e) => /^RACE/i.test(String(e.category || '')));
  const races = raceEvents.map((e) => toRace(e, today)).sort((a, b) => a.date.localeCompare(b.date));
  const upcoming = races.filter((r) => r.daysUntil >= 0), past = races.filter((r) => r.daysUntil < 0).reverse();

  // 다음 대회: 지금 기준 예측
  if (args.predict_upcoming !== false && upcoming[0] && upcoming[0].sport && upcoming[0].distanceKm) {
    const r = upcoming[0];
    try {
      const p = await runPrediction({ sport: r.sport, distance_km: r.distanceKm, goal_time: r.goalTime || undefined, elevation_gain_m: r.elevationGainM ?? undefined }, null);
      r.prediction = { asOf: p.asOf, rows: p.prediction, cycling: p.cyclingPrediction, goal: p.goal, readinessPct: p.readiness && p.readiness.scorePct, durability: p.durability && p.durability.label, condition: p.condition && p.condition.label };
    } catch (e) { r.prediction = { error: e.message || String(e) }; }
  }
  // 지난 대회: 예측 대비 실제
  const reviewed = past.slice(0, pastLimit);
  if (reviewed.length) {
    const acts = await fetchActivities(addDays(reviewed[reviewed.length - 1].date, -1), addDays(reviewed[0].date, 1));
    for (const r of reviewed) r.review = await pastRaceReview(r, acts);
  }
  const missing = raceEvents.filter((e) => !eventKm(e));
  const noGain = races.filter((r) => (r.sport === 'trail_run' || r.sport === 'cycling' || r.sport === 'mtb') && r.elevationGainM == null);
  for (const r of noGain) r.warning = 'No elevation gain in the calendar description — trail/cycling prediction ignores climbing and will be far too fast. Add "고도 1300" (or D+1300) to the race description.';
  return {
    today,
    upcoming, past,
    notes: [
      'Distances come from the Intervals.icu calendar. In a race description, "목표 h:mm:ss" sets a goal, "기록 h:mm:ss" the official finish time (used as the actual result) and "고도 1300" / "D+1300" the course elevation gain.',
      ...(missing.length ? [`${missing.length} race(s) have no distance in Intervals.icu; fields present: ${[...new Set(missing.flatMap((e) => Object.keys(e)))].sort().join(', ')}`] : []),
    ],
  };
}
