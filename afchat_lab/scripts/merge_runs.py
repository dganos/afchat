"""Merge per-model full-run JSONs (one model per run file) into a single
leaderboard record + leaderboard.md, as if they were one multi-model run.

The qualify-then-full workflow runs each model as its own `run_eval` invocation,
so every run-*.json holds one model. This stitches the latest FULL run (n == 30)
of every label back into one record for the web UI / report.

Usage: .venv/bin/python scripts/merge_runs.py [results_dir]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from harness.run_eval import write_outputs  # noqa: E402

LAB = Path(__file__).resolve().parent.parent


def main() -> None:
    rdir = LAB / (sys.argv[1] if len(sys.argv) > 1 else "results_he")
    testset = json.loads((LAB / "testset/questions_he.json").read_text())
    n_full = len(testset["questions"])

    latest: dict[str, dict] = {}  # label -> model summary (latest full run wins)
    started = None
    for f in sorted(rdir.glob("run-2*.json")):  # chronological
        rec = json.loads(f.read_text())
        for m in rec.get("models", []):
            if m.get("n") == n_full:
                latest[m["label"]] = m
                started = rec.get("started", started)

    if not latest:
        sys.exit(f"No full ({n_full}-question) runs found in {rdir}")

    merged = {
        "started": started,
        "judge": "claude-sonnet-4-6",
        "merged_from": "latest full run per label (scripts/merge_runs.py)",
        "models": list(latest.values()),
    }
    write_outputs(merged, testset, stamp="merged-full", rdir=rdir)


if __name__ == "__main__":
    main()
