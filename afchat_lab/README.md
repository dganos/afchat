# afchat_lab

Experiment sandbox for afchat. **Goal: find the best local open-source model for
question-answering over documents (QA-over-docs).**

The lab is tracked in git (it's our work). Only generated run artifacts
(`results/`) and the Python virtualenv (`.venv/`) are ignored.

## How the benchmark works

```
                          ┌─────────────────────────────────────────┐
   question  ───────────► │  Candidate (LM Studio model, as agent)   │
                          │  • driven via OpenAI-compatible API       │
                          │  • reads docs through the filesystem MCP  │
                          │    server already configured in LM Studio │
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

- **Candidate** = a model loaded in LM Studio, driven as an *agent*. Its only access
  to the documents is the **filesystem MCP server already configured in your
  `~/.lmstudio/mcp.json`** (`@modelcontextprotocol/server-filesystem`). We reuse that
  exact server — the harness acts as the MCP *host*: it launches the server pointed at
  `corpus/` (read-only), exposes a read-only subset of its tools to the model, and
  executes each tool call the model makes. This is real QA-over-docs: the model must
  navigate and read files itself. (LM Studio runs MCP only inside its chat app, not via
  the REST API, so the harness has to host the tool loop for headless scoring.)
- **Judge** = the **Claude Agent SDK** scores each answer against the reference answer
  and required key facts. It reuses your local Claude Code login (no API key). It is the
  **only** judge: the run preflights it and **aborts if Claude can't be reached** — no
  Claude, no test. There is no fallback grader.
- **Output** = `results/leaderboard.md` + a full `results/run-<timestamp>.json`.

## Layout

```
afchat_lab/
├── README.md
├── config.yaml              models under test, judge, agent + server settings
├── requirements.txt
├── corpus/                  10 EU-transportation reference docs (~2,000–2,800 words each)
├── testset/
│   └── questions.json       30 questions: reference_answer + key_facts (ground truth)
├── harness/
│   ├── agent.py             MCP host + LM Studio tool-using agent loop (candidate)
│   ├── judge.py             Claude Agent SDK judge (+ key-fact fallback)
│   └── run_eval.py          orchestrator + leaderboard
├── webui/                   local control + visualization dashboard
│   ├── server.py            FastAPI: state, runs, corpus, launch + live SSE stream
│   └── index.html           single-file instrument-deck UI (no build step)
└── results/                 generated run artifacts (git-ignored)
```

## Setup

```bash
cd afchat_lab
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

Prerequisites:
- **LM Studio** with the local server running: `lms server start`
- The candidate models pulled (`lms ls`) — see the `models:` list in `config.yaml`
- For the Claude judge: be logged into Claude Code (no API key needed)

## Run

```bash
source .venv/bin/activate

# Quick smoke (1 model, 2 questions, uses the already-loaded model)
python -m harness.run_eval --no-manage --limit 2 --models nemotron-4b

# Full benchmark: every model in config.yaml × all 30 questions, Claude judge.
# Loads/unloads each model via `lms` automatically.
python -m harness.run_eval
```

Flags: `--limit N`, `--models <labels/ids>`, `--no-manage` (don't load/unload models).
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
- **Control** — select models, set question limit and the load/unload option, hit Launch,
  and watch the run stream live. (Judge is always Claude; the run aborts if it's unreachable.)
- **Leaderboard** — ranked models with score bars and ✓/~/✗ chips, per saved run.
- **Questions** — every (model × question) row, filterable by model/verdict/difficulty;
  expand a row to see the model's answer, the reference, key facts, and the judge's rationale.
- **Corpus** — browse the 10 source documents rendered as markdown.

No build step or CDN — a single `index.html` (system Futura/mono fonts) served by FastAPI,
so it works offline.

## Notes & knobs

- `config.yaml > lmstudio.context_length` (default 8192) is the window each model is
  loaded with. Bigger = more RAM. Tune down for the 8 GB air-gapped target.
- `config.yaml > agent.max_tool_result_chars` truncates tool output to protect small
  context windows.
- **Known finding:** some models (e.g. nemotron-4b) emit tool calls as *raw text*
  instead of the API's structured `tool_calls`, so the harness can't execute them and
  the answer fails. That is a genuine signal about a model's agentic/tool reliability —
  one of the things this benchmark measures.
