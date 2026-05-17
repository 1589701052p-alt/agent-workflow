#!/bin/sh
# Stub opencode binary for Playwright e2e (P-5-07).
#
# Two modes:
#   --version           prints a version line that satisfies MIN_OPENCODE_VERSION.
#   run <prompt> ...    emits one --format=json text event carrying a
#                       <workflow-output> envelope, then exits 0.
#
# The envelope content is fixed: a single port "answer" with value
# "stub e2e output". The companion test creates an agent whose declared
# outputs are exactly ["answer"], so the runner parses cleanly.
#
# All other args (--agent / --format / --dangerously-skip-permissions /
# the prompt itself) are ignored — we don't care what the daemon asked
# for; we just need the runner to see a well-formed envelope.

set -eu

case "${1-}" in
  --version|-v|version)
    echo "stub-opencode 1.14.99"
    exit 0
    ;;
  run)
    : # fallthrough
    ;;
  *)
    echo "stub-opencode: unsupported mode: ${*:-<no args>}" >&2
    exit 2
    ;;
esac

# JSON-encoded text event. The runner reads --format json line-by-line and
# concatenates `part.text` from each `text` event, then extracts the last
# <workflow-output> envelope from that buffer. One event with the whole
# envelope is sufficient.
# RFC-029: when the framework asks for an inventory drop (by setting
# OPENCODE_AW_INVENTORY_OUT), simulate what the real aw-inventory-dump
# plugin would have written. Keeps existing main.spec.ts cases unaffected
# while letting the inventory-section spec exercise the captured:true path.
if [ -n "${OPENCODE_AW_INVENTORY_OUT:-}" ]; then
  cat > "${OPENCODE_AW_INVENTORY_OUT}" <<'INVENTORY_JSON'
{
  "schemaVersion": 1,
  "capturedAt": 1700000000000,
  "agents": [
    {"name": "e2e-stub-coder", "mode": "primary", "modelProviderId": "anthropic", "modelId": "claude-opus-4-7", "readonly": true, "source": "inline"}
  ],
  "skills": [
    {"name": "fixture-skill", "source": "managed", "path": "/tmp/skills/fixture-skill", "description": "stub e2e skill"}
  ],
  "mcps": [
    {"name": "fixture-mcp-ok", "type": "local", "status": "connected", "hint": null},
    {"name": "fixture-mcp-warn", "type": "remote", "status": "needs_auth", "hint": "token missing"}
  ],
  "plugins": [
    {"specifier": "file:///tmp/plugins/aw-inventory-dump.mjs", "source": "inline"}
  ]
}
INVENTORY_JSON
fi

printf '%s\n' '{"type":"text","timestamp":0,"part":{"type":"text","text":"<workflow-output>\n  <port name=\"answer\">stub e2e output</port>\n</workflow-output>"}}'
exit 0
