// 트랙·트레드밀·실내 활동의 고도 보정
//
// 트랙(400m 운동장)이나 트레드밀은 실제로 평지인데, 워치 기압계·GPS 잡음 때문에
// 하프 한 번에 수백 m 상승고도가 찍히곤 한다 (예: 트랙 21km → 873m).
// 이런 값이 주간 합계·고도 보정·트레일 평균 고도에 섞이지 않도록 0으로 본다.
// 판단은 확실한 경우만: Virtual* 종목, Intervals.icu trainer 플래그, 이름에 트랙/트레드밀/실내.

var FLAT_NAME = /트랙|트레드밀|실내|런닝머신|러닝머신|\btrack\b|treadmill|indoor/i;

// { type, name, trainer } → 평지 장소면 이유 문자열, 아니면 null
export function flatVenueReason(a) {
  if (!a) return null;
  var type = String(a.type || a.intervalsType || a.gpxType || "");
  if (/^Virtual/i.test(type)) return "실내 종목 (" + type + ")";
  if (a.trainer === true) return "실내 훈련 표시 (trainer)";
  var m = String(a.name || "").match(FLAT_NAME);
  if (m) return "이름에 '" + m[0] + "' — 트랙·실내는 평지로 봄";
  return null;
}

// YMC 앱 활동 객체에 보정 적용 (바뀌었으면 새 객체, 아니면 그대로)
export function correctActivityElevation(act) {
  if (!act || act.elevationCorrected) return act;
  var reason = flatVenueReason(act);
  if (!reason || !(act.elevationGain > 0 || act.elevationLoss > 0)) return act;
  return Object.assign({}, act, {
    recordedElevationGain: act.elevationGain || 0,
    elevationGain: 0, elevationLoss: 0,
    elevationCorrected: reason,
  });
}
