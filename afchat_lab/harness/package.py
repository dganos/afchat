"""Agent packages: the single source of truth for an agent's inference behaviour.

A *package* is a folder (e.g. `packages/gemma4-qa/`) holding everything needed to
reproduce one agent: the model to load, the runtime knobs, the tool CONTRACTS
(name + description + JSON-schema the model sees), and the system prompt. Both
afchat_lab (Python) and the Aristo app (JS) load the SAME package and supply only
the tool *implementations* for their runtime — neither holds the prompt, the tool
descriptions, or the runtime knobs internally.

Canonical format (read directly by both, no derived copies):
    packages/gemma4-qa/package.json    — model, runtime, tools[{name,description,parameters}]
    packages/gemma4-qa/system_prompt.md — the system prompt text

    pkg = load_package("../packages/gemma4-qa")
    tools = openai_tools(pkg)   # [{type:function, function:{name,description,parameters}}]
    await answer_question_ollama(session, tools, base_url, pkg.model["id"], corpus_dir,
                                 question, pkg.runtime, system_prompt=pkg.system_prompt)
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path


@dataclass
class AgentPackage:
    """Model + runtime + tool contracts + system prompt, loaded from a package folder."""

    name: str
    description: str
    model: dict
    runtime: dict
    tools: list[dict]          # each: {name, description, parameters(JSON schema)}
    system_prompt: str
    dir: Path
    version: int = 1
    embed_model: "dict | None" = None   # {id, max_input_chars, top_k} for semantic retrieval

    @property
    def tool_names(self) -> list[str]:
        return [t["name"] for t in self.tools]

    def summary(self) -> str:
        return (f"{self.name} v{self.version} | model={self.model.get('id')} | "
                f"tools={self.tool_names} | ctx={self.model.get('context_length')} "
                f"steps={self.runtime.get('max_steps')} cap={self.runtime.get('max_tool_result_chars')}")


def load_package(path: str | Path) -> AgentPackage:
    """Load a package from its folder (or its package.json). Raises on missing keys.

    A package may declare `"extends": "<relative path to a base package>"` (one
    level, no chains). This is how the lab's per-model candidate packages
    (afchat_lab/agents/<label>/) stay glued to the PRODUCTION package in the
    Aristo folder (packages/gemma4-qa): they carry only their model block and
    inherit the system prompt, tool contracts, and runtime knobs from production
    — so a production contract change automatically applies to every candidate,
    and candidates can never silently drift.
    """
    p = Path(path)
    pkg_json = p / "package.json" if p.is_dir() else p
    pkg_dir = pkg_json.parent
    d = json.loads(pkg_json.read_text(encoding="utf-8"))

    base: AgentPackage | None = None
    if d.get("extends"):
        base_path = (pkg_dir / d["extends"]).resolve()
        base_d = json.loads((base_path / "package.json" if base_path.is_dir() else base_path).read_text(encoding="utf-8"))
        if base_d.get("extends"):
            raise ValueError(f"package {pkg_json}: extends chains are not allowed (base also extends)")
        base = load_package(base_path)

    model = d.get("model") or (base.model if base else None)
    tools = d.get("tools") or (base.tools if base else None)
    runtime = {**(base.runtime if base else {}), **d.get("runtime", {})}
    embed_model = d.get("embed_model") or (base.embed_model if base else None)

    missing = [k for k, v in (("name", d.get("name")), ("model", model), ("tools", tools)) if not v]
    if not d.get("system_prompt_file") and base is None:
        missing.append("system_prompt_file")
    if missing:
        raise ValueError(f"package {pkg_json} missing required keys: {missing}")
    if "id" not in model:
        raise ValueError(f"package {pkg_json}: model.id is required")

    if d.get("system_prompt_file"):
        system_prompt = (pkg_dir / d["system_prompt_file"]).read_text(encoding="utf-8").strip()
    else:
        system_prompt = base.system_prompt

    return AgentPackage(
        name=d["name"],
        version=int(d.get("version", base.version if base else 1)),
        description=(d.get("description") or (base.description if base else "")).strip(),
        model=model,
        runtime=runtime,
        tools=tools,
        system_prompt=system_prompt,
        dir=pkg_dir,
        embed_model=embed_model,
    )


def openai_tools(pkg: AgentPackage) -> list[dict]:
    """Build OpenAI/Ollama function-tool specs from the package's tool contracts."""
    return [
        {"type": "function",
         "function": {"name": t["name"], "description": t["description"],
                      "parameters": t.get("parameters", {"type": "object", "properties": {}})}}
        for t in pkg.tools
    ]
