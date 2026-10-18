#!/usr/bin/env python3
"""Minimal Codex UserPromptSubmit probe for a local Git branch answer."""

from __future__ import annotations

import json
import subprocess
import sys
from typing import Any


SUPPORTED_PROMPT = "what git branch am i on"


def main() -> int:
    try:
        payload: Any = json.load(sys.stdin)
    except (json.JSONDecodeError, TypeError):
        return 0

    if not isinstance(payload, dict):
        return 0

    prompt = payload.get("prompt")
    cwd = payload.get("cwd")
    if not isinstance(prompt, str) or not isinstance(cwd, str):
        return 0

    normalized = " ".join(prompt.casefold().strip().rstrip("?!. ").split())
    if normalized != SUPPORTED_PROMPT:
        return 0

    try:
        result = subprocess.run(
            ["git", "branch", "--show-current"],
            cwd=cwd,
            check=True,
            capture_output=True,
            text=True,
            timeout=2,
        )
    except (OSError, subprocess.SubprocessError):
        return 0

    branch = result.stdout.strip()
    if not branch:
        return 0

    print(
        json.dumps(
            {
                "decision": "block",
                "reason": f"Fast Lane local answer: current Git branch is {branch}.",
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
