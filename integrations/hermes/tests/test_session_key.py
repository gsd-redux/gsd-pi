"""Live session-key resolution (#1711 / #1788)."""

from __future__ import annotations

import threading
from types import SimpleNamespace
from unittest.mock import MagicMock

import open_gsd_hermes
from open_gsd_hermes.config import GsdConfig
from open_gsd_hermes.inject import make_pre_llm_call_handler
from open_gsd_hermes.session_key import (
    bind_session_key,
    reset_session_key,
    resolve_session_key,
)
from open_gsd_hermes.types import BindingContext, DeliveryTarget


def test_resolve_session_key_prefers_bound_context_over_env(monkeypatch) -> None:
    monkeypatch.setenv("HERMES_SESSION_KEY", "agent:main:cli:direct:local")
    token = bind_session_key("agent:main:telegram:thread:1:4162")
    try:
        assert resolve_session_key() == "agent:main:telegram:thread:1:4162"
    finally:
        reset_session_key(token)
    assert resolve_session_key() == "agent:main:cli:direct:local"


def test_resolve_session_key_uses_gateway_contextvar_before_env(monkeypatch) -> None:
    monkeypatch.setenv("HERMES_SESSION_KEY", "agent:main:cli:direct:local")
    monkeypatch.setitem(
        __import__("sys").modules,
        "gateway",
        SimpleNamespace(),
    )
    monkeypatch.setitem(
        __import__("sys").modules,
        "gateway.session_context",
        SimpleNamespace(get_session_env=lambda name: "agent:main:telegram:thread:9:7777"),
    )
    assert resolve_session_key() == "agent:main:telegram:thread:9:7777"


def test_resolve_session_key_unbound_without_env_is_none(monkeypatch) -> None:
    monkeypatch.delenv("HERMES_SESSION_KEY", raising=False)
    assert resolve_session_key() is None


def test_delivery_target_is_computed_from_live_key(monkeypatch) -> None:
    monkeypatch.delenv("HERMES_SESSION_KEY", raising=False)
    ctx = MagicMock()
    monkeypatch.setattr(open_gsd_hermes, "load_config", lambda: GsdConfig())
    monkeypatch.setattr(open_gsd_hermes, "GsdMcpClient", lambda _config: MagicMock())
    open_gsd_hermes.register(ctx)
    get_target = open_gsd_hermes.register._state["get_target"]
    get_session_key = open_gsd_hermes.register._state["get_session_key"]

    assert get_session_key() is None
    assert get_target() is None

    token = bind_session_key("agent:main:telegram:thread:1:4162")
    try:
        assert get_session_key() == "agent:main:telegram:thread:1:4162"
        target = get_target()
        assert target == DeliveryTarget.from_session_key("agent:main:telegram:thread:1:4162")
        assert target is not None
        assert target.chat_id == "1:4162"
    finally:
        reset_session_key(token)

    token = bind_session_key("agent:main:telegram:thread:2:7777")
    try:
        target = get_target()
        assert target is not None
        assert target.chat_id == "2:7777"
    finally:
        reset_session_key(token)


def test_unbound_context_does_not_inject_default_project(monkeypatch) -> None:
    monkeypatch.delenv("HERMES_SESSION_KEY", raising=False)
    client = MagicMock()
    handler = make_pre_llm_call_handler(
        MagicMock(default_project="/tmp/default-project"),
        client,
        lambda: BindingContext(cwd="/tmp"),
    )
    assert handler() == {}
    client.progress.assert_not_called()


def test_concurrent_threads_resolve_distinct_session_keys(monkeypatch) -> None:
    monkeypatch.delenv("HERMES_SESSION_KEY", raising=False)
    results: dict[str, str | None] = {}

    def worker(name: str, key: str) -> None:
        token = bind_session_key(key)
        try:
            results[name] = resolve_session_key()
        finally:
            reset_session_key(token)

    threads = [
        threading.Thread(target=worker, args=("a", "agent:main:telegram:thread:1:A")),
        threading.Thread(target=worker, args=("b", "agent:main:telegram:thread:1:B")),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert results["a"] == "agent:main:telegram:thread:1:A"
    assert results["b"] == "agent:main:telegram:thread:1:B"
