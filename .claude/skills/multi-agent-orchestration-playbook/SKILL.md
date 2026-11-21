---
name: "multi-agent-orchestration-playbook"
description: "Use before planning a large task that needs an orchestrator and several agents over hours or days, such as a test lab, scheduled agents, a long build or parallel research (מעבדת בדיקות, אורקסטרציה, סוכנים מתוזמנים). Not for one-session work."
---

# Multi-agent orchestration playbook

Version 1, 21.11.2026. Rules for an orchestrator that sets up and runs a large task with several agents. "The owner" is the person the task is for.

## Core rules
Five things matter most: the goal and the target are agreed before any work (section 1); one orchestrator plans and owns progress but does not do the roles' work (2); one shared folder, with one writer per file (4); a script before an agent, and a model chosen by the work and the budget (7); nothing is left to run alone before the launch checks pass (9).

## When to use it, and how strictly
- Use it when the task runs for hours or days, does not fit in one context, or needs roles that work in parallel or check each other. If one agent can finish the task in one session, say so and do not use it: several agents cost many times the tokens of one.
- Sections 1–11 are principles and always hold. The role list, the folder layout, the file names and the model starting points are defaults: adapt them to the task and note each change in the charter.
- If a principle does not fit the task, tell the owner and propose a change. Do not bend it silently.

## 1. Gate 0: the goal and the target are agreed
Nothing is built before this gate.
1. Ask the kickoff questions once, together. Skip what the owner already answered.
2. Say plainly if the goal cannot be measured, if the target does not fit the budget, or if a simpler setup would do the job.
3. Write back, in five lines at most: the goal, the target (a number or a state that can be checked), what "done" means, and what is out of scope.
4. Start only after the owner says yes to that text. Save it at the top of the charter.
5. If the goal or the target changes later, stop new work and come back to this gate.

**Kickoff questions:**
1. Goal: what should be true at the end, in one sentence?
2. Target: which number or checkable state shows we got there, and by when?
3. Scope: what may change, and what must not be touched?
4. Resources: which repos, machines, accounts and tools? Who else uses them?
5. Budget: what are you willing to spend (money, tokens, or a share of the usage limit), how much machine time, and what is the balance now? Is a model off limits, always or at certain hours?
6. Permissions: what may agents do without asking (push, deploy, delete, spend), and what never?
7. Reporting: when do you want to hear, and what counts as urgent?
8. Test run: may the orchestrator run one small end-to-end test on its own?

## 2. The orchestrator
**Does:**
1. Passes gate 0 with the owner.
2. Reads the project profile and adds the task to its registry (section 12).
3. Writes the charter (section 3) and a plan in stages (section 11).
4. Sets up only the roles the goal needs. It starts from the minimum and adds a role only when a bottleneck shows.
5. Writes each role's run prompt (section 5) and chooses its model and thinking level (section 7).
6. Runs the launch checks before anything is left alone (section 9).
7. On every wake-up reads, in this order: `owner-notes.md`, `status/`, open questions. Then it fixes the queue, the schedule and the budget. It owns the schedule.
8. Checks numbers against the results ledger before any report to the owner.
9. Settles a disagreement between roles, or passes it to the owner.

**Does not:** do the roles' work (run tests, write product code), read raw logs, or take product decisions.

**Speaks up at once when:**
- The goal or the target is unclear, or the work shows that it cannot be reached.
- A principle here does not fit the task.
- An access or a permission is missing.
- The budget will run out before the target is reached.
- Results look wrong, or too good.
- There is no progress for two cycles, or the same failure repeats.
- A step cannot be undone.

It sends one short message: the problem, the options, its recommendation, and what goes on meanwhile. Roles raise the same things under `NEEDS` in their reports.

**Protects its own context:**
- State lives in files, not in the conversation. Test: a new session that reads only `CHARTER.md` and `status/` can take over.
- Long reading, and work with many tool calls, go to a sub-agent. The sub-agent returns a report header and paths only.
- It reads a full report only when a status says `blocked` or a number looks wrong.
- At the end of each stage it writes a stage summary to a file. If the conversation is heavy, a new session continues from the files.

## 3. The charter (`CHARTER.md`)
The source of truth for one task. The fields are fixed:

| Field | Content |
|---|---|
| Goal and target | The text the owner agreed to at gate 0, word for word |
| Done | The state that ends the task |
| Scope | What must not change, and what may be tried |
| Resources | Machines, repos, accounts, tools, and who else uses them |
| Access matrix | Per role: each resource and action it needs, and the date it was verified (section 9) |
| Budget | What the owner is willing to spend, machine hours, models that are off limits, and the balance at the start |
| Permissions | What agents may do without asking, and what that approval does not cover |
| Roles | Table: role, model, thinking level and the reason for both, when it runs, how it runs, reads, writes, time limit |
| Stages | The decision rule of each stage, written in advance |
| Known limits | What cannot be done or measured in this setup |
| Stop and handover | How to stop everything, and how another session takes over |

## 4. The shared folder
A folder in the repo, or any place every role can reach. The layout is a default:

| Path | Holds | Writer |
|---|---|---|
| `CHARTER.md` | The charter and the rules | Orchestrator |
| `owner-notes.md` | The owner's directions. Everyone reads it first. It wins over everything | Owner |
| `questions-for-owner.md` | Open questions, each with a recommendation | One of: orchestrator, manager |
| `decisions.md` | Decisions taken, one line each | Orchestrator |
| `access-check.md` | Proof of every access check: date, role, resource, action, result | Orchestrator |
| `STOP` | An empty file. A role that sees it writes one log line and ends | Owner or orchestrator |
| `prompts/<role>.md` | The run prompt of each role | Orchestrator |
| `status/<role>.md` | The role's state, 10 lines at most, overwritten in every session | The role |
| `reports/<role>/` | One report per session | The role |
| `details/` | Full output and logs | Whoever produced it |
| `queue.json` | Work items, in order | Manager |
| `results/ledger.jsonl` | The results ledger: one line per finished item | Runner |
| `tools/` | Scripts: queue, scoring, integrity checks | Developer |

- Each task has its own folder, named after the task. Two tasks never share a folder, a queue, a ledger, a `STOP` file or a role log.
- Everything a task creates outside its folder (scheduled tasks, sub-agents, services, branches) carries the task's name at the start of its name.
- One writer per file. A role that needs a change in a file it does not own asks for it in its own report.
- In a repo: pull right before every push, commit only your own files, never force push.
- Save results after every unit of work, not at the end of a session. A session that dies must not lose results.
- Results are copied as they are. Nobody edits a result line to "fix" it.
- Language: files for agents in English. Summaries for the owner in the owner's language.

## 5. Roles
Pick only what the goal needs. The list is a default: rename, merge or add roles to fit the task.

| Role | Does | Usual start: tier, thinking |
|---|---|---|
| Runner | Runs the queue and records results | A script, no model |
| Collector | Moves the queue and the results between the machine and the folder, deploys versions, checks integrity | Cheap, low |
| Manager | Reads results, sets the queue, writes insights and the summary | Strong, medium to high |
| Writers | Write test cases or content to a spec | Strong, medium |
| Researcher | Checks outside sources and returns options, each with its source | Strong, medium |
| Architect | Turns insights into ranked change proposals | Strong, high |
| Developer | Builds one change at a time, tests it, pushes | The strongest the budget allows, high |
| Reviewer | Checks work, numbers and claims against the source, in a clean context | Strong, medium to high |

Whoever produces a piece of work is never the one who approves it. The same pattern fits other tasks:

| Task | Who produces | Who checks | Unit of work |
|---|---|---|---|
| Research | Researchers in parallel, one per question | Reviewer, against the sources | One question |
| Long build | Developers, one per component | Reviewer or tester | One feature |
| Batch job (migration, mass edit) | Runner script | Checker, on a sample | One batch |

**Every run prompt has the same six parts:**
1. Goal in one line, and what good output looks like.
2. Read first: `STOP`, `owner-notes.md`, your own status, and an exact list of input files.
3. Do: the steps. What a script decides, the agent does not decide.
4. Write: which files, in which format. Only files this role owns.
5. Limits: time, what not to touch, what the role may not decide, what the owner approved and what that approval does not cover.
6. End: the `END` line, the status file, the report.

- **Unattended run:** the agent never asks. It decides inside the rules and writes what is not its call under `NEEDS`.
- **A scheduled task gets a short prompt only:** who the role is, what the owner approved, and "read `prompts/<role>.md` and follow it". The run prompt can then be improved between runs without touching the schedule.
- A session with nothing worth doing is a fine result. The role says so in one line.

**How a role runs:**

| Mechanism | Fits | Limit |
|---|---|---|
| Script or service on the machine | Deterministic, long-running work | Needs access to the machine |
| Scheduled task | A cyclic role that works only against the shared folder | Starts with no memory. Check which tools and access it really has |
| Sub-agent of the orchestrator's session | A role that needs a tool only that session has | Dies with the session |

Prefer a mechanism that does not depend on an open conversation or on a personal computer.

## 6. Reports in three layers
| Layer | Where | Length | Who reads |
|---|---|---|---|
| 1. Status | `status/<role>.md` | 10 lines at most | The orchestrator, on every wake-up |
| 2. Session report | `reports/<role>/` | A fixed header, then free detail | Roles that need it. The orchestrator reads the header only |
| 3. Details | `details/`, the ledger | No limit | Only through a pointer, for a specific question |

The fixed header of every report:

```
ROLE | TIME | TOPIC
STATUS:  done / partial / blocked
DID:     what was done
FOUND:   findings, with numbers
CHANGED: files and commits
NEEDS:   decision or help, and from whom
NEXT:    next step
DETAILS: paths to the full material
```

- A sub-agent returns the header and paths to the orchestrator. Never raw output.
- A number without a path to its source does not count.

## 7. Models and thinking level
For each role the orchestrator chooses the model tier and the thinking level (effort). Both are choices, not fixed values. It writes the choice and the reason in the charter's roles table, and every later change in `decisions.md`.

| Factor | Go higher (stronger model, more thinking) | Go lower |
|---|---|---|
| Judgment needed | Design, analysis, unclear cases, final checks | Mechanical steps with clear rules |
| Cost of a mistake | Expensive, hard to notice, shapes the work after it | Cheap, caught by the next check |
| Volume | Few, short sessions | Frequent or long sessions |
| Speed | Time is not pressing | An answer is needed fast |
| Budget | There is room | The balance is running low |

1. No model where a script will do.
2. Start each role at the cheapest tier and the lowest thinking level that pass its test run. After a measured failure, raise one step on one of the two. Lower a role that passes easily.
3. The budget comes from the owner at gate 0. Plan the roles, and how often they run, to fit it.
4. Keep a count of sessions and tokens per role. Check the balance on every wake-up. If the orchestrator cannot read it, it asks the owner before each long run.
5. When the balance runs low, act in this order: run less often, lower the tier or the thinking of low-risk roles, pause low-value roles. Tell the owner before the ceiling is reached, not after.
6. Put heavy roles after a usage limit resets.
7. Write a fallback for every role, for when its model is not available: another model, or skip the session.
8. Review the choices after the first cycles, at the end of each stage, and when a new model comes out.

## 8. Robustness: no role blocks another
- Each role runs on its own clock and reads whatever is in the folder at that moment. No role waits for another.
- Lock: a `START` line at the start of a session and an `END` line at its end, in the role's own log. A new session that finds a fresh `START` with no `END` ends at once. An old `START` means a dead run, and the new session takes over.
- Every session and every run has a time limit. When time is up: finish the thing in hand, save what is done, write `END` with what was not reached. Never save half a change.
- "Done" is decided by what the run measures (code, input, settings), not by the commit. A script decides what is left to run.
- An item that cannot run is logged as skipped, with the reason. It is not retried forever.
- Every session reads the real state from the source (the version on the machine, the head of the branch). Every result line carries the version it really ran on.
- Copies of results are checked by checksum.
- Shared resource: an agent never cuts a person's run. It waits.
- Two tasks that share a machine, a branch or a usage limit agree in advance who uses what and when. The agreement is written in both charters.

## 9. Launch: nothing runs alone before these checks
1. **Access check.** Fill the access matrix: for every role, each resource and action it needs (read, write, push, reach a machine, call a tool, use a secret). Test each one from the role's real runtime, not from the orchestrator's session. Write every result in `access-check.md`. A role with a missing access does not launch, and the orchestrator tells the owner exactly what to grant.
2. **Permissions.** An approval written in a prompt is not a permission. Check that the runtime itself lets each action through: no approval prompt that nobody will answer, and no automatic block.
3. **End-to-end test run.** One small item goes through the whole chain: queue, run, ledger, status, report, summary.
4. **Who approves the test run.** Small, cheap and reversible: the orchestrator runs it and reports. If it costs machine time or money, or touches a shared resource: ask the owner first.
5. **Each scheduled role is fired once from its real mechanism,** not from the orchestrator's session.
6. **First cycle.** After the first scheduled cycle the orchestrator wakes up and checks that every role really ran: `START` and `END` lines, a fresh status, a ledger line.
7. **Only then tell the owner that the task is running.** Say what was verified and what was not.
8. **Heartbeat.** A status that is not refreshed for two cycles is a fault. The orchestrator tells the owner at once and does not wait for the summary.

## 10. The owner
- Decides: the goal, the target, product decisions, what becomes official, permissions, the budget.
- Every question comes with a recommendation. If the matter is reversible, work goes on by the recommendation, behind a switch. If it is not reversible, or it is a product decision, the role waits and works on what is not blocked.
- Open questions are closed before a long unattended run. An open question leaves empty rounds.
- The summary for the owner is short and fixed: numbers at the start and at the end, what was fixed and proven, what was tried and did not help, what is open, what the owner must decide.

## 11. Stages
0. Gate: goal and target agreed.
1. Setup: charter, folder, scripts, role prompts.
2. Launch checks (section 9).
3. Baseline: measure where things stand before any change.
4. Work loop: propose, build, check, accept or reject, record.
5. Close: verify numbers, summary for the owner, pause the tasks, lessons.

## 12. The project profile
The rules above are the same in every project. What is specific to one project lives in its project profile: a file named `orchestration-project-profile` in the repo or in the project's knowledge. Read it right after gate 0. If there is none, write one and ask the owner where to keep it. It has three parts:
- **Facts for every task:** people and owners, the repo and its rules, machines and how they are shared, deploy rules, access paths already proven, the usual model split, language, hard rules. Also facts about the environment the agents run in: which scheduling mechanisms exist, what each can reach, how permissions are granted. Do not assume these: check the profile or the product docs, or test.
- **Task registry:** one row per task: name, folder, owner, what it holds outside its folder (runners, scheduled tasks, sealed sets), state.
- **Rules for a new task:** add a row to the registry before setup, never read another task's sealed test set, and follow whatever else the project adds.

## 13. Module: test and improvement labs
Use this section when the task measures a system and improves it. In a lab, stage 3 is: fix the base settings, check noise, measure the baseline, build the three sets.

1. The metric and the decision rule are written before anyone reads a result.
2. Check noise first: run the same thing twice. Same result: one run is enough. Different: set a number of repeats, and the smallest difference that counts as a change.
3. Measure a baseline before any change.
4. Three sets. **Regression:** must not fall. **Development:** the fixers see it. **Sealed test:** written by agents that saw no results, read only through a scoring script, never used to write a fix.
5. A fix answers a general cause, with evidence from several runs. Never write a fix from the words of one case.
6. One change per experiment, behind a switch (flag) that is off by default. The official version does not move. When two changes are tested together, nobody knows which one helped.
7. Gates, in order: the regression set did not fall, the development set rose, the sealed set rose. Then the owner decides. A gain that comes from one case is not proof.
8. Quick revert: a fall above a threshold set in advance, confirmed by a second run, is reverted in the next round without waiting for analysis.
9. Fix the measurement before the product. A change in the measurement needs a new baseline.
10. Separation: whoever wrote a fix does not score it. Whoever summed the numbers is not the only one to verify them.

**Capacity:**
- Measure the pace in the first hour. The queue is never longer than what will run before the next review. A script enforces the queue length, not an instruction.
- Split the capacity in advance, for example 30% regression, 40% experiments, 30% sealed set.
- Sample a large set. Do not run all of it.
- Rank change proposals by expected gain per hour of developer time and machine time. Each proposal states the cause and its evidence, the change, how to measure it, and what could fall.
- A regression stays open until the developer's next session. So the developer runs often, in short sessions.

## 14. Improving these rules
- Never change these rules during a task. At close, list the lessons. A lesson about one project goes to its project profile. A general lesson becomes a proposed edit to this skill, for the owner to approve.
- Propose an edit only on evidence: a rule failed, a missing rule cost something, or the owner corrected the same thing twice. Each proposal names the lines it replaces or removes.