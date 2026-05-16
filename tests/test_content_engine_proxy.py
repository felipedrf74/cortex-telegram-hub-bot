"""Root-level pytest entrypoint for the content-engine suite.

The Phases 0-15 QA checklist runs:

    content-engine/.venv313/bin/python -m pytest tests/

from the repository root. The real Python suite lives under
``content-engine/tests``. This proxy keeps that documented command meaningful
by executing the real suite as a child pytest run and failing if it fails.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


def test_content_engine_suite_passes() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    content_engine_root = repo_root / "content-engine"

    result = subprocess.run(
        [sys.executable, "-m", "pytest", "tests/"],
        cwd=content_engine_root,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, (
        "content-engine pytest failed\n"
        f"stdout:\n{result.stdout}\n\n"
        f"stderr:\n{result.stderr}"
    )
