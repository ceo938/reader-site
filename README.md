# reader-site — 커뮤베스트

커뮤니티 베스트 · 일간지 부동산 뉴스 · 해외 테크 기사를 한 화면에서 읽는 사이트.
주소: https://commubest.ceo-2b7.workers.dev (자체 도메인은 wrangler.toml 주석 참고)

- `public/` — 공개 파일. Cloudflare Workers 정적 자산으로 배포한다.
- `public/data/items.json` — 수집 결과. 화면은 깃허브 raw 주소에서 이 파일을 직접 읽는다(배포 없이 갱신됨). raw가 안 되면 배포된 사본을 쓴다.
- `collector/collect.py` — 수집기. 소스 목록(COMMUNITY / NEWS / TECH)이 이 파일 위쪽에 있다. 소스를 더하거나 빼려면 여기만 고친다.
- `.github/workflows/collect.yml` — 20분마다 수집기를 돌려 결과가 바뀌면 커밋한다.

## 배포
화면(index.html 등)을 고쳤을 때만 배포한다. 수집 데이터는 배포와 무관하다.
```bash
npx wrangler deploy
```
wrangler 로그인은 ~/Library/Preferences/.wrangler/config/default.toml 에 살아 있다.

## 자체 도메인 붙이기
1. Cloudflare 대시보드 → Domain Registration → Register Domains 에서 도메인 구입(같은 계정이면 DNS가 자동으로 잡힌다).
2. wrangler.toml 의 `routes` 줄 주석을 풀고 도메인을 맞춘 뒤 `npx wrangler deploy`.

## 로컬에서 돌리기
```bash
.venv/bin/python collector/collect.py
.venv/bin/python -m http.server -d public 8765   # http://localhost:8765
```

## 소스
- 커뮤니티: 뽐뿌·에펨코리아·오늘의유머·보배드림·더쿠·루리웹·엠엘비파크·디시인사이드·82cook (베스트/인기글 페이지 스크랩). 에펨·오유는 깃허브 서버 접속을 막아 새 글이 안 들어온다.
- 부동산: 매일경제·한국경제(부동산 전용 RSS), 조선·동아·연합·한겨레·경향·뉴시스(경제 RSS를 부동산 낱말로 거름)
- 테크: BBC·NYT·Guardian·The Verge·Ars Technica·Hacker News (RSS)
- 클리앙은 봇 차단(410), 네이버 카페(부동산스터디 등)는 로그인이 필요해 뺐다.

제목·링크·짧은 요약만 싣고 본문은 원문으로 보낸다. 광고(애드센스)는 index.html 맨 위 `AD` 값이 비어 있으면 안 그려진다.
