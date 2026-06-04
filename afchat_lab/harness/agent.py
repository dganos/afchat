"""Candidate agent: a local LM Studio model answering questions over the corpus.

The model is driven through LM Studio's OpenAI-compatible API. Its only way to see
the documents is the filesystem MCP server that is ALREADY configured in LM Studio
(`~/.lmstudio/mcp.json`). The harness reuses that exact server (no custom MCP) and
acts as the MCP host: it lists the server's tools, advertises a read-only subset to
the model as OpenAI tools, and executes each tool call the model makes.

This mirrors real "QA over documents": the model must navigate and read files itself.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from mcp import ClientSession, StdioServerParameters


SYSTEM_PROMPT = (
    "You answer questions about EU transportation rules using ONLY the documents "
    "available through your tools. The documents live in the allowed corpus directory; "
    "their file names indicate their topic (e.g. speed limits, driving licences, alcohol).\n\n"
    "Workflow:\n"
    "1. Call list_directory on the corpus directory to see the available files.\n"
    "2. Pick the file whose name best matches the question and call read_text_file on it.\n"
    "3. Find the specific fact and give a short, direct final answer.\n\n"
    "Rules: ground every answer in the documents. Do not invent facts. When you know the "
    "answer, reply with the final answer as plain text and stop calling tools. Keep the "
    "final answer concise (one or two sentences with the exact numbers/terms)."
)


def load_fs_server_params(mcp_json_path: str, server_name: str, corpus_dir: str) -> StdioServerParameters:
    """Build StdioServerParameters by reusing the LM Studio filesystem MCP definition.

    We take the command/args from the user's mcp.json and repoint the allowed
    directory at our corpus, so the candidate is sandboxed to the test documents.
    """
    corpus_dir = str(Path(corpus_dir).resolve())
    path = Path(os.path.expanduser(mcp_json_path))
    command, args = "npx", ["-y", "@modelcontextprotocol/server-filesystem"]
    if path.exists():
        cfg = json.loads(path.read_text())
        servers = cfg.get("mcpServers", {})
        spec = servers.get(server_name)
        if spec and spec.get("command"):
            command = spec["command"]
            # Drop any directory arguments from the original config; we supply our own.
            base = [a for a in spec.get("args", []) if not a.startswith("/")]
            args = base
    return StdioServerParameters(command=command, args=[*args, corpus_dir])


def mcp_tools_to_openai(tools: Any, allowlist: list[str]) -> list[dict]:
    """Convert MCP tool definitions to OpenAI function-tool specs (allowlisted)."""
    out = []
    for t in tools.tools:
        if t.name not in allowlist:
            continue
        out.append(
            {
                "type": "function",
                "function": {
                    "name": t.name,
                    "description": (t.description or "")[:1024],
                    "parameters": t.inputSchema or {"type": "object", "properties": {}},
                },
            }
        )
    return out


@dataclass
class AgentResult:
    answer: str = ""
    steps: int = 0
    tool_calls: list[dict] = field(default_factory=list)
    error: str | None = None
    finish: str = "answered"  # answered | max_steps | error


async def _dispatch_tool(session: ClientSession, name: str, args: dict, cap: int) -> str:
    try:
        res = await session.call_tool(name, args)
        parts = []
        for block in res.content:
            text = getattr(block, "text", None)
            parts.append(text if text is not None else str(block))
        out = "\n".join(parts)
    except Exception as e:  # noqa: BLE001
        out = f"[tool error] {e}"
    return out[:cap]


async def _stream_step(client, model, messages, tools, temperature, emit):
    """One streamed chat completion. Emits content tokens live; returns (content, tool_calls)."""
    kwargs = dict(model=model, messages=messages, temperature=temperature, stream=True)
    if tools is not None:
        kwargs.update(tools=tools, tool_choice="auto")
    stream = await client.chat.completions.create(**kwargs)
    content = ""
    tcs: dict[int, dict] = {}
    async for chunk in stream:
        if not chunk.choices:
            continue
        delta = chunk.choices[0].delta
        # Reasoning models (e.g. *-thinking) stream their chain-of-thought in a
        # separate field; surface it so they don't look frozen while thinking.
        rc = getattr(delta, "reasoning_content", None) or getattr(delta, "reasoning", None)
        if rc:
            emit("reasoning", rc)
        if getattr(delta, "content", None):
            content += delta.content
            emit("token", delta.content)
        for tc in getattr(delta, "tool_calls", None) or []:
            slot = tcs.setdefault(tc.index, {"id": "", "name": "", "args": ""})
            if tc.id:
                slot["id"] = tc.id
            fn = getattr(tc, "function", None)
            if fn and fn.name:
                slot["name"] = fn.name
            if fn and fn.arguments:
                slot["args"] += fn.arguments
    tool_calls = [tcs[i] for i in sorted(tcs)]
    return content, tool_calls


async def answer_question(
    session: ClientSession,
    oai_tools: list[dict],
    client,
    model: str,
    corpus_dir: str,
    question: str,
    cfg: dict,
    on_event=None,
) -> AgentResult:
    """Run the tool-using loop for a single question, streaming progress via on_event.

    on_event(kind, *args) is called with:
      ("speak_start", step)         model is about to generate text
      ("token", text)               a streamed content token
      ("speak_end",)                end of a generation
      ("tool", name, args)          the model invoked a tool
      ("tool_result", name, chars)  tool returned this many chars
    """
    def emit(*a):
        if on_event:
            on_event(*a)

    corpus_dir = str(Path(corpus_dir).resolve())
    cap = int(cfg.get("max_tool_result_chars", 6000))
    max_steps = int(cfg.get("max_steps", 8))
    temperature = float(cfg.get("temperature", 0))

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": f"Allowed corpus directory: {corpus_dir}\n\nQuestion: {question}"},
    ]
    result = AgentResult()

    for step in range(max_steps):
        result.steps = step + 1
        emit("speak_start", step)
        try:
            content, tool_calls = await _stream_step(client, model, messages, oai_tools, temperature, emit)
        except Exception as e:  # noqa: BLE001
            result.error = f"chat.completions error: {e}"
            result.finish = "error"
            return result
        emit("speak_end")

        if not tool_calls:
            result.answer = content.strip()
            result.finish = "answered"
            return result

        # Record the assistant turn (with its tool calls) then execute each call.
        messages.append(
            {
                "role": "assistant",
                "content": content or "",
                "tool_calls": [
                    {"id": t["id"] or f"call_{i}", "type": "function",
                     "function": {"name": t["name"], "arguments": t["args"]}}
                    for i, t in enumerate(tool_calls)
                ],
            }
        )
        for i, t in enumerate(tool_calls):
            try:
                args = json.loads(t["args"] or "{}")
            except json.JSONDecodeError:
                args = {}
            emit("tool", t["name"], args)
            output = await _dispatch_tool(session, t["name"], args, cap)
            result.tool_calls.append({"name": t["name"], "args": args, "chars": len(output)})
            emit("tool_result", t["name"], len(output))
            messages.append({"role": "tool", "tool_call_id": t["id"] or f"call_{i}", "content": output})

    # Out of steps: force a final answer with no tools.
    messages.append(
        {"role": "user", "content": "Based only on the documents you have read, give your final answer now."}
    )
    emit("speak_start", "final")
    try:
        content, _ = await _stream_step(client, model, messages, None, temperature, emit)
    except Exception as e:  # noqa: BLE001
        result.error = f"final answer error: {e}"
        result.finish = "error"
        return result
    emit("speak_end")
    result.answer = content.strip()
    result.finish = "max_steps"
    return result
