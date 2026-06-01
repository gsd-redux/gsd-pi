"""Tests for Hermes plugin configuration defaults."""

from __future__ import annotations

from pathlib import Path

from open_gsd_hermes.config import GsdConfig, config_path


def test_default_gsd_version_range_matches_plugin_release_train() -> None:
    config = GsdConfig()

    assert config.gsd_version_min == "2.53"
    assert config.gsd_version_max == "3.0"


def test_dict_fallback_gsd_version_range_matches_plugin_release_train() -> None:
    config = GsdConfig.from_dict({"gsd": {}})

    assert config.gsd_version_min == "2.53"
    assert config.gsd_version_max == "3.0"


def test_config_path_respects_hermes_home(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("HERMES_GSD_CONFIG", raising=False)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes-home"))

    assert config_path() == tmp_path / "hermes-home" / "gsd.yaml"


def test_config_path_explicit_env_wins(tmp_path: Path, monkeypatch) -> None:
    explicit = tmp_path / "custom-gsd.yaml"
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes-home"))
    monkeypatch.setenv("HERMES_GSD_CONFIG", str(explicit))

    assert config_path() == explicit
