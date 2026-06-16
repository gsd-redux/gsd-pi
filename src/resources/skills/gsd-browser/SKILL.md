---
name: gsd-browser
description: Use gsd-browser for browser automation and UAT: navigating local apps, inspecting pages, clicking or filling controls, taking screenshots, asserting UI behavior, collecting console/network diagnostics, visual diffing, and creating evidence bundles. Prefer this over legacy Playwright browser tooling when both are available.
allowed-tools: Bash(gsd-browser:*), Bash(gsd-browser *)
---

# gsd-browser

Use `gsd-browser` as the default browser surface for automated UAT and real UI verification.

## MCP First

When MCP tools are available, prefer the `gsd-browser` server:

- Discovery: `browser_snapshot_refs`, `browser_find`, `browser_get_accessibility_tree`
- Actions: `browser_act`, `browser_batch`, `browser_click_ref`, `browser_fill_ref`
- Verification: `browser_assert`, `browser_screenshot`, `browser_visual_diff`
- Diagnostics: `browser_get_console_logs`, `browser_get_network_logs`, `browser_debug_bundle`

If the host namespaces MCP tools, use names like `mcp__gsd-browser__browser_snapshot_refs`.

## CLI Fallback

The daemon starts automatically on first browser command.

```bash
gsd-browser navigate http://localhost:3000
gsd-browser snapshot
gsd-browser click-ref @v1:e1
gsd-browser wait-for --condition network_idle
gsd-browser assert --checks '[{"kind":"url_contains","text":"dashboard"}]'
gsd-browser screenshot --output /tmp/gsd-browser-uat.png --format png
```

After any navigation, submit, or dynamic DOM change, take a fresh snapshot before using refs again. Refs are versioned, such as `@v1:e1` and `@v2:e3`, and old refs can become stale.

Use `--json` when parsing output programmatically. Use named sessions for parallel or project-specific work:

```bash
gsd-browser --session gsd-pi navigate http://localhost:3000
```
