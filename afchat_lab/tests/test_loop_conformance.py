"""Loop-conformance test (lab side).

Replays the shared scenarios in packages/gemma4-qa/loop-conformance-scenarios.json
through the LAB agent loop (answer_question_ollama) with the Ollama chat call and the
tool dispatch mocked, and asserts the recovery-nudge sequence matches the spec.

The APP has a sibling runner (api/loop-conformance.test.js) that asserts the SAME
spec against streamChatResponse. Together they guarantee the two duplicated agent
loops recover identically — the drift that let the app end silently on empty turns.

Run from afchat_lab/ with the venv:
    .venv/bin/python -m unittest tests.test_loop_conformance
"""

from __future__ import annotations

import asyncio
import json
import unittest
from pathlib import Path

import harness.agent as agent
from harness.package import load_package

LAB = Path(__file__).resolve().parent.parent
PKG = load_package(LAB.parent / "packages" / "gemma4-qa")
SPEC = json.loads((PKG.dir / "loop-conformance-scenarios.json").read_text())


def _run_scenario(scn: dict) -> list[str]:
    """Drive the lab loop over one scenario; return the ordered nudge labels fired."""
    rec = PKG.runtime["recovery"]
    label = {
        rec["empty_turn_nudge"]: "empty",
        rec["refusal_pointer_nudge"]: "pointer",
        rec["max_steps_final"]: "final",
    }

    responses: list[dict] = []
    tool_results: list[str] = []
    for t in scn["turns"]:
        if "tools" in t:
            tcs = [{"function": {"name": x["name"], "arguments": x.get("args", {})}} for x in t["tools"]]
            responses.append({"message": {"content": "", "tool_calls": tcs}})
            tool_results.extend(x["result"] for x in t["tools"])
        else:
            responses.append({"message": {"content": t.get("content", ""), "tool_calls": []}})

    resp_iter = iter(responses)
    nudges: list[str] = []

    def fake_chat(base_url, model, messages, tools, num_ctx, temperature, timeout, think=None, num_predict=0):
        # A nudge is the last user message the loop appended before this call.
        if messages and messages[-1].get("role") == "user":
            lab = label.get(messages[-1]["content"])
            if lab and lab not in nudges:
                nudges.append(lab)
        try:
            return next(resp_iter)
        except StopIteration:
            return {"message": {"content": "", "tool_calls": []}}

    tr_iter = iter(tool_results)

    async def fake_dispatch(session, name, args, cap, corpus_dir=None):
        try:
            return next(tr_iter)
        except StopIteration:
            return ""

    orig_chat, orig_dispatch = agent._ollama_chat, agent._dispatch_tool
    agent._ollama_chat = fake_chat
    agent._dispatch_tool = fake_dispatch
    try:
        cfg = {**PKG.runtime, "request_timeout_s": 10}
        asyncio.run(agent.answer_question_ollama(
            session=None, oai_tools=[], base_url="x", model="m",
            corpus_dir=str(LAB), question="Q?", cfg=cfg,
            system_prompt=PKG.system_prompt, num_ctx=1024, think=None,
        ))
    finally:
        agent._ollama_chat = orig_chat
        agent._dispatch_tool = orig_dispatch
    return nudges


class LoopConformanceTest(unittest.TestCase):
    def test_scenarios(self):
        self.assertGreaterEqual(len(SPEC["scenarios"]), 5)
        self.assertEqual(SPEC["max_steps"], PKG.runtime["max_steps"],
                         "scenario spec max_steps must match the package")
        for scn in SPEC["scenarios"]:
            with self.subTest(scenario=scn["name"]):
                self.assertEqual(_run_scenario(scn), scn["expect_nudges"])


if __name__ == "__main__":
    unittest.main()
