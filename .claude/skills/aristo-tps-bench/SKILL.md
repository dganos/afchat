---
name: aristo-tps-bench
description: Run or explain the Aristo tokens/sec throughput benchmark (gemma-4-e4b via Ollama, Aristo's exact config) to compare performance across machines. Use when asked to "benchmark Aristo", "measure tokens/sec", "test throughput", "compare machines", or "how fast does the model run".
---

# Aristo throughput benchmark (tokens/sec)

Measures **Aristo's actual configuration** — same model (`gemma-4-e4b`), same 32k
context window, same system prompt + warm-up the app uses — driven through
Ollama's native `/api/chat` exactly like Aristo's chat path. It reads Ollama's own
token counters (exact, not estimated) and reports two numbers:

- **generation** — tok/s the model produces the answer (the headline metric)
- **prefill** — tok/s the model ingests the prompt

It deliberately bypasses the UI's `smoothStream` word-pacing (a cosmetic ~18ms/word
display throttle, not a hardware metric).

Script: `afchat_lab/scripts/bench_aristo_tps.py` (standalone, Python 3 stdlib only).

## Prerequisites

- `ollama serve` running
- the model pulled: `ollama pull gemma-4-e4b:latest`
- Python 3 (no pip installs needed)

## Run it (per machine)

```bash
# from the repo (auto-finds Aristo's agent package):
python3 afchat_lab/scripts/bench_aristo_tps.py --out aristo_tps.jsonl

# on a bare machine with only the script copied over (falls back to embedded
# Aristo defaults: gemma-4-e4b:latest, num_ctx 32768, same-size prompt):
python3 bench_aristo_tps.py --out aristo_tps.jsonl
```

Each run prints a table + one JSON line (and appends it to `--out`). Keep the
options identical on every machine for a fair comparison.

Useful flags:
- `--model <tag>` override the Ollama model tag
- `--num-ctx N` override the context window (default: package value, 32768)
- `--runs N` generation runs to average (default 5)
- `--num-predict N` tokens to generate per run (default 256)
- `--prefill-tokens N` prompt size for the prefill test (default 4096)
- `--base-url URL` point at a remote Ollama (default `http://localhost:11434`)
- `--json` print only the JSON line

## Compare across machines

Collect everyone's `aristo_tps.jsonl` into one file, then:

```bash
python3 -c "import json;[print(f\"{json.loads(l)['machine']['host']:<16} {json.loads(l)['machine']['cpu'][:22]:<22} gen {json.loads(l)['gen_tps']:>6.1f}  prefill {json.loads(l)['prefill_tps']:>7.1f}\") for l in open('aristo_tps.jsonl')]"
```

## Reference results

| Machine | CPU | RAM | num_ctx | generation | prefill |
|---|---|---|---|---|---|
| Tsachis-MacBook-Air | Apple M4 (10 cores) | 16 GB | 32768 | **27.7 tok/s** | 363 tok/s |

(macOS 24.5.0 / arm64, gemma-4-e4b:latest, temp 0. Generation is steady at
27–29 tok/s across runs; prefill ~355–375 tok/s on a cold ~4k-token prompt.)

Add a row here as you benchmark each machine.

## Notes

- **Generation tok/s is the number to compare** — it's the sustained output speed
  and is essentially independent of prompt content.
- **Prefill** is fast and mostly one-time: Ollama caches the shared system+tools
  prefix, which is exactly why Aristo warms it up at startup. A unique prompt is
  used each prefill run so the cache can't inflate the number.
- If `gemma-4-e4b` isn't installed the script lists available tags and exits;
  pull it or pass `--model`.
