#!/usr/bin/env bash
set -euo pipefail
for mod in bootstrap/write-gate bootstrap/dynamic-tools gsd-db state preferences db-writer doctor journal milestone-ids; do
  if rg -q "src/resources/extensions/gsd/$mod\.js" packages/mcp-server/src/workflow-tools.ts; then
    echo "ERROR: workflow-tools.ts imports from $mod directly; use mcp-bridge.ts instead"
    exit 1
  fi
done
echo "OK: workflow-tools.ts uses mcp-bridge.ts for core GSD modules"
