"""Candidate agent: a local LM Studio model answering questions over the corpus.

The model is driven through LM Studio's OpenAI-compatible API. Its only way to see
the documents is the filesystem MCP server that is ALREADY configured in LM Studio
(`~/.lmstudio/mcp.json`). The harness reuses that exact server (no custom MCP) and
acts as the MCP host: it lists the server's tools, advertises a read-only subset to
the model as OpenAI tools, and executes each tool call the model makes.

This mirrors real "QA over documents": the model must navigate and read files itself.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from mcp import ClientSession, StdioServerParameters


SYSTEM_PROMPT = """You are a document-grounded question-answering agent. Answer the user's question using ONLY the documents reachable through your tools — never from prior knowledge or assumptions. The file names indicate each document's topic.

## Your tools (read-only)
1. list_directory(path) — lists the files in a directory. Call it first to see which documents exist.
2. search_content(pattern, [path]) — searches for text INSIDE the documents (a content/grep search). Give a concrete keyword, number, unit, or short phrase; it returns the matching lines with their file and line number. This is your MAIN tool: it jumps you straight to a fact without reading whole files. Matching is case-insensitive substring, so use a SHORT exact term (a single word, a number, or a unit), NOT a whole sentence and NOT a glob like "*length*".
3. read_text_file(path, [head], [tail]) — returns a file's text. Use the EXACT path shown by list_directory. A file can be long; pass head=N or tail=N to read only the first/last N lines instead of the whole file. A very long read may come back ending in a "[TRUNCATED ...]" notice — the rest was NOT shown.

## How to answer — locate first, then read narrowly
1. Call list_directory to see the available files.
2. Decide the document's term for what is asked. Map the question's everyday wording to the term/unit the document would use, by MEANING not by matching words. For example:
   - "how long is it / from nose to tail" ↔ "אורך" / "length"
   - "how tall / how high" ↔ a "Height" / "גובה" row
   - "how heavy / what does it weigh" ↔ a "Weight" / "Mass" / "משקל" entry
   - an abbreviation in the question may be spelled out in the document (or vice-versa); a value may be in a different unit than you expected.
3. Call search_content with that term — try the question's language first (e.g. Hebrew). Read the returned lines carefully: facts are very often stored as TABLE ROWS like "label | value" (e.g. "אורך כולל | 19.76 m"), so the matching line itself frequently already contains the answer.
4. If you need more context around a hit, read_text_file the relevant file (use head/tail to stay focused) and read around that spot.
5. Extract the exact value (number + unit, term, or short list) and give a direct final answer.

## If the first search finds nothing
Do NOT conclude it's missing. Search again with a DIFFERENT term — a synonym, the core noun, a related unit or number, or the other language (Hebrew ↔ English). Only say "this is not in the documents" AFTER several different searches have turned up nothing.

## Mistakes to avoid
- search_content needs a short exact substring. If a search returns nothing, shorten or replace the term — do not give up, and do not fall back to reading the whole file blindly.
- Trust what your tools return. Do NOT assume more files exist elsewhere, or that a result is "only a snippet", and start over. Build on what you have already seen; never repeat an identical call.
- Use exact paths from list_directory. A failed read does NOT mean the information is unavailable — fix the path, or reuse content you already retrieved.

## Final answer
- Ground every statement in the documents; never invent, infer, or estimate facts.
- Answer in the SAME language as the question.
- Be concise: one or two sentences containing the exact number(s)/unit(s), term, or short list requested. Then stop calling tools."""


# ── Content search (grep) ──────────────────────────────────────────────────────
# The LM Studio filesystem MCP server's `search_files` matches file/dir NAMES
# (a path glob), NOT file contents — so the candidates have no way to locate a
# fact without reading whole files (which then overflow the context). The harness
# is the MCP host, so it implements its own content search and dispatches it
# locally (never forwarded to the MCP server).
CONTENT_SEARCH_NAME = "search_content"
CONTENT_SEARCH_TOOL = {
    "type": "function",
    "function": {
        "name": CONTENT_SEARCH_NAME,
        "description": (
            "Search for text INSIDE the documents (a content/grep search). Give a "
            "concrete keyword, number, unit, or short phrase; returns the matching lines "
            "with their file and line number. This is the fastest way to locate a fact "
            "without reading whole files. Matching is case-insensitive substring, so use a "
            "short exact term (a single word, number, or unit), not a whole sentence or a "
            "glob like '*length*'."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "Text to find inside the documents (keyword, number, unit, or short phrase).",
                },
                "path": {
                    "type": "string",
                    "description": "Optional file or sub-directory to restrict the search to. Defaults to all documents.",
                },
            },
            "required": ["pattern"],
        },
    },
}


def _grep_corpus(
    corpus_dir: str, pattern: str, path: str | None = None,
    max_matches: int = 40, line_cap: int = 300,
) -> str:
    """Case-insensitive substring search over the corpus' text files.

    Returns "rel/path:lineno: <line>" for each match (lines clipped to line_cap),
    capped at max_matches. Sandboxed to corpus_dir.
    """
    if not pattern:
        return "[tool error] search_content needs a non-empty 'pattern'."
    base = Path(corpus_dir).resolve()
    if path:
        p = Path(path)
        target = (p if p.is_absolute() else base / p).resolve()
        try:
            target.relative_to(base)
        except ValueError:
            return f"[tool error] path not within the corpus: {path}"
        roots = [target] if target.is_file() else sorted(target.rglob("*"))
    else:
        roots = sorted(base.rglob("*"))

    needle = pattern.lower()
    hits: list[str] = []
    for f in roots:
        if not f.is_file():
            continue
        try:
            text = f.read_text(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            continue
        rel = f.relative_to(base).as_posix()
        for i, line in enumerate(text.splitlines(), 1):
            if needle in line.lower():
                s = line.strip()
                if len(s) > line_cap:
                    s = s[:line_cap] + "…"
                hits.append(f"{rel}:{i}: {s}")
                if len(hits) >= max_matches:
                    return "\n".join(hits) + (
                        f"\n\n[showing the first {max_matches} matches; refine the pattern for fewer]"
                    )
    if not hits:
        return f'No lines containing "{pattern}" were found in the documents.'
    return "\n".join(hits)


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


async def _dispatch_tool(
    session: ClientSession, name: str, args: dict, cap: int, corpus_dir: str | None = None,
) -> str:
    try:
        if name == CONTENT_SEARCH_NAME:
            # Harness-implemented content search — never forwarded to the MCP server.
            out = _grep_corpus(corpus_dir or ".", args.get("pattern", ""), args.get("path"))
        else:
            res = await session.call_tool(name, args)
            parts = []
            for block in res.content:
                text = getattr(block, "text", None)
                parts.append(text if text is not None else str(block))
            out = "\n".join(parts)
    except Exception as e:  # noqa: BLE001
        return f"[tool error] {e}"[:cap]
    if len(out) > cap:
        # Make truncation VISIBLE: a silent cut leaves the model unable to tell the
        # answer span was dropped, so it wrongly concludes the info is missing.
        full = len(out)
        out = out[:cap] + (
            f"\n\n[TRUNCATED: showed the first {cap} of {full} characters; the rest of "
            f"this file was NOT shown. The answer may be in the unshown part — call "
            f"search_files with a keyword from the question (a number, unit, term, or "
            f"country) to locate the passage, then read around it.]"
        )
    return out


# Some local models (notably gemma via LM Studio) sometimes emit a tool call as
# plain TEXT in their chat-template format instead of through the API's structured
# tool_calls channel — most often on a turn where no tools were advertised, but it
# can leak mid-loop too. Such text is NOT an answer and must never be shown or
# scored as one; we detect it and convert it back into a real tool call.
#
# Observed gemma form:
#   <|tool_call>call:search_files{path:<|"|>foo.md<|"|>,keyword:<|"|>length<|"|>}<tool_call|>
# Also handled: the generic <tool_call>{ ...json... }</tool_call> form.
_GEMMA_CALL_RE = re.compile(
    r"<\|?tool_call\|?>\s*call:(?P<name>\w+)\s*\{(?P<body>.*?)\}\s*<\/?\|?tool_call\|?>",
    re.DOTALL,
)
_JSON_CALL_RE = re.compile(r"<tool_call>\s*(?P<json>\{.*?\})\s*</tool_call>", re.DOTALL)
_ARG_PAIR_RE = re.compile(r'(\w+)\s*:\s*"([^"]*)"')


def _parse_gemma_args(body: str) -> dict:
    # gemma wraps string values in a literal <|"|> quote token; normalise to ".
    body = body.replace('<|"|>', '"')
    return {k: v for k, v in _ARG_PAIR_RE.findall(body)}


def parse_text_tool_calls(content: str) -> tuple[str, list[dict]]:
    """Extract tool calls a model emitted as plain text (chat-template leakage).

    Returns (cleaned_content, calls). Each call matches the streamed tool-call slot
    shape ({"id","name","args"} with args as a JSON string), so it flows through the
    normal execution path. The tool-call spans are removed from the content so a
    leaked call can never be returned as the model's answer text.
    """
    if not content or "tool_call" not in content:
        return content, []
    calls: list[dict] = []
    cleaned = content

    def add(name: str, args: dict, raw: str) -> None:
        nonlocal cleaned
        calls.append({"id": f"call_text_{len(calls)}", "name": name,
                      "args": json.dumps(args, ensure_ascii=False)})
        cleaned = cleaned.replace(raw, "")

    for m in _GEMMA_CALL_RE.finditer(content):
        add(m.group("name"), _parse_gemma_args(m.group("body")), m.group(0))
    for m in _JSON_CALL_RE.finditer(content):
        try:
            obj = json.loads(m.group("json"))
        except json.JSONDecodeError:
            continue
        name = obj.get("name") or obj.get("tool") or ""
        args = obj.get("arguments") or obj.get("args") or {
            k: v for k, v in obj.items() if k not in ("name", "tool")
        }
        if name:
            add(name, args if isinstance(args, dict) else {}, m.group(0))
    return cleaned.strip(), calls


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
    if not tool_calls:
        # The API gave no structured tool calls — but the model may have emitted one
        # as text (template leakage). Recover it as a real call so it is never
        # mistaken for the final answer.
        content, leaked = parse_text_tool_calls(content)
        if leaked:
            tool_calls = leaked
    return content, tool_calls


def _append_tool_turn(messages: list[dict], content: str, tool_calls: list[dict]) -> None:
    """Record the assistant turn (text + the tool calls it requested)."""
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


async def _run_tool_calls(
    session: ClientSession, tool_calls: list[dict], messages: list[dict],
    cap: int, result: "AgentResult", emit, corpus_dir: str | None = None,
) -> None:
    """Execute each tool call and append its result as a tool message."""
    for i, t in enumerate(tool_calls):
        try:
            args = json.loads(t["args"] or "{}")
        except json.JSONDecodeError:
            args = {}
        emit("tool", t["name"], args)
        output = await _dispatch_tool(session, t["name"], args, cap, corpus_dir)
        result.tool_calls.append({"name": t["name"], "args": args, "chars": len(output)})
        emit("tool_result", t["name"], len(output))
        messages.append({"role": "tool", "tool_call_id": t["id"] or f"call_{i}", "content": output})


async def _force_final_answer(
    client, model: str, messages: list[dict], temperature: float, result: "AgentResult", emit,
    session: ClientSession, oai_tools: list[dict], cap: int, corpus_dir: str | None = None,
) -> None:
    """Out of steps: ask for a final answer.

    A model that still hasn't found the fact will often try to call a tool here
    instead of answering. If we forbid tools outright, that intent is wasted (and
    some models leak the call as text, which parse_text_tool_calls then strips,
    leaving an EMPTY answer — no feedback to the user). So we keep tools available
    and, if the model insists on a tool, execute it and re-ask — giving it the data
    to actually answer. After a small budget we make a final no-tools pass so the
    model is forced to commit to plain text.
    """
    for attempt in range(2):
        messages.append({
            "role": "user",
            "content": "Based only on the documents you have read, give your final answer now.",
        })
        emit("speak_start", "final")
        # Last pass: forbid tools so the model must answer in plain text.
        tools = None if attempt == 1 else oai_tools
        try:
            content, tool_calls = await _stream_step(client, model, messages, tools, temperature, emit)
        except Exception as e:  # noqa: BLE001
            result.error = f"final answer error: {e}"
            result.finish = "error"
            return
        emit("speak_end")
        if content.strip():
            result.answer = content.strip()
            result.finish = "max_steps"
            return
        if tool_calls:
            # The model wants data, not to answer yet — honour it once, then re-ask.
            _append_tool_turn(messages, content, tool_calls)
            await _run_tool_calls(session, tool_calls, messages, cap, result, emit, corpus_dir)
            continue
        break
    result.answer = content.strip()
    result.finish = "max_steps"


async def answer_question(
    session: ClientSession,
    oai_tools: list[dict],
    client,
    model: str,
    corpus_dir: str,
    question: str,
    cfg: dict,
    on_event=None,
    system_prompt: str | None = None,
) -> AgentResult:
    """Run the tool-using loop for a single question, streaming progress via on_event.

    system_prompt overrides the default module SYSTEM_PROMPT (e.g. when an agent
    package supplies its own prompt).

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

    # Advertise the harness-implemented content search alongside the MCP tools,
    # unless the caller already included it.
    tools = list(oai_tools)
    if not any(t.get("function", {}).get("name") == CONTENT_SEARCH_NAME for t in tools):
        tools.append(CONTENT_SEARCH_TOOL)

    messages = [
        {"role": "system", "content": system_prompt or SYSTEM_PROMPT},
        {"role": "user", "content": f"Allowed corpus directory: {corpus_dir}\n\nQuestion: {question}"},
    ]
    result = AgentResult()

    for step in range(max_steps):
        result.steps = step + 1
        emit("speak_start", step)
        try:
            content, tool_calls = await _stream_step(client, model, messages, tools, temperature, emit)
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
        _append_tool_turn(messages, content, tool_calls)
        await _run_tool_calls(session, tool_calls, messages, cap, result, emit, corpus_dir)

    await _force_final_answer(client, model, messages, temperature, result, emit, session, tools, cap, corpus_dir)
    return result


# ── Reference candidate: Claude via the Agent SDK ──────────────────────────────
# Lets a hosted model (Claude) be benchmarked as a candidate alongside the local
# LM Studio models — same question set, same judge, same logs. Claude navigates
# the corpus with its own read-only tools (Read/Glob/Grep), mirroring the local
# candidates' list/read/search tools.

CLAUDE_CANDIDATE_PROMPT = (
    "You answer questions using ONLY the documents in the current directory. Use your "
    "file tools to list, read, and search the documents, find the specific fact, and give "
    "a short, direct final answer. Ground every answer in the documents; do not invent "
    "facts. Answer in the SAME language as the question. Keep the final answer concise "
    "(one or two sentences with the exact numbers/terms)."
)


async def answer_question_claude(
    corpus_dir: str, question: str, cfg: dict, on_event=None, model: str = "claude-sonnet-4-6",
) -> AgentResult:
    """Answer one question by driving Claude agentically over the corpus (read-only)."""
    def emit(*a):
        if on_event:
            on_event(*a)

    try:
        from claude_agent_sdk import query, ClaudeAgentOptions
    except Exception as e:  # noqa: BLE001
        return AgentResult(error=f"claude-agent-sdk unavailable: {e}", finish="error")

    corpus_dir = str(Path(corpus_dir).resolve())
    max_steps = int(cfg.get("max_steps", 8))
    options = ClaudeAgentOptions(
        system_prompt=CLAUDE_CANDIDATE_PROMPT,
        allowed_tools=["Read", "Glob", "Grep"],
        cwd=corpus_dir,
        permission_mode="bypassPermissions",
        max_turns=max_steps,
        model=model,
    )

    for attempt in range(3):  # retry transient Agent SDK errors (rate limits)
        result = AgentResult()
        texts: list[str] = []
        emit("speak_start", 0)
        try:
            async for message in query(prompt=question, options=options):
                for block in getattr(message, "content", []) or []:
                    t = getattr(block, "text", None)
                    if t:
                        texts.append(t)
                        emit("token", t)
                    if block.__class__.__name__ == "ToolUseBlock" or getattr(block, "type", None) == "tool_use":
                        name = getattr(block, "name", "tool")
                        inp = getattr(block, "input", {}) or {}
                        result.tool_calls.append({"name": name, "args": inp, "chars": 0})
                        result.steps += 1
                        emit("tool", name, inp)
            emit("speak_end")
            result.answer = next((t.strip() for t in reversed(texts) if t.strip()), "")
            result.steps = max(result.steps, 1)
            result.finish = "answered"
            return result
        except Exception as e:  # noqa: BLE001
            emit("speak_end")
            result.error = f"claude candidate error: {e}"
            result.finish = "error"
            if attempt < 2:
                await asyncio.sleep(8 * (attempt + 1))
                continue
            return result
