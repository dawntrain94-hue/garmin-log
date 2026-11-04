// 지속 고강도 시간 계산 (Sweet Spot 이상)
//
// 라이딩 전체 평균 파워로는 "오르막에서만 Sweet Spot" 같은 훈련이 안 보여서,
// 30초 평균 파워를 순서대로 저장해 두고(6시간 라이딩 ≈ 720개 숫자),
// FTP × 85% 이상이 2분 이상 이어진 구간만 합산한다.
// → 짧은 스프린트·신호 출발은 빠지고, 오르막 인터벌·나눠 탄 블록은 잡힘.
// FTP가 바뀌어도 다시 계산할 수 있게 와트 그대로 저장.

var BIN_S = 30;
var MAX_GAP_S = 10;   // 이보다 긴 기록 끊김(정지 등)은 블록을 끊음
var GAP = -1;

// series: [[unixSeconds, watts], ...] (시간순)
export function buildPowerBins(series) {
  if (!series || series.length < 60) return null;
  var bins = [], acc = 0, accT = 0, moving = 0;
  for (var i = 1; i < series.length; i++) {
    var dt = series[i][0] - series[i - 1][0];
    if (!(dt > 0 && dt <= MAX_GAP_S)) {
      if (accT >= BIN_S / 2) bins.push(Math.round(acc / accT));
      acc = 0; accT = 0;
      if (bins.length && bins[bins.length - 1] !== GAP) bins.push(GAP);
      continue;
    }
    acc += series[i][1] * dt; accT += dt; moving += dt;
    if (accT >= BIN_S) { bins.push(Math.round(acc / accT)); acc = 0; accT = 0; }
  }
  if (accT >= BIN_S / 2) bins.push(Math.round(acc / accT));
  return moving >= 600 ? bins : null; // 파워 기록 10분 미만이면 의미 없음
}

// FTP × fraction 이상이 minMinutes 이상 이어진 구간의 누적 시간(분)
export function sustainedMinutes(bins, ftp, fraction, minMinutes) {
  if (!bins || !(ftp > 0)) return 0;
  var watts = ftp * fraction, need = Math.ceil((minMinutes || 2) * 60 / BIN_S);
  var total = 0, run = 0;
  for (var i = 0; i <= bins.length; i++) {
    var b = i < bins.length ? bins[i] : GAP;
    if (b !== GAP && b >= watts) { run++; continue; }
    if (run >= need) total += run;
    run = 0;
  }
  return total * BIN_S / 60;
}
