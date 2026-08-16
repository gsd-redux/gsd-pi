"""pre_llm_call hook — inject live GSD project snapshot."""

from __future__ import annotations

from typing import Any, Callable

from open_gsd_hermes.binding import BindingError, resolve_project_dir
from open_gsd_hermes.config import GsdConfig
from open_gsd_hermes.gsd_client import GsdMcpClient
from open_gsd_hermes.session_key import resolve_session_key
from open_gsd_hermes.snapshot import format_snapshot
from open_gsd_hermes.types import BindingContext


def make_pre_llm_call_handler(
    config: GsdConfig,
    client: GsdMcpClient,
    get_binding_ctx: Callable[[], BindingContext],
) -> Callable[..., dict[str, str]]:
    """Return Hermes pre_llm_call hook that injects compact project context."""

    def pre_llm_call(**_kwargs: Any) -> dict[str, str]:
        if not resolve_session_key():
            return {}
        try:
            project_dir = resolve_project_dir(config, get_binding_ctx())
            progress = client.progress(project_dir)
            return {"context": format_snapshot(progress)}
        except BindingError:
            return {}
        except Exception as e:
            return {"context": f"## GSD\n(snapshot unavailable: {e})"}

    return pre_llm_call
