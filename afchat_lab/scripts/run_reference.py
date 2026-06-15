"""Run a reference LLM (Claude via the Agent SDK) as the CANDIDATE agent over a
corpus, to calibrate a test set: if a strong model scores well on the natural-
phrasing questions, the questions are fair (measure comprehension); if it also
struggles, they're too oblique.

Claude is driven agentically with read-only filesystem tools (Read/Glob/Grep)
pointed at the corpus, mirroring the LM Studio candidates' list/read/search tools.
Answers are graded by the same judge (harness.judge). Writes a run-*.json in the
standard schema so it shows up in the lab UI/leaderboard.

Usage (from afchat_lab/, venv active):
    .venv/bin/python scripts/run_reference.py --config config_124.yaml [--limit N]
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from datetime import datetime
from pathlib import Path

import yaml

LAB = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(LAB))

from harness import judge as judging  # noqa: E402
from harness.run_eval import summarize, write_outputs  # noqa: E402

CANDIDATE_PROMPT = (
    "You answer questions using ONLY the documents in the current directory. "
    "Use your file tools to list, read, and search the documents, find the specific "
    "fact, and give a short, direct final answer. Ground every answer in the documents; "
    "do not invent facts. Answer in the SAME language as the question. Keep the final "
    "answer concise (one or two sentences with the exact numbers/terms)."
)


async def answer_with_claude(question: str, corpus_dir: str, model: str, max_turns: int):
    from claude_agent_sdk import query, ClaudeAgentOptions

    options = ClaudeAgentOptions(
        system_prompt=CANDIDATE_PROMPT,
        allowed_tools=["Read", "Glob", "Grep"],
        cwd=corpus_dir,
        permission_mode="bypassPermissions",
        max_turns=max_turns,
        model=model,
    )
    texts: list[str] = []
    n_tool = 0
    async for message in query(prompt=question, options=options):
        for block in getattr(message, "content", []) or []:
            t = getattr(block, "text", None)
            if t:
                texts.append(t)
            if block.__class__.__name__ == "ToolUseBlock" or getattr(block, "type", None) == "tool_use":
                n_tool += 1
    # final answer = last non-empty assistant text
    answer = next((t for t in reversed(texts) if t.strip()), "")
    return answer.strip(), n_tool


async def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--config", default="config_124.yaml")
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--model", default="claude-sonnet-4-6", help="reference candidate model")
    args = p.parse_args()

    cfg = yaml.safe_load((LAB / args.config).read_text())
    corpus_dir = str((LAB / cfg["paths"]["corpus_dir"]).resolve())
    testset = json.loads((LAB / cfg["paths"]["testset"]).read_text())
    questions = testset["questions"]
    if args.limit:
        questions = questions[: args.limit]
    judge_model = cfg["judge"].get("model", "claude-sonnet-4-6")
    max_turns = int(cfg["agent"].get("max_steps", 8))

    print(f"Preflight: Claude judge ({judge_model}) ...", flush=True)
    await judging.preflight(judge_model)
    print(f"Reference candidate: {args.model} over {Path(corpus_dir).name}  ({len(questions)} Q)\n")

    label = f"{args.model} (reference)"
    rows = []
    t0 = time.monotonic()
    for q in questions:
        qs = time.monotonic()
        answer, n_tool, finish, err = "", 0, "error", None
        for attempt in range(3):  # retry transient Agent SDK errors (rate limits)
            try:
                answer, n_tool = await answer_with_claude(q["question"], corpus_dir, args.model, max_turns)
                finish, err = "answered", None
                break
            except Exception as e:  # noqa: BLE001
                err = str(e)[:200]
                await asyncio.sleep(8 * (attempt + 1))
        await asyncio.sleep(2)  # pace requests to avoid rate limiting
        try:
            v = await judging.grade(q["question"], q["reference_answer"], q["key_facts"], answer, model=judge_model)
        except judging.JudgeUnavailable as e:
            v = judging.Verdict("error", 0.0, str(e)[:120])
        rows.append({
            "id": q["id"], "difficulty": q["difficulty"], "source_doc": q["source_doc"],
            "answer": answer, "steps": n_tool, "finish": finish, "error": err,
            "n_tool_calls": n_tool, "elapsed_s": round(time.monotonic() - qs, 1),
            "verdict": v.verdict, "score": v.score, "rationale": v.rationale,
            "grader": v.grader, "raw": v.raw,
        })
        mark = {"correct": "✓", "partial": "~", "incorrect": "✗"}.get(v.verdict, "✗")
        print(f"  {q['id']} {q['difficulty']:6} {mark} {v.verdict:9} | {q['question'][:48]} -> {answer[:60]!r}")

    summary = summarize(rows, label, args.model, round(time.monotonic() - t0))
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    run_record = {"started": datetime.now().isoformat(timespec="seconds"), "judge": judge_model, "models": [summary]}
    rdir = LAB / cfg["paths"].get("results_dir", "results")
    write_outputs(run_record, testset, stamp + "-ref", rdir=rdir)
    print(f"\n=> {summary['pct']}%  ({summary['correct']}✓ {summary['partial']}~ {summary['incorrect']}✗)  over {summary['n_scored']}Q")


if __name__ == "__main__":
    asyncio.run(main())
