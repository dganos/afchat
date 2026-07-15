"""Run the document-QA benchmark: each model answers all questions (as an MCP
filesystem agent), the Claude Agent SDK judge scores each answer, and we emit a
per-model leaderboard.

The Claude judge is required. The run preflights it first; if Claude can't be
reached, the benchmark aborts — there is no fallback grader.

Usage (from afchat_lab/, with .venv active):
    python -m harness.run_eval                     # all models, all questions
    python -m harness.run_eval --limit 3           # first 3 questions (quick smoke)
    python -m harness.run_eval --models nemotron-4b,gemma-4-e2b
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import sys
import time
from datetime import datetime
from pathlib import Path

import yaml
from mcp import ClientSession
from mcp.client.stdio import stdio_client

from harness import judge as judging
from harness.agent import (
    answer_question_claude,
    answer_question_ollama,
    load_fs_server_params,
    ollama_capabilities,
)
from harness.package import load_package, openai_tools

LAB = Path(__file__).resolve().parent.parent


_CONFIG_FILE = "config_124_long.yaml"


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


def representative_subset(questions: list[dict], n: int) -> list[dict]:
    """Pick n questions spread evenly across the test set (R9).

    A naive first-N smoke run hides deep-document failures: the early questions tend
    to have their facts near the top of their source docs, so a 5Q run can read 5/5
    while later "deep fact" questions silently fail. Evenly spaced sampling always
    includes the last (often hardest) questions, and is deterministic — reproducible
    per NFR-5.
    """
    if n <= 0 or n >= len(questions):
        return questions
    if n == 1:
        return [questions[0]]
    last = len(questions) - 1
    idx = sorted({round(i * last / (n - 1)) for i in range(n)})
    return [questions[i] for i in idx]


def summarize(rows: list[dict], label: str, mid: str, duration_s: int) -> dict:
    """Compute a per-model summary from its question rows.

    Single source of truth for both the live snapshot and the final record, so the
    two can never drift. Error accounting (FR-6):
      - judge error: model answered but Claude couldn't score → excluded from denominator.
      - model error: model crashed (finish=error) → counts as 0, stays in denominator.
    """
    n = len(rows)
    judge_errors = [r for r in rows if r["verdict"] == "error" and r["finish"] != "error"]
    model_errors = [r for r in rows if r["verdict"] == "error" and r["finish"] == "error"]
    scored = [r for r in rows if r["verdict"] != "error" or r["finish"] == "error"]
    n_scored = len(scored)
    total = sum(r["score"] for r in scored)
    return {
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
        elif kind == "retry":
            close_line()
            sys.stdout.write(f"     ⟳ transient error (retry {a[1]}): {a[0]}\n")
            sys.stdout.flush()

    return on_event


async def run(args: argparse.Namespace) -> None:
    cfg = load_config()
    paths = cfg["paths"]
    corpus_dir = str((LAB / paths["corpus_dir"]).resolve())
    testset = json.loads((LAB / paths["testset"]).read_text())
    questions = testset["questions"]
    if args.first:
        questions = questions[: args.first]
    elif args.limit:
        questions = representative_subset(questions, args.limit)

    models = cfg["models"]
    # Per-model candidate packages (afchat_lab/agents/<label>/): an entry may be
    # just `package: agents/qwen3-8b` — id/label/ctx/think come from that package,
    # which EXTENDS the production package (same prompt/tools/runtime; see
    # agents/README.md). Entries without `package` run the production agent.
    for m in models:
        if m.get("package"):
            pm = load_package((LAB / m["package"]).resolve())
            m["_pkg"] = pm
            m.setdefault("id", pm.model["id"])
            m.setdefault("label", pm.model.get("label", pm.model["id"]))
    if args.models:
        # Match config entries by label/id; anything else is an AD-HOC model (e.g.
        # picked from the "downloaded" list in the web UI) — run it with defaults so
        # model selection is not coupled to the config's models: list.
        by_key = {k: m for m in models for k in (m["label"], m["id"])}
        picked: list[dict] = []
        for w in (m.strip() for m in args.models.split(",")):
            if not w:
                continue
            m = by_key.get(w) or {"id": w, "label": w.split("/")[-1], "adhoc": True}
            if m not in picked:
                picked.append(m)
        models = picked
    if not models:
        print("No models selected.", file=sys.stderr)
        return

    # The agent — system prompt + tool contracts + runtime + context window — comes
    # entirely from the agent package, the single source of truth shared with Aristo.
    pkg = load_package((LAB / cfg["package"]).resolve())
    print(f"Agent package: {pkg.summary()}")
    pkg_tools = openai_tools(pkg)
    pkg_ctx = int(pkg.model.get("context_length", 8192))
    _timeout = cfg.get("ollama", {}).get("request_timeout_s", 180)
    # AGENT knobs come ONLY from the shared package — never from a lab config.
    # The lab must behave exactly as Aristo will; a config that quietly changed
    # max_tool_result_chars / num_predict / max_steps would make lab results stop
    # predicting production. request_timeout_s is the lab's own HTTP client
    # timeout (test environment, not agent behavior), so it stays config-level.
    if cfg.get("runtime"):
        sys.exit("Config error: 'runtime:' overrides are not allowed — agent knobs "
                 "live in the shared package (SAME AGENT as Aristo). Edit "
                 f"{cfg['package']}/package.json instead.")
    runtime = {**pkg.runtime, "request_timeout_s": _timeout}

    judge_model = cfg["judge"].get("model", "claude-sonnet-4-6")

    # No Claude, no test. Verify the judge before spending any model inference.
    print(f"Preflight: checking Claude judge ({judge_model}) ...", flush=True)
    try:
        await judging.preflight(judge_model)
    except judging.JudgeUnavailable as e:
        print(f"ABORT — Claude judge unavailable, so the benchmark cannot run.\n  {e}", file=sys.stderr)
        sys.exit(2)
    print("Preflight OK.")

    # Runtime backend: Ollama, native /api/chat (like Aristo). The only backend.
    if "ollama" not in cfg:
        sys.exit("Config error: an 'ollama:' block is required — the lab runs on Ollama only.")
    ollama_base = cfg["ollama"].get("base_url", "http://localhost:11434")
    num_ctx = pkg_ctx  # context window comes from the agent package
    print(f"Backend: Ollama @ {ollama_base}  (num_ctx={num_ctx})")
    # Ad-hoc models carry no config knobs — apply the lab's uniform no-thinking
    # policy from their declared capabilities, and flag tool-less ones up front.
    for m in models:
        if not m.get("adhoc") or m.get("provider") == "claude":
            continue
        caps = ollama_capabilities(ollama_base, m["id"])
        if "thinking" in caps and m.get("think") is None:
            m["think"] = False
            print(f"  {m['label']}: thinking-capable → think=false (lab policy)")
        if caps and "tools" not in caps:
            print(f"  ! {m['label']}: no 'tools' capability — expect tool-call failures")

    params = load_fs_server_params(corpus_dir)

    cfg_paths = cfg["paths"]
    rdir = LAB / cfg_paths.get("results_dir", "results")
    rdir.mkdir(exist_ok=True)
    live_path = rdir / "run-live.json"
    judging.configure_logging(rdir / "judge.log", cfg["judge"].get("log_level"))

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    run_log = _RunLog(rdir / f"run-{stamp}.log")
    sys.stdout = run_log  # tee all stdout to log

    run_record = {"started": datetime.now().isoformat(timespec="seconds"), "judge": judge_model, "models": []}

    def write_live(label: str, mid: str, rows: list, elapsed: int = 0) -> None:
        if not rows:
            return
        live_model = {**summarize(rows, label, mid, elapsed), "live": True}
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
        # Hosted reference candidate (Claude via Agent SDK): its own read-only
        # tools instead of the Ollama + MCP path.
        is_claude = model.get("provider") == "claude" or mid.startswith("claude")
        # Per-model candidate package (or the production default). Everything the
        # agent IS — prompt, tools, runtime, ctx, think — comes from this package.
        mpkg = model.get("_pkg") or pkg
        m_tools = openai_tools(mpkg) if model.get("_pkg") else oai_tools
        m_runtime = {**mpkg.runtime, "request_timeout_s": _timeout}
        m_ctx = int(mpkg.model.get("context_length", 8192))
        m_think = model["think"] if "think" in model else mpkg.model.get("think")
        model_start = time.monotonic()
        print(f"\n=== {label}  ({mid}){'  [reference: Claude Agent SDK]' if is_claude else ''} ===")
        if model.get("_pkg"):
            print(f"  agent package: {mpkg.summary()}")
        rows = []
        for q in questions:
            # Print the question first so progress is visible while the model thinks.
            print(f"\n  {'-' * 68}")
            print(f"  {q['id']} · {q['difficulty']} · {q['source_doc']}", flush=True)
            print(f"  Q: {_clip(q['question'], 300)}", flush=True)
            q_start = time.monotonic()
            if is_claude:
                # Reference baseline: Claude via the Agent SDK with its own tools —
                # not the packaged agent, so it keeps its own minimal prompt.
                ar = await answer_question_claude(
                    corpus_dir, q["question"], m_runtime,
                    on_event=_make_printer(run_log), model=mid,
                )
                if not ar.answer and ar.error:
                    print(f"  A: [error] {_clip(ar.error, 200)}", flush=True)
            else:
                ar = await answer_question_ollama(
                    session, m_tools, ollama_base, mid, corpus_dir, q["question"], m_runtime,
                    on_event=_make_printer(run_log), system_prompt=mpkg.system_prompt,
                    num_ctx=int(model.get("context_length", m_ctx)),
                    think=m_think,
                )
                if not ar.answer and ar.error:
                    print(f"  A: [error] {_clip(ar.error, 200)}", flush=True)
            v = await grade_one(q, ar.answer)
            rows.append(
                {
                    "id": q["id"], "difficulty": q["difficulty"], "source_doc": q["source_doc"],
                    "answer": ar.answer, "steps": ar.steps, "finish": ar.finish, "error": ar.error,
                    "n_tool_calls": len(ar.tool_calls), "elapsed_s": round(time.monotonic() - q_start, 1),
                    "verdict": v.verdict, "score": v.score, "rationale": v.rationale,
                    "grader": v.grader, "raw": v.raw,
                }
            )
            write_live(label, mid, rows, round(time.monotonic() - model_start))
            q_elapsed = round(time.monotonic() - q_start, 1)
            mark = {"correct": "✓", "partial": "~", "incorrect": "✗"}.get(v.verdict, "✗")
            print(f"  ref: {_clip(q['reference_answer'], 200)}")
            print(f"  judge raw: {v.raw}")
            print(f"  {mark} {v.verdict.upper()}  (steps={ar.steps}, tools={len(ar.tool_calls)}, {q_elapsed}s)")
            print(f"  judge: score={v.score}  {v.rationale}", flush=True)
        duration_s = round(time.monotonic() - model_start)
        summary = summarize(rows, label, mid, duration_s)
        print(f"  -> {summary['pct']}% over {summary['n_scored']}Q  ({summary['correct']}✓ {summary['partial']}~ {summary['incorrect']}✗ {summary['model_errors']}💥 {summary['judge_errors']}⚖︎)  {duration_s}s")
        return summary

    async with stdio_client(params) as (r, w):
        async with ClientSession(r, w) as session:
            await session.initialize()
            # The model-facing tool set is the agent package's contracts; the MCP
            # server (list_directory/read_text_file) and the harness grep
            # (search_content) are just the implementations behind those names.
            print(f"Tools exposed to candidates (from package): {pkg.tool_names}")
            for m in models:
                run_record["models"].append(await eval_model(session, pkg_tools, m))

    write_outputs(run_record, testset, stamp, rdir=rdir)
    if live_path.exists():
        live_path.unlink()
    run_log.close()


def write_outputs(run_record: dict, testset: dict, stamp: str | None = None, rdir: Path | None = None) -> None:
    if rdir is None:
        rdir = LAB / load_config()["paths"].get("results_dir", "results")
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
    p.add_argument("--limit", type=int, default=0, help="evenly-spaced sample of N questions (representative smoke subset)")
    p.add_argument("--first", type=int, default=0, help="run the first N questions in order (q01..qN); overrides --limit")
    p.add_argument("--models", type=str, default="", help="comma-separated labels/ids to run")
    p.add_argument("--config", type=str, default="config_124_long.yaml", help="config file to use")
    args = p.parse_args()
    _CONFIG_FILE = args.config
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
