"""Classic-RAG evaluation: retrieve-then-inject, single model call, no tools.

EXPERIMENTAL lab mode (not the production agent): for each question, retrieve the
top-k corpus blocks by hybrid BM25 + embedding-cosine (reciprocal rank fusion over
the same block index the agentic semantic supplement uses), inject them into ONE
prompt, and score the single-shot answer with the same Claude judge. The point is
a speed/quality comparison against the agentic tool loop: one prefill instead of
~3.4 steps of tool calls.

Usage (from afchat_lab/, venv active; Ollama + bge-m3 required):
    python -m harness.rag_eval --model gemma-4-e4b:latest --limit 10
    python -m harness.rag_eval --model gemma-4-e4b:latest            # full 50Q
    python -m harness.rag_eval --model qwen3:8b --k 12
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import time
from datetime import datetime
from pathlib import Path

import yaml

from harness import judge as judging
from harness.agent import (
    _build_block_index,
    _embed,
    _cosine,
    _strip_marks,
    _rank_blocks,
    _ollama_chat,
    configure_embeddings,
)
from harness.package import load_package
from harness.run_eval import representative_subset, summarize

LAB = Path(__file__).resolve().parent.parent

# FALLBACK ONLY — the live prompt comes from the package rag block (SAME AGENT rule).
RAG_SYSTEM_PROMPT = """You are a document-grounded question-answering assistant.
Answer the user's question using ONLY the document excerpts provided in the message.
Each excerpt line starts with its source file and line number ("file.md:123:").

Rules:
- Ground every statement in the excerpts; never invent, infer, or estimate facts.
- Copy each value and its unit EXACTLY as written — never convert units or substitute another unit's name.
- The SAME label (max speed, weight, pressure...) exists in several documents with DIFFERENT values. FIRST identify which FILE matches the question's subject (aircraft/system name), THEN take the value ONLY from that file's excerpts — a nearly-right value from the wrong file is the most common error. If excerpts conflict, the file whose name/title matches the question's subject wins.
- Answer in the SAME language as the question.
- Be concise: one or two sentences with the exact number(s)/unit(s), term, or short list requested.
- End by naming the file the value came from, in parentheses — e.g. "(medical-equipment.md)".
- If the excerpts truly do not contain the answer, say so briefly.
"""


import hashlib


def _load_enriched_index(corpus_dir: Path) -> list[dict]:
    """The agent's block index, with retrieval text ENRICHED by doc title+filename.

    A block's text often lacks its document's identity (the '## מגבלות משקל' table
    never says 'עיטם' — only the doc title does), so question terms naming the
    platform miss both channels. Retrieval scores against 'title (file)\\nraw';
    the DISPLAYED block stays the original. Enriched embeddings get their own
    disk cache (signature-keyed) alongside the agent's cache.
    """
    index = _build_block_index(corpus_dir)
    titles: dict[str, str] = {}
    for f in sorted(corpus_dir.rglob("*.md")):
        rel = f.relative_to(corpus_dir).as_posix()
        for line in f.read_text(encoding="utf-8", errors="replace").splitlines():
            if line.lstrip().startswith("# "):
                titles[rel] = " ".join(line.lstrip()[2:].split())
                break
    enriched = [f"{titles.get(b['file'], '')} ({b['file']})\n{b['raw']}" for b in index]
    sig = hashlib.sha1(("rag-enrich\x00" + "\x00".join(enriched)).encode()).hexdigest()
    cache = LAB / ".embed_cache_rag_enriched.json"
    vecs = None
    if cache.exists():
        try:
            d = json.loads(cache.read_text())
            if d.get("sig") == sig:
                vecs = d["vecs"]
        except Exception:  # noqa: BLE001
            vecs = None
    if vecs is None:
        print("  embedding enriched retrieval texts (one-time) ...", flush=True)
        vecs = _embed(enriched)
        try:
            cache.write_text(json.dumps({"sig": sig, "vecs": vecs}))
        except Exception:  # noqa: BLE001
            pass
    out = []
    for b, e, v in zip(index, enriched, vecs):
        out.append({**b, "score_text": e, "score_vec": v})
    return out


def _rrf(question: str, index: list[dict], k: int, c: int = 60, top_n: int = 50, depths: "tuple | list" = (8, 4)) -> list[dict]:
    """Top-k blocks by reciprocal-rank fusion of embedding-cosine and block-BM25.

    Fuses only each channel's top_n (standard RRF): fusing FULL rankings lets
    masses of zero-relevance blocks accumulate reciprocal-rank mass and outvote a
    #1-in-one-channel block (observed: a sem-rank-1 answer block missed top-12).
    """
    qv = _embed([question])[0]
    sem = sorted(range(len(index)), key=lambda i: -_cosine(qv, index[i]["score_vec"]))[:top_n]
    words = [w for w in re.split(r"[^\w\"']+", _strip_marks(question.lower())) if len(w) >= 2]
    ranked = _rank_blocks([{"raw": b["score_text"], "disp": str(i)} for i, b in enumerate(index)], words)
    lex = [int(b["disp"]) for b in ranked][:top_n]
    score: dict[int, float] = {}
    for rank, i in enumerate(sem):
        score[i] = score.get(i, 0.0) + 1.0 / (c + rank + 1)
    for rank, i in enumerate(lex):
        score[i] = score.get(i, 0.0) + 1.0 / (c + rank + 1)
    ordered = sorted(score, key=lambda i: -score[i])
    top = ordered[:k]
    # DOC BOOST — the RAG analogue of the agentic catalog win: aggregate fused
    # scores per FILE (sum of its best 3 blocks), pick the top-2 files, and
    # guarantee each file's best in-file blocks a seat. Rescues facts whose block
    # ranks mid-pack in one channel only because the block text lacks the doc's
    # identity (e.g. a weight table that never names the platform).
    by_file: dict[str, float] = {}
    file_blocks: dict[str, list[int]] = {}
    for i in ordered:
        f = index[i]["file"]
        file_blocks.setdefault(f, []).append(i)
        if len(file_blocks[f]) <= 3:
            by_file[f] = by_file.get(f, 0.0) + score[i]
    # Deeper coverage for the #1 file (8 blocks) than the runner-up (4): the top
    # file is very likely the answer's document (observed: the answer table sat
    # at within-file sem rank 8, below a 4-block cut).
    top_files = sorted(by_file, key=lambda f: -by_file[f])[:2]
    for depth, f in zip(depths, top_files):
        infile = sorted((i for i, b in enumerate(index) if b["file"] == f),
                        key=lambda i: -_cosine(qv, index[i]["score_vec"]))[:depth]
        for i in infile:
            if i not in top:
                top.append(i)
    # CONTEXT ORDER: blocks of the #1 subject file first (then #2, then the rest),
    # semantic-best first within each group. The observed failure mode is
    # extraction-under-clutter — the model grabs a near-miss value from a WRONG
    # document that happens to sit earlier in the context; leading with the
    # subject-matching file's blocks makes the right value the first one seen.
    rank_of = {f: r for r, f in enumerate(top_files)}
    top.sort(key=lambda i: (rank_of.get(index[i]["file"], 9),
                            -_cosine(qv, index[i]["score_vec"])))
    return [index[i] for i in top]


def _build_prompt(question: str, blocks: list[dict], char_budget: int) -> str:
    parts, used = [], 0
    for b in blocks:
        t = b["disp"]
        if used + len(t) > char_budget and parts:
            break
        parts.append(t)
        used += len(t)
    ctx = "\n\n".join(parts)
    return f"Document excerpts:\n\n{ctx}\n\nQuestion: {question}"


async def run(args: argparse.Namespace) -> None:
    cfg = yaml.safe_load((LAB / args.config).read_text())
    corpus_dir = (LAB / cfg["paths"]["corpus_dir"]).resolve()
    testset = json.loads((LAB / cfg["paths"]["testset"]).read_text())
    questions = testset["questions"]
    if args.limit:
        questions = representative_subset(questions, args.limit)

    pkg = load_package((LAB / cfg["package"]).resolve())
    configure_embeddings(getattr(pkg, "embed_model", None))
    # RAG knobs from the shared package (SAME AGENT rule) — CLI flags override.
    rag = pkg.rag or {}
    if not args.k:
        args.k = int(rag.get("k", 12))
    if not args.ctx_chars:
        args.ctx_chars = int(rag.get("ctx_chars", 11000))
    rag_prompt = rag.get("system_prompt", RAG_SYSTEM_PROMPT)
    rrf_kw = {"c": int(rag.get("rrf_c", 60)), "top_n": int(rag.get("fuse_top_n", 50)),
              "depths": tuple(rag.get("doc_boost_depths", (8, 4)))}
    judge_model = cfg["judge"].get("model", "claude-sonnet-4-6")
    base = cfg.get("ollama", {}).get("base_url", "http://localhost:11434")
    timeout = cfg.get("ollama", {}).get("request_timeout_s", 600)
    num_ctx = int(pkg.model.get("context_length", 32768))
    num_predict = args.num_predict or int(pkg.runtime.get("num_predict", 2048))

    print(f"RAG eval: model={args.model} k={args.k} ctx_budget={args.ctx_chars} chars")
    print(f"Preflight: checking Claude judge ({judge_model}) ...", flush=True)
    await judging.preflight(judge_model)
    print("Preflight OK.")

    print("Building/loading enriched block index (bge-m3) ...", flush=True)
    index = _load_enriched_index(corpus_dir)
    print(f"  {len(index)} blocks.")

    rdir = LAB / "results_124_long_rag"
    rdir.mkdir(exist_ok=True)
    judging.configure_logging(rdir / "judge.log", cfg["judge"].get("log_level"))

    rows = []
    t_model = time.monotonic()
    for q in questions:
        q_start = time.monotonic()
        blocks = _rrf(q["question"], index, args.k, **rrf_kw)
        prompt = _build_prompt(q["question"], blocks, args.ctx_chars)
        messages = [{"role": "system", "content": rag_prompt},
                    {"role": "user", "content": prompt}]
        err = None
        try:
            resp = await asyncio.to_thread(
                _ollama_chat, base, args.model, messages, None, num_ctx, 0.0, timeout,
                args.think, num_predict,
            )
            answer = ((resp.get("message", {}) or {}).get("content") or "").strip()
        except Exception as e:  # noqa: BLE001
            answer, err = "", str(e)
        elapsed = round(time.monotonic() - q_start, 1)
        try:
            v = await judging.grade(q["question"], q["reference_answer"], q["key_facts"],
                                    answer, model=judge_model)
        except judging.JudgeUnavailable as e:
            v = judging.Verdict("error", 0.0, str(e)[:120])
        mark = {"correct": "✓", "partial": "~", "incorrect": "✗"}.get(v.verdict, "✗")
        hit = any(kf in "".join(b["raw"] for b in blocks) for kf in q["key_facts"])
        print(f"  {q['id']} {mark} {v.verdict:9} {elapsed:6.1f}s  retrieved_answer_present={hit}  {v.rationale[:80]}")
        rows.append({
            "id": q["id"], "difficulty": q["difficulty"], "source_doc": q["source_doc"],
            "answer": answer, "steps": 1, "finish": "error" if err else "answered",
            "error": err, "n_tool_calls": 0, "elapsed_s": elapsed,
            "retrieval_hit": hit,
            "verdict": v.verdict, "score": v.score, "rationale": v.rationale,
            "grader": v.grader, "raw": v.raw,
        })
    duration = round(time.monotonic() - t_model)
    s = summarize(rows, f"rag-{args.model.split('/')[-1]}", args.model, duration)
    hits = sum(r["retrieval_hit"] for r in rows)
    print(f"\n== RAG {args.model}: {s['pct']}% over {s['n_scored']}Q "
          f"({s['correct']}✓ {s['partial']}~ {s['incorrect']}✗)  avg {s['avg_q_s']}s/q  "
          f"retrieval hit-rate {hits}/{len(rows)}")
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    out = rdir / f"rag-{stamp}.json"
    out.write_text(json.dumps({"mode": "classic-rag", "model": args.model, "k": args.k,
                               "ctx_chars": args.ctx_chars, "summary": s}, indent=2, ensure_ascii=False))
    print(f"Saved: {out}")


def main() -> None:
    p = argparse.ArgumentParser(description="classic-RAG benchmark (single-shot, no tools)")
    p.add_argument("--model", required=True)
    p.add_argument("--config", default="config_124_long.yaml")
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--k", type=int, default=0, help="blocks to inject (0 = package value)")
    p.add_argument("--ctx-chars", type=int, default=0, help="context char budget (0 = package value)")
    p.add_argument("--num-predict", type=int, default=0, help="override generation cap (0 = package value)")
    p.add_argument("--think", default=None, type=lambda s: s.lower() == "true",
                   help="true/false to force the think flag; omit for model default")
    args = p.parse_args()
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
