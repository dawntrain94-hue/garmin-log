// 같은 운동을 기기 두 대로 동시에 기록한 경우(예: Edge + Forerunner) 하나만 남기기
//
// 같은 종목군(라이딩끼리 / 러닝끼리)이고 시간이 겹치면 같은 운동으로 본다.
// 한 사람이 같은 시간에 라이딩 두 개를 할 수는 없으니, 겹침이 10분 이상이거나
// 짧은 쪽의 절반 이상이면 중복. (워치가 한 라이딩을 두 조각으로 나눠 기록한 경우도 잡힘)
// 남기는 기준: 파워 데이터가 있는 기록 → 둘 다 있거나 없으면 더 오래 기록된 것.

var RIDE = { Ride: 1, VirtualRide: 1, GravelRide: 1, EBikeRide: 1, MountainBikeRide: 1 };
var RUN = { Run: 1, TrailRun: 1, VirtualRun: 1 };
var MIN_OVERLAP_S = 10 * 60;

function family(type) { return RIDE[type] ? "ride" : RUN[type] ? "run" : null; }

// "2026-10-09T10:41:07" (현지 시각, 시간대 없음) → 초. 비교만 하므로 시간대는 무시해도 됨
function toSec(start) {
  var m = String(start || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000 : null;
}

// get(a) → { id, start, type, durationSec (경과 시간, 없으면 이동 시간), hasPower }
// 반환: { keep: [...], dropped: [{ item, keptId }] }
export function dedupeActivities(list, get) {
  var rows = (list || []).map(function (a, i) {
    var g = get(a), t = toSec(g.start), dur = Math.max(0, g.durationSec || 0);
    return { a: a, i: i, id: g.id, fam: family(g.type), t: t, end: t == null ? null : t + dur, dur: dur, power: !!g.hasPower };
  });
  var better = function (x, y) { // x를 y 대신 남길 것인가
    if (x.power !== y.power) return x.power;
    return x.dur > y.dur;
  };
  var isDup = function (x, y) {
    var overlap = Math.min(x.end, y.end) - Math.max(x.t, y.t);
    if (overlap <= 0) return Math.abs(x.t - y.t) <= 120 && (x.dur < 120 || y.dur < 120); // 시작만 같은 짧은 조각
    return overlap >= Math.min(MIN_OVERLAP_S, 0.5 * Math.min(x.dur, y.dur));
  };

  var cand = rows.filter(function (r) { return r.fam && r.t != null; }).sort(function (x, y) { return x.t - y.t; });
  var winner = {}; // 밀려난 기록 → 이긴 기록
  for (var i = 0; i < cand.length; i++) {
    for (var j = i + 1; j < cand.length && cand[j].t <= cand[i].end + 120; j++) {
      var x = cand[i], y = cand[j];
      if (x.fam !== y.fam || !isDup(x, y)) continue;
      var xs = root(x), ys = root(y);
      if (xs === ys) continue;
      if (better(ys, xs)) winner[xs.i] = ys; else winner[ys.i] = xs;
    }
  }
  function root(r) { while (winner[r.i]) r = winner[r.i]; return r; }

  return {
    keep: rows.filter(function (r) { return !winner[r.i]; }).map(function (r) { return r.a; }),
    dropped: rows.filter(function (r) { return winner[r.i]; }).map(function (r) { return { item: r.a, keptId: root(r).id }; }),
  };
}
