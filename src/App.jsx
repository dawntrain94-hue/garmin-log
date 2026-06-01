import { useState, useEffect, useRef } from "react";

// ── 유틸 ──────────────────────────────────────────────────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
  var R = 6371000, dLat = (lat2-lat1)*Math.PI/180, dLon = (lon2-lon1)*Math.PI/180;
  var a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R*2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
function smoothElevation(eles) {
  if (!eles.length) return eles;
  var w = eles.length > 5000 ? 5 : 3, half = Math.floor(w/2);
  return eles.map(function(_, i) {
    var s = Math.max(0,i-half), e = Math.min(eles.length-1,i+half), sum = 0;
    for (var j = s; j <= e; j++) sum += eles[j];
    return sum/(e-s+1);
  });
}
function calcElevGain(eles, threshold) {
  var range = Math.max.apply(null,eles) - Math.min.apply(null,eles);
  var t = threshold != null ? threshold : (range < 50 ? 1.5 : range < 200 ? 3.0 : 7.5);
  var gain = 0, loss = 0, base = eles[0];
  for (var i = 1; i < eles.length; i++) {
    var diff = eles[i] - base;
    if (diff > t) { gain += diff; base = eles[i]; }
    else if (diff < -t) { loss += Math.abs(diff); base = eles[i]; }
  }
  return { gain: Math.round(gain), loss: Math.round(loss) };
}

function parseActivityGPX(text) {
  var parser = new DOMParser();
  var doc = parser.parseFromString(text, "text/xml");
  var points = Array.from(doc.querySelectorAll("trkpt"));
  if (!points.length) return null;
  var totalDist = 0, hrs = [], powers = [], rawEles = [];
  var prevLat, prevLon, prevTime;
  var windowDist = 0, windowTime = 0, paces = [];
  points.forEach(function(pt, i) {
    var lat = parseFloat(pt.getAttribute("lat"));
    var lon = parseFloat(pt.getAttribute("lon"));
    var ele = parseFloat(pt.querySelector("ele") ? pt.querySelector("ele").textContent : 0);
    var timeStr = pt.querySelector("time") ? pt.querySelector("time").textContent : null;
    var hrEl = pt.querySelector("hr") || pt.querySelector("heartrate") || pt.querySelector("Value");
    var pwrEl = pt.querySelector("power") || pt.querySelector("watts");
    rawEles.push(ele);
    if (hrEl) { var h = parseInt(hrEl.textContent); if (h > 40 && h < 220) hrs.push(h); }
    if (pwrEl) { var pw = parseInt(pwrEl.textContent); if (pw > 0 && pw < 2000) powers.push(pw); }
    if (i > 0 && prevLat != null) {
      var d = haversine(prevLat, prevLon, lat, lon);
      totalDist += d;
      if (prevTime && timeStr) {
        var dt = (new Date(timeStr) - new Date(prevTime)) / 1000;
        var spd = dt > 0 ? d/dt : 0;
        if (dt > 0 && dt < 60 && spd >= 0.3) {
          windowDist += d; windowTime += dt;
          if (windowTime >= 10 && windowDist > 2) {
            var p = (windowTime/windowDist)*1000/60;
            if (p >= 1 && p <= 30) paces.push(p);
            windowDist = 0; windowTime = 0;
          }
        }
      }
    }
    prevLat = lat; prevLon = lon; prevTime = timeStr;
  });
  var times = Array.from(doc.querySelectorAll("time"));
  var duration = times.length >= 2 ? (new Date(times[times.length-1].textContent) - new Date(times[0].textContent)) / 1000 : 0;
  var avgPaceMinKm = 0;
  if (paces.length > 0) {
    var sorted = paces.slice().sort(function(a,b){return a-b;});
    var median = sorted[Math.floor(sorted.length/2)];
    var filtered = paces.filter(function(p){return p >= median*0.5 && p <= median*1.5;});
    avgPaceMinKm = +((filtered.length>0?filtered:paces).reduce(function(a,b){return a+b;},0)/(filtered.length||paces.length)).toFixed(2);
  } else if (totalDist > 0 && duration > 0) {
    avgPaceMinKm = +((duration/60)/(totalDist/1000)).toFixed(2);
  }
  var smoothed = smoothElevation(rawEles);
  var eg = calcElevGain(smoothed);
  var step = Math.max(1, Math.floor(smoothed.length/80));
  var elevProfile = smoothed.filter(function(_, i){return i%step===0;});
  var nameEl = doc.querySelector("name");
  var typeEl = doc.querySelector("type");
  var activityDate = "";
  if (times.length > 0) {
    try { var d = new Date(times[0].textContent); activityDate = d.toISOString().slice(0,10); } catch(e) {}
  }
  return {
    name: nameEl ? nameEl.textContent : "활동",
    gpxType: typeEl ? typeEl.textContent : "",
    activityDate: activityDate,
    distanceKm: +((totalDist/1000).toFixed(2)),
    elevationGain: eg.gain, elevationLoss: eg.loss,
    durationMin: Math.round(duration/60),
    avgPaceMinKm: avgPaceMinKm,
    avgHR: hrs.length ? Math.round(hrs.reduce(function(a,b){return a+b;},0)/hrs.length) : null,
    maxHR: hrs.length ? Math.max.apply(null,hrs) : null,
    avgPower: powers.length ? Math.round(powers.reduce(function(a,b){return a+b;},0)/powers.length) : null,
    points: points.length, elevProfile: elevProfile,
  };
}

// ── FIT 바이너리 파서 ──────────────────────────────────────────────────────────
function parseActivityFIT(buffer) {
  var bytes = new Uint8Array(buffer);
  var view = new DataView(buffer);

  // FIT 헤더 검증
  if (bytes.length < 14) return null;
  var headerSize = bytes[0];
  var protocol = bytes[1];
  // FIT 시그니처 확인 (.FIT)
  var sig = String.fromCharCode(bytes[8],bytes[9],bytes[10],bytes[11]);
  if (sig !== '.FIT') return null;

  // 메시지 정의/데이터 파싱
  var localMsgDefs = {};
  var pos = headerSize;
  var dataEnd = headerSize + view.getUint32(4, true);
  if (dataEnd > bytes.length) dataEnd = bytes.length - 2;

  // 수집할 데이터
  var lats=[], lons=[], alts=[], timestamps=[], hrs=[], powers=[], speeds=[];
  var totalDist = 0;
  var sessionAvgPower = null, sessionAvgHR = null, sessionAvgSpeed = null;
  var sessionNP = null, sessionTSS = null;
  var activityTimestamp = null;

  // FIT 메시지 번호
  var MSG_RECORD = 20;
  var MSG_SESSION = 18;
  var MSG_ACTIVITY = 34;

  // FIT 타입
  var BASE_TYPES = {
    0x00: {size:1,signed:false}, 0x01: {size:1,signed:true},
    0x02: {size:1,signed:false}, 0x83: {size:2,signed:false},
    0x84: {size:2,signed:true},  0x85: {size:4,signed:false},
    0x86: {size:4,signed:true},  0x07: {size:1,signed:false},
    0x88: {size:4,signed:false,'float':true}, 0x89: {size:8,signed:false,'float':true},
    0x0A: {size:1,signed:false}, 0x8B: {size:2,signed:false},
    0x8C: {size:4,signed:false}, 0x0D: {size:1,signed:false},
    0x0E: {size:4,signed:false}, 0x0F: {size:8,signed:false},
    0xFF: {size:1,signed:false}, // invalid
  };

  function readVal(bt, pos) {
    var info = BASE_TYPES[bt] || {size:1,signed:false};
    var sz = info.size;
    if (pos + sz > bytes.length) return {val:null, size:sz};
    var val = null;
    try {
      if (bt === 0x88) val = view.getFloat32(pos, true);
      else if (bt === 0x89) val = view.getFloat64(pos, true);
      else if (sz === 1) val = info.signed ? view.getInt8(pos) : view.getUint8(pos);
      else if (sz === 2) val = info.signed ? view.getInt16(pos,true) : view.getUint16(pos,true);
      else if (sz === 4) val = info.signed ? view.getInt32(pos,true) : view.getUint32(pos,true);
      else if (sz === 8) { val = view.getUint32(pos,true); } // lo 32비트만
    } catch(e) { val = null; }
    return {val:val, size:sz};
  }

  try {
    while (pos < dataEnd) {
      var recHdr = bytes[pos]; pos++;
      var isDefn = (recHdr & 0x40) !== 0;
      var isCompressed = (recHdr & 0x80) !== 0;

      if (isCompressed) {
        // 압축 타임스탬프 레코드 — 단순 건너뜀
        var localNum = (recHdr >> 5) & 0x03;
        var def = localMsgDefs[localNum];
        if (def) {
          for (var fi=0; fi<def.fields.length; fi++) pos += def.fields[fi].size;
        } else { pos++; }
        continue;
      }

      var localMsgNum = recHdr & 0x0F;

      if (isDefn) {
        pos++; // reserved
        var arch = bytes[pos++]; // 0=little, 1=big
        var globalMsgNum = arch === 0 ? view.getUint16(pos,true) : view.getUint16(pos,false);
        pos += 2;
        var numFields = bytes[pos++];
        var fields = [];
        for (var fi=0; fi<numFields; fi++) {
          var fNum = bytes[pos++];
          var fSz  = bytes[pos++];
          var fBt  = bytes[pos++];
          fields.push({num:fNum, size:fSz, baseType:fBt, arch:arch});
        }
        // 개발자 필드 (있으면 건너뜀)
        if (recHdr & 0x20) {
          var nDev = bytes[pos++];
          for (var di=0; di<nDev; di++) pos += 3;
        }
        localMsgDefs[localMsgNum] = {globalMsgNum:globalMsgNum, fields:fields, arch:arch};

      } else {
        // 데이터 레코드
        var def2 = localMsgDefs[localMsgNum];
        if (!def2) { pos++; continue; }

        var recData = {};
        for (var fi=0; fi<def2.fields.length; fi++) {
          var f = def2.fields[fi];
          var r = readVal(f.baseType, pos);
          recData[f.num] = r.val;
          pos += f.size;
        }

        var gNum = def2.globalMsgNum;

        if (gNum === MSG_RECORD) {
          // record: lat=0, lon=1, alt=2, hr=3, power=7, speed=6, dist=5, ts=253
          if (recData[0] != null && recData[0] !== 0x7FFFFFFF)
            lats.push(recData[0] * (180/Math.pow(2,31)));
          if (recData[1] != null && recData[1] !== 0x7FFFFFFF)
            lons.push(recData[1] * (180/Math.pow(2,31)));
          if (recData[2] != null) alts.push(recData[2]/5 - 500);
          if (recData[3] != null && recData[3] > 0 && recData[3] < 250) hrs.push(recData[3]);
          if (recData[7] != null && recData[7] > 0 && recData[7] < 2500) powers.push(recData[7]);
          if (recData[6] != null && recData[6] > 0) speeds.push(recData[6]/1000);
          if (recData[253] != null) timestamps.push(recData[253]);
        }

        if (gNum === MSG_SESSION) {
          // session: avg_power=20, avg_hr=16, avg_speed=14, nec_power=34, tss=35, ts=253
          if (recData[20] != null && recData[20] > 0 && recData[20] < 2000) sessionAvgPower = recData[20];
          if (recData[16] != null && recData[16] > 0) sessionAvgHR = recData[16];
          if (recData[14] != null && recData[14] > 0) sessionAvgSpeed = recData[14]/1000;
          if (recData[34] != null && recData[34] > 0) sessionNP = recData[34]; // normalized power
          if (recData[35] != null) sessionTSS = recData[35]/10;
          if (recData[253] != null && !activityTimestamp) activityTimestamp = recData[253];
        }

        if (gNum === MSG_ACTIVITY) {
          if (recData[253] != null) activityTimestamp = recData[253];
        }
      }
    }
  } catch(e) {
    // 파싱 중 오류 시 그냥 현재까지 수집한 데이터 사용
  }

  if (lats.length < 2 && powers.length < 10 && hrs.length < 10) return null;

  // 거리 계산
  var totalDistM = 0;
  for (var i=1; i<lats.length; i++) {
    totalDistM += haversine(lats[i-1],lons[i-1],lats[i],lons[i]);
  }

  // 시간 계산
  var durationSec = 0;
  if (timestamps.length >= 2) {
    durationSec = timestamps[timestamps.length-1] - timestamps[0];
  }

  // 고도 상승
  var smoothedAlts = alts.length > 0 ? smoothElevation(alts) : [];
  var eg = smoothedAlts.length > 0 ? calcElevGain(smoothedAlts) : {gain:0,loss:0};

  // elevProfile
  var step = Math.max(1, Math.floor(smoothedAlts.length/80));
  var elevProfile = smoothedAlts.filter(function(_,i){return i%step===0;});

  // 평균 속도/페이스
  var avgSpeedMs = sessionAvgSpeed || (totalDistM > 0 && durationSec > 0 ? totalDistM/durationSec : 0);
  var avgPaceMinKm = avgSpeedMs > 0 ? (1000/avgSpeedMs/60) : 0;

  // 심박
  var avgHR = sessionAvgHR;
  if (!avgHR && hrs.length > 0) avgHR = Math.round(hrs.reduce(function(a,b){return a+b;},0)/hrs.length);

  // 파워 (세션 값 우선, 없으면 레코드 평균)
  var avgPower = sessionAvgPower;
  if (!avgPower && powers.length > 0) avgPower = Math.round(powers.reduce(function(a,b){return a+b;},0)/powers.length);

  // 활동 날짜 (FIT timestamp는 2000-01-01 기준 초)
  var activityDate = "";
  if (activityTimestamp) {
    try {
      var fitEpoch = 631065600; // 2000-01-01 UTC Unix epoch
      var unixTs = (activityTimestamp + fitEpoch) * 1000;
      activityDate = new Date(unixTs).toISOString().slice(0,10);
    } catch(e) {}
  }

  return {
    name: "활동",
    gpxType: "cycling",
    activityDate: activityDate,
    distanceKm: +((totalDistM/1000).toFixed(2)),
    elevationGain: eg.gain, elevationLoss: eg.loss,
    durationMin: Math.round(durationSec/60),
    avgPaceMinKm: +avgPaceMinKm.toFixed(2),
    avgHR: avgHR || null,
    maxHR: hrs.length ? Math.max.apply(null,hrs) : null,
    avgPower: avgPower || null,
    normalizedPower: sessionNP || null,
    tss: sessionTSS || null,
    points: lats.length,
    elevProfile: elevProfile,
    hasPower: powers.length > 50,
  };
}

function parseCourseGPX(text) {
  var parser = new DOMParser();
  var doc = parser.parseFromString(text, "text/xml");
  var points = Array.from(doc.querySelectorAll("trkpt"));
  if (!points.length) points = Array.from(doc.querySelectorAll("rtept"));
  if (!points.length) points = Array.from(doc.querySelectorAll("wpt"));
  if (!points.length) return null;
  var totalDist = 0, rawEles = [], prevLat, prevLon;
  points.forEach(function(pt, i) {
    var lat = parseFloat(pt.getAttribute("lat")), lon = parseFloat(pt.getAttribute("lon"));
    var ele = parseFloat(pt.querySelector("ele") ? pt.querySelector("ele").textContent : 0);
    rawEles.push(ele);
    if (i > 0) totalDist += haversine(prevLat, prevLon, lat, lon);
    prevLat = lat; prevLon = lon;
  });
  var smoothed = smoothElevation(rawEles);
  var eg = calcElevGain(smoothed);
  var step = Math.max(1, Math.floor(smoothed.length/80));
  var elevProfile = smoothed.filter(function(_, i){return i%step===0;});
  var gainPerKm = totalDist > 0 ? (eg.gain/(totalDist/1000)) : 0;
  var techDifficulty = gainPerKm>=50?"매우 어려움 (산악)":gainPerKm>=30?"어려움 (고산악)":gainPerKm>=15?"중급 (언덕 많음)":gainPerKm>=7?"보통 (완만한 언덕)":"쉬움 (평탄)";
  var nameEl = doc.querySelector("name");
  return {
    name: nameEl ? nameEl.textContent : "코스",
    distanceKm: +((totalDist/1000).toFixed(2)),
    elevationGain: eg.gain, elevationLoss: eg.loss,
    minElevation: Math.round(Math.min.apply(null,smoothed)),
    maxElevation: Math.round(Math.max.apply(null,smoothed)),
    gainPerKm: Math.round(gainPerKm), techDifficulty: techDifficulty,
    points: points.length, elevProfile: elevProfile,
  };
}

function formatPace(p) {
  if (!p || p <= 0) return "—";
  var min = Math.floor(p), sec = Math.round((p-min)*60);
  return min+"'"+String(sec).padStart(2,"0")+'"';
}
function formatDuration(min) {
  if (!min) return "—";
  var h = Math.floor(min/60), m = min%60;
  return h > 0 ? h+"h "+m+"m" : m+"m";
}

// ── 사이클링 물리 시뮬레이션 ──────────────────────────────────────────────────
function calcCyclingTime(ftp, distKm, eleGain, weightKg, elevProfile, customZones) {
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

// ── 상수 ──────────────────────────────────────────────────────────────────────
var SPORT_LABELS = {
  trail_run:"🏔 트레일런", road_run:"🏃 로드런", cycling:"🚴 사이클/그란폰도", mtb:"🚵 MTB",
};
var PRESET_RACES = [
  {label:"직접 입력", value:"custom"},
  {label:"── 트레일런 ──", value:"", disabled:true},
  {label:"트레일 10K",  value:"trail_10",   km:10},
  {label:"트레일 21K",  value:"trail_21.1", km:21.1},
  {label:"트레일 30K",  value:"trail_30",   km:30},
  {label:"트레일 50K",  value:"trail_50",   km:50},
  {label:"트레일 100K", value:"trail_100",  km:100},
  {label:"트레일 100Mile", value:"trail_161", km:161},
  {label:"── 로드런 ──", value:"", disabled:true},
  {label:"로드 5K",      value:"road_5",     km:5},
  {label:"로드 10K",     value:"road_10",    km:10},
  {label:"하프마라톤",   value:"road_21.1",  km:21.1},
  {label:"풀마라톤",     value:"road_42.195",km:42.195},
  {label:"── 사이클 ──", value:"", disabled:true},
  {label:"100km",        value:"cycle_100",  km:100},
  {label:"그란폰도 160km", value:"cycle_160", km:160},
  {label:"200km 브레베", value:"cycle_200",  km:200},
];

// ── 고도 차트 ─────────────────────────────────────────────────────────────────
function ElevChart(props) {
  var data = props.data, color = props.color||"#00e5a0", height = props.height||52;
  if (!data || !data.length) return null;
  var min = Math.min.apply(null,data), max = Math.max.apply(null,data), range = max-min||1;
  var w = 400, h = height;
  var pts = data.map(function(e,i){
    return (i/(data.length-1))*w+","+(h-((e-min)/range)*(h-4)-2);
  }).join(" ");
  var uid = color.replace("#","");
  return (
    <svg viewBox={"0 0 "+w+" "+h} style={{width:"100%",height:h,display:"block"}} preserveAspectRatio="none">
      <defs>
        <linearGradient id={"g"+uid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <polygon points={"0,"+h+" "+pts+" "+w+","+h} fill={"url(#g"+uid+")"} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}

// ── 대회 결과 GPX 심층 분석 ──────────────────────────────────────────────────
function analyzeRaceResult(text, courseDistKm) {
  var parser = new DOMParser();
  var doc = parser.parseFromString(text, "text/xml");
  var points = Array.from(doc.querySelectorAll("trkpt"));
  if (!points.length) return null;
  var NS = 'http://www.topografix.com/GPX/1/1';

  var lats=[], lons=[], eles=[], times=[], hrs=[], powers=[];
  points.forEach(function(pt) {
    lats.push(parseFloat(pt.getAttribute("lat")));
    lons.push(parseFloat(pt.getAttribute("lon")));
    var ele = pt.querySelector("ele"); eles.push(ele?parseFloat(ele.textContent):0);
    var t = pt.querySelector("time"); times.push(t?t.textContent:null);
    var hr = pt.querySelector("hr")||pt.querySelector("heartrate");
    if (hr) { var h=parseInt(hr.textContent); if(h>40&&h<220) hrs.push(h); else hrs.push(null); } else hrs.push(null);
    var pw = pt.querySelector("power")||pt.querySelector("watts");
    if (pw) { var p=parseInt(pw.textContent); if(p>0&&p<2000) powers.push(p); else powers.push(null); } else powers.push(null);
  });

  // 총 거리 / 시간
  var totalDist = 0;
  var dists = [0];
  for (var i = 1; i < lats.length; i++) {
    var d = haversine(lats[i-1],lons[i-1],lats[i],lons[i]);
    totalDist += d; dists.push(totalDist);
  }
  var duration = 0;
  var t0 = times[0], tN = times[times.length-1];
  if (t0 && tN) { try { duration = (new Date(tN)-new Date(t0))/1000; } catch(e) {} }

  // 10등분 구간 분석
  var segments = [];
  // 거리 기반 동적 구간 수: 단거리<30km→10, 중거리<80km→15, 장거리→20
  var segCount = totalDist/1000 > 80 ? 20 : (totalDist/1000 > 30 ? 15 : 10);
  var segDistM = totalDist / segCount;
  var segIdx = 0, segDist = 0, segTime = 0, segHrs = [], segPwrs = [], segEles = [];
  var lastSegDist = 0;

  for (var i = 1; i < lats.length; i++) {
    var d = dists[i] - dists[i-1];
    var dt = 0;
    if (times[i] && times[i-1]) { try { dt = (new Date(times[i])-new Date(times[i-1]))/1000; } catch(e) {} }
    segDist += d; segTime += dt;
    if (hrs[i]) segHrs.push(hrs[i]);
    if (powers[i]) segPwrs.push(powers[i]);
    segEles.push(eles[i]);

    if (segDist >= segDistM || i === lats.length-1) {
      var pctDone = (dists[i]/totalDist*100);
      var avgHR = segHrs.length ? Math.round(segHrs.reduce(function(a,b){return a+b;},0)/segHrs.length) : null;
      var avgPwr = segPwrs.length ? Math.round(segPwrs.reduce(function(a,b){return a+b;},0)/segPwrs.length) : null;
      var paceMinKm = segDist > 0 && segTime > 0 ? (segTime/segDist*1000/60) : 0;
      var speedKmh = segDist > 0 && segTime > 0 ? (segDist/segTime*3.6) : 0;
      var eleGain = 0, eleBase = segEles[0];
      segEles.forEach(function(e){var diff=e-eleBase;if(diff>3){eleGain+=diff;eleBase=e;}else if(diff<-3){eleBase=e;}});
      segments.push({
        idx: segments.length+1,
        distKm: +(segDist/1000).toFixed(1),
        cumDistKm: +(dists[i]/1000).toFixed(1),
        paceMinKm: +paceMinKm.toFixed(2),
        speedKmh: +speedKmh.toFixed(1),
        avgHR: avgHR, avgPower: avgPwr,
        eleGain: Math.round(eleGain),
        pctDone: Math.round(pctDone),
      });
      segDist=0; segTime=0; segHrs=[]; segPwrs=[]; segEles=[];
    }
  }

  // 초/중/후반 3분할 분석 (전 구간 커버)
  var n3 = segments.length;
  var t1 = Math.max(1, Math.round(n3/3));
  var t2 = Math.max(t1+1, Math.round(n3*2/3));

  var earlySegs  = segments.slice(0, t1);
  var midSegs    = segments.slice(t1, t2);
  var lateSegs   = segments.slice(t2);

  function segAvgPace(arr) {
    var v = arr.filter(function(s){return s.paceMinKm>0;});
    return v.length ? v.reduce(function(a,b){return a+b.paceMinKm;},0)/v.length : 0;
  }
  function segAvgSpd(arr) {
    var v = arr.filter(function(s){return s.speedKmh>0;});
    return v.length ? v.reduce(function(a,b){return a+b.speedKmh;},0)/v.length : 0;
  }

  var avgPaceFirst = segAvgPace(earlySegs);
  var avgPaceMid   = segAvgPace(midSegs);
  var avgPaceLast  = segAvgPace(lateSegs);

  var avgSpdFirst = segAvgSpd(earlySegs);
  var avgSpdMid   = segAvgSpd(midSegs);
  var avgSpdLast  = segAvgSpd(lateSegs);

  // 저하 기준: 초반 대비 중반/후반 변화율
  var paceMidDegPct  = avgPaceFirst > 0 ? ((avgPaceMid -avgPaceFirst)/avgPaceFirst*100) : 0;
  var paceLastDegPct = avgPaceFirst > 0 ? ((avgPaceLast-avgPaceFirst)/avgPaceFirst*100) : 0;
  var paceDegradePct = paceLastDegPct; // 기존 호환

  var spdMidDegPct   = avgSpdFirst > 0 ? ((avgSpdFirst-avgSpdMid )/avgSpdFirst*100) : 0;
  var spdLastDegPct  = avgSpdFirst > 0 ? ((avgSpdFirst-avgSpdLast)/avgSpdFirst*100) : 0;
  var spdDegradePct  = spdLastDegPct; // 기존 호환

  // 파워 3분할
  var pwrSegs = segments.filter(function(s){return s.avgPower;});
  var avgPwrFirst = 0, avgPwrMid = 0, avgPwrLast = 0, pwrDegradePct = 0;
  if (pwrSegs.length >= 3) {
    var pt1 = Math.max(1,Math.round(pwrSegs.length/3));
    var pt2 = Math.max(pt1+1,Math.round(pwrSegs.length*2/3));
    avgPwrFirst = pwrSegs.slice(0,pt1).reduce(function(a,b){return a+b.avgPower;},0)/pt1;
    avgPwrMid   = pwrSegs.slice(pt1,pt2).reduce(function(a,b){return a+b.avgPower;},0)/Math.max(1,pt2-pt1);
    avgPwrLast  = pwrSegs.slice(pt2).reduce(function(a,b){return a+b.avgPower;},0)/Math.max(1,pwrSegs.length-pt2);
    pwrDegradePct = avgPwrFirst > 0 ? ((avgPwrFirst-avgPwrLast)/avgPwrFirst*100) : 0;
  }

  // 구간 거리 경계
  var earlyEndKm = earlySegs.length ? earlySegs[earlySegs.length-1].cumDistKm : 0;
  var midEndKm   = midSegs.length   ? midSegs[midSegs.length-1].cumDistKm     : earlyEndKm;
  var earlyDistKm = earlyEndKm;
  var lateStartKm = midEndKm;

  // 유효 hr, power 통계
  var validHrs = hrs.filter(function(h){return h;});
  var validPwrs = powers.filter(function(p){return p;});
  var avgHR = validHrs.length ? Math.round(validHrs.reduce(function(a,b){return a+b;},0)/validHrs.length) : null;
  var maxHR = validHrs.length ? Math.max.apply(null,validHrs) : null;
  var avgPwr = validPwrs.length ? Math.round(validPwrs.reduce(function(a,b){return a+b;},0)/validPwrs.length) : null;

  return {
    distKm: +(totalDist/1000).toFixed(2),
    durationMin: Math.round(duration/60),
    durationHM: Math.floor(duration/3600)+"h "+String(Math.round((duration%3600)/60)).padStart(2,"0")+"m",
    avgSpeedKmh: duration > 0 ? +((totalDist/1000)/(duration/3600)).toFixed(1) : 0,
    avgHR: avgHR, maxHR: maxHR, avgPower: avgPwr,
    segments: segments,
    paceDegradePct: +paceLastDegPct.toFixed(1),
    paceMidDegPct: +paceMidDegPct.toFixed(1),
    pwrDegradePct: +pwrDegradePct.toFixed(1),
    spdDegradePct: +spdLastDegPct.toFixed(1),
    spdMidDegPct: +spdMidDegPct.toFixed(1),
    avgSpdFirst: +avgSpdFirst.toFixed(1), avgSpdMid: +avgSpdMid.toFixed(1), avgSpdLast: +avgSpdLast.toFixed(1),
    avgPaceFirst: avgPaceFirst, avgPaceMid: avgPaceMid, avgPaceLast: avgPaceLast,
    avgPwrFirst: Math.round(avgPwrFirst), avgPwrMid: Math.round(avgPwrMid), avgPwrLast: Math.round(avgPwrLast),
    earlyDistKm: +earlyDistKm.toFixed(1),
    midEndKm: +midEndKm.toFixed(1),
    lateStartKm: +lateStartKm.toFixed(1),
    avgPwrFirst: Math.round(avgPwrFirst), avgPwrLast: Math.round(avgPwrLast),
    hasPower: validPwrs.length > 100,
    hasHR: validHrs.length > 100,
  };
}
var C = {
  bg:"#0a0c0f", surface:"#111418", surface2:"#0d1014",
  border:"#1e2530", accent:"#00e5a0", gold:"#ffb830",
  red:"#ff6b35", blue:"#4d9fff", text:"#e8edf5", muted:"#5a6478",
};
function cardStyle() { return {background:C.surface,border:"1px solid "+C.border,padding:"16px 18px"}; }
function inputStyle() { return {width:"100%",background:C.surface2,border:"1px solid "+C.border,color:C.text,padding:"9px 12px",fontFamily:"monospace",fontSize:13,outline:"none"}; }
function selectStyle() { return {width:"100%",background:C.surface2,border:"1px solid "+C.border,color:C.text,padding:"9px 12px",fontFamily:"monospace",fontSize:13,outline:"none",WebkitAppearance:"none"}; }
function labelStyle() { return {fontFamily:"monospace",fontSize:10,color:C.muted,letterSpacing:2,display:"block",marginBottom:6,textTransform:"uppercase"}; }
function secTitle(col) { return {fontFamily:"monospace",fontSize:10,color:col||C.accent,letterSpacing:3,marginBottom:10}; }
function tabBtn(active) {
  return {background:active?C.accent:"transparent",color:active?C.bg:C.muted,border:"none",padding:"8px 16px",cursor:"pointer",fontFamily:"monospace",fontSize:11,letterSpacing:1,fontWeight:active?700:400,transition:"all .15s"};
}

// ── 메인 앱 ───────────────────────────────────────────────────────────────────
export default function App() {
  var _s = useState([]); var activities = _s[0], setActivities = _s[1];
  var _v = useState("log"); var view = _v[0], setView = _v[1];
  var _si = useState(null); var selectedId = _si[0], setSelectedId = _si[1];
  var _ld = useState(false); var loading = _ld[0], setLoading = _ld[1];
  var _sr = useState(false); var storageReady = _sr[0], setStorageReady = _sr[1];
  var _an = useState(null); var analysis = _an[0], setAnalysis = _an[1];
  var _at = useState(null); var aiText = _at[0], setAiText = _at[1];
  var _to = useState(null); var toast = _to[0], setToast = _to[1];
  var _pr = useState({name:"",weight:"",age:"",gender:"male",ltPaceMinKm:"",ltHR:"",vo2maxRun:"",ftp:"",ftpPerKg:"",vo2maxCycle:"",notes:""});
  var profile = _pr[0], setProfile = _pr[1];
  var _ps = useState(false); var profileSaved = _ps[0], setProfileSaved = _ps[1];
  var _sp = useState("road_run"); var sport = _sp[0], setSport = _sp[1];
  var _lf = useState("all"); var logFilter = _lf[0], setLogFilter = _lf[1];
  var _ad = useState(false); var actDrag = _ad[0], setActDrag = _ad[1];
  var actRef = useRef();
  var _rp = useState("custom"); var racePreset = _rp[0], setRacePreset = _rp[1];
  var _rk = useState(""); var raceKmInput = _rk[0], setRaceKmInput = _rk[1];
  var _rn = useState(""); var raceNote = _rn[0], setRaceNote = _rn[1];
  var _cd = useState(null); var courseData = _cd[0], setCourseData = _cd[1];
  var _cf = useState(""); var courseFileName = _cf[0], setCourseFileName = _cf[1];
  var _me = useState(""); var manualEleGain = _me[0], setManualEleGain = _me[1];
  var _cdr = useState(false); var courseDrag = _cdr[0], setCourseDrag = _cdr[1];
  var courseRef = useRef();
  var _id = useState(false); var importDrag = _id[0], setImportDrag = _id[1];
  var _ip = useState(null); var importPreview = _ip[0], setImportPreview = _ip[1];
  var importRef = useRef();
  var _em = useState({}); var expandedMonths = _em[0], setExpandedMonths = _em[1];
  var _ex = useState(null); var exportText = _ex[0], setExportText = _ex[1];
  var _ec = useState(false); var exportCopied = _ec[0], setExportCopied = _ec[1];
  var _rr = useState(null); var raceResult = _rr[0], setRaceResult = _rr[1];
  var _rd = useState(false); var raceResultDrag = _rd[0], setRaceResultDrag = _rd[1];
  var raceResultRef = useRef();

  // ── storage
  var store = {
    get: async function(key) {
      try { var v = localStorage.getItem(key); if (v) return v; } catch(e) {}
      return null;
    },
    set: async function(key, value) {
      try {
        localStorage.setItem(key, value);
        return;
      } catch(e) {
        throw new Error("저장 실패 — 백업 탭에서 JSON으로 보관하세요");
      }
    },
  };

  useEffect(function() {
    (async function() {
      try {
        var av = await store.get("tlog_activities");
        if (av) { var pa = JSON.parse(av); if (Array.isArray(pa)) setActivities(pa); }
        var pv = await store.get("tlog_profile");
        if (pv) { var pp = JSON.parse(pv); if (pp && typeof pp === "object") setProfile(pp); }
      } catch(e) {}
      setStorageReady(true);
    })();
  }, []);

  function showToast(msg, type) { setToast({msg:msg,type:type||"ok"}); setTimeout(function(){setToast(null);},3000); }
  async function saveActivities(list) {
    try { await store.set("tlog_activities", JSON.stringify(list)); }
    catch(e) { showToast("⚠ 저장 실패 — 백업 탭에서 JSON 내보내기로 보관하세요","error"); }
  }
  async function saveProfile(p) {
    try { await store.set("tlog_profile", JSON.stringify(p)); setProfileSaved(true); setTimeout(function(){setProfileSaved(false);},2500); }
    catch(e) { showToast("저장 실패: "+(e.message||"오류"),"error"); }
  }

  // 자동 종목 분류
  function autoClassifySport(avgSpeedKmh, gainPerKm, nameTag, typeTag) {
    var type = (typeTag||"").toLowerCase();
    if (type) {
      if (type.indexOf("run") >= 0 && type.indexOf("trail") >= 0) return "trail_run";
      if (type.indexOf("run") >= 0) return "road_run";
      if (type.indexOf("cycling") >= 0 || type.indexOf("biking") >= 0 || type.indexOf("bike") >= 0) return "cycling";
      if (type.indexOf("mtb") >= 0 || type.indexOf("mountain") >= 0) return "mtb";
    }
    var name = (nameTag||"").toLowerCase();
    var CYCLING = ["cycling","cycle","bike","ride","사이클","그란폰도","granfondo","brevet","breve","엣지","edge","폰도","fondo"];
    var TRAIL   = ["trail","트레일","산악","mtb","mountain","울트라","ultra"];
    var RUN     = ["run","러닝","running","달리기","조깅","jog","마라톤","marathon"];
    for (var i = 0; i < CYCLING.length; i++) if (name.indexOf(CYCLING[i]) >= 0) return "cycling";
    for (var i = 0; i < TRAIL.length; i++) if (name.indexOf(TRAIL[i]) >= 0) return "trail_run";
    for (var i = 0; i < RUN.length; i++) if (name.indexOf(RUN[i]) >= 0) return "road_run";
    if (avgSpeedKmh >= 18) return "cycling";
    if (avgSpeedKmh >= 12) return gainPerKm >= 20 ? "mtb" : "cycling";
    if (avgSpeedKmh >= 6) return gainPerKm >= 30 ? "trail_run" : "road_run";
    return "trail_run";
  }

  async function handleActivityFiles(files) {
    var valid = Array.from(files).filter(function(f){return /\.(gpx|tcx|fit)$/i.test(f.name);});
    if (!valid.length) { showToast("GPX, TCX 또는 FIT 파일만 지원합니다","error"); return; }
    var added = 0, newList = activities.slice(), detectedSports = [];
    for (var i = 0; i < valid.length; i++) {
      var file = valid[i];
      var isFit = /\.fit$/i.test(file.name);
      var stats = null;

      if (isFit) {
        // FIT 바이너리 파싱
        var buf = await file.arrayBuffer();
        stats = parseActivityFIT(buf);
        if (!stats) { showToast(file.name+" — FIT 파싱 실패","error"); continue; }
        // FIT는 사이클로 기본 분류 (gpxType 기반)
      } else {
        stats = parseActivityGPX(await file.text());
        if (!stats) continue;
      }

      var avgSpeedKmh = stats.durationMin > 0 ? (stats.distanceKm/(stats.durationMin/60)) : 0;
      var gainPerKm = stats.distanceKm > 0 ? (stats.elevationGain/stats.distanceKm) : 0;
      var detected = autoClassifySport(avgSpeedKmh, gainPerKm, stats.name, stats.gpxType);
      detectedSports.push(SPORT_LABELS[detected]||detected);
      newList.unshift(Object.assign({
        id:"a_"+Date.now()+"_"+Math.random().toString(36).slice(2,5),
        sport: detected, uploadedAt: new Date().toISOString(), fileName: file.name,
      }, stats));
      added++;
    }
    if (added > 0) {
      setActivities(newList); await saveActivities(newList);
      showToast(added+"개 저장 ✓  자동분류: "+detectedSports.join(", "));
      setView("log");
    } else { showToast("파싱 실패. 파일을 확인해주세요","error"); }
  }

  async function handleCourseFile(files) {
    var file = Array.from(files).find(function(f){return /\.(gpx|tcx)$/i.test(f.name);});
    if (!file) { showToast("GPX 파일을 올려주세요","error"); return; }
    var data = parseCourseGPX(await file.text());
    if (!data) { showToast("코스 파싱 실패","error"); return; }
    setCourseData(data); setCourseFileName(file.name);
    setRacePreset("custom"); setRaceKmInput(String(data.distanceKm));
    setManualEleGain("");
    showToast("코스 로드 완료 — "+data.distanceKm+"km ✓");
  }

  async function deleteActivity(id) {
    var list = activities.filter(function(a){return a.id!==id;});
    setActivities(list); await saveActivities(list); showToast("삭제 완료");
  }

  function exportData() {
    var payload = {version:1,exportedAt:new Date().toISOString(),activities:activities,profile:profile};
    var json = JSON.stringify(payload,null,2);
    setExportText(json); setExportCopied(false);
    try {
      var blob = new Blob([json],{type:"application/json"});
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url; a.download = "garmin-log-"+new Date().toISOString().slice(0,10)+".json";
      a.click(); URL.revokeObjectURL(url);
    } catch(e) {}
  }
  function copyExportText() {
    if (!exportText) return;
    try {
      navigator.clipboard.writeText(exportText).then(function(){
        setExportCopied(true); setTimeout(function(){setExportCopied(false);},3000);
        showToast("클립보드에 복사됐어요 ✓");
      }).catch(function(){ showToast("복사 실패 — 텍스트를 직접 선택 후 복사하세요","error"); });
    } catch(e) { showToast("복사 실패","error"); }
  }

  async function handleImportFile(files) {
    var file = Array.from(files).find(function(f){return /\.json$/i.test(f.name);});
    if (!file) { showToast("JSON 파일을 올려주세요","error"); return; }
    try {
      var data = JSON.parse(await file.text());
      if (!data.version || !Array.isArray(data.activities)) throw new Error("올바른 백업 파일이 아니에요");
      setImportPreview({data:data,fileName:file.name});
    } catch(e) { showToast("파일 오류: "+e.message,"error"); }
  }
  async function confirmImport() {
    if (!importPreview) return;
    try {
      await store.set("tlog_activities", JSON.stringify(importPreview.data.activities));
      await store.set("tlog_profile", JSON.stringify(importPreview.data.profile));
      setActivities(importPreview.data.activities); setProfile(importPreview.data.profile);
      setImportPreview(null); showToast("불러오기 완료 — "+importPreview.data.activities.length+"개 ✓"); setView("log");
    } catch(e) { showToast("불러오기 실패: "+e.message,"error"); }
  }

  function getRaceKm() {
    if (racePreset === "custom") return parseFloat(raceKmInput)||0;
    var p = PRESET_RACES.find(function(r){return r.value===racePreset;});
    return p ? p.km : 0;
  }
  function getRaceLabel() {
    if (racePreset === "custom") return raceKmInput ? raceKmInput+"km" : "?km";
    var p = PRESET_RACES.find(function(r){return r.value===racePreset&&!r.disabled;});
    return p ? p.label : racePreset;
  }

  function runLocalPrediction() {
    var raceKm = getRaceKm();
    if (!raceKm) { showToast("목표 거리를 입력해주세요","error"); return; }
    var hasProfile = !!(profile.ltPaceMinKm||profile.ftp||profile.ltHR);
    if (!activities.length && !hasProfile) { showToast("활동 데이터 또는 프로필(LT/FTP)이 필요해요","error"); return; }
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
    var now = Date.now();

    // ── Banister 모델 기반 3개 시간창 분석
    var DAY = 86400000;
    var ctl42 = relevantActs.filter(function(a){return now-new Date(a.activityDate||a.uploadedAt).getTime()<42*DAY;});
    var ctl70 = relevantActs.filter(function(a){return now-new Date(a.activityDate||a.uploadedAt).getTime()<70*DAY;});
    var atl7  = relevantActs.filter(function(a){return now-new Date(a.activityDate||a.uploadedAt).getTime()<7*DAY;});
    var atl14 = relevantActs.filter(function(a){return now-new Date(a.activityDate||a.uploadedAt).getTime()<14*DAY;});
    var cond28= relevantActs.filter(function(a){return now-new Date(a.activityDate||a.uploadedAt).getTime()<28*DAY;});

    // 크로스트레이닝 시간창 (42일 이내)
    var cross42 = crossActs.filter(function(a){return now-new Date(a.activityDate||a.uploadedAt).getTime()<42*DAY;});
    var cross7  = crossActs.filter(function(a){return now-new Date(a.activityDate||a.uploadedAt).getTime()<7*DAY;});

    // 크로스트레이닝 유산소 기여 환산 (항목별 가중치 적용)
    // 트레일↔로드: 85% (심폐 거의 동일), 사이클↔러닝: 25%
    var crossVolKmEquiv = cross42.reduce(function(a, b) {
      var w = getCrossWeight(b);
      var equiv = isCyclingTarget ? b.distanceKm/3 : b.distanceKm; // 사이클은 러닝 1/3 환산
      return a + equiv * w;
    }, 0);
    var crossWeeklyKmEquiv = cross7.reduce(function(a, b) {
      var w = getCrossWeight(b);
      var equiv = isCyclingTarget ? b.distanceKm/3 : b.distanceKm;
      return a + equiv * w;
    }, 0);

    // 피트니스 창: 6~10주 데이터 우선 (CTL 42일), 없으면 70일
    var fitnessActs = ctl42.length >= 3 ? ctl42 : (ctl70.length >= 2 ? ctl70 : relevantActs);

    // 주간 볼륨: 동종 + 크로스 환산 합산 (ATL 방식)
    var wk1Km = atl7.reduce(function(a,b){return a+b.distanceKm;},0) + crossWeeklyKmEquiv;
    var wk2to4Km = cond28.filter(function(a){return now-new Date(a.activityDate||a.uploadedAt).getTime()>=7*DAY;})
      .reduce(function(a,b){return a+b.distanceKm;},0);
    var weeklyVolKm = wk1Km * 0.5 + (wk2to4Km/3) * 0.5;

    // 피트니스 기반 페이스: 6~10주 장거리 훈련 우선
    var validPaces = fitnessActs.filter(function(a){return a.avgPaceMinKm>1&&a.avgPaceMinKm<20;}).map(function(a){return a.avgPaceMinKm;});
    var recentAvgPace = validPaces.length ? validPaces.reduce(function(a,b){return a+b;},0)/validPaces.length : 0;

    // 장거리 훈련 페이스 (목표의 40% 이상, 6~10주 이내)
    var longActs = fitnessActs.filter(function(a){return a.distanceKm>=raceKm*0.4&&a.avgPaceMinKm>1;});
    var recentLongPace = longActs.length ? longActs.reduce(function(a,b){return a+b.avgPaceMinKm;},0)/longActs.length : 0;

    // 컨디션 계수: 동종 + 크로스 포함 전체 부하 기반
    var condFactor = 1.0;
    if (fitnessActs.length >= 2 && weeklyVolKm > 0) {
      var ftBaseKm = (fitnessActs.reduce(function(a,b){return a+b.distanceKm;},0) + crossVolKmEquiv)
        / Math.ceil((fitnessActs.length + cross42.length) / 1.5);
      var tsb = ftBaseKm > 0 ? (ftBaseKm - wk1Km) / ftBaseKm : 0;
      if (tsb > 0.3) condFactor = 0.97;
      else if (tsb > 0.1) condFactor = 0.99;
      else if (tsb < -0.3) condFactor = 1.04;
      else if (tsb < -0.1) condFactor = 1.02;
    }

    var fitnessWindowLabel = ctl42.length >= 3 ? "6주(42일)" : (ctl70.length >= 2 ? "10주(70일)" : "전체 기간");
    var condLabel = condFactor < 1.0 ? "컨디션 양호" : (condFactor > 1.02 ? "피로 축적" : "보통");
    var hasCrossTraining = cross42.length > 0;

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
      var dataPace = 0, dataLabel = "", dataConfidence = "";
      if (recentLongPace > 0) {
        var distFactor = Math.pow(raceKm/Math.max(maxActDist,raceKm*0.5), 0.07);
        dataPace = recentLongPace * distFactor;
        dataLabel = "장거리 훈련 기반 ("+fitnessWindowLabel+")"; dataConfidence = "신뢰도 높음";
      } else if (recentAvgPace > 0) {
        var distPenalty = 1 + Math.log(raceKm/Math.max(maxActDist,5))*0.08;
        dataPace = recentAvgPace * Math.max(1.0,distPenalty);
        dataLabel = "훈련 평균 기반 ("+fitnessWindowLabel+")"; dataConfidence = "신뢰도 보통";
      }
      var elePerKm = 0;
      if (courseData) {
        // 코스 GPX 있으면 코스 고도 우선
        elePerKm = courseData.gainPerKm;
      } else if (sport === "trail_run") {
        // 트레일런이고 코스 없으면 훈련 평균 고도 사용
        elePerKm = avgElePerKm;
      }
      // 로드런은 코스 GPX 없으면 고도 보정 0 (평지 기준)

      // 트레일런 고도 보정: Minetti 구간별 계산 (로드 단순 공식 대체)
      // 로드런: 100m/km당 6% (기존)
      // 트레일: 구간별 경사 × 에너지 비용 비율로 정밀 계산
      var eleBoostPct = 0;
      if (elePerKm > 0) {
        if (sport === "trail_run" && courseData && courseData.elevProfile && courseData.elevProfile.length >= 2) {
          // Minetti 트레일 보정: 코스 elevProfile로 구간별 경사 → 가중 평균 배율
          var ep = courseData.elevProfile;
          var totalFactor = 0, totalDist2 = 0;
          var segLen = courseData.distanceKm / (ep.length - 1);
          for (var ei = 1; ei < ep.length; ei++) {
            var g = (ep[ei] - ep[ei-1]) / (segLen * 1000);
            var s = Math.max(-0.30, Math.min(0.30, g));
            var cost = (155.4*Math.pow(s,5) - 30.4*Math.pow(s,4) - 43.3*Math.pow(s,3) + 46.3*Math.pow(s,2) + 19.5*s + 3.6) / 3.6;
            // 트레일 내리막 보정
            if (s < -0.10) cost = 1.05;
            else if (s < -0.05) cost = 1.0;
            else if (s < 0) cost = 1.0 + (cost - 1.0) * 0.30;
            totalFactor += cost * segLen;
            totalDist2 += segLen;
          }
          var avgFactor = totalDist2 > 0 ? totalFactor / totalDist2 : 1.0;
          eleBoostPct = avgFactor - 1.0; // 예: 1.35 → 35% 페이스 페널티
        } else {
          // 로드런 / 코스 없을 때: 기존 단순 공식
          eleBoostPct = (elePerKm / 100) * 0.06;
        }
      }
      var rows = [];
      if (dataPace > 0 && lt > 0) {
        rows = [
          {src:"훈련 데이터 기반", pace:dataPace*condFactor*(1+eleBoostPct), desc:dataLabel+" · "+dataConfidence, isRecommended:false},
          {src:"통합 예측 (추천)", pace:(dataPace*0.6+lt*1.12*0.4)*condFactor*(1+eleBoostPct), desc:"실측+LT 통합 · "+condLabel, isRecommended:true},
          {src:"LT 이론 기반", pace:lt*1.15*(1+eleBoostPct), desc:"LT 페이스 × 1.15 (이론)", isRecommended:false},
        ];
      } else if (dataPace > 0) {
        rows = [
          {src:"낙관적", pace:dataPace*condFactor*(1+eleBoostPct)*0.95, desc:dataLabel+" · 컨디션 최상", isRecommended:false},
          {src:"현실적 (추천)", pace:dataPace*condFactor*(1+eleBoostPct), desc:dataLabel+" · "+condLabel, isRecommended:true},
          {src:"보수적", pace:dataPace*condFactor*(1+eleBoostPct)*1.08, desc:dataLabel+" · 여유 있게", isRecommended:false},
        ];
      } else if (lt > 0) {
        // 거리별 적정 LT 배율 (스포츠과학 기반)
        // 10K: LT×1.04~1.08, 하프: LT×1.10~1.14, 풀마: LT×1.18~1.22
        var ltMult, ltMultHard, ltMultEasy;
        if (raceKm <= 5) {
          ltMultHard = 1.00; ltMult = 1.03; ltMultEasy = 1.07;
        } else if (raceKm <= 10) {
          ltMultHard = 1.03; ltMult = 1.06; ltMultEasy = 1.10;
        } else if (raceKm <= 21.1) {
          ltMultHard = 1.08; ltMult = 1.12; ltMultEasy = 1.17;
        } else if (raceKm <= 42.195) {
          ltMultHard = 1.14; ltMult = 1.18; ltMultEasy = 1.24;
        } else if (raceKm <= 60) {
          ltMultHard = 1.22; ltMult = 1.28; ltMultEasy = 1.35;
        } else {
          ltMultHard = 1.30; ltMult = 1.40; ltMultEasy = 1.55;
        }
        rows = [
          {src:"목표 페이스 (LT×"+ltMultHard.toFixed(2)+")", pace:lt*ltMultHard*(1+eleBoostPct), desc:"충분히 훈련된 경우 도전 페이스", isRecommended:false},
          {src:"현실적 예측 (LT×"+ltMult.toFixed(2)+")", pace:lt*ltMult*(1+eleBoostPct), desc:"일반적 레이스 페이스 기준", isRecommended:true},
          {src:"여유 페이스 (LT×"+ltMultEasy.toFixed(2)+")", pace:lt*ltMultEasy*(1+eleBoostPct), desc:"처음 도전 / 완주 목표", isRecommended:false},
        ];
      }
      if (rows.length) {
        runningRows = rows.map(function(r) {
          var totalMin = r.pace * raceKm;
          var tH = Math.floor(totalMin/60), tM = Math.round(totalMin%60);
          if (tM===60){tH++;tM=0;}
          return {label:r.src, desc:r.desc, pace:formatPace(r.pace), time:tH+"h "+String(tM).padStart(2,"0")+"m", isRecommended:r.isRecommended};
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
      maxDist: maxActDist.toFixed(1),
      fitnessWindow: fitnessWindowLabel,
      condLabel: condLabel,
      isCycling: isCyclingSport,
      avgPace: (!isCyclingSport&&recentAvgPace>0) ? formatPace(recentAvgPace) : null,
      longPace: (!isCyclingSport&&recentLongPace>0) ? formatPace(recentLongPace) : null,
      avgPower: isCyclingSport&&recentAvgPower>0 ? recentAvgPower+"W" : null,
      avgSpeed: isCyclingSport&&recentAvgSpeed>0 ? recentAvgSpeed+"km/h" : null,
      crossCount: cross42.length,
      crossKmEquiv: crossVolKmEquiv > 0 ? crossVolKmEquiv.toFixed(0) : null,
      crossWeight: Math.round(CROSS_WEIGHT*100),
    } : null;

    setAiText(null);
    setAnalysis({
      raceLabel:getRaceLabel(), raceKm:raceKm, hasCourse:!!courseData,
      courseData:courseData?Object.assign({},courseData):null,
      effectiveEleGain:courseData&&manualEleGain&&parseFloat(manualEleGain)>0?parseFloat(manualEleGain):(courseData?courseData.elevationGain:null),
      hasProfile:hasProfile, noActivity:noActivity,
      cyclingRows:cyclingRows, runningRows:runningRows,
      trainingSummary:trainingSummary, sport:sport,
    });
    setView("predict");
  }
  async function runPrediction() { runLocalPrediction(); }

  var selected = activities.find(function(a){return a.id===selectedId;});
  var totalKm = activities.reduce(function(a,b){return a+b.distanceKm;},0).toFixed(1);
  var totalEle = activities.reduce(function(a,b){return a+(b.elevationGain||0);},0).toLocaleString();

  if (!storageReady) return (
    <div style={{background:C.bg,minHeight:"100dvh",display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{color:C.accent,fontFamily:"monospace",fontSize:12,letterSpacing:3}}>LOADING...</div>
    </div>
  );

  return (
    <div style={{background:C.bg,minHeight:"100dvh",fontFamily:"sans-serif",color:C.text}}>
      <div style={{position:"fixed",inset:0,pointerEvents:"none",zIndex:0,
        backgroundImage:"linear-gradient(rgba(0,229,160,0.02) 1px,transparent 1px),linear-gradient(90deg,rgba(0,229,160,0.02) 1px,transparent 1px)",
        backgroundSize:"32px 32px"}} />
      {toast && (
        <div style={{position:"fixed",top:20,right:20,zIndex:999,
          background:toast.type==="error"?"#2a0f0a":"#0a2a1a",
          border:"1px solid "+(toast.type==="error"?C.red:C.accent),
          color:toast.type==="error"?C.red:C.accent,
          padding:"10px 18px",fontFamily:"monospace",fontSize:12,letterSpacing:1}}>
          {toast.msg}
        </div>
      )}
      <div style={{maxWidth:840,margin:"0 auto",padding:"env(safe-area-inset-top, 44px) 20px calc(env(safe-area-inset-bottom, 20px) + 60px)",position:"relative",zIndex:1}}>

        {/* 헤더 */}
        <div style={{marginBottom:24}}>
          <div style={{fontFamily:"monospace",fontSize:10,color:C.accent,letterSpacing:4,marginBottom:5}}>◆ PERSONAL TRAINING LOG</div>
          <div style={{fontSize:28,fontWeight:900,letterSpacing:1,marginBottom:10}}>내 훈련 기록</div>
          <div style={{display:"flex",gap:18,flexWrap:"wrap"}}>
            {[
              ["활동",activities.length+"개"],["총 거리",totalKm+" km"],["누적 고도",totalEle+" m↑"],
              ...(profile.ltPaceMinKm?[["LT 페이스",formatPace(parseFloat(profile.ltPaceMinKm))]]:[]),
              ...(profile.ftp?[["FTP",profile.ftp+"W"]]:[]),
            ].map(function(item){
              return (
                <span key={item[0]} style={{fontFamily:"monospace",fontSize:11}}>
                  <span style={{color:C.muted}}>{item[0]}: </span>
                  <span style={{color:C.accent}}>{item[1]}</span>
                </span>
              );
            })}
          </div>
        </div>

        {/* 탭 */}
        <div style={{display:"flex",gap:2,marginBottom:22,borderBottom:"1px solid "+C.border,flexWrap:"wrap"}}>
          {[["log","📋 기록"],["profile","⚡ 프로필"],["predict","🎯 예측"],["backup","💾 백업"]].map(function(item){
            return (
              <button key={item[0]} onClick={function(){setView(item[0]);if(item[0]!=="predict")setAnalysis(null);}} style={tabBtn(view===item[0])}>
                {item[1]}
              </button>
            );
          })}
        </div>

        {/* ── 기록 탭 */}
        {view==="log" && (
          <div>
            {/* 종목 필터 탭 — 항상 상단 표시 */}
            <div style={{display:"flex",gap:4,marginBottom:10,flexWrap:"wrap"}}>
              {[["all","🗂 전체"]].concat(Object.entries(SPORT_LABELS).map(function(e){return [e[0],e[1]];})).map(function(item){
                var key = item[0], label = item[1];
                var count = key==="all" ? activities.length : activities.filter(function(a){return a.sport===key;}).length;
                var isActive = logFilter===key;
                return (
                  <button key={key} onClick={function(){setLogFilter(key);}} style={{
                    background:isActive?C.accent:"transparent",
                    color:isActive?C.bg:count>0?C.muted:"#2a3040",
                    border:"1px solid "+(isActive?C.accent:count>0?C.border:"#1a2030"),
                    padding:"6px 12px",cursor:count>0||key==="all"?"pointer":"default",
                    fontFamily:"monospace",fontSize:11,fontWeight:isActive?700:400,
                    transition:"all .15s",opacity:count===0&&key!=="all"?0.4:1,
                  }}>
                    {label} {count>0&&<span style={{opacity:0.7}}>({count})</span>}
                  </button>
                );
              })}
              <div style={{marginLeft:"auto"}} onClick={function(){actRef.current.click();}}
                onDragOver={function(e){e.preventDefault();setActDrag(true);}}
                onDragLeave={function(){setActDrag(false);}}
                onDrop={function(e){e.preventDefault();setActDrag(false);handleActivityFiles(e.dataTransfer.files);}}
                style={{border:"1px solid "+C.accent,padding:"6px 14px",cursor:"pointer",fontFamily:"monospace",fontSize:11,color:C.accent,fontWeight:700,background:actDrag?"rgba(0,229,160,0.08)":"transparent",transition:"all .15s",flexShrink:0}}>
                + GPX
              </div>
            </div>

            {!activities.length ? (
              <div>
                <div onDragOver={function(e){e.preventDefault();setActDrag(true);}}
                  onDragLeave={function(){setActDrag(false);}}
                  onDrop={function(e){e.preventDefault();setActDrag(false);handleActivityFiles(e.dataTransfer.files);}}
                  onClick={function(){actRef.current.click();}}
                  style={{border:"1.5px dashed "+(actDrag?C.accent:C.border),background:actDrag?"rgba(0,229,160,0.04)":C.surface,padding:"40px 20px",cursor:"pointer",textAlign:"center"}}>
                  <div style={{fontSize:28,marginBottom:8}}>📂</div>
                  <div style={{fontFamily:"monospace",fontSize:13,marginBottom:4}}>GPX 드래그 또는 클릭</div>
                  <div style={{fontFamily:"monospace",fontSize:10,color:C.muted}}>종목 자동 분류</div>
                </div>
              </div>
            ) : (
              <div>
                {/* 연도/월별 그룹핑 — logFilter 적용 */}
                {(function(){
                  var filtered = logFilter==="all" ? activities : activities.filter(function(a){return a.sport===logFilter;});
                  if (!filtered.length) return (
                    <div style={{textAlign:"center",padding:"32px 20px",color:C.muted,fontFamily:"monospace",fontSize:12}}>
                      {SPORT_LABELS[logFilter]||logFilter} 기록이 없어요
                    </div>
                  );
                  var groups = {};
                  filtered.forEach(function(act){
                    var dateStr = act.activityDate || act.uploadedAt || "";
                    var ym = dateStr ? dateStr.slice(0,7) : "날짜없음";
                    if (!groups[ym]) groups[ym] = [];
                    groups[ym].push(act);
                  });
                  var keys = Object.keys(groups).sort(function(a,b){return b>a?1:-1;});
                  var defaultKey = keys.length > 0 ? keys[0] : null;
                  return keys.map(function(ym){
                    var isExpanded = ym in expandedMonths ? expandedMonths[ym] : (ym===defaultKey);
                    var label = ym==="날짜없음"?"날짜 없음":(function(){var p=ym.split("-");return p[0]+"년 "+parseInt(p[1])+"월";})();
                    var monthActs = groups[ym];
                    var monthKm = monthActs.reduce(function(a,b){return a+b.distanceKm;},0).toFixed(0);
                    var monthEle = monthActs.reduce(function(a,b){return a+(b.elevationGain||0);},0);
                    return (
                      <div key={ym} style={{marginBottom:8}}>
                        <div
                          onClick={function(){setExpandedMonths(function(prev){var next=Object.assign({},prev);next[ym]=!isExpanded;return next;});}}
                          style={{display:"flex",alignItems:"center",gap:10,padding:"9px 14px",cursor:"pointer",
                            background:isExpanded?"rgba(0,229,160,0.06)":C.surface,
                            border:"1px solid "+(isExpanded?"rgba(0,229,160,0.25)":C.border),
                            marginBottom:isExpanded?6:0,transition:"all .15s"}}
                          onMouseEnter={function(e){e.currentTarget.style.borderColor=C.accent;}}
                          onMouseLeave={function(e){e.currentTarget.style.borderColor=isExpanded?"rgba(0,229,160,0.25)":C.border;}}>
                          <div style={{fontFamily:"monospace",fontSize:12,color:C.accent,fontWeight:700,letterSpacing:1,flex:1}}>
                            {isExpanded?"▾ ":"▸ "}{label}
                          </div>
                          <div style={{fontFamily:"monospace",fontSize:10,color:C.muted}}>
                            {monthActs.length}개 · {monthKm}km · {monthEle.toLocaleString()}m↑
                          </div>
                        </div>
                        {isExpanded && (
                          <div style={{display:"flex",flexDirection:"column",gap:6}}>
                            {monthActs.map(function(act){
                              var title = act.name || act.fileName || "활동";
                              var dateLabel = act.activityDate || (act.uploadedAt?act.uploadedAt.slice(0,10):"");
                              return (
                                <div key={act.id}
                                  style={Object.assign(cardStyle(),{cursor:"pointer",padding:"10px 14px"})}
                                  onMouseEnter={function(e){e.currentTarget.style.borderColor=C.accent;}}
                                  onMouseLeave={function(e){e.currentTarget.style.borderColor=C.border;}}
                                  onClick={function(){setSelectedId(act.id);setView("detail");}}>
                                  <div style={{display:"flex",alignItems:"flex-start",gap:8,marginBottom:5}}>
                                    <div style={{fontSize:16,flexShrink:0,marginTop:1}}>
                                      {act.sport==="trail_run"?"🏔":act.sport==="cycling"?"🚴":act.sport==="mtb"?"🚵":"🏃"}
                                    </div>
                                    <div style={{flex:1,minWidth:0}}>
                                      <div style={{fontWeight:700,fontSize:13,lineHeight:1.35,wordBreak:"break-word",marginBottom:2}}>{title}</div>
                                      <div style={{fontFamily:"monospace",fontSize:10,color:C.muted}}>{dateLabel} · {SPORT_LABELS[act.sport]||act.sport}</div>
                                    </div>
                                    <button onClick={function(e){e.stopPropagation();deleteActivity(act.id);}}
                                      style={{background:"transparent",border:"none",color:"#2a3040",cursor:"pointer",fontSize:13,padding:"2px 4px",flexShrink:0}}
                                      onMouseEnter={function(e){e.currentTarget.style.color=C.red;}}
                                      onMouseLeave={function(e){e.currentTarget.style.color="#2a3040";}}>✕</button>
                                  </div>
                                  <div style={{display:"flex",gap:10,flexWrap:"wrap",paddingLeft:24}}>
                                    {[
                                      [act.distanceKm+"km",C.text],[formatPace(act.avgPaceMinKm),C.accent],
                                      [(act.elevationGain||0)+"m↑",C.gold],[act.avgHR?act.avgHR+"bpm":"—",C.red],
                                      ...(act.avgPower?[[act.avgPower+"W",C.blue]]:[]),
                                      ...(act.normalizedPower?[["NP "+act.normalizedPower+"W","#7ab8ff"]]:[]),
                                      ...(act.tss?[["TSS "+Math.round(act.tss),"#a88fff"]]:[]),
                                    ].map(function(v,i){return <div key={i} style={{fontFamily:"monospace",fontSize:12,fontWeight:700,color:v[1]}}>{v[0]}</div>;})}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  });
                })()}
              </div>
            )}
            <input ref={actRef} type="file" multiple accept=".gpx,.tcx,.fit" style={{display:"none"}} onChange={function(e){handleActivityFiles(e.target.files);}} />
          </div>
        )}

        {/* ── 상세 탭 */}
        {view==="detail" && selected && (
          <div>
            <button onClick={function(){setView("log");}} style={{background:"transparent",border:"1px solid "+C.border,color:C.muted,padding:"6px 14px",cursor:"pointer",fontFamily:"monospace",fontSize:11,marginBottom:18}}>← 목록</button>
            <div style={{marginBottom:14}}>
              <div style={secTitle()}>ACTIVITY DETAIL</div>
              <div style={{fontSize:18,fontWeight:700}}>{selected.name||selected.fileName}</div>
              <div style={{fontFamily:"monospace",fontSize:11,color:C.muted,marginTop:3}}>
                {selected.activityDate||(selected.uploadedAt?selected.uploadedAt.slice(0,10):"")} · {SPORT_LABELS[selected.sport]}
              </div>
            </div>
            {selected.elevProfile && (
              <div style={Object.assign(cardStyle(),{marginBottom:12})}>
                <div style={{fontFamily:"monospace",fontSize:9,color:C.muted,letterSpacing:2,marginBottom:5}}>ELEVATION PROFILE</div>
                <ElevChart data={selected.elevProfile} color={C.accent} height={56} />
              </div>
            )}
            <div style={{display:"grid",gridTemplateColumns:"repeat(3, 1fr)",gap:8}}>
              {[
                ["거리",selected.distanceKm+" km",C.accent],["시간",formatDuration(selected.durationMin),C.text],
                ["평균 페이스",formatPace(selected.avgPaceMinKm),C.accent],
                ["고도 상승",(selected.elevationGain||0)+" m↑",C.gold],["고도 하강",(selected.elevationLoss||0)+" m↓",C.gold],
                ["평균 심박",selected.avgHR?selected.avgHR+" bpm":"—",C.red],
                ["최고 심박",selected.maxHR?selected.maxHR+" bpm":"—",C.red],
                ...(selected.avgPower?[["평균 파워",selected.avgPower+" W",C.blue]]:[]),
                ["GPS 포인트",selected.points?selected.points.toLocaleString():"—",C.muted],
              ].map(function(item){
                return (
                  <div key={item[0]} style={cardStyle()}>
                    <div style={{fontFamily:"monospace",fontSize:9,color:C.muted,letterSpacing:2,marginBottom:4,textTransform:"uppercase"}}>{item[0]}</div>
                    <div style={{fontFamily:"monospace",fontSize:16,fontWeight:700,color:item[2],overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{item[1]}</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── 프로필 탭 */}
        {view==="profile" && (
          <div>
            <div style={Object.assign(cardStyle(),{marginBottom:14,borderLeft:"3px solid "+C.gold})}>
              <div style={secTitle(C.gold)}>ℹ️  ABOUT</div>
              <div style={{fontSize:12,color:"#a8b4c8",lineHeight:1.9}}>
                Garmin Connect의 <strong style={{color:C.text}}>젖산 역치 페이스 / FTP</strong> 값을 입력해두세요.<br />
                훈련 데이터가 쌓일수록 예측이 더 정밀해집니다.
              </div>
            </div>
            <div style={Object.assign(cardStyle(),{marginBottom:10})}>
              <div style={secTitle()}>// 기본 정보</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                <div><div style={labelStyle()}>이름</div><input type="text" value={profile.name} onChange={function(e){setProfile(function(p){return Object.assign({},p,{name:e.target.value});});}} placeholder="예: 이름" style={inputStyle()} /></div>
                <div><div style={labelStyle()}>체중 (kg)</div><input type="number" value={profile.weight} onChange={function(e){setProfile(function(p){return Object.assign({},p,{weight:e.target.value});});}} placeholder="예: 65" style={inputStyle()} /></div>
                <div><div style={labelStyle()}>나이</div><input type="number" value={profile.age} onChange={function(e){setProfile(function(p){return Object.assign({},p,{age:e.target.value});});}} placeholder="예: 31" style={inputStyle()} /></div>
                <div>
                  <div style={labelStyle()}>성별</div>
                  <select value={profile.gender} onChange={function(e){setProfile(function(p){return Object.assign({},p,{gender:e.target.value});});}} style={selectStyle()}>
                    <option value="male">남성</option><option value="female">여성</option>
                  </select>
                </div>
              </div>
            </div>
            <div style={Object.assign(cardStyle(),{marginBottom:10,borderLeft:"3px solid "+C.accent})}>
              <div style={secTitle()}>// 러닝 퍼포먼스</div>
              <div style={{fontSize:11,color:C.muted,marginBottom:14}}>Garmin Connect → 나의 통계 → 달리기 역치</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12}}>
                <div>
                  <div style={labelStyle()}>LT2 페이스 (min/km)</div>
                  <input type="number" value={profile.ltPaceMinKm} onChange={function(e){setProfile(function(p){return Object.assign({},p,{ltPaceMinKm:e.target.value});});}} placeholder="예: 5.25" step="0.01" style={inputStyle()} />
                  <div style={{fontFamily:"monospace",fontSize:10,color:C.muted,marginTop:4}}>{profile.ltPaceMinKm?"→ "+formatPace(parseFloat(profile.ltPaceMinKm)):"Garmin 역치 페이스"}</div>
                </div>
                <div>
                  <div style={labelStyle()}>LTHR (bpm)</div>
                  <input type="number" value={profile.ltHR} onChange={function(e){setProfile(function(p){return Object.assign({},p,{ltHR:e.target.value});});}} placeholder="예: 162" style={inputStyle()} />
                </div>
                <div>
                  <div style={labelStyle()}>VO2max 러닝</div>
                  <input type="number" value={profile.vo2maxRun} onChange={function(e){setProfile(function(p){return Object.assign({},p,{vo2maxRun:e.target.value});});}} placeholder="예: 52" style={inputStyle()} />
                </div>
              </div>
              {profile.ltPaceMinKm && !isNaN(parseFloat(profile.ltPaceMinKm)) && (
                <div style={{marginTop:14,background:"rgba(0,229,160,0.06)",border:"1px solid rgba(0,229,160,0.2)",padding:"10px 14px"}}>
                  <div style={{fontFamily:"monospace",fontSize:10,color:C.accent,marginBottom:6,letterSpacing:2}}>LT 기반 페이스 참고표</div>
                  <div style={{display:"flex",gap:16,flexWrap:"wrap"}}>
                    {[["하프",1.06],["풀마라톤",1.12],["50K 트레일",1.20],["100K",1.35]].map(function(item){
                      return <span key={item[0]} style={{fontFamily:"monospace",fontSize:11}}><span style={{color:C.muted}}>{item[0]}: </span><span style={{color:C.text}}>{formatPace(parseFloat(profile.ltPaceMinKm)*item[1])}</span></span>;
                    })}
                  </div>
                </div>
              )}
            </div>
            <div style={Object.assign(cardStyle(),{marginBottom:10,borderLeft:"3px solid "+C.blue})}>
              <div style={secTitle(C.blue)}>// 사이클링 퍼포먼스</div>
              <div style={{fontSize:11,color:C.muted,marginBottom:14}}>Garmin Connect → 나의 통계 → 사이클링 FTP</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12}}>
                <div>
                  <div style={labelStyle()}>FTP (W)</div>
                  <input type="number" value={profile.ftp} onChange={function(e){setProfile(function(p){return Object.assign({},p,{ftp:e.target.value});});}} placeholder="예: 210" style={inputStyle()} />
                </div>
                <div>
                  <div style={labelStyle()}>FTP/kg (W/kg)</div>
                  <input type="number" value={profile.ftpPerKg} onChange={function(e){setProfile(function(p){return Object.assign({},p,{ftpPerKg:e.target.value});});}} placeholder="예: 3.2" step="0.01" style={inputStyle()} />
                  <div style={{fontFamily:"monospace",fontSize:10,color:C.muted,marginTop:4}}>{profile.ftp&&profile.weight?"→ "+(parseFloat(profile.ftp)/parseFloat(profile.weight)).toFixed(2)+" W/kg":"체중 입력 시 자동계산"}</div>
                </div>
                <div>
                  <div style={labelStyle()}>VO2max 사이클</div>
                  <input type="number" value={profile.vo2maxCycle} onChange={function(e){setProfile(function(p){return Object.assign({},p,{vo2maxCycle:e.target.value});});}} placeholder="예: 55" style={inputStyle()} />
                </div>
              </div>
              {profile.ftp && !isNaN(parseFloat(profile.ftp)) && (
                <div style={{marginTop:14,background:"rgba(77,159,255,0.06)",border:"1px solid rgba(77,159,255,0.2)",padding:"10px 14px"}}>
                  <div style={{fontFamily:"monospace",fontSize:10,color:C.blue,marginBottom:6,letterSpacing:2}}>FTP 기반 장거리 타깃 파워</div>
                  <div style={{display:"flex",gap:16,flexWrap:"wrap"}}>
                    {[["100km",0.73],["160km 그란폰도",0.68],["200km",0.62]].map(function(item){
                      return <span key={item[0]} style={{fontFamily:"monospace",fontSize:11}}><span style={{color:C.muted}}>{item[0]}: </span><span style={{color:C.text}}>{Math.round(parseFloat(profile.ftp)*item[1])}W</span></span>;
                    })}
                  </div>
                </div>
              )}
            </div>
            <div style={Object.assign(cardStyle(),{marginBottom:16})}>
              <div style={secTitle()}>// 메모</div>
              <textarea value={profile.notes} onChange={function(e){setProfile(function(p){return Object.assign({},p,{notes:e.target.value});});}}
                placeholder="예: PCL 재건술 후 복귀 중, 무릎 감각 주의"
                style={Object.assign(inputStyle(),{height:72,resize:"vertical"})} />
            </div>
            <button onClick={async function(){await saveProfile(profile);}} style={{
              width:"100%",padding:16,background:profileSaved?"#0a2a1a":C.accent,
              color:profileSaved?C.accent:C.bg,border:profileSaved?"1px solid "+C.accent:"none",
              fontFamily:"monospace",fontSize:14,fontWeight:700,letterSpacing:3,cursor:"pointer",transition:"all .3s",
            }}>{profileSaved?"✓ 저장 완료":"프로필 저장"}</button>
          </div>
        )}

        {/* ── 예측 탭 */}
        {view==="predict" && (
          <div>
            {!analysis ? (
              <div>
                {/* 프로필 상태 */}
                <div style={Object.assign(cardStyle(),{marginBottom:10,borderLeft:"3px solid "+((profile.ltPaceMinKm||profile.ftp)?C.accent:C.muted)})}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <div>
                      <div style={{fontFamily:"monospace",fontSize:11,color:(profile.ltPaceMinKm||profile.ftp)?C.accent:C.muted,marginBottom:4}}>
                        {(profile.ltPaceMinKm||profile.ftp)?"⚡ 프로필 연동 — 정밀 예측 가능":"⚠ 프로필 미입력 — 훈련 데이터만으로 예측"}
                      </div>
                      <div style={{fontFamily:"monospace",fontSize:10,color:C.muted}}>
                        {profile.ltPaceMinKm&&"LT: "+formatPace(parseFloat(profile.ltPaceMinKm))}
                        {profile.ltPaceMinKm&&profile.ftp&&"  ·  "}
                        {profile.ftp&&"FTP: "+profile.ftp+"W"}
                        {profile.ltHR&&"  ·  LTHR: "+profile.ltHR+"bpm"}
                      </div>
                    </div>
                    <button onClick={function(){setView("profile");}} style={{background:"transparent",border:"1px solid "+C.border,color:C.muted,padding:"5px 12px",cursor:"pointer",fontFamily:"monospace",fontSize:10}}>
                      {(profile.ltPaceMinKm||profile.ftp)?"수정":"입력하기"}
                    </button>
                  </div>
                </div>
                {/* 종목 */}
                <div style={Object.assign(cardStyle(),{marginBottom:10})}>
                  <div style={secTitle()}>// 01 · 종목</div>
                  <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                    {Object.entries(SPORT_LABELS).map(function(entry){
                      return (
                        <button key={entry[0]} onClick={function(){setSport(entry[0]);}} style={{
                          background:sport===entry[0]?C.accent:C.surface2,color:sport===entry[0]?C.bg:C.muted,
                          border:"1px solid "+(sport===entry[0]?C.accent:C.border),
                          padding:"7px 14px",cursor:"pointer",fontFamily:"monospace",fontSize:12,transition:"all .15s",
                        }}>{entry[1]}</button>
                      );
                    })}
                  </div>
                </div>
                {/* 목표 거리 */}
                <div style={Object.assign(cardStyle(),{marginBottom:10})}>
                  <div style={secTitle()}>// 02 · 목표 대회 거리</div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                    <div>
                      <div style={labelStyle()}>프리셋</div>
                      <select value={racePreset} onChange={function(e){setRacePreset(e.target.value);if(e.target.value!=="custom")setRaceKmInput("");}} style={selectStyle()}>
                        {PRESET_RACES.map(function(r,i){return <option key={i} value={r.value} disabled={!!r.disabled}>{r.label}</option>;})}
                      </select>
                    </div>
                    <div>
                      <div style={labelStyle()}>직접 입력 (km)</div>
                      <div style={{display:"flex",gap:8,alignItems:"center"}}>
                        <input type="number" value={racePreset==="custom"?raceKmInput:(getRaceKm()||"")}
                          onChange={function(e){setRacePreset("custom");setRaceKmInput(e.target.value);}}
                          placeholder="예: 63.5" min="1" max="1000" step="0.1" style={Object.assign(inputStyle(),{flex:1})} />
                        <span style={{fontFamily:"monospace",fontSize:12,color:C.muted,flexShrink:0}}>km</span>
                      </div>
                      {courseData&&raceKmInput&&<div style={{fontFamily:"monospace",fontSize:10,color:C.accent,marginTop:4}}>← 코스 파일에서 자동 입력</div>}
                    </div>
                  </div>
                  {getRaceKm()>0&&<div style={{marginTop:10,fontFamily:"monospace",fontSize:12,color:C.muted}}>목표: <span style={{color:C.accent,fontWeight:700}}>{getRaceKm()}km</span></div>}
                </div>
                {/* 코스 GPX */}
                <div style={Object.assign(cardStyle(),{marginBottom:10})}>
                  <div style={secTitle(C.gold)}>// 03 · 대회 코스 GPX (선택)</div>
                  {courseData ? (
                    <div style={{background:"rgba(255,184,48,0.05)",border:"1px solid rgba(255,184,48,0.25)",padding:"14px 16px"}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
                        <div>
                          <div style={{fontFamily:"monospace",fontSize:12,color:C.gold,marginBottom:2}}>✓ {courseData.name}</div>
                          <div style={{fontFamily:"monospace",fontSize:10,color:C.muted}}>{courseFileName}</div>
                        </div>
                        <button onClick={function(){setCourseData(null);setCourseFileName("");setRaceKmInput("");setManualEleGain("");}} style={{background:"transparent",border:"1px solid "+C.border,color:C.muted,padding:"4px 10px",cursor:"pointer",fontFamily:"monospace",fontSize:10}}>제거</button>
                      </div>
                      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginBottom:12}}>
                        {[["거리",courseData.distanceKm+"km",C.text],["상승(GPX)",courseData.elevationGain+"m↑",(manualEleGain&&parseFloat(manualEleGain)>0)?C.muted:C.gold],
                          ["난이도",courseData.techDifficulty,C.red],["상승/km",courseData.gainPerKm+"m/km",C.blue],
                          ["최저",courseData.minElevation+"m",C.muted],["최고",courseData.maxElevation+"m",C.muted]].map(function(item){
                          return (
                            <div key={item[0]} style={{background:C.surface2,padding:"8px 10px"}}>
                              <div style={{fontFamily:"monospace",fontSize:9,color:C.muted,marginBottom:3}}>{item[0]}</div>
                              <div style={{fontFamily:"monospace",fontSize:13,fontWeight:700,color:item[2]}}>{item[1]}</div>
                            </div>
                          );
                        })}
                      </div>
                      {/* 수동 고도 입력 */}
                      <div style={{background:"rgba(255,184,48,0.05)",border:"1px solid rgba(255,184,48,0.2)",padding:"12px 14px",marginBottom:12}}>
                        <div style={{fontFamily:"monospace",fontSize:10,color:C.gold,marginBottom:4}}>⚠ GPX 고도 ≠ Garmin 실측 고도 (기압 고도계 차이)</div>
                        <div style={{fontFamily:"monospace",fontSize:10,color:C.muted,marginBottom:8,lineHeight:1.6}}>Garmin Connect 누적 상승 수치를 입력하면 시뮬레이션에 반영됩니다.</div>
                        <div style={{display:"flex",gap:8,alignItems:"center"}}>
                          <div style={{fontFamily:"monospace",fontSize:11,color:C.muted,flexShrink:0}}>실제 누적 상승:</div>
                          <input type="number" value={manualEleGain} onChange={function(e){setManualEleGain(e.target.value);}}
                            placeholder={"예: "+courseData.elevationGain+" (GPX값)"}
                            style={Object.assign(inputStyle(),{flex:1,padding:"6px 10px",fontSize:12})} />
                          <div style={{fontFamily:"monospace",fontSize:11,color:C.muted,flexShrink:0}}>m</div>
                          {manualEleGain&&<button onClick={function(){setManualEleGain("");}} style={{background:"transparent",border:"none",color:C.muted,cursor:"pointer",fontFamily:"monospace",fontSize:11}}>초기화</button>}
                        </div>
                        {manualEleGain&&parseFloat(manualEleGain)>0&&(
                          <div style={{fontFamily:"monospace",fontSize:10,color:C.gold,marginTop:6}}>✓ {parseFloat(manualEleGain).toLocaleString()}m↑ 반영 (GPX {courseData.elevationGain}m 대신)</div>
                        )}
                      </div>
                      {courseData.elevProfile&&(
                        <div>
                          <div style={{fontFamily:"monospace",fontSize:9,color:C.muted,letterSpacing:2,marginBottom:4}}>COURSE ELEVATION PROFILE</div>
                          <ElevChart data={courseData.elevProfile} color={C.gold} height={56} />
                          <div style={{display:"flex",justifyContent:"space-between",fontFamily:"monospace",fontSize:9,color:C.muted,marginTop:3}}>
                            <span>{courseData.minElevation}m</span><span>{courseData.maxElevation}m</span>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div onDragOver={function(e){e.preventDefault();setCourseDrag(true);}}
                      onDragLeave={function(){setCourseDrag(false);}}
                      onDrop={function(e){e.preventDefault();setCourseDrag(false);handleCourseFile(e.dataTransfer.files);}}
                      onClick={function(){courseRef.current.click();}}
                      style={{border:"1.5px dashed "+(courseDrag?C.gold:C.border),background:courseDrag?"rgba(255,184,48,0.04)":C.surface2,padding:"28px 20px",textAlign:"center",cursor:"pointer",transition:"all .2s"}}>
                      <div style={{fontSize:26,marginBottom:8}}>🗺️</div>
                      <div style={{fontFamily:"monospace",fontSize:12,marginBottom:4}}>코스 GPX 드래그 또는 클릭</div>
                      <div style={{fontSize:11,color:C.muted}}>대회 공홈 / Strava / Komoot GPX 가능</div>
                    </div>
                  )}
                  <input ref={courseRef} type="file" accept=".gpx,.tcx,.fit" style={{display:"none"}} onChange={function(e){handleCourseFile(e.target.files);}} />
                </div>
                {/* 추가 정보 */}
                <div style={Object.assign(cardStyle(),{marginBottom:16})}>
                  <div style={secTitle()}>// 04 · 대회 추가 정보 (선택)</div>
                  <input value={raceNote} onChange={function(e){setRaceNote(e.target.value);}} placeholder="예: TNF100 2026, 컷오프 26시간" style={inputStyle()} />
                </div>
                <div style={{fontFamily:"monospace",fontSize:11,color:C.muted,marginBottom:12}}>
                  {activities.length>0 ? "📊 "+activities.length+"개 활동 · "+totalKm+"km 누적" : <span style={{color:C.gold}}>⚠ 활동 데이터 없음 — 프로필 이론값만으로 예측</span>}
                  {(profile.ltPaceMinKm||profile.ftp)&&<span style={{color:C.accent}}> · LT/FTP 연동</span>}
                  {courseData&&<span style={{color:C.gold}}> · 코스 GPX 반영</span>}
                </div>
                {!activities.length&&!(profile.ltPaceMinKm||profile.ftp)&&(
                  <div style={{background:"rgba(255,107,53,0.08)",border:"1px solid rgba(255,107,53,0.3)",padding:"12px 16px",marginBottom:12,fontFamily:"monospace",fontSize:11,color:C.red,lineHeight:1.7}}>
                    활동 데이터와 프로필(LT/FTP) 모두 없어요. 둘 중 하나는 있어야 해요.
                  </div>
                )}
                <button onClick={runPrediction}
                  disabled={loading||(!activities.length&&!(profile.ltPaceMinKm||profile.ftp))||!getRaceKm()}
                  style={{width:"100%",padding:18,
                    background:(!loading&&getRaceKm()&&(activities.length||profile.ltPaceMinKm||profile.ftp))?C.accent:C.border,
                    color:(!loading&&getRaceKm()&&(activities.length||profile.ltPaceMinKm||profile.ftp))?C.bg:C.muted,
                    border:"none",fontFamily:"monospace",fontSize:16,fontWeight:700,letterSpacing:3,
                    cursor:(!loading&&getRaceKm()&&(activities.length||profile.ltPaceMinKm||profile.ftp))?"pointer":"not-allowed",transition:"all .2s"}}>
                  {activities.length?"대회 기록 예측 →":"이론값 기반 예측 →"}
                </button>
              </div>
            ) : (
              <div>
                <button onClick={function(){setAnalysis(null);setAiText(null);setRaceResult(null);}} style={{background:"transparent",border:"1px solid "+C.border,color:C.muted,padding:"6px 14px",cursor:"pointer",fontFamily:"monospace",fontSize:11,marginBottom:18,letterSpacing:1}}>← 다시 설정</button>
                {analysis.noActivity&&(
                  <div style={{background:"rgba(255,184,48,0.08)",border:"1px solid rgba(255,184,48,0.4)",padding:"12px 16px",marginBottom:14,fontFamily:"monospace",fontSize:11,color:C.gold,lineHeight:1.8}}>
                    ⚠ 활동 데이터 없음 — 프로필(LT/FTP) 이론값만으로 예측한 결과입니다.
                  </div>
                )}
                {analysis.courseData&&analysis.courseData.elevProfile&&(
                  <div style={Object.assign(cardStyle(),{marginBottom:14})}>
                    <div style={{fontFamily:"monospace",fontSize:9,color:C.gold,letterSpacing:2,marginBottom:5}}>
                      TARGET COURSE — {analysis.courseData.distanceKm}km / {analysis.effectiveEleGain||analysis.courseData.elevationGain}m↑
                      {analysis.effectiveEleGain&&analysis.effectiveEleGain!==analysis.courseData.elevationGain&&(
                        <span style={{color:C.muted}}> (Garmin 실측 / GPX {analysis.courseData.elevationGain}m)</span>
                      )}
                    </div>
                    <ElevChart data={analysis.courseData.elevProfile} color={C.gold} height={56} />
                    <div style={{display:"flex",justifyContent:"space-between",fontFamily:"monospace",fontSize:9,color:C.muted,marginTop:3}}>
                      <span>최저 {analysis.courseData.minElevation}m</span><span>최고 {analysis.courseData.maxElevation}m</span>
                    </div>
                  </div>
                )}
                {/* 사이클 파워존별 완주 시간 */}
                {analysis.cyclingRows&&(
                  <div style={Object.assign(cardStyle(),{marginBottom:14})}>
                    <div style={{fontFamily:"monospace",fontSize:10,color:C.blue,letterSpacing:3,marginBottom:8}}>⚡ FTP {profile.ftp}W — 구간별 물리 시뮬레이션</div>
                    <div style={{fontFamily:"monospace",fontSize:10,color:"rgba(0,229,160,0.6)",marginBottom:12,padding:"6px 10px",background:"rgba(0,229,160,0.05)",border:"1px solid rgba(0,229,160,0.15)"}}>
                      ✓ 실측검증: IF 0.68(129W) → 저수령 101km 총 소요시간 5h 44m<br />
                      ※ 총 소요시간 = 보급·정지 포함 / 이동시간 = Strava Moving Time
                    </div>
                    <div style={{display:"flex",flexDirection:"column",gap:8}}>
                      {analysis.cyclingRows.map(function(row,i){
                        var isTarget = i===1;
                        return (
                          <div key={row.label} style={{background:isTarget?"rgba(0,229,160,0.08)":C.surface2,border:"1px solid "+(isTarget?"rgba(0,229,160,0.3)":C.border),padding:"12px 16px",display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
                            <div style={{minWidth:160}}>
                              <div style={{fontFamily:"monospace",fontSize:11,color:isTarget?C.accent:C.text,fontWeight:700}}>{row.label}</div>
                              <div style={{fontFamily:"monospace",fontSize:10,color:C.muted,marginTop:2}}>{row.desc}</div>
                              <div style={{fontFamily:"monospace",fontSize:10,color:C.blue,marginTop:2}}>IF {row.if_val}</div>
                            </div>
                            <div style={{display:"flex",gap:16,flex:1,flexWrap:"wrap"}}>
                              <div><div style={{fontFamily:"monospace",fontSize:9,color:C.muted,marginBottom:2}}>출력</div><div style={{fontFamily:"monospace",fontSize:15,fontWeight:700,color:C.blue}}>{row.power}W</div></div>
                              <div><div style={{fontFamily:"monospace",fontSize:9,color:C.muted,marginBottom:2}}>평균속도</div><div style={{fontFamily:"monospace",fontSize:15,fontWeight:700,color:C.text}}>{row.movSpeed}km/h</div></div>
                              <div>
                                <div style={{fontFamily:"monospace",fontSize:9,color:C.muted,marginBottom:2}}>예상완주 (총 소요)</div>
                                <div style={{fontFamily:"monospace",fontSize:19,fontWeight:900,color:isTarget?C.accent:C.gold}}>{row.time}</div>
                                <div style={{fontFamily:"monospace",fontSize:9,color:C.muted,marginTop:2}}>이동시간: {row.movTime}</div>
                              </div>
                            </div>
                            {isTarget&&<div style={{fontFamily:"monospace",fontSize:9,color:C.accent,border:"1px solid "+C.accent,padding:"2px 8px"}}>추천</div>}
                          </div>
                        );
                      })}
                    </div>
                    <div style={{fontFamily:"monospace",fontSize:10,color:C.muted,marginTop:10,lineHeight:1.7}}>
                      ※ 코스 GPX 구간별 경사도 × 파워 물리 시뮬레이션. 바람·노면·컨디션에 따라 ±10~15% 차이 가능.
                    </div>
                  </div>
                )}
                {/* 훈련 데이터 요약 */}
                {analysis.trainingSummary&&(
                  <div style={Object.assign(cardStyle(),{marginBottom:10,borderLeft:"3px solid "+C.accent})}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                      <div style={{fontFamily:"monospace",fontSize:10,color:C.accent,letterSpacing:2}}>📊 훈련 데이터 반영됨</div>
                      <div style={{fontFamily:"monospace",fontSize:9,color:C.muted}}>
                        피트니스 창: <span style={{color:C.accent}}>{analysis.trainingSummary.fitnessWindow}</span>
                        {analysis.trainingSummary.condLabel&&(
                          <span> · 컨디션: <span style={{color:analysis.trainingSummary.condLabel==="컨디션 양호"?C.accent:analysis.trainingSummary.condLabel==="피로 축적"?C.red:C.muted}}>{analysis.trainingSummary.condLabel}</span></span>
                        )}
                      </div>
                    </div>
                    <div style={{display:"flex",gap:16,flexWrap:"wrap",fontFamily:"monospace",fontSize:11}}>
                      {[
                        ["활동(창내)", analysis.trainingSummary.count+"개"],
                        ["총 거리", analysis.trainingSummary.totalKm+"km"],
                        ["주간 볼륨", analysis.trainingSummary.weeklyKm+"km/주"],
                        ["최장 거리", analysis.trainingSummary.maxDist+"km"],
                        ...(analysis.trainingSummary.isCycling ? [
                          ...(analysis.trainingSummary.avgPower ? [["평균 파워", analysis.trainingSummary.avgPower]] : []),
                          ...(analysis.trainingSummary.avgSpeed ? [["평균 속도", analysis.trainingSummary.avgSpeed]] : []),
                        ] : [
                          ...(analysis.trainingSummary.longPace ? [["장거리 페이스", analysis.trainingSummary.longPace]] :
                              analysis.trainingSummary.avgPace ? [["평균 페이스", analysis.trainingSummary.avgPace]] : []),
                        ]),
                      ].map(function(item){
                        return (
                          <span key={item[0]}>
                            <span style={{color:C.muted}}>{item[0]}: </span>
                            <span style={{color:C.text,fontWeight:700}}>{item[1]}</span>
                          </span>
                        );
                      })}
                    </div>
                    {/* 크로스트레이닝 반영 표시 */}
                    {analysis.trainingSummary.crossCount > 0 && (
                      <div style={{marginTop:8,fontFamily:"monospace",fontSize:10,color:"rgba(77,159,255,0.8)",background:"rgba(77,159,255,0.06)",border:"1px solid rgba(77,159,255,0.2)",padding:"5px 10px",lineHeight:1.6}}>
                        🔄 크로스트레이닝 반영: {analysis.trainingSummary.crossCount}개 활동
                        {analysis.trainingSummary.crossKmEquiv && " · 유산소 환산 "+analysis.trainingSummary.crossKmEquiv+"km"}
                        <br />
                        <span style={{color:C.muted}}>
                          {analysis.trainingSummary.isCycling
                            ? "러닝 훈련 심폐 기여 반영 — 페달링 효율은 미적용"
                            : analysis.sport==="road_run"
                              ? "트레일런 심폐 기여 85% + 사이클 25% 반영 — 페이스 기준은 로드런만"
                              : "로드런 심폐 기여 85% + 사이클 25% 반영 — 페이스 기준은 트레일런만"}
                        </span>
                      </div>
                    )}
                  </div>
                )}
                {/* 러닝 예측 */}
                {analysis.runningRows&&(
                  <div style={Object.assign(cardStyle(),{marginBottom:14})}>
                    <div style={{fontFamily:"monospace",fontSize:10,color:C.accent,letterSpacing:3,marginBottom:12}}>
                      🏃 완주 시간 예측
                      {analysis.trainingSummary ? <span style={{color:C.muted,fontWeight:400}}> — 훈련 데이터 {analysis.trainingSummary.count}개 반영</span>
                        : <span style={{color:C.gold,fontWeight:400}}> — LT 이론값만</span>}
                    </div>
                    <div style={{display:"flex",flexDirection:"column",gap:8}}>
                      {analysis.runningRows.map(function(row){
                        var isTarget = row.isRecommended;
                        return (
                          <div key={row.label} style={{background:isTarget?"rgba(0,229,160,0.08)":C.surface2,border:"1px solid "+(isTarget?"rgba(0,229,160,0.3)":C.border),padding:"12px 16px",display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
                            <div style={{flex:1}}>
                              <div style={{fontFamily:"monospace",fontSize:11,color:isTarget?C.accent:C.text,fontWeight:700}}>{row.label}</div>
                              <div style={{fontFamily:"monospace",fontSize:10,color:C.muted,marginTop:2}}>{row.desc}</div>
                            </div>
                            <div style={{display:"flex",gap:16}}>
                              <div><div style={{fontFamily:"monospace",fontSize:9,color:C.muted,marginBottom:2}}>페이스</div><div style={{fontFamily:"monospace",fontSize:15,fontWeight:700,color:C.blue}}>{row.pace}</div></div>
                              <div><div style={{fontFamily:"monospace",fontSize:9,color:C.muted,marginBottom:2}}>예상완주</div><div style={{fontFamily:"monospace",fontSize:19,fontWeight:900,color:isTarget?C.accent:C.gold}}>{row.time}</div></div>
                            </div>
                            {isTarget&&<div style={{fontFamily:"monospace",fontSize:9,color:C.accent,border:"1px solid "+C.accent,padding:"2px 8px"}}>추천</div>}
                          </div>
                        );
                      })}
                    </div>
                    {analysis.sport==="trail_run"&&(
                      <div style={{marginTop:12,background:"rgba(255,184,48,0.05)",border:"1px solid rgba(255,184,48,0.2)",padding:"10px 14px"}}>
                        <div style={{fontFamily:"monospace",fontSize:10,color:C.gold,marginBottom:6,letterSpacing:1}}>⚠ 트레일런 예측 한계</div>
                        <div style={{fontFamily:"monospace",fontSize:10,color:C.muted,lineHeight:1.9}}>
                          코스 GPX 경사 × Minetti 트레일 공식으로 보정한 수치예요.<br />
                          아래 요소로 실제가 더 걸릴 수 있어요<br />
                          <span style={{color:"#3a4560"}}>· 너덜·바위·진흙 등 노면 불량</span><br />
                          <span style={{color:"#3a4560"}}>· 로프·핸드레일 구간 감속</span><br />
                          <span style={{color:"#3a4560"}}>· 급경사 오르막 걷기 전환</span><br />
                          <span style={{color:"#3a4560"}}>· 출발 혼잡·보급소 대기</span><br />
                          <span style={{color:C.gold}}>→ 코스 난이도에 따라 예측보다 20~50% 더 걸릴 수 있어요.</span>
                        </div>
                      </div>
                    )}
                  </div>
                )}
                <div style={Object.assign(cardStyle(),{marginBottom:14,padding:"14px 16px"})}>
                  <div style={{fontFamily:"monospace",fontSize:11,color:C.muted,lineHeight:1.8}}>
                    ※ 위 수치는 코스 GPX 구간별 경사도 × 파워 물리 시뮬레이션 결과예요.<br />
                    실제 훈련 GPX (파워미터 포함)가 쌓일수록 IF 추정이 더 정확해집니다.<br />
                    <span style={{color:C.gold}}>실측 검증: FTP 190W / IF 0.68 → 저수령 101km 실제 5h 44m</span>
                  </div>
                </div>

                {/* ── 대회 결과 비교 분석 */}
                <div style={Object.assign(cardStyle(),{marginBottom:14,borderLeft:"3px solid "+C.red})}>
                  <div style={secTitle(C.red)}>🏁 대회 결과 비교 분석</div>
                  <div style={{fontFamily:"monospace",fontSize:11,color:C.muted,marginBottom:14,lineHeight:1.7}}>
                    대회 완주 후 Garmin Connect에서 GPX를 내보내서 올려주세요.<br />
                    예측 vs 실제를 비교해서 부족한 부분과 훈련 방향을 알려드려요.
                  </div>

                  {!raceResult ? (
                    <div>
                      <div onDragOver={function(e){e.preventDefault();setRaceResultDrag(true);}}
                        onDragLeave={function(){setRaceResultDrag(false);}}
                        onDrop={function(e){
                          e.preventDefault(); setRaceResultDrag(false);
                          var file = Array.from(e.dataTransfer.files).find(function(f){return /\.gpx$/i.test(f.name);});
                          if (!file) { showToast("GPX 파일을 올려주세요","error"); return; }
                          file.text().then(function(txt){
                            var result = analyzeRaceResult(txt, analysis.raceKm);
                            if (!result) { showToast("GPX 파싱 실패","error"); return; }
                            setRaceResult(result); showToast("대회 결과 분석 완료 ✓");
                          });
                        }}
                        onClick={function(){raceResultRef.current.click();}}
                        style={{border:"1.5px dashed "+(raceResultDrag?C.red:C.border),background:raceResultDrag?"rgba(255,107,53,0.04)":C.surface2,padding:"28px 20px",textAlign:"center",cursor:"pointer",transition:"all .2s"}}>
                        <div style={{fontSize:26,marginBottom:8}}>🏅</div>
                        <div style={{fontFamily:"monospace",fontSize:12,marginBottom:4}}>대회 완주 GPX 업로드</div>
                        <div style={{fontSize:11,color:C.muted}}>Garmin Connect → 활동 → 내보내기</div>
                      </div>
                      <input ref={raceResultRef} type="file" accept=".gpx" style={{display:"none"}}
                        onChange={function(e){
                          var file = e.target.files[0]; if (!file) return;
                          file.text().then(function(txt){
                            var result = analyzeRaceResult(txt, analysis.raceKm);
                            if (!result) { showToast("GPX 파싱 실패","error"); return; }
                            setRaceResult(result); showToast("대회 결과 분석 완료 ✓");
                          });
                        }} />
                    </div>
                  ) : (
                    <div>
                      <div style={{display:"flex",justifyContent:"flex-end",marginBottom:10}}>
                        <button onClick={function(){setRaceResult(null);}} style={{background:"transparent",border:"1px solid "+C.border,color:C.muted,padding:"4px 10px",cursor:"pointer",fontFamily:"monospace",fontSize:10}}>다시 업로드</button>
                      </div>

                      {/* 예측 vs 실제 수치 비교 */}
                      {(function(){
                        // 추천 존 예측 시간 (index 1 = 추천)
                        var predTime = null;
                        if (analysis.cyclingRows) {
                          predTime = analysis.cyclingRows[1].time; // 총 소요시간 기준
                        } else if (analysis.runningRows) {
                          var recRow = analysis.runningRows.find(function(r){return r.isRecommended;});
                          predTime = recRow ? recRow.time : (analysis.runningRows[0] ? analysis.runningRows[0].time : null);
                        }
                        var predMin = 0;
                        if (analysis.cyclingRows) {
                          predMin = Math.round(analysis.cyclingRows[1].timeHours * 60); // timeHours = 총 소요시간
                        } else if (analysis.runningRows) {
                          var recRow2 = analysis.runningRows.find(function(r){return r.isRecommended;});
                          if (recRow2 && recRow2.time) {
                            var tp = recRow2.time.match(/(\d+)h\s*(\d+)m/);
                            if (tp) predMin = parseInt(tp[1])*60 + parseInt(tp[2]);
                          }
                        }
                        var diffMin = raceResult.durationMin - predMin;
                        var diffSign = diffMin > 0 ? "+" : "";
                        var diffColor = Math.abs(diffMin) <= 15 ? C.accent : Math.abs(diffMin) <= 30 ? C.gold : C.red;

                        // 붕괴 분석
                        var isCycling = (analysis.sport==="cycling"||analysis.sport==="mtb");
                        var paceCollapse = isCycling ? raceResult.spdDegradePct > 8 : raceResult.paceDegradePct > 8;
                        var midCollapse  = isCycling ? raceResult.spdMidDegPct > 8  : raceResult.paceMidDegPct > 8;
                        var powerCollapse = raceResult.hasPower && raceResult.pwrDegradePct > 10;
                        var hrSpike = raceResult.avgHR && profile.ltHR && raceResult.avgHR > parseFloat(profile.ltHR)*1.05;


                        // ── 전문 코치 수준 훈련 처방 생성
                        var prescriptions = [];
                        var isTrailRace = (analysis.sport==="trail_run");

                        // ① 후반 페이스/파워 붕괴
                        if (paceCollapse || powerCollapse) {
                          var degradePctVal = isCycling ? Math.abs(raceResult.spdDegradePct) : Math.abs(raceResult.paceDegradePct);
                          prescriptions.push({
                            issue: raceResult.lateStartKm+"km~ 후반 "+(isCycling?"속도":"페이스")+" 저하 "+degradePctVal.toFixed(0)+"%",
                            cause: "유산소 기저(Aerobic Base) 부족 또는 초반 오버페이스.\n후반 붕괴의 주요 원인은 미토콘드리아 밀도와 지방 산화 능력이 충분히 발달하지 않은 상태에서 레이스 초반 무산소 에너지 시스템에 과의존하는 것입니다.",
                            training: isCycling
                              ? "【핵심 처방】 Z2 유산소 기반 강화\n• 주 2~3회 Z2 라이딩 90~120분 (FTP 56~75%, 대화 가능 강도)\n• 6~8주간 주간 볼륨 점진적으로 10~15%씩 증가\n\n【보조 처방】 Sweet Spot 근지구력\n• 주 1~2회 FTP×88~93% 구간 2×20분 (휴식 5분)\n• Z2보다 시간 대비 효율 높아 바쁜 일정에 적합\n\n【페이싱 전략 수정】\n• 첫 20~30%는 목표 IF보다 3~5% 낮게 시작\n• 파워미터 있으면 구간별 목표 와트 사전 설정 후 초과 금지"
                              : isTrailRace
                                ? "【핵심 처방】 유산소 기저 + 트레일 특이적 훈련\n• 주 3회 이상 Z2 장거리런 (LT1 이하, 대화 가능 수준)\n• 히켓(Hill Repeat): 100~200m 급경사 × 8~10회 주 1회\n  (후방 사슬 햄스트링·둔근 강화로 오르막 효율 향상)\n• 내리막 훈련: 주 1회 장거리런 중 급경사 내리막 구간 포함\n  (대퇴사두근 편심 수축 적응으로 후반 내리막 속도 유지)\n\n【근력 보강】 주 2회\n• 스쿼트·런지·데드리프트 (오르막 근지구력)\n• 박스 스텝다운·싱글레그 스쿼트 (내리막 충격 흡수)\n\n【레이싱 전략】\n• RPE 기반 페이싱: 오르막은 체감 강도 우선, 심박 후순위\n• 경사 25% 이상 구간은 걷기 전환이 에너지 효율적\n• 보급: 45~60분마다 탄수화물 30~60g + 전해질 필수"
                                : "【핵심 처방】 Z2 유산소 기반 (6~8주)\n• 주 3회 이상 Z2 페이스런 (LT 페이스 × 1.3~1.5, 대화 가능)\n• 목표 거리의 70~80% 이상 롱런 주 1회 확보\n\n【보조 처방】 LT 개선 템포런\n• 주 1회 LT 페이스 × 1.05~1.10 강도로 20~30분\n• 또는 크루즈 인터벌: LT 페이스 × 1.05로 4×10분 (휴식 2분)\n\n【레이싱 전략 수정】\n• 목표 페이스보다 첫 5km를 5~8% 느리게 시작 (Negative Split)\n• 호흡이 편한 강도를 중반까지 유지",
                            color: C.red,
                          });
                        }

                        // ② 중반 저하 후 회복
                        if (midCollapse && !paceCollapse) {
                          var midDegPct = isCycling ? raceResult.spdMidDegPct : raceResult.paceMidDegPct;
                          prescriptions.push({
                            issue: raceResult.earlyDistKm+"~"+raceResult.midEndKm+"km 중반 저하 "+Math.abs(midDegPct).toFixed(0)+"% — 후반 회복",
                            cause: "중반 특정 구간(급경사 연속 또는 기후·노면 변화)에서 과도한 에너지 소비 또는 보급 타이밍 실패. 후반 회복은 에너지 보충 후 글리코겐 재공급이 이뤄진 것으로 볼 수 있습니다.",
                            training: isCycling
                              ? "【에너지 전략 개선】\n• 보급 주기: 45~60분마다 탄수화물 30~60g (젤·바·음료)\n• 중반 고강도 구간 진입 5~10분 전 사전 보급\n• 훈련 시 실제 레이스 보급 루틴 그대로 연습할 것\n\n【코스 분석 훈련】\n• 해당 중반 구간과 유사한 경사·길이의 클라이밍 반복 훈련\n• 어려운 오르막은 FTP×70~80%로 출력 제한 — 후반 여력 확보"
                              : "【에너지·페이싱 전략】\n• 보급: 30~45분마다 탄수화물 보충 (젤 또는 음료)\n• 어려운 중반 구간 진입 전 페이스를 5~10% 의도적으로 늦추기\n\n【훈련 처방】\n• 백투백 런: 2일 연속 장거리런으로 피로 상태 페이싱 적응\n• 히켓 인터벌 주 1회로 중반 오르막 특이적 근지구력 강화",
                            color: C.gold,
                          });
                        }

                        // ③ 심박 LTHR 초과
                        if (hrSpike) {
                          prescriptions.push({
                            issue: "평균 심박 LTHR 초과 ("+raceResult.avgHR+"bpm vs LTHR "+profile.ltHR+"bpm)",
                            cause: "레이스 전반에 걸쳐 무산소 역치(LT2) 이상 강도로 운동한 것을 의미합니다. 심폐 여유(Cardiac Reserve)가 부족하거나 LT2 강도가 낮게 설정되어 있을 수 있습니다.",
                            training: "【LT2 역치 상향 훈련】\n• VO2max 인터벌: 4~5분 × 4~5세트, VO2max 95~100% 강도\n  (1:1 운동:휴식 비율, 주 1~2회)\n• 역치런: LT2 페이스 × 1.0~1.05, 20~30분 주 1회\n• Z2 볼륨 증가로 미토콘드리아 밀도 향상 → LT2 자연 상승\n\n【레이싱 조언】\n• 출발 후 20분은 목표 심박보다 5~10bpm 낮게 유지\n• 오르막에서 심박이 LTHR 초과하면 즉시 페이스 낮추기",
                            color: C.gold,
                          });
                        }

                        // ④ 전반적 출력 부족
                        if (!paceCollapse && !powerCollapse && diffMin > 20) {
                          prescriptions.push({
                            issue: "예측 대비 "+diffMin+"분 초과 — 전반적 출력 부족",
                            cause: isCycling
                              ? "FTP 대비 실제 레이스 지속 출력(IF)이 낮습니다. 근지구력 부족 또는 코스 실제 난이도가 예측보다 높을 수 있습니다."
                              : "LT 기반 예측 페이스와 실제 레이스 출력 사이 갭이 큽니다. 유산소 역치(LT)가 레이스 강도를 지탱하기에 아직 충분하지 않거나, 훈련-레이스 강도 전환이 익숙하지 않을 수 있습니다.",
                            training: isCycling
                              ? "【FTP 향상 핵심 처방】\n• Sweet Spot 2×20분, 주 2회 (FTP×88~93%)\n  단기 FTP 향상에 시간 대비 가장 효율적\n• Z2 장거리 라이딩 주 1회 (2~3시간) — 지방 산화 능력 강화\n\n【코스 재검토】\n• Garmin 측정 실제 고도로 예측 탭 재시뮬레이션\n• 바람·기온·그룹 이탈 등 변수 고려 (물리 시뮬은 이상 조건 기준)"
                              : "【LT 역치 훈련 강화】\n• LT 템포런: LT 페이스 × 1.05~1.10, 20~40분 지속, 주 1~2회\n• 크루즈 인터벌: LT 페이스 × 1.05로 3~5× 8~12분 (휴식 2분)\n\n【레이스 강도 적응】\n• 목표 레이스 페이스로 5~10km 구간 주 1회 달리기\n  (훈련에서 레이스 강도 경험 부족이 실전 출력 저하의 흔한 원인)",
                            color: C.gold,
                          });
                        }

                        // ⑤ IF 부족 (파워 데이터 있을 때)
                        if (raceResult.hasPower && raceResult.avgPower && profile.ftp) {
                          var actualIF = +(raceResult.avgPower/parseFloat(profile.ftp)).toFixed(2);
                          var targetIF = analysis.cyclingRows ? analysis.cyclingRows[1].if_val : "0.68";
                          if (actualIF < parseFloat(targetIF) - 0.05) {
                            prescriptions.push({
                              issue: "실제 IF "+actualIF+" < 목표 IF "+targetIF+" (파워 "+Math.round((parseFloat(targetIF)-actualIF)*parseFloat(profile.ftp))+"W 부족)",
                              cause: "레이스 내내 목표 출력을 유지하지 못했습니다. 근지구력(Muscular Endurance) 부족 또는 FTP가 실제보다 높게 측정되었을 가능성이 있습니다.",
                              training: "【근지구력 향상 처방】\n• Sweet Spot 2×20분 주 2회 (FTP×88~93%)\n  FTP 직하단 강도로 근섬유 산화 능력과 젖산 완충 능력 동시 향상\n• 오버언더 인터벌: FTP×95% 4분 → FTP×105% 1분 × 4~6세트\n  역치 전환 능력 강화\n\n【근력 훈련 병행】 주 1~2회\n• 스쿼트·레그프레스 (사이클링 주동근 강화)\n• 3~5주 후 FTP 재측정 권장 (20분 테스트 또는 Ramp Test)",
                              color: C.blue,
                            });
                          }
                        }

                        // ⑥ 잘한 레이스
                        if (!paceCollapse && !powerCollapse && !hrSpike && Math.abs(diffMin) <= 20) {
                          prescriptions.push({
                            issue: "예측 대비 편차 ±"+Math.abs(diffMin)+"분 — 레이싱 전략 적절",
                            cause: "현재 훈련 수준과 레이싱 전략이 잘 맞아 있습니다. 이 시점에서는 강도를 급격히 올리기보다 볼륨을 점진적으로 늘리는 것이 더 안전하고 효과적입니다.",
                            training: "【현재 방향 유지 + 점진적 과부하】\n• 주간 볼륨 매 2~3주마다 10~15%씩 증가, 4주마다 1주 회복 주\n• 강도 분배: Z2 80% + 역치/인터벌 20% 유지 (Polarized 모델)\n\n【다음 단계 목표 설정】\n• 목표 대회 거리 15~20% 늘리거나\n• 현재 종목 목표 기록을 3~5% 단축하는 새 목표 설정\n• 스트렝스 트레이닝 추가로 부상 예방 및 경제성 향상",
                            color: C.accent,
                          });
                        }
                        return (
                          <div>
                            {/* 수치 비교표 */}
                            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:16}}>
                              {[
                                ["예측 완주 (추천)", predTime||"—", C.muted],
                                ["실제 완주", raceResult.durationHM, C.accent],
                                ["예측 대비", diffMin!==0?(diffSign+diffMin+"분"):"일치", diffColor],
                                ["실제 평균속도", raceResult.avgSpeedKmh+"km/h", C.text],
                                ...(raceResult.avgHR?[["평균 심박", raceResult.avgHR+"bpm", C.red]]:[]),
                                ...(raceResult.avgPower?[["평균 파워", raceResult.avgPower+"W (IF "+(+(raceResult.avgPower/parseFloat(profile.ftp||190)).toFixed(2))+")", C.blue]]:[]),
                                ...(isCycling
                                  ? (raceResult.hasPower
                                      ? [
                                          ["초반 "+raceResult.earlyDistKm+"km 파워", raceResult.avgPwrFirst+"W", C.text],
                                          ["중반 "+raceResult.midEndKm+"km 파워", raceResult.avgPwrMid+"W", Math.abs(raceResult.pwrDegradePct)>10&&raceResult.avgPwrFirst>raceResult.avgPwrMid?C.gold:C.text],
                                          ["후반 "+raceResult.lateStartKm+"km~ 파워", raceResult.avgPwrLast+"W", raceResult.pwrDegradePct>10?C.red:C.accent],
                                        ]
                                      : [
                                          ["초반 "+raceResult.earlyDistKm+"km 평속", raceResult.avgSpdFirst+"km/h", C.text],
                                          ["중반 "+raceResult.midEndKm+"km 평속", raceResult.avgSpdMid+"km/h", raceResult.spdMidDegPct>8?C.gold:C.text],
                                          ["후반 "+raceResult.lateStartKm+"km~ 평속", raceResult.avgSpdLast+"km/h", raceResult.spdDegradePct>8?C.red:C.accent],
                                        ])
                                  : [
                                      ["초반 "+raceResult.earlyDistKm+"km 페이스", formatPace(raceResult.avgPaceFirst), C.text],
                                      ["중반 "+raceResult.midEndKm+"km 페이스", formatPace(raceResult.avgPaceMid), raceResult.paceMidDegPct>8?C.gold:C.text],
                                      ["후반 "+raceResult.lateStartKm+"km~ 페이스", formatPace(raceResult.avgPaceLast), raceResult.paceDegradePct>8?C.red:C.accent],
                                    ]
                                ),
                              ].map(function(item){
                                return (
                                  <div key={item[0]} style={{background:C.surface2,padding:"10px 12px"}}>
                                    <div style={{fontFamily:"monospace",fontSize:9,color:C.muted,marginBottom:3}}>{item[0]}</div>
                                    <div style={{fontFamily:"monospace",fontSize:13,fontWeight:700,color:item[2]}}>{item[1]}</div>
                                  </div>
                                );
                              })}
                            </div>

                            {/* 코스 고도 + 페이스 저하 구간 오버레이 */}
                            {raceResult.segments && raceResult.segments.length > 1 && (function(){
                              var segs = raceResult.segments;
                              var n = segs.length;
                              var totalDist = raceResult.distKm;
                              var actualVals = isCycling
                                ? segs.map(function(s){return s.speedKmh||0;})
                                : segs.map(function(s){return s.paceMinKm||0;});
                              var validVals = actualVals.filter(function(v){return v>0;});
                              if (!validVals.length) return null;
                              var elevProf = analysis.courseData ? analysis.courseData.elevProfile : null;
                              if (!elevProf || elevProf.length < 2) return null;

                              // 전반 기준선
                              var firstVals = actualVals.slice(0, Math.floor(n*0.4)).filter(function(v){return v>0;});
                              var baselineVal = firstVals.length
                                ? firstVals.reduce(function(a,b){return a+b;},0)/firstVals.length
                                : validVals.reduce(function(a,b){return a+b;},0)/validVals.length;

                              // 경사 보정
                              var isTrail = (analysis.sport === "trail_run");
                              // 그란폰도: 내리막 40km/h 제한 있음 → 내리막에서 빨라지는 기대를 제한
                              var isGranfondo = isCycling && analysis.raceKm >= 60;

                              function gradeAdjFactor(g) {
                                var s = Math.max(-0.30, Math.min(0.30, g));
                                if (!isTrail) {
                                  // 로드런: Minetti 공식 그대로
                                  return (155.4*Math.pow(s,5)-30.4*Math.pow(s,4)-43.3*Math.pow(s,3)+46.3*Math.pow(s,2)+19.5*s+3.6)/3.6;
                                } else {
                                  // 트레일런: 내리막 가속 효과 최소화
                                  if (s >= 0) {
                                    return (155.4*Math.pow(s,5)-30.4*Math.pow(s,4)-43.3*Math.pow(s,3)+46.3*Math.pow(s,2)+19.5*s+3.6)/3.6;
                                  } else {
                                    if (s < -0.10) return 1.05;
                                    if (s < -0.05) return 1.0;
                                    var roadFactor = (155.4*Math.pow(s,5)-30.4*Math.pow(s,4)-43.3*Math.pow(s,3)+46.3*Math.pow(s,2)+19.5*s+3.6)/3.6;
                                    return 1.0 + (roadFactor - 1.0) * 0.30;
                                  }
                                }
                              }

                              var segGrades = segs.map(function(s,i){
                                var i0=Math.round((i/n)*(elevProf.length-1));
                                var i1=Math.min(Math.round(((i+1)/n)*(elevProf.length-1)),elevProf.length-1);
                                // 시작~끝 고도차만 보면 고개 정상 부근에서 오류 발생
                                // → 구간 내 최고점/최저점 기준으로 실제 특성 판단
                                var sub = elevProf.slice(i0, i1+1);
                                if (!sub.length) return 0;
                                var elePeak = Math.max.apply(null, sub);
                                var eleVall = Math.min.apply(null, sub);
                                var eleStart = sub[0], eleEnd = sub[sub.length-1];
                                var segDistM = Math.max(s.distKm*1000, 200);
                                // 오르막 판단: 끝이 시작보다 높고, 상승이 하강보다 많을 때
                                var up = 0, dn = 0;
                                for (var ei3=1; ei3<sub.length; ei3++) {
                                  var dd = sub[ei3]-sub[ei3-1];
                                  if (dd>0.5) up+=dd; else if(dd<-0.5) dn+=Math.abs(dd);
                                }
                                // 순 고도차 기반 경사
                                return (eleEnd-eleStart)/segDistM;
                              });

                              // 구간별 기대 속도/페이스 계산
                              var gradeAdjExpected = segs.map(function(s,i){
                                if (!isCycling) return baselineVal * gradeAdjFactor(segGrades[i]);

                                var grade = segGrades[i];

                                // 구간 내 오르막/내리막 실제 비율
                                var ep0 = Math.round(i/n*(elevProf.length-1));
                                var ep1 = Math.min(Math.round((i+1)/n*(elevProf.length-1)), elevProf.length-1);
                                var sub2 = elevProf.slice(ep0, ep1+1);
                                var climbM = 0, descentM = 0;
                                for (var ei2=1; ei2<sub2.length; ei2++) {
                                  var dd2 = sub2[ei2]-sub2[ei2-1];
                                  if (dd2>0.5) climbM+=dd2; else if(dd2<-0.5) descentM+=Math.abs(dd2);
                                }
                                var totalElev = climbM + descentM;
                                var climbRatio = totalElev > 0 ? climbM/totalElev : 0.5;

                                // 고개 정상 직후 감지: 이전 2구간이 오르막
                                var prevUp1 = i>0 && segGrades[i-1]>0.02;
                                var prevUp2 = i>1 && segGrades[i-2]>0.02;
                                var nearSummit = prevUp1 || prevUp2;

                                // 오르막 구간
                                if (grade > 0.02) {
                                  return Math.max(baselineVal*(1-grade*15), 5);
                                }

                                // 내리막/혼합 구간
                                // 고개 정상 직후이거나 오르막 35% 이상 섞인 구간 → 헤어핀 감속 구간
                                if (nearSummit || climbRatio > 0.35) {
                                  return baselineVal * 1.05;
                                }
                                if (grade < -0.02) {
                                  // 순수 내리막: 완만한 가속, 그란폰도 38km/h 상한
                                  var coast = baselineVal*(1+Math.abs(grade)*2);
                                  if (isGranfondo) return Math.min(coast, 38);
                                  return Math.min(coast, 50);
                                }

                                return baselineVal;
                              });

                              // 저하 감지 임계값: 트레일은 더 관대하게 (노면 변화 많음)
                              var threshold = isTrail ? 0.12 : 0.07;
                              var bigThreshold = isTrail ? 0.20 : 0.15;

                              var degradeSegs = actualVals.map(function(v,i){
                                if (i < n*0.20 || !v) return false;
                                var exp = gradeAdjExpected[i];
                                var worse = isCycling ? (v<exp*(1-threshold)) : (v>exp*(1+threshold));
                                if (!worse) return false;
                                var bigDiff = isCycling ? (v<exp*(1-bigThreshold)) : (v>exp*(1+bigThreshold));
                                var prev = i>0 && (isCycling?(actualVals[i-1]<gradeAdjExpected[i-1]*(1-threshold)):(actualVals[i-1]>gradeAdjExpected[i-1]*(1+threshold)));
                                var next = i<n-1 && (isCycling?(actualVals[i+1]<gradeAdjExpected[i+1]*(1-threshold)):(actualVals[i+1]>gradeAdjExpected[i+1]*(1+threshold)));
                                return bigDiff || prev || next;
                              });

                              // SVG
                              var W=380, H=100, PAD_L=26, PAD_R=6, PAD_T=4, PAD_B=16;
                              var chartW=W-PAD_L-PAD_R, chartH=H-PAD_T-PAD_B;
                              var elevMin=Math.min.apply(null,elevProf), elevMax=Math.max.apply(null,elevProf);
                              var elevRange=elevMax-elevMin||1;
                              var elevPts=elevProf.map(function(e,ei){
                                return (PAD_L+(ei/(elevProf.length-1))*chartW)+","+(PAD_T+chartH-((e-elevMin)/elevRange)*chartH);
                              }).join(" ");
                              function segX0(i){return PAD_L+((i>0?segs[i-1].cumDistKm:0)/totalDist)*chartW;}
                              function segX1(i){return PAD_L+((segs[i]?segs[i].cumDistKm:totalDist)/totalDist)*chartW;}

                              // 저하 구간 범위 + 실제vs기대 수치
                              var degradeRanges=[];
                              var inR=false, rStart=-1;
                              for (var di=0;di<=n;di++){
                                if (di<n && degradeSegs[di]){if(!inR){inR=true;rStart=di;}}
                                else if(inR){
                                  var sk=rStart>0?segs[rStart-1].cumDistKm:0;
                                  var ek=segs[di-1]?segs[di-1].cumDistKm:totalDist;
                                  var mx=0, sumActual=0, sumExp=0, cnt=0;
                                  for(var dj=rStart;dj<di;dj++){
                                    var df=isCycling?(gradeAdjExpected[dj]-actualVals[dj])/gradeAdjExpected[dj]*100:(actualVals[dj]-gradeAdjExpected[dj])/gradeAdjExpected[dj]*100;
                                    if(df>mx)mx=df;
                                    if(actualVals[dj]>0){sumActual+=actualVals[dj];sumExp+=gradeAdjExpected[dj];cnt++;}
                                  }
                                  var avgActual=cnt?sumActual/cnt:0;
                                  var avgExp=cnt?sumExp/cnt:0;
                                  var actualStr = isCycling
                                    ? (avgActual>0?avgActual.toFixed(1)+"km/h":"—")
                                    : (avgActual>0?(Math.floor(avgActual)+"'"+String(Math.round((avgActual%1)*60)).padStart(2,"0")+'"'):"—");
                                  var expStr = isCycling
                                    ? (avgExp>0?avgExp.toFixed(1)+"km/h":"—")
                                    : (avgExp>0?(Math.floor(avgExp)+"'"+String(Math.round((avgExp%1)*60)).padStart(2,"0")+'"'):"—");
                                  degradeRanges.push({start:sk,end:ek,diff:Math.round(mx),actualStr:actualStr,expStr:expStr});
                                  inR=false;
                                }
                              }
                              var degradeCount=degradeSegs.filter(Boolean).length;

                              return (
                                <div style={Object.assign(cardStyle(),{marginBottom:14,padding:"12px 14px"})}>
                                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                                    <div style={{fontFamily:"monospace",fontSize:10,color:C.gold,letterSpacing:1}}>코스 고도 — 페이스 저하 구간</div>
                                    <div style={{fontFamily:"monospace",fontSize:9,color:C.muted}}>경사 보정 기대 페이스 대비</div>
                                  </div>
                                  <div style={{display:"flex",gap:14,marginBottom:6}}>
                                    <div style={{display:"flex",alignItems:"center",gap:4}}>
                                      <div style={{width:14,height:8,background:"rgba(255,184,48,0.4)",border:"1px solid rgba(255,184,48,0.7)"}} />
                                      <span style={{fontFamily:"monospace",fontSize:9,color:C.muted}}>고도</span>
                                    </div>
                                    {degradeCount>0&&(
                                      <div style={{display:"flex",alignItems:"center",gap:4}}>
                                        <div style={{width:14,height:8,background:"rgba(255,107,53,0.5)",border:"1px solid "+C.red}} />
                                        <span style={{fontFamily:"monospace",fontSize:9,color:C.red}}>페이스 저하 구간</span>
                                      </div>
                                    )}
                                    {degradeCount===0&&(
                                      <div style={{fontFamily:"monospace",fontSize:9,color:C.accent}}>✓ 경사 감안 시 페이스 저하 없음</div>
                                    )}
                                  </div>
                                  <svg viewBox={"0 0 "+W+" "+H} style={{width:"100%",height:H,display:"block"}} preserveAspectRatio="none">
                                    {degradeSegs.map(function(isDeg,i){
                                      if(!isDeg) return null;
                                      var x0=segX0(i), x1=segX1(i);
                                      return <rect key={i} x={x0} y={PAD_T} width={Math.max(2,x1-x0)} height={chartH} fill="rgba(255,107,53,0.30)" />;
                                    })}
                                    <polygon points={PAD_L+","+(PAD_T+chartH)+" "+elevPts+" "+(PAD_L+chartW)+","+(PAD_T+chartH)} fill="rgba(255,184,48,0.22)" />
                                    <polyline points={elevPts} fill="none" stroke={C.gold} strokeWidth="1.5" />
                                    {degradeSegs.map(function(isDeg,i){
                                      if(!isDeg) return null;
                                      var x0=segX0(i), x1=segX1(i);
                                      var ps=i===0||!degradeSegs[i-1], pe=i===n-1||!degradeSegs[i+1];
                                      return [
                                        ps?<line key={i+"s"} x1={x0} y1={PAD_T} x2={x0} y2={PAD_T+chartH} stroke={C.red} strokeWidth="1.5" opacity="0.8"/>:null,
                                        pe?<line key={i+"e"} x1={x1} y1={PAD_T} x2={x1} y2={PAD_T+chartH} stroke={C.red} strokeWidth="1.5" opacity="0.8"/>:null,
                                      ];
                                    })}
                                    {[elevMin,(elevMin+elevMax)/2,elevMax].map(function(v,i){
                                      return <text key={i} x={PAD_L-3} y={PAD_T+chartH-(i/2)*chartH+3} textAnchor="end" fontSize="8" fill={C.muted} opacity="0.8">{Math.round(v)+"m"}</text>;
                                    })}
                                    {[0,0.25,0.5,0.75,1.0].map(function(r,i){
                                      return <text key={i} x={PAD_L+r*chartW} y={H-1} textAnchor="middle" fontSize="8" fill={C.muted} opacity="0.7">{Math.round(r*totalDist)+"km"}</text>;
                                    })}
                                  </svg>
                                  {degradeRanges.length>0&&(
                                    <div style={{marginTop:8,display:"flex",flexDirection:"column",gap:4}}>
                                      {degradeRanges.map(function(r,i){
                                        return (
                                          <div key={i} style={{fontFamily:"monospace",fontSize:10,color:C.red,background:"rgba(255,107,53,0.08)",padding:"6px 10px",border:"1px solid rgba(255,107,53,0.3)"}}>
                                            <div>⚠ {r.start.toFixed(1)}km ~ {r.end.toFixed(1)}km — 기대 대비 최대 {r.diff}% {isCycling?"감속":"페이스 저하"}</div>
                                            {r.actualStr&&r.expStr&&(
                                              <div style={{marginTop:3,color:C.muted}}>
                                                구간 실제 {r.actualStr} vs 기대 {r.expStr}
                                                {" (차이: "+(isCycling?(+(parseFloat(r.expStr)-parseFloat(r.actualStr)).toFixed(1))+"km/h 부족":(r.actualStr+" vs "+r.expStr))+")"}
                                              </div>
                                            )}
                                          </div>
                                        );
                                      })}
                                      {isTrail&&(
                                        <div style={{fontFamily:"monospace",fontSize:9,color:C.muted,marginTop:2,lineHeight:1.5}}>
                                          ※ 트레일런 기준 — 내리막 가속 효과 최소화, 임계값 ±12%
                                        </div>
                                      )}
                                      {isGranfondo&&(
                                        <div style={{fontFamily:"monospace",fontSize:9,color:C.muted,marginTop:2,lineHeight:1.5}}>
                                          ※ 그란폰도 기준 — 내리막 40km/h 제한 적용, 임계값 ±7%
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              );
                            })()}

                            {/* 훈련 처방 */}
                            <div style={{fontFamily:"monospace",fontSize:10,color:C.accent,letterSpacing:2,marginBottom:10}}>📋 분석 결과 & 훈련 처방</div>
                            <div style={{display:"flex",flexDirection:"column",gap:12}}>
                              {prescriptions.map(function(p,i){
                                return (
                                  <div key={i} style={{background:C.surface2,border:"1px solid "+C.border,borderLeft:"3px solid "+p.color,padding:"14px 16px"}}>
                                    <div style={{fontFamily:"monospace",fontSize:12,color:p.color,fontWeight:700,marginBottom:8,lineHeight:1.4}}>{p.issue}</div>
                                    <div style={{fontFamily:"monospace",fontSize:10,color:"#5a6a8a",marginBottom:10,lineHeight:1.7,borderBottom:"1px solid "+C.border,paddingBottom:8}}>
                                      {p.cause.split('\\n').map(function(line,li){return <span key={li}>{line}<br/></span>;})}
                                    </div>
                                    <div style={{fontFamily:"monospace",fontSize:10,color:C.text,lineHeight:1.9}}>
                                      {p.training.split('\\n').map(function(line,li){
                                        var isHeader = line.startsWith('【');
                                        var isBullet = line.startsWith('•');
                                        return (
                                          <div key={li} style={{
                                            color: isHeader ? p.color : (isBullet ? C.text : C.muted),
                                            fontWeight: isHeader ? 700 : 400,
                                            marginTop: isHeader ? 8 : 0,
                                            paddingLeft: isBullet ? 8 : 0,
                                          }}>{line}</div>
                                        );
                                      })}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── 백업 탭 */}
        {view==="backup" && (
          <div>
            <div style={Object.assign(cardStyle(),{marginBottom:16,borderLeft:"3px solid "+C.blue})}>
              <div style={secTitle(C.blue)}>💾 기기 간 데이터 이동</div>
              <div style={{fontSize:12,color:"#a8b4c8",lineHeight:2}}>
                <span style={{color:C.text}}>① 현재 기기</span>에서 <span style={{color:C.accent}}>내보내기 → 복사버튼</span><br />
                <span style={{color:C.text}}>② 다른 기기</span>에서 <span style={{color:C.gold}}>붙여넣기로 불러오기</span><br />
                <span style={{color:C.muted}}>※ PC는 파일 자동 다운로드, 모바일은 복사/붙여넣기</span><br />
                <span style={{color:C.muted}}>※ 불러오기 시 현재 기기 데이터를 덮어씁니다</span>
              </div>
            </div>
            <div style={Object.assign(cardStyle(),{marginBottom:16})}>
              <div style={secTitle()}>// 현재 데이터</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:16}}>
                {(function(){
                  var now = Date.now();
                  var old70 = activities.filter(function(a){
                    var d = new Date(a.activityDate||a.uploadedAt).getTime();
                    return now - d > 70*86400000;
                  });
                  return [
                    ["활동 기록", activities.length+"개", C.accent],
                    ["총 거리", totalKm+" km", C.accent],
                    ["70일 초과", old70.length ? old70.length+"개" : "없음", old70.length ? C.gold : C.muted],
                  ].map(function(item){
                    return (
                      <div key={item[0]} style={{background:C.surface2,padding:"12px 14px"}}>
                        <div style={{fontFamily:"monospace",fontSize:9,color:C.muted,marginBottom:4,letterSpacing:2}}>{item[0]}</div>
                        <div style={{fontFamily:"monospace",fontSize:16,fontWeight:700,color:item[2]}}>{item[1]}</div>
                      </div>
                    );
                  });
                })()}
              </div>

              {/* 70일 초과 활동 정리 */}
              {(function(){
                var now = Date.now();
                var old70 = activities.filter(function(a){
                  return now - new Date(a.activityDate||a.uploadedAt).getTime() > 70*86400000;
                });
                if (!old70.length) return null;
                return (
                  <div style={{background:"rgba(255,184,48,0.06)",border:"1px solid rgba(255,184,48,0.25)",padding:"12px 14px",marginBottom:14}}>
                    <div style={{fontFamily:"monospace",fontSize:11,color:C.gold,marginBottom:6}}>
                      🗑 70일 초과 활동 — {old70.length}개
                    </div>
                    <div style={{fontFamily:"monospace",fontSize:10,color:C.muted,marginBottom:10,lineHeight:1.7}}>
                      예측에 반영되지 않는 70일 이전 활동이에요.<br />
                      삭제 전 내보내기로 백업을 권장합니다.
                    </div>
                    <div style={{display:"flex",flexDirection:"column",gap:4,marginBottom:10,maxHeight:120,overflow:"auto"}}>
                      {old70.map(function(a){
                        var dateLabel = a.activityDate || (a.uploadedAt?a.uploadedAt.slice(0,10):"");
                        var daysAgo = Math.floor((now-new Date(a.activityDate||a.uploadedAt).getTime())/86400000);
                        return (
                          <div key={a.id} style={{fontFamily:"monospace",fontSize:10,color:C.muted,display:"flex",justifyContent:"space-between"}}>
                            <span>{dateLabel} · {a.name||a.fileName||"활동"}</span>
                            <span style={{color:"#3a4560"}}>{daysAgo}일 전</span>
                          </div>
                        );
                      })}
                    </div>
                    <button
                      onClick={async function(){
                        var now2 = Date.now();
                        var kept = activities.filter(function(a){
                          return now2 - new Date(a.activityDate||a.uploadedAt).getTime() <= 70*86400000;
                        });
                        setActivities(kept);
                        await saveActivities(kept);
                        showToast((activities.length-kept.length)+"개 삭제 완료 ✓");
                      }}
                      style={{width:"100%",padding:10,background:"rgba(255,184,48,0.15)",color:C.gold,border:"1px solid rgba(255,184,48,0.4)",fontFamily:"monospace",fontSize:12,fontWeight:700,cursor:"pointer",letterSpacing:1}}>
                      70일 초과 {old70.length}개 삭제
                    </button>
                  </div>
                );
              })()}

              <button onClick={exportData} style={{width:"100%",padding:14,background:C.accent,color:C.bg,border:"none",fontFamily:"monospace",fontSize:13,fontWeight:700,letterSpacing:2,cursor:"pointer"}}>
                ↓ 내보내기 (JSON)
              </button>
              {exportText && (
                <div style={{marginTop:12}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                    <div style={{fontFamily:"monospace",fontSize:10,color:C.muted,letterSpacing:1}}>📋 아래 전체 선택 후 복사 → 메모앱 등에 저장</div>
                    <button onClick={copyExportText} style={{
                      background:exportCopied?"#0a2a1a":C.accent,color:exportCopied?C.accent:C.bg,
                      border:exportCopied?"1px solid "+C.accent:"none",
                      padding:"5px 14px",fontFamily:"monospace",fontSize:11,fontWeight:700,cursor:"pointer",transition:"all .2s",flexShrink:0,
                    }}>{exportCopied?"✓ 복사됨":"복사"}</button>
                  </div>
                  <textarea readOnly value={exportText} onClick={function(e){e.target.select();}}
                    style={{width:"100%",height:120,background:C.surface2,border:"1px solid "+C.border,color:C.muted,fontFamily:"monospace",fontSize:16,padding:"8px",resize:"none",outline:"none",lineHeight:1.4,boxSizing:"border-box"}} />
                  <div style={{fontFamily:"monospace",fontSize:10,color:C.muted,marginTop:4}}>
                    활동 {activities.length}개 · 프로필 포함 · {(exportText.length/1024).toFixed(1)}KB
                  </div>
                </div>
              )}
            </div>
            <div style={Object.assign(cardStyle(),{marginBottom:16})}>
              <div style={secTitle(C.gold)}>// 불러오기</div>
              {importPreview ? (
                <div>
                  <div style={{background:"rgba(255,184,48,0.06)",border:"1px solid rgba(255,184,48,0.3)",padding:"16px 18px",marginBottom:14}}>
                    <div style={{fontFamily:"monospace",fontSize:11,color:C.gold,marginBottom:10}}>📄 {importPreview.fileName}</div>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12}}>
                      {[["활동 수",importPreview.data.activities?importPreview.data.activities.length+"개":"0개"],
                        ["내보낸 날짜",importPreview.data.exportedAt?importPreview.data.exportedAt.slice(0,10):"—"],
                        ["LT 페이스",importPreview.data.profile&&importPreview.data.profile.ltPaceMinKm?formatPace(parseFloat(importPreview.data.profile.ltPaceMinKm)):"없음"],
                        ["FTP",importPreview.data.profile&&importPreview.data.profile.ftp?importPreview.data.profile.ftp+"W":"없음"],
                      ].map(function(item){
                        return (
                          <div key={item[0]} style={{background:C.surface2,padding:"8px 12px"}}>
                            <div style={{fontFamily:"monospace",fontSize:9,color:C.muted,marginBottom:3}}>{item[0]}</div>
                            <div style={{fontFamily:"monospace",fontSize:13,fontWeight:700,color:C.text}}>{item[1]}</div>
                          </div>
                        );
                      })}
                    </div>
                    <div style={{fontFamily:"monospace",fontSize:11,color:C.red,marginBottom:12}}>⚠ 현재 {activities.length}개 활동이 위 데이터로 교체됩니다</div>
                    <div style={{display:"flex",gap:8}}>
                      <button onClick={confirmImport} style={{flex:1,padding:12,background:C.gold,color:C.bg,border:"none",fontFamily:"monospace",fontSize:13,fontWeight:700,letterSpacing:2,cursor:"pointer"}}>✓ 덮어쓰기 확인</button>
                      <button onClick={function(){setImportPreview(null);}} style={{padding:"12px 18px",background:"transparent",color:C.muted,border:"1px solid "+C.border,fontFamily:"monospace",fontSize:13,cursor:"pointer"}}>취소</button>
                    </div>
                  </div>
                </div>
              ) : (
                <div>
                  <div onDragOver={function(e){e.preventDefault();setImportDrag(true);}}
                    onDragLeave={function(){setImportDrag(false);}}
                    onDrop={function(e){e.preventDefault();setImportDrag(false);handleImportFile(e.dataTransfer.files);}}
                    onClick={function(){importRef.current.click();}}
                    style={{border:"1.5px dashed "+(importDrag?C.gold:C.border),background:importDrag?"rgba(255,184,48,0.04)":C.surface2,padding:"28px 20px",textAlign:"center",cursor:"pointer",transition:"all .2s",marginBottom:10}}>
                    <div style={{fontSize:28,marginBottom:8}}>📂</div>
                    <div style={{fontFamily:"monospace",fontSize:13,marginBottom:4}}>파일 드래그 또는 클릭</div>
                    <div style={{fontSize:11,color:C.muted}}><span style={{color:C.gold}}>garmin-log-YYYY-MM-DD.json</span></div>
                  </div>
                  <div style={{fontFamily:"monospace",fontSize:10,color:C.muted,marginBottom:6,letterSpacing:1}}>📱 모바일: 복사한 JSON을 아래에 붙여넣기 후 확인</div>
                  <textarea
                    placeholder='{"version":1,"activities":[...]...} 전체 붙여넣기'
                    onChange={function(e){
                      var val = e.target.value.trim();
                      if (!val) return;
                      try {
                        var data = JSON.parse(val);
                        if (!data.version || !Array.isArray(data.activities)) throw new Error("올바른 백업 데이터가 아니에요");
                        setImportPreview({data:data,fileName:"붙여넣기"});
                      } catch(err) {}
                    }}
                    style={{width:"100%",height:80,background:C.surface2,border:"1px solid "+C.border,color:C.muted,fontFamily:"monospace",fontSize:16,padding:"8px",resize:"none",outline:"none",lineHeight:1.4,boxSizing:"border-box"}}
                  />
                </div>
              )}
              <input ref={importRef} type="file" accept=".json" style={{display:"none"}} onChange={function(e){handleImportFile(e.target.files);}} />
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
