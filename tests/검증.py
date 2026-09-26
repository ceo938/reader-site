#!/usr/bin/env python3
"""커뮤베스트 번역 전수 검증. 실제 배포 서버를 상대로 돌린다.
  .venv/bin/python tests/검증.py            # 전체
  .venv/bin/python tests/검증.py --rebuild  # 제목 지도를 지우고 처음부터 다시(원제목 기록 포함)
"""
import json, sys, time, urllib.parse, urllib.request, urllib.error, subprocess, threading
from collections import Counter

BASE = "https://commubest.ceo-2b7.workers.dev"
NS = "a4461d99ec91454bb6873d031a389764"
DATA = "https://raw.githubusercontent.com/ceo938/reader-site/main/public/data/items.json"
FAIL = []
UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"

def get(url, timeout=120):
    try:
        r = urllib.request.urlopen(urllib.request.Request(url, headers={"cache-control": "no-cache", "user-agent": UA}), timeout=timeout)
        return json.loads(r.read())
    except urllib.error.HTTPError as e:
        try: return json.loads(e.read())
        except Exception: return {"error": f"HTTP {e.code}"}

def post(url, body, timeout=180):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"content-type": "application/json", "user-agent": UA})
    return json.loads(urllib.request.urlopen(req, timeout=timeout).read())

def ok(cond, msg):
    print(("  ✓ " if cond else "  ✗ ") + msg)
    if not cond: FAIL.append(msg)

def has_korean(s): return any("가" <= ch <= "힣" for ch in s or "")

# ── 0. 준비 ─────────────────────────────────────────────
data = get(DATA + "?t=" + str(int(time.time())))
items = {sec: data["items"][sec] for sec in ("tech", "world")}
print(f"데이터 {data['generated']} 테크 {len(items['tech'])} 해외 {len(items['world'])}")

if "--rebuild" in sys.argv:
    print("\n[0] 제목 지도 재구축")
    subprocess.run(["npx", "-y", "wrangler@latest", "kv", "key", "delete", "--namespace-id", NS, "--remote", "titles:map"], capture_output=True)
    for k in range(3):
        r = get(BASE + "/api/pretranslate", timeout=900); print("  ", r)
        if r.get("untranslated", 1) == 0 or r.get("batches", 0) == 0: break

# ── 1. 상태 ─────────────────────────────────────────────
print("\n[1] 서버 상태")
st = get(BASE + "/api/status")
print("  ", st)
ok(st.get("has_key"), "번역 키 있음")
last = st.get("last_pretranslate") or {}
ok(bool(last.get("at")), "자동 번역 실행 기록 있음")

# ── 2. 제목: 화면과 같은 경로로 전수 요청 ─────────────────────
print("\n[2] 제목·요약 전수")
for sec, lst in items.items():
    got = {}
    for i in range(0, len(lst), 60):
        chunk = [{"id": it["id"], "title": it["title"], "summary": (it.get("summary") or "")[:200]} for it in lst[i:i+60]]
        got.update(post(BASE + "/api/titles", {"items": chunk}).get("result", {}))
    missing = [it for it in lst if it["id"] not in got]
    bad = [it for it in lst if it["id"] in got and not has_korean(got[it["id"]].get("ko_title"))]
    stale = [it for it in lst if it["id"] in got and got[it["id"]].get("src") and got[it["id"]]["src"] != it["title"]]
    ok(not missing, f"{sec}: {len(lst)}건 중 번역 없음 {len(missing)}건 " + "; ".join(m["title"][:40] for m in missing[:3]))
    ok(not bad, f"{sec}: 한국어 아닌 번역 {len(bad)}건")
    ok(not stale, f"{sec}: 원제목 바뀐 뒤 옛 번역 남은 것 {len(stale)}건")

# ── 3. 본문: 출처별 1건, 화면과 같은 폴링 ─────────────────────
def read_poll(u, limit=240, label=""):
    q = BASE + "/api/read?u=" + urllib.parse.quote(u, safe="")
    t0 = time.time(); last = None
    while time.time() - t0 < limit:
        try: j = get(q, timeout=150)
        except Exception as e: j = {"error": "요청 실패 " + str(e)[:60]}
        last = j
        if j.get("paras") or j.get("error"): break
        time.sleep(2)
    return time.time() - t0, last

print("\n[3] 본문 번역 (출처별 새 기사)")
picked = {}
for sec, lst in items.items():
    for it in lst:
        if it["source"] not in picked and it["source"] != "Hacker News": picked[it["source"]] = it
results = {}
def run_one(src, it):
    u = it["url"].split("?")[0] + "?v=" + str(int(time.time()))
    results[src] = read_poll(u, label=src)
threads = [threading.Thread(target=run_one, args=(s, it)) for s, it in picked.items()]
for t in threads: t.start()
for t in threads: t.join()
for src, (sec_, j) in results.items():
    if j and j.get("paras"):
        ps = [p for p in j["paras"] if "en" in p]
        empty = [p for p in ps if not p["ko"]]
        nonko = [p for p in ps if p["ko"] and not has_korean(p["ko"])]
        ok(len(ps) >= 3 and not empty and not nonko, f"{src}: {sec_:.0f}초, 문단 {len(ps)}, 빈 {len(empty)}, 비한국어 {len(nonko)}, 사진 {len(j['paras'])-len(ps)} | {j.get('ko_title','')[:40]}")
    else:
        paywall = src in ("NYT", "FT")
        msg = (j or {}).get("error", "응답 없음")
        ok(paywall, f"{src}: 실패 '{msg[:50]}' ({'유료 벽이라 예상된 실패' if paywall else '예상 밖'})")

# ── 4. 열다가 나가기: 3건을 8초 만에 끊고 다시 열기 ─────────────
print("\n[4] 열다가 나간 뒤 다시 열기")
cands = [it for s, it in picked.items() if s in ("BBC", "The Guardian", "Ars Technica", "The Verge", "DW", "France 24", "NPR")][:3]
urls = [it["url"].split("?")[0] + "?v=abandon" + str(int(time.time())) for it in cands]
procs = [subprocess.Popen(["curl", "-s", "-m", "8", "-A", UA, BASE + "/api/read?u=" + urllib.parse.quote(u, safe="")], stdout=subprocess.DEVNULL) for u in urls]
for p in procs: p.wait()
for u in urls:
    sec_, j = read_poll(u, limit=200)
    ok(bool(j and j.get("paras")), f"다시 열어 완료 {sec_:.0f}초 | {u[:60]}")

# ── 5. 같은 글 동시 열기(폰+PC) ────────────────────────────────
print("\n[5] 같은 글을 두 곳에서 동시에")
it = cands[0]; u = it["url"].split("?")[0] + "?v=dup" + str(int(time.time()))
res = {}
def dup(k): res[k] = read_poll(u, limit=200)
ts = [threading.Thread(target=dup, args=(k,)) for k in range(2)]
for t in ts: t.start()
for t in ts: t.join()
ok(all(v[1] and v[1].get("paras") for v in res.values()), f"두 요청 모두 완료 ({', '.join(f'{v[0]:.0f}초' for v in res.values())})")
st2 = get(BASE + "/api/status")
print("   사용량 변화: 본문", st.get("today", {}).get("read"), "→", st2.get("today", {}).get("read"))

print("\n==== 결과:", "모두 통과" if not FAIL else f"실패 {len(FAIL)}건")
for f in FAIL: print("  -", f)
sys.exit(1 if FAIL else 0)
