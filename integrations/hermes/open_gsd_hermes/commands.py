"""`/gsd` slash command router — bind, status, auto, cancel, reply."""

from __future__ import annotations

import shlex
from typing import Any, Callable

from open_gsd_hermes.binding import (
    BindingError,
    SessionBindStore,
    resolve_explicit_project_dir,
    resolve_project_dir,
)
from open_gsd_hermes.config import GsdConfig
from open_gsd_hermes.gsd_client import GsdMcpClient
from open_gsd_hermes.notifications import NotificationService
from open_gsd_hermes.snapshot import format_snapshot
from open_gsd_hermes.supervisor import SupervisorContext, SupervisorFsm, SupervisorState
from open_gsd_hermes.types import BindingContext


class GsdCommandRouter:
    def __init__(
        self,
        config: GsdConfig,
        client: GsdMcpClient,
        bind_store: SessionBindStore,
        supervisor: SupervisorFsm,
        get_session_key: Callable[[], str],
        get_binding_ctx: Callable[[], BindingContext],
        get_supervisor_ctx: Callable[[], SupervisorContext],
        set_supervisor_ctx: Callable[[SupervisorContext], None],
        get_platform_channel: Callable[[], tuple[str | None, str | None]],
        notifications: NotificationService | None = None,
    ) -> None:
        self._config = config
        self._client = client
        self._bind_store = bind_store
        self._supervisor = supervisor
        self._get_session_key = get_session_key
        self._get_binding_ctx = get_binding_ctx
        self._get_supervisor_ctx = get_supervisor_ctx
        self._set_supervisor_ctx = set_supervisor_ctx
        self._get_platform_channel = get_platform_channel
        self._notifications = notifications

    async def handle(self, args: str = "", **_kwargs: Any) -> str:
        try:
            tokens = shlex.split(args) if args else []
        except ValueError as e:
            return f"Invalid arguments: {e}"
        sub = (tokens[0] if tokens else "help").lower()
        rest = tokens[1:]

        handlers = {
            "bind": self._cmd_bind,
            "status": self._cmd_status,
            "auto": self._cmd_auto,
            "cancel": self._cmd_cancel,
            "reply": self._cmd_reply,
            "help": self._cmd_help,
        }
        handler = handlers.get(sub, self._cmd_help)
        return await handler(rest)

    async def _cmd_help(self, _rest: list[str]) -> str:
        return (
            "**GSD commands**\n"
            "- `/gsd bind <path>` — bind this chat to a project\n"
            "- `/gsd status` — show progress snapshot\n"
            "- `/gsd auto` — start auto mode (MCP)\n"
            "- `/gsd cancel` — cancel running session\n"
            "- `/gsd reply <text>` — resolve blocker"
        )

    def _binding_ctx(self, slash_path: str | None = None) -> BindingContext:
        sk = self._get_session_key()
        platform, channel = self._get_platform_channel()
        base = self._get_binding_ctx()
        return BindingContext(
            slash_path=slash_path,
            session_bind=self._bind_store.get(sk) or base.session_bind,
            platform=platform or base.platform,
            channel_id=channel or base.channel_id,
            cron_project=base.cron_project,
            cwd=base.cwd,
        )

    async def _cmd_bind(self, rest: list[str]) -> str:
        if not rest:
            return "Usage: `/gsd bind <project-path>`"
        path = rest[0]
        sk = self._get_session_key()
        try:
            project_dir = resolve_explicit_project_dir(path)
        except BindingError as e:
            return str(e)
        self._bind_store.set(sk, project_dir)
        self._client.invalidate_cache(project_dir)
        return f"Bound to `{project_dir}`"

    async def _cmd_status(self, _rest: list[str]) -> str:
        try:
            project_dir = resolve_project_dir(
                self._config, self._binding_ctx()
            )
            progress = self._client.progress(project_dir)
            return format_snapshot(progress)
        except BindingError as e:
            return str(e)
        except Exception as e:
            return f"GSD status unavailable: {e}"

    async def _cmd_auto(self, _rest: list[str]) -> str:
        try:
            project_dir = resolve_project_dir(
                self._config, self._binding_ctx()
            )
        except BindingError as e:
            return str(e)
        try:
            result = self._client.execute(project_dir)
        except Exception as e:
            return f"Could not start GSD auto mode: {e}"
        session_id = result.get("sessionId") or result.get("session_id")
        if not session_id:
            return "Could not start GSD auto mode: missing session ID"
        self._supervisor.stop()
        ctx = self._get_supervisor_ctx()
        ctx.session_id = session_id
        ctx.project_dir = project_dir
        ctx.state = SupervisorState.RUNNING
        ctx.last_progress = None
        ctx.last_status = None
        ctx.pending_blocker_id = None
        ctx.notified_terminal = False
        self._set_supervisor_ctx(ctx)
        self._supervisor.start()
        return f"Started GSD auto mode (session `{session_id}`)"

    async def _cmd_cancel(self, _rest: list[str]) -> str:
        ctx = self._get_supervisor_ctx()
        try:
            try:
                if ctx.session_id and ctx.project_dir:
                    project_dir = resolve_explicit_project_dir(ctx.project_dir)
                else:
                    project_dir = resolve_project_dir(
                        self._config, self._binding_ctx()
                    )
            except BindingError as e:
                result = str(e)
            else:
                try:
                    if ctx.session_id:
                        self._client.cancel(
                            session_id=ctx.session_id, project_dir=project_dir
                        )
                    else:
                        self._client.cancel_by_project(project_dir)
                except Exception as e:
                    result = f"Cancel request failed: {e}"
                else:
                    if self._notifications is not None:
                        self._notifications.notify_terminal("cancelled")
                        ctx.notified_terminal = True
                    result = "Cancel requested."
        finally:
            self._supervisor.stop()
            ctx.state = SupervisorState.CANCELLED
            self._set_supervisor_ctx(ctx)
        return result

    async def _cmd_reply(self, rest: list[str]) -> str:
        if not rest:
            return "Usage: `/gsd reply <your answer>`"
        text = " ".join(rest)
        ctx = self._get_supervisor_ctx()
        if not ctx.session_id:
            return "No active GSD session. Run `/gsd auto` first."
        try:
            self._client.resolve_blocker(ctx.session_id, text)
            self._client.invalidate_cache(ctx.project_dir)
        except Exception as e:
            return f"Could not send blocker response: {e}"
        return "Blocker response sent."
