"""Live Hermes session-key resolution (gateway contextvar, then env)."""

from __future__ import annotations

import os
from contextvars import ContextVar, Token

HERMES_SESSION_KEY_ENV = "HERMES_SESSION_KEY"

_SESSION_KEY: ContextVar[str | None] = ContextVar("open_gsd_hermes_session_key", default=None)


def bind_session_key(key: str) -> Token[str | None]:
    """Bind a session key for the current context/thread. For tests and callers."""
    return _SESSION_KEY.set(key)


def reset_session_key(token: Token[str | None]) -> None:
    _SESSION_KEY.reset(token)


def _gateway_session_key() -> str | None:
    try:
        from gateway.session_context import get_session_env
    except Exception:
        return None
    try:
        key = get_session_env(HERMES_SESSION_KEY_ENV)
    except Exception:
        return None
    if isinstance(key, str) and key.strip():
        return key
    return None


def resolve_session_key() -> str | None:
    """Live session key: bound context, then gateway contextvar, then env.

    Unbound context (nothing live, env unset) returns None — do not inject
    the hardcoded ``agent:main:cli:direct:local`` default.
    """
    bound = _SESSION_KEY.get()
    if bound:
        return bound
    live = _gateway_session_key()
    if live:
        return live
    env = os.environ.get(HERMES_SESSION_KEY_ENV)
    if env and env.strip():
        return env
    return None
