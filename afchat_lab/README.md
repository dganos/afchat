# afchat_lab

Experiment sandbox for afchat. **Goal: find the best local open-source model for
question-answering over documents (QA-over-docs).**

> ## ⚠️ SUPER IMPORTANT — the lab and Aristo run the SAME AGENT
>
> The agent — model, system prompt, tool contracts, and **every runtime knob**
> (`max_steps`, `max_tool_result_chars`, `num_predict`, `temperature`,
> `context_length`) — is defined **once**, in `packages/gemma4-qa/package.json`,
> and loaded by both the lab and the Aristo app. The lab exists to predict how
> Aristo will behave; any lab-side deviation makes its results worthless.
>
> - **Never** tune agent behavior in a lab config. `runtime:` overrides in a
>   config are rejected by the harness on purpose. Fix agent problems in the
>   package, so production changes with the lab.
> - If Aristo doesn't honor a package knob yet, **teach Aristo the knob** (see
>   `api/chat.js`) — don't implement it lab-only.
> - Candidate models each have their OWN configuration folder —
>   `agents/<label>/package.json` — which `extends` the production package and
>   declares only its model block (id, context_length, think). Candidates
>   inherit production's prompt/tools/runtime and cannot silently drift.
>   Promoting a candidate = folding its model block into the production package.
> - Config files own only the test ENVIRONMENT: corpus, testset, judge, backend
>   URL, HTTP client timeout, and which models to run (by production default or
>   by `package: agents/<label>` reference).

The lab is tracked in git (it's our work). Only generated run artifacts
(`results/`) and the Python virtualenv (`.venv/`) are ignored.

## How the benchmark works

```
                          ┌─────────────────────────────────────────┐
   question  ───────────► │  Candidate (Ollama model, as agent)      │
                          │  • driven via Ollama's native /api/chat   │
                          │    (exactly as Aristo drives it)          │
                          │  • reads docs through the filesystem MCP  │
                          │    server the harness launches            │
                          └──────────────┬──────────────────────────┘
                                         │ final answer
                                         ▼
                          ┌─────────────────────────────────────────┐
   reference + key facts ►│  Judge (Claude Agent SDK)                │
                          │  verdict ∈ {correct, partial, incorrect} │
                          │  score   ∈ {1.0, 0.5, 0.0}               │
                          └──────────────┬──────────────────────────┘
                                         ▼
                                   per-model leaderboard
```

- **Candidate** = a model in the Ollama store, driven as an *agent* over Ollama's
  native `/api/chat` — exactly as the Aristo app drives it. Its only access to the
  documents is the **filesystem MCP server**
  (`@modelcontextprotocol/server-filesystem`) — the harness acts as the MCP *host*:
  it launches the server pointed at the corpus (read-only), exposes a read-only subset
  of its tools to the model, and executes each tool call the model makes. This is
  real QA-over-docs: the model must navigate and read files itself.
- **Judge** = the **Claude Agent SDK** scores each answer against the reference answer
  and required key facts. It reuses your local Claude Code login (no API key). It is the
  **only** judge: the run preflights it and **aborts if Claude can't be reached** — no
  Claude, no test. There is no fallback grader.
- **Output** = `results/leaderboard.md` + a full `results/run-<timestamp>.json`.

## Layout

```
afchat_lab/
├── README.md
├── config_124_long.yaml     the benchmark: 50 questions over the 32-doc corpus_124
├── config_124_long_10.yaml  10Q qualifier subset (evenly-spaced, deterministic)
├── config_124_long_5.yaml   5Q smoke subset
├── requirements.txt
├── corpus_124/              32 Hebrew squadron docs (2 real ינשוף manuals + 30 fictional)
├── testset/
│   ├── questions_124_long_corpus.json   50 questions: reference_answer + key_facts
│   ├── questions_124_long_10.json       10Q subset of the above
│   └── questions_124_long_5.json        5Q subset of the above
├── agents/                  per-candidate packages (extend the production package)
├── harness/
│   ├── agent.py             MCP host + Ollama tool-using agent loop (candidate)
│   ├── judge.py             Claude Agent SDK judge
│   ├── package.py           agent-package loader (shared with Aristo)
│   └── run_eval.py          orchestrator + leaderboard
├── webui/                   local control + visualization dashboard
│   ├── server.py            FastAPI: state, runs, corpus, launch + live SSE stream
│   └── index.html           single-file instrument-deck UI (no build step)
└── results_124_long*/       generated run artifacts (git-ignored), per config
```

## Setup

```bash
cd afchat_lab
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

Prerequisites:
- **Ollama** running (`ollama serve`) — models auto-load on first request
- The candidate models pulled (`ollama ls`) — see the `models:` list in the config
- For the Claude judge: be logged into Claude Code (no API key needed)

## Run

```bash
source .venv/bin/activate

# Quick smoke (1 model, 2 questions)
python -m harness.run_eval --limit 2 --models gemma-4-e4b

# Full benchmark: every model in config_124_long.yaml × all 50 questions, Claude judge.
python -m harness.run_eval

# Qualifier / smoke subsets (fixed, evenly-spaced question files)
python -m harness.run_eval --config config_124_long_10.yaml
python -m harness.run_eval --config config_124_long_5.yaml
```

Flags: `--limit N`, `--models <labels/ids>`, `--config <file>` (default `config_124_long.yaml`).
The run preflights the Claude judge and aborts if it can't be reached.

## Web UI

A local dashboard to **control** runs (pick models, judge, options, launch) and
**visualize** outputs (animated leaderboard, per-question drill-down, corpus browser),
with a live console that streams a run as it happens.

```bash
source .venv/bin/activate
python -m webui.server          # serves http://localhost:8731
```

Tabs:
- **Control** — select models, set the question limit, hit Launch, and watch the run
  stream live. (Judge is always Claude; the run aborts if it's unreachable.)
- **Leaderboard** — ranked models with score bars and ✓/~/✗ chips, per saved run.
- **Questions** — every (model × question) row, filterable by model/verdict/difficulty;
  expand a row to see the model's answer, the reference, key facts, and the judge's rationale.
- **Corpus** — browse the 32 source documents rendered as markdown.

No build step or CDN — a single `index.html` (system Futura/mono fonts) served by FastAPI,
so it works offline.

## Notes & knobs

- The context window (`num_ctx`) and every other agent knob (`max_steps`,
  `max_tool_result_chars`, `num_predict`, `temperature`) come from the shared agent
  package (`packages/gemma4-qa/package.json`) — never from a lab config. See the
  SAME AGENT rule above.
- **Known finding:** some models (e.g. nemotron-4b) emit tool calls as *raw text*
  instead of the API's structured `tool_calls`, so the harness can't execute them and
  the answer fails. That is a genuine signal about a model's agentic/tool reliability —
  one of the things this benchmark measures.
