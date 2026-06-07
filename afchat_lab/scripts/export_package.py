"""Export an agent package (YAML) to JSON for non-Python consumers (e.g. the Aristo app).

The YAML in packages/ is the single source of truth; this writes a JSON mirror that
JavaScript can load without a YAML dependency.

Usage:
    .venv/bin/python scripts/export_package.py packages/gemma4-qa.yaml ../api/packages/gemma4-qa.json
"""
import json
import sys
from pathlib import Path

import yaml

src, dst = Path(sys.argv[1]), Path(sys.argv[2])
data = yaml.safe_load(src.read_text())
dst.parent.mkdir(parents=True, exist_ok=True)
dst.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"exported {src} -> {dst}")
