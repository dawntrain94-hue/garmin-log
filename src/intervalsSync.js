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
  var r = await fetch("/api/intervals?" + qs, { headers: { "x-ymc-secret": getSecret() } });
  if (r.status === 401) throw new UnauthorizedError("비밀키가 맞지 않아요");
  if (!r.ok) throw new Error("Intervals.icu 요청 실패 (" + r.status + ")");
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
