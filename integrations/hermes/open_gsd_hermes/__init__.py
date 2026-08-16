"""open-gsd-hermes — Hermes Agent plugin for GSD Pi integration."""

from __future__ import annotations

import os
from typing import Any

from open_gsd_hermes.binding import SessionBindStore
from open_gsd_hermes.commands import GsdCommandRouter
from open_gsd_hermes.config import GsdConfig, load_config
from open_gsd_hermes.credentials import CredentialPassthrough
from open_gsd_hermes.gsd_client import GsdMcpClient
from open_gsd_hermes.inject import make_pre_llm_call_handler
from open_gsd_hermes.memory import GsdMemoryProvider
from open_gsd_hermes.notifications import NotificationService
from open_gsd_hermes.session_key import resolve_session_key
from open_gsd_hermes.supervisor import SupervisorContext, SupervisorFsm
from open_gsd_hermes.types import BindingContext, DeliveryTarget, PluginContext


def register(ctx: PluginContext) -> None:
    """Hermes plugin entry point."""
    config = load_config()
    client = GsdMcpClient(config)
    bind_store = SessionBindStore()

    binding_ctx = BindingContext(cwd=os.getcwd())
    supervisor_ctx = SupervisorContext()

    def get_session_key() -> str | None:
        return resolve_session_key()

    def get_binding_ctx() -> BindingContext:
        return binding_ctx

    def get_supervisor_ctx() -> SupervisorContext:
        return supervisor_ctx

    def set_supervisor_ctx(sctx: SupervisorContext) -> None:
        nonlocal supervisor_ctx
        supervisor_ctx = sctx

    def get_target() -> DeliveryTarget | None:
        key = get_session_key()
        if not key:
            return None
        return DeliveryTarget.from_session_key(key)

    def get_platform_channel() -> tuple[str | None, str | None]:
        t = get_target()
        if t:
            return t.platform, t.chat_id
        return None, None

    notifications = NotificationService(ctx, config, get_target)
    supervisor = SupervisorFsm(
        config,
        client,
        notifications,
        get_supervisor_ctx,
        set_supervisor_ctx,
    )

    router = GsdCommandRouter(
        config,
        client,
        bind_store,
        supervisor,
        get_session_key,
        get_binding_ctx,
        get_supervisor_ctx,
        set_supervisor_ctx,
        get_platform_channel,
        notifications,
    )

    ctx.register_hook(
        "pre_llm_call",
        make_pre_llm_call_handler(config, client, router._binding_ctx),
    )
    ctx.register_command("gsd", router.handle)

    memory_provider = GsdMemoryProvider(config, client)
    if hasattr(ctx, "register_memory_provider"):
        ctx.register_memory_provider(memory_provider)

    # Validate credential config at startup
    creds = CredentialPassthrough(config.credential_source)
    for warning in creds.validate():
        if hasattr(ctx, "log_warning"):
            ctx.log_warning(warning)  # type: ignore[attr-defined]

    # Expose for tests
    register._state = {  # type: ignore[attr-defined]
        "config": config,
        "client": client,
        "router": router,
        "supervisor": supervisor,
        "get_session_key": get_session_key,
        "get_target": get_target,
    }


__all__ = ["register", "GsdConfig", "load_config"]
