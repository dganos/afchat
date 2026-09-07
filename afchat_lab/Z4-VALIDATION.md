# Z4 (A5000) model validation runbook

Goal: decide whether **qwen3:30b-a3b** or **gemma4:26b-a4b-it-qat** replaces the
custom `gemma-4-e4b` as Aristo's production model on the HP Z4 G4 / RTX A5000
(24 GB VRAM). Quality bar: **≥ 89–91% on the 50Q** (the production e4b's level,
measured twice). Speed will be far above the old CPU target either way; measure
it anyway for the record.

Neither candidate runs on the 16 GB M1 dev Mac (19/16 GB weights) — this must be
done on the Z4 (or any 24 GB+ CUDA box).

## One-time setup on the Z4

1. Ollama (the bundled one or system, ≥ 0.31): make sure it serves on
   `http://localhost:11434` with the shared model store.
2. Pull the models (~35 GB total):
   ```
   ollama pull qwen3:30b-a3b
   ollama pull gemma4:26b-a4b-it-qat
   ollama pull bge-m3
   ```
   (plus `gemma-4-e4b` from the GitHub release if you want the baseline re-run.)
3. Python 3.11+, then from `afchat_lab/`:
   `python -m venv .venv && .venv/bin/pip install -r requirements.txt`
4. Judge: `ANTHROPIC_API_KEY` in the environment (the benchmark aborts without it).
5. Node (for the MCP filesystem server used by the agentic harness).

## Speed (tokens/sec) — for the record

Follow the `aristo-tps-bench` skill (`scripts/bench_aristo_tps.py`), one run per
model, and add rows to the skill's reference table:
```
python3 scripts/bench_aristo_tps.py --model qwen3:30b-a3b --out aristo_tps.jsonl
python3 scripts/bench_aristo_tps.py --model gemma4:26b-a4b-it-qat --out aristo_tps.jsonl
```

## Quality — the decision (50Q, qualify first)

Both candidates are already registered in the configs and carry their required
adaptations (qwen3: think=false; gemma4-26b: think=false + the stripped-tools
prompt — stock gemma4 models drop tool calls under the prose tools section).

```
# 10Q qualifiers first (per the qualify-first rule):
.venv/bin/python -m harness.run_eval --config config_124_long_10.yaml --models qwen3-30b-a3b
.venv/bin/python -m harness.run_eval --config config_124_long_10.yaml --models gemma4-26b-a4b

# full 50Q for whichever clears ~80% on the qualifier:
.venv/bin/python -m harness.run_eval --config config_124_long.yaml --models qwen3-30b-a3b,gemma4-26b-a4b
```

Judge wobble is ±4 pts — for a close call, run the 50Q twice (the production
e4b scored 91.0 twice in a row; that's the standard).

## Promotion

Winner ≥ the bar → in `packages/gemma4-qa/package.json` set `model.id` (and
`label`) to it, keep the loser in `agentic_models` (or drop it to save 16–19 GB
of bundle), rebuild the Windows bundle (`build-windows-on-windows.ps1` — it now
stage-checks every `agentic_models` entry), and re-run the app smoke: greeting,
a doc question, an abort-then-ask (the ghost-generation fix logs
`client disconnected mid-response`).

Known per-model facts going in (from the M1 lab, quality is hardware-independent
for same-quant models — but these are DIFFERENT quants than tested, so treat as
priors, not results): qwen3-30b sampled 4✓/5 agentically at IQ2; gemma4 family
Hebrew is proven (91% e4b, 88% RAG e2b-qat); stock-gemma4 + qwen3 both need
think=false in the loop (already configured).
