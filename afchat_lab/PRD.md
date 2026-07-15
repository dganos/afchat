# afchat_lab — Product Requirements Document

**Status:** Working prototype with known issues (see §10)
**Last updated:** 2026-06-07
**Owner:** dganos

---

## 1. Purpose & Goal

afchat_lab is a **local benchmark harness** that answers one question:

> Which locally-runnable, open-source LLM is best at **question-answering over a
> document corpus (QA-over-docs)** — when the model must navigate and read the
> documents itself via tools, on consumer hardware (≤16 GB RAM)?

It is an experiment sandbox for the parent `afchat` app. It runs a fixed set of
questions against a fixed corpus, drives each candidate model as a **tool-using
agent**, and scores every answer with **Claude as the judge**, producing a
per-model leaderboard.

A second mode benchmarks the **same task in Hebrew** (translated corpus + questions)
to evaluate Hebrew-capable models.

---

## 2. Background & Context

- The parent app (`afchat`) does QA over local documents using a local model.
- We need an objective, repeatable way to pick the best local model for that task.
- Constraint: must run on a **16 GB Mac** (target deployment is even tighter — an
  8 GB air-gapped box), so models run **one at a time** and are sized accordingly.
- The benchmark is **agentic**: the model is not handed the documents. It must use
  filesystem tools (`list_directory`, `read_text_file`, `search_files`) to find and
  read the right file, then answer. This measures both **comprehension** and
  **tool-use reliability** — a model that can't emit valid tool calls fails the task,
  which is itself a meaningful signal.

---

## 3. Definitions

| Term | Meaning |
|------|---------|
| **Candidate** | A model under test, served by Ollama, driven as an agent over the native /api/chat endpoint. |
| **Judge** | Claude (via Claude Agent SDK), the sole grader. Compares candidate answer to reference + key facts. |
| **Corpus** | 10 EU-transportation reference documents (markdown, ~2,000–2,800 words each). Hebrew variant: `corpus_he/`. |
| **Test set** | 30 questions, each answerable from a single corpus doc, with a reference answer + required key facts. |
| **Run** | One execution of N models × M questions, producing a timestamped JSON + log + leaderboard. |
| **Verdict** | `correct` (1.0) / `partial` (0.5) / `incorrect` (0.0). Plus operational states: `error`. |

---

## 4. System Architecture

```
                         ┌──────────────────────────────────────────────┐
   question  ──────────► │  Candidate (Ollama model, as an agent)         │
                         │  • native /api/chat (localhost:11434)          │
                         │  • reads docs via filesystem MCP tools          │
                         │    (harness is the MCP host)                    │
                         └───────────────┬────────────────────────────────┘
                                         │ final answer
                                         ▼
                         ┌──────────────────────────────────────────────┐
   reference + key facts►│  Judge (Claude Agent SDK, reuses Claude login) │
                         │  verdict ∈ {correct, partial, incorrect}        │
                         └───────────────┬────────────────────────────────┘
                                         ▼
                       per-model leaderboard + full run log
```

### Components

1. **Harness** (`harness/`, Python, ~750 LOC)
   - `agent.py` — MCP host + tool-using agent loop (the candidate driver).
   - `judge.py` — Claude Agent SDK grader. No fallback: no Claude → no test.
   - `run_eval.py` — orchestrator: runs questions (Ollama auto-loads models),
     calls judge, writes outputs (JSON + `.log` + leaderboard.md + live snapshot).

2. **Web UI** (`webui/`, FastAPI + single-file HTML)
   - `server.py` — REST API + SSE live console stream + run process management.
   - `index.html` — single-page dashboard (no build step, system fonts, offline).

3. **Data**
   - `config.yaml` (EN) / `config_he.yaml` (HE) — models, judge, agent/server settings.
   - `corpus/` + `corpus_he/` — the documents.
   - `testset/questions.json` + `questions_he.json` — ground truth.
   - `results/` + `results_he/` — generated artifacts (git-ignored), incl. per-run
     `judge.log` diagnostics.

4. **Tooling**
   - `scripts/translate_hebrew.py` — Claude-driven generation of the Hebrew corpus/testset.
   - `tests/` — unit tests for the scoring math (`summarize`) and judge JSON parsing.

### Dependencies
- **Ollama** running (`ollama serve`), candidate models pulled; models auto-load
  on first request.
- **Claude Code login** (the judge reuses it; no API key).
- Python 3.10 venv: `mcp`, `PyYAML`, `claude-agent-sdk`, `fastapi`, `uvicorn`.

---

## 5. Functional Requirements

### 5.1 Benchmark execution (harness)
- **FR-1** Run any subset of configured models against any subset (or all) of the questions.
- **FR-2** Drive each candidate as an agent: expose the allowlisted filesystem tools,
  execute each tool call the model makes (pointed read-only at the corpus), loop up to
  `max_steps`, then force a final answer.
- **FR-3** Preflight the Claude judge before any inference; **abort** the whole run if
  Claude is unreachable.
- **FR-4** Ollama auto-loads each model on its first request; no explicit
  load/unload management. Support a per-model `context_length` override.
- **FR-5** Grade every answer with Claude; record verdict, score, rationale, and the
  **raw judge JSON response**.
- **FR-6** Distinguish two failure types:
  - **model error** (`finish=error`): the model/server crashed — counts as 0, stays in denominator.
  - **judge error** (judge couldn't score an answered question): excluded from the scored denominator.
- **FR-7** Write outputs per run: `run-<ts>.json` (full structured data), `run-<ts>.log`
  (complete console output incl. full thinking), `leaderboard.md`. Maintain a
  `run-live.json` snapshot updated after every question; delete it when the run ends.
- **FR-8** CLI flags: `--limit N`, `--models <labels/ids>`, `--config <file>`.

### 5.2 Scoring & metrics
- **FR-9** Per model: `correct/partial/incorrect/model_errors/judge_errors` counts,
  `score`, `pct` (over scored questions), `avg_steps`, total `duration_s`, per-question
  `avg_q_s` and `std_q_s`.
- **FR-10** Per question row: answer, verdict, score, rationale, raw judge JSON, steps,
  tool-call count, elapsed seconds, finish state, source doc, any error.

### 5.3 Web UI
- **FR-11 Control tab** — select models, set question limit (with presets: All / 10Q / 5Q),
  toggle load/unload, Launch, Stop. Live console streams the run.
- **FR-12 Console** — live streamed output with color coding; shows current model name and
  an elapsed timer; thinking shown as `· think: (N chars)` summary (full text only in the log).
- **FR-13 Leaderboard tab** — ranked models with score bars, ✓/~/✗ + error chips, avg steps,
  timing (total + mean±std per Q). Default view = **"Best of all runs"** aggregate (best score
  per model across all runs of the active benchmark); individual runs selectable.
- **FR-14 Logs tab** — one row per run (date, models, scores), expandable to a per-question
  sub-list with the same filters (model/verdict/difficulty). Each question expands to show
  full question, full answer, judge verdict box (raw JSON + rationale), reference, key facts,
  meta. Per-run **📋 View log** (raw colored log modal) and **🗑 Delete**. Partial (stopped)
  runs appear too, with delete.
- **FR-15 Corpus tab** — browse the source documents rendered as markdown (RTL for Hebrew).
- **FR-16 Language switch** — EN 🇪🇺 / HE 🇮🇱 toggle swaps the active config; clears caches,
  reloads models/runs/corpus, switches the UI to RTL for Hebrew.
- **FR-17 RAM meter** — htop-style live memory bar (matches the figure a model load will find).
- **FR-18 Live updates** — leaderboard and logs update during a run (polling `run-live.json`),
  not only at the end.

### 5.4 Hebrew mode
- **FR-19** Provide a translated corpus (`corpus_he/`) and test set (`questions_he.json`),
  produced by `scripts/translate_hebrew.py` (Claude-translated, preserving markdown, numbers,
  units, proper nouns).
- **FR-20** Hebrew benchmark uses Hebrew-capable, **tool-supporting** models. DictaLM 2.0 is
  excluded (no tool-calling); DictaLM 3.0 (1.7B Qwen3-based, 12B Nemotron-based) is used.

---

## 6. Data Model

### Run JSON (`run-<ts>.json`)
```json
{
  "started": "ISO-8601",
  "judge": "claude-sonnet-4-6",
  "models": [
    {
      "label": "gemma-4-e4b", "id": "google/gemma-4-e4b",
      "n": 30, "n_scored": 28,
      "correct": 18, "partial": 1, "incorrect": 9,
      "model_errors": 0, "judge_errors": 2,
      "score": 18.5, "pct": 66.1,
      "avg_steps": 3.6, "duration_s": 412, "avg_q_s": 13.7, "std_q_s": 6.2,
      "rows": [
        {
          "id": "q01", "difficulty": "easy", "source_doc": "01-driving-licences.md",
          "answer": "...", "steps": 3, "finish": "answered", "error": null,
          "n_tool_calls": 2, "elapsed_s": 12.3,
          "verdict": "correct", "score": 1.0,
          "rationale": "...", "grader": "claude-agent-sdk", "raw": "{...}"
        }
      ]
    }
  ]
}
```

### Test-set question
```json
{
  "id": "q01", "source_doc": "01-driving-licences.md",
  "difficulty": "easy|medium|hard", "answer_type": "numeric|term|list|date|explanation|multi",
  "question": "...", "reference_answer": "...", "key_facts": ["125 cc", "11 kW"]
}
```

---

## 7. API Surface (FastAPI, localhost:8731)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/` | Dashboard HTML |
| GET | `/api/state` | Active config models, judge, testset count, runs, run status |
| GET | `/api/memory` | total/used/free RAM |
| GET | `/api/configs` | Active config + available config options |
| POST | `/api/configs/{name}` | Switch active config (blocked while running) |
| GET | `/api/runs/aggregate` | Best score per model across all runs |
| GET | `/api/runs/{name}` | One run's full JSON |
| DELETE | `/api/runs/{name}` | Delete a run |
| GET | `/api/logs` | List `.log` files (with `has_json` flag) |
| GET | `/api/logs/{name}` | Raw log text |
| DELETE | `/api/logs/{name}` | Delete a log (used for partial runs) |
| GET | `/api/questions` | Active test set |
| GET | `/api/corpus` / `/api/corpus/{name}` | Corpus list / one doc |
| POST | `/api/run` | Launch a run (models, limit, no_manage) |
| POST | `/api/run/stop` | Stop the active run (SIGKILL + unload models) |
| GET | `/api/run/live` | Live snapshot (404 if not running) |
| GET | `/api/run/stream` | SSE live console stream |

---

## 8. Non-Functional Requirements

- **NFR-1 Offline** — UI is a single HTML file, system fonts, no CDN/build.
- **NFR-2 Single-user, local** — one active run at a time; no auth.
- **NFR-3 Memory-aware** — models run sequentially; per-model context/offload overrides
  for tight RAM. RAM meter reflects evictable cache.
- **NFR-4 Resilient logging** — run log is line-buffered and flushed per write, so a
  killed/aborted run still has a complete log up to the kill point.
- **NFR-5 Reproducible** — temperature 0; fixed corpus + test set tracked in git.
- **NFR-6 No silent fallback grading** — Claude is the only judge; absence aborts the run.

---

## 9. Key Design Decisions

1. **Agentic, not retrieval-handed** — the model must use tools to read docs. Tool-call
   reliability is part of what we measure (e.g. models that emit tool calls as raw text fail).
2. **Claude as sole judge** — key-fact-anchored grading, no brittle string match, no fallback.
3. **Standard filesystem MCP server** (`@modelcontextprotocol/server-filesystem`) —
   the harness is the MCP *host*; we do not ship a custom server. Pointed read-only
   at the corpus.
4. **System-prompt handling** — models that reject the `system` role (e.g. DictaLM 2.0) are
   incompatible with the agentic design; we select tool-capable models instead of degrading
   the test (rejected: stuffing the whole corpus into the prompt — that is a different test).
5. **Two error classes** — model crash vs judge failure scored differently so a flaky judge
   doesn't unfairly tank a model that actually answered.
6. **Live snapshot file** (`run-live.json`) — decouples the long-running eval subprocess from
   the UI; survives a UI server restart.
7. **Whole-document reads, with visible truncation** — `max_tool_result_chars` and
   `context_length` are sized to hold an entire corpus doc in a single `read_text_file`
   (corpus docs run ~14k chars). Root-cause analysis of gemma-4-e4b showed a 6 KB cap
   silently dropped >half of each doc, so the model could not see the answer span and
   wrongly refused. When a read still exceeds the cap it now carries an explicit
   `[TRUNCATED …]` marker, and the system prompt directs the model to `search_files`
   (content match) and to read the whole file before concluding a fact is missing.
8. **Representative smoke subset** — `--limit N` samples N questions evenly across the
   test set (not the first N), so a quick run still exercises deep-document questions
   whose facts sit late in their source doc. Deterministic, so it stays reproducible.

---

## 10. Known Issues / Open Bugs

> These are **current, real** defects. This section is the honest state of the prototype.

- **BUG-1 (fixed) — Stop button unreliable.** The launch now persists the child PID to
  `.run.pid`; `POST /api/run/stop` falls back to killing by PID (and finalizing state +
  clearing the live snapshot) when the in-process handle is gone. Residual: an
  in-flight model call may still hold resources briefly after SIGKILL.
- **BUG-2 (mitigated, watch) — Live-console token duplication.** Caused by watchdog
  reconnects opening overlapping SSE streams during slow (80s/Q) generation. Mitigated via
  empty-data keepalives + single-EventSource guard + 15s watchdog. Verify under the 12B model.
- **BUG-3 (fixed) — UI server restart orphans a running eval.** On startup the server
  reconciles `.run.pid`: a still-alive PID is re-adopted as the active run (stoppable by
  PID), a dead one has its stale pidfile + `run-live.json` cleaned up. Live-leaderboard
  polling continues for a re-adopted run; the live token stream does not (handle was lost).
- **LIMITATION — DictaLM 2.0** cannot do tool calling (Mistral/Zephyr template, user/assistant
  roles only). Excluded from the benchmark by design.

---

## 11. Models Under Test (current)

### EN (`config.yaml`)
| Label | ID / package |
|-------|---------------|
| gemma-4-e4b | gemma-4-e4b:latest (PRODUCTION, Aristo's package) |
| qwen3-4b | agents/qwen3-4b |
| qwen3-8b | agents/qwen3-8b |

### HE (`config_he.yaml`)
| Label | ID / package |
|-------|---------------|
| gemma-4-e4b | gemma-4-e4b:latest (PRODUCTION, Aristo's package) |
| qwen3-4b / 8b / 14b | agents/qwen3-* |
| dictalm3-1.7b / 12b | agents/dictalm3-* |
| mistral-nemo-12b | agents/mistral-nemo-12b |
| claude-sonnet-ref | claude-sonnet-4-6 (hosted reference) |

---

## 12. Usage

```bash
cd afchat_lab
python3.10 -m venv .venv && .venv/bin/pip install -r requirements.txt

# Prereqs: ollama serve ; models pulled ; logged into Claude Code

# CLI
.venv/bin/python -m harness.run_eval --models gemma-4-e4b --limit 5
.venv/bin/python -m harness.run_eval --config config_he.yaml   # Hebrew

# Web UI
.venv/bin/python -m webui.server   # http://localhost:8731

# Tests
.venv/bin/python -m unittest discover -s tests
```

---

