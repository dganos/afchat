#!/usr/bin/env python3
"""
bench_aristo_tps.py — Aristo throughput benchmark (tokens/sec), for comparing machines.

Standalone & dependency-free (Python 3 stdlib only). It measures Aristo's *actual*
configuration — same model, same 32k context window, same system prompt + warm-up
that the Aristo app uses — driven through Ollama's native /api/chat exactly like
Aristo's chat path. It reports:

  • generation throughput  (tok/s the model produces the answer)   ← the headline
  • prefill / prompt-eval   (tok/s the model ingests the prompt)

It records the machine (CPU, cores, RAM, OS) so results are comparable across boxes,
and prints one JSON line you can append (--out) to build a side-by-side table.

NOTE: this measures the engine throughput Aristo gets — it deliberately does NOT go
through the app's UI smoothing (smoothStream paces words at ~18ms for display; that's
a cosmetic throttle, not a hardware metric).

Usage:
    python3 bench_aristo_tps.py                         # auto-finds the agent package
    python3 bench_aristo_tps.py --package /path/to/packages/gemma4-qa
    python3 bench_aristo_tps.py --model gemma-4-e4b:latest --num-ctx 32768
    python3 bench_aristo_tps.py --out aristo_tps.jsonl  # append a line per machine

Compare collected results:
    python3 -c "import json;[print(f\"{json.loads(l)['machine']['host']:<16} {json.loads(l)['machine']['cpu'][:22]:<22} gen {json.loads(l)['gen_tps']:>6.1f}  prefill {json.loads(l)['prefill_tps']:>7.1f}\") for l in open('aristo_tps.jsonl')]"
"""
import argparse
import json
import os
import platform
import socket
import subprocess
import time
import urllib.request
from pathlib import Path

# ── Aristo's shipped configuration (defaults; overridden by the real package if found)
ARISTO_MODEL = "gemma-4-e4b:latest"
ARISTO_NUM_CTX = 32768
ARISTO_TEMP = 0


# ── machine info (best-effort, cross-platform, no deps) ───────────────────────
def _sh(cmd):
    try:
        return subprocess.check_output(cmd, stderr=subprocess.DEVNULL).decode().strip()
    except Exception:
        return ""


def cpu_name():
    s = platform.system()
    if s == "Darwin":
        return _sh(["sysctl", "-n", "machdep.cpu.brand_string"]) or platform.processor()
    if s == "Linux":
        try:
            for line in open("/proc/cpuinfo"):
                if line.lower().startswith("model name"):
                    return line.split(":", 1)[1].strip()
        except Exception:
            pass
    return platform.processor() or platform.machine()


def ram_gb():
    s = platform.system()
    try:
        if s == "Darwin":
            return round(int(_sh(["sysctl", "-n", "hw.memsize"])) / 1024**3, 1)
        if s == "Linux":
            for line in open("/proc/meminfo"):
                if line.startswith("MemTotal"):
                    return round(int(line.split()[1]) * 1024 / 1024**3, 1)
        if s == "Windows":
            import ctypes

            class MS(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                            ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                            ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                            ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
            ms = MS(); ms.dwLength = ctypes.sizeof(MS)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(ms))
            return round(ms.ullTotalPhys / 1024**3, 1)
    except Exception:
        pass
    return 0.0


def machine_info():
    return {"host": platform.node() or socket.gethostname(),
            "os": f"{platform.system()} {platform.release()}", "arch": platform.machine(),
            "cpu": cpu_name(), "cores": os.cpu_count(), "ram_gb": ram_gb()}


# ── load Aristo's agent package (model / ctx / temperature / system prompt) ────
def load_package(explicit):
    candidates = []
    if explicit:
        candidates.append(Path(explicit))
    here = Path(__file__).resolve().parent
    candidates += [here / "../../packages/gemma4-qa", here / "../packages/gemma4-qa",
                   Path.cwd() / "packages/gemma4-qa"]
    for base in candidates:
        pkg = base / "package.json"
        if pkg.exists():
            d = json.loads(pkg.read_text())
            spf = base / d.get("system_prompt_file", "system_prompt.md")
            sysmsg = spf.read_text() if spf.exists() else _fallback_prompt()
            return {
                "model": d.get("model", {}).get("id", ARISTO_MODEL),
                "num_ctx": d.get("model", {}).get("context_length", ARISTO_NUM_CTX),
                "temperature": d.get("runtime", {}).get("temperature", ARISTO_TEMP),
                "system": sysmsg, "source": str(base.resolve()),
            }
    return {"model": ARISTO_MODEL, "num_ctx": ARISTO_NUM_CTX, "temperature": ARISTO_TEMP,
            "system": _fallback_prompt(), "source": "embedded defaults (package not found)"}


def _fallback_prompt():
    # ~5k chars, roughly the size of Aristo's QA system prompt, so prefill cost is
    # representative even when the real package file isn't present.
    unit = ("You are Aristo, a question-answering assistant over a document corpus. "
            "You must find and read the relevant files with the read-only filesystem "
            "tools before answering, and ground every claim in the text you read. ")
    return (unit * 24)[:4900]


# ── ollama ────────────────────────────────────────────────────────────────────
def ollama_chat(base, model, messages, num_ctx, num_predict, temperature, timeout):
    payload = {"model": model, "stream": False,
               "options": {"temperature": temperature, "num_ctx": int(num_ctx), "num_predict": int(num_predict)},
               "messages": messages}
    req = urllib.request.Request(base.rstrip("/") + "/api/chat", data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def resolve_model(base, want):
    try:
        with urllib.request.urlopen(base.rstrip("/") + "/api/tags", timeout=10) as r:
            tags = [m["name"] for m in json.loads(r.read()).get("models", [])]
    except Exception as e:
        raise SystemExit(f"ERROR: Ollama not reachable at {base} ({e}). Start it with `ollama serve`.")
    if want in tags:
        return want
    wbase = want.split(":")[0].split("/")[-1]
    for t in tags:
        if t.split(":")[0].split("/")[-1] == wbase:
            return t
    raise SystemExit(f"ERROR: Aristo model '{want}' not installed. Available: {tags}\n"
                     f"Pull it with `ollama pull {want}` or pass --model <tag>.")


def tps(d, kind):
    cnt, dur = d.get(f"{kind}_count", 0), d.get(f"{kind}_duration", 0)  # duration in ns
    return cnt, dur, (cnt / (dur / 1e9)) if dur else 0.0


def filler(n_words, salt):
    base = ("rotor lift collective cyclic pitch torque tail autorotation airspeed altitude "
            "procedure limit emergency checklist engine hydraulic warning").split()
    return f"ref{salt} " + " ".join(base[i % len(base)] for i in range(n_words))


# ── benchmark ─────────────────────────────────────────────────────────────────
# A general-knowledge prompt that reliably elicits a long answer, so the
# generation sample is large enough for a stable tok/s (the model's output speed
# is independent of the prompt's content).
QUESTION = ("Explain in detail, step by step and across several paragraphs, how a helicopter "
            "main rotor produces lift, and how collective pitch, cyclic pitch, and the tail "
            "rotor each control the aircraft. Be thorough.")


def main():
    p = argparse.ArgumentParser(description="Aristo tokens/sec benchmark")
    p.add_argument("--base-url", default="http://localhost:11434")
    p.add_argument("--package", default="", help="path to the agent package dir (auto-detected if omitted)")
    p.add_argument("--model", default="", help="override the Ollama model tag")
    p.add_argument("--num-ctx", type=int, default=0, help="override context window (default: package value)")
    p.add_argument("--runs", type=int, default=5, help="generation runs to average")
    p.add_argument("--num-predict", type=int, default=256, help="tokens to generate per run")
    p.add_argument("--prefill-tokens", type=int, default=4096, help="approx prompt size for the prefill test")
    p.add_argument("--timeout", type=int, default=600)
    p.add_argument("--out", default="", help="append one JSON result line to this file")
    p.add_argument("--json", action="store_true", help="print only the JSON result")
    a = p.parse_args()

    pkg = load_package(a.package)
    model = resolve_model(a.base_url, a.model or pkg["model"])
    num_ctx = a.num_ctx or pkg["num_ctx"]
    temp = pkg["temperature"]
    sysmsg = pkg["system"]
    mi = machine_info()

    if not a.json:
        print(f"Aristo throughput benchmark")
        print(f"Machine : {mi['host']}  ·  {mi['cpu']}  ·  {mi['cores']} cores  ·  {mi['ram_gb']} GB  ·  {mi['os']} {mi['arch']}")
        print(f"Config  : {model}  num_ctx={num_ctx}  temp={temp}  (package: {pkg['source']})")
        print(f"Warming up (load weights + cache the {len(sysmsg)}-char system prefix, like Aristo)…", flush=True)

    # Aristo's exact warm-up: system prompt + a tiny user turn → loads weights, caches prefix.
    ollama_chat(a.base_url, model, [{"role": "system", "content": sysmsg},
                                    {"role": "user", "content": "hi"}], num_ctx, 8, temp, a.timeout)

    # ── generation throughput (prefix cached → isolates output speed) ──
    if not a.json:
        print(f"\nGeneration ({a.runs} runs):\n{'run':>3} {'tokens':>7} {'tok/s':>7} {'wall_s':>7}")
    g_tok = g_ns = 0; g_per = []
    for i in range(1, a.runs + 1):
        t0 = time.monotonic()
        d = ollama_chat(a.base_url, model, [{"role": "system", "content": sysmsg},
                                            {"role": "user", "content": QUESTION}],
                        num_ctx, a.num_predict, temp, a.timeout)
        wall = time.monotonic() - t0
        cnt, dur, t = tps(d, "eval")
        g_tok += cnt; g_ns += dur; g_per.append(round(t, 1))
        if not a.json:
            print(f"{i:>3} {cnt:>7} {t:>7.1f} {wall:>7.1f}")
    gen_tps = g_tok / (g_ns / 1e9) if g_ns else 0.0

    # ── prefill throughput (unique prompt each run → real prefill, no cache reuse) ──
    if not a.json:
        print(f"\nPrefill (~{a.prefill_tokens}-token prompt, unique each run):\n{'run':>3} {'tokens':>7} {'tok/s':>8}")
    p_tok = p_ns = 0
    for i in range(1, 4):
        body = filler(int(a.prefill_tokens / 0.75), salt=f"{i}-{int(time.monotonic()*1000)}")
        d = ollama_chat(a.base_url, model, [{"role": "system", "content": sysmsg},
                                            {"role": "user", "content": body + "\n\nReply OK."}],
                        max(num_ctx, a.prefill_tokens + 1024), 1, temp, a.timeout)
        cnt, dur, t = tps(d, "prompt_eval")
        p_tok += cnt; p_ns += dur
        if not a.json:
            print(f"{i:>3} {cnt:>7} {t:>8.1f}")
    prefill_tps = p_tok / (p_ns / 1e9) if p_ns else 0.0

    result = {"app": "aristo", "machine": mi, "model": model, "num_ctx": num_ctx,
              "num_predict": a.num_predict, "gen_tps": round(gen_tps, 1), "gen_tps_per_run": g_per,
              "prefill_tps": round(prefill_tps, 1), "ts": time.strftime("%Y-%m-%dT%H:%M:%S")}

    if not a.json:
        print("\n" + "=" * 60)
        print(f"  GENERATION : {result['gen_tps']:>7.1f} tok/s   (gemma-4-e4b, Aristo config)")
        print(f"  PREFILL    : {result['prefill_tps']:>7.1f} tok/s")
        print("=" * 60)
    print(json.dumps(result))
    if a.out:
        with open(a.out, "a") as f:
            f.write(json.dumps(result) + "\n")
        if not a.json:
            print(f"(appended to {a.out})")


if __name__ == "__main__":
    main()
