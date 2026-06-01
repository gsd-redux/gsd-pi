"""Contract test: gsd read progress against minimal-project fixture."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

FIXTURE = Path(__file__).parent / "fixtures" / "minimal-project"
REPO_ROOT = Path(__file__).resolve().parents[3]
GSD_CLI = os.environ.get("GSD_CLI_PATH", "node")
GSD_LOADER = os.environ.get(
    "GSD_LOADER_PATH", str(REPO_ROOT / "dist" / "loader.js")
)


def _gsd_cmd(*args: str) -> list[str]:
    if GSD_CLI == "node" or GSD_CLI.endswith("node"):
        return [GSD_CLI, GSD_LOADER, *args]
    return [GSD_CLI, *args]


def test_read_cli_progress_fixture() -> None:
    if not Path(GSD_LOADER).exists():
        pytest.skip(f"GSD loader not built: {GSD_LOADER}")

    result = subprocess.run(
        _gsd_cmd(
            "read",
            "progress",
            "--json",
            "--project",
            str(FIXTURE.resolve()),
        ),
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
        cwd=str(REPO_ROOT),
    )
    assert result.returncode == 0, result.stderr or result.stdout
    envelope = json.loads(result.stdout)
    assert envelope["integration_version"] == 1
    assert envelope["kind"] == "progress"
    data = envelope["data"]
    assert data.get("activeMilestone", {}).get("id") == "M001"
    assert "Hermes Integration" in (data.get("activeMilestone", {}).get("title") or "")
