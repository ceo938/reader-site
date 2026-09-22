"""해외 테크 기사 제목·요약 한국어 번역 (Claude API).

ANTHROPIC_API_KEY 가 없으면 아무것도 하지 않고 그대로 돌려준다.
이미 ko_title 이 있는 항목은 건너뛴다. 한 번에 25건씩 묶어 보낸다.
"""
import os, json

MODEL = "claude-opus-5"
BATCH = 25
SUMMARY = os.environ.get("TRANSLATE_SUMMARY") == "1"   # 기본은 제목만. 요약까지 하려면 1

PROMPT = """아래는 해외 테크 뉴스의 제목과 요약이다. 각 항목을 한국어로 옮겨라.

규칙
- 제목은 한국 신문 온라인판 제목 투로. 직역하지 말고 뜻이 바로 잡히게. 20~40자.
- 회사·제품·인명은 한국에서 통용되는 표기를 쓰고, 낯선 고유명사는 원어를 괄호로 병기한다.
- 요약은 두 문장 이내, 존댓말 없이 '~다' 체.
- 요약이 비어 있으면 빈 문자열로 둔다. 없는 내용을 지어내지 않는다.
- id 는 그대로 돌려준다.

항목:
"""

SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "ko_title": {"type": "string"},
                    "ko_summary": {"type": "string"},
                },
                "required": ["id", "ko_title", "ko_summary"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["items"],
    "additionalProperties": False,
}


def translate(items):
    """items: dict 목록(id, title, summary). ko_title/ko_summary 를 채워 넣는다. 번역한 건수를 돌려준다."""
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return 0
    todo = [it for it in items if not it.get("ko_title")]
    if not todo:
        return 0
    import anthropic
    client = anthropic.Anthropic()
    done = 0
    for i in range(0, len(todo), BATCH):
        chunk = todo[i:i + BATCH]
        payload = [{"id": it["id"], "title": it["title"], "summary": (it.get("summary", "") if SUMMARY else "")} for it in chunk]
        try:
            resp = client.messages.create(
                model=MODEL,
                max_tokens=16000,
                output_config={"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}},
                messages=[{"role": "user", "content": PROMPT + json.dumps(payload, ensure_ascii=False)}],
            )
            if resp.stop_reason == "refusal":
                print("번역: 거절됨", getattr(resp, "stop_details", None))
                continue
            out = json.loads(resp.content[0].text)["items"]
        except Exception as ex:
            print(f"번역 실패: {ex.__class__.__name__}: {str(ex)[:120]}")
            continue
        by = {o["id"]: o for o in out}
        for it in chunk:
            o = by.get(it["id"])
            if o and o["ko_title"].strip():
                it["ko_title"] = o["ko_title"].strip()
                it["ko_summary"] = o["ko_summary"].strip()
                done += 1
    return done
