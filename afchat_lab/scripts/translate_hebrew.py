"""Translate corpus + testset to Hebrew using Claude Agent SDK."""
from __future__ import annotations
import asyncio, json, sys
from pathlib import Path

LAB = Path(__file__).resolve().parent.parent

async def translate(text: str, context: str = "") -> str:
    from claude_agent_sdk import query, ClaudeAgentOptions
    opts = ClaudeAgentOptions(
        system_prompt=(
            "You are a professional Hebrew translator. Translate the given text to Hebrew accurately. "
            "Preserve all markdown formatting, tables, headers, bullet points, numbers, units, "
            "proper nouns (EU directives, regulation numbers, category labels like A1/A2/B/C/D, "
            "chemical symbols, acronyms like CPC/ADR/LEZ), and technical terms exactly as-is. "
            "Output ONLY the translated text with no commentary."
        ),
        allowed_tools=[],
        max_turns=1,
        model="claude-sonnet-4-6",
    )
    prompt = f"{context}\n\n{text}" if context else text
    result = ""
    async for msg in query(prompt=prompt, options=opts):
        for block in getattr(msg, "content", []) or []:
            t = getattr(block, "text", None)
            if t:
                result += t
    return result.strip()


async def translate_corpus():
    src = LAB / "corpus"
    dst = LAB / "corpus_he"
    dst.mkdir(exist_ok=True)
    files = sorted(src.glob("*.md"))
    for i, f in enumerate(files, 1):
        out = dst / f.name
        if out.exists():
            print(f"  skip {f.name} (already done)")
            continue
        print(f"  [{i}/{len(files)}] translating {f.name} ...", flush=True)
        text = f.read_text()
        translated = await translate(text, "Translate this EU transportation reference document to Hebrew:")
        out.write_text(translated)
        print(f"         done ({len(translated)} chars)")


async def translate_questions():
    src = LAB / "testset" / "questions.json"
    dst = LAB / "testset" / "questions_he.json"
    if dst.exists():
        print("  skip questions_he.json (already done)")
        return
    data = json.loads(src.read_text())
    print(f"  translating {len(data['questions'])} questions ...", flush=True)
    # Translate all questions in one batch for efficiency
    qs = data["questions"]
    batch = json.dumps(qs, ensure_ascii=False, indent=2)
    prompt = (
        "Translate the following JSON array of QA questions to Hebrew. "
        "Translate only the values of: 'question', 'reference_answer', and each string in 'key_facts'. "
        "Keep all field names, IDs, source_doc, difficulty, answer_type, and numeric values unchanged. "
        "Return ONLY the valid JSON array with no commentary.\n\n" + batch
    )
    result = await translate(prompt)
    # strip markdown code fences if present
    result = result.strip()
    if result.startswith("```"):
        result = "\n".join(result.split("\n")[1:])
    if result.endswith("```"):
        result = "\n".join(result.split("\n")[:-1])
    translated_qs = json.loads(result)
    out = {**data, "meta": {**data["meta"],
        "name": "שאלות תחבורה אירופאית — ערכת בדיקות בעברית",
        "corpus_dir": "corpus_he",
    }, "questions": translated_qs}
    dst.write_text(json.dumps(out, ensure_ascii=False, indent=2))
    print(f"  saved questions_he.json ({len(translated_qs)} questions)")


async def main():
    print("=== Translating corpus to Hebrew ===")
    await translate_corpus()
    print("\n=== Translating questions to Hebrew ===")
    await translate_questions()
    print("\nDone.")

asyncio.run(main())
