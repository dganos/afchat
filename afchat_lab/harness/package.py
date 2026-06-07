"""Agent packages: a self-contained (model + system prompt + tools) bundle.

A *package* is everything needed to reproduce one agent's behaviour — which model
to load, the system prompt that drives it, the tools it may call, and the runtime
knobs they were tuned with. Packages live in `packages/*.yaml`; load one with
`load_package()` and feed it to the agent loop:

    pkg = load_package("packages/gemma4-qa.yaml")
    oai_tools = mcp_tools_to_openai(mcp_tools, pkg.tool_allowlist)
    await answer_question(session, oai_tools, client, pkg.model["id"], corpus_dir,
                          question, pkg.runtime, system_prompt=pkg.system_prompt)
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import yaml


@dataclass
class AgentPackage:
    """Model + system prompt + tools + runtime, loaded from a package YAML."""

    name: str
    description: str
    model: dict
    runtime: dict
    tools: list[dict]
    system_prompt: str
    version: int = 1

    @property
    def tool_allowlist(self) -> list[str]:
        """Tool names to expose to the model (schemas resolved by the MCP host)."""
        return [t["name"] for t in self.tools]

    def summary(self) -> str:
        return (f"{self.name} v{self.version} | model={self.model.get('id')} | "
                f"tools={self.tool_allowlist} | "
                f"ctx={self.model.get('context_length')} steps={self.runtime.get('max_steps')} "
                f"cap={self.runtime.get('max_tool_result_chars')}")


def load_package(path: str | Path) -> AgentPackage:
    """Parse a package YAML into an AgentPackage. Raises on missing required keys."""
    d = yaml.safe_load(Path(path).read_text())
    missing = [k for k in ("name", "model", "tools", "system_prompt") if k not in d]
    if missing:
        raise ValueError(f"package {path} missing required keys: {missing}")
    if "id" not in d["model"]:
        raise ValueError(f"package {path}: model.id is required")
    return AgentPackage(
        name=d["name"],
        version=int(d.get("version", 1)),
        description=d.get("description", "").strip(),
        model=d["model"],
        runtime=d.get("runtime", {}),
        tools=d["tools"],
        system_prompt=d["system_prompt"].strip(),
    )
