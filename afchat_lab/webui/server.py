"""Local web UI for afchat_lab: control runs and visualize the leaderboard.

Run from afchat_lab/ with the venv active:
    uvicorn webui.server:app --reload --port 8731
or:
    python -m webui.server

Then open http://localhost:8731
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path

import yaml
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse

LAB = Path(__file__).resolve().parent.parent
WEBUI = Path(__file__).resolve().parent
RESULTS = LAB / "results"

app = FastAPI(title="afchat_lab")

# Single active run (this is a single-user local tool).
RUN: dict = {"proc": None, "lines": [], "status": "idle", "started": None, "cmd": None}


def load_config() -> dict:
    return yaml.safe_load((LAB / "config.yaml").read_text())


def load_testset() -> dict:
    return json.loads((LAB / load_config()["paths"]["testset"]).read_text())


def _board(models: list[dict]) -> list[dict]:
    return sorted(models, key=lambda m: m.get("pct", 0), reverse=True)


def list_runs() -> list[dict]:
    if not RESULTS.exists():
        return []
    out = []
    for f in sorted(RESULTS.glob("run-*.json"), reverse=True):
        try:
            d = json.loads(f.read_text())
        except Exception:  # noqa: BLE001
            continue
        out.append(
            {
                "name": f.name,
                "started": d.get("started"),
                "models": [
                    {k: m.get(k) for k in ("label", "pct", "correct", "partial", "incorrect", "avg_steps", "n")}
                    for m in _board(d.get("models", []))
                ],
            }
        )
    return out


@app.get("/", response_class=HTMLResponse)
def index() -> str:
    return (WEBUI / "index.html").read_text()


@app.get("/api/state")
def state() -> dict:
    cfg = load_config()
    ts = load_testset()
    return {
        "models": cfg["models"],
        "judge": cfg["judge"],
        "lmstudio": {k: cfg["lmstudio"].get(k) for k in ("context_length", "base_url", "manage_models")},
        "testset": {"name": ts["meta"]["name"], "count": len(ts["questions"])},
        "runs": list_runs(),
        "run_status": RUN["status"],
    }


@app.get("/api/runs/{name}")
def get_run(name: str) -> JSONResponse:
    if not re.fullmatch(r"run-[0-9-]+\.json", name):
        raise HTTPException(400, "bad name")
    f = RESULTS / name
    if not f.exists():
        raise HTTPException(404, "not found")
    return JSONResponse(json.loads(f.read_text()))


@app.get("/api/questions")
def questions() -> JSONResponse:
    return JSONResponse(load_testset())


@app.get("/api/corpus")
def corpus() -> list[dict]:
    cdir = LAB / load_config()["paths"]["corpus_dir"]
    out = []
    for f in sorted(cdir.glob("*.md")):
        text = f.read_text()
        title = next((ln[2:].strip() for ln in text.splitlines() if ln.startswith("# ")), f.stem)
        out.append({"file": f.name, "title": title, "words": len(text.split())})
    return out


@app.get("/api/corpus/{name}")
def corpus_doc(name: str) -> JSONResponse:
    if not re.fullmatch(r"[\w.\-]+\.md", name):
        raise HTTPException(400, "bad name")
    f = LAB / load_config()["paths"]["corpus_dir"] / name
    if not f.exists():
        raise HTTPException(404, "not found")
    return JSONResponse({"file": name, "text": f.read_text()})


async def _reader(proc) -> None:
    # Read raw chunks (not whole lines) so streamed tokens reach the UI as they arrive.
    assert proc.stdout is not None
    while True:
        chunk = await proc.stdout.read(256)
        if not chunk:
            break
        RUN["lines"].append(chunk.decode(errors="replace"))
    await proc.wait()
    RUN["lines"].append(f"\n__exit__ {proc.returncode}\n")
    RUN["status"] = "done"


@app.post("/api/run")
async def start_run(req: Request) -> dict:
    if RUN["status"] == "running":
        raise HTTPException(409, "a run is already in progress")
    body = await req.json()
    flags: list[str] = []
    if body.get("limit"):
        flags += ["--limit", str(int(body["limit"]))]
    models = [m for m in body.get("models", []) if m]
    if models:
        flags += ["--models", ",".join(models)]
    if body.get("no_manage"):
        flags.append("--no-manage")

    cmd = [sys.executable, "-u", "-m", "harness.run_eval", *flags]
    RUN.update(status="running", lines=[f"$ {' '.join(cmd)}\n"], started=datetime.now().isoformat(timespec="seconds"), cmd=cmd)
    proc = await asyncio.create_subprocess_exec(
        *cmd, cwd=str(LAB), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
    )
    RUN["proc"] = proc
    asyncio.create_task(_reader(proc))
    return {"ok": True, "cmd": cmd}


@app.post("/api/run/stop")
async def stop_run() -> dict:
    proc = RUN.get("proc")
    if RUN["status"] != "running" or proc is None:
        raise HTTPException(409, "no run in progress")
    RUN["status"] = "stopping"
    RUN["lines"].append("__stop__ requested by user — terminating run")
    try:
        proc.terminate()
    except ProcessLookupError:
        pass
    # Free any model the run had loaded so it doesn't sit in RAM.
    try:
        p = await asyncio.create_subprocess_exec("lms", "unload", "--all",
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
        await p.wait()
    except Exception:  # noqa: BLE001
        pass
    return {"ok": True}


@app.get("/api/run/stream")
async def run_stream() -> StreamingResponse:
    async def gen():
        idx = 0
        # Replay buffered lines, then follow until the run ends.
        while True:
            lines = RUN["lines"]
            while idx < len(lines):
                yield f"data: {json.dumps(lines[idx])}\n\n"
                idx += 1
            if RUN["status"] != "running":
                yield f"event: done\ndata: {json.dumps(RUN['status'])}\n\n"
                return
            await asyncio.sleep(0.4)

    return StreamingResponse(gen(), media_type="text/event-stream")


def main() -> None:
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8731)


if __name__ == "__main__":
    main()
