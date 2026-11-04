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

읽기 전용 도구: `get_training_overview`, `list_activities`, `get_cycling_intensity`, `get_recovery`, `get_thresholds`, `get_activity`, `get_activity_splits` (km별 구간·심박 드리프트·심박 존)
