// 커뮤베스트 워커 — 정적 파일 + 번역 API
//   POST /api/titles   {items:[{id,title,summary}]}  → {id:{ko_title,ko_summary}}   (테크 목록, KV에 7일 저장)
//   GET  /api/read?u=  기사 URL                      → {title,ko_title,paras:[{en,ko}]} (본문, KV에 30일 저장)
// 비밀값 ANTHROPIC_API_KEY 는 `npx wrangler secret put ANTHROPIC_API_KEY` 로 넣는다.
import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-sonnet-5";        // 본문 번역 (번역엔 쏘넷으로 충분, 비용 1/2.5)
const TITLE_MODEL = "claude-sonnet-5";  // 제목·요약 번역
const ALLOWED = ["bbc.com", "bbc.co.uk", "nytimes.com", "theguardian.com", "theverge.com", "arstechnica.com", "npr.org", "dw.com", "france24.com", "ft.com"];
const ENT = { "&quot;": '"', "&amp;": "&", "&#39;": "'", "&apos;": "'", "&lt;": "<", "&gt;": ">", "&nbsp;": " ", "&#8217;": "’", "&#8216;": "‘", "&#8220;": "“", "&#8221;": "”" };
const decode = s => s.replace(/&(?:#\d+|#x[0-9a-f]+|[a-z]+);/gi, m => ENT[m] ?? (m.startsWith("&#x") ? String.fromCodePoint(parseInt(m.slice(3, -1), 16)) : m.startsWith("&#") ? String.fromCodePoint(parseInt(m.slice(2, -1), 10)) : m));
const DAY_CAP = { titles: 120, read: 60 };   // 하루 호출 상한(남용 방지)

const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/api/titles" && req.method === "POST") return titles(req, env).catch(e => json({ error: String(e) }, 500));
    if (url.pathname === "/api/read") return read(url, env).catch(e => json({ error: String(e) }, 500));
    return env.ASSETS.fetch(req);
  },
};

async function capOK(env, kind) {
  const k = `cap:${kind}:${new Date().toISOString().slice(0, 10)}`;
  const n = parseInt((await env.READ_CACHE.get(k)) || "0", 10) + 1;
  await env.READ_CACHE.put(k, String(n), { expirationTtl: 172800 });
  return n <= DAY_CAP[kind];
}

function client(env) {
  if (!env.ANTHROPIC_API_KEY) throw new Error("번역 키가 아직 없습니다 (ANTHROPIC_API_KEY)");
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
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

async function titles(req, env) {
  const body = await req.json();
  const items = (body.items || []).slice(0, 60).filter(i => i.id && i.title);
  const out = {};
  const todo = [];
  for (const it of items) {
    const c = await env.READ_CACHE.get("t:" + it.id, "json");
    if (c && c.ko_title) out[it.id] = c;
    else if (c && c.pending) continue;            // 다른 요청이 번역 중 → 이번엔 건너뜀
    else todo.push(it);
  }
  if (todo.length) {
    for (const it of todo) await env.READ_CACHE.put("t:" + it.id, JSON.stringify({ pending: 1 }), { expirationTtl: 120 });
    if (!(await capOK(env, "titles"))) return json({ result: out, note: "오늘 한도 초과" });
    const resp = await client(env).messages.stream({
      model: TITLE_MODEL, max_tokens: 16000, thinking: { type: "disabled" },
      output_config: { effort: "low", format: { type: "json_schema", schema: TITLE_SCHEMA } },
      messages: [{ role: "user", content: TITLE_PROMPT + JSON.stringify(todo.map(i => ({ id: i.id, title: i.title, summary: (i.summary || "").slice(0, 200) }))) }],
    }).finalMessage();
    if (resp.stop_reason === "refusal") return json({ result: out, note: "번역 거절" });
    const parsed = JSON.parse(resp.content[0].text);
    for (const r of parsed.items) {
      if (!r.ko_title) continue;
      const v = { ko_title: r.ko_title, ko_summary: r.ko_summary || "" };
      out[r.id] = v;
      await env.READ_CACHE.put("t:" + r.id, JSON.stringify(v), { expirationTtl: 7 * 86400 });
    }
  }
  return json({ result: out });
}

// ── 본문 ────────────────────────────────────────────────────────────────
async function extract(u) {
  const r = await fetch(u, { headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36", "accept-language": "en" }, cf: { cacheTtl: 600 } });
  if (!r.ok) throw new Error("원문을 못 받았습니다 " + r.status);
  let title = "", inArticle = false, inSkip = 0, cur = null;
  const all = [], art = [];   // 블록: {t:문단} 또는 {img:주소}
  const pick = (e) => {
    let src = e.getAttribute("src") || e.getAttribute("data-src") || "";
    const ss = e.getAttribute("srcset") || e.getAttribute("data-srcset");
    if (ss) { const c = ss.split(",").map(x => x.trim().split(/\s+/)); const big = c.filter(x => x[1] && /w$/.test(x[1])).sort((a, b) => parseInt(b[1]) - parseInt(a[1]))[0]; src = (big ? big[0] : c[0][0]) || src; }
    if (!src || src.startsWith("data:")) return null;
    if (/logo|icon|avatar|pixel|1x1|badge|sprite|\.svg/i.test(src)) return null;
    const w = parseInt(e.getAttribute("width") || "0", 10); if (w && w < 200) return null;
    try { return new URL(decode(src), u).href; } catch { return null; }
  };
  const rw = new HTMLRewriter()
    .on("meta[property='og:title']", { element(e) { title = title || e.getAttribute("content") || ""; } })
    .on("title", { text(t) { if (!title) title += t.text; } })
    .on("article", { element(e) { inArticle = true; e.onEndTag(() => { inArticle = false; }); } })
    .on("p", {
      element(e) { cur = { t: "", a: inArticle }; e.onEndTag(() => { const s = cur.t.replace(/\s+/g, " ").trim(); if (s.length > 40) (cur.a ? art : all).push({ t: s }); cur = null; }); },
      text(t) { if (cur) cur.t += t.text; },
    })
    // 기자 프로필·관련기사·추천 영역의 사진은 뺀다
    .on('[class*="author"],[class*="byline"],[class*="avatar"],[class*="profile"],[class*="related"],[class*="recirc"],[class*="promo"],[class*="newsletter"],[class*="comment"]', { element(e) { inSkip++; e.onEndTag(() => { inSkip--; }); } })
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

const READ_SCHEMA = { type: "object", properties: { ko_title: { type: "string" }, paras: { type: "array", items: { type: "string" } } }, required: ["ko_title", "paras"], additionalProperties: false };
const READ_PROMPT = `아래 영문 기사를 한국어로 번역하라.
- 문단 수와 순서를 그대로 유지한다(입력 문단 하나 = 출력 문단 하나). 합치거나 빼지 않는다.
- 자연스러운 한국어 기사체('~다'). 고유명사는 통용 표기, 낯설면 원어 병기.
- 구독 안내·쿠키 안내·사진 설명 같은 문단은 그대로 짧게 옮기되 지어내지 않는다.
- ko_title 은 한국 신문 제목 투 20~40자.
`;

async function read(url, env) {
  const u = url.searchParams.get("u") || "";
  let host;
  try { host = new URL(u).hostname; } catch { return json({ error: "주소가 이상합니다" }, 400); }
  if (!ALLOWED.some(h => host === h || host.endsWith("." + h))) return json({ error: "지원하지 않는 사이트" }, 400);
  const key = "r:" + u;
  const cached = await env.READ_CACHE.get(key, "json");
  if (cached && cached.paras) return json(cached);
  if (cached && cached.pending) return json({ error: "지금 번역 중입니다. 잠시 뒤 다시 열어 주세요." }, 409);
  await env.READ_CACHE.put(key, JSON.stringify({ pending: 1 }), { expirationTtl: 180 });
  if (!(await capOK(env, "read"))) return json({ error: "오늘 번역 한도를 넘었습니다" }, 429);
  const { title, blocks } = await extract(u);
  const paras = blocks.filter(b => b.t).map(b => b.t);
  if (!paras.length) return json({ error: "본문을 읽어오지 못했습니다(유료 기사일 수 있음)", title, paras: [] }, 422);
  // 긴 출력이라 스트리밍으로 받는다(SDK가 긴 요청에 요구)
  const resp = await client(env).messages.stream({
    model: MODEL, max_tokens: 32000, thinking: { type: "disabled" },
    output_config: { effort: "low", format: { type: "json_schema", schema: READ_SCHEMA } },
    messages: [{ role: "user", content: READ_PROMPT + JSON.stringify({ title, paras }) }],
  }).finalMessage();
  if (resp.stop_reason === "refusal") return json({ error: "번역이 거절되었습니다" }, 422);
  const p = JSON.parse(resp.content[0].text);
  let i = 0;
  const out = blocks.map(b => b.t ? { en: b.t, ko: p.paras[i++] || "" } : { img: b.img, alt: b.alt });
  const result = { title, ko_title: p.ko_title, paras: out, url: u };
  await env.READ_CACHE.put(key, JSON.stringify(result), { expirationTtl: 30 * 86400 });
  return json(result);
}
