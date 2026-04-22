// GSD2 — Extension — Notification Status
import type { ExtensionContext } from "@gsd/pi-coding-agent";

import { getUnreadCount, onNotificationStoreChange } from "./notification-store.js";
import { formattedShortcutPair } from "./shortcut-defs.js";

// Key chosen to sort after alphabetic extension keys so the chip lands on the
// far right of the extension-status block.
const STATUS_KEY = "zz-notifications";

export function buildNotificationChip(): string {
  const unread = getUnreadCount();
  if (unread === 0) return "";
  return `🔔 ${unread} unread (${formattedShortcutPair("notifications")})`;
}

// Retained for backwards compatibility with tests and the RPC fallback path
// that still expected a line-array widget. Returns empty when no unread.
export function buildNotificationWidgetLines(): string[] {
  const chip = buildNotificationChip();
  return chip ? [`  ${chip}`] : [];
}

const REFRESH_INTERVAL_MS = 30_000;

export function initNotificationWidget(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;

  const push = () => {
    const chip = buildNotificationChip();
    ctx.ui.setStatus(STATUS_KEY, chip.length > 0 ? chip : undefined);
  };
  push();

  onNotificationStoreChange(push);
  setInterval(push, REFRESH_INTERVAL_MS).unref?.();
}
