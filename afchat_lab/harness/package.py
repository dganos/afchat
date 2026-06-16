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
    await answer_question(session, tools, client, pkg.model["id"], corpus_dir,
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

    @property
    def tool_names(self) -> list[str]:
        return [t["name"] for t in self.tools]

    def summary(self) -> str:
        return (f"{self.name} v{self.version} | model={self.model.get('id')} | "
                f"tools={self.tool_names} | ctx={self.model.get('context_length')} "
                f"steps={self.runtime.get('max_steps')} cap={self.runtime.get('max_tool_result_chars')}")


def load_package(path: str | Path) -> AgentPackage:
    """Load a package from its folder (or its package.json). Raises on missing keys."""
    p = Path(path)
    pkg_json = p / "package.json" if p.is_dir() else p
    pkg_dir = pkg_json.parent
    d = json.loads(pkg_json.read_text())

    missing = [k for k in ("name", "model", "tools", "system_prompt_file") if k not in d]
    if missing:
        raise ValueError(f"package {pkg_json} missing required keys: {missing}")
    if "id" not in d["model"]:
        raise ValueError(f"package {pkg_json}: model.id is required")

    system_prompt = (pkg_dir / d["system_prompt_file"]).read_text().strip()
    return AgentPackage(
        name=d["name"],
        version=int(d.get("version", 1)),
        description=d.get("description", "").strip(),
        model=d["model"],
        runtime=d.get("runtime", {}),
        tools=d["tools"],
        system_prompt=system_prompt,
        dir=pkg_dir,
    )


def openai_tools(pkg: AgentPackage) -> list[dict]:
    """Build OpenAI/Ollama function-tool specs from the package's tool contracts."""
    return [
        {"type": "function",
         "function": {"name": t["name"], "description": t["description"],
                      "parameters": t.get("parameters", {"type": "object", "properties": {}})}}
        for t in pkg.tools
    ]
