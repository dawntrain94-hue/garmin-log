// 한 활동의 구간 분석 (MCP get_activity_splits와 앱 상세 화면 /api/intervals?action=splits가 같이 씀)

import { icuJson, icuGpxText, toSettings, UpstreamError, athletePathOrNull } from './_icu.js';
import { analyzeSplits, samplesFromStreams, samplesFromGpx } from './_splits.js';
import { flatVenueReason } from '../src/elevation.js';

const RIDE_TYPES = new Set(['Ride', 'VirtualRide', 'GravelRide', 'EBikeRide', 'MountainBikeRide']);

export class SplitsError extends Error {}

// → { raw, flat, source, availableStreams, lthr, result }
export async function loadActivitySplits(id, splitKm) {
  const ap = athletePathOrNull();
  if (!ap) throw new SplitsError('서버의 INTERVALS_ATHLETE_ID 형식이 이상해요 ("i" + 숫자 또는 0)');
  const [raw, settingsRaw] = await Promise.all([icuJson(`/activity/${id}`), icuJson(`${ap}/sport-settings`)]);
  if (raw && raw._note) throw new SplitsError('Strava를 거쳐 들어온 활동이라 Intervals.icu가 상세 데이터를 주지 않음');
  const settings = toSettings(settingsRaw);
  const isRide = RIDE_TYPES.has(raw.type);
  const lthr = isRide ? settings.ride && settings.ride.lthr : settings.run && settings.run.lthr;

  let samples = null, source = 'streams';
  try { samples = samplesFromStreams(await icuJson(`/activity/${id}/streams.json`)); } catch (e) { if (e instanceof UpstreamError && e.status === 401) throw e; }
  if (!samples) { source = 'gpx'; try { samples = samplesFromGpx((await icuGpxText(id)).text); } catch { /* fall through */ } }
  if (!samples) throw new SplitsError('이 활동은 시간·거리 기록이 없어서 구간 분석을 할 수 없어요');

  const km = parseFloat(splitKm) > 0 ? Math.min(20, Math.max(0.2, parseFloat(splitKm))) : null;
  const flat = flatVenueReason({ type: raw.type, name: raw.name, trainer: raw.trainer });
  const result = analyzeSplits(samples, { isRide, splitKm: km, lthr, flat: !!flat });
  if (!result) throw new SplitsError('기록이 너무 짧거나 이동 구간이 없어서 분석할 수 없어요');
  return { raw, flat, source, availableStreams: samples.streamTypes, lthr, result };
}
