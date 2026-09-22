#!/usr/bin/env python3
"""읽을거리 수집기.

커뮤니티 베스트 · 일간지 부동산 · 해외 테크 기사를 받아 public/data/items.json 에 쓴다.
20분마다 GitHub Actions가 돌리고, 결과가 바뀌면 커밋 → Cloudflare Pages 자동 배포.

  python3 collector/collect.py            # 전체
  python3 collector/collect.py --only 뽐뿌  # 소스 하나만 (디버그)
"""
import json, re, sys, time, hashlib, html
from datetime import datetime, timezone, timedelta
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

import requests, feedparser
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "data" / "items.json"
STATE = ROOT / "collector" / "state.json"
KST = timezone(timedelta(hours=9))
UA = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36",
    "Accept-Language": "ko,en;q=0.8",
}
KEEP_HOURS = 48          # 이 시간 지난 항목은 버린다
PER_SOURCE = 40          # 소스당 최대 보관


def get(url, enc=None, timeout=25):
    for attempt in range(3):
        try:
            r = requests.get(url, headers=UA, timeout=timeout)
            r.raise_for_status()
            break
        except Exception:
            if attempt == 2:
                raise
            time.sleep(3)
    if enc:
        r.encoding = enc
    return r


def clean(t):
    t = html.unescape(t or "")
    t = re.sub(r"<[^>]+>", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def uid(url):
    return hashlib.sha1(url.encode()).hexdigest()[:12]


# ─────────────────────────── 커뮤니티 (HTML 스크랩) ───────────────────────────
# 각 항목: (이름, URL, 인코딩, 선택자, 링크 기준 URL, 제외 패턴)
COMMUNITY = [
    ("뽐뿌",   "https://www.ppomppu.co.kr/hot.php",                        "euc-kr", "a.baseList-title",  "https://www.ppomppu.co.kr", r"^AD\b"),
    ("에펨코리아", "https://www.fmkorea.com/best",                          None,     "a.hotdeal_var8",    "https://www.fmkorea.com",   None),
    ("오늘의유머", "https://www.todayhumor.co.kr/board/list.php?table=bestofbest", "utf-8", "td.subject a", "https://www.todayhumor.co.kr", None),
    ("보배드림", "https://www.bobaedream.co.kr/list?code=best",              "euc-kr", "a.bsubject",        "https://www.bobaedream.co.kr", None),
    ("더쿠",   "https://theqoo.net/hot",                                   None,     "td.title a",        "https://theqoo.net",        r"/event/"),
    ("루리웹",  "https://bbs.ruliweb.com/best",                             None,     "a.subject_link",    "https://bbs.ruliweb.com",   None),
    ("엠엘비파크", "https://mlbpark.donga.com/mp/b.php?b=bullpen&m=hot",     None,     "a.txt",             "https://mlbpark.donga.com", None),
    ("디시인사이드", "https://gall.dcinside.com/board/lists/?id=dcbest",      None,     "td.gall_tit a",     "https://gall.dcinside.com", r"이용 안내|공지"),
    ("82cook", "https://www.82cook.com/entiz/enti.php?bn=15&sort=hit",     "utf-8",  "td.title a",        "https://www.82cook.com/entiz/", r"공지|당부의 말씀|비밀번호를 변경|무단 게재"),
]

# 제목 뒤에 붙는 댓글 수 "(79)" "[83]" 정리
TAIL = re.compile(r"\s*[\[\(]\s*\d+\s*[\]\)]\s*$")


def scrape_community(name, url, enc, sel, base, skip):
    r = get(url, enc)
    s = BeautifulSoup(r.text, "lxml")
    out, seen = [], set()
    for a in s.select(sel):
        title = TAIL.sub("", clean(a.get_text(" ", strip=True)))
        href = a.get("href") or ""
        if len(title) < 4 or not href or href.startswith("#") or href.startswith("javascript"):
            continue
        if skip and re.search(skip, title + " " + href):
            continue
        link = requests.compat.urljoin(base, href)
        if link in seen:
            continue
        seen.add(link)
        out.append({"source": name, "title": title, "url": link})
        if len(out) >= PER_SOURCE:
            break
    return out


# ─────────────────────────── 일간지 부동산 (RSS) ───────────────────────────
# 부동산 전용 피드는 그대로, 경제 종합 피드는 부동산 낱말로 거른다.
RE_WORDS = re.compile(
    r"부동산|아파트|청약|분양|전세|월세|재건축|재개발|집값|주택|매매가|집 ?값|입주|오피스텔|"
    r"LTV|DSR|주담대|주택담보|국토부|국토교통부|LH|공공택지|신도시|GTX|역세권|임대차|전셋값|매물|규제지역|토허|토지거래"
)
NEWS = [
    ("매일경제", "https://www.mk.co.kr/rss/30100041/",                                            False),
    ("한국경제", "https://www.hankyung.com/feed/realestate",                                     False),
    ("조선일보", "https://www.chosun.com/arc/outboundfeeds/rss/category/economy/?outputType=xml", True),
    ("동아일보", "https://rss.donga.com/economy.xml",                                            True),
    ("연합뉴스", "https://www.yna.co.kr/rss/economy.xml",                                        True),
    ("한겨레",  "https://www.hani.co.kr/rss/economy/",                                          True),
    ("경향신문", "https://www.khan.co.kr/rss/rssdata/economy_news.xml",                          True),
    ("뉴시스",  "https://newsis.com/RSS/economy.xml",                                            True),
]

# ─────────────────────────── 해외 테크 (RSS) ───────────────────────────
TECH = [
    ("BBC",          "http://feeds.bbci.co.uk/news/technology/rss.xml"),
    ("NYT",          "https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml"),
    ("The Guardian", "https://www.theguardian.com/technology/rss"),
    ("The Verge",    "https://www.theverge.com/rss/index.xml"),
    ("Ars Technica", "https://feeds.arstechnica.com/arstechnica/technology-lab"),
    ("Hacker News",  "https://hnrss.org/frontpage"),
]


def entry_time(e):
    for k in ("published_parsed", "updated_parsed"):
        if e.get(k):
            return datetime.fromtimestamp(time.mktime(e[k]), tz=timezone.utc).astimezone(KST).isoformat(timespec="minutes")
    return None


def fetch_rss(name, url, filt=False):
    r = get(url)
    f = feedparser.parse(r.content)
    out = []
    for e in f.entries:
        title = clean(e.get("title"))
        link = e.get("link")
        if not title or not link:
            continue
        summary = clean(e.get("summary") or e.get("description") or "")[:200]
        if filt and not RE_WORDS.search(title + " " + summary):
            continue
        out.append({"source": name, "title": title, "url": link, "summary": summary, "time": entry_time(e)})
        if len(out) >= PER_SOURCE:
            break
    return out


# ─────────────────────────── 실행 ───────────────────────────
def run(only=None):
    jobs = []
    for c in COMMUNITY:
        if not only or only in c[0]:
            jobs.append(("community", c[0], lambda c=c: scrape_community(*c)))
    for n, u, filt in NEWS:
        if not only or only in n:
            jobs.append(("realestate", n, lambda n=n, u=u, filt=filt: fetch_rss(n, u, filt)))
    for n, u in TECH:
        if not only or only in n:
            jobs.append(("tech", n, lambda n=n, u=u: fetch_rss(n, u)))

    results, errors = {"community": [], "realestate": [], "tech": []}, {}

    def work(job):
        sec, name, fn = job
        try:
            return sec, name, fn(), None
        except Exception as ex:
            return sec, name, [], f"{ex.__class__.__name__}: {str(ex)[:80]}"

    with ThreadPoolExecutor(8) as pool:
        for sec, name, items, err in pool.map(work, jobs):
            if err:
                errors[name] = err
            results[sec].extend(items)
            print(f"{sec:10} {name:8} {len(items):3}건 {err or ''}")

    # 이전 상태와 합친다: 처음 본 시각(first_seen)을 유지해 새 글이 위로 오게 한다.
    state = json.loads(STATE.read_text()) if STATE.exists() else {}
    now = datetime.now(KST)
    now_s = now.isoformat(timespec="minutes")
    cutoff = (now - timedelta(hours=KEEP_HOURS)).isoformat(timespec="minutes")
    merged = {"community": {}, "realestate": {}, "tech": {}}

    # 이번에 못 받은 소스(오류)는 이전 항목을 그대로 살린다.
    for sec, items in state.get("items", {}).items():
        for it in items:
            if it.get("first_seen", "") >= cutoff and it["source"] in errors:
                merged[sec][it["url"]] = it

    for sec, items in results.items():
        for it in items:
            prev = None
            for old in state.get("items", {}).get(sec, []):
                if old["url"] == it["url"]:
                    prev = old
                    break
            it = dict(it)
            it["id"] = uid(it["url"])
            it["first_seen"] = prev["first_seen"] if prev else now_s
            if not it.get("time"):
                it["time"] = it["first_seen"]
            merged[sec][it["url"]] = it

    # 커뮤니티는 베스트에서 내려간 글도 48시간은 남긴다(읽던 글이 사라지지 않게)
    for old in state.get("items", {}).get("community", []):
        if old["url"] not in merged["community"] and old.get("first_seen", "") >= cutoff:
            old = dict(old); old["dropped"] = True
            merged["community"][old["url"]] = old

    final = {}
    for sec, d in merged.items():
        lst = [v for v in d.values() if v.get("first_seen", "") >= cutoff]
        lst.sort(key=lambda v: (v.get("time") or v["first_seen"]), reverse=True)
        final[sec] = lst

    sources = {
        "community": [c[0] for c in COMMUNITY],
        "realestate": [n for n, _, _ in NEWS],
        "tech": [n for n, _ in TECH],
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"generated": now_s, "sources": sources, "errors": errors, "items": final}, ensure_ascii=False, indent=0))
    STATE.write_text(json.dumps({"updated": now_s, "items": final}, ensure_ascii=False))
    print(f"\n생성 {now_s}  커뮤니티 {len(final['community'])} · 부동산 {len(final['realestate'])} · 테크 {len(final['tech'])}  오류 {len(errors)}")


if __name__ == "__main__":
    only = sys.argv[sys.argv.index("--only") + 1] if "--only" in sys.argv else None
    run(only)
