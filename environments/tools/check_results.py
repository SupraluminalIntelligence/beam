"""Validate beam/out/manifest.json and fail unless every check passed or was not evaluated.

    python check_results.py [beam/out]
"""
import json
import sys
from pathlib import Path

root = Path(sys.argv[1] if len(sys.argv) > 1 else "beam/out")
m = json.loads((root / "manifest.json").read_text())
problems = []
if m.get("version") != 1:
    problems.append(f"manifest version {m.get('version')!r}")
for kind in ("series", "fields", "tables"):
    for item in m.get(kind, []):
        for key in ("data", "preview", "full"):
            if key in item and not (root / item[key]).exists():
                problems.append(f"{kind} {item['name']}: {item[key]} is missing")
for q in m.get("quantities", []):
    ref = q.get("reference")
    print(f"{q['name']:>28} = {q['value']:.6g} {q['unit']}" + (f"   (reference {ref['value']:.6g}, {ref['source']})" if ref else ""))
for c in m.get("checks", []):
    print(f"{c['status']:>28}   {c['id']}  {c.get('value', '')}")
    if c["status"] not in ("pass", "not-evaluated"):
        problems.append(f"check {c['id']} is {c['status']}")
if not m.get("checks"):
    problems.append("no checks")
for p in problems:
    print(f"::error::{p}")
sys.exit(1 if problems else 0)
