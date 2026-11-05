# 내 훈련 기록 — Personal Training Log PWA

개인 가민 훈련 기록 및 대회 예측 앱

## 배포 방법

### GitHub에 올리기
1. GitHub에서 새 저장소 생성 (이름: `garmin-log`)
2. 이 폴더의 파일들을 전부 업로드

### Vercel 배포
1. vercel.com 로그인
2. "New Project" → GitHub 저장소 선택
3. Framework: **Vite** 선택
4. Deploy 클릭

### 아이폰에 설치
1. Safari로 Vercel URL 접속
2. 하단 공유 버튼(□↑) 탭
3. "홈 화면에 추가" 탭
4. 완료 — 앱 아이콘으로 실행 가능

## Intervals.icu 연동

Garmin → Intervals.icu → YMC. Vercel 환경변수(Production):

| 이름 | 값 |
|---|---|
| `INTERVALS_API_KEY` | intervals.icu → Settings → Developer Settings → API Key |
| `INTERVALS_ATHLETE_ID` | `0` (API 키 주인) 또는 `i123456` |
| `YMC_SECRET` | 직접 정한 비밀키 (앱 SYNC와 Claude 커넥터에서 사용) |

## Claude 커넥터 (MCP)

claude.ai → Customize → Connectors → Add custom connector

- URL: `https://garmin-log.vercel.app/api/mcp`
- 인증: 요청 헤더 `Authorization: Bearer <YMC_SECRET>`

읽기 전용 도구: `get_training_overview`, `list_activities`, `get_cycling_intensity`, `get_recovery`, `get_thresholds`, `get_activity`, `get_activity_splits` (km별 구간·심박 드리프트·심박 존·케이던스·보폭·폼 변화), `predict_race` (앱 🎯 예측 탭과 같은 계산: 예측 기록·준비도·내구성·TID·컨디션), `get_races` (Intervals.icu 캘린더 대회: D-day·예측, 지난 대회는 대회 전날 기준 예측 대비 실제)

트랙·트레드밀·실내 활동은 상승고도를 0으로 봐요 (기기 기록값은 `recordedElevationGain`에 남김). 앱에서도 같은 규칙으로 저장된 기록을 한 번 정리해요 (`src/elevation.js`).

대회 설명란에 `목표 3:59:59`를 쓰면 목표 기록으로, `기록 5:18:48`을 쓰면 공식 기록(실제 결과)으로, `고도 1300` 또는 `D+1300`을 쓰면 코스 획득고도로 읽어요.
