// YMC client helper for /api/intervals (Vercel function in /api/intervals.js)

var SECRET_KEY = "ymc_secret";

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
  var r = await fetch("/api/intervals?" + qs, { headers: { "x-ymc-secret": encodeURIComponent(getSecret()) } });
  if (r.status === 401) {
    var info = null;
    try { info = await r.json(); } catch (e) {}
    if (!info || info.error !== "unauthorized") {
      throw new Error("Vercel 배포 보호에 막혔어요. garmin-log.vercel.app 주소로 열었는지 확인해 주세요");
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
