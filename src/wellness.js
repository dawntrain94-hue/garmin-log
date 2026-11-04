// 회복 데이터 (Intervals.icu Wellness: Garmin HRV, 안정시 심박, VO2max, 수면)
//
// HRV 판단 방식: 최근 7일 평균 ln(rMSSD)를 직전 8~60일 기준선(평균 ± 표준편차)과 비교.
// 하루 값은 변동이 커서 주간 평균과 개인 기준선을 쓰는 방식 (Plews 등 HRV-guided training 연구).
// condAdj는 기존 condFactor와 같은 방향: 1보다 크면 피로(예측 페이스 느리게), 작으면 양호.

var DAY = 86400000;
var KEEP_DAYS = 400;

function dayNum(dateStr) { return Math.floor(new Date(dateStr + "T00:00:00Z").getTime() / DAY); }
function mean(a) { return a.reduce(function (s, x) { return s + x; }, 0) / a.length; }
function sd(a) {
  if (a.length < 2) return 0;
  var m = mean(a);
  return Math.sqrt(a.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / (a.length - 1));
}

// 날짜별로 합치기 (새 값이 있는 필드만 덮어씀), 오래된 건 정리
export function mergeWellness(existing, incoming, todayStr) {
  var byDate = {};
  (existing || []).forEach(function (w) { if (w && w.date) byDate[w.date] = Object.assign({}, w); });
  (incoming || []).forEach(function (w) {
    if (!w || !w.date) return;
    var cur = byDate[w.date] || { date: w.date };
    Object.keys(w).forEach(function (k) { if (w[k] != null) cur[k] = w[k]; });
    byDate[w.date] = cur;
  });
  var cutoff = dayNum(todayStr) - KEEP_DAYS;
  return Object.keys(byDate).sort()
    .filter(function (d) { return dayNum(d) >= cutoff; })
    .map(function (d) { return byDate[d]; });
}

function latestOf(list, field) {
  for (var i = list.length - 1; i >= 0; i--) if (list[i][field] != null) return { date: list[i].date, value: list[i][field] };
  return null;
}

export function computeWellnessStatus(list, todayStr) {
  if (!list || !list.length) return null;
  list = list.filter(function (w) { return w && w.date; })
    .slice().sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  var today = dayNum(todayStr);
  var ago = function (w) { return today - dayNum(w.date); };

  var latest = {
    hrv: latestOf(list, "hrv"), restingHR: latestOf(list, "restingHR"),
    vo2max: latestOf(list, "vo2max"), weight: latestOf(list, "weight"),
    sleepHours: latestOf(list, "sleepHours"),
  };

  var goods = [], warnings = [], details = [];
  var hrvAdj = 1.0, rhrAdj = 1.0, hrv = null, rhr = null;

  // ── HRV
  var lastHrv = latest.hrv;
  var fresh = lastHrv && (today - dayNum(lastHrv.date)) <= 3;
  var recentH = list.filter(function (w) { return w.hrv && ago(w) >= 0 && ago(w) < 7; }).map(function (w) { return Math.log(w.hrv); });
  var baseH = list.filter(function (w) { return w.hrv && ago(w) >= 7 && ago(w) < 60; }).map(function (w) { return Math.log(w.hrv); });
  if (fresh && recentH.length >= 3 && baseH.length >= 14) {
    var bm = mean(baseH), bs = Math.max(sd(baseH), 0.03); // 너무 작은 SD로 과민 반응 방지
    var z = (mean(recentH) - bm) / bs;
    hrv = {
      recent: Math.round(Math.exp(mean(recentH))),
      base: Math.round(Math.exp(bm)),
      low: Math.round(Math.exp(bm - 0.5 * bs)), high: Math.round(Math.exp(bm + 0.5 * bs)),
      z: +z.toFixed(2),
    };
    var hrvLabel = "HRV 7일 평균 " + hrv.recent + "ms (평소 " + hrv.low + "~" + hrv.high + ")";
    if (z < -1.0) { hrvAdj = 1.03; warnings.push(hrvLabel + " — 평소보다 크게 낮음, 회복 우선"); hrv.state = "low"; }
    else if (z < -0.5) { hrvAdj = 1.015; warnings.push(hrvLabel + " — 평소보다 낮음"); hrv.state = "low"; }
    else if (z > 0.5) { hrvAdj = 0.99; goods.push(hrvLabel + " — 회복 양호"); hrv.state = "high"; }
    else { details.push(hrvLabel + " — 정상 범위"); hrv.state = "normal"; }
  } else if (lastHrv) {
    details.push(fresh ? "HRV 기준선 쌓는 중 (2주 이상 필요)" : "최근 3일 HRV 데이터 없음 — SYNC로 갱신");
  }

  // ── 안정시 심박
  var recentR = list.filter(function (w) { return w.restingHR && ago(w) >= 0 && ago(w) < 7; }).map(function (w) { return w.restingHR; });
  var baseR = list.filter(function (w) { return w.restingHR && ago(w) >= 7 && ago(w) < 60; }).map(function (w) { return w.restingHR; });
  var rFresh = latest.restingHR && (today - dayNum(latest.restingHR.date)) <= 3;
  if (rFresh && recentR.length >= 3 && baseR.length >= 14) {
    rhr = { recent: +mean(recentR).toFixed(1), base: +mean(baseR).toFixed(1) };
    rhr.diff = +(rhr.recent - rhr.base).toFixed(1);
    var rhrLabel = "안정시 심박 7일 평균 " + Math.round(rhr.recent) + "bpm (평소 " + Math.round(rhr.base) + ")";
    if (rhr.diff >= 5) { rhrAdj = 1.01; warnings.push(rhrLabel + " — 5bpm 이상 높음, 피로·컨디션 저하 신호"); }
    else if (rhr.diff >= 3) details.push(rhrLabel + " — 약간 높음");
    else if (rhr.diff <= -2) goods.push(rhrLabel + " — 안정적");
  }

  // ── 수면 (참고만, 보정 없음)
  var recentS = list.filter(function (w) { return w.sleepHours && ago(w) >= 0 && ago(w) < 7; }).map(function (w) { return w.sleepHours; });
  var sleepAvg = recentS.length >= 3 ? +mean(recentS).toFixed(1) : null;
  if (sleepAvg != null && sleepAvg < 6) warnings.push("최근 7일 평균 수면 " + sleepAvg + "시간 — 부족");

  return {
    latest: latest, hrv: hrv, rhr: rhr, sleepAvg: sleepAvg,
    condAdj: +(hrvAdj * rhrAdj).toFixed(4),
    goods: goods, warnings: warnings, details: details,
  };
}
