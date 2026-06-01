"""Tests for Hermes plugin configuration defaults."""

from __future__ import annotations

from open_gsd_hermes.config import GsdConfig


def test_default_gsd_version_range_matches_plugin_release_train() -> None:
    config = GsdConfig()

    assert config.gsd_version_min == "2.53"
    assert config.gsd_version_max == "3.0"


def test_dict_fallback_gsd_version_range_matches_plugin_release_train() -> None:
    config = GsdConfig.from_dict({"gsd": {}})

    assert config.gsd_version_min == "2.53"
    assert config.gsd_version_max == "3.0"
