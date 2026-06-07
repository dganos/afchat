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
import signal
import subprocess
import sys
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path

import yaml
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse

LAB = Path(__file__).resolve().parent.parent
WEBUI = Path(__file__).resolve().parent

@asynccontextmanager
async def _lifespan(app: FastAPI):
    reconcile_orphan()  # recover/clean a run left behind by a prior server
    yield


app = FastAPI(title="afchat_lab", lifespan=_lifespan)

# Single active run (this is a single-user local tool).
RUN: dict = {"proc": None, "pid": None, "lines": [], "offset": 0, "status": "idle", "started": None, "cmd": None}

ACTIVE_CONFIG: str = "config.yaml"
CONFIG_OPTIONS: list[str] = ["config.yaml", "config_he.yaml", "config_124.yaml"]

# Persisted PID of the eval subprocess. Survives a UI-server restart so an
# orphaned run can still be stopped and stale state reconciled (BUG-1/BUG-3).
PIDFILE = LAB / ".run.pid"


def _write_pidfile(pid: int, cmd: list[str]) -> None:
    try:
        PIDFILE.write_text(json.dumps(
            {"pid": pid, "config": ACTIVE_CONFIG, "started": RUN["started"], "cmd": cmd}
        ))
    except Exception:  # noqa: BLE001
        pass


def _read_pidfile() -> dict | None:
    try:
        return json.loads(PIDFILE.read_text())
    except Exception:  # noqa: BLE001
        return None


def _clear_pidfile() -> None:
    try:
        PIDFILE.unlink()
    except FileNotFoundError:
        pass
    except Exception:  # noqa: BLE001
        pass


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except Exception:  # noqa: BLE001
        return False
    return True


def _clean_live(config: str | None) -> None:
    """Delete the stale run-live.json for the given config's results dir."""
    try:
        cfg = load_config(config)
        live = LAB / cfg["paths"].get("results_dir", "results") / "run-live.json"
        live.unlink(missing_ok=True)
    except Exception:  # noqa: BLE001
        pass


def reconcile_orphan() -> None:
    """On server startup, recover or clean up a run left behind by a prior server.

    If the persisted PID is still alive, adopt it as the active run (we lost the
    asyncio handle but can still stop it by PID). If it's dead, clear the stale
    pidfile and live snapshot.
    """
    info = _read_pidfile()
    if not info:
        return
    global ACTIVE_CONFIG
    pid = info.get("pid")
    if pid and _pid_alive(pid):
        if info.get("config") in CONFIG_OPTIONS and (LAB / info["config"]).exists():
            ACTIVE_CONFIG = info["config"]
        RUN.update(
            proc=None, pid=pid, status="running",
            started=info.get("started"), cmd=info.get("cmd"), offset=0,
            lines=["__reconnected__ recovered orphaned run after server restart\n"],
        )
    else:
        _clean_live(info.get("config"))
        _clear_pidfile()


# Parsed-config cache keyed by name → (mtime, data). Avoids re-reading and
# re-parsing the YAML on every request while still picking up on-disk edits.
_CONFIG_CACHE: dict[str, tuple[float, dict]] = {}


def load_config(cfg: str | None = None) -> dict:
    name = cfg or ACTIVE_CONFIG
    path = LAB / name
    mtime = path.stat().st_mtime
    cached = _CONFIG_CACHE.get(name)
    if cached and cached[0] == mtime:
        return cached[1]
    data = yaml.safe_load(path.read_text())
    _CONFIG_CACHE[name] = (mtime, data)
    return data


def load_testset() -> dict:
    return json.loads((LAB / load_config()["paths"]["testset"]).read_text())


def results_dir() -> Path:
    cfg = load_config()
    return LAB / cfg["paths"].get("results_dir", "results")


def _board(models: list[dict]) -> list[dict]:
    return sorted(models, key=lambda m: m.get("pct", 0), reverse=True)


def list_runs() -> list[dict]:
    if not results_dir().exists():
        return []
    out = []
    for f in sorted(results_dir().glob("run-*.json"), reverse=True):
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


def _total_mem() -> int:
    try:
        return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
    except (AttributeError, ValueError, OSError):
        return 0


def _available_mem() -> int:
    """Realistically allocatable RAM, including reclaimable cache.

    Mirrors the app's api/available-memory.js so the lab's "free" figure
    matches what a model load will actually find available.
    """
    if sys.platform == "darwin":
        try:
            out = subprocess.run(["vm_stat"], capture_output=True, text=True, timeout=1).stdout
            m = re.search(r"page size of (\d+) bytes", out)
            page = int(m.group(1)) if m else 4096
            pages = 0
            for key in ("Pages free", "Pages inactive", "Pages speculative", "Pages purgeable"):
                mm = re.search(rf"{key}:\s+(\d+)", out)
                if mm:
                    pages += int(mm.group(1))
            if pages:
                return pages * page
        except Exception:  # noqa: BLE001
            pass
    elif sys.platform.startswith("linux"):
        try:
            mm = re.search(r"MemAvailable:\s+(\d+)\s+kB", Path("/proc/meminfo").read_text())
            if mm:
                return int(mm.group(1)) * 1024
        except Exception:  # noqa: BLE001
            pass
    return 0


@app.get("/api/memory")
def memory() -> dict:
    total = _total_mem()
    free = _available_mem()
    used = max(0, total - free) if (total and free) else 0
    return {"total": total, "free": free, "used": used}


@app.get("/", response_class=HTMLResponse)
def index() -> str:
    return (WEBUI / "index.html").read_text()


@app.get("/api/configs")
def list_configs() -> dict:
    return {
        "active": ACTIVE_CONFIG,
        "options": [c for c in CONFIG_OPTIONS if (LAB / c).exists()],
    }


@app.post("/api/configs/{name}")
async def set_config(name: str) -> dict:
    global ACTIVE_CONFIG
    if name not in CONFIG_OPTIONS or not (LAB / name).exists():
        raise HTTPException(400, f"unknown config: {name}")
    if RUN["status"] == "running":
        raise HTTPException(409, "cannot switch config while a run is in progress")
    ACTIVE_CONFIG = name
    return {"active": ACTIVE_CONFIG}


@app.get("/api/runs/aggregate")
def aggregate_runs() -> JSONResponse:
    best: dict = {}
    for run_meta in list_runs():
        try:
            d = json.loads((results_dir() / run_meta["name"]).read_text())
        except Exception:
            continue
        for m in d.get("models", []):
            label = m["label"]
            if label not in best or m.get("pct", 0) > best[label].get("pct", 0):
                best[label] = {**m, "best_run": run_meta["name"], "best_started": d.get("started")}
    return JSONResponse({
        "aggregate": True,
        "started": "all runs",
        "models": sorted(best.values(), key=lambda m: m.get("pct", 0), reverse=True),
    })


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
    f = results_dir() / name
    if not f.exists():
        raise HTTPException(404, "not found")
    return JSONResponse(json.loads(f.read_text()))


@app.delete("/api/runs/{name}")
def delete_run(name: str) -> dict:
    if not re.fullmatch(r"run-[0-9-]+\.json", name):
        raise HTTPException(400, "bad name")
    f = results_dir() / name
    if not f.exists():
        raise HTTPException(404, "not found")
    f.unlink()
    # Also remove from cache hint (client handles RUNCACHE)
    return {"deleted": name}


@app.get("/api/logs")
def list_logs() -> JSONResponse:
    rdir = results_dir()
    if not rdir.exists():
        return JSONResponse([])
    entries = []
    for f in sorted(rdir.glob("run-*.log"), reverse=True):
        has_json = (rdir / f.name.replace(".log", ".json")).exists()
        entries.append({"name": f.name, "size": f.stat().st_size, "has_json": has_json})
    return JSONResponse(entries)


@app.delete("/api/logs/{name}")
def delete_log(name: str) -> dict:
    if not re.fullmatch(r"run-[0-9-]+\.log", name):
        raise HTTPException(400, "bad name")
    f = results_dir() / name
    if not f.exists():
        raise HTTPException(404, "not found")
    f.unlink()
    return {"deleted": name}


@app.get("/api/logs/{name}")
def get_log(name: str):
    if not re.fullmatch(r"run-[0-9-]+\.log", name):
        raise HTTPException(400, "bad name")
    f = results_dir() / name
    if not f.exists():
        raise HTTPException(404, "not found")
    from fastapi.responses import PlainTextResponse
    return PlainTextResponse(f.read_text(encoding="utf-8", errors="replace"))


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


MAX_LOG_LINES = 400

async def _reader(proc) -> None:
    # Read raw chunks so streamed tokens reach the UI as they arrive.
    assert proc.stdout is not None
    while True:
        chunk = await proc.stdout.read(4096)
        if not chunk:
            break
        RUN["lines"].append(chunk.decode(errors="replace"))
        if len(RUN["lines"]) > MAX_LOG_LINES:
            trim = MAX_LOG_LINES // 2
            del RUN["lines"][:trim]
            RUN["offset"] += trim
    await proc.wait()
    RUN["lines"].append(f"\n__exit__ {proc.returncode}\n")
    RUN["status"] = "done"
    RUN["pid"] = None
    _clear_pidfile()
    # Clean up stale live file whether run completed or was killed.
    live = results_dir() / "run-live.json"
    if live.exists():
        try:
            live.unlink()
        except Exception:
            pass


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

    cmd = [sys.executable, "-u", "-m", "harness.run_eval", "--config", ACTIVE_CONFIG, *flags]
    RUN.update(status="running", lines=[f"$ {' '.join(cmd)}\n"], offset=0, started=datetime.now().isoformat(timespec="seconds"), cmd=cmd)
    lms_bin = str(Path.home() / ".lmstudio" / "bin")
    run_env = {**os.environ, "PYTHONUNBUFFERED": "1"}
    run_env["PATH"] = lms_bin + os.pathsep + run_env.get("PATH", "")
    proc = await asyncio.create_subprocess_exec(
        *cmd, cwd=str(LAB), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        env=run_env,
    )
    RUN["proc"] = proc
    RUN["pid"] = proc.pid
    _write_pidfile(proc.pid, cmd)
    asyncio.create_task(_reader(proc))
    return {"ok": True, "cmd": cmd}


@app.post("/api/run/stop")
async def stop_run() -> dict:
    proc = RUN.get("proc")
    pid = RUN.get("pid")
    if RUN["status"] != "running":
        raise HTTPException(409, "no run in progress")
    RUN["status"] = "stopping"
    RUN["lines"].append("__stop__ requested by user — terminating run")
    # SIGKILL — can't be caught or ignored, kills immediately even mid-API-call.
    if proc is not None:
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        # Give the process 2s to die, then unload models.
        try:
            await asyncio.wait_for(proc.wait(), timeout=2.0)
        except asyncio.TimeoutError:
            pass
    elif pid:
        # Orphaned run: the server was restarted and lost the asyncio handle, so
        # there's no _reader to drain output or flip status. Kill by persisted PID
        # and finalize state here (BUG-1/BUG-3).
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        RUN["lines"].append(f"\n__exit__ killed orphan pid {pid}\n")
        RUN["status"] = "done"
        _clean_live(ACTIVE_CONFIG)
    RUN["pid"] = None
    _clear_pidfile()
    # Unload models with a timeout so we don't hang here either.
    try:
        lms_path = str(Path.home() / ".lmstudio" / "bin" / "lms")
        p = await asyncio.create_subprocess_exec(lms_path, "unload", "--all",
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
        await asyncio.wait_for(p.wait(), timeout=10.0)
    except Exception:  # noqa: BLE001
        pass
    return {"ok": True}


@app.get("/api/run/live")
def get_live_run() -> JSONResponse:
    if RUN["status"] != "running":
        raise HTTPException(404, "no live run")
    f = results_dir() / "run-live.json"
    if not f.exists():
        raise HTTPException(404, "no live run")
    return JSONResponse(json.loads(f.read_text()))


@app.get("/api/run/stream")
async def run_stream() -> StreamingResponse:
    async def gen():
        # abs_idx is the absolute position across all items ever appended (survives trims).
        # Start 50 items from the end so reconnects catch up quickly.
        abs_idx = max(0, RUN["offset"] + len(RUN["lines"]) - 50)
        while True:
            # Recompute local_idx on EVERY inner iteration so trims that happen
            # between yields are handled correctly (local_idx is always fresh).
            while True:
                local_idx = abs_idx - RUN["offset"]
                if local_idx < 0:       # trim skipped past abs_idx; jump to buffer start
                    local_idx = 0
                    abs_idx = RUN["offset"]
                if local_idx >= len(RUN["lines"]):
                    break               # caught up; wait for more data
                yield f"data: {json.dumps(RUN['lines'][local_idx])}\n\n"
                abs_idx += 1
            if RUN["status"] != "running":
                yield f"event: done\ndata: {json.dumps(RUN['status'])}\n\n"
                return
            # Empty-string data message: client uses it to keep the watchdog alive
            # during slow generation, and skips appending it (empty content).
            yield f"data: {json.dumps('')}\n\n"
            await asyncio.sleep(0.4)

    return StreamingResponse(gen(), media_type="text/event-stream")


def main() -> None:
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8731)


if __name__ == "__main__":
    main()
