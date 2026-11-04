// YMC client helper for /api/intervals (Vercel function in /api/intervals.js)

var SECRET_KEY = "ymc_secret";
var API_BASE = (typeof location !== "undefined" && /^(localhost|127\.0\.0\.1)$/.test(location.hostname))
  ? "" : "https://garmin-log.vercel.app";

export function getSecret() {
  try { return localStorage.getItem(SECRET_KEY) || ""; } catch (e) { return ""; }
}
export function setSecret(value) {
  try {
    if (value) localStorage.setItem(SECRET_KEY, value);
    else localStorage.removeItem(SECRET_KEY);
  } catch (e) { /* storage blocked */ }
}

export class UnauthorizedError extends Error {}

async function call(params) {
  var qs = new URLSearchParams(params).toString();
  // 헤더에는 영문/숫자만 들어갈 수 있어서 인코딩해서 보냄 (한글이 섞여도 안전)
  // 앱을 어느 주소에서 열든 보호가 없는 실제 주소의 API를 사용
  var r = await fetch(API_BASE + "/api/intervals?" + qs, { headers: { "x-ymc-secret": encodeURIComponent(getSecret()) } });
  if (r.status === 401) {
    var info = null;
    try { info = await r.json(); } catch (e) {}
    if (!info || info.error !== "unauthorized") {
      throw new Error("Vercel 배포 보호에 막혔어요 (" + r.status + ")");
    }
    var why = info.caseOnly ? "대소문자만 달라요"
      : "입력 " + info.sentLength + "자 / 서버 " + info.serverLength + "자";
    throw new UnauthorizedError("비밀키가 맞지 않아요 (" + why + ")");
  }
  if (!r.ok) {
    var detail = "";
    try { detail = (await r.json()).error || ""; } catch (e) {}
    throw new Error(detail ? detail : "요청 실패 (" + r.status + ")");
  }
  return params.action === "gpx" ? r.text() : r.json();
}

export function listActivities(oldest, newest) {
  return call({ action: "list", oldest: oldest, newest: newest });
}

export function fetchGpx(id) {
  return call({ action: "gpx", id: id });
}

// Intervals.icu activity type → YMC sport key (null = YMC가 다루지 않는 종목)
export function mapIntervalsType(type) {
  switch (type) {
    case "Run": return "road_run";
    case "TrailRun": return "trail_run";
    case "Ride":
    case "VirtualRide":
    case "GravelRide":
    case "EBikeRide": return "cycling";
    case "MountainBikeRide": return "mtb";
    default: return null;
  }
}
