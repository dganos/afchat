"""Run the document-QA benchmark: each model answers all questions (as an MCP
filesystem agent), the Claude Agent SDK judge scores each answer, and we emit a
per-model leaderboard.

The Claude judge is required. The run preflights it first; if Claude can't be
reached, the benchmark aborts — there is no fallback grader.

Usage (from afchat_lab/, with .venv active):
    python -m harness.run_eval                     # all models, all questions
    python -m harness.run_eval --limit 3           # first 3 questions (quick smoke)
    python -m harness.run_eval --models nemotron-4b,gemma-4-e2b
    python -m harness.run_eval --no-manage         # don't load/unload models via `lms`
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

import yaml
from mcp import ClientSession
from mcp.client.stdio import stdio_client
from openai import AsyncOpenAI

from harness import judge as judging
from harness.agent import (
    AgentResult,
    answer_question,
    load_fs_server_params,
    mcp_tools_to_openai,
)

LAB = Path(__file__).resolve().parent.parent


_CONFIG_FILE = "config.yaml"


def load_config() -> dict:
    return yaml.safe_load((LAB / _CONFIG_FILE).read_text())


def _std(vals: list[float]) -> float:
    if len(vals) < 2:
        return 0.0
    mean = sum(vals) / len(vals)
    return round(math.sqrt(sum((v - mean) ** 2 for v in vals) / len(vals)), 1)


def _clip(s: str, n: int) -> str:
    """Collapse whitespace and clip to n chars for tidy single-line console output."""
    s = " ".join((s or "").split())
    return s if len(s) <= n else s[: n - 1] + "…"


class _RunLog:
    """Tees sys.stdout to a log file for the duration of a run."""

    def __init__(self, path: Path):
        self._file = path.open("w", encoding="utf-8", buffering=1)  # line-buffered
        self._real = sys.stdout

    def write(self, s: str) -> None:
        self._real.write(s)
        self._file.write(s)
        self._file.flush()

    def flush(self) -> None:
        self._real.flush()
        self._file.flush()

    def log_only(self, s: str) -> None:
        """Write to the log file only — does NOT appear on the console."""
        self._file.write(s)
        self._file.flush()

    def fileno(self) -> int:
        return self._real.fileno()

    def close(self) -> None:
        sys.stdout = self._real
        self._file.close()


def _make_printer(run_log: "_RunLog | None" = None):
    """Stream agent progress to stdout.

    Reasoning text is suppressed on stdout (char-count summary only)
    but written in full to the run log file.
    """
    think_buf: list[str] = []
    in_answer = False

    def emit_think() -> None:
        close_line()   # ensure any open answer line is closed before think summary
        if think_buf:
            full = "".join(think_buf)
            sys.stdout.write(f"  · think: ({len(full)} chars)\n")
            sys.stdout.flush()
            if run_log:
                run_log.log_only(f"{full}\n")
            think_buf.clear()

    def close_line() -> None:
        nonlocal in_answer
        if in_answer:
            sys.stdout.write("\n")
            sys.stdout.flush()
            in_answer = False

    def on_event(kind, *a):
        nonlocal in_answer
        if kind == "reasoning":
            think_buf.append(a[0])
        elif kind == "token":
            if think_buf:
                emit_think()        # flush pending thinking summary before answer starts
            if not in_answer:
                sys.stdout.write("  A: ")
                in_answer = True
            sys.stdout.write(a[0])
            sys.stdout.flush()
        elif kind == "speak_end":
            emit_think()
            close_line()
        elif kind == "tool":
            emit_think()
            close_line()
            name, args = a[0], (a[1] or {})
            astr = ", ".join(f"{k}={_clip(str(v), 48)}" for k, v in args.items())
            sys.stdout.write(f"     → {name}({astr})\n")
            sys.stdout.flush()
        elif kind == "tool_result":
            sys.stdout.write(f"       ↳ {a[1]} chars read\n")
            sys.stdout.flush()

    return on_event


def lms(*args: str) -> tuple[int, str]:
    proc = subprocess.run(["lms", *args], capture_output=True, text=True)
    return proc.returncode, (proc.stdout + proc.stderr).strip()


def model_load(model_id: str, ctx: int, gpu: str | None = None) -> str | None:
    # `gpu` is LM Studio's offload ratio ("off"/"max"/0..1). Big models that fit
    # in RAM but OOM the Metal compute buffer on an 8 GB box need partial CPU
    # offload to load *and* run — so it's a per-model override, not a global.
    extra = ["--gpu", str(gpu)] if gpu is not None else []
    code, out = lms("load", model_id, "--context-length", str(ctx), *extra, "--yes")
    return None if code == 0 else out


def model_unload(model_id: str) -> None:
    lms("unload", model_id)


def model_unload_all() -> None:
    lms("unload", "--all")


async def run(args: argparse.Namespace) -> None:
    cfg = load_config()
    paths = cfg["paths"]
    corpus_dir = str((LAB / paths["corpus_dir"]).resolve())
    testset = json.loads((LAB / paths["testset"]).read_text())
    questions = testset["questions"]
    if args.limit:
        questions = questions[: args.limit]

    models = cfg["models"]
    if args.models:
        wanted = {m.strip() for m in args.models.split(",")}
        models = [m for m in models if m["label"] in wanted or m["id"] in wanted]
    if not models:
        print("No models selected.", file=sys.stderr)
        return

    judge_model = cfg["judge"].get("model", "claude-sonnet-4-6")

    # No Claude, no test. Verify the judge before spending any model inference.
    print(f"Preflight: checking Claude judge ({judge_model}) ...", flush=True)
    try:
        await judging.preflight(judge_model)
    except judging.JudgeUnavailable as e:
        print(f"ABORT — Claude judge unavailable, so the benchmark cannot run.\n  {e}", file=sys.stderr)
        sys.exit(2)
    print("Preflight OK.")

    manage = cfg["lmstudio"].get("manage_models", True) and not args.no_manage
    ctx = int(cfg["lmstudio"].get("context_length", 8192))

    if manage:
        print("Unloading any currently loaded models (clean slate) ...", flush=True)
        model_unload_all()

    params = load_fs_server_params(paths["lmstudio_mcp_json"], paths["mcp_server_name"], corpus_dir)
    client = AsyncOpenAI(
        base_url=cfg["lmstudio"]["base_url"],
        api_key=cfg["lmstudio"]["api_key"],
        timeout=cfg["lmstudio"].get("request_timeout_s", 180),
    )

    cfg_paths = cfg["paths"]
    rdir = LAB / cfg_paths.get("results_dir", "results")
    rdir.mkdir(exist_ok=True)
    live_path = rdir / "run-live.json"

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    run_log = _RunLog(rdir / f"run-{stamp}.log")
    sys.stdout = run_log  # tee all stdout to log

    run_record = {"started": datetime.now().isoformat(timespec="seconds"), "judge": judge_model, "models": []}

    def write_live(label: str, mid: str, rows: list, elapsed: int = 0) -> None:
        if not rows:
            return
        n = len(rows)
        judge_errors = [r for r in rows if r["verdict"] == "error" and r["finish"] != "error"]
        model_errors = [r for r in rows if r["verdict"] == "error" and r["finish"] == "error"]
        scored = [r for r in rows if r["verdict"] != "error" or r["finish"] == "error"]
        n_scored = len(scored)
        total = sum(r["score"] for r in scored)
        live_model = {
            "label": label, "id": mid, "n": n, "n_scored": n_scored, "live": True,
            "correct": sum(r["verdict"] == "correct" for r in rows),
            "partial": sum(r["verdict"] == "partial" for r in rows),
            "incorrect": sum(r["verdict"] == "incorrect" for r in rows),
            "model_errors": len(model_errors),
            "judge_errors": len(judge_errors),
            "score": round(total, 2),
            "pct": round(100 * total / n_scored, 1) if n_scored else 0.0,
            "avg_steps": round(sum(r["steps"] for r in rows) / n, 1),
            "duration_s": elapsed,
            "avg_q_s": round(sum(r["elapsed_s"] for r in rows) / n, 1),
            "std_q_s": _std([r["elapsed_s"] for r in rows]),
            "rows": rows,
        }
        snap = {**run_record, "live": True, "current_model": label,
                "models": run_record["models"] + [live_model]}
        try:
            live_path.write_text(json.dumps(snap, ensure_ascii=False))
        except Exception:
            pass

    async def grade_one(q: dict, answer: str):
        try:
            return await judging.grade(
                q["question"], q["reference_answer"], q["key_facts"], answer, model=judge_model
            )
        except judging.JudgeUnavailable as e:
            return judging.Verdict("error", 0.0, str(e)[:120])

    async def eval_model(session, oai_tools, model):
        label, mid = model["label"], model["id"]
        model_start = time.monotonic()
        print(f"\n=== {label}  ({mid}) ===")
        load_err = None
        if manage:
            # Per-model overrides (optional): a smaller context and/or partial GPU
            # offload for models that can't run at the global default on 8 GB.
            mctx = int(model.get("context_length", ctx))
            gpu = model.get("gpu")
            desc = f"ctx={mctx}" + (f", gpu={gpu}" if gpu is not None else "")
            print(f"  loading ({desc}) ...", flush=True)
            load_err = model_load(mid, mctx, gpu)
            if load_err:
                print(f"  ! load failed: {load_err.splitlines()[-1][:160]}")
        rows = []
        for q in questions:
            # Print the question first so progress is visible while the model thinks.
            print(f"\n  {'-' * 68}")
            print(f"  {q['id']} · {q['difficulty']} · {q['source_doc']}", flush=True)
            print(f"  Q: {_clip(q['question'], 300)}", flush=True)
            q_start = time.monotonic()
            if load_err:
                ar = AgentResult(error=load_err, finish="error")
                print(f"  A: [error] {_clip(load_err, 200)}", flush=True)
            else:
                ar = await answer_question(
                    session, oai_tools, client, mid, corpus_dir, q["question"], cfg["agent"],
                    on_event=_make_printer(run_log),
                )
                if not ar.answer and ar.error:
                    print(f"  A: [error] {_clip(ar.error, 200)}", flush=True)
            v = await grade_one(q, ar.answer)
            rows.append(
                {
                    "id": q["id"], "difficulty": q["difficulty"], "source_doc": q["source_doc"],
                    "answer": ar.answer, "steps": ar.steps, "finish": ar.finish, "error": ar.error,
                    "n_tool_calls": len(ar.tool_calls), "elapsed_s": round(time.monotonic() - q_start, 1),
                    "verdict": v.verdict, "score": v.score, "rationale": v.rationale, "grader": v.grader,
                }
            )
            write_live(label, mid, rows, round(time.monotonic() - model_start))
            q_elapsed = round(time.monotonic() - q_start, 1)
            mark = {"correct": "✓", "partial": "~", "incorrect": "✗"}.get(v.verdict, "✗")
            print(f"  ref: {_clip(q['reference_answer'], 200)}")
            print(f"  judge raw: {v.raw}")
            print(f"  {mark} {v.verdict.upper()}  (steps={ar.steps}, tools={len(ar.tool_calls)}, {q_elapsed}s)")
            print(f"  judge: score={v.score}  {v.rationale}", flush=True)
        if manage:
            model_unload(mid)
        n = len(rows)
        duration_s = round(time.monotonic() - model_start)
        # Judge errors: model answered but Claude couldn't score → exclude from denominator.
        # Model errors: model crashed → count as 0 in denominator.
        judge_errors = [r for r in rows if r["verdict"] == "error" and r["finish"] != "error"]
        model_errors = [r for r in rows if r["verdict"] == "error" and r["finish"] == "error"]
        scored = [r for r in rows if r["verdict"] != "error" or r["finish"] == "error"]
        n_scored = len(scored)
        total = sum(r["score"] for r in scored)
        summary = {
            "label": label, "id": mid, "n": n, "n_scored": n_scored,
            "correct": sum(r["verdict"] == "correct" for r in rows),
            "partial": sum(r["verdict"] == "partial" for r in rows),
            "incorrect": sum(r["verdict"] == "incorrect" for r in rows),
            "model_errors": len(model_errors),
            "judge_errors": len(judge_errors),
            "score": round(total, 2),
            "pct": round(100 * total / n_scored, 1) if n_scored else 0.0,
            "avg_steps": round(sum(r["steps"] for r in rows) / n, 1) if n else 0,
            "duration_s": duration_s,
            "avg_q_s": round(sum(r["elapsed_s"] for r in rows) / n, 1) if n else 0,
            "std_q_s": _std([r["elapsed_s"] for r in rows]) if n else 0.0,
            "rows": rows,
        }
        print(f"  -> {summary['pct']}% over {n_scored}Q  ({summary['correct']}✓ {summary['partial']}~ {summary['incorrect']}✗ {len(model_errors)}💥 {len(judge_errors)}⚖︎)  {duration_s}s")
        return summary

    async with stdio_client(params) as (r, w):
        async with ClientSession(r, w) as session:
            await session.initialize()
            tools = await session.list_tools()
            oai_tools = mcp_tools_to_openai(tools, cfg["agent"]["tool_allowlist"])
            print(f"MCP tools exposed to candidates: {[t['function']['name'] for t in oai_tools]}")
            for m in models:
                run_record["models"].append(await eval_model(session, oai_tools, m))

    write_outputs(run_record, testset, stamp)
    if live_path.exists():
        live_path.unlink()
    run_log.close()


def write_outputs(run_record: dict, testset: dict, stamp: str | None = None) -> None:
    cfg = load_config()
    rdir = LAB / cfg["paths"].get("results_dir", "results")
    rdir.mkdir(exist_ok=True)
    if not stamp:
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    (rdir / f"run-{stamp}.json").write_text(json.dumps(run_record, indent=2, ensure_ascii=False))

    board = sorted(run_record["models"], key=lambda m: m["pct"], reverse=True)
    lines = [
        f"# Leaderboard — {run_record['started']}",
        "",
        f"Test set: {testset['meta']['name']} ({len(testset['questions'])} questions)",
        "",
        "| Rank | Model | Score % | ✓ | ~ | ✗ | Avg steps |",
        "|-----:|-------|--------:|--:|--:|--:|----------:|",
    ]
    for i, m in enumerate(board, 1):
        lines.append(
            f"| {i} | {m['label']} | {m['pct']} | {m['correct']} | {m['partial']} | {m['incorrect']} | {m['avg_steps']} |"
        )
    md = "\n".join(lines) + "\n"
    (rdir / "leaderboard.md").write_text(md)
    print("\n" + md)
    print(f"Saved: {rdir.name}/run-{stamp}.json  and  {rdir.name}/leaderboard.md")


def main() -> None:
    global _CONFIG_FILE
    p = argparse.ArgumentParser(description="afchat_lab document-QA benchmark")
    p.add_argument("--limit", type=int, default=0, help="only the first N questions")
    p.add_argument("--models", type=str, default="", help="comma-separated labels/ids to run")
    p.add_argument("--no-manage", action="store_true", help="do not load/unload models via lms")
    p.add_argument("--config", type=str, default="config.yaml", help="config file to use")
    args = p.parse_args()
    _CONFIG_FILE = args.config
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
