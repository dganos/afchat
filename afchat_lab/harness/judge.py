"""Correctness judge — Claude Agent SDK only.

The Claude Agent SDK grades each candidate answer against the reference answer and
required key facts, returning {verdict, score, rationale}. There is NO fallback:
if the SDK can't run (not installed / not authenticated), the benchmark aborts —
no Claude, no test.

Scoring: correct -> 1.0, partial -> 0.5, incorrect -> 0.0.
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger("judge")
# No-op by default: importing this module must not spew a CWD-relative judge.log.
# Callers opt in via configure_logging(); standalone use stays quiet.
log.addHandler(logging.NullHandler())


def configure_logging(log_path: str | os.PathLike | None = None, level: str | None = None) -> None:
    """Attach a file handler for judge diagnostics.

    Path/level are explicit (callers pass results_dir) or come from the
    AFCHAT_JUDGE_LOG / AFCHAT_JUDGE_LOG_LEVEL env vars. Level defaults to INFO,
    not DEBUG, so the prompt/response of every grade isn't logged unboundedly.
    """
    log_path = log_path or os.environ.get("AFCHAT_JUDGE_LOG")
    if not log_path:
        return
    level_name = (level or os.environ.get("AFCHAT_JUDGE_LOG_LEVEL") or "INFO").upper()
    handler = logging.FileHandler(Path(log_path), encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    log.setLevel(getattr(logging, level_name, logging.INFO))
    # Avoid stacking duplicate handlers if called more than once.
    log.handlers = [h for h in log.handlers if not isinstance(h, logging.FileHandler)]
    log.addHandler(handler)


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
    raw: str = ""


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

    t0 = time.monotonic()
    log.debug("CALL model=%s prompt_len=%d", model, len(prompt))
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
        elapsed = round(time.monotonic() - t0, 2)
        log.debug("OK elapsed=%.2fs response_len=%d response=%s", elapsed, len(text), text[:120])
        return text
    except Exception as e:  # noqa: BLE001 - auth / runtime failure
        elapsed = round(time.monotonic() - t0, 2)
        log.error("FAIL elapsed=%.2fs error=%s", elapsed, e)
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
        return Verdict("incorrect", 0.0, "judge output unparseable", raw=text.strip())
    verdict = str(data.get("verdict", "")).lower().strip()
    score = float(data.get("score", _SCORE.get(verdict, 0.0)))
    return Verdict(verdict, score, str(data.get("rationale", "")), raw=text.strip())
