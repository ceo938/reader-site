# reader-site — 읽을거리

커뮤니티 베스트 · 일간지 부동산 뉴스 · 해외 테크 기사를 한 화면에서 읽는 개인용 사이트.

- `public/` — 공개 파일. Cloudflare Pages가 이 폴더를 그대로 배포한다.
- `public/data/items.json` — 수집 결과. 화면은 이 파일 하나만 읽는다.
- `collector/collect.py` — 수집기. 소스 목록(COMMUNITY / NEWS / TECH)이 이 파일 위쪽에 있다. 소스를 더하거나 빼려면 여기만 고친다.
- `.github/workflows/collect.yml` — 20분마다 수집기를 돌려 결과가 바뀌면 커밋한다. 커밋되면 Pages가 자동 배포.

## 처음 한 번 할 일
1. GitHub에 `reader-site` 저장소를 만들고 이 폴더를 push.
2. Cloudflare → Workers & Pages → Create → Pages → Connect to Git → `reader-site` 선택.
   빌드 명령 비움, 출력 디렉터리 `public`.
3. GitHub 저장소 Settings → Actions → General → Workflow permissions를 "Read and write"로.
4. Actions 탭에서 "읽을거리 수집" 워크플로를 한 번 수동 실행(Run workflow).

## 로컬에서 돌리기
```bash
.venv/bin/python collector/collect.py
.venv/bin/python -m http.server -d public 8765   # http://localhost:8765
```

## 소스
- 커뮤니티: 뽐뿌·에펨코리아·오늘의유머·보배드림·더쿠·루리웹·엠엘비파크·디시인사이드·82cook (베스트/인기글 페이지 스크랩)
- 부동산: 매일경제·한국경제(부동산 전용 RSS), 조선·동아·연합·한겨레·경향·뉴시스(경제 RSS를 부동산 낱말로 거름)
- 테크: BBC·NYT·Guardian·The Verge·Ars Technica·Hacker News (RSS)
- 클리앙은 봇 차단(410), 네이버 카페(부동산스터디 등)는 로그인이 필요해 뺐다.

제목·링크·짧은 요약만 싣고 본문은 원문으로 보낸다. 검색엔진 색인은 막아 둠(noindex).
