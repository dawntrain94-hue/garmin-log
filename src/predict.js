// YMC 대회 예측 — 앱(🎯 예측 탭)과 Claude 커넥터(/api/mcp predict_race)가 같이 쓰는 계산.
// App.jsx의 runLocalPrediction에서 그대로 옮겨온 순수 함수 (React 상태 없음).
//
// input:
//   activities  YMC 활동 배열 (최신순). 필드: sport(road_run|trail_run|cycling|mtb), distanceKm, durationMin,
//               avgPaceMinKm, avgHR, elevationGain, activityDate(YYYY-MM-DD), avgPower, powerBins
//   profile     { ltPaceMinKm, ltHR, maxHR, ftp, weight, vdot, age, gender } (문자열/숫자 모두 가능)
//   wellness    [{ date, hrv, restingHR, sleepHours, ... }] (computeWellnessStatus 입력)
//   sport       목표 종목, raceKm 목표 거리
//   courseData  { distanceKm, elevationGain, gainPerKm, elevProfile } 또는 null
//   manualEleGain 사이클 코스 획득고도 수동 입력값 (선택)
//   now / today 기준 시각(ms) / 기준 날짜(YYYY-MM-DD) — 서버에서 Asia/Seoul 기준으로 넘김
// 반환: { error } 또는 { raceKm, hasProfile, noActivity, cyclingRows, runningRows, trainingSummary,
//        trainingReadiness, wellnessStatus, sport, hasCourse, courseData, effectiveEleGain }

import { computeWellnessStatus } from "./wellness.js";
import { sustainedMinutes } from "./intensity.js";

export function calcVDOT(distKm, timeMin) {
  var v = (distKm * 1000) / timeMin; // m/min
  var t = timeMin;
  var numerator = -4.6 + 0.182258*v + 0.000104*v*v;
  var denominator = 0.8 + 0.1894393*Math.exp(-0.012778*t) + 0.2989558*Math.exp(-0.1932605*t);
  return +(numerator/denominator).toFixed(1);
}

// VDOT으로 특정 거리 예측 시간(분) 계산 — 수치해석으로 역산
export function vdotToPaceMinKm(vdot, distKm) {
  // t(분)에 대해 이진 탐색으로 calcVDOT(distKm, t) ≈ vdot 만족하는 t 찾기
  var lo = distKm * 1.5, hi = distKm * 30; // 분 범위
  for (var i = 0; i < 60; i++) {
    var mid = (lo+hi)/2;
    if (calcVDOT(distKm, mid) > vdot) lo = mid;
    else hi = mid;
  }
  var totalMin = (lo+hi)/2;
  return totalMin / distKm; // min/km
}

export function formatPace(p) {
  if (!p || p <= 0) return "—";
  var min = Math.floor(p), sec = Math.round((p-min)*60);
  return min+"'"+String(sec).padStart(2,"0")+'"';
}

// ── 사이클링 물리 시뮬레이션 ──────────────────────────────────────────────────
export function calcCyclingTime(ftp, distKm, eleGain, weightKg, elevProfile, customZones) {
  if (!ftp || !distKm) return null;
  var ftpW = parseFloat(ftp), dist = parseFloat(distKm);
  var kg = (parseFloat(weightKg)||70)+8, g = 9.81, CdA = 0.38, rho = 1.1, Crr = 0.004;

  function uphillSpeed(power, grade) {
    var a = 0.5*CdA*rho, c = Crr*kg*g + kg*g*grade;
    if (c <= 0) return 10;
    var v = Math.min(power/c, 15);
    for (var i = 0; i < 60; i++) {
      var f = a*v*v*v+c*v-power, df = 3*a*v*v+c;
      if (Math.abs(df) < 0.001) break;
      v -= f/df; v = Math.max(0.3, Math.min(v,20));
      if (Math.abs(f/df) < 0.0001) break;
    }
    return v;
  }
  function downhillSpeed(power, grade) {
    var a = 0.5*CdA*rho, gf = kg*g*Math.abs(grade), rr = Crr*kg*g;
    var coast = gf > rr ? Math.sqrt((gf-rr)/(0.5*CdA*rho)) : 0;
    var v = Math.max(coast, 3.0);
    for (var i = 0; i < 60; i++) {
      var f = a*v*v*v+Crr*kg*g*v-power-kg*g*Math.abs(grade)*v;
      var df = 3*a*v*v+Crr*kg*g-kg*g*Math.abs(grade);
      if (Math.abs(df) < 0.001) break;
      v -= f/df; v = Math.max(0.5, Math.min(v,22));
      if (Math.abs(f/df) < 0.0001) break;
    }
    return Math.max(v, coast);
  }

  var zones = customZones || [
    {label:"Z2 편안 (IF 0.62)", pct:0.62, desc:"입문/회복 — 대화 가능"},
    {label:"Z2 중간 (IF 0.68)", pct:0.68, desc:"장거리 지속 — 실전 검증 페이스"},
    {label:"Z3 템포 (IF 0.75)", pct:0.75, desc:"편안하게 힘든 — 중급 목표"},
    {label:"Z4 역치 (IF 0.90)", pct:0.90, desc:"매우 힘듦 — 상급자"},
  ];

  return zones.map(function(z) {
    var power = ftpW * z.pct, totalTimeSec = 0;
    if (elevProfile && elevProfile.length >= 2) {
      var n = elevProfile.length, segDistM = dist*1000/(n-1);
      var profileToUse = elevProfile;
      if (eleGain && parseFloat(eleGain) > 0) {
        var profileGain = 0, pb = elevProfile[0];
        for (var pi = 1; pi < elevProfile.length; pi++) {
          var pd = elevProfile[pi]-pb;
          if (pd > 0.5) { profileGain += pd; pb = elevProfile[pi]; }
          else if (pd < -0.5) { pb = elevProfile[pi]; }
        }
        if (profileGain > 0) {
          var scale = parseFloat(eleGain)/profileGain, baseEle = elevProfile[0];
          profileToUse = elevProfile.map(function(e){return baseEle+(e-baseEle)*scale;});
        }
      }
      for (var i = 0; i < n-1; i++) {
        var dEle = profileToUse[i+1]-profileToUse[i], grade = dEle/segDistM;
        var speedMs;
        if (grade >= -0.005) {
          speedMs = uphillSpeed(power, Math.max(grade,0));
          if (grade > 0.12) speedMs = Math.min(speedMs, 10/3.6);
          else if (grade > 0.08) speedMs = Math.min(speedMs, 14/3.6);
          else if (grade > 0.04) speedMs = Math.min(speedMs, 18/3.6);
          speedMs = Math.max(speedMs, 1/3.6);
        } else {
          speedMs = downhillSpeed(power, grade);
          if (grade < -0.10) speedMs = Math.min(speedMs, 50/3.6);
          else if (grade < -0.06) speedMs = Math.min(speedMs, 55/3.6);
          else speedMs = Math.min(speedMs, 60/3.6);
        }
        totalTimeSec += segDistM/speedMs;
      }
    } else {
      var avgGrade = eleGain ? parseFloat(eleGain)/(dist*1000) : 0;
      var spd = uphillSpeed(power, avgGrade)*3.6;
      spd = Math.max(12, Math.min(spd,35));
      totalTimeSec = dist/spd*3600;
    }
    var stopTimeSec = (dist/100)*10*60;
    totalTimeSec += stopTimeSec;
    var movingSec = totalTimeSec - stopTimeSec;
    var tH = Math.floor(totalTimeSec/3600), tM = Math.round((totalTimeSec%3600)/60);
    if (tM===60){tH++;tM=0;}
    var movH = Math.floor(movingSec/3600), movM = Math.round((movingSec%3600)/60);
    if (movM===60){movH++;movM=0;}
    return {
      label: z.label, desc: z.desc,
      power: Math.round(power), if_val: z.pct.toFixed(2),
      speed: (dist/(totalTimeSec/3600)).toFixed(1),
      movSpeed: (dist/(movingSec/3600)).toFixed(1),
      time: tH+"h "+String(tM).padStart(2,"0")+"m",
      movTime: movH+"h "+String(movM).padStart(2,"0")+"m",
      timeHours: totalTimeSec/3600,
    };
  });
}

export function predictRace(input) {
    var activities = input.activities || [];
    var profile = input.profile || {};
    var wellness = input.wellness || [];
    var sport = input.sport;
    var courseData = input.courseData || null;
    var manualEleGain = input.manualEleGain || "";
    var today = input.today;
    var raceKm = parseFloat(input.raceKm) || 0;
    if (!raceKm) return { error: "목표 거리를 입력해주세요" };
    var hasProfile = !!(profile.ltPaceMinKm||profile.ftp||profile.ltHR);
    if (!activities.length && !hasProfile) return { error: "활동 데이터 또는 프로필(LT/FTP)이 필요해요" };
    var noActivity = activities.length === 0;

    var isCyclingTarget = (sport==="cycling"||sport==="mtb");
    var isRunningTarget = (sport==="trail_run"||sport==="road_run");

    // 페이스/강도 계산용: 동종 종목만 (트레일 5'42"를 로드 기준에 쓰면 안 됨)
    var relevantActs = activities.filter(function(a){
      if (isCyclingTarget) return (a.sport==="cycling"||a.sport==="mtb");
      return a.sport === sport; // 로드런이면 로드런만, 트레일이면 트레일만
    });

    // 크로스트레이닝: 유산소 기저(심폐)에 기여하는 이종 종목
    // 사이클 ↔ 러닝, 로드런 ↔ 트레일런 (페이스는 다르지만 심폐는 전이됨)
    var crossActs = activities.filter(function(a){
      if (isCyclingTarget) return (a.sport==="trail_run"||a.sport==="road_run");
      if (sport==="road_run") return (a.sport==="trail_run"||a.sport==="cycling"||a.sport==="mtb");
      if (sport==="trail_run") return (a.sport==="road_run"||a.sport==="cycling"||a.sport==="mtb");
      return false;
    });
    // 크로스 가중치: 같은 러닝군은 85%(페이스 외 유산소 대부분 전이), 사이클은 25%
    // crossActs 항목별로 가중치를 다르게 적용
    function getCrossWeight(act) {
      if (isCyclingTarget) return 0.20; // 사이클에서 러닝 기여
      if (sport==="road_run"&&act.sport==="trail_run") return 0.85; // 트레일→로드 심폐 거의 동일
      if (sport==="trail_run"&&act.sport==="road_run") return 0.85; // 로드→트레일 심폐 거의 동일
      return 0.25; // 사이클↔러닝
    }
    var CROSS_WEIGHT = 0.25; // fallback (주간볼륨 계산 시 동적으로 대체)

    var recent = relevantActs.slice(0,20);
    var totalVolKm = relevantActs.reduce(function(a,b){return a+b.distanceKm;},0);
    var maxActDist = relevantActs.length ? Math.max.apply(null,relevantActs.map(function(a){return a.distanceKm;})) : 0;
    var avgElePerKm = relevantActs.length && totalVolKm > 0 ? relevantActs.reduce(function(a,b){return a+(b.elevationGain||0);},0)/totalVolKm : 0;
    var now = input.now != null ? input.now : Date.now();

    // ── Banister 모델 기반 3개 시간창 분석
    var DAY = 86400000;
    var ctl42 = relevantActs.filter(function(a){return now-new Date(a.activityDate||a.uploadedAt).getTime()<42*DAY;});
    var ctl70 = relevantActs.filter(function(a){return now-new Date(a.activityDate||a.uploadedAt).getTime()<70*DAY;});
    var atl7  = relevantActs.filter(function(a){return now-new Date(a.activityDate||a.uploadedAt).getTime()<7.5*DAY;});
    var atl14 = relevantActs.filter(function(a){return now-new Date(a.activityDate||a.uploadedAt).getTime()<14*DAY;});
    var cond28= relevantActs.filter(function(a){return now-new Date(a.activityDate||a.uploadedAt).getTime()<28*DAY;});

    // 크로스트레이닝 시간창 (42일 이내)
    var cross42 = crossActs.filter(function(a){return now-new Date(a.activityDate||a.uploadedAt).getTime()<42*DAY;});
    var cross7  = crossActs.filter(function(a){return now-new Date(a.activityDate||a.uploadedAt).getTime()<7*DAY;});

    // 크로스트레이닝: 거리 환산 → 시간×강도(TRIMP) 기반으로 교체
    // 근거: 거리는 종목 간 비교 불가, 운동 시간×심박 강도가 유일한 공통 지표
    // (Banister TRIMP: load = duration × HR_ratio × e^(1.92×HR_ratio))
    // 실용화: durationMin × intensityFactor로 단순화
    // intensityFactor: Z2(0.3) / Z3(0.6) / Z4+(1.0) — 러닝이 사이클보다 VO2 전이 더 큼
    var lthrRef2 = profile.ltHR ? parseFloat(profile.ltHR) : 0;
    var maxHRRef = profile.maxHR ? parseFloat(profile.maxHR) : (lthrRef2 > 0 ? lthrRef2/0.87 : 0);

    function crossTRIMP(act, towardCycling, lthrRef2, maxHRRef) {
      // 운동 시간 추정 (없으면 거리/평균속도)
      var durMin = act.durationMin || 0;
      if (!durMin && act.distanceKm > 0 && act.avgPaceMinKm > 0)
        durMin = act.distanceKm * act.avgPaceMinKm;

      // 강도 계수 (심박 기반 우선, 없으면 페이스/속도 기반 추정)
      var intensityF = 0.4; // 기본값 (중간 강도)
      var hrRef = maxHRRef > 0 ? maxHRRef : (lthrRef2 > 0 ? lthrRef2/0.87 : 0);
      if (act.avgHR && hrRef > 0) {
        var hrRatio = act.avgHR / hrRef;
        if (hrRatio < 0.65)      intensityF = 0.20; // Z1 회복
        else if (hrRatio < 0.75) intensityF = 0.35; // Z2 유산소
        else if (hrRatio < 0.85) intensityF = 0.60; // Z3 템포
        else if (hrRatio < 0.92) intensityF = 0.85; // Z4 역치
        else                     intensityF = 1.00; // Z5 VO2max
      }

      // 종목별 VO2 전이 계수
      // 러닝→사이클: 심폐 전이 80%, 근육 특이성 낮음
      // 사이클→러닝: 심폐 전이 70%, 충격 부하 적응 안됨
      // 트레일→로드: 심폐 거의 동일, 지형 차이만 (90%)
      var transferRate = 0.7;
      if (!towardCycling) { // 러닝 예측 시 크로스 = 사이클
        transferRate = 0.70;
      } else { // 사이클 예측 시 크로스 = 러닝
        var isCrossTrail = (act.sport === "trail_run");
        transferRate = isCrossTrail ? 0.75 : 0.80;
      }

      return durMin * intensityF * transferRate; // TRIMP 점수 (분 단위)
    }

    // 피트니스 기여: 42일 크로스트레이닝 TRIMP 합산
    var crossTRIMP42 = cross42.reduce(function(a,b){return a+crossTRIMP(b,isCyclingTarget,lthrRef2,maxHRRef);},0);
    // 이번 주 크로스 피로 기여: 7일 TRIMP
    var crossTRIMP7  = cross7.reduce(function(a,b){return a+crossTRIMP(b,isCyclingTarget,lthrRef2,maxHRRef);},0);

    // 피트니스 창: 6~10주 데이터 우선 (CTL 42일), 없으면 70일
    var fitnessActs = ctl42.length >= 3 ? ctl42 : (ctl70.length >= 2 ? ctl70 : relevantActs);

    // 준비도/내구성 평가용 확장 활동 목록
    // 트레일런 ↔ 로드런: 유산소 기저 85% 전이, 빈도·내구성에 반영
    // 사이클: 러닝 준비도에 25% 반영 (심폐만)
    // 페이스 계산에는 사용하지 않음 (종목 특이성 유지)
    var fitnessActsForReadiness = fitnessActs.slice(); // 동종 100%
    if (!isCyclingTarget) {
      // 러닝 준비도: 반대 러닝군(트레일↔로드) 85% + 사이클 25% 가상 활동으로 추가
      crossActs.forEach(function(ca) {
        var w = (ca.sport==="trail_run"||ca.sport==="road_run") ? 0.85 : 0.25;
        fitnessActsForReadiness.push(Object.assign({}, ca, {
          distanceKm: ca.distanceKm * w,
          _isCrossWeighted: true,
          _crossWeight: w,
        }));
      });
    }

    // 동종 훈련 TRIMP (fitnessActs 정의 후 계산)
    var sameTRIMP42 = fitnessActs.reduce(function(a,b){
      var dur = b.durationMin || (b.distanceKm && b.avgPaceMinKm ? b.distanceKm*b.avgPaceMinKm : 0);
      return a + dur * 0.7;
    },0);
    var sameTRIMP7  = atl7.reduce(function(a,b){
      var dur = b.durationMin || (b.distanceKm && b.avgPaceMinKm ? b.distanceKm*b.avgPaceMinKm : 0);
      return a + dur * 0.7;
    },0);

    // 크로스 기여 비율 (표시용)
    var crossContribPct = sameTRIMP42 > 0
      ? Math.round(crossTRIMP42 / (sameTRIMP42 + crossTRIMP42) * 100)
      : 0;

    // 주간 볼륨: 동종 + 크로스 환산 합산 (ATL 방식)
    var crossVolKmEquiv = 0;
    var crossWeeklyKmEquiv = 0;

    var wk1Km = atl7.reduce(function(a,b){return a+b.distanceKm;},0);
    var wk2to4Km = cond28.filter(function(a){return now-new Date(a.activityDate||a.uploadedAt).getTime()>=7*DAY;})
      .reduce(function(a,b){return a+b.distanceKm;},0);
    var weeklyVolKm = wk1Km * 0.5 + (wk2to4Km/3) * 0.5;

    // 피트니스 기반 페이스: 이상치 제거 후 계산 (IQR 방식)
    var rawPaces = fitnessActs.filter(function(a){return a.avgPaceMinKm>1&&a.avgPaceMinKm<20;}).map(function(a){return a.avgPaceMinKm;});
    var validPaces = rawPaces;
    if (rawPaces.length >= 4) {
      var sortedP = rawPaces.slice().sort(function(a,b){return a-b;});
      var q1 = sortedP[Math.floor(sortedP.length*0.25)];
      var q3 = sortedP[Math.floor(sortedP.length*0.75)];
      var iqr = q3 - q1;
      validPaces = rawPaces.filter(function(p){return p >= q1-iqr*1.5 && p <= q3+iqr*1.5;});
    }
    var recentAvgPace = validPaces.length ? validPaces.reduce(function(a,b){return a+b;},0)/validPaces.length : 0;

    // 장거리 훈련 페이스 (목표의 40% 이상, 6~10주 이내)
    var longActs = fitnessActs.filter(function(a){return a.distanceKm>=raceKm*0.4&&a.avgPaceMinKm>1;});
    var recentLongPace = longActs.length ? longActs.reduce(function(a,b){return a+b.avgPaceMinKm;},0)/longActs.length : 0;

    // 컨디션 계수: 동종 + 크로스 포함 전체 부하 기반
    // 컨디션 계수 (TSB 근사): 동종 훈련 + 강도 가중 크로스트레이닝 피로
    var condFactor = 1.0;
    if (fitnessActs.length >= 2) {
      var wk1KmPure = atl7.reduce(function(a,b){return a+b.distanceKm;},0);

      // 크로스트레이닝 피로 기여: 강도에 따라 가중
      // 심박 데이터 있으면 강도 추정, 없으면 보수적 10% 반영
      var lthrRef = profile.ltHR ? parseFloat(profile.ltHR) : 0;
      var crossFatigue = cross7.reduce(function(acc, a) {
        var distKm = isCyclingTarget ? a.distanceKm / 3 : a.distanceKm; // 환산 거리
        if (lthrRef > 0 && a.avgHR) {
          // 고강도(역치 이상): 40% 반영, 저강도: 10% 반영
          var intensity = a.avgHR / lthrRef;
          var crossW = intensity >= 0.85 ? 0.40 : 0.10;
          return acc + distKm * crossW;
        }
        return acc + distKm * 0.10; // 강도 모르면 저강도 가정
      }, 0);

      var ftBaseKm = fitnessActs.reduce(function(a,b){return a+b.distanceKm;},0)
        / Math.max(1, fitnessActs.length / (fitnessActs.length > 4 ? 1.5 : 1));
      var wk1Total = wk1KmPure + crossFatigue; // 동종 + 강도 가중 크로스
      var tsb = ftBaseKm > 0 ? (ftBaseKm - wk1Total) / ftBaseKm : 0;
      if (tsb > 0.3)       condFactor = 0.97;
      else if (tsb > 0.1)  condFactor = 0.99;
      else if (tsb < -0.3) condFactor = 1.04;
      else if (tsb < -0.1) condFactor = 1.02;
    }

    var fitnessWindowLabel = ctl42.length >= 3 ? "6주(42일)" : (ctl70.length >= 2 ? "10주(70일)" : "전체 기간");
    var condLabel = condFactor < 1.0 ? "컨디션 양호" : (condFactor > 1.02 ? "피로 축적" : "보통");
    var hasCrossTraining = cross42.length > 0;

    // ── 훈련 충분도 평가 ────────────────────────────────────────────────────────
    var trainingReadiness = (function(){
      if (relevantActs.length === 0) return null;
      var score = 0, maxScore = 0;
      var goods = [], warnings = [], details = [];

      // 종목별 주간 볼륨 기준 (현실적 아마추어 기준)
      // 사이클: 목표거리 30% 이상이면 보통, 50% 이상이면 충분
      //   100km 그란폰도: 30km+ 보통, 50km+ 충분
      //   200km 코스:    60km+ 보통, 100km+ 충분
      // 러닝: 목표거리 40% 이상이면 보통, 70% 이상이면 충분
      var volMin  = isCyclingTarget ? Math.floor(raceKm * 0.30) : Math.floor(raceKm * 0.40);
      var volGood = isCyclingTarget ? Math.floor(raceKm * 0.50) : Math.floor(raceKm * 0.70);

      // ① 주간 볼륨
      maxScore += 25;
      var thisWeekKm = atl7.reduce(function(a,b){return a+b.distanceKm;},0);
      var wk7label = isCyclingTarget
        ? atl7.length+"회 / "+thisWeekKm.toFixed(0)+"km"
        : thisWeekKm.toFixed(0)+"km";

      if (thisWeekKm >= volGood) {
        score += 25;
        goods.push("최근 7일 "+(isCyclingTarget?"라이딩":"러닝")+" 충분 — "+wk7label);
      } else if (thisWeekKm >= volMin) {
        score += 15;
        details.push("최근 7일 "+(isCyclingTarget?"라이딩":"러닝")+" 보통 — "+wk7label);
      } else if (thisWeekKm > 0) {
        score += 5;
        var rec = Math.round(volMin)+"km/주 이상 권장";
        warnings.push("최근 7일 "+(isCyclingTarget?"라이딩":"러닝")+" 부족 — "+wk7label+", "+rec);
      } else { warnings.push("최근 7일 훈련 없음"); }

      // ② 롱런/롱라이드 (사이클은 60%, 러닝은 70% 기준)
      maxScore += 30;
      var longThresh = isCyclingTarget ? raceKm * 0.6 : raceKm * 0.7;
      var midThresh  = isCyclingTarget ? raceKm * 0.4 : raceKm * 0.5;
      var longActs2  = fitnessActsForReadiness.filter(function(a){return a.distanceKm>=longThresh;});
      var midActs2   = fitnessActsForReadiness.filter(function(a){return a.distanceKm>=midThresh;});
      var actLabel   = isCyclingTarget ? "롱라이드" : "롱런";
      if (longActs2.length >= 2)      { score += 30; goods.push(actLabel+" 충분 — "+Math.round(longThresh)+"km 이상 "+longActs2.length+"회"); }
      else if (longActs2.length >= 1) { score += 20; goods.push(actLabel+" 1회 — 목표의 "+Math.round(longThresh/raceKm*100)+"% 달성"); }
      else if (midActs2.length >= 1)  { score += 10; warnings.push(actLabel+" 부족 — "+Math.round(longThresh)+"km 이상 훈련 1회 권장"); }
      else                             { warnings.push("장거리 훈련 없음 — "+Math.round(midThresh)+"km 이상 훈련 필요"); }

      // ③ 훈련 빈도 (주 3회 기준)
      maxScore += 20;
      var daysSpanned = Math.max(1, Math.min(42, fitnessActsForReadiness.length > 1 ? (function(){
        var dates = fitnessActsForReadiness.map(function(a){return new Date(a.activityDate||a.uploadedAt).getTime();});
        return Math.round((Math.max.apply(null,dates)-Math.min.apply(null,dates))/86400000)+1;
      })() : 7));
      var weeklyFreq = fitnessActsForReadiness.length / (daysSpanned/7);
      if (weeklyFreq >= 4)       { score += 20; goods.push("훈련 빈도 양호 — 이번 주 "+Math.round(weeklyFreq)+"회 이상 훈련"); }
      else if (weeklyFreq >= 3)  { score += 15; details.push("훈련 빈도 보통 — 주 평균 "+Math.round(weeklyFreq)+"회 훈련"); }
      else if (weeklyFreq > 0)   { score += 5;  warnings.push("훈련 빈도 부족 — 최근 주 평균 "+Math.round(weeklyFreq)+"회, 꾸준한 훈련을 위해 주 3회 이상 권장"); }

      // ④ 훈련 강도 평가
      maxScore += 25;
      if (!isCyclingTarget) {
        // 러닝: 페이스 비교
        var targetPace = 0;
        if (profile.vdot && parseFloat(profile.vdot)>0 && raceKm>0)
          targetPace = vdotToPaceMinKm(parseFloat(profile.vdot), raceKm);
        else if (profile.ltPaceMinKm && parseFloat(profile.ltPaceMinKm)>0)
          targetPace = parseFloat(profile.ltPaceMinKm) * (raceKm<=10?1.06:raceKm<=21.1?1.12:1.18);
        if (targetPace > 0 && recentAvgPace > 0) {
          var paceGap = (recentAvgPace - targetPace) / targetPace * 100;
          if (paceGap < 10)      { score += 25; goods.push("훈련 페이스 적절 — 목표와 "+paceGap.toFixed(0)+"% 차이"); }
          else if (paceGap < 20) { score += 15; details.push("훈련 페이스 목표보다 "+paceGap.toFixed(0)+"% 느림 (정상 범위)"); }
          else if (paceGap < 35) { score += 8;  warnings.push("훈련 평균("+formatPace(recentAvgPace)+") 목표("+formatPace(targetPace)+")보다 "+paceGap.toFixed(0)+"% 느림"); }
          else                    {              warnings.push("훈련 페이스와 목표 차이 큼 — 인터벌/템포런 추가 권장"); }
        } else { score += 15; details.push("LT 또는 VDOT 입력 시 페이스 평가 가능"); }
      } else {
        // 사이클: 지속 고강도 시간 (FTP 85% 이상이 2분 이상 이어진 구간) → 없으면 평균 IF
        if (profile.ftp && parseFloat(profile.ftp)>0) {
          var ftpR = parseFloat(profile.ftp);
          var pwrActsR = fitnessActs.filter(function(a){return a.avgPower&&a.avgPower>0;});
          var binActsR = fitnessActs.filter(function(a){return a.powerBins && a.powerBins.length;});
          if (binActsR.length >= 2) {
            var weeksR = fitnessActs === ctl42 ? 6 : fitnessActs === ctl70 ? 10 : Math.max(1, (function(){
              var ts = fitnessActs.map(function(a){return new Date(a.activityDate||a.uploadedAt).getTime();});
              return (now - Math.min.apply(null, ts)) / DAY / 7;
            })());
            var ssTotal = binActsR.reduce(function(sum, a){ return sum + sustainedMinutes(a.powerBins, ftpR, 0.85, 2); }, 0);
            var ssWeek = Math.round(ssTotal / weeksR);
            var ssRides = binActsR.filter(function(a){ return sustainedMinutes(a.powerBins, ftpR, 0.85, 2) >= 10; }).length;
            var ssLabel = "FTP 85%↑ 2분 이상 지속 — 주당 " + ssWeek + "분 (최근 " + Math.round(weeksR) + "주, 10분↑ 라이딩 " + ssRides + "회)";
            if (ssWeek >= 40)      { score += 25; goods.push("훈련 강도 적절 — " + ssLabel); }
            else if (ssWeek >= 20) { score += 15; details.push("훈련 강도 보통 — " + ssLabel + ", 주당 40분 이상이면 충분"); }
            else                   { score += 5;  warnings.push("고강도 부족 — " + ssLabel + ". 오르막에서 8~15분 × 2~3회 또는 5분 블록 여러 번으로 누적해도 돼요"); }
            if (binActsR.length < pwrActsR.length) details.push("파워 상세 있는 라이딩 " + binActsR.length + "/" + pwrActsR.length + "개 기준 — 나머지는 기간 SYNC 시 자동 보완");
          } else if (pwrActsR.length >= 2) {
            var avgPwrR = pwrActsR.reduce(function(a,b){return a+b.avgPower;},0)/pwrActsR.length;
            var ifR = avgPwrR/parseFloat(profile.ftp);
            if (ifR >= 0.65)      { score += 25; goods.push("훈련 강도 적절 — 평균 IF "+ifR.toFixed(2)); }
            else if (ifR >= 0.55) { score += 15; details.push("훈련 강도 보통 — 평균 IF "+ifR.toFixed(2)); }
            else                   { score += 5;  warnings.push("훈련 강도 낮음 — Sweet Spot(FTP×88~93%) 훈련 추가 권장"); }
          } else { score += 15; details.push("FIT 파일 업로드 시 파워 기반 강도 평가 가능"); }
        } else { score += 15; details.push("FTP 입력 시 훈련 강도 평가 가능"); }
      }

      var pct = maxScore > 0 ? Math.round(score/maxScore*100) : 0;
      var level = pct >= 75 ? "충분" : pct >= 50 ? "보통" : pct >= 25 ? "부족" : "매우 부족";
      var color = pct >= 75 ? "#00e5a0" : pct >= 50 ? "#ffb830" : "#ff6b35";
      return {score:pct, level:level, color:color, goods:goods, details:details, warnings:warnings};
    })();

    // ══════════════════════════════════════════════════════════════════
    // ① 내구성 지수 (Durability Index)
    // 롱라이드/롱런 훈련 이력 기반으로 후반 감속 계수 계산
    // 근거: 장거리 훈련이 많을수록 피로 저항성이 높아짐 (Hamilton et al. 2024)
    // ──────────────────────────────────────────────────────────────────
    var durabilityIndex = (function(){
      var longThreshDur = raceKm * 0.60;
      var longActs2 = fitnessActsForReadiness.filter(function(a){return a.distanceKm >= longThreshDur;});
      var totalLongKm = longActs2.reduce(function(a,b){return a+b.distanceKm;},0);

      // 크로스 활동은 가중치 적용됐으므로 실질 횟수로 환산
      var pureCount = longActs2.filter(function(a){return !a._isCrossWeighted;}).length;
      var crossCount2 = longActs2.filter(function(a){return a._isCrossWeighted;}).length;
      // 크로스 2개 = 순수 1개 수준으로 환산
      var effectiveCount = pureCount + Math.floor(crossCount2 / 2);

      // 내구성 점수: 0~1
      // 0 = 장거리 훈련 없음 (후반 큰 감속 예상)
      // 1 = 충분한 장거리 훈련 (후반 감속 최소)
      var score = 0;
      if (effectiveCount >= 3) score = 1.0;
      else if (effectiveCount === 2) score = 0.75;
      else if (effectiveCount === 1) score = 0.50;
      else if (fitnessActsForReadiness.filter(function(a){return a.distanceKm>=raceKm*0.4;}).length >= 2) score = 0.30;
      else score = 0.10;

      // 후반 페이스 감속 예상 비율 (0% ~ 15%)
      // 내구성 낮을수록 후반 더 느려짐
      var lateDecayPct = (1 - score) * 0.12; // 최대 12% 감속

      return {
        score: score,
        longActsCount: pureCount,
        crossLongCount: crossCount2,
        totalLongKm: +totalLongKm.toFixed(0),
        lateDecayPct: lateDecayPct,
        label: score >= 0.75 ? "양호" : score >= 0.50 ? "보통" : "부족",
        color: score >= 0.75 ? "#00e5a0" : score >= 0.50 ? "#ffb830" : "#ff6b35",
      };
    })();

    // ══════════════════════════════════════════════════════════════════
    // ② 훈련 강도 분배 분석 (TID - Training Intensity Distribution)
    // 심박 데이터 기반 Z1/Z2/Z3 비율 계산
    // 근거: 피라미드형 TID가 아마추어 엔듀어런스에 최적 (Magalhães et al. 2024)
    // ──────────────────────────────────────────────────────────────────
    var tidAnalysis = (function(){
      var lthrN = profile.ltHR ? parseFloat(profile.ltHR) : 0;
      var maxHRN = profile.maxHR ? parseFloat(profile.maxHR) : (lthrN>0 ? lthrN/0.87 : 0);
      if (!lthrN && !maxHRN) return null;

      var hrRef = maxHRN || lthrN/0.87;
      var z1Count=0, z2Count=0, z3Count=0, total=0;

      fitnessActs.forEach(function(a){
        if (!a.avgHR) return;
        total++;
        var ratio = a.avgHR / hrRef;
        if (ratio < 0.75) z1Count++;
        else if (ratio < 0.87) z2Count++;
        else z3Count++;
      });

      if (total === 0) return null;

      var z1Pct = Math.round(z1Count/total*100);
      var z2Pct = Math.round(z2Count/total*100);
      var z3Pct = Math.round(z3Count/total*100);

      // 피라미드형 이상: Z1 75~80% / Z2 15~20% / Z3 5~10%
      // 양극화형: Z1 75~80% / Z2 5% / Z3 15~20%
      var isPyramid = z1Pct >= 60 && z3Pct <= 20;
      var isZ2Heavy = z2Pct > 40; // 역치 과다 (과훈련 위험)
      var isZ3Heavy = z3Pct > 30; // 고강도 과다

      var feedback = "";
      if (isZ2Heavy) feedback = "역치 구간(Z2) 과다 — 회복 훈련 비율 늘리기 권장";
      else if (isZ3Heavy) feedback = "고강도(Z3) 과다 — Z1 유산소 기반 강화 필요";
      else if (z1Pct >= 60) feedback = "강도 분배 양호 — 피라미드형 유지";
      else feedback = "Z1 유산소 훈련 비율 증가 권장 (현재 "+z1Pct+"%)";

      return {z1Pct:z1Pct, z2Pct:z2Pct, z3Pct:z3Pct,
              total:total, isPyramid:isPyramid,
              feedback:feedback,
              color: isPyramid ? "#00e5a0" : (isZ2Heavy||isZ3Heavy) ? "#ff6b35" : "#ffb830"};
    })();

    // ══════════════════════════════════════════════════════════════════
    // ③ 심박 기반 회복 지표 개선
    // 같은 거리라도 심박이 높으면 더 피로한 것 반영
    // 현재 condFactor에 심박 강도 가중 추가
    // ──────────────────────────────────────────────────────────────────
    // (condFactor는 이미 crossTRIMP에서 심박 강도 반영하고 있음)
    // 추가: 최근 7일 훈련 강도 심박 평균으로 추가 보정
    var hrCondAdj = 1.0;
    if (profile.ltHR && parseFloat(profile.ltHR) > 0 && atl7.length > 0) {
      var lthrCond = parseFloat(profile.ltHR);
      var recentHRActs = atl7.filter(function(a){return a.avgHR && a.avgHR > 0;});
      if (recentHRActs.length > 0) {
        var avgRecentHR = recentHRActs.reduce(function(a,b){return a+b.avgHR;},0)/recentHRActs.length;
        var hrIntensity = avgRecentHR / lthrCond;
        // 최근 7일 평균 심박이 LTHR보다 높으면 추가 피로 반영
        if (hrIntensity > 1.05) hrCondAdj = 1.02;      // LTHR 5% 초과
        else if (hrIntensity > 0.95) hrCondAdj = 1.01; // LTHR 근처
        else if (hrIntensity < 0.75) hrCondAdj = 0.99; // 회복 훈련 위주
      }
    }
    var condFactorFinal = Math.min(1.06, condFactor * hrCondAdj);

    // ④ 회복 데이터 (Garmin HRV · 안정시 심박 via Intervals.icu)
    var wellnessStatus = computeWellnessStatus(wellness, today);
    if (wellnessStatus) {
      condFactorFinal = Math.min(1.06, condFactorFinal * wellnessStatus.condAdj);
      if (trainingReadiness) {
        trainingReadiness.goods = trainingReadiness.goods.concat(wellnessStatus.goods);
        trainingReadiness.warnings = trainingReadiness.warnings.concat(wellnessStatus.warnings);
        trainingReadiness.details = trainingReadiness.details.concat(wellnessStatus.details);
      }
    }

    // ══════════════════════════════════════════════════════════════════
    // ④ 성별/나이 보정 계수
    // 근거: 동일 LT/VDOT이라도 나이·성별에 따라 레이스 퍼포먼스 다름
    // 나이: 35세 이후 10년마다 VO2max ~10% 감소 (Joyner 2026)
    // 성별: 여성은 지방 산화 비율이 높아 장거리 상대적 유리
    // ──────────────────────────────────────────────────────────────────
    var ageGenderAdj = (function(){
      var age = profile.age ? parseFloat(profile.age) : 0;
      var gender = profile.gender || "male";
      var adj = 1.0;
      var notes = [];

      if (age >= 35) {
        // 35세 이후 10년당 약 1% 페이스 패널티 (보수적 추정)
        var agePenalty = Math.min(0.05, (age - 35) / 10 * 0.01);
        adj += agePenalty;
        if (agePenalty > 0.01) notes.push(age+"세 나이 보정 +"+Math.round(agePenalty*100)+"%");
      }

      if (gender === "female") {
        // 여성: 장거리(21km+)에서 지방 산화 비율 높아 상대적으로 유리
        // 단거리는 중립
        if (raceKm >= 21.1) {
          adj -= 0.005; // 0.5% 페이스 이점
          notes.push("여성 장거리 지방산화 보정");
        }
      }

      return {adj: adj, notes: notes};
    })();

    // 사이클: 훈련 IF 기반 파워존 조정
    var cyclingRows = null;
    if ((sport==="cycling"||sport==="mtb") && profile.ftp && courseData) {
      var effectiveEleGain = manualEleGain && parseFloat(manualEleGain) > 0 ? parseFloat(manualEleGain) : courseData.elevationGain;
      var effectiveCourseData = Object.assign({}, courseData, {elevationGain: effectiveEleGain});

      var trainingIF = null, trainingIFLabel = "";
      var ftpN = parseFloat(profile.ftp);

      // ① 파워 데이터 있으면 실측 IF 직접 계산 (가장 정확)
      var pwrActs = fitnessActs.filter(function(a){return a.avgPower&&a.durationMin>=30;});
      if (pwrActs.length >= 2) {
        var longPwrActs = pwrActs.filter(function(a){return a.distanceKm>=raceKm*0.3;});
        var basePwrActs = longPwrActs.length >= 1 ? longPwrActs : pwrActs;
        var avgPwr = basePwrActs.reduce(function(a,b){return a+b.avgPower;},0)/basePwrActs.length;
        trainingIF = +(avgPwr/ftpN).toFixed(2);
        trainingIFLabel = (longPwrActs.length>=1?"장거리":"평균")+" 실측 IF "+trainingIF+" ("+fitnessWindowLabel+") · 파워계";
      }

      // ② 파워 없을 때: 훈련 볼륨과 컨디션 기반으로 기본 IF 범위 조정
      // - 장거리(60km+) 훈련이 있으면 지구력 있다고 판단 → IF 상향
      // - 주간 볼륨이 충분하면 → IF 상향, 부족하면 → IF 하향
      // - condFactor 반영 (피로/회복 상태)
      var baseIF_default = 0.68; // 검증된 기본값 (저수령 IF 0.68 실측)
      if (!trainingIF && fitnessActs.length >= 1) {
        var longCycleActs = fitnessActs.filter(function(a){return a.distanceKm >= 60;});
        var totalCycleKm = fitnessActs.reduce(function(acc,a){return acc+a.distanceKm;},0);

        var ifAdj = 0;
        // 장거리 훈련 있으면 +0.03
        if (longCycleActs.length >= 1) ifAdj += 0.03;
        // 2개 이상이면 추가 +0.02
        if (longCycleActs.length >= 2) ifAdj += 0.02;
        // 주간 볼륨 충분하면 +0.02 (목표 거리의 50% 이상)
        if (weeklyVolKm >= raceKm * 0.5) ifAdj += 0.02;
        // 훈련이 부족하면 -0.03
        if (totalCycleKm < raceKm * 0.5) ifAdj -= 0.03;

        trainingIF = Math.min(Math.max(+(baseIF_default + ifAdj).toFixed(2), 0.50), 0.90);
        trainingIFLabel = "훈련 볼륨 기반 추정 IF "+trainingIF
          +" ("+fitnessWindowLabel+", 장거리 "+longCycleActs.length+"회, 주간 "+weeklyVolKm.toFixed(0)+"km)"
          +" · 파워계 추가 시 정밀도 향상";
      }

      // ③ condFactor를 IF에 반영
      // condFactor 0.97 = 컨디션 양호 → IF 소폭 상향
      // condFactor 1.04 = 피로 → IF 소폭 하향
      var ifCondAdj = 2 - condFactor; // 0.97→1.03, 1.04→0.96
      if (trainingIF) {
        var adjustedIF = Math.min(Math.max(+(trainingIF * ifCondAdj).toFixed(2), 0.40), 1.05);
        if (Math.abs(adjustedIF - trainingIF) >= 0.01) {
          trainingIF = adjustedIF;
          trainingIFLabel += condFactor < 1.0 ? " · 컨디션 양호 보정(+)" : (condFactor > 1.01 ? " · 피로 보정(-)" : "");
        }
      }

      var zones;
      if (trainingIF && trainingIF > 0.4 && trainingIF < 1.1) {
        var baseIF = Math.min(Math.max(trainingIF, 0.50), 0.92);
        zones = [
          {label:"회복 페이스 (IF "+(baseIF-0.08).toFixed(2)+")", pct:baseIF-0.08, desc:"가볍게 — 회복/입문"},
          {label:"훈련 기반 추천 (IF "+baseIF.toFixed(2)+")", pct:baseIF, desc:trainingIFLabel},
          {label:"목표 페이스 (IF "+(baseIF+0.06).toFixed(2)+")", pct:baseIF+0.06, desc:"훈련보다 약간 강하게"},
          {label:"고강도 (IF "+(baseIF+0.12).toFixed(2)+")", pct:baseIF+0.12, desc:"매우 힘듦 — 단거리 한정"},
        ];
      } else {
        // 훈련 데이터 없으면 기본 고정 존
        zones = null;
      }
      cyclingRows = calcCyclingTime(profile.ftp, effectiveCourseData.distanceKm, effectiveEleGain, profile.weight, effectiveCourseData.elevProfile, zones);
    }

    // 러닝
    var runningRows = null;
    if (sport==="trail_run"||sport==="road_run") {
      var lt = profile.ltPaceMinKm ? parseFloat(profile.ltPaceMinKm) : 0;
      var vdotScore = (sport==="road_run" && profile.vdot) ? parseFloat(profile.vdot) : 0;

      // 거리별 LT 배율
      var ltMults = (function(){
        if (raceKm <= 5)      return {hard:1.00, mid:1.03, easy:1.07};
        if (raceKm <= 10)     return {hard:1.03, mid:1.06, easy:1.10};
        if (raceKm <= 21.1)   return {hard:1.08, mid:1.12, easy:1.17};
        if (raceKm <= 42.195) return {hard:1.14, mid:1.18, easy:1.24};
        if (raceKm <= 60)     return {hard:1.22, mid:1.28, easy:1.35};
        return                       {hard:1.30, mid:1.40, easy:1.55};
      })();

      // VDOT 기반 예측 페이스 (로드런 전용)
      var vdotPace = 0;
      if (vdotScore > 0 && sport === "road_run") {
        vdotPace = vdotToPaceMinKm(vdotScore, raceKm);
      }

      // 훈련 데이터 기반 페이스
      var dataPace = 0, dataLabel = "", dataConfidence = "";
      if (recentLongPace > 0) {
        dataPace = recentLongPace;
        dataLabel = "장거리 훈련 기반 ("+fitnessWindowLabel+")";
        dataConfidence = "신뢰도 높음";
      } else if (recentAvgPace > 0) {
        var trainAvgDist = maxActDist > 0 ? maxActDist : 10;
        var riegelFactor = Math.pow(raceKm / trainAvgDist, 0.06);
        dataPace = recentAvgPace * riegelFactor;
        dataLabel = "훈련 평균 기반 (거리 보정 ×"+riegelFactor.toFixed(2)+")";
        dataConfidence = "신뢰도 보통";
      }

      var elePerKm = 0;
      if (courseData) {
        elePerKm = courseData.gainPerKm;
      } else if (sport === "trail_run") {
        elePerKm = avgElePerKm;
      }

      var eleBoostPct = 0;
      if (elePerKm > 0) {
        if (sport === "trail_run" && courseData && courseData.elevProfile && courseData.elevProfile.length >= 2) {
          var ep = courseData.elevProfile;
          var totalFactor = 0, totalDist2 = 0;
          var segLen = courseData.distanceKm / (ep.length - 1);
          for (var ei = 1; ei < ep.length; ei++) {
            var g = (ep[ei] - ep[ei-1]) / (segLen * 1000);
            var s = Math.max(-0.30, Math.min(0.30, g));
            var cost = (155.4*Math.pow(s,5) - 30.4*Math.pow(s,4) - 43.3*Math.pow(s,3) + 46.3*Math.pow(s,2) + 19.5*s + 3.6) / 3.6;
            if (s < -0.10) cost = 1.05;
            else if (s < -0.05) cost = 1.0;
            else if (s < 0) cost = 1.0 + (cost - 1.0) * 0.30;
            totalFactor += cost * segLen;
            totalDist2 += segLen;
          }
          var avgFactor = totalDist2 > 0 ? totalFactor / totalDist2 : 1.0;
          eleBoostPct = avgFactor - 1.0;
        } else {
          eleBoostPct = (elePerKm / 100) * 0.06;
        }
      }

      // ── 교차검증 블렌딩 (로드런 전용) ──────────────────────────────
      // 입력된 데이터에 따라 신뢰도 가중치 동적 계산
      // VDOT: 가장 신뢰도 높음 (실제 레이스 기반)
      // LT: 높음 (가민 측정값)
      // 훈련 데이터: 중간 (간접 지표)
      var rows = [];
      if (sport === "road_run" && vdotPace > 0) {
        // VDOT은 레이스 실측 기반이라 condFactor 미적용
        var vdotPred = vdotPace * ageGenderAdj.adj;
        var ltPred   = lt > 0 ? lt * ltMults.mid * condFactorFinal * ageGenderAdj.adj : 0;
        var ltHard   = lt > 0 ? lt * ltMults.hard * condFactorFinal * ageGenderAdj.adj : 0;

        // dataPace 신뢰도: 훈련 거리가 목표 거리와 비슷할수록 높음
        // 10K 예측인데 훈련이 5km짜리만 있으면 신뢰도 낮춤
        var distSimilarity = maxActDist > 0 ? Math.min(1.0, maxActDist / raceKm) : 0;
        var dataPred = dataPace > 0 ? dataPace * condFactor : 0;

        // 가중치: 거리 유사도로 dataPace 가중치 조정
        var wVdot = 0.45;
        var wLt   = ltPred > 0 ? 0.35 : 0;
        var wData = dataPred > 0 ? 0.20 * distSimilarity : 0; // 거리 가깝을수록 가중치 증가
        var wSum  = wVdot + wLt + wData;
        // wData가 0이면 VDOT+LT만으로 정규화
        var blended = (vdotPred*wVdot + (ltPred||vdotPred)*wLt + (dataPred||vdotPred)*wData) / wSum;

        // 교차검증 편차 계산
        var preds = [vdotPred, ltPred, dataPred].filter(function(p){return p>0;});
        var predAvg = preds.reduce(function(a,b){return a+b;},0)/preds.length;
        var predStd = Math.sqrt(preds.reduce(function(a,p){return a+Math.pow(p-predAvg,2);},0)/preds.length);
        var cvPct = predAvg > 0 ? predStd/predAvg*100 : 0;

        var cvLabel = cvPct < 2 ? "✓ 지표 일치 — 신뢰도 높음"
          : cvPct < 5 ? "△ 지표 소폭 차이 — 신뢰도 보통"
          : "⚠ 지표 차이 있음 — 최근 레이스 기록 입력 권장";

        rows = [
          {src:"VDOT 예측 (Jack Daniels)", pace:vdotPred*(1+eleBoostPct), desc:"VDOT "+vdotScore.toFixed(1)+" 기반 — 레이스 실측 최적화", isRecommended:false},
          {src:"교차검증 통합 (추천)", pace:blended*(1+eleBoostPct), desc:"VDOT 40%+LT 35%+훈련 25% · "+cvLabel, isRecommended:true},
          ...(ltHard>0?[{src:"LT 도전 페이스", pace:ltHard*(1+eleBoostPct), desc:"LT×"+ltMults.hard.toFixed(2)+" · 최상의 날 기준", isRecommended:false}]:[]),
          ...(dataPred>0?[{src:"훈련 기반", pace:dataPred*(1+eleBoostPct), desc:dataLabel, isRecommended:false}]:[]),
        ];
      } else if (lt > 0 && dataPace > 0) {
        // VDOT 없음: LT + 훈련 블렌딩
        var ltPred2  = lt * ltMults.mid * condFactorFinal * ageGenderAdj.adj;
        var ltHard2  = lt * ltMults.hard * condFactorFinal * ageGenderAdj.adj;
        var dataPred2 = dataPace * condFactorFinal * ageGenderAdj.adj;
        var blend = recentLongPace > 0 ? 0.5 : 0.3;
        var blended2 = ltPred2*(1-blend) + dataPred2*blend;
        rows = [
          {src:"도전 페이스 (LT×"+ltMults.hard.toFixed(2)+")", pace:ltHard2*(1+eleBoostPct), desc:"LT 기반 최적 페이스", isRecommended:false},
          {src:"통합 예측 (추천)", pace:blended2*(1+eleBoostPct), desc:"LT+훈련 통합 · "+condLabel, isRecommended:true},
          {src:"훈련 기반", pace:dataPred2*(1+eleBoostPct), desc:dataLabel+" · "+dataConfidence, isRecommended:false},
        ];
      } else if (lt > 0) {
        rows = [
          {src:"도전 페이스 (LT×"+ltMults.hard.toFixed(2)+")", pace:lt*ltMults.hard*condFactorFinal*ageGenderAdj.adj*(1+eleBoostPct), desc:"충분히 훈련된 경우", isRecommended:false},
          {src:"현실적 예측 (LT×"+ltMults.mid.toFixed(2)+")", pace:lt*ltMults.mid*condFactorFinal*ageGenderAdj.adj*(1+eleBoostPct), desc:"일반적 레이스 기준", isRecommended:true},
          {src:"여유 페이스 (LT×"+ltMults.easy.toFixed(2)+")", pace:lt*ltMults.easy*condFactorFinal*ageGenderAdj.adj*(1+eleBoostPct), desc:"처음 도전 / 완주 목표", isRecommended:false},
        ];
      } else if (vdotPace > 0) {
        rows = [
          {src:"VDOT 예측", pace:vdotPace*condFactor*(1+eleBoostPct), desc:"VDOT "+vdotScore.toFixed(1)+" 기반", isRecommended:true},
        ];
      } else if (dataPace > 0) {
        rows = [
          {src:"낙관적", pace:dataPace*condFactor*(1+eleBoostPct)*0.95, desc:dataLabel+" · 컨디션 최상", isRecommended:false},
          {src:"현실적 (추천)", pace:dataPace*condFactor*(1+eleBoostPct), desc:dataLabel+" · "+condLabel, isRecommended:true},
          {src:"보수적", pace:dataPace*condFactor*(1+eleBoostPct)*1.08, desc:dataLabel+" · 여유 있게", isRecommended:false},
        ];
      }
      if (rows.length) {
        runningRows = rows.map(function(r) {
          var totalMin = r.pace * raceKm;
          var tH = Math.floor(totalMin/60), tM = Math.round(totalMin%60);
          if (tM===60){tH++;tM=0;}
          return {label:r.src, desc:r.desc, pace:formatPace(r.pace), time:tH+"h "+String(tM).padStart(2,"0")+"m", isRecommended:r.isRecommended, paceMinKm:+r.pace.toFixed(3), totalMin:+totalMin.toFixed(1)};
        });
      }
    }

    var isCyclingSport = (sport==="cycling"||sport==="mtb");

    // 사이클: 피트니스 창(6~10주) 기반 평균 파워/속도
    var recentAvgPower = 0, recentAvgSpeed = 0;
    if (isCyclingSport) {
      var pwrActsF = fitnessActs.filter(function(a){return a.avgPower && a.avgPower > 0;});
      if (pwrActsF.length) recentAvgPower = Math.round(pwrActsF.reduce(function(a,b){return a+b.avgPower;},0)/pwrActsF.length);
      var spdActsF = fitnessActs.filter(function(a){return a.avgPaceMinKm > 0;});
      if (spdActsF.length) {
        var avgPaceVal = spdActsF.reduce(function(a,b){return a+b.avgPaceMinKm;},0)/spdActsF.length;
        recentAvgSpeed = avgPaceVal > 0 ? +(60/avgPaceVal).toFixed(1) : 0;
      }
    }

    var trainingSummary = relevantActs.length ? {
      count: fitnessActs.length,
      totalKm: totalVolKm.toFixed(0),
      weeklyKm: weeklyVolKm.toFixed(0),
      wk7km: wk1Km.toFixed(0),
      wk4avg: (wk2to4Km/3).toFixed(0),
      maxDist: maxActDist.toFixed(1),
      fitnessWindow: fitnessWindowLabel,
      condLabel: condLabel,
      condFactorFinal: condFactorFinal,
      isCycling: isCyclingSport,
      avgPace: (!isCyclingSport&&recentAvgPace>0) ? formatPace(recentAvgPace) : null,
      longPace: (!isCyclingSport&&recentLongPace>0) ? formatPace(recentLongPace) : null,
      avgPower: isCyclingSport&&recentAvgPower>0 ? recentAvgPower+"W" : null,
      avgSpeed: isCyclingSport&&recentAvgSpeed>0 ? recentAvgSpeed+"km/h" : null,
      crossCount: cross42.length,
      crossKmEquiv: crossContribPct > 5 ? crossContribPct+"%" : null,
      crossWeight: crossContribPct,
      durability: durabilityIndex,
      tid: tidAnalysis,
      ageGenderNotes: ageGenderAdj.notes,
    } : null;

    return {
      raceKm:raceKm, hasCourse:!!courseData,
      courseData:courseData?Object.assign({},courseData):null,
      effectiveEleGain:courseData&&manualEleGain&&parseFloat(manualEleGain)>0?parseFloat(manualEleGain):(courseData?courseData.elevationGain:null),
      hasProfile:hasProfile, noActivity:noActivity,
      cyclingRows:cyclingRows, runningRows:runningRows,
      trainingSummary:trainingSummary, sport:sport, trainingReadiness:trainingReadiness, wellnessStatus:wellnessStatus,
    };
}
