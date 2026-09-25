# 핫딜 파이프라인

쿠팡 파트너스 API → 자체 가격 이력 → 딜 판정 → 텔레그램 채널 발송 + 정적 사이트(GitHub Pages) 생성.
외부 패키지 없이 Node 20+ 하나로 돌아가고, GitHub Actions가 30분마다 실행한다.

## 구조

```
pipeline.mjs                 본체 (API 서명, 수집, 가격 이력, 판정, 텔레그램, 사이트 렌더)
keywords.json                검색 API로 돌릴 키워드 (회당 4개씩 순환)
.github/workflows/hotdeal.yml 30분 주기 실행 + data/, docs/ 커밋
sample/goldbox-2026-09-25.json 2026-09-25 실제 골드박스 8개 (키 없이 테스트용)
docs/index.html              위 샘플로 만든 사이트 미리보기
```

실행하면 `data/prices.json`(상품별 가격 이력 90일), `data/feed.json`(최근 48시간 발송 딜), `data/state.json`(키워드 순번)이 생긴다.

## 딜 판정 규칙

| 조건 | 점수 |
|---|---|
| 골드박스 상품 | +2 |
| 표시 할인율 20% 이상 | +1 |
| 추적 3일 이상 + 추적 기간 중 최저가 경신 | +3 |
| 30일 최고가 대비 15% 이상 하락 | +1 |

- 2점 이상이면 발송, 회당 최대 5개
- 같은 상품은 7일 동안 다시 안 보냄 (그 사이 더 싸지면 예외)
- 01~07시(KST)는 텔레그램 발송을 멈추고 사이트만 갱신
- 분유, 의료기기처럼 표시광고 리스크가 큰 품목은 자동 발송에서 제외
- "최저가" 같은 절대 표현은 안 쓴다. 쿠팡 가이드가 과장 표현 자제를 권고하기 때문에 "추적 N일 중 최저"처럼 검증 가능한 문구만 쓴다.

## 키 없이 테스트

```powershell
$env:MOCK="sample/goldbox-2026-09-25.json"; $env:DRY_RUN="1"; node pipeline.mjs
```

## 실제 가동

1. 쿠팡 파트너스 최종승인(누적 판매 15만 원) 후 Tools > 파트너스 API에서 Access/Secret Key 발급
2. GitHub 저장소 생성 후 이 폴더 업로드
3. Settings > Secrets: `CP_ACCESS_KEY`, `CP_SECRET_KEY`, `TG_BOT_TOKEN`
4. Settings > Variables: `TG_CHAT_ID`(@채널명), `SITE_URL`, `CP_SUB_ID`(선택)
5. Settings > Pages: Branch `main`, 폴더 `/docs`
6. Actions 탭에서 `hotdeal` 수동 실행 1회로 확인

GitHub(미국 IP)에서 쿠팡 API 호출이 막히면 집 PC에서 돌린다:

```powershell
setx CP_ACCESS_KEY "..." ; setx CP_SECRET_KEY "..." ; setx TG_BOT_TOKEN "..." ; setx TG_CHAT_ID "@채널명"
schtasks /Create /SC MINUTE /MO 30 /TN hotdeal /TR "cmd /c cd /d <이 폴더 경로> && node pipeline.mjs"
```

## API 호출 한도

쿠팡 가이드 기준으로 검색은 시간당 10회, 리포트는 50회, 그 외(골드박스, 딥링크)는 100회까지다. 한 번만 넘겨도 24시간 차단된다.
이 설정(30분 주기, 회당 검색 4회)이면 시간당 검색 8회, 골드박스 2회로 한도 안에 들어간다.
`searchPerRun`을 올리거나 cron을 더 짧게 바꾸면 차단된다.

## 정책 체크리스트 (위반 시 수익금 몰수 + 해지)

- [ ] 파트너스 [내 정보 관리]에 링크가 올라가는 모든 곳(텔레그램 채널, 사이트, X 계정)을 활동 페이지로 등록하고 스크린샷도 등록
- [ ] 모든 게시물 첫 줄에 대가성 문구 (코드에 이미 들어가 있음)
- [ ] 채널명, 도메인, 프로필에 "쿠팡" 금지 (쿠팡 지재권 위반으로 탈퇴 처리)
- [ ] 활동 금지 사이트에 링크 금지: 당근마켓, 뽐뿌, 퀘이사존, 에펨코리아, 디시인사이드, 다모앙 등. 아카라이브는 모든 활동 금지. 목록은 partners.coupang.com/#announcements/17 에서 계속 업데이트됨
- [ ] 다른 커뮤니티 핫딜 글을 퍼오지 않기 (제3자 저작물 무단 사용 금지). 딜 소스는 쿠팡 API와 자체 가격 이력만 쓴다
- [ ] 동의 없는 DM이나 문자로 링크 보내지 않기. 텔레그램 채널은 구독자가 직접 들어오는 구조라 괜찮다
- [ ] 플로팅 배너, 자동 리다이렉트 금지. 사이트 코드에는 없음
- [ ] 클릭 수, CTR 같은 통계는 외부 공개 금지
