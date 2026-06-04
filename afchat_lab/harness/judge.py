"""Correctness judge — Claude Agent SDK only.

The Claude Agent SDK grades each candidate answer against the reference answer and
required key facts, returning {verdict, score, rationale}. There is NO fallback:
if the SDK can't run (not installed / not authenticated), the benchmark aborts —
no Claude, no test.

Scoring: correct -> 1.0, partial -> 0.5, incorrect -> 0.0.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass


class JudgeUnavailable(RuntimeError):
    """Raised when the Claude Agent SDK judge cannot be reached."""


JUDGE_SYSTEM = (
    "You are a strict, fair grader for a document-QA benchmark. You compare a candidate "
    "answer to a reference answer and a list of required key facts. Reward correctness of "
    "the facts, not wording. Ignore extra correct detail. Output ONLY a JSON object."
)

JUDGE_TEMPLATE = """Grade the candidate answer.

QUESTION:
{question}

REFERENCE ANSWER:
{reference}

REQUIRED KEY FACTS (all must be conveyed for a "correct" verdict):
{key_facts}

CANDIDATE ANSWER:
{candidate}

Rules:
- "correct": every required key fact is present and accurate (paraphrase is fine).
- "partial": some but not all key facts present, or minor inaccuracy.
- "incorrect": key facts missing/wrong, refusal, or no answer.
Output ONLY this JSON: {{"verdict": "correct|partial|incorrect", "score": 1.0|0.5|0.0, "rationale": "<=20 words"}}"""

_SCORE = {"correct": 1.0, "partial": 0.5, "incorrect": 0.0}


@dataclass
class Verdict:
    verdict: str
    score: float
    rationale: str
    grader: str = "claude-agent-sdk"


def _parse_json(text: str) -> dict | None:
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        return None


async def _query_claude(prompt: str, model: str) -> str:
    """Run a single one-shot Claude Agent SDK query. Raises JudgeUnavailable on failure."""
    try:
        from claude_agent_sdk import query, ClaudeAgentOptions
    except Exception as e:  # noqa: BLE001 - not installed
        raise JudgeUnavailable(f"claude-agent-sdk not importable: {e}") from e

    try:
        options = ClaudeAgentOptions(
            system_prompt=JUDGE_SYSTEM,
            allowed_tools=[],
            max_turns=1,
            model=model,
        )
        text = ""
        async for message in query(prompt=prompt, options=options):
            for block in getattr(message, "content", []) or []:
                t = getattr(block, "text", None)
                if t:
                    text += t
        return text
    except Exception as e:  # noqa: BLE001 - auth / runtime failure
        raise JudgeUnavailable(f"Claude judge call failed: {e}") from e


async def preflight(model: str = "claude-sonnet-4-6") -> None:
    """Verify the Claude judge actually works before a run. Raises JudgeUnavailable."""
    text = await _query_claude(
        'Reply with ONLY this JSON: {"verdict": "correct", "score": 1.0, "rationale": "ok"}',
        model,
    )
    if not _parse_json(text):
        raise JudgeUnavailable("Claude judge reachable but did not return parseable JSON")


async def grade(question: str, reference: str, key_facts: list[str], candidate: str, *, model: str = "claude-sonnet-4-6") -> Verdict:
    """Grade with Claude. Raises JudgeUnavailable if the judge can't run."""
    prompt = JUDGE_TEMPLATE.format(
        question=question,
        reference=reference,
        key_facts="\n".join(f"- {k}" for k in key_facts),
        candidate=candidate or "(no answer)",
    )
    text = await _query_claude(prompt, model)
    data = _parse_json(text)
    if not data or "verdict" not in data:
        # Reached Claude but couldn't parse this one answer — score it incorrect, don't fall back.
        return Verdict("incorrect", 0.0, "judge output unparseable")
    verdict = str(data.get("verdict", "")).lower().strip()
    score = float(data.get("score", _SCORE.get(verdict, 0.0)))
    return Verdict(verdict, score, str(data.get("rationale", ""))[:200])
