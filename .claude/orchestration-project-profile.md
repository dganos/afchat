# Orchestration project profile — Aristo (afchat)

**Purpose:** The project-specific half of the rules for multi-agent tasks in this repo: facts that hold for every such task, the registry of tasks, the rules for a new task. The general rules are in the skill `multi-agent-orchestration-playbook`. An orchestrator reads this file right after the goal and the target are agreed.
**Last updated:** 21.11.2026

> **Update guidelines:** This file is a living document. Update it when a fact about the project changes, or when a task is added, paused or closed. Change only what new information requires — no cosmetic edits. An orchestrator edits only its own row in the task registry. It proposes every other change to the owner.

## Where the rules live
| Item | Place |
|---|---|
| The skill | `.claude/skills/multi-agent-orchestration-playbook/SKILL.md`. A copy of the skill in `dganos/ahithophel` (version 1, 21.11.2026). Never edit it here; when the source changes, replace the copy as a whole |
| This profile | `.claude/orchestration-project-profile.md`. The only copy |
| Lessons | A lesson about this project is written here. A general lesson is proposed as an edit to the skill in its source repo |

## Facts for every task
| Field | Value |
|---|---|
| People | Dgani (owner of every task unless a charter says otherwise) |
| Repo | `dganos/afchat`. `api/` (API server + agent loop), `app/` + `components/` (Next.js UI), `packages/gemma4-qa/` (the agent package — SAME AGENT rule: agent behavior is tuned only there), `afchat_lab/` (benchmark lab), `scripts/` (build/release) |
| Repo rules | Cloud sessions develop on their assigned `claude/` branch and push only there. No PR unless the owner asks. Never force push. Never commit `resources/models/`, `resources/ollama/` or build output |
| Machines | The owner's Windows dev box and target machines run the real app with the bundled Ollama. Cloud sessions have Node but **no Ollama and no models**: anything that needs the real model is verified on the owner's machine, or against a mocked Ollama stream, and the report says which |
| Model starting split | Code: the strongest model, high effort. Review: strong, medium–high. Mechanical work: cheap, low |
| Language | Repo files in English. UI strings stay Hebrew-first. Summaries for the owner in Hebrew, in short sentences |

## Task registry
| Task | Folder | Owner | Holds outside its folder | State |
|---|---|---|---|---|
| — | — | — | — | — |

## Rules for a new task
1. Open a new top-level folder under `orchestration/<task-name>/`. Never write into another task's folder.
2. Add a row to the registry before setup.
3. Start the names of sub-agents, scheduled tasks and branches with the task's name.
4. Work that one agent can finish in one session does not get a task folder — say so and do it directly (skill, "When to use it").

## Claude Code notes
See the same section in `dganos/ahithophel/.claude/orchestration-project-profile.md` (read 21.11.2026). The facts there about sub-agents, scheduled tasks and permissions hold here too; recheck the docs before relying on them.
