// km별 구간 기록 + 심박 흐름 분석 (MCP get_activity_splits)
//
// 입력: 시간순 샘플 { t: 초(시작 기준), d: 누적 거리 m, hr?, w?, alt? }
// 정지 구간(기록 끊김 10초 초과, 또는 거의 안 움직임)은 이동 시간에서 뺀다.
// 심박 드리프트: 이동 시간 기준 전반/후반을 나눠 "속도(또는 파워) ÷ 심박" 효율을 비교한
// aerobic decoupling(%) — 5% 미만이면 그 강도를 끝까지 유산소로 버텼다는 일반적 기준.

const MAX_GAP_S = 10;

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const r1 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 10) / 10);
const r2 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 100) / 100);

// 시간 가중 평균용 누적기
function acc() { return { time: 0, dist: 0, hrT: 0, hrW: 0, hrMax: null, wT: 0, wW: 0, cT: 0, cW: 0, cD: 0, dyn: {}, up: 0, down: 0 }; }
function add(a, seg) {
  a.time += seg.dt; a.dist += seg.dd;
  if (seg.hr != null) { a.hrT += seg.dt; a.hrW += seg.hr * seg.dt; a.hrMax = Math.max(a.hrMax || 0, seg.hr); }
  if (seg.w != null) { a.wT += seg.dt; a.wW += seg.w * seg.dt; }
  if (seg.cad != null) { a.cT += seg.dt; a.cW += seg.cad * seg.dt; a.cD += seg.dd; } // 케이던스 있는 구간의 시간·거리
  if (seg.dyn) for (const k in seg.dyn) { const v = seg.dyn[k]; if (v == null) continue; const d = (a.dyn[k] ||= { t: 0, w: 0 }); d.t += seg.dt; d.w += v * seg.dt; }
  if (seg.dAlt > 0) a.up += seg.dAlt; else a.down -= seg.dAlt;
}
function out(a, isRide) {
  const km = a.dist / 1000;
  return {
    km: r2(km),
    timeSec: Math.round(a.time),
    paceMinKm: !isRide && km > 0 ? r2(a.time / 60 / km) : undefined,
    speedKmh: isRide && a.time > 0 ? r1(km / (a.time / 3600)) : undefined,
    avgHR: a.hrT ? Math.round(a.hrW / a.hrT) : null,
    maxHR: a.hrMax != null ? Math.round(a.hrMax) : null,
    avgPower: a.wT ? Math.round(a.wW / a.wT) : undefined,
    elevGain: Math.round(a.up), elevLoss: Math.round(a.down),
    ...(isRide ? {} : runDyn(a)),
  };
}

// 러닝: 평균 케이던스(spm)와 보폭(m/걸음) — 보폭 = 이동 거리 ÷ 걸음 수 (워치 케이던스만으로 계산)
function runDyn(a) {
  if (!a.cT) return {};
  const cad = a.cW / a.cT, steps = cad * a.cT / 60;
  const o = { cadenceSpm: Math.round(cad), strideM: steps > 0 ? r2(a.cD / steps) : null };
  const dm = (k) => (a.dyn[k] && a.dyn[k].t ? a.dyn[k].w / a.dyn[k].t : null);
  if (dm('gct') != null) o.groundContactMs = Math.round(dm('gct'));
  if (dm('vo') != null) o.verticalOscCm = r1(dm('vo'));
  if (dm('vr') != null) o.verticalRatioPct = r1(dm('vr'));
  return o;
}

// 워치 러닝 다이내믹스 스트림 단위 정리 (Intervals.icu가 넘겨주는 값의 크기로 판단)
//  stance_time: 접지 시간 ms / vertical_oscillation: mm 또는 cm → cm / vertical_ratio: %
function dynScale(name, arr) {
  const v = arr.filter((x) => x > 0).sort((x, y) => x - y);
  if (!v.length) return null;
  const med = v[Math.floor(v.length / 2)];
  if (name === 'vo') return med > 30 ? 0.1 : 1;     // 60~120mm → cm
  if (name === 'gct') return med < 5 ? 1000 : 1;    // 0.25s → ms
  return 1;
}

// 고도 잡음 줄이기: 5포인트 이동평균 후, 1m 이상 변할 때만 반영
function smoothAlt(samples) {
  const n = samples.length, alt = samples.map((s) => s.alt);
  if (!alt.some((v) => v != null)) return alt;
  const sm = alt.map((_, i) => {
    let s = 0, c = 0;
    for (let k = Math.max(0, i - 2); k <= Math.min(n - 1, i + 2); k++) if (alt[k] != null) { s += alt[k]; c++; }
    return c ? s / c : null;
  });
  let base = sm.find((v) => v != null);
  return sm.map((v) => { if (v == null) return base; if (Math.abs(v - base) >= 1) base = v; return base; });
}

export function hrZoneFor(hr, lthr) {
  const p = hr / lthr; // Friel 러닝 심박 존 (LTHR 기준)
  return p < 0.85 ? 'Z1' : p < 0.90 ? 'Z2' : p < 0.95 ? 'Z3' : p < 1.0 ? 'Z4' : 'Z5';
}

export function analyzeSplits(samples, opts = {}) {
  const isRide = !!opts.isRide;
  const splitM = (opts.splitKm || (isRide ? 5 : 1)) * 1000;
  const minSpeed = isRide ? 1.5 : 0.8; // m/s 이하면 정지로 봄
  if (!samples || samples.length < 30) return null;
  // 트랙·트레드밀·실내는 평지: 고도 잡음을 무시
  const alt = opts.flat ? samples.map(() => null) : smoothAlt(samples);
  // Garmin은 러닝 케이던스를 한쪽 다리 기준(예: 85)으로 저장하기도 함 → 중앙값이 120 미만이면 ×2
  const cads = isRide ? [] : samples.map((s) => s.cad).filter((c) => c > 20).sort((x, y) => x - y);
  const cadMult = cads.length && cads[Math.floor(cads.length / 2)] < 120 ? 2 : 1;
  const scales = {};
  for (const k of ['gct', 'vo', 'vr']) { const arr = samples.map((x) => x.dyn && x.dyn[k]).filter((x) => x > 0); if (arr.length) scales[k] = dynScale(k, arr); }
  const scaleDyn = (d) => { const o = {}; for (const k in scales) o[k] = d[k] > 0 ? d[k] * scales[k] : null; return o; };

  // 구간(segment) 목록
  const segs = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    const dt = b.t - a.t, dd = Math.max(0, b.d - a.d);
    if (!(dt > 0) || dt > MAX_GAP_S || dd / dt < minSpeed) continue;
    segs.push({ dt, dd, d: b.d, hr: b.hr ?? a.hr ?? null, w: b.w ?? null, cad: !isRide && b.cad > 0 ? b.cad * cadMult : null, dyn: isRide || !b.dyn ? null : scaleDyn(b.dyn), dAlt: alt[i] != null && alt[i - 1] != null ? alt[i] - alt[i - 1] : 0 });
  }
  if (!segs.length) return null;

  // km별
  const splits = []; let cur = acc(), next = splitM, idx = 1;
  const total = acc();
  for (const s of segs) {
    add(cur, s); add(total, s);
    if (s.d >= next) { splits.push({ split: idx++, ...out(cur, isRide) }); cur = acc(); next += splitM; }
  }
  if (cur.dist >= Math.min(200, splitM * 0.2)) splits.push({ split: idx, partial: true, ...out(cur, isRide) });

  // 전반/후반 (이동 시간 기준 절반)
  const half = total.time / 2, h1 = acc(), h2 = acc(); let tsum = 0;
  for (const s of segs) { add(tsum < half ? h1 : h2, s); tsum += s.dt; }
  const eff = (h) => {
    if (!h.hrT) return null;
    const hr = h.hrW / h.hrT;
    if (isRide && h.wT) return (h.wW / h.wT) / hr;          // 파워 ÷ 심박
    return (h.dist / h.time) / hr;                           // 속도 ÷ 심박
  };
  const e1 = eff(h1), e2 = eff(h2);
  const halves = {
    first: out(h1, isRide), second: out(h2, isRide),
    hrDriftBpm: h1.hrT && h2.hrT ? r1(h2.hrW / h2.hrT - h1.hrW / h1.hrT) : null,
    aerobicDecouplingPct: e1 && e2 ? r1((e1 - e2) / e1 * 100) : null,
    basis: isRide && h1.wT ? 'power:HR' : 'pace:HR',
  };

  // 심박 존 시간 (LTHR 있을 때)
  let hrZones = null;
  if (opts.lthr > 0) {
    const z = { Z1: 0, Z2: 0, Z3: 0, Z4: 0, Z5: 0 };
    for (const s of segs) if (s.hr != null) z[hrZoneFor(s.hr, opts.lthr)] += s.dt;
    const zt = Object.values(z).reduce((a, b) => a + b, 0);
    hrZones = { lthr: opts.lthr, basis: 'Friel % of LTHR: Z1<85 Z2 85-89 Z3 90-94 Z4 95-99 Z5≥100',
      minutes: Object.fromEntries(Object.entries(z).map(([k, v]) => [k, Math.round(v / 60)])),
      percent: Object.fromEntries(Object.entries(z).map(([k, v]) => [k, zt ? Math.round(v / zt * 100) : 0])) };
  }

  // 페이스 변화: 처음 3구간 vs 마지막 3구간 (완주 구간만)
  const full = splits.filter((s) => !s.partial);
  let fade = null;
  if (full.length >= 6) {
    const k = (s) => (isRide ? s.speedKmh : s.paceMinKm);
    const a = mean(full.slice(0, 3).map(k)), b = mean(full.slice(-3).map(k));
    fade = isRide ? { first3SpeedKmh: r1(a), last3SpeedKmh: r1(b), changePct: r1((b - a) / a * 100) }
                  : { first3PaceMinKm: r2(a), last3PaceMinKm: r2(b), changePct: r1((b - a) / a * 100) }; // 러닝: +면 느려짐
  }

  const formChange = isRide ? null : analyzeForm(full, halves);
  return { totals: out(total, isRide), splits, halves, fade, hrZones, formChange };
}

// 폼 변화: 속도 = 케이던스 × 보폭 이므로 페이스 변화를 둘로 나눔 (ln 비율 기준)
//  - peak: 가장 빨랐던 연속 3구간, last: 마지막 3구간
//  - strideDropFromKm: 피크 이후 보폭이 피크 대비 3% 넘게 줄어든 상태가 끝까지(또는 3구간 연속) 이어진 첫 구간
function analyzeForm(full, halves) {
  const ok = full.filter((s) => s.cadenceSpm && s.strideM);
  if (ok.length < 6) return null;
  const speed = (s) => 1 / s.paceMinKm;
  const avg = (arr, f) => mean(arr.map(f));
  let pi = 0, best = -1;
  for (let i = 0; i + 3 <= ok.length; i++) { const v = avg(ok.slice(i, i + 3), speed); if (v > best) { best = v; pi = i; } }
  const peak = ok.slice(pi, pi + 3), last = ok.slice(-3);
  const split = (A, B) => {
    const dv = Math.log(avg(B, speed) / avg(A, speed));
    const dc = Math.log(avg(B, (s) => s.cadenceSpm) / avg(A, (s) => s.cadenceSpm));
    const ds = Math.log(avg(B, (s) => s.strideM) / avg(A, (s) => s.strideM));
    return {
      speedChangePct: r1((Math.exp(dv) - 1) * 100),
      cadenceChangePct: r1((Math.exp(dc) - 1) * 100),
      strideChangePct: r1((Math.exp(ds) - 1) * 100),
      // 속도 변화 중 보폭이 차지한 몫 (%). 100에 가까우면 보폭이 줄어서 느려진 것
      strideSharePct: Math.abs(dv) > 0.005 ? Math.round(ds / dv * 100) : null,
    };
  };
  const peakStride = avg(peak, (s) => s.strideM), peakCad = avg(peak, (s) => s.cadenceSpm);
  let strideDropFromKm = null;
  const after = ok.slice(pi + 3);
  for (let i = 0; i < after.length; i++) {
    const rest = after.slice(i, Math.min(after.length, i + 3));
    if (rest.length >= Math.min(3, after.length - i) && rest.every((s) => s.strideM < peakStride * 0.97)) { strideDropFromKm = after[i].split; break; }
  }
  const dynDelta = {};
  for (const [k, unit] of [['groundContactMs', 'ms'], ['verticalOscCm', 'cm'], ['verticalRatioPct', '%pt']]) {
    if (peak.every((s) => s[k] != null) && last.every((s) => s[k] != null)) {
      const a = avg(peak, (s) => s[k]), b = avg(last, (s) => s[k]);
      dynDelta[k] = { peak: r1(a), last3: r1(b), change: r1(b - a), unit };
    }
  }
  const h1 = halves.first, h2 = halves.second;
  return {
    peak: { splits: `${peak[0].split}-${peak[2].split}`, paceMinKm: r2(1 / avg(peak, speed)), cadenceSpm: Math.round(peakCad), strideM: r2(peakStride) },
    last3: { splits: `${last[0].split}-${last[2].split}`, paceMinKm: r2(1 / avg(last, speed)), cadenceSpm: Math.round(avg(last, (s) => s.cadenceSpm)), strideM: r2(avg(last, (s) => s.strideM)) },
    peakToLast: split(peak, last),
    strideDropFromKm,
    dynamics: Object.keys(dynDelta).length ? dynDelta : undefined,
    halves: h1.cadenceSpm && h2.cadenceSpm ? { firstCadenceSpm: h1.cadenceSpm, secondCadenceSpm: h2.cadenceSpm, firstStrideM: h1.strideM, secondStrideM: h2.strideM } : undefined,
    basis: 'speed = cadence × stride; stride = distance ÷ steps from the watch cadence. strideSharePct = how much of the speed change came from stride length. dynamics: wrist running dynamics (ground contact time, vertical oscillation, vertical ratio) at the peak vs the last 3 splits.',
  };
}

// Intervals.icu streams.json ([{type, data}] 또는 {type: data}) → samples
export function samplesFromStreams(streams) {
  const map = {};
  if (Array.isArray(streams)) for (const s of streams) { if (s && s.type && Array.isArray(s.data)) map[s.type] = s.data; }
  else if (streams && typeof streams === 'object') for (const [k, v] of Object.entries(streams)) if (Array.isArray(v)) map[k] = v;
  const pick = (...names) => { for (const n of names) if (map[n]) return map[n]; return null; };
  const time = pick('time'), dist = pick('distance');
  if (!time || !dist) return null;
  const hr = pick('heartrate', 'heart_rate', 'hr'), w = pick('watts', 'power'), alt = pick('altitude', 'fixed_altitude', 'enhanced_altitude'), cad = pick('cadence');
  const gct = pick('stance_time', 'ground_contact_time'), vo = pick('vertical_oscillation'), vr = pick('vertical_ratio');
  const n = Math.min(time.length, dist.length), out = [];
  for (let i = 0; i < n; i++) {
    if (time[i] == null || dist[i] == null) continue;
    out.push({ t: +time[i], d: +dist[i], hr: hr && hr[i] > 30 ? +hr[i] : null, w: w && w[i] != null ? +w[i] : null, alt: alt && alt[i] != null ? +alt[i] : null, cad: cad && cad[i] > 0 ? +cad[i] : null,
      dyn: gct || vo || vr ? { gct: gct ? +gct[i] || null : null, vo: vo ? +vo[i] || null : null, vr: vr ? +vr[i] || null : null } : null });
  }
  if (out.length) out.streamTypes = Object.keys(map).sort();
  return out.length ? out : null;
}

// GPX → samples (거리: 좌표 간 직선거리 합)
export function samplesFromGpx(text) {
  const tag = (inner, names) => { const m = inner.match(new RegExp(`<(?:[\\w-]+:)?(?:${names})\\b[^>]*>\\s*([^<\\s][^<]*?)\\s*</(?:[\\w-]+:)?(?:${names})>`, 'i')); return m ? m[1] : null; };
  const pt = /<trkpt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/trkpt>)/gi;
  const out = []; let m, t0 = null, d = 0, prev = null;
  while ((m = pt.exec(text))) {
    const lat = parseFloat((m[1].match(/\blat\s*=\s*["']([^"']+)["']/) || [])[1]);
    const lon = parseFloat((m[1].match(/\blon\s*=\s*["']([^"']+)["']/) || [])[1]);
    const inner = m[2] || '', time = tag(inner, 'time');
    if (!isFinite(lat) || !isFinite(lon) || !time) continue;
    const ts = Date.parse(time) / 1000; if (!ts) continue;
    if (t0 == null) t0 = ts;
    if (prev) d += haversine(prev[0], prev[1], lat, lon);
    prev = [lat, lon];
    const hr = parseFloat(tag(inner, 'hr|heartrate')), w = parseFloat(tag(inner, 'power|watts')), alt = parseFloat(tag(inner, 'ele')), cad = parseFloat(tag(inner, 'cad|cadence'));
    out.push({ t: ts - t0, d, hr: hr > 30 ? hr : null, w: isFinite(w) ? w : null, alt: isFinite(alt) ? alt : null, cad: cad > 0 ? cad : null });
  }
  return out.length ? out : null;
}
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, dLat = (lat2 - lat1) * Math.PI / 180, dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
