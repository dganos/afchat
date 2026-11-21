# Aristo (afchat)

## Working method for large tasks
Setting up or running a large task with several agents (a lab, a long build, a research effort):
use the `multi-agent-orchestration-playbook` skill (`.claude/skills/`) and read
`.claude/orchestration-project-profile.md` before you plan. A role agent inside such a task follows its
own run prompt. Work that one agent can finish in one session is done directly.
