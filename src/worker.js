// 커뮤베스트 워커 — 정적 파일 + 번역 API
//   POST /api/titles   {items:[{id,title,summary}]}  → {id:{ko_title,ko_summary}}   (테크 목록, KV에 7일 저장)
//   GET  /api/read?u=  기사 URL                      → {title,ko_title,paras:[{en,ko}]} (본문, KV에 30일 저장)
// 비밀값 ANTHROPIC_API_KEY 는 `npx wrangler secret put ANTHROPIC_API_KEY` 로 넣는다.
import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-opus-5";          // 본문 번역 (사장님 지시로 오퍼스, 260923)
const TITLE_MODEL = "claude-sonnet-5";  // 제목·요약 번역
const ALLOWED = ["bbc.com", "bbc.co.uk", "theguardian.com", "theverge.com", "arstechnica.com", "npr.org", "dw.com", "aljazeera.com", "cbc.ca"];
const ENT = { "&quot;": '"', "&amp;": "&", "&#39;": "'", "&apos;": "'", "&lt;": "<", "&gt;": ">", "&nbsp;": " ", "&#8217;": "’", "&#8216;": "‘", "&#8220;": "“", "&#8221;": "”" };
const decode = s => s.replace(/&(?:#\d+|#x[0-9a-f]+|[a-z]+);/gi, m => ENT[m] ?? (m.startsWith("&#x") ? String.fromCodePoint(parseInt(m.slice(3, -1), 16)) : m.startsWith("&#") ? String.fromCodePoint(parseInt(m.slice(2, -1), 10)) : m));
const DAY_CAP = { titles: 120, read: 60 };   // 하루 호출 상한(남용 방지)

const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/api/titles" && req.method === "POST") return titles(req, env).catch(e => json({ error: String(e) }, 500));
    if (url.pathname === "/api/read") return read(url, env, ctx).catch(e => json({ error: String(e) }, 500));
    if (url.pathname === "/api/pretranslate") return pretranslate(env).then(r => json(r)).catch(e => json({ error: String(e) }, 500));
    if (url.pathname === "/api/issues") return env.READ_CACHE.get(ISSUES, "json").then(r => json(r || {}));
    if (url.pathname === "/api/cluster") return clusterIssues(env, url.searchParams.get("rebuild") === "1").then(r => json(r)).catch(e => json({ error: String(e) }, 500));
    if (url.pathname === "/api/status") return status(env, req).then(r => json(r)).catch(e => json({ error: String(e) }, 500));
    return env.ASSETS.fetch(req);
  },
  // 20분마다(수집 직후) 테크·해외 새 글 제목을 미리 번역해 둔다 → 화면을 열면 바로 한국어
  async scheduled(event, env, ctx) {
    // 7·27·47분: 제목 번역 / 15분: 이슈 묶기
    if (event.cron.startsWith("15")) ctx.waitUntil(clusterIssues(env)); else ctx.waitUntil(pretranslate(env));
  },
};

const DATA_URL = "https://raw.githubusercontent.com/ceo938/reader-site/main/public/data/items.json";
const TMAP = "titles:map";   // 제목 번역 전체 지도 {id:{ko_title,ko_summary,t}} — cron이 유일한 기록자

async function loadTmap(env) { return (await env.READ_CACHE.get(TMAP, "json")) || {}; }

// 20분마다: 새 글 제목 번역 → tmap 한 장에 합쳐 저장(쓰기 1회). 주문형으로 번역된 개별 키도 흡수한다.
async function pretranslate(env) {
  const r = await fetch(DATA_URL + "?" + Date.now(), { cf: { cacheTtl: 0 } });
  const data = await r.json();
  const items = [];
  for (const sec of ["tech", "world"]) for (const it of data.items[sec] || []) items.push({ id: it.id, title: it.title, summary: it.summary || "" });
  const tmap = await loadTmap(env);
  const todo = [];
  let absorbed = 0;
  for (const it of items) {
    const cur = tmap[it.id];
    if (cur && (!cur.src || cur.src === it.title)) continue;   // 있고 원제목도 같음
    const c = await env.READ_CACHE.get("t:" + it.id, "json");
    if (c && c.ko_title && (!c.src || c.src === it.title)) { tmap[it.id] = { ...c, t: Date.now() }; absorbed++; } else todo.push(it);
  }
  let done = 0, batches = 0;
  for (let i = 0; i < todo.length && batches < 6; i += 12, batches++) {
    if (!(await capOK(env, "titles"))) break;
    try {
      const chunk = todo.slice(i, i + 12);
      const res = await translateBatch(env, chunk, false);
      const srcOf = Object.fromEntries(chunk.map(c => [c.id, c.title]));
      for (const [id, v] of Object.entries(res)) { tmap[id] = { ...v, src: srcOf[id], t: Date.now() }; done++; }
    } catch (e) { console.log("pretranslate batch error", String(e)); }
  }
  // 목록에서 사라진 지 7일 넘은 것은 지도에서 뺀다
  const keep = new Set(items.map(i => i.id)), cutoff = Date.now() - 7 * 86400e3;
  for (const id of Object.keys(tmap)) if (!keep.has(id) && (tmap[id].t || 0) < cutoff) delete tmap[id];
  await env.READ_CACHE.put(TMAP, JSON.stringify(tmap));
  const out = { total: items.length, untranslated: todo.length, translated: done, absorbed, batches, map_size: Object.keys(tmap).length };
  await env.READ_CACHE.put("status:pretranslate", JSON.stringify({ ...out, at: new Date().toISOString() }), { expirationTtl: 86400 });
  return out;
}

// ─────────────────────────── 이슈 묶기 ───────────────────────────
// 부동산·테크·해외 기사를 "같은 사건"끼리 묶는다. 매시간 새 기사만 기존 이슈에 붙이고(비용 절약),
// 여러 곳이 보도한 이슈가 위로 오도록 점수를 매긴다. 결과는 issues:map 한 키.
const ISSUES = "issues:map";
const CLUSTER_SECS = ["realestate", "tech", "world"];
const SKIP_TITLE = /\blive\b|– live|- live|podcast|\bvideo\b|in pictures|crossword|quiz|newsletter|^opinion|^letters|\[속보\]|포토\]|\[포토|사진\]|\[영상|영상\]|\[인사\]|\[부고\]|부고\]|만평/i;
const CLUSTER_SCHEMA = {
  type: "object",
  properties: {
    assign: { type: "array", items: { type: "object", properties: {
      item: { type: "string" },
      issue: { type: "string" },
      off: { type: "boolean" },
    }, required: ["item", "issue", "off"], additionalProperties: false } },
  },
  required: ["assign"], additionalProperties: false,
};
const CLUSTER_PROMPT = {
  realestate: "한국 부동산 뉴스다. 같은 정책·같은 사건·같은 단지/지역 이슈를 다룬 기사를 하나의 이슈로 묶어라. 부동산(주택·청약·분양·전월세·재건축·대출규제·집값·건설사 주택사업)과 무관한 기사(금리 일반, 증시, 기업 실적, 해외 경제 등)는 off=true.",
  tech: "해외 테크 뉴스다. 같은 회사의 같은 발표, 같은 사건, 같은 제품을 다룬 기사를 하나의 이슈로 묶어라. 테크와 무관한 정치·일반 기사는 off=true.",
  world: "해외 주요 뉴스다. 같은 사건·같은 정상회담·같은 분쟁을 다룬 기사를 하나의 이슈로 묶어라. 연예·스포츠·생활 기사는 off=true.",
};

async function clusterSection(env, sec, items, tmap, prev, rebuild) {
  // prev: {issues:{id:{h,ids:[],t}}, seen:{itemId:issueId}}
  const issues = rebuild ? {} : (prev.issues || {});
  const seen = rebuild ? {} : (prev.seen || {});
  const cutoff = Date.now() - 48 * 3600e3;
  const alive = items.filter(it => Date.parse(it.time || it.first_seen) > cutoff && !SKIP_TITLE.test(it.title));
  const todo = alive.filter(it => !seen[it.id]);
  if (todo.length) {
    const existing = Object.entries(issues).map(([id, v]) => ({ id, h: v.h })).slice(-120);
    const list = todo.slice(0, 80).map(it => ({ id: it.id, src: it.source, title: (tmap[it.id] && tmap[it.id].ko_title) || it.title }));
    const resp = await client(env).messages.stream({
      model: TITLE_MODEL, max_tokens: 16000, thinking: { type: "disabled" },
      output_config: { effort: "low", format: { type: "json_schema", schema: CLUSTER_SCHEMA } },
      messages: [{ role: "user", content: `${CLUSTER_PROMPT[sec]}
규칙: 기존 이슈 목록에 맞는 게 있으면 그 id를 쓰고, 없으면 "새:" 뒤에 이슈 제목(한국어 한 줄, 20자 안팎, 신문 제목 투)을 붙여라. 새 기사 여러 건이 같은 새 이슈면 같은 "새:제목"을 반복해 써라. 모든 새 기사를 빠짐없이 배정하라.

기존 이슈:
${JSON.stringify(existing)}

새 기사:
${JSON.stringify(list)}` }],
    }).finalMessage();
    if (resp.stop_reason === "refusal") throw new Error("묶기 거절");
    const out = JSON.parse(resp.content[0].text);
    const newIds = {};
    for (const a of out.assign) {
      const it = todo.find(x => x.id === a.item); if (!it) continue;
      if (a.off) { seen[it.id] = "off"; continue; }
      let iid = a.issue;
      if (iid.startsWith("새:")) {
        const h = iid.slice(2).trim();
        iid = newIds[h] || (newIds[h] = "i" + it.id.slice(0, 8));
        if (!issues[iid]) issues[iid] = { h, ids: [], t: 0 };
      } else if (!issues[iid]) { issues[iid] = { h: it.title.slice(0, 60), ids: [], t: 0 }; }
      issues[iid].ids.push(it.id); seen[it.id] = iid;
    }
    for (const it of todo) if (!seen[it.id]) { const iid = "i" + it.id.slice(0, 8); issues[iid] = { h: (tmap[it.id] && tmap[it.id].ko_title) || it.title, ids: [it.id], t: 0 }; seen[it.id] = iid; }
  }
  // 정리: 현재 목록에 없는 기사 제거, 빈 이슈 제거, 최신 시각·출처 수·점수 계산
  const byId = Object.fromEntries(items.map(it => [it.id, it]));
  const result = [];
  for (const [iid, v] of Object.entries(issues)) {
    v.ids = v.ids.filter(id => byId[id]);
    if (!v.ids.length) { delete issues[iid]; continue; }
    const srcs = new Set(v.ids.map(id => byId[id].source));
    v.t = Math.max(...v.ids.map(id => Date.parse(byId[id].time || byId[id].first_seen) || 0));
    const ageH = (Date.now() - v.t) / 3600e3;
    v.n = v.ids.length; v.s = srcs.size;
    v.score = srcs.size * 3 + Math.min(v.ids.length, 6) + (ageH < 6 ? 4 : ageH < 12 ? 2 : ageH < 24 ? 1 : 0) - (ageH > 36 ? 3 : 0);
    result.push({ id: iid, ...v });
  }
  for (const id of Object.keys(seen)) if (!byId[id]) delete seen[id];
  result.sort((a, b) => b.score - a.score || b.t - a.t);
  return { issues, seen, list: result, translated: todo.length };
}

async function clusterIssues(env, rebuild = false) {
  const r = await fetch(DATA_URL + "?" + Date.now(), { cf: { cacheTtl: 0 } });
  const data = await r.json();
  const tmap = await loadTmap(env);
  const prev = (await env.READ_CACHE.get(ISSUES, "json")) || {};
  const out = { at: new Date().toISOString(), secs: {} };
  const summary = {};
  for (const sec of CLUSTER_SECS) {
    try {
      const res = await clusterSection(env, sec, data.items[sec] || [], tmap, (prev.secs || {})[sec] || {}, rebuild);
      out.secs[sec] = { issues: res.issues, seen: res.seen, list: res.list.map(x => ({ id: x.id, h: x.h, ids: x.ids, n: x.n, s: x.s, t: x.t, score: x.score })) };
      summary[sec] = { issues: res.list.length, new_items: res.translated };
    } catch (e) {
      out.secs[sec] = (prev.secs || {})[sec] || { issues: {}, seen: {}, list: [] };
      summary[sec] = { error: String(e.message || e) };
    }
  }
  await env.READ_CACHE.put(ISSUES, JSON.stringify(out));
  return summary;
}

async function status(env, req) {
  const day = new Date().toISOString().slice(0, 10);
  return {
    last_pretranslate: await env.READ_CACHE.get("status:pretranslate", "json"),
    last_cluster: ((await env.READ_CACHE.get(ISSUES, "json")) || {}).at || null,
    today: { titles: parseInt((await env.READ_CACHE.get(`cap:titles:${day}`)) || "0", 10), read: parseInt((await env.READ_CACHE.get(`cap:read:${day}`)) || "0", 10) },
    caps: DAY_CAP, has_key: !!env.ANTHROPIC_API_KEY, colo: req && req.cf ? req.cf.colo : null,
  };
}

async function capOK(env, kind) {
  const k = `cap:${kind}:${new Date().toISOString().slice(0, 10)}`;
  const n = parseInt((await env.READ_CACHE.get(k)) || "0", 10) + 1;
  await env.READ_CACHE.put(k, String(n), { expirationTtl: 172800 });
  return n <= DAY_CAP[kind];
}

// ── API 중계: 미국(wnam)에 고정된 Durable Object가 대신 api.anthropic.com 을 부른다 ──
export class ApiProxy {
  constructor(state, env) { this.env = env; }
  async fetch(req) {
    const u = new URL(req.url);
    const target = "https://api.anthropic.com" + u.pathname + u.search;
    const headers = new Headers(req.headers); headers.delete("host");
    return fetch(target, { method: req.method, headers, body: req.body });
  }
}
function viaProxy(env, hint) {
  const stub = env.API.get(env.API.idFromName("anthropic-" + hint), { locationHint: hint });
  return (url, init) => stub.fetch(url, init);
}
function client(env, hint = "wnam") {
  if (!env.ANTHROPIC_API_KEY) throw new Error("번역 키가 아직 없습니다 (ANTHROPIC_API_KEY)");
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, fetch: viaProxy(env, hint), maxRetries: 2 });
}

// ── 제목·요약 ────────────────────────────────────────────────────────────
const TITLE_SCHEMA = {
  type: "object",
  properties: { items: { type: "array", items: { type: "object", properties: { id: { type: "string" }, ko_title: { type: "string" }, ko_summary: { type: "string" } }, required: ["id", "ko_title", "ko_summary"], additionalProperties: false } } },
  required: ["items"], additionalProperties: false,
};
const TITLE_PROMPT = `아래는 해외 테크 뉴스의 제목과 요약이다. 각 항목을 한국어로 옮겨라.
- 제목은 한국 신문 온라인판 제목 투로. 직역하지 말고 뜻이 바로 잡히게. 20~40자.
- 회사·제품·인명은 한국에서 통용되는 표기, 낯선 고유명사는 원어를 괄호로 병기.
- 요약은 두 문장 이내 '~다' 체. 비어 있으면 빈 문자열. 없는 내용을 지어내지 않는다.
- id 는 그대로.
항목:
`;

// 한 묶음 번역 → {id:{ko_title,ko_summary}}. store=true면 개별 키에도 저장(주문형).
async function translateBatch(env, todo, store) {
  const out = {};
  if (!todo.length) return out;
  const resp = await client(env).messages.stream({
    model: TITLE_MODEL, max_tokens: 16000, thinking: { type: "disabled" },
    output_config: { effort: "low", format: { type: "json_schema", schema: TITLE_SCHEMA } },
    messages: [{ role: "user", content: TITLE_PROMPT + JSON.stringify(todo.map(i => ({ id: i.id, title: i.title, summary: (i.summary || "").slice(0, 200) }))) }],
  }).finalMessage();
  if (resp.stop_reason === "refusal") throw new Error("번역 거절");
  const parsed = JSON.parse(resp.content[0].text);
  for (const r of parsed.items) {
    if (!r.ko_title) continue;
    const src = (todo.find(i => i.id === r.id) || {}).title;
    const v = { ko_title: r.ko_title, ko_summary: r.ko_summary || "", src };
    out[r.id] = v;
    if (store) await env.READ_CACHE.put("t:" + r.id, JSON.stringify(v), { expirationTtl: 7 * 86400 });
  }
  return out;
}

async function titles(req, env) {
  const body = await req.json();
  const items = (body.items || []).slice(0, 60).filter(i => i.id && i.title);
  const tmap = await loadTmap(env);
  const out = {}, todo = [];
  const fresh = (v, it) => v && v.ko_title && (!v.src || v.src === it.title);
  for (const it of items) {
    if (fresh(tmap[it.id], it)) { out[it.id] = tmap[it.id]; continue; }
    const c = await env.READ_CACHE.get("t:" + it.id, "json");
    if (fresh(c, it)) out[it.id] = c; else todo.push(it);
  }
  if (todo.length) {
    if (!(await capOK(env, "titles"))) return json({ result: out, note: "오늘 한도 초과" });
    const chunks = []; for (let i = 0; i < todo.length; i += 8) chunks.push(todo.slice(i, i + 8));
    const results = await Promise.allSettled(chunks.map(c => translateBatch(env, c, true)));
    let err = null;
    for (const r of results) { if (r.status === "fulfilled") Object.assign(out, r.value); else err = String(r.reason); }
    return json({ result: out, ...(err ? { note: err } : {}) });
  }
  return json({ result: out });
}

// ── 본문 ────────────────────────────────────────────────────────────────
async function extract(u) {
  let r = await fetch(u, { headers: {
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36",
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "sec-fetch-site": "none", "upgrade-insecure-requests": "1",
  }, cf: { cacheTtl: 600 } });
  if (!r.ok) {   // 일부 사이트는 sec-fetch 헤더를 싫어한다 → 단순 헤더로 한 번 더
    r = await fetch(u, { headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36", "accept": "text/html,*/*;q=0.8", "accept-language": "en" }, cf: { cacheTtl: 0 } });
  }
  if (!r.ok) throw new Error("원문을 못 받았습니다 " + r.status);
  let title = "", inArticle = false, inSkip = 0, cur = null;
  const all = [], art = [];   // 블록: {t:문단} 또는 {img:주소}
  const pick = (e) => {
    let src = e.getAttribute("src") || e.getAttribute("data-src") || "";
    const ss = e.getAttribute("srcset") || e.getAttribute("data-srcset");
    if (ss) { const c = ss.split(",").map(x => x.trim().split(/\s+/)); const big = c.filter(x => x[1] && /w$/.test(x[1])).sort((a, b) => parseInt(b[1]) - parseInt(a[1]))[0]; src = (big ? big[0] : c[0][0]) || src; }
    if (!src || src.startsWith("data:")) return null;
    if (/logo|icon|avatar|pixel|1x1|badge|sprite|placeholder|spacer|blank|\.svg/i.test(src)) return null;
    const w = parseInt(e.getAttribute("width") || "0", 10); if (w && w < 200) return null;
    try { return new URL(decode(src), u).href; } catch { return null; }
  };
  const endTag = (e, fn) => { try { e.onEndTag(fn); } catch { } };
  const rw = new HTMLRewriter()
    .on("meta[property='og:title']", { element(e) { title = title || e.getAttribute("content") || ""; } })
    .on("title", { text(t) { if (!title) title += t.text; } })
    .on("article", { element(e) { inArticle = true; endTag(e, () => { inArticle = false; }); } })
    .on("p", {
      element(e) { const mine = { t: "", a: inArticle }; cur = mine; endTag(e, () => { const s = mine.t.replace(/\s+/g, " ").trim(); if (s.length > 40) (mine.a ? art : all).push({ t: s }); if (cur === mine) cur = null; }); },
      text(t) { if (cur) cur.t += t.text; },
    })
    // 기자 프로필·관련기사·추천 영역의 사진은 뺀다
    .on('[class*="author"],[class*="byline"],[class*="avatar"],[class*="profile"],[class*="related"],[class*="recirc"],[class*="promo"],[class*="newsletter"],[class*="comment"]', { element(e) { inSkip++; endTag(e, () => { inSkip--; }); } })
    .on("img", { element(e) {
      if (inSkip > 0) return;
      const alt = (e.getAttribute("alt") || "").trim().slice(0, 200);
      if (/^[A-Z][a-z]+(?: [A-Z][a-z'-]+){1,2}$/.test(alt)) return;   // 사람 이름만 있는 alt = 기자 프로필 사진
      const src = pick(e); if (src) (inArticle ? art : all).push({ img: src, alt });
    } })
    .on("script,style,nav,footer,aside,header", { element(e) { e.remove(); } });
  await rw.transform(r).text();
  const artText = art.filter(b => b.t).length;
  let blocks = artText >= 3 ? art : all;
  // 반복 안내문·중복 문단 제거(예: 버지의 "Posts from this topic will be added to your daily email digest")
  const seen = new Set(), BOILER = /daily (email )?digest|news that matters|sign up for|subscribe to|newsletter|cookie|all rights reserved|follow us on|read more:|advertisement/i;
  blocks = blocks.filter(b => { if (b.img) { if (seen.has(b.img)) return false; seen.add(b.img); return true; } const k = b.t.toLowerCase(); if (seen.has(k) || BOILER.test(b.t)) return false; seen.add(k); return true; });
  // 사진은 글 사이에 최대 12장, 연속 중복 없이
  let imgs = 0; blocks = blocks.filter(b => b.t || (++imgs <= 12));
  blocks = blocks.slice(0, 80);
  return { title: decode(title.trim()), blocks: blocks.map(b => b.t ? { t: decode(b.t) } : b) };
}

const READ_SCHEMA = { type: "object", properties: { ko_title: { type: "string" }, paras: { type: "array", items: { type: "object", properties: { i: { type: "integer" }, ko: { type: "string" } }, required: ["i", "ko"], additionalProperties: false } } }, required: ["ko_title", "paras"], additionalProperties: false };
const READ_PROMPT = `아래 영문 기사의 일부 문단을 한국어로 번역하라.
- 입력 문단마다 번호 i 가 있다. 출력은 같은 번호 i 와 그 문단의 번역 ko 를 하나씩, 빠짐없이 돌려준다. 문단을 합치거나 빼지 않는다.
- 자연스러운 한국어 기사체('~다'). 고유명사는 통용 표기, 낯설면 원어 병기.
- 구독 안내·사진 설명 같은 문단도 짧게 그대로 옮기되 지어내지 않는다.
- ko_title 은 기사 제목을 한국 신문 제목 투 20~40자로.
`;
const CHUNK = 8;            // 묶음 크기(문단). 묶음 하나가 30초 안에 끝나야 한다.
const PER_POLL = 4;         // 확인 요청 한 번에 동시에 처리할 묶음 수

async function translateChunk(env, title, numbered) {
  const resp = await client(env).messages.stream({
    model: MODEL, max_tokens: 16000, thinking: { type: "disabled" },
    output_config: { effort: "low", format: { type: "json_schema", schema: READ_SCHEMA } },
    messages: [{ role: "user", content: READ_PROMPT + JSON.stringify({ title, paras: numbered }) }],
  }).finalMessage();
  if (resp.stop_reason === "refusal") throw new Error("번역이 거절되었습니다");
  const p = JSON.parse(resp.content[0].text);
  const map = {};
  for (const x of p.paras) if (x && typeof x.i === "number" && x.ko) map[x.i] = x.ko;
  return { ko_title: p.ko_title, map };
}

// 묶음 하나 처리(30초 안). 결과는 j:<u>:c<idx> 에 저장.
async function runChunk(env, u, job, idx) {
  const key = `j:${u}:c${idx}`;
  try {
    const numbered = job.texts.slice(idx * CHUNK, (idx + 1) * CHUNK).map((t, k) => ({ i: idx * CHUNK + k, t }));
    const r = await translateChunk(env, job.title, numbered);
    const v = { ok: 1, map: r.map, ko_title: idx === 0 ? r.ko_title : undefined };
    await env.READ_CACHE.put(key, JSON.stringify(v), { expirationTtl: 3600 });
    return v;
  } catch (e) {
    const v = { err: String(e.message || e), at: Date.now() };
    await env.READ_CACHE.put(key, JSON.stringify(v), { expirationTtl: 120 });
    return v;
  }
}

async function read(url, env, ctx) {
  const u = url.searchParams.get("u") || "";
  let host;
  try { host = new URL(u).hostname; } catch { return json({ error: "주소가 이상합니다" }, 400); }
  if (!ALLOWED.some(h => host === h || host.endsWith("." + h))) return json({ error: "지원하지 않는 사이트" }, 400);
  const rkey = "r:" + u, jkey = "j:" + u;
  const retry = url.searchParams.get("retry") === "1";
  const cached = await env.READ_CACHE.get(rkey, "json");
  if (cached && cached.paras) return json(cached);
  if (cached && cached.error && !retry) return json({ error: cached.error }, 422);

  // 작업 정의(본문 추출)는 첫 요청 때 한 번만
  let job = retry ? null : await env.READ_CACHE.get(jkey, "json");
  if (!job) {
    if (!(await capOK(env, "read"))) return json({ error: "오늘 번역 한도를 넘었습니다" }, 429);
    let ex;
    try { ex = await extract(u); } catch (e) { return json({ error: String(e.message || e) }, 422); }
    const texts = ex.blocks.filter(b => b.t).map(b => b.t);
    if (!texts.length) { await env.READ_CACHE.put(rkey, JSON.stringify({ error: "본문을 읽어오지 못했습니다(유료 기사일 수 있음)" }), { expirationTtl: 300 }); return json({ error: "본문을 읽어오지 못했습니다(유료 기사일 수 있음)" }, 422); }
    job = { title: ex.title, blocks: ex.blocks, texts, n: Math.ceil(texts.length / CHUNK), at: Date.now() };
    await env.READ_CACHE.put(jkey, JSON.stringify(job), { expirationTtl: 3600 });
  }

  // 묶음 상태 읽기 → 남은 묶음을 이 요청 안에서(연결을 붙든 채) 처리 → 다시 상태 읽기
  // waitUntil(응답 뒤 30초 제한)에 의존하지 않는다. 화면은 3초마다 다시 부르므로 끊겨도 완료된 묶음은 남는다.
  const readStates = () => Promise.all(Array.from({ length: job.n }, (_, i) => env.READ_CACHE.get(`j:${u}:c${i}`, "json")));
  let states = await readStates();
  const pick = () => { const t = []; for (let i = 0; i < job.n && t.length < PER_POLL; i++) { const st = states[i]; if (st && st.ok) continue; if (st && st.claim && Date.now() - st.claim < 35000) continue; t.push(i); } return t; };
  const todo = pick();
  let took = 0;
  if (todo.length) {
    for (const i of todo) await env.READ_CACHE.put(`j:${u}:c${i}`, JSON.stringify({ claim: Date.now() }), { expirationTtl: 120 });
    const t0 = Date.now();
    const results = await Promise.all(todo.map(i => runChunk(env, u, job, i)));
    took = Date.now() - t0;
    // KV는 방금 쓴 값을 바로 못 돌려줄 수 있으니 이번 결과는 직접 반영
    for (let k = 0; k < todo.length; k++) states[todo[k]] = results[k];
  }
  const done = states.filter(x => x && x.ok).length;
  if (done === job.n) {
    const map = Object.assign({}, ...states.map(x => x.map));
    const ko_title = (states[0] && states[0].ko_title) || job.title;
    let i = 0;
    const paras = job.blocks.map(b => b.t ? { en: b.t, ko: map[i++] || "" } : { img: b.img, alt: b.alt });
    const result = { title: job.title, ko_title, paras, url: u, at: new Date().toISOString() };
    await env.READ_CACHE.put(rkey, JSON.stringify(result), { expirationTtl: 30 * 86400 });
    return json(result);
  }
  const errs = states.filter(x => x && x.err).map(x => x.err);
  return json({ pending: true, done, total: job.n, took, ...(errs.length ? { note: errs[0] } : {}) });
}
